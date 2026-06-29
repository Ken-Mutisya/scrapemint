// Polymarket Market Monitor
// Pulls prediction market data from the Polymarket Gamma API.
// Filters by category tag, keyword, volume, liquidity, status, and end date.
// One row per market (or per event).
//
// Endpoints:
//   https://gamma-api.polymarket.com/markets  -> markets list
//   https://gamma-api.polymarket.com/events   -> events (groups of markets)
//   https://gamma-api.polymarket.com/tags/{id} -> tag lookup
//
// Public API, no auth required for reads. Rate limit is not published but
// 1 req / 200ms is safe in practice.
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 50;
const RATE_SLEEP_MS = 200;
const PAGE_SIZE = 100;

// Static category -> tag ID map for common top level categories.
// Users can pass extra numeric tag IDs via tagIds.
const CATEGORY_TO_TAG_ID = {
    sports: 1,
    politics: 2,
    crypto: 21,
    technology: 22,
    tech: 22,
    music: 100,
    entertainment: 18,
    awards: 18,
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
    itemType = 'markets',
    status = 'active',
    minVolume24h = 0,
    minLiquidity = 0,
    minTotalVolume = 0,
    minPriceChangePct = 0,
    minutesUntilEnd = 0,
    sortBy = 'volume24hr',
    maxItemsPerSource = 100,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const searchList = toArray(searchQueries).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
const categoryList = toArray(categories).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
const rawTagIds = toArray(tagIds).map((t) => String(t).trim()).filter(Boolean);

const resolvedTagIds = new Set(rawTagIds);
for (const cat of categoryList) {
    const id = CATEGORY_TO_TAG_ID[cat];
    if (id) resolvedTagIds.add(String(id));
    else log.warning(`Unknown category "${cat}". Known: ${Object.keys(CATEGORY_TO_TAG_ID).join(', ')}. Use tagIds for custom tags.`);
}

const itemTypeNorm = itemType === 'events' ? 'events' : 'markets';
const endpointPath = itemTypeNorm === 'events' ? 'events' : 'markets';

await Actor.createProxyConfiguration(proxyInput);

const store = await Actor.openKeyValueStore('polymarket-monitor-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

const statusParams = buildStatusParams(status);
const tagIdList = resolvedTagIds.size > 0 ? [...resolvedTagIds] : [null];

log.info(`Fetching ${endpointPath}. status=${status} tags=${resolvedTagIds.size > 0 ? [...resolvedTagIds].join(',') : 'any'} searches=${searchList.length}`);

for (const tagId of tagIdList) {
    if (totalPushed >= maxItemsTotal) break;
    await fetchAndPush(tagId);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Actor.exit();

async function fetchAndPush(tagId) {
    let offset = 0;
    let pulled = 0;

    while (pulled < maxItemsPerSource && totalPushed < maxItemsTotal) {
        const url = buildUrl(endpointPath, {
            ...statusParams,
            limit: Math.min(PAGE_SIZE, maxItemsPerSource - pulled),
            offset,
            order: sortBy,
            ascending: 'false',
            volume_num_min: minTotalVolume > 0 ? minTotalVolume : undefined,
            liquidity_num_min: minLiquidity > 0 ? minLiquidity : undefined,
            tag_id: tagId || undefined,
            related_tags: tagId ? 'true' : undefined,
        });

        await sleep(RATE_SLEEP_MS);
        let batch;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                log.warning(`HTTP ${res.status} on ${url}`);
                break;
            }
            batch = await res.json();
        } catch (err) {
            log.warning(`fetch failed: ${err?.message}`);
            break;
        }

        if (!Array.isArray(batch) || batch.length === 0) break;

        for (const item of batch) {
            if (pulled >= maxItemsPerSource || totalPushed >= maxItemsTotal) break;
            totalSeen += 1;

            const row = itemTypeNorm === 'events' ? shapeEvent(item) : shapeMarket(item);
            if (!row) { filteredOut += 1; continue; }
            if (!passesFilters(row)) { filteredOut += 1; continue; }

            if (dedupe && seen.has(row.id)) { deduped += 1; continue; }

            await Actor.pushData(row);
            totalPushed += 1;
            pulled += 1;
            newSeen.add(row.id);
            maybeCharge();
        }

        offset += batch.length;
        if (batch.length < PAGE_SIZE) break;
    }
}

function shapeMarket(m) {
    if (!m || !m.id) return null;
    const outcomes = parseJsonArr(m.outcomes);
    const prices = parseJsonArr(m.outcomePrices).map((p) => toNumber(p));
    const outcomePairs = outcomes.map((name, i) => ({
        name,
        price: prices[i] ?? null,
    }));

    return {
        kind: 'market',
        id: m.id,
        conditionId: m.conditionId || null,
        slug: m.slug,
        question: m.question,
        description: m.description ? String(m.description).slice(0, 1000) : null,
        url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
        image: m.image || null,
        outcomes: outcomePairs,
        lastTradePrice: toNumber(m.lastTradePrice),
        bestBid: toNumber(m.bestBid),
        bestAsk: toNumber(m.bestAsk),
        spread: toNumber(m.spread),
        volume24hr: toNumber(m.volume24hr),
        volume1wk: toNumber(m.volume1wk),
        volume1mo: toNumber(m.volume1mo),
        volumeTotal: toNumber(m.volumeNum) ?? toNumber(m.volume),
        liquidity: toNumber(m.liquidityNum) ?? toNumber(m.liquidity),
        oneWeekPriceChange: toNumber(m.oneWeekPriceChange),
        oneMonthPriceChange: toNumber(m.oneMonthPriceChange),
        startDate: m.startDate || null,
        endDate: m.endDate || null,
        endDateIso: m.endDateIso || null,
        active: !!m.active,
        closed: !!m.closed,
        archived: !!m.archived,
        acceptingOrders: !!m.acceptingOrders,
        featured: !!m.featured,
        new: !!m.new,
        negRisk: !!m.negRisk,
        events: Array.isArray(m.events) ? m.events.map((e) => ({
            id: e.id,
            slug: e.slug,
            title: e.title,
        })) : [],
        scrapedAt: new Date().toISOString(),
    };
}

function shapeEvent(e) {
    if (!e || !e.id) return null;
    return {
        kind: 'event',
        id: e.id,
        slug: e.slug,
        title: e.title,
        description: e.description ? String(e.description).slice(0, 1000) : null,
        url: e.slug ? `https://polymarket.com/event/${e.slug}` : null,
        image: e.image || null,
        startDate: e.startDate || null,
        endDate: e.endDate || null,
        volume24hr: toNumber(e.volume24hr),
        volume1wk: toNumber(e.volume1wk),
        volumeTotal: toNumber(e.volume) ?? toNumber(e.volumeNum),
        liquidity: toNumber(e.liquidity) ?? toNumber(e.liquidityNum),
        active: !!e.active,
        closed: !!e.closed,
        archived: !!e.archived,
        featured: !!e.featured,
        marketsCount: Array.isArray(e.markets) ? e.markets.length : null,
        topMarkets: Array.isArray(e.markets) ? e.markets.slice(0, 5).map((m) => ({
            id: m.id,
            slug: m.slug,
            question: m.question,
            lastTradePrice: toNumber(m.lastTradePrice),
        })) : [],
        scrapedAt: new Date().toISOString(),
    };
}

function passesFilters(row) {
    if (searchList.length > 0) {
        const hay = `${row.question || row.title || ''} ${row.description || ''}`.toLowerCase();
        const hit = searchList.some((q) => hay.includes(q));
        if (!hit) return false;
    }

    if (minVolume24h > 0 && (row.volume24hr == null || row.volume24hr < minVolume24h)) return false;
    if (minTotalVolume > 0 && (row.volumeTotal == null || row.volumeTotal < minTotalVolume)) return false;
    if (minLiquidity > 0 && (row.liquidity == null || row.liquidity < minLiquidity)) return false;

    if (minPriceChangePct > 0 && row.kind === 'market') {
        const mv = Math.max(
            Math.abs(row.oneWeekPriceChange ?? 0),
            Math.abs(row.oneMonthPriceChange ?? 0),
        );
        if ((mv * 100) < minPriceChangePct) return false;
    }

    if (minutesUntilEnd > 0 && row.endDate) {
        const ends = Date.parse(row.endDate);
        if (Number.isFinite(ends)) {
            const mins = (ends - Date.now()) / 60000;
            if (mins < minutesUntilEnd) return false;
        }
    }

    return true;
}

function buildStatusParams(status) {
    switch (String(status).toLowerCase()) {
        case 'closed':
            return { active: 'false', closed: 'true', archived: 'false' };
        case 'all':
            return {};
        case 'active':
        default:
            return { active: 'true', closed: 'false', archived: 'false' };
    }
}

function buildUrl(path, params) {
    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `https://gamma-api.polymarket.com/${path}${qs ? '?' + qs : ''}`;
}

function parseJsonArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return []; }
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'market_signal' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
