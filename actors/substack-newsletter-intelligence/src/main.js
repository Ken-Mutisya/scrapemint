// Substack Newsletter Intelligence
//
// Strategy
// --------
// Substack publication /about pages are server rendered HTML and expose
// the writer name, tagline, description, category, cover image, and a
// plain text subscriber count ("446,000 subscribers"). We hit one
// /about page per publication, parse the metadata, and optionally pull
// recent posts from the public archive API at
//   https://{subdomain}.substack.com/api/v1/archive?sort=new&limit=N
// which returns one row per post with title, slug, post_date, audience
// (everyone vs paid), comment_count, and URL. No auth required.
//
// Discovery
// ---------
// substack.com is a SPA. The search page at substack.com/search/{term}
// renders publication cards after JS hydration, so we use Playwright to
// load the page, wait for the cards to render, and harvest hrefs that
// point at Substack publication subdomains.
//
// Pay per event
// -------------
//   publication_row ($0.005) charged when a publication row is pushed.
//   First 3 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER = 3;
const SUBSTACK_BASE = 'https://substack.com';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    subdomains = [],
    publicationUrls = [],
    queries = [],
    fetchRecentPosts = true,
    maxRecentPosts = 12,
    fetchAuthorLinks = true,
    maxPublications = 50,
    maxResultsPerQuery = 25,
    // Defaults to false. This is a search tool, not a monitor: a buyer who
    // repeats a query wants the full result set again, and the dedupe key is an
    // immutable id, so `true` suppressed each item permanently after its first
    // appearance. Verified 2026-08-11 by re-running each actor on its own
    // prefill against a warm store. Set it to true deliberately to poll for
    // new items only, accepting that a run finding nothing new returns no rows.
    dedupe = false,
    navigationDelayMs = 1500,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxPublications) > 0 ? Number(maxPublications) : Infinity;
const recentPostsCap = Math.max(1, Math.min(100, Number(maxRecentPosts) || 12));
const perQueryCap = Math.max(1, Math.min(200, Number(maxResultsPerQuery) || 25));
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('substack-newsletter-intelligence-seen') : null;
const seenSubdomains = new Set(seenStore ? (await seenStore.getValue('seen-subdomains')) || [] : []);
let pushedRows = 0;

const subdomainList = uniq(
    (Array.isArray(subdomains) ? subdomains : [])
        .map((s) => normalizeSubdomain(s))
        .filter(Boolean)
);
const urlSubdomainList = uniq(
    (Array.isArray(publicationUrls) ? publicationUrls : [])
        .map((u) => subdomainFromUrl(u))
        .filter(Boolean)
);
const queryList = (Array.isArray(queries) ? queries : []).map((q) => String(q).trim()).filter(Boolean);

const directSubdomains = uniq([...subdomainList, ...urlSubdomainList]);

if (directSubdomains.length === 0 && queryList.length === 0) {
    log.warning('No input. Provide at least one of subdomains[], publicationUrls[], or queries[].');
    await Actor.exit();
}

log.info(`Inputs: ${directSubdomains.length} direct subdomains, ${queryList.length} search queries. Cap: ${cap}.`);

const seeds = [];
for (const sd of directSubdomains) {
    seeds.push({
        url: aboutUrl(sd),
        userData: { label: 'about', subdomain: sd, sourceQuery: null },
        uniqueKey: `about:${sd}`,
    });
}
for (const q of queryList) {
    seeds.push({
        url: `${SUBSTACK_BASE}/search/${encodeURIComponent(q)}`,
        userData: { label: 'search', query: q },
        uniqueKey: `search:${q}`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 4)),
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 3,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler(ctx) {
        const { request, page } = ctx;
        const { label } = request.userData;
        if (navigationDelayMs > 0) await page.waitForTimeout(navigationDelayMs);
        if (label === 'search') return handleSearch(ctx);
        if (label === 'about') return handleAbout(ctx);
        log.warning(`Unknown label: ${label}`);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

async function handleSearch({ request, page, log: ll }) {
    if (pushedRows >= cap) return;
    const { query } = request.userData;

    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const links = await page.$$eval('a[href*=".substack.com"], a[href^="https://"]', (anchors) => {
        const out = [];
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^https?:\/\/([a-z0-9-]+)\.substack\.com(\/?|\/p\/.*)?$/i);
            if (m) out.push({ subdomain: m[1].toLowerCase(), href });
        }
        return out;
    }).catch(() => []);

    const customLinks = await page.$$eval('a[data-href*="substack"], a[href*="/p/"]', (anchors) => {
        return anchors.map((a) => a.getAttribute('href')).filter(Boolean);
    }).catch(() => []);

    const candidates = new Set();
    for (const l of links) {
        if (l.subdomain && l.subdomain !== 'www' && l.subdomain !== 'on') candidates.add(l.subdomain);
    }
    for (const href of customLinks) {
        const sd = subdomainFromUrl(href);
        if (sd) candidates.add(sd);
    }

    const list = [...candidates].slice(0, perQueryCap);
    ll.info(`[search] "${query}": ${list.length} unique subdomains found.`);

    for (const sd of list) {
        if (pushedRows >= cap) break;
        if (dedupe && seenSubdomains.has(sd)) continue;
        await crawler.addRequests([{
            url: aboutUrl(sd),
            userData: { label: 'about', subdomain: sd, sourceQuery: query },
            uniqueKey: `about:${sd}`,
        }]);
    }
}

