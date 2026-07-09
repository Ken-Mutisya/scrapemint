// Google Trends Scraper (No Login)
//
// Strategy
// --------
// Google Trends exposes a keyless two-step JSON API:
//   1. GET /trends/api/explore?req=<json>   -> widget list with per-widget tokens
//   2. GET /trends/api/widgetdata/<kind>?req=<widget.request>&token=<widget.token>
// The explore endpoint 429s without a NID cookie, but hitting the public explore
// page first sets that cookie (the page itself may 429 and STILL set the cookie).
// We bootstrap the cookie once, then run explore + widgetdata per keyword with a
// polite delay. No login, no API key, no browser.
//
// Row types (all charged as trend_row):
//   interest_over_time  one row per keyword, full timeline embedded
//   interest_by_region  one row per region (top N by value)
//   related_query       one row per top/rising related search
// RELATED_TOPICS is deliberately not offered: Google tags keyless sessions
// USER_TYPE_SCRAPER in the signed widget token and returns empty rankedList
// for the topics (ENTITY) widget, while the queries widget still serves data.
//
// Pay per event
// -------------
//   trend_row ($0.004) charged when a row is pushed.
//   First 10 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 10;
const HARD_CAP = 5000;
const BASE = 'https://trends.google.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIME_RANGES = new Set(['now 1-H', 'now 4-H', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y', 'all']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    geo = '',
    timeRange = 'today 12-m',
    category = 0,
    property = '',
    dataTypes = ['interestOverTime', 'interestByRegion', 'relatedQueries'],
    maxRegionsPerKeyword = 20,
    maxRelatedPerKeyword = 25,
    maxRows = 500,
    proxyConfiguration: proxyInput,
} = input;

const cleanKeywords = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k || '').trim()).filter(Boolean);
if (cleanKeywords.length === 0) {
    log.warning('Provide at least one keyword in "keywords", e.g. ["web scraping", "chatgpt"].');
    await Actor.exit();
}

const wanted = new Set(Array.isArray(dataTypes) ? dataTypes : [dataTypes]);
const geoClean = String(geo || '').trim().toUpperCase();
const time = TIME_RANGES.has(String(timeRange).trim()) ? String(timeRange).trim() : 'today 12-m';
const cat = Number(category) || 0;
const prop = ['images', 'news', 'youtube', 'froogle'].includes(String(property)) ? String(property) : '';
const regionCap = Math.max(1, Math.min(500, Number(maxRegionsPerKeyword) || 20));
const relatedCap = Math.max(1, Math.min(50, Number(maxRelatedPerKeyword) || 25));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

