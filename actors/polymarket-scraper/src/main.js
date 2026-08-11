// Polymarket Scraper
//
// Bulk scrape Polymarket prediction markets via the public Gamma API,
// optionally enriched with CLOB order book, recent trades, and YES price
// history. One row per market.
//
// Endpoints (all public, no auth):
//   Gamma:    https://gamma-api.polymarket.com/markets
//   CLOB:     https://clob.polymarket.com/book?token_id=<token_id>
//             https://clob.polymarket.com/prices-history?market=<token_id>&interval=<i>
//   Data:     https://data-api.polymarket.com/trades?market=<conditionId>
//
// Free tier: first 2 items per run are free. Charge per row after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 2;
const RATE_SLEEP_MS = 200;
const PAGE_SIZE = 100;

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';

const CATEGORY_TO_TAG_ID = {
    sports: 1,
    politics: 2,
    crypto: 21,
    technology: 22,
    tech: 22,
    music: 100,
    entertainment: 18,
    elections: 24,
    'us-election': 24,
    basketball: 28,
    football: 10,
    blockchain: 20,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    categories = [],
    tagIds = [],
    marketSlugs = [],
    conditionIds = [],
    status = 'active',
    minVolume24h = 0,
    minTotalVolume = 0,
    minLiquidity = 0,
    sortBy = 'volume24hr',
    includeOrderbook = false,
    orderbookDepth = 10,
    includeRecentTrades = false,
    recentTradesLimit = 25,
    includePriceHistory = false,
    priceHistoryInterval = '1d',
    maxItemsPerSource = 100,
    maxItemsTotal = 200,
    dedupe = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxItemsTotal) > 0 ? Number(maxItemsTotal) : Infinity;
const perSourceCap = Number(maxItemsPerSource) > 0 ? Number(maxItemsPerSource) : 100;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const fetcher = await buildProxiedFetch(proxyConfiguration);

const seenStore = dedupe ? await Actor.openKeyValueStore('polymarket-scraper-seen') : null;
const seenIds = new Set(seenStore ? (await seenStore.getValue('seen-condition-ids')) || [] : []);
let pushed = 0;
let chargedAfterFreeTier = 0;

