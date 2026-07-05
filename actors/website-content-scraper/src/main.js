// Website Content Scraper: Clean Markdown for AI and RAG
//
// Strategy
// --------
// Breadth-first crawl over plain HTTP starting from the buyer's URLs. Each
// fetched page is cleaned (nav/footer/script/style/form boilerplate removed),
// the main content region is picked (main/article/[role=main], else body),
// and converted to markdown, plain text, or cleaned HTML. One row per page.
// No browser, no proxy by default, no API key.
//
// Pay per event
// -------------
//   page_row ($0.003) charged per page that yields extracted content.
//   Failed fetches and non-HTML responses are never pushed or charged.
//   First 2 content rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const FREE_TIER_ROWS = 2;
const HARD_CAP_PAGES = 500;
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 800000;
const CONCURRENCY = 8;
const MAX_CONTENT_CHARS = 200000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const BOILERPLATE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form', 'template',
    'nav', 'header', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
    '[aria-hidden="true"]', '.cookie-banner', '#cookie-banner', '.cookie-consent',
];
const NON_HTML_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|ico|mp4|mp3|webm|avi|mov|woff2?|ttf|eot|css|js|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|dmg|exe|apk)([?#]|$)/i;
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [],
    maxPages = 20,
    maxDepth = 2,
    sameDomainOnly = true,
    includePatterns = [],
    excludePatterns = [],
    outputFormat = 'markdown',
    useSitemap = false,
    proxyConfiguration: proxyInput,
} = input;

const seeds = (Array.isArray(startUrls) ? startUrls : String(startUrls).split(/[\n,]/))
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .map((u) => String(u || '').trim()).filter(Boolean);
if (!seeds.length) {
    log.warning('Provide "startUrls": a list of pages to crawl, e.g. ["https://docs.apify.com/platform"].');
    await Actor.exit();
}
const pageCap = Math.max(1, Math.min(HARD_CAP_PAGES, Number(maxPages) || 20));
const depthCap = Math.max(0, Math.min(5, Number(maxDepth) ?? 2));
const includes = (includePatterns || []).map(String).filter(Boolean);
const excludes = (excludePatterns || []).map(String).filter(Boolean);
const format = ['markdown', 'text', 'html'].includes(outputFormat) ? outputFormat : 'markdown';

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});
turndown.remove(['script', 'style']);

function normalizeUrl(raw, base) {
    let u;
    try { u = new URL(String(raw).trim(), base); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    const params = [...u.searchParams.keys()];
    for (const p of params) if (TRACKING_PARAMS.test(p)) u.searchParams.delete(p);
    let s = u.href;
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
}

function sameSite(urlStr, rootHost) {
    try {
        const h = new URL(urlStr).hostname.replace(/^www\./, '');
        return h === rootHost || h.endsWith(`.${rootHost}`);
    } catch { return false; }
}

function passesFilters(urlStr) {
    if (excludes.some((p) => urlStr.includes(p))) return false;
    if (includes.length && !includes.some((p) => urlStr.includes(p))) return false;
    return true;
}

async function fetchPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WebsiteContentScraper/1.0; +https://apify.com/scrapemint/website-content-scraper)',
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'en',
            },
            ...(dispatcher ? { dispatcher } : {}),
        });
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !/text\/html|application\/xhtml/.test(ctype)) {
            return { ok: false, status: res.status, finalUrl: res.url, html: '' };
        }
        const html = (await res.text()).slice(0, MAX_HTML_BYTES);
        return { ok: true, status: res.status, finalUrl: res.url, html };
    } catch {
        return { ok: false, status: 0, finalUrl: url, html: '' };
    } finally {
        clearTimeout(timer);
    }
}

