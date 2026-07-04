// Google Ads Transparency Scraper (No Login)
//
// Strategy
// --------
// The Ads Transparency Center exposes keyless JSON RPC endpoints (no cookie,
// no API key, no browser):
//   POST /anji/_/rpc/SearchService/SearchSuggestions  advertiser search
//     f.req={"1":"<query>","2":<count>,"3":<count>}
//   POST /anji/_/rpc/SearchService/SearchCreatives    creatives per advertiser
//     f.req={"2":<pageSize>,"3":{"13":{"1":["<AR id>"]},"8":[<region enum>]},
//            "7":{"1":1},"4":"<page cursor>"}
//     The "7":{"1":1} member is mandatory or the service returns {}.
//     Response: "1" = creative rows, "2" = next page cursor.
// Region enum = 2000 + ISO 3166-1 numeric country code (US 2840, GB 2826).
// Omitting field 8 means "anywhere".
//
// Pay per event
// -------------
//   creative_row ($0.004) charged when an ad creative row is pushed.
//   First 2 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 40;
const BASE = 'https://adstransparency.google.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 2000 + ISO 3166-1 numeric. "ANYWHERE" omits the region member entirely.
const REGION_ENUM = {
    US: 2840, GB: 2826, DE: 2276, FR: 2250, IT: 2380, ES: 2724, NL: 2528,
    BE: 2056, AT: 2040, CH: 2756, SE: 2752, NO: 2578, DK: 2208, FI: 2246,
    IE: 2372, PT: 2620, PL: 2616, CZ: 2203, GR: 2300, RO: 2642, HU: 2348,
    CA: 2124, MX: 2484, BR: 2076, AR: 2032, CL: 2152, CO: 2170,
    AU: 2036, NZ: 2554, JP: 2392, KR: 2410, IN: 2356, SG: 2702, HK: 2344,
    TW: 2158, ID: 2360, MY: 2458, TH: 2764, PH: 2608, VN: 2704,
    ZA: 2710, NG: 2566, KE: 2404, EG: 2818, IL: 2376, AE: 2784, SA: 2682, TR: 2792,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    advertiserIds = [],
    region = 'ANYWHERE',
    maxAdvertisersPerQuery = 1,
    maxCreativesPerAdvertiser = 30,
    maxRows = 100,
    proxyConfiguration: proxyInput,
} = input;

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
const cleanIds = (Array.isArray(advertiserIds) ? advertiserIds : [advertiserIds])
    .map((a) => String(a || '').trim().toUpperCase()).filter((a) => /^AR\d+$/.test(a));
if (cleanQueries.length === 0 && cleanIds.length === 0) {
    log.warning('Provide advertiser names or domains in "queries" (e.g. ["Nike, Inc."]) or AR ids in "advertiserIds".');
    await Actor.exit();
}

const regionKey = String(region || 'ANYWHERE').trim().toUpperCase();
const regionEnum = REGION_ENUM[regionKey] || null;
if (regionKey !== 'ANYWHERE' && !regionEnum) {
    log.warning(`Unknown region "${region}", falling back to ANYWHERE. Supported: ANYWHERE, ${Object.keys(REGION_ENUM).join(', ')}.`);
}
const perQuery = Math.max(1, Math.min(10, Number(maxAdvertisersPerQuery) || 1));
const perAdvertiser = Math.max(1, Math.min(HARD_CAP, Number(maxCreativesPerAdvertiser) || 30));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

// Soft deadline derived from the run timeout so we exit cleanly instead of TIMED-OUT.
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : null;
const deadline = timeoutAt ? timeoutAt - 30_000 : null;
const pastDeadline = () => deadline && Date.now() > deadline;

