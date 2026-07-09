// VS Code Extension Developer Leads: Publisher Contacts
//
// Strategy
// --------
// Query the VS Code Marketplace gallery API (keyless public JSON POST) per
// keyword and category, paginate by install count, and aggregate extensions
// into one lead row per PUBLISHER: display name, verified domain, website,
// GitHub repo, total installs, extension count, and top extensions. Then
// scrape each publisher's website for contact emails. Optional cross-run
// dedupe turns a scheduled run into a new-publisher feed.
//
// Buyers: devtool/API/cloud vendors selling to extension authors, AI-tooling
// companies, developer-marketing agencies, and recruiters sourcing proven
// VS Code ecosystem engineers.
//
// Pay per event
// -------------
//   publisher_contact_row ($0.01) per publisher pushed WITH a scraped email.
//   publisher_row ($0.004) for the rest. First 2 rows per run are free.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 10;
const FETCH_TIMEOUT_MS = 30000;
const SITE_FETCH_TIMEOUT_MS = 6000;
const GALLERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
// IncludeVersions(1) + IncludeCategoryAndTags(4) + IncludeVersionProperties(16)
// + IncludeStatistics(256) + IncludeLatestVersionOnly(512)
const QUERY_FLAGS = 789;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    categories = [],
    minInstalls = 0,
    maxPublishers = 50,
    includeEmail = true,
    maxEmailLookups = 100,
    concurrency = 8,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = [...new Set(asList(keywords))];
const cats = [...new Set(asList(categories))];
if (kws.length === 0 && cats.length === 0) {
    throw new Error('Provide at least one keyword (e.g. ["database","kubernetes"]) or category (e.g. ["AI"]).');
}
const minInst = Math.max(0, Number(minInstalls) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxPublishers) || 50));
const emailCap = Math.max(0, Math.min(500, Number(maxEmailLookups) || 100));
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

const seenStore = dedupe ? await Actor.openKeyValueStore('vscode-publishers-seen') : null;
const seen = new Set();
if (seenStore) for (const id of (await seenStore.getValue('seen-publishers')) || []) seen.add(String(id));

// ---------- Stage 1: gallery queries, aggregate per publisher ----------
const publishers = new Map(); // publisherId -> aggregate
const queries = [
    ...kws.map((v) => ({ filterType: 10, value: v, label: `keyword "${v}"` })),
    ...cats.map((v) => ({ filterType: 5, value: v, label: `category "${v}"` })),
];

for (const q of queries) {
    if (pastDeadline()) { log.warning('Approaching actor timeout, stopping search.'); break; }
    let total = Infinity;
    let fetched = 0;
    for (let page = 1; page <= MAX_PAGES_PER_QUERY && fetched < total; page++) {
        if (pastDeadline()) break;
        // Publishers dedupe across extensions, so fetch a few pages beyond the
        // row cap before trusting we have enough distinct publishers.
        if (publishers.size >= cap * 3) break;
        const body = {
            filters: [{
                criteria: [
                    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
                    { filterType: q.filterType, value: q.value },
                ],
                pageNumber: page,
                pageSize: PAGE_SIZE,
                sortBy: 4, // installs desc
                sortOrder: 0,
            }],
            flags: QUERY_FLAGS,
        };
        const data = await postJson(GALLERY_URL, body);
        const result = data?.results?.[0];
        const exts = result?.extensions || [];
        if (page === 1) {
            const meta = (result?.resultMetadata || []).find((m) => m.metadataType === 'ResultCount');
            total = meta?.metadataItems?.find((i) => i.name === 'TotalCount')?.count ?? exts.length;
        }
        fetched += exts.length;
        for (const e of exts) ingestExtension(e, q.label);
        if (exts.length < PAGE_SIZE) break;
    }
    log.info(`${q.label}: ${fetched} extensions scanned, ${publishers.size} distinct publishers so far.`);
}

if (publishers.size === 0) { log.warning('No extensions matched.'); await Actor.exit(); }

// ---------- Stage 2: filter, rank, cap ----------
let leads = [...publishers.values()].filter((p) => p.totalInstalls >= minInst);
if (seen.size) leads = leads.filter((p) => !seen.has(p.publisherId));
leads.sort((a, b) => b.totalInstalls - a.totalInstalls);
leads = leads.slice(0, cap);
log.info(`${leads.length} publisher leads after filters (minInstalls=${minInst}, cap=${cap}).`);
if (leads.length === 0) { log.warning('No publishers passed filters.'); await Actor.exit(); }

