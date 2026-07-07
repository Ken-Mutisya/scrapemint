// SEO Site Audit Scraper: On-Page Issues for Every Page
//
// Strategy
// --------
// Breadth-first crawl over plain HTTP (redirects followed manually so chains
// can be counted). Each page is parsed once with cheerio and scored against
// standard on-page checks: title/meta lengths and duplicates, H1 structure,
// canonical, robots/noindex, image alt coverage, thin content, redirect
// chains, and (optionally) HEAD-checked broken internal links. One row per
// page with a ready-made issues[] array. No browser, no proxy, no API key.
//
// Pay per event
// -------------
//   page_row ($0.003) charged per audited page pushed. Unreachable URLs and
//   non-HTML responses are never pushed or charged. First 2 rows per run are
//   free so buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 2;
const HARD_CAP_PAGES = 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1500000;
const CONCURRENCY = 8;
const MAX_REDIRECTS = 6;
const MAX_LINK_CHECKS = 2000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const NON_HTML_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|ico|mp4|mp3|webm|avi|mov|woff2?|ttf|eot|css|js|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|dmg|exe|apk)([?#]|$)/i;
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$)/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [],
    maxPages = 20,
    maxDepth = 3,
    includePatterns = [],
    excludePatterns = [],
    checkBrokenLinks = true,
    useSitemap = false,
    proxyConfiguration: proxyInput,
} = input;

const seeds = (Array.isArray(startUrls) ? startUrls : String(startUrls).split(/[\n,]/))
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .map((u) => String(u || '').trim()).filter(Boolean);
if (!seeds.length) {
    log.warning('Provide "startUrls": pages to audit, e.g. ["https://example.com"].');
    await Actor.exit();
}
const pageCap = Math.max(1, Math.min(HARD_CAP_PAGES, Number(maxPages) || 20));
const depthCap = Math.max(0, Math.min(10, Number(maxDepth) ?? 3));
const includes = (includePatterns || []).map(String).filter(Boolean);
const excludes = (excludePatterns || []).map(String).filter(Boolean);

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

const UA = 'Mozilla/5.0 (compatible; SeoSiteAuditScraper/1.0; +https://apify.com/scrapemint/seo-site-audit-scraper)';

function normalizeUrl(raw, base) {
    let u;
    try { u = new URL(String(raw).trim(), base); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(p)) u.searchParams.delete(p);
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

// Follow redirects manually so the chain length is measurable.
async function fetchWithChain(url) {
    const chain = [];
    let current = url;
    const t0 = Date.now();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(current, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
                ...(dispatcher ? { dispatcher } : {}),
            });
            if ([301, 302, 303, 307, 308].includes(res.status)) {
                const loc = res.headers.get('location');
                if (!loc) return { ok: false, status: res.status, chain, finalUrl: current, html: '', ms: Date.now() - t0 };
                chain.push({ from: current, status: res.status });
                current = new URL(loc, current).href;
                continue;
            }
            const ctype = res.headers.get('content-type') || '';
            if (!res.ok || !/text\/html|application\/xhtml/.test(ctype)) {
                return { ok: false, status: res.status, chain, finalUrl: current, html: '', ms: Date.now() - t0 };
            }
            const html = (await res.text()).slice(0, MAX_HTML_BYTES);
            return { ok: true, status: res.status, chain, finalUrl: current, html, ms: Date.now() - t0, bytes: html.length };
        } catch {
            return { ok: false, status: 0, chain, finalUrl: current, html: '', ms: Date.now() - t0 };
        } finally {
            clearTimeout(timer);
        }
    }
    return { ok: false, status: 310, chain, finalUrl: current, html: '', ms: Date.now() - t0 };
}

// One HEAD (GET fallback) per unique internal URL, cached run-wide.
const linkStatus = new Map();
let linkChecksDone = 0;
async function checkLink(url) {
    if (linkStatus.has(url)) return linkStatus.get(url);
    if (linkChecksDone >= MAX_LINK_CHECKS) return null;
    linkChecksDone += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let status = 0;
    try {
        let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA }, ...(dispatcher ? { dispatcher } : {}) });
        if (res.status === 405 || res.status === 501) {
            res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA, Range: 'bytes=0-0' }, ...(dispatcher ? { dispatcher } : {}) });
        }
        status = res.status;
    } catch { status = 0; }
    clearTimeout(timer);
    linkStatus.set(url, status);
    return status;
}

const seenTitles = new Map();
const seenDescriptions = new Map();