let dispatcher = null;
if (proxyInput?.useApifyProxy || proxyInput?.proxyUrls?.length) {
    try {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        const proxyUrl = await proxyConfiguration?.newUrl();
        if (proxyUrl) {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
            log.info('Routing requests through proxy.');
        }
    } catch (err) {
        log.warning(`Proxy requested but unavailable, continuing direct: ${err?.message}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google applies per-IP quotas to this RPC surface: bursts get HTTP 429 for a
// short window, then recover. Retry with growing backoff instead of failing.
const RETRY_DELAYS = [2_000, 6_000, 15_000];

async function rpc(service, reqObj) {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        if (attempt > 0) {
            if (pastDeadline()) break;
            await sleep(RETRY_DELAYS[attempt - 1]);
        }
        const res = await fetch(`${BASE}/anji/_/rpc/${service}?authuser=`, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': UA,
                accept: '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'x-same-domain': '1',
                origin: BASE,
                referer: `${BASE}/`,
            },
            body: `f.req=${encodeURIComponent(JSON.stringify(reqObj))}`,
            ...(dispatcher ? { dispatcher } : {}),
        });
        const text = await res.text();
        if (res.ok) {
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`${service} returned non-JSON: ${text.slice(0, 160)}`);
            }
        }
        lastErr = new Error(`${service} HTTP ${res.status}: ${text.slice(0, 120)}`);
        if (res.status !== 429 && res.status < 500) break;
        log.warning(`${service} HTTP ${res.status}, retry ${attempt + 1}/${RETRY_DELAYS.length}...`);
    }
    throw lastErr;
}

const toIso = (epochSecs) => {
    const n = Number(epochSecs);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

// Preview markup varies by format; derive a stable format + asset URL from it.
function parsePreview(previewObj) {
    const html = JSON.stringify(previewObj || {});
    const srcMatch = html.match(/src=\\?"(https:[^"\\]+)/);
    const src = srcMatch ? srcMatch[1] : null;
    let format = 'text';
    if (/<video|youtube\.com|ytimg|\bvideo\b/i.test(html)) format = 'video';
    else if (/<img|simgad|googlesyndication\.com\/archive/i.test(html)) format = 'image';
    return { format, previewAssetUrl: src };
}

let totalRowsPushed = 0;
const __chargeJobs = [];

async function pushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'creative_row' });
        } catch (err) {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }
    }
}

// 1) Resolve advertisers.
const advertisers = [];
const seenAdvertisers = new Set();
for (const id of cleanIds) {
    if (!seenAdvertisers.has(id)) {
        seenAdvertisers.add(id);
        advertisers.push({ advertiserId: id, advertiserName: null, advertiserRegion: null, query: null });
    }
}
for (const q of cleanQueries) {
    if (pastDeadline()) break;
    try {
        const out = await rpc('SearchService/SearchSuggestions', { 1: q, 2: 20, 3: 20 });
        const suggestions = (out?.['1'] || [])
            .map((s) => s?.['1'])
            .filter((a) => a?.['2']);
        if (!suggestions.length) {
            log.warning(`No advertiser found for "${q}".`);
            continue;
        }
        for (const a of suggestions.slice(0, perQuery)) {
            const id = a['2'];
            if (seenAdvertisers.has(id)) continue;
            seenAdvertisers.add(id);
            advertisers.push({
                advertiserId: id,
                advertiserName: a['1'] || null,
                advertiserRegion: a['3'] || null,
                query: q,
            });
        }
    } catch (err) {
        log.warning(`Advertiser search failed for "${q}": ${err?.message}`);
    }
    await sleep(250);
}
log.info(`Resolved ${advertisers.length} advertiser(s).`);

// 2) Pull creatives per advertiser with pagination.
outer:
for (const adv of advertisers) {
    let cursor = null;
    let pulled = 0;
    while (pulled < perAdvertiser && totalRowsPushed < rowCap) {
        if (pastDeadline()) {
            log.warning('Approaching run timeout, stopping cleanly.');
            break outer;
        }
        const req = {
            2: Math.min(PAGE_SIZE, perAdvertiser - pulled),
            3: { 13: { 1: [adv.advertiserId] }, ...(regionEnum ? { 8: [regionEnum] } : {}) },
            7: { 1: 1 },
            ...(cursor ? { 4: cursor } : {}),
        };
        let out;
        try {
            out = await rpc('SearchService/SearchCreatives', req);
        } catch (err) {
            log.warning(`Creative search failed for ${adv.advertiserId}: ${err?.message}`);
            break;
        }
        const rows = out?.['1'] || [];
        if (!rows.length) {
            if (pulled === 0) log.info(`No creatives for ${adv.advertiserName || adv.advertiserId} (region ${regionKey}).`);
            break;
        }
        for (const r of rows) {
            if (totalRowsPushed >= rowCap || pulled >= perAdvertiser) break;
            const { format, previewAssetUrl } = parsePreview(r['3']);
            await pushRow({
                advertiserId: r['1'] || adv.advertiserId,
                advertiserName: r['12'] || adv.advertiserName,
                advertiserRegion: adv.advertiserRegion,
                query: adv.query,
                creativeId: r['2'] || null,
                format,
                formatRaw: r['4'] ?? null,
                previewAssetUrl,
                firstShown: toIso(r?.['6']?.['1']),
                lastShown: toIso(r?.['7']?.['1']),
                totalCreativesForAdvertiser: r['13'] ?? null,
                transparencyUrl: r['2'] ? `${BASE}/advertiser/${adv.advertiserId}/creative/${r['2']}?region=${regionKey === 'ANYWHERE' ? 'anywhere' : regionKey}` : null,
                searchRegion: regionKey,
                scrapedAt: new Date().toISOString(),
            });
            pulled += 1;
        }
        cursor = out?.['2'] || null;
        if (!cursor) break;
        await sleep(300);
    }
    if (totalRowsPushed >= rowCap) break;
}

await Promise.allSettled(__chargeJobs);
log.info(`Done. Pushed ${totalRowsPushed} creative row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