async function handleAbout({ request, page, log: ll }) {
    if (pushedRows >= cap) return;
    const { subdomain, sourceQuery } = request.userData;

    await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const finalUrl = page.url();
    const onSubstack = /\.substack\.com/.test(finalUrl);

    const meta = await page.evaluate(() => {
        const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;
        const html = document.body?.innerHTML || '';
        const bodyText = document.body?.innerText || '';

        const description = attr('meta[name="description"]', 'content') || attr('meta[property="og:description"]', 'content') || null;
        const ogTitle = attr('meta[property="og:title"]', 'content') || null;
        const ogImage = attr('meta[property="og:image"]', 'content') || null;
        const author = attr('meta[name="author"]', 'content') || null;
        const titleEl = txt('title');

        const searchSpace = `${bodyText}\n${description || ''}`;
        const subscriberMatch = searchSpace.match(/([\d,]+(?:\.\d+)?(?:\s?[KkMm])?)\s+(?:paid\s+)?subscribers?\b/);
        const subscriberCountText = subscriberMatch ? subscriberMatch[0].trim() : null;
        let subscriberCount = null;
        if (subscriberMatch) {
            const raw = subscriberMatch[1].replace(/,/g, '').replace(/\s/g, '');
            const unit = raw.slice(-1).toLowerCase();
            const num = parseFloat(raw);
            if (Number.isFinite(num)) {
                if (unit === 'k') subscriberCount = Math.round(num * 1000);
                else if (unit === 'm') subscriberCount = Math.round(num * 1_000_000);
                else subscriberCount = Math.round(num);
            }
        }
        let subscriberTier = null;
        if (!subscriberCount) {
            if (/hundreds of thousands of subscribers/i.test(searchSpace)) subscriberTier = '100K_plus';
            else if (/tens of thousands of subscribers/i.test(searchSpace)) subscriberTier = '10K_plus';
            else if (/thousands of subscribers/i.test(searchSpace)) subscriberTier = '1K_plus';
            else if (/millions of subscribers/i.test(searchSpace)) subscriberTier = '1M_plus';
        }

        const hasPaidTier = /paid subscriber|paid post|subscribe.{0,30}\$/i.test(bodyText) || !!document.querySelector('[data-attr*="paid"], [data-paid="true"]');

        const ldNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        let writerName = author;
        let writerHandle = null;
        let publicationName = ogTitle ? ogTitle.replace(/^About\s*[-:]\s*/, '').trim() : null;
        for (const node of ldNodes) {
            try {
                const d = JSON.parse(node.textContent || '');
                if (d?.author?.name) writerName = writerName || d.author.name;
                if (d?.publisher?.name) publicationName = publicationName || d.publisher.name;
            } catch {}
        }

        const externalLinks = [];
        const linkNodes = Array.from(document.querySelectorAll('a[href^="http"]'));
        for (const a of linkNodes) {
            const href = a.getAttribute('href') || '';
            if (/twitter\.com|x\.com|linkedin\.com|github\.com|youtube\.com|tiktok\.com|instagram\.com|threads\.net|bsky\.app/i.test(href)) {
                externalLinks.push(href);
            }
        }

        return {
            description,
            ogTitle,
            ogImage,
            writerName,
            publicationName,
            subscriberCount,
            subscriberCountText,
            subscriberTier,
            hasPaidTier,
            externalLinks: [...new Set(externalLinks)].slice(0, 12),
            pageTitle: titleEl,
        };
    }).catch(() => ({}));

    const lookedLikePlaceholder = !onSubstack && !meta.publicationName;

    const row = {
        subdomain,
        url: `https://${subdomain}.substack.com/`,
        aboutUrl: aboutUrl(subdomain),
        finalUrl,
        movedToCustomDomain: !onSubstack,
        name: meta.publicationName || meta.ogTitle || null,
        writerName: meta.writerName || null,
        tagline: extractTagline(meta.description),
        description: meta.description || null,
        coverImage: meta.ogImage || null,
        subscriberCount: meta.subscriberCount,
        subscriberCountText: meta.subscriberCountText,
        subscriberTier: meta.subscriberTier || null,
        hasPaidTier: !!meta.hasPaidTier,
        externalLinks: fetchAuthorLinks ? (meta.externalLinks || []) : [],
        sourceQuery: sourceQuery || null,
        scrapedAt: new Date().toISOString(),
    };

    if (fetchRecentPosts) {
        const posts = await fetchArchivePosts(page, subdomain, recentPostsCap);
        row.recentPosts = posts;
        row.recentPostCount = posts.length;
        row.paidPostFraction = posts.length > 0
            ? Math.round((posts.filter((p) => p.audience !== 'everyone').length / posts.length) * 100) / 100
            : null;
        const dates = posts.map((p) => p.postDate).filter(Boolean).sort();
        row.lastPostAt = dates.length > 0 ? dates[dates.length - 1] : null;
        if (dates.length >= 2) {
            const first = new Date(dates[0]).getTime();
            const last = new Date(dates[dates.length - 1]).getTime();
            const days = Math.max(1, Math.round((last - first) / 86400_000));
            row.postsPerWeek = Math.round((posts.length / days) * 7 * 100) / 100;
        } else {
            row.postsPerWeek = null;
        }
    }

    await pushRow(row);
    ll.info(`[about] ${subdomain}: ${row.subscriberCount ?? '?'} subs, ${row.recentPostCount ?? '?'} recent posts.`);
}