function auditPage(html, pageUrl, fetchMeta) {
    const $ = cheerio.load(html);
    const title = ($('title').first().text() || '').trim();
    const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
    const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;
    const lang = $('html').attr('lang')?.trim() || null;
    const h1s = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h2Count = $('h2').length;
    const imgs = $('img').toArray();
    const imgsMissingAlt = imgs.filter((el) => !($(el).attr('alt') || '').trim()).length;
    const ldJsonCount = $('script[type="application/ld+json"]').length;
    const ogTitle = Boolean($('meta[property="og:title"]').attr('content'));

    const internal = new Set();
    let externalCount = 0;
    const rootHost = new URL(pageUrl).hostname.replace(/^www\./, '');
    for (const el of $('a[href]').toArray()) {
        const norm = normalizeUrl($(el).attr('href'), pageUrl);
        if (!norm) continue;
        if (sameSite(norm, rootHost)) { if (!NON_HTML_EXT.test(norm)) internal.add(norm); }
        else externalCount += 1;
    }

    $('script, style, noscript, nav, header, footer, aside').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = text ? text.split(/\s+/).length : 0;

    const issues = [];
    if (!title) issues.push('missing_title');
    else {
        if (title.length > 60) issues.push('title_too_long');
        if (title.length < 10) issues.push('title_too_short');
        const firstTitleUrl = seenTitles.get(title);
        if (firstTitleUrl && firstTitleUrl !== pageUrl) issues.push('duplicate_title');
        else seenTitles.set(title, pageUrl);
    }
    if (!metaDescription) issues.push('missing_meta_description');
    else {
        if (metaDescription.length > 160) issues.push('meta_description_too_long');
        const firstDescUrl = seenDescriptions.get(metaDescription);
        if (firstDescUrl && firstDescUrl !== pageUrl) issues.push('duplicate_meta_description');
        else seenDescriptions.set(metaDescription, pageUrl);
    }
    if (h1s.length === 0) issues.push('missing_h1');
    if (h1s.length > 1) issues.push('multiple_h1');
    if (!canonical) issues.push('missing_canonical');
    if (/noindex/.test(metaRobots)) issues.push('noindex');
    if (!lang) issues.push('missing_lang');
    if (imgsMissingAlt > 0) issues.push('images_missing_alt');
    if (wordCount < 150) issues.push('thin_content');
    if (fetchMeta.chain.length > 1) issues.push('redirect_chain');

    return {
        title: title || null,
        titleLength: title.length,
        metaDescription: metaDescription || null,
        metaDescriptionLength: metaDescription.length,
        metaRobots: metaRobots || null,
        canonical,
        lang,
        h1Count: h1s.length,
        firstH1: h1s[0] || null,
        h2Count,
        imageCount: imgs.length,
        imagesMissingAlt: imgsMissingAlt,
        structuredDataBlocks: ldJsonCount,
        hasOgTitle: ogTitle,
        wordCount,
        internalLinks: [...internal],
        externalLinkCount: externalCount,
        issues,
    };
}

let rowsPushed = 0;
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

async function sitemapUrls(rootUrl) {
    try {
        const base = new URL(rootUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${base.origin}/sitemap.xml`, { signal: controller.signal, headers: { 'User-Agent': UA }, ...(dispatcher ? { dispatcher } : {}) });
        clearTimeout(timer);
        if (!res.ok) return [];
        const xml = (await res.text()).slice(0, 3000000);
        return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).filter((l) => !/\.xml([?#]|$)/i.test(l));
    } catch { return []; }
}

// --- crawl ---

const seen = new Set();
const queue = [];

function enqueue(urlStr, depth, rootHost, isSeed = false) {
    if (!urlStr || seen.has(urlStr) || NON_HTML_EXT.test(urlStr)) return;
    if (!isSeed) {
        if (depth > depthCap) return;
        if (!sameSite(urlStr, rootHost)) return;
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

log.info(`Auditing from ${seeds.length} start URL(s): up to ${pageCap} pages, depth ${depthCap}, broken-link check ${checkBrokenLinks ? 'on' : 'off'}.`);

let fetched = 0;
while (queue.length && rowsPushed < pageCap) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = queue.splice(0, Math.min(CONCURRENCY, pageCap - rowsPushed));
    const results = await Promise.all(batch.map(async (job) => ({ job, res: await fetchWithChain(job.url) })));
    fetched += batch.length;
    for (const { job, res } of results) {
        if (rowsPushed >= pageCap) break;
        if (!res.ok || !res.html) {
            linkStatus.set(job.url, res.status || 0);
            continue;
        }
        const audit = auditPage(res.html, res.finalUrl, res);
        for (const link of audit.internalLinks) enqueue(link, job.depth + 1, job.rootHost);

        let brokenLinks = [];
        if (checkBrokenLinks && audit.internalLinks.length) {
            const statuses = await Promise.all(audit.internalLinks.slice(0, 100).map(async (l) => [l, await checkLink(l)]));
            brokenLinks = statuses.filter(([, s]) => s !== null && (s === 0 || s >= 400)).map(([l, s]) => ({ url: l, status: s }));
            if (brokenLinks.length) audit.issues.push('broken_internal_links');
        }

        const { internalLinks, ...rest } = audit;
        await flushRow({
            url: job.url,
            finalUrl: res.finalUrl,
            httpStatus: res.status,
            redirectChain: res.chain,
            redirectHops: res.chain.length,
            depth: job.depth,
            responseMs: res.ms,
            htmlBytes: res.bytes || 0,
            ...rest,
            internalLinkCount: internalLinks.length,
            brokenLinks,
            brokenLinkCount: brokenLinks.length,
            issueCount: rest.issues.length,
            auditedAt: new Date().toISOString(),
        });
    }
    if (fetched % 40 < CONCURRENCY) log.info(`Progress: ${rowsPushed} page(s) audited, ${queue.length} queued, ${linkChecksDone} links checked.`);
}

log.info(`Done. ${rowsPushed} page row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable), ${fetched} fetched, ${linkChecksDone} links checked.`);
await Actor.exit();