// ---------- Stage 3: scrape publisher websites for emails ----------
if (includeEmail && emailCap > 0) {
    const targets = leads.filter((p) => (p.website && !isUnscrapable(p.website)) || p.githubRepo).slice(0, emailCap);
    log.info(`Scraping ${targets.length} publisher sites for contact emails.`);
    await mapWithConcurrency(targets, pool, async (p) => {
        if (pastDeadline()) return p;
        const emails = new Set();
        if (p.website && !isUnscrapable(p.website)) {
            const domain = extractDomain(p.website);
            const { reachable, emails: found, contactLinks } = await fetchSite(p.website);
            p.websiteReachable = reachable;
            for (const e of found) emails.add(e);
            // Homepages rarely list emails; try one contact/about page.
            if (emails.size === 0 && reachable) {
                for (const link of contactLinks.slice(0, 2)) {
                    if (pastDeadline()) break;
                    const sub = await fetchSite(link);
                    for (const e of sub.emails) emails.add(e);
                    if (emails.size) break;
                }
            }
            if (reachable && domain) p.mxFound = await hasMx(domain);
        }
        if (emails.size === 0 && p.githubRepo) {
            for (const e of await fetchGithubReadmeEmails(p.githubRepo)) emails.add(e);
        }
        p.emails = [...emails];
        p.likelyContactEmails = inferContactEmails(extractDomain(p.website), p.emails);
        return p;
    });
}

// ---------- Stage 4: push + charge ----------
let rowsPushed = 0; let contactRows = 0; let basicRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

for (const p of leads) {
    const hasEmail = (p.emails || []).length > 0;
    const row = {
        publisher: p.displayName,
        publisherHandle: p.publisherName,
        publisherId: p.publisherId,
        domainVerified: p.domainVerified,
        website: p.website || null,
        githubRepo: p.githubRepo || null,
        websiteReachable: p.websiteReachable ?? null,
        email: (p.emails && p.emails[0]) || null,
        emails: p.emails || [],
        likelyContactEmails: p.likelyContactEmails || [],
        mxFound: p.mxFound ?? null,
        extensionCount: p.extensionCount,
        totalInstalls: p.totalInstalls,
        avgRating: p.ratingCount ? Math.round((p.ratingSum / p.ratingCount) * 100) / 100 : null,
        topExtensions: p.extensions
            .sort((a, b) => b.installs - a.installs)
            .slice(0, 5),
        categories: [...p.categories].slice(0, 10),
        matchedQueries: [...p.matchedQueries],
        marketplaceUrl: `https://marketplace.visualstudio.com/publishers/${encodeURIComponent(p.publisherName)}`,
        scrapedAt: new Date().toISOString(),
    };
    await flushRow(row, hasEmail ? 'publisher_contact_row' : 'publisher_row');
    if (hasEmail) contactRows += 1; else basicRows += 1;
    seen.add(p.publisherId);
}

