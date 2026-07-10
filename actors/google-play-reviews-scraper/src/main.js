// Google Play Reviews Scraper
//
// Strategy
// --------
// Google Play serves reviews through its public batchexecute RPC, the same
// call the store's own review page makes. It is keyless JSON:
//   POST https://play.google.com/_/PlayStoreUi/data/batchexecute?hl=<lang>&gl=<country>
//   f.req=[[["UsvDTd","[null,null,[2,<sort>,[<count>,null,<token>],null,[null,<stars>]],[\"<appId>\",7]]",null,"generic"]]]
// sort: 1 = most relevant, 2 = newest, 3 = rating. The third slot carries the
// page size and continuation token, so deep pulls are repeated cheap POSTs.
// No login, no API key, no browser; works from datacenter IPs.
//
// Pay per event
// -------------
//   review_row ($0.002) charged when a review row is pushed.
//   First 2 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 250;
const SORTS = { newest: 2, relevance: 1, rating: 3 };
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    apps = [],
    sort = 'newest',
    starsFilter = 0,
    language = 'en',
    country = 'us',
    maxReviewsPerApp = 200,
    maxRows = 1000,
    proxyConfiguration: proxyInput,
} = input;

const appIds = (Array.isArray(apps) ? apps : [apps])
    .map(parseAppId)
    .filter(Boolean);
if (!appIds.length) {
    log.warning('Provide at least one Google Play app ID or store URL in "apps", e.g. ["com.whatsapp"].');
    await Actor.exit();
}

const sortValue = SORTS[String(sort || 'newest').toLowerCase()] ?? SORTS.newest;
const stars = Number(starsFilter) >= 1 && Number(starsFilter) <= 5 ? Number(starsFilter) : null;
const hl = String(language || 'en').trim().toLowerCase() || 'en';
const gl = String(country || 'us').trim().toLowerCase() || 'us';
const perAppCap = Math.max(1, Math.min(HARD_CAP, Number(maxReviewsPerApp) || 200));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

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

async function fetchReviewPage(appId, token) {
    const inner = [null, null, [2, sortValue, [PAGE_SIZE, null, token ?? null], null, [null, stars]], [appId, 7]];
    const body = new URLSearchParams({
        'f.req': JSON.stringify([[['UsvDTd', JSON.stringify(inner), null, 'generic']]]),
    });
    const res = await fetch(`https://play.google.com/_/PlayStoreUi/data/batchexecute?hl=${hl}&gl=${gl}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
        body,
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`batchexecute HTTP ${res.status}`);
    const raw = await res.text();
    const envelope = JSON.parse(raw.startsWith(")]}'") ? raw.slice(raw.indexOf('\n', raw.indexOf('\n') + 1)) : raw);
    const payload = envelope?.[0]?.[2];
    if (!payload) return { reviews: [], nextToken: null };
    const data = JSON.parse(payload);
    return {
        reviews: Array.isArray(data?.[0]) ? data[0] : [],
        nextToken: data?.[1]?.[1] ?? null,
    };
}

function mapReview(r, appId) {
    const epochSec = r?.[5]?.[0];
    const replyEpochSec = r?.[7]?.[2]?.[0];
    return {
        appId,
        reviewId: r?.[0] ?? null,
        userName: r?.[1]?.[0] ?? null,
        rating: r?.[2] ?? null,
        text: r?.[4] ?? null,
        date: epochSec ? new Date(epochSec * 1000).toISOString() : null,
        thumbsUpCount: r?.[6] ?? 0,
        appVersion: r?.[10] ?? null,
        developerReplyText: r?.[7]?.[1] ?? null,
        developerReplyDate: replyEpochSec ? new Date(replyEpochSec * 1000).toISOString() : null,
        url: r?.[0] ? `https://play.google.com/store/apps/details?id=${appId}&reviewId=${r[0]}` : null,
        sort: String(sort),
        starsFilter: stars,
        language: hl,
        country: gl,
        scrapedAt,
    };
}

let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'review_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const scrapedAt = new Date().toISOString();
log.info(`Scraping reviews for ${appIds.length} app(s), sort=${sort}${stars ? `, stars=${stars}` : ''} (${hl}/${gl}).`);

let stopped = false;
for (const appId of appIds) {
    if (stopped || totalRowsPushed >= cap) break;
    const seen = new Set();
    let pushedForApp = 0;
    let token = null;
    let failures = 0;
    while (pushedForApp < perAppCap && totalRowsPushed < cap) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            stopped = true;
            break;
        }
        let page;
        try {
            page = await fetchReviewPage(appId, token);
            failures = 0;
        } catch (err) {
            failures += 1;
            log.warning(`App "${appId}" page failed: ${err?.message}`);
            if (failures >= 5) {
                log.warning('Five consecutive failures; Play may be rate limiting this IP. Stopping this app.');
                break;
            }
            await sleep(2000);
            continue;
        }
        if (!page.reviews.length) {
            if (pushedForApp === 0) log.warning(`App "${appId}": no reviews returned. Check the app ID exists and has reviews in ${hl}/${gl}.`);
            break;
        }
        let newInPage = 0;
        for (const r of page.reviews) {
            const id = r?.[0];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            newInPage += 1;
            if (pushedForApp >= perAppCap || totalRowsPushed >= cap) break;
            await flushRow(mapReview(r, appId));
            pushedForApp += 1;
        }
        if (!page.nextToken || newInPage === 0) break;
        token = page.nextToken;
        await sleep(REQUEST_DELAY_MS);
    }
    log.info(`App "${appId}": ${pushedForApp} review(s).`);
}

log.info(`Done. Pushed ${totalRowsPushed} review row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();

function parseAppId(value) {
    const s = String(value || '').trim();
    if (!s) return null;
    const m = s.match(/[?&]id=([a-zA-Z0-9._]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9._]+$/.test(s) && s.includes('.')) return s;
    log.warning(`Skipping unrecognized app reference: "${s}". Use a package ID like com.example.app or a full Play store URL.`);
    return null;
}

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
