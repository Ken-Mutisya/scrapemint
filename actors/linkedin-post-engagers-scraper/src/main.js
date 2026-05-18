// LinkedIn Post Engagers Scraper (No Cookies)
//
// Strategy
// --------
// LinkedIn's authenticated /voyager/ API needs a session cookie. The public
// post embed does not:
//   https://www.linkedin.com/embed/feed/update/urn:li:activity:{id}/
// Appending ?showComments=true or ?showReactions=true renders the public
// commenter and reactor lists in that same cookieless embed.
//
// One request per post. Inside the handler we visit the embed three times
// (base, comments, reactions), parse each, then MERGE comment and reaction
// signals per person so each human becomes a single lead row. A person who
// both commented and reacted is one row, not two, which is the whole point
// of an engagers product versus the post scraper's separate rows.
//
// Output rows
// -----------
//   kind: "post"     one optional summary row per post (not charged)
//   kind: "engager"  one row per unique person per post (charged)
//
// Free tier: first 25 engager rows per run are free. After that charge per
// engager.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ENGAGERS = 25;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    postUrls = [],
    scrapeComments = true,
    scrapeReactions = true,
    maxEngagersPerPost = 0,
    includePostSummary = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const posts = [];
const seen = new Set();
for (const raw of postUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = unwrapPostUrl(String(v).trim());
    const activityId = extractActivityId(cleaned);
    if (!activityId || seen.has(activityId)) continue;
    seen.add(activityId);
    posts.push({ activityId, shareUrl: /^https?:\/\//i.test(cleaned) ? cleaned : null });
}

if (posts.length === 0) {
    log.warning('No valid LinkedIn post URLs or activity URNs provided. Example: https://www.linkedin.com/feed/update/urn:li:activity:7180000000000000000/');
    await Actor.exit();
}

if (!scrapeComments && !scrapeReactions) {
    log.warning('Both scrapeComments and scrapeReactions are off. Nothing to do.');
    await Actor.exit();
}

const engagerCap = Number(maxEngagersPerPost) > 0 ? Number(maxEngagersPerPost) : Infinity;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

let totalEngagers = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 4)),
    headless: true,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 150,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 45000;
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],
    async requestHandler(ctx) {
        return handlePost(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(posts.map((p) => ({
    url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${p.activityId}/`,
    userData: { activityId: p.activityId, shareUrl: p.shareUrl },
    uniqueKey: `post:${p.activityId}`,
})));

await crawler.run();

log.info(`Run complete. Posts: ${posts.length}. Engagers pushed: ${totalEngagers}.`);
await Actor.exit();

// ---------- Handler ----------

async function handlePost({ page, request }) {
    const { activityId, shareUrl } = request.userData;

    try {
        await page.waitForSelector('article, .feed-shared-update-v2, .commentary, .feed-shared-actor', { timeout: 12000 });
    } catch {}

    const meta = await page.evaluate(() => {
        const sel = (s, r = document) => r.querySelector(s);
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const m = (p) => sel(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute('content') || null;
        const authorBlock = sel('.feed-shared-actor, .actor');
        const authorName = text(sel('.feed-shared-actor__name, .actor-name, .feed-shared-actor__title', authorBlock || document)) || text(sel('h3 a span[dir="ltr"]'));
        const authorLinkEl = sel('.feed-shared-actor a[href*="/in/"], .feed-shared-actor a[href*="/company/"]');
        const bodyEl = sel('.feed-shared-update-v2__description, .feed-shared-text, .commentary, .attributed-text-segment-list__container');
        return {
            authorName,
            authorUrl: authorLinkEl?.href || null,
            authorHeadline: text(sel('.feed-shared-actor__description, .feed-shared-actor__sub-description', authorBlock || document)) || null,
            bodyText: text(bodyEl) || m('og:description'),
            reactionsText: text(sel('.social-counts-reactions__count, .social-details-social-counts__reactions-count, [data-test-id="social-counts-reactions"]')),
            commentsText: text(sel('.social-counts-comments, .social-details-social-counts__comments, [data-test-id="social-counts-comments"]')),
            repostsText: text(sel('.social-counts-shares, .social-details-social-counts__shares, [data-test-id="social-counts-reposts"]')),
        };
    });

    const postUrl = shareUrl || `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
    const reactionCount = parseCount(meta.reactionsText);
    const commentCount = parseCount(meta.commentsText);

    if (includePostSummary) {
        await Actor.pushData({
            kind: 'post',
            postId: activityId,
            postUrn: `urn:li:activity:${activityId}`,
            postUrl,
            author: {
                name: meta.authorName || null,
                url: cleanLinkedInUrl(meta.authorUrl),
                headline: meta.authorHeadline || null,
            },
            textSnippet: meta.bodyText ? meta.bodyText.slice(0, 500) : null,
            engagement: {
                reactions: reactionCount,
                comments: commentCount,
                reposts: parseCount(meta.repostsText),
            },
            scrapedAt: new Date().toISOString(),
        });
    }

    // profileUrl (or lowercased name when a profile link is missing) -> lead row.
    const engagers = new Map();
    const keyFor = (profileUrl, name) => (profileUrl ? profileUrl.toLowerCase() : `name:${(name || '').toLowerCase()}`);

    if (scrapeComments && commentCount !== 0) {
        const comments = await collectComments(page, activityId);
        for (const c of comments) {
            const pUrl = cleanLinkedInUrl(c.profileUrl);
            const k = keyFor(pUrl, c.name);
            if (!k || k === 'name:') continue;
            const e = engagers.get(k) || baseEngager(c.name, pUrl);
            e.headline = e.headline || c.headline || null;
            e.commented = true;
            e.commentText = e.commentText || c.text || null;
            e.commentedAt = e.commentedAt || c.time || null;
            engagers.set(k, e);
        }
    }

    if (scrapeReactions && reactionCount !== 0) {
        const reactions = await collectReactions(page, activityId);
        for (const r of reactions) {
            const pUrl = cleanLinkedInUrl(r.profileUrl);
            const k = keyFor(pUrl, r.name);
            if (!k || k === 'name:') continue;
            const e = engagers.get(k) || baseEngager(r.name, pUrl);
            e.reacted = true;
            e.reactionType = e.reactionType || r.reactionType || null;
            engagers.set(k, e);
        }
    }

    let pushed = 0;
    for (const e of engagers.values()) {
        if (pushed >= engagerCap) break;
        const via = [];
        if (e.commented) via.push('comment');
        if (e.reacted) via.push('reaction');

        await Actor.pushData({
            kind: 'engager',
            postId: activityId,
            postUrn: `urn:li:activity:${activityId}`,
            postUrl,
            postAuthor: meta.authorName || null,
            name: e.name || null,
            profileUrl: e.profileUrl || null,
            headline: e.headline || null,
            engagedVia: via,
            commentText: e.commentText || null,
            commentedAt: e.commentedAt || null,
            reactionType: e.reactionType || null,
            scrapedAt: new Date().toISOString(),
        });
        pushed += 1;
        totalEngagers += 1;

        if (totalEngagers > FREE_TIER_ENGAGERS) {
            await Actor.charge({ eventName: 'engager_extracted' }).catch((err) => {
                log.warning(`charge failed (continuing): ${err?.message}`);
            });
        }
    }

    log.info(`Post ${activityId}: ${pushed} engager rows pushed (reactions~${reactionCount ?? '?'}, comments~${commentCount ?? '?'}).`);
}

// ---------- Collectors ----------

async function collectComments(page, activityId) {
    try {
        await page.goto(`https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/?showComments=true`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch { return []; }
    try {
        await page.waitForSelector('.comments-comment-item, [data-test-id="comment"], article.comment', { timeout: 8000 });
    } catch {}
    await autoScroll(page);

    return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.comments-comment-item, [data-test-id="comment"], article.comment').forEach((el) => {
            const link = el.querySelector('a[href*="/in/"], a[href*="/company/"]');
            const profileUrl = link?.href ? link.href.split('?')[0] : null;
            const nameEl = el.querySelector('.comments-post-meta__name-text, .comments-post-meta__name, .comments-comment-item__name-text');
            const name = (nameEl?.textContent || link?.textContent || '').replace(/\s+/g, ' ').trim();
            const headlineEl = el.querySelector('.comments-post-meta__headline, .comments-comment-item__headline');
            const headline = (headlineEl?.textContent || '').replace(/\s+/g, ' ').trim();
            const bodyEl = el.querySelector('.comments-comment-item__main-content, .feed-shared-main-content--comment, .comment-body, .attributed-text-segment-list__container');
            const text = (bodyEl?.textContent || '').replace(/\s+/g, ' ').trim();
            const time = el.querySelector('time')?.getAttribute('datetime') || null;
            if (name || text) out.push({ name, profileUrl, headline, text, time });
        });
        return out;
    }).catch(() => []);
}

async function collectReactions(page, activityId) {
    try {
        await page.goto(`https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/?showReactions=true`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch { return []; }
    try {
        await page.waitForSelector('.social-details-reactors-tab-body, .reactions-row, a[href*="/in/"]', { timeout: 8000 });
    } catch {}
    await autoScroll(page);

    return page.evaluate(() => {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]').forEach((a) => {
            const href = (a.href || '').split('?')[0];
            if (!/linkedin\.com\/(in|company)\//.test(href)) return;
            if (seen.has(href)) return;
            const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!name) return;
            const card = a.closest('li, div, article');
            const reactionImg = card?.querySelector('img[alt*="reaction"], img[data-test-icon]');
            const reactionType = reactionImg?.getAttribute('alt') || reactionImg?.getAttribute('data-test-icon') || null;
            seen.add(href);
            out.push({ name, profileUrl: href, reactionType });
        });
        return out;
    }).catch(() => []);
}

async function autoScroll(page) {
    try {
        for (let i = 0; i < 6; i++) {
            await page.mouse.wheel(0, 2200);
            await page.waitForTimeout(900);
        }
    } catch {}
}

function baseEngager(name, profileUrl) {
    return { name: name || null, profileUrl: profileUrl || null, headline: null, commented: false, reacted: false, commentText: null, commentedAt: null, reactionType: null };
}

// ---------- URL helpers (shared shape with linkedin-profile-posts-scraper) ----------

function unwrapPostUrl(href) {
    if (!href) return href;
    let url = href;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (/bing\.com$/.test(host)) {
            const real = u.searchParams.get('u') || u.searchParams.get('r');
            if (real) {
                if (real.startsWith('a1')) {
                    try { url = Buffer.from(real.slice(2), 'base64').toString('utf8'); } catch { url = real; }
                } else url = real;
            }
        } else if (/google\.com$/.test(host) && u.pathname.startsWith('/url')) {
            url = u.searchParams.get('q') || u.searchParams.get('url') || url;
        } else if (/duckduckgo\.com$/.test(host) && u.pathname === '/l/') {
            const real = u.searchParams.get('uddg');
            if (real) url = decodeURIComponent(real);
        }
    } catch {}
    try {
        const u = new URL(url);
        if (/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
            if (u.pathname.startsWith('/login') || u.pathname.startsWith('/signup') || u.pathname.startsWith('/uas/')) {
                const inner = u.searchParams.get('session_redirect') || u.searchParams.get('redirect');
                if (inner) url = decodeURIComponent(inner);
            }
        }
    } catch {}
    return url;
}

function extractActivityId(url) {
    if (!url) return null;
    const m1 = url.match(/-activity-(\d{15,25})-/);
    if (m1) return m1[1];
    const m2 = url.match(/urn(?::|%3A)li(?::|%3A)activity(?::|%3A)(\d{15,25})/i);
    if (m2) return m2[1];
    const m3 = url.match(/(?:^|[^\d])(\d{18,21})(?:$|[^\d])/);
    if (m3) return m3[1];
    return null;
}

function cleanLinkedInUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return href;
        return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return href; }
}

function parseCount(text) {
    if (!text) return null;
    const t = text.replace(/,/g, '').toLowerCase().trim();
    const m = t.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