function extractContent(html, pageUrl) {
    const $ = cheerio.load(html);
    const title = ($('title').first().text() || '').trim() || null;
    const description = $('meta[name="description"]').attr('content')?.trim() || null;
    const lang = $('html').attr('lang')?.trim() || null;
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;

    const links = [];
    for (const el of $('a[href]').toArray()) {
        const norm = normalizeUrl($(el).attr('href'), pageUrl);
        if (norm && !NON_HTML_EXT.test(norm)) links.push(norm);
    }

    for (const sel of BOILERPLATE_SELECTORS) $(sel).remove();
    let $content = $('main').first();
    if (!$content.length) $content = $('article').first();
    if (!$content.length) $content = $('[role="main"]').first();
    if (!$content.length) $content = $('body');

    const contentHtml = ($content.html() || '').trim();
    const text = $content.text().replace(/\s+/g, ' ').trim();

    let content;
    if (format === 'html') {
        content = contentHtml.slice(0, MAX_CONTENT_CHARS);
    } else if (format === 'text') {
        content = text.slice(0, MAX_CONTENT_CHARS);
    } else {
        let md = '';
        try {
            md = turndown.turndown(contentHtml);
        } catch {
            md = text;
        }
        content = md.replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CONTENT_CHARS);
    }

    return {
        title,
        description,
        lang,
        canonical,
        content,
        wordCount: text ? text.split(/\s+/).length : 0,
        links,
    };
}

async function sitemapUrls(rootUrl) {
    const out = [];
    try {
        const base = new URL(rootUrl);
        const res = await fetchPageRaw(`${base.origin}/sitemap.xml`);
        if (!res) return out;
        // Handle sitemap indexes one level deep.
        const locs = [...res.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
        const childMaps = locs.filter((l) => /sitemap[^/]*\.xml/i.test(l)).slice(0, 3);
        const pageLocs = locs.filter((l) => !/\.xml([?#]|$)/i.test(l));
        out.push(...pageLocs);
        for (const child of childMaps) {
            if (out.length >= pageCap * 2) break;
            const xml = await fetchPageRaw(child);
            if (!xml) continue;
            out.push(...[...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).filter((l) => !/\.xml([?#]|$)/i.test(l)));
        }
    } catch { /* sitemap is best-effort */ }
    return out;
}

async function fetchPageRaw(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebsiteContentScraper/1.0)' },
            ...(dispatcher ? { dispatcher } : {}),
        });
        if (!res.ok) return null;
        return (await res.text()).slice(0, 2000000);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// --- crawl ---

const seen = new Set();
const queue = [];
let rowsPushed = 0;

function enqueue(urlStr, depth, rootHost, isSeed = false) {
    if (!urlStr || seen.has(urlStr)) return;
    if (NON_HTML_EXT.test(urlStr)) return;
    if (!isSeed) {
        if (depth > depthCap) return;
        if (sameDomainOnly && !sameSite(urlStr, rootHost)) return;
        if (!passesFilters(urlStr)) return;
    }
    seen.add(urlStr);
    queue.push({ url: urlStr, depth, rootHost });
}

for (const raw of seeds) {
    const norm = normalizeUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!norm) { log.warning(`Skipping invalid start URL: ${raw}`); continue; }
    const rootHost = new URL(norm).hostname.replace(/^www\./, '');
    enqueue(norm, 0, rootHost, true);
    if (useSitemap) {
        const extra = await sitemapUrls(norm);
        log.info(`Sitemap for ${rootHost}: ${extra.length} URL(s) discovered.`);
        for (const u of extra) enqueue(normalizeUrl(u), 1, rootHost);
        if (queue.length >= pageCap) break;
    }
}

// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'page_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Crawling from ${seeds.length} start URL(s): up to ${pageCap} pages, depth ${depthCap}, format ${format}.`);

let fetched = 0;
let stopped = false;
while (queue.length && rowsPushed < pageCap && !stopped) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = queue.splice(0, Math.min(CONCURRENCY, pageCap - rowsPushed));
    const results = await Promise.all(batch.map(async (job) => ({ job, res: await fetchPage(job.url) })));
    fetched += batch.length;
    for (const { job, res } of results) {
        if (rowsPushed >= pageCap) break;
        if (!res.ok || !res.html) continue;
        const page = extractContent(res.html, res.finalUrl);
        if (!page.content || page.wordCount < 5) continue;
        for (const link of page.links) enqueue(link, job.depth + 1, job.rootHost);
        await flushRow({
            url: job.url,
            finalUrl: res.finalUrl,
            depth: job.depth,
            title: page.title,
            description: page.description,
            lang: page.lang,
            canonical: page.canonical,
            format,
            content: page.content,
            wordCount: page.wordCount,
            crawledAt: new Date().toISOString(),
        });
    }
    if (fetched % 40 < CONCURRENCY) log.info(`Progress: ${rowsPushed} page(s) pushed, ${queue.length} queued.`);
}

log.info(`Done. ${rowsPushed} page row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable), ${fetched} URL(s) fetched.`);
await Actor.exit();
