// Sitemap Change Monitor: New & Removed Pages on Any Website
//
// Strategy
// --------
// A site's sitemap announces its structure: every new product line,
// content cluster or landing page shows up there first. Each run
// discovers the sitemap(s) for every monitored site (robots.txt Sitemap
// lines -> sitemap index recursion -> /sitemap.xml fallback), collects
// the URL set (gzipped child sitemaps supported), and diffs it against
// the previous run's snapshot in a named key-value store. One row per
// NEW page and per REMOVED page (plus optional lastmod updates). First
// run per site emits one free baseline row; a site that published
// nothing pushes nothing and costs nothing. Keyless, proxyless.
//
// Pay per event
// -------------
//   change_row ($0.005) per pushed change. Baselines are free.
//   First 2 change rows per run are free.

import { Actor, log } from 'apify';
import zlib from 'node:zlib';

const FREE_TIER_CHANGES = 2;
const HARD_ROW_CAP = 2000;
const HARD_URL_CAP = 50000;
const LASTMOD_URL_CAP = 20000;
const MAX_CHILD_SITEMAPS = 50;
const FETCH_TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    sites = [],
    trackNewPages = true,
    trackRemovedPages = true,
    trackUpdatedPages = false,
    maxUrlsPerSite = 20000,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const siteList = [...new Set(asList(sites).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)))];
const urlCap = Math.max(10, Math.min(trackUpdatedPages ? LASTMOD_URL_CAP : HARD_URL_CAP, Number(maxUrlsPerSite) || 20000));
const rowCap = Math.max(1, Math.min(HARD_ROW_CAP, Number(maxRows) || 200));

if (!siteList.length) {
    log.error('Provide at least one site or sitemap URL in "sites".');
    await Actor.exit();
}
log.info(`Monitoring ${siteList.length} site(s), up to ${urlCap} URLs each. No proxy used.`);

const state = await Actor.openKeyValueStore('sitemap-change-monitor-state');
const siteKey = (u) => `site-${u.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120)}`;