const queries = Array.isArray(searchQueries) ? searchQueries.filter(Boolean) : [];
const categoryList = Array.isArray(categories) ? categories.filter(Boolean) : [];
const explicitTagIds = (Array.isArray(tagIds) ? tagIds : [])
    .map((x) => Number(String(x).trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
const slugList = Array.isArray(marketSlugs) ? marketSlugs.filter(Boolean) : [];
const conditionList = Array.isArray(conditionIds) ? conditionIds.filter(Boolean) : [];

const resolvedTagIds = new Set(explicitTagIds);
for (const cat of categoryList) {
    const tagId = CATEGORY_TO_TAG_ID[String(cat).toLowerCase()];
    if (tagId) resolvedTagIds.add(tagId);
    else log.warning(`Unknown category "${cat}", skipped. Pass numeric tag ID via tagIds[] instead.`);
}

if (
    queries.length === 0 && resolvedTagIds.size === 0
    && slugList.length === 0 && conditionList.length === 0
) {
    log.warning('No input. Provide at least one of: searchQueries[], categories[], tagIds[], marketSlugs[], conditionIds[].');
    await Actor.exit();
}

const collected = new Map(); // conditionId -> raw market

// 1. Direct slugs.
for (const slug of slugList) {
    if (collected.size >= cap) break;
    const m = await fetchMarketBySlug(slug).catch((err) => {
        log.warning(`Slug ${slug} failed: ${err?.message}`);
        return null;
    });
    if (m?.conditionId) collected.set(m.conditionId, m);
}

// 2. Direct condition IDs.
for (const cid of conditionList) {
    if (collected.size >= cap) break;
    if (collected.has(cid)) continue;
    const m = await fetchMarketByConditionId(cid).catch((err) => {
        log.warning(`Condition ID ${cid} failed: ${err?.message}`);
        return null;
    });
    if (m?.conditionId) collected.set(m.conditionId, m);
}

// 3. Search queries.
for (const q of queries) {
    if (collected.size >= cap) break;
    const list = await searchMarkets(q).catch((err) => {
        log.warning(`Search "${q}" failed: ${err?.message}`);
        return [];
    });
    let count = 0;
    for (const m of list) {
        if (collected.size >= cap || count >= perSourceCap) break;
        if (m.conditionId && !collected.has(m.conditionId)) {
            collected.set(m.conditionId, m);
            count += 1;
        }
    }
    log.info(`Search "${q}": ${list.length} markets returned, ${count} added.`);
}

// 4. Tag IDs (resolved from categories or explicit).
for (const tid of resolvedTagIds) {
    if (collected.size >= cap) break;
    const list = await listMarkets({ tagId: tid }).catch((err) => {
        log.warning(`Tag ${tid} failed: ${err?.message}`);
        return [];
    });
    let count = 0;
    for (const m of list) {
        if (collected.size >= cap || count >= perSourceCap) break;
        if (m.conditionId && !collected.has(m.conditionId)) {
            collected.set(m.conditionId, m);
            count += 1;
        }
    }
    log.info(`Tag ${tid}: ${list.length} markets returned, ${count} added.`);
}

// Apply numeric filters + sort + final cap.
const filtered = [...collected.values()].filter((m) => {
    const v24 = numberOrZero(m.volume24hr);
    const vTot = numberOrZero(m.volumeNum ?? m.volume);
    const liq = numberOrZero(m.liquidityNum ?? m.liquidity);
    if (v24 < minVolume24h) return false;
    if (vTot < minTotalVolume) return false;
    if (liq < minLiquidity) return false;
    return true;
});

filtered.sort((a, b) => sortKey(b, sortBy) - sortKey(a, sortBy));

let processedCount = 0;
const finalList = filtered.slice(0, Number.isFinite(cap) ? cap : filtered.length);

// Enrichment runs in batches of `concurrency`.
for (let i = 0; i < finalList.length; i += concurrency) {
    const batch = finalList.slice(i, i + concurrency);
    const rows = await Promise.all(batch.map((m) => buildRow(m).catch((err) => {
        log.warning(`Row ${m.conditionId} failed: ${err?.message}`);
        return null;
    })));

    for (const row of rows) {
        if (!row) continue;
        if (dedupe && row.conditionId && seenIds.has(row.conditionId)) continue;
        await Actor.pushData(row);
        if (row.conditionId) seenIds.add(row.conditionId);
        pushed += 1;
        if (pushed > FREE_TIER_ITEMS) {
            await Actor.charge({ eventName: 'market_row' }).catch(() => {});
            chargedAfterFreeTier += 1;
        }
        log.info(`Pushed ${row.slug || row.conditionId} | vol24h=${row.volume24h?.toFixed?.(0) ?? '?'} | yes=${row.outcomePrices?.[0] ?? '?'} (${pushed})`);
        if (pushed >= cap) break;
    }
    processedCount += batch.length;
    if (pushed >= cap) break;
}

if (seenStore && pushed > 0) await seenStore.setValue('seen-condition-ids', [...seenIds]);
log.info(`Run complete. Processed ${processedCount} markets, pushed ${pushed} rows. Charged events: ${chargedAfterFreeTier}.`);
await Actor.exit();

// ---------- Network ----------

// Polymarket answers fine from Apify datacenter IPs, so the default path uses a
// plain fetch and never touches a proxy. This used to destructure
// HttpsProxyAgent from a package that is not a dependency, so the name came back
// undefined and `new undefined()` threw "HttpsProxyAgent is not a constructor"
// on EVERY request. With proxy defaulted on in the schema, that meant every run
// on default input returned zero rows (found 2026-08-11; 36 users, 140 runs/30d).
// Native fetch also ignores `agent` outright: a proxy needs an undici dispatcher.
// If a proxy is requested but no dispatcher can be built, warn and keep going
// unproxied rather than failing every request.
async function buildProxiedFetch(proxy) {
    if (!proxy) return (url, opts) => fetch(url, opts);
    let ProxyAgent = null;
    try { ({ ProxyAgent } = await import('undici')); } catch { /* not installed */ }
    if (typeof ProxyAgent !== 'function') {
        log.warning('Proxy requested but no undici ProxyAgent is available; continuing without a proxy.');
        return (url, opts) => fetch(url, opts);
    }
    return async (url, opts = {}) => {
        const proxyUrl = await proxy.newUrl();
        return fetch(url, { ...opts, dispatcher: new ProxyAgent(proxyUrl) });
    };
}

async function getJson(url, opts = {}) {
    const res = await fetcher(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- Gamma listings ----------

async function listMarkets({ search, tagId } = {}) {
    const out = [];
    let offset = 0;
    while (out.length < perSourceCap) {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String(offset));
        if (status === 'active') {
            params.set('active', 'true');
            params.set('closed', 'false');
        } else if (status === 'closed') {
            params.set('closed', 'true');
        } else if (status === 'resolved') {
            params.set('closed', 'true');
            params.set('archived', 'false');
        }
        if (search) params.set('search', search);
        if (tagId) params.set('tag_id', String(tagId));
        if (sortBy === 'volume24hr') { params.set('order', 'volume24hr'); params.set('ascending', 'false'); }
        else if (sortBy === 'liquidity') { params.set('order', 'liquidity'); params.set('ascending', 'false'); }
        else if (sortBy === 'endDate') { params.set('order', 'endDate'); params.set('ascending', 'true'); }
        else if (sortBy === 'startDate') { params.set('order', 'startDate'); params.set('ascending', 'false'); }

        const url = `${GAMMA_BASE}/markets?${params.toString()}`;
        const list = await getJson(url);
        if (!Array.isArray(list) || list.length === 0) break;
        out.push(...list);
        if (list.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        await sleep(RATE_SLEEP_MS);
    }
    return out;
}

// Keyword search. The Gamma /markets endpoint silently ignores ?search=, so
// use /public-search, which returns matching events. Flatten each event's
// nested markets[] (same field shape as /markets) and keep those matching the
// requested status. Final sort + cap are applied by the caller.
async function searchMarkets(query) {
    const out = [];
    let page = 1;
    while (out.length < perSourceCap) {
        const params = new URLSearchParams();
        params.set('q', query);
        params.set('limit_per_type', '20');
        params.set('page', String(page));
        if (status === 'active') params.set('events_status', 'active');

        const url = `${GAMMA_BASE}/public-search?${params.toString()}`;
        const data = await getJson(url);
        const events = Array.isArray(data?.events) ? data.events : [];
        if (events.length === 0) break;

        for (const ev of events) {
            const markets = Array.isArray(ev.markets) ? ev.markets : [];
            for (const m of markets) {
                if (marketMatchesStatus(m)) out.push(m);
            }
        }

        if (!data?.pagination?.hasMore) break;
        page += 1;
        await sleep(RATE_SLEEP_MS);
    }
    return out;
}

function marketMatchesStatus(m) {
    if (status === 'active') return m.active === true && m.closed !== true;
    if (status === 'closed') return m.closed === true;
    if (status === 'resolved') return m.closed === true;
    return true; // 'all'
}

async function fetchMarketBySlug(slug) {
    const url = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}&limit=1`;
    const list = await getJson(url);
    return Array.isArray(list) && list[0] ? list[0] : null;
}

async function fetchMarketByConditionId(cid) {
    const url = `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(cid)}&limit=1`;
    const list = await getJson(url);
    return Array.isArray(list) && list[0] ? list[0] : null;
}

// ---------- Row builder ----------

async function buildRow(m) {
    const outcomes = parseJsonArray(m.outcomes);
    const prices = parseJsonArray(m.outcomePrices).map((p) => numberOrNull(p));
    const tokenIds = parseJsonArray(m.clobTokenIds);

    const row = {
        conditionId: m.conditionId || null,
        slug: m.slug || null,
        question: m.question || null,
        description: m.description || null,
        category: m.category || null,
        tags: Array.isArray(m.tags) ? m.tags : null,
        startDate: m.startDate || null,
        endDate: m.endDate || null,
        active: !!m.active,
        closed: !!m.closed,
        resolved: m.resolved == null ? null : !!m.resolved,
        outcomes,
        outcomePrices: prices,
        // Deliberately zero, not null: a price of 0 is a false claim about
        // probability, but a market the API reports no volume for genuinely
        // has not traded. Keep these numeric so buyers can sort and filter.
        volume24h: numberOrZero(m.volume24hr),
        totalVolume: numberOrZero(m.volumeNum ?? m.volume),
        liquidity: numberOrZero(m.liquidityNum ?? m.liquidity),
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
        imageUrl: m.image || m.icon || null,
        clobTokenIds: tokenIds,
        scrapedAt: new Date().toISOString(),
    };

    if (includeOrderbook && tokenIds.length > 0) {
        row.orderbook = {};
        for (let i = 0; i < tokenIds.length; i += 1) {
            const outcomeName = outcomes[i] || `outcome_${i}`;
            row.orderbook[outcomeName] = await fetchOrderbook(tokenIds[i], orderbookDepth).catch((err) => {
                log.warning(`Orderbook ${tokenIds[i]} failed: ${err?.message}`);
                return null;
            });
            await sleep(RATE_SLEEP_MS);
        }
    }

    if (includeRecentTrades && row.conditionId) {
        row.recentTrades = await fetchRecentTrades(row.conditionId, recentTradesLimit, outcomes, tokenIds).catch((err) => {
            log.warning(`Trades ${row.conditionId} failed: ${err?.message}`);
            return null;
        });
    }

    if (includePriceHistory && tokenIds.length > 0) {
        row.priceHistory = await fetchPriceHistory(tokenIds[0], priceHistoryInterval).catch((err) => {
            log.warning(`Price history ${tokenIds[0]} failed: ${err?.message}`);
            return null;
        });
    }

    return row;
}

async function fetchOrderbook(tokenId, depth) {
    const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
    const data = await getJson(url);
    const trim = (rows) => (Array.isArray(rows) ? rows : [])
        .map((r) => ({ price: numberOrNull(r.price), size: numberOrNull(r.size) }))
        // A book level with no price is not a level, and it would also poison
        // the sort below, where null - null is 0.
        .filter((r) => r.price !== null)
        .slice(0, depth);
    return {
        timestamp: isoFromMs(data?.timestamp),
        bids: trim(data?.bids).sort((a, b) => b.price - a.price).slice(0, depth),
        asks: trim(data?.asks).sort((a, b) => a.price - b.price).slice(0, depth),
    };
}

async function fetchRecentTrades(conditionId, limit, outcomes, tokenIds) {
    const url = `${DATA_BASE}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}`;
    const list = await getJson(url);
    if (!Array.isArray(list)) return [];
    const tokenToOutcome = new Map();
    for (let i = 0; i < tokenIds.length; i += 1) tokenToOutcome.set(String(tokenIds[i]), outcomes[i] || `outcome_${i}`);
    return list.map((t) => ({
        side: t.side || null,
        outcome: tokenToOutcome.get(String(t.asset)) || null,
        price: numberOrNull(t.price),
        size: numberOrNull(t.size),
        timestamp: t.timestamp ? isoFromMs(Number(t.timestamp) * 1000) : null,
        trader: t.proxyWallet || null,
        txHash: t.transactionHash || null,
    }));
}

async function fetchPriceHistory(tokenId, interval) {
    const url = `${CLOB_BASE}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${encodeURIComponent(interval)}&fidelity=60`;
    const data = await getJson(url);
    if (!Array.isArray(data?.history)) return [];
    return data.history.map((p) => {
        const t = numberOrNull(p.t);
        return {
            timestamp: t === null ? null : isoFromMs(t * 1000),
            yesPrice: numberOrNull(p.p),
        };
    });
}

// ---------- Helpers ----------

function parseJsonArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    }
    return [];
}

// Sorting only: a comparator needs a real number, and a market with no volume
// data belongs at the bottom of the list. Never use this for a published field.
function numberOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Every published numeric field goes through this. Number(null) is 0 and
// Number('') is 0, so a bare cast turns "the API omitted this" into a price of
// zero, which on a prediction market reads as "0% probability" rather than
// "unknown". Absent and zero are different facts and buyers pay per row.
function numberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// new Date(NaN).toISOString() throws RangeError, so an absent or unparseable
// timestamp would kill the whole run rather than drop one field.
function isoFromMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sortKey(m, key) {
    if (key === 'volume24hr') return numberOrZero(m.volume24hr);
    if (key === 'liquidity') return numberOrZero(m.liquidityNum ?? m.liquidity);
    if (key === 'endDate') return -Date.parse(m.endDate || 0); // soonest first => smallest ts => negate
    if (key === 'startDate') return Date.parse(m.startDate || 0);
    return numberOrZero(m.volume24hr);
}