// Soft deadline derived from the run timeout so we exit cleanly instead of TIMED-OUT.
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : null;
const deadline = timeoutAt ? timeoutAt - 30_000 : null;
const pastDeadline = () => deadline && Date.now() > deadline;

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function rawGet(url, extraHeaders = {}) {
    return fetch(url, {
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${BASE}/trends/explore`,
            ...(cookie ? { Cookie: cookie } : {}),
            ...extraHeaders,
        },
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
    });
}

function absorbCookies(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length) {
        const jar = new Map(cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
        for (const sc of setCookies) {
            const pair = sc.split(';')[0].trim();
            if (pair.includes('=')) jar.set(pair.split('=')[0], pair);
        }
        cookie = [...jar.values()].join('; ');
    }
}

// The explore page often responds 429 yet still sets the NID cookie we need.
async function bootstrapCookie() {
    const res = await rawGet(`${BASE}/trends/explore?geo=${encodeURIComponent(geoClean || 'US')}&q=test`);
    absorbCookies(res);
    if (!cookie) {
        const res2 = await rawGet(`${BASE}/trends/`);
        absorbCookies(res2);
    }
    log.info(cookie ? 'Trends cookie bootstrapped.' : 'No cookie granted; trying anyway.');
}

// Trends JSON responses are prefixed with an anti-JSON line like )]}' — strip it.
async function trendsJson(url, attempt = 0) {
    const res = await rawGet(url);
    absorbCookies(res);
    if (res.status === 429 && attempt < 2) {
        log.warning(`429 from Trends, backing off ${(attempt + 1) * 5}s and refreshing cookie...`);
        await sleep((attempt + 1) * 5000);
        await bootstrapCookie();
        return trendsJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`trends HTTP ${res.status}`);
    const body = await res.text();
    const idx = body.indexOf('\n');
    return JSON.parse(idx >= 0 ? body.slice(idx + 1) : body);
}

function widgetUrl(kind, widget) {
    const params = new URLSearchParams({
        hl: 'en-US',
        tz: '0',
        req: JSON.stringify(widget.request),
        token: widget.token,
    });
    return `${BASE}/trends/api/widgetdata/${kind}?${params}`;
}

let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'trend_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const scrapedAt = new Date().toISOString();
const baseMeta = (keyword) => ({ keyword, geo: geoClean || 'worldwide', timeRange: time, category: cat, property: prop || 'web', scrapedAt });

log.info(`Fetching Google Trends for ${cleanKeywords.length} keyword(s), geo=${geoClean || 'worldwide'}, time="${time}", types=[${[...wanted].join(', ')}].`);
await bootstrapCookie();

for (let i = 0; i < cleanKeywords.length; i++) {
    const keyword = cleanKeywords[i];
    if (totalRowsPushed >= cap || pastDeadline()) break;
    if (i > 0) await sleep(1500 + Math.floor(Math.random() * 1000));

    let widgets;
    try {
        const req = { comparisonItem: [{ keyword, geo: geoClean, time }], category: cat, property: prop };
        const params = new URLSearchParams({ hl: 'en-US', tz: '0', req: JSON.stringify(req) });
        const d = await trendsJson(`${BASE}/trends/api/explore?${params}`);
        widgets = Object.fromEntries((d.widgets || []).map((w) => [w.id, w]));
    } catch (err) {
        log.warning(`Keyword "${keyword}" explore failed: ${err?.message}`);
        continue;
    }
    let pushedForKeyword = 0;

    if (wanted.has('interestOverTime') && widgets.TIMESERIES && totalRowsPushed < cap) {
        try {
            const d = await trendsJson(widgetUrl('multiline', widgets.TIMESERIES));
            const pts = d?.default?.timelineData || [];
            if (pts.length) {
                const timeline = pts.map((p) => ({
                    date: p.time ? new Date(Number(p.time) * 1000).toISOString() : null,
                    formattedTime: p.formattedTime || null,
                    value: Array.isArray(p.value) ? p.value[0] : null,
                    isPartial: p.isPartial || false,
                }));
                const values = timeline.map((t) => t.value).filter((v) => typeof v === 'number');
                await flushRow({
                    type: 'interest_over_time',
                    ...baseMeta(keyword),
                    points: timeline.length,
                    averageValue: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
                    peakValue: values.length ? Math.max(...values) : null,
                    latestValue: values.length ? values[values.length - 1] : null,
                    timeline,
                });
                pushedForKeyword += 1;
            } else {
                log.warning(`Keyword "${keyword}": empty timeline (low volume, or Trends throttling this IP).`);
            }
        } catch (err) {
            log.warning(`Keyword "${keyword}" interestOverTime failed: ${err?.message}`);
        }
    }

    if (wanted.has('interestByRegion') && widgets.GEO_MAP && totalRowsPushed < cap) {
        try {
            const d = await trendsJson(widgetUrl('comparedgeo', widgets.GEO_MAP));
            const regions = (d?.default?.geoMapData || [])
                .filter((r) => r.hasData?.[0] || (Array.isArray(r.value) && r.value[0] > 0))
                .sort((a, b) => (b.value?.[0] || 0) - (a.value?.[0] || 0))
                .slice(0, regionCap);
            for (const r of regions) {
                if (totalRowsPushed >= cap) break;
                await flushRow({
                    type: 'interest_by_region',
                    ...baseMeta(keyword),
                    geoCode: r.geoCode || null,
                    geoName: r.geoName || null,
                    value: Array.isArray(r.value) ? r.value[0] : null,
                });
                pushedForKeyword += 1;
            }
        } catch (err) {
            log.warning(`Keyword "${keyword}" interestByRegion failed: ${err?.message}`);
        }
    }

    if (wanted.has('relatedQueries') && widgets.RELATED_QUERIES && totalRowsPushed < cap) {
        try {
            const d = await trendsJson(widgetUrl('relatedsearches', widgets.RELATED_QUERIES));
            const lists = d?.default?.rankedList || [];
            const labelled = [
                ...(lists[0]?.rankedKeyword || []).map((rk) => ({ rk, rank: 'top' })),
                ...(lists[1]?.rankedKeyword || []).map((rk) => ({ rk, rank: 'rising' })),
            ];
            const perList = { top: 0, rising: 0 };
            for (const { rk, rank } of labelled) {
                if (totalRowsPushed >= cap || perList[rank] >= relatedCap) continue;
                perList[rank] += 1;
                await flushRow({
                    type: 'related_query',
                    ...baseMeta(keyword),
                    rank,
                    query: rk.query || null,
                    value: rk.value ?? null,
                    formattedValue: rk.formattedValue || null,
                    link: rk.link ? `${BASE}${rk.link}` : null,
                });
                pushedForKeyword += 1;
            }
        } catch (err) {
            log.warning(`Keyword "${keyword}" relatedQueries failed: ${err?.message}`);
        }
    }

    log.info(`Keyword "${keyword}": ${pushedForKeyword} row(s).`);
}

log.info(`Done. Pushed ${totalRowsPushed} trend row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();

// Buyer-selected RESIDENTIAL or SERP proxy groups bill the developer under
// pay-per-event pricing, and this data source works from datacenter IPs, so
// those groups are stripped (buyer-supplied proxyUrls pass through untouched).
function sanitizeProxyInput(p) {
    if (!p || typeof p !== 'object') return p;
    const out = { ...p };
    if (Array.isArray(out.apifyProxyGroups)) {
        const kept = out.apifyProxyGroups.filter((g) => !/RESIDENTIAL|SERP/i.test(String(g)));
        if (kept.length !== out.apifyProxyGroups.length) {
            log.warning('Ignoring RESIDENTIAL/SERP proxy groups: this source works from datacenter IPs and premium groups only raise run costs.');
        }
        if (kept.length) out.apifyProxyGroups = kept;
        else delete out.apifyProxyGroups;
    }
    return out;
}