async function fetchBody(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, text/plain, */*' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status}: ${url}`); return null; }
        const buf = Buffer.from(await res.arrayBuffer());
        // Handle .xml.gz child sitemaps (and servers that skip content-encoding).
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            try { return zlib.gunzipSync(buf).toString('utf8'); } catch { return buf.toString('utf8'); }
        }
        return buf.toString('utf8');
    } catch (err) {
        log.warning(`Fetch failed (${url}): ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const decodeXml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

// Returns { kind: 'index'|'urlset', locs: [{url, lastmod}] }
function parseSitemap(xml) {
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = [];
    const blockRe = isIndex ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi;
    let m;
    while ((m = blockRe.exec(xml)) !== null) {
        const block = m[0];
        const loc = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)?.[1];
        if (!loc) continue;
        const lastmod = block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)?.[1] || null;
        locs.push({ url: decodeXml(loc), lastmod: lastmod ? decodeXml(lastmod) : null });
    }
    // Some flat sitemaps skip <url> wrappers entirely; fall back to bare <loc>s.
    if (!locs.length) {
        const bare = xml.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi) || [];
        for (const b of bare) locs.push({ url: decodeXml(b.replace(/<\/?loc>/gi, '')), lastmod: null });
    }
    return { kind: isIndex ? 'index' : 'urlset', locs };
}

async function discoverSitemaps(entry) {
    // Explicit sitemap URL: use as-is.
    if (/\.xml(\.gz)?([?#]|$)/i.test(entry) || /sitemap/i.test(new URL(entry).pathname)) return [entry];
    const origin = new URL(entry).origin;
    const found = [];
    const robots = await fetchBody(`${origin}/robots.txt`);
    if (robots) {
        for (const line of robots.split('\n')) {
            const m = line.match(/^\s*sitemap:\s*(\S+)/i);
            if (m) found.push(m[1].trim());
        }
    }
    if (!found.length) found.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
    return [...new Set(found)];
}

async function collectUrls(entry) {
    const queue = await discoverSitemaps(entry);
    const seenMaps = new Set();
    const urls = new Map(); // url -> lastmod
    let fetched = 0;
    let anyOk = false;
    while (queue.length && urls.size < urlCap && fetched < MAX_CHILD_SITEMAPS) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const mapUrl = queue.shift();
        if (seenMaps.has(mapUrl)) continue;
        seenMaps.add(mapUrl);
        const xml = await fetchBody(mapUrl);
        fetched += 1;
        if (!xml || !/<(urlset|sitemapindex|loc)[\s>]/i.test(xml)) continue;
        anyOk = true;
        const { kind, locs } = parseSitemap(xml);
        if (kind === 'index') {
            for (const l of locs) if (!seenMaps.has(l.url)) queue.push(l.url);
        } else {
            for (const l of locs) {
                if (urls.size >= urlCap) break;
                if (!urls.has(l.url)) urls.set(l.url, l.lastmod);
            }
        }
    }
    return anyOk ? { urls, sitemapCount: fetched } : null;
}

let changeRows = 0;
let baselineRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    if (chargeable) {
        changeRows += 1;
        if (changeRows > FREE_TIER_CHANGES) {
            try {
                await Actor.charge({ eventName: 'change_row' });
            } catch (err) {
                log.warning(`charge failed: ${err?.message}`);
            }
        }
    } else {
        baselineRows += 1;
    }
}

const checkedAt = new Date().toISOString();

async function processSite(entry) {
    const key = siteKey(entry);
    const collected = await collectUrls(entry);
    if (!collected) {
        log.warning(`${entry}: no sitemap found (robots.txt has no Sitemap line and /sitemap.xml is missing); skipping.`);
        return;
    }
    const { urls, sitemapCount } = collected;
    // Snapshot: [url, lastmod] pairs (lastmod only kept when tracking updates).
    const snapshot = [...urls.entries()].map(([u, lm]) => (trackUpdatedPages ? [u, lm] : [u]));
    const prevRaw = await state.getValue(key);

    if (!prevRaw) {
        await flushRow({
            changeType: 'baseline',
            site: entry,
            urlCount: urls.size,
            sitemapsFetched: sitemapCount,
            note: 'First run for this site: URL snapshot saved. Changes appear from the next run.',
            checkedAt,
        }, false);
        await state.setValue(key, snapshot);
        log.info(`${entry}: baseline saved (${urls.size} URLs from ${sitemapCount} sitemap file(s)).`);
        return;
    }

    const prev = new Map(prevRaw.map((e) => [e[0], e.length > 1 ? e[1] : null]));
    let changes = 0;
    const emit = async (row) => {
        if (changeRows >= rowCap) return false;
        await flushRow({ site: entry, ...row, checkedAt }, true);
        changes += 1;
        return true;
    };

    outer: {
        if (trackNewPages) {
            for (const [u, lm] of urls) {
                if (!prev.has(u)) {
                    if (!await emit({ changeType: 'new_page', url: u, lastmod: lm })) break outer;
                }
            }
        }
        if (trackRemovedPages) {
            for (const [u] of prev) {
                if (!urls.has(u)) {
                    if (!await emit({ changeType: 'removed_page', url: u })) break outer;
                }
            }
        }
        if (trackUpdatedPages) {
            for (const [u, lm] of urls) {
                const old = prev.get(u);
                if (prev.has(u) && old && lm && old !== lm) {
                    if (!await emit({ changeType: 'updated_page', url: u, oldLastmod: old, newLastmod: lm })) break outer;
                }
            }
        }
    }

    await state.setValue(key, snapshot);
    log.info(`${entry}: ${changes} change(s) across ${urls.size} URLs.`);
}

for (const entry of siteList) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
    if (changeRows >= rowCap) break;
    try {
        await processSite(entry);
    } catch (err) {
        log.warning(`${entry}: ${err?.message}`);
    }
}

log.info(`Done. ${changeRows} change(s) (${Math.max(0, changeRows - FREE_TIER_CHANGES)} chargeable), ${baselineRows} baseline(s). Unchanged sites cost nothing.`);
await Actor.exit();