async function fetchArchivePosts(page, subdomain, limit) {
    const url = `https://${subdomain}.substack.com/api/v1/archive?sort=new&offset=0&limit=${limit}`;
    try {
        const data = await page.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'omit' });
            if (!r.ok) return null;
            return await r.json();
        }, url);
        if (!Array.isArray(data)) return [];
        return data.slice(0, limit).map((p) => ({
            id: p.id,
            title: p.title || null,
            subtitle: p.subtitle || null,
            slug: p.slug || null,
            postDate: p.post_date || null,
            audience: p.audience || null,
            type: p.type || null,
            commentCount: typeof p.comment_count === 'number' ? p.comment_count : null,
            wordcount: p.wordcount ?? null,
            podcastDuration: p.podcast_duration || null,
            url: p.canonical_url || (p.slug ? `https://${subdomain}.substack.com/p/${p.slug}` : null),
        }));
    } catch {
        return [];
    }
}

async function pushRow(row) {
    if (pushedRows >= cap) return;
    if (dedupe && row.subdomain && seenSubdomains.has(row.subdomain)) return;
    await Actor.pushData(row);
    pushedRows += 1;
    if (row.subdomain) seenSubdomains.add(row.subdomain);
    if (pushedRows > FREE_TIER) {
        await Actor.charge({ eventName: 'publication_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

// ---------- helpers ----------

function normalizeSubdomain(s) {
    if (!s) return null;
    const v = String(s).trim().toLowerCase();
    if (!v) return null;
    if (v.includes('://')) return subdomainFromUrl(v);
    return v.replace(/\.substack\.com$/, '').replace(/[^a-z0-9-]/g, '');
}

function subdomainFromUrl(url) {
    if (!url) return null;
    const m = String(url).trim().toLowerCase().match(/^https?:\/\/([a-z0-9-]+)\.substack\.com/);
    if (m) return m[1];
    return null;
}

function aboutUrl(sd) {
    return `https://${sd}.substack.com/about`;
}

function extractTagline(desc) {
    if (!desc) return null;
    const m = desc.split('.')[0];
    return m && m.length < 160 ? m.trim() : null;
}

function uniq(arr) {
    return [...new Set(arr)];
}

await crawler.addRequests(seeds);
await crawler.run();

if (seenStore) {
    await seenStore.setValue('seen-subdomains', [...seenSubdomains]);
}

log.info(`Run complete. Seeds: ${seeds.length}. Rows pushed: ${pushedRows}.`);
await Actor.exit();