if (seenStore) await seenStore.setValue('seen-publishers', [...seen].slice(-50000));
log.info(`Done. ${rowsPushed} publisher row(s) pushed: ${contactRows} with email, ${basicRows} without (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();

// ---------- aggregation ----------

function ingestExtension(e, queryLabel) {
    const pub = e?.publisher;
    if (!pub?.publisherId || !e.extensionName) return;
    const v = e.versions?.[0] || {};
    const props = Object.fromEntries((v.properties || []).map((p) => [p.key, p.value]));
    const stats = Object.fromEntries((e.statistics || []).map((s) => [s.statisticName, s.value]));
    const installs = Math.round(stats.install || 0);

    let agg = publishers.get(pub.publisherId);
    if (!agg) {
        agg = {
            publisherId: pub.publisherId,
            publisherName: pub.publisherName,
            displayName: clean(pub.displayName) || pub.publisherName,
            domainVerified: pub.isDomainVerified === true,
            website: webUrl(pub.domain),
            githubRepo: null,
            extensions: [],
            extensionCount: 0,
            totalInstalls: 0,
            ratingSum: 0,
            ratingCount: 0,
            categories: new Set(),
            matchedQueries: new Set(),
        };
        publishers.set(pub.publisherId, agg);
    }
    agg.matchedQueries.add(queryLabel);
    for (const c of e.categories || []) agg.categories.add(c);

    // Website fallback order: verified publisher domain, then any non-GitHub
    // link on the extension, then the GitHub repo as a last resort reference.
    const links = ['Microsoft.VisualStudio.Services.Links.Learn', 'Microsoft.VisualStudio.Services.Links.Getstarted', 'Microsoft.VisualStudio.Services.Links.Support', 'Microsoft.VisualStudio.Services.Links.Source']
        .map((k) => webUrl(props[k])).filter(Boolean);
    const gh = links.find((u) => /github\.com/i.test(u));
    if (gh && !agg.githubRepo) agg.githubRepo = gh.replace(/\.git$/i, '');
    if (!agg.website) agg.website = links.find((u) => !isUnscrapable(u)) || null;

    if (agg.extensions.some((x) => x.name === e.extensionName)) return;
    agg.extensionCount += 1;
    agg.totalInstalls += installs;
    if (stats.averagerating && stats.ratingcount) {
        agg.ratingSum += stats.averagerating * stats.ratingcount;
        agg.ratingCount += stats.ratingcount;
    }
    agg.extensions.push({
        name: e.extensionName,
        displayName: clean(e.displayName),
        installs,
        rating: stats.averagerating ? Math.round(stats.averagerating * 100) / 100 : null,
        lastUpdated: e.lastUpdated || null,
        url: `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(`${pub.publisherName}.${e.extensionName}`)}`,
    });
}

// ---------- website email enrichment ----------

function isUnscrapable(url) {
    return /github\.com|marketplace\.visualstudio\.com|visualstudio\.com|aka\.ms/i.test(String(url || ''));
}

function extractDomain(urlOrHost) {
    if (!urlOrHost) return null;
    try {
        const u = String(urlOrHost).trim();
        const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
        return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
    } catch { return null; }
}

async function fetchSite(websiteUrl) {
    if (!websiteUrl) return { reachable: false, emails: [], contactLinks: [] };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
        const res = await fetch(websiteUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadEnrich/1.0)' },
        });
        clearTimeout(timer);
        const reachable = res.status < 500;
        let emails = []; let contactLinks = [];
        if (reachable && (res.headers.get('content-type') || '').includes('text')) {
            const html = (await res.text()).slice(0, 300000);
            emails = extractEmailsFromHtml(html);
            contactLinks = extractContactLinks(html, res.url || websiteUrl);
        }
        return { reachable, emails, contactLinks };
    } catch { return { reachable: false, emails: [], contactLinks: [] }; }
}

function extractContactLinks(html, baseUrl) {
    const out = [];
    const seenLinks = new Set();
    let baseHost;
    try { baseHost = new URL(baseUrl).hostname; } catch { return out; }
    for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
        if (!/contact|about|support|impressum/i.test(m[1])) continue;
        try {
            const u = new URL(m[1], baseUrl);
            if (!/^https?:$/.test(u.protocol) || u.hostname !== baseHost) continue;
            if (seenLinks.has(u.href)) continue;
            seenLinks.add(u.href);
            out.push(u.href);
            if (out.length >= 4) break;
        } catch { /* skip bad href */ }
    }
    return out;
}

async function fetchGithubReadmeEmails(repoUrl) {
    const m = String(repoUrl).match(/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!m) return [];
    const base = `https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/i, '')}/HEAD`;
    for (const file of ['README.md', 'readme.md', 'package.json']) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
            const res = await fetch(`${base}/${file}`, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadEnrich/1.0)' } });
            clearTimeout(timer);
            if (!res.ok) continue;
            const emails = extractEmailsFromHtml((await res.text()).slice(0, 300000))
                .filter((e) => !/users\.noreply\.github\.com$/i.test(e));
            if (emails.length) return emails;
        } catch { /* try next file */ }
    }
    return [];
}

async function hasMx(domain) {
    if (!domain) return false;
    try {
        const records = await Promise.race([
            dns.resolveMx(domain),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        return Array.isArray(records) && records.length > 0;
    } catch { return false; }
}

function extractEmailsFromHtml(html) {
    if (!html) return [];
    const set = new Set();
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
        const e = decodeURIComponent(m[1]).toLowerCase().trim();
        if (EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e)) set.add(e);
    }
    for (const m of html.matchAll(EMAIL_RE)) {
        const e = m[0].toLowerCase();
        if (!EMAIL_SHAPE.test(e) || PACKAGE_VERSION.test(e)) continue;
        if (/\.(png|jpe?g|gif|svg|webp|css|js|json|woff2?)$/i.test(e)) continue;
        if (/@(?:sentry|wixpress|example|email|2x|github|noreply)\./i.test(e)) continue;
        set.add(e);
    }
    return [...set];
}

function inferContactEmails(domain, existing) {
    const set = new Set();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        if (typeof e !== 'string' || PACKAGE_VERSION.test(e) || !EMAIL_SHAPE.test(e)) continue;
        set.add(e.toLowerCase());
    }
    if (domain) for (const local of ['info', 'contact', 'hello', 'support']) set.add(`${local}@${domain}`);
    return [...set];
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

// ---------- shared ----------

function webUrl(u) {
    const s = String(u || '').trim();
    if (!s) return null;
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try { new URL(withProto); return withProto; } catch { return null; }
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null; }

async function postJson(url, body, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(700 * i);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json;api-version=3.0-preview.1',
                    'User-Agent': 'VsCodeExtensionDeveloperLeads/1.0 (+https://apify.com/scrapemint/vscode-extension-developer-leads)',
                },
                body: JSON.stringify(body),
            });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            log.warning(`gallery API ${res.status} for ${JSON.stringify(body.filters?.[0]?.criteria?.[1] || {})}`);
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`gallery fetch failed: ${err?.message}`);
        } finally { clearTimeout(timer); }
    }
    return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
