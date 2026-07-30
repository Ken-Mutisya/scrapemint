// DEX Pool Price Tracker: price history, liquidity and trade flow
//
// Strategy
// --------
// GeckoTerminal indexes on-chain liquidity pools across 100+ networks and is
// keyless. Two things it publishes that a plain DEX screener does not:
//
//   1. OHLCV CANDLES per pool (open/high/low/close/volume), so a pool has a
//      price HISTORY rather than only a current price.
//   2. UNIQUE BUYERS and SELLERS per window, not just buy/sell counts, which
//      is what makes the trade-flow imbalance readable.
//
//   pools    GET /networks/{network}/trending_pools | new_pools   (20 per call)
//   history  GET /networks/{network}/pools/{address}/ohlcv/{tf}   (1 per call)
//   networks GET /networks                                        (100 per call)
//
// Rate limiting is the design constraint
// --------------------------------------
// Measured from an Apify datacenter IP by sweeping the gap between requests:
//
//   gap  1000ms -> 200,200,200,200,200,429,429,429
//   gap  3000ms -> 200,200,200,200,200,429,429,200
//   gap  6000ms -> 200,200,200,200,200,429,429,429
//   gap 10000ms -> 200,200,200,200,200,200,429,200
//
// Five requests go through at any gap and a 10s gap buys exactly one more, so
// this is a quota of ~5 per window rather than a rate a longer gap can
// outrun. Spacing calls further apart is almost worthless. The 429 arrives in
// ~7ms and the pattern varies between sweeps, which is what a quota shared
// with whoever else sits on that datacenter IP looks like.
//
// Measured recovery: after a deliberate 12-request burst that drew 7 refusals,
// the endpoint served 200 again 45s later. The 15/30/45s backoff below is
// sized against that.
//
// Consequences, and they shape every mode below:
//   - Prefer endpoints returning MANY rows per call. pools and networks each
//     cost ONE request and return 20 and 100 rows, so they are unaffected.
//   - history costs one request PER POOL, so it is capped at 5 pools per run
//     and leans on backoff rather than pacing to recover the quota.
//   - A throttled run emits a free note row saying results may be partial,
//     rather than silently returning nothing.
//
// Pay per event
// -------------
//   pool_row ($0.004) per pool or candle row pushed. Notes are free.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const API = 'https://api.geckoterminal.com/api/v2';
const FETCH_TIMEOUT_MS = 30000;
const UA = 'DexPoolPriceTracker/1.0 (+https://apify.com/scrapemint/dex-pool-price-tracker)';
// The venue rejects unknown timeframes with HTTP 400 rather than falling back.
const TIMEFRAMES = { minute: 'minute', hour: 'hour', day: 'day' };
// Matches the measured ~5-request quota: asking about more pools than this in
// one run guarantees a throttle rather than more data.
const MAX_HISTORY_POOLS = 5;

// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'pools',
    network = 'eth',
    poolList = 'trending',
    poolAddresses = [],
    timeframe = 'hour',
    aggregate = 1,
    candleLimit = 100,
    minLiquidityUsd = 0,
    minVolume24hUsd = 0,
    requestGapMs = 3000,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const net = String(network || 'eth').trim().toLowerCase() || 'eth';
const tf = TIMEFRAMES[String(timeframe || 'hour').toLowerCase()] || 'hour';
const agg = Math.max(1, Number(aggregate) || 1);
const candles = Math.max(1, Math.min(1000, Number(candleLimit) || 100));
const minLiq = Math.max(0, Number(minLiquidityUsd) || 0);
const minVol = Math.max(0, Number(minVolume24hUsd) || 0);
const gap = Math.max(1000, Math.min(15000, Number(requestGapMs) || 3000));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const addresses = asList(poolAddresses).slice(0, MAX_HISTORY_POOLS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let throttled = false;
let requests = 0;

// Paced GET with 429 backoff. The venue answers 429 in milliseconds, so a
// retry without a real wait just burns the budget; waits grow 15s, 30s, 45s.
async function getJson(url, attempt = 0) {
    if (pastDeadline()) return null;
    if (requests > 0) await sleep(gap);
    requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 429) {
            throttled = true;
            if (attempt < 3 && !pastDeadline()) {
                const wait = 15000 * (attempt + 1);
                log.warning(`Rate limited by the venue; waiting ${wait / 1000}s before retry ${attempt + 1}/3.`);
                await sleep(wait);
                return getJson(url, attempt + 1);
            }
            log.warning('Still rate limited after 3 retries; giving up on this request.');
            return null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 120)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Every numeric field arrives as a STRING ("0.00396995436661614"). Null and
// empty stay null so an unreported figure never publishes as a real 0.
const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const round = (n, dp = 4) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
// The venue reports market cap only when it knows circulating supply, and
// signals "unknown" as the string "0.0" as well as null. A live pool cannot
// have a zero market cap, so both map to null and buyers are told to use FDV.
const marketCap = (v) => {
    const n = num(v);
    return n == null || n === 0 ? null : n;
};
// Relationship ids look like "eth_0xC02aaA39...", so the address is the tail.
const relAddress = (rel) => {
    const id = rel?.data?.id;
    if (!id) return null;
    const i = String(id).indexOf('_');
    return i >= 0 ? String(id).slice(i + 1) : String(id);
};

let rowsPushed = 0;
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'pool_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

function poolRow(p) {
    const a = p.attributes || {};
    const r = p.relationships || {};
    const vol24 = num(a.volume_usd?.h24);
    const liq = num(a.reserve_in_usd);
    const tx24 = a.transactions?.h24 || {};
    const buys = num(tx24.buys);
    const sells = num(tx24.sells);
    const buyers = num(tx24.buyers);
    const sellers = num(tx24.sellers);
    // Turnover says how hard the pool's own liquidity is working. A high
    // reading on thin liquidity is the shape of a pool being churned.
    const turnover = vol24 != null && liq != null && liq > 0 ? vol24 / liq : null;
    const buySell = buys != null && sells != null && sells > 0 ? buys / sells : null;
    const buyerSeller = buyers != null && sellers != null && sellers > 0 ? buyers / sellers : null;
    return {
        recordType: 'pool',
        network: net,
        poolAddress: clean(a.address),
        poolName: clean(a.name),
        dex: relAddress(r.dex),
        baseTokenAddress: relAddress(r.base_token),
        quoteTokenAddress: relAddress(r.quote_token),
        priceUsd: num(a.base_token_price_usd),
        quotePriceUsd: num(a.quote_token_price_usd),
        priceChangePct5m: num(a.price_change_percentage?.m5),
        priceChangePct1h: num(a.price_change_percentage?.h1),
        priceChangePct24h: num(a.price_change_percentage?.h24),
        liquidityUsd: liq,
        volume24hUsd: vol24,
        turnoverRatio24h: round(turnover, 4),
        buys24h: buys,
        sells24h: sells,
        uniqueBuyers24h: buyers,
        uniqueSellers24h: sellers,
        buySellRatio24h: round(buySell, 4),
        uniqueBuyerSellerRatio24h: round(buyerSeller, 4),
        // Unique participants are harder to fake than raw counts, so the read
        // is stated on those and only when both sides are reported.
        flowRead: buyerSeller == null
            ? 'Unique buyer/seller counts not reported for this window.'
            : buyerSeller > 1.2 ? `More unique buyers than sellers (${round(buyerSeller, 2)}x).`
                : buyerSeller < 0.83 ? `More unique sellers than buyers (${round(1 / buyerSeller, 2)}x).`
                    : 'Buyers and sellers roughly balanced.',
        fdvUsd: num(a.fdv_usd),
        marketCapUsd: marketCap(a.market_cap_usd),
        marketCapReported: marketCap(a.market_cap_usd) != null,
        poolFeePercentage: num(a.pool_fee_percentage),
        lockedLiquidityPct: num(a.locked_liquidity_percentage),
        poolCreatedAt: clean(a.pool_created_at),
        url: a.address ? `https://www.geckoterminal.com/${net}/pools/${a.address}` : null,
        scrapedAt: new Date().toISOString(),
    };
}

// ---- Run ---------------------------------------------------------------
log.info(`mode=${mode} network=${net} ${mode === 'history' ? `timeframe=${tf} aggregate=${agg} candles<=${candles}` : `list=${poolList}`} gap=${gap}ms cap=${cap} rows.`);

let emitted = 0;

if (mode === 'networks') {
    const d = await getJson(`${API}/networks`);
    for (const n of d?.data || []) {
        if (rowsPushed >= cap) break;
        await flushRow({
            recordType: 'network',
            networkId: clean(n.id),
            name: clean(n.attributes?.name),
            coingeckoAssetPlatformId: clean(n.attributes?.coingecko_asset_platform_id),
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
} else if (mode === 'history') {
    if (!addresses.length) {
        await flushRow({
            note: 'History mode needs at least one pool address. Run pools mode first and copy poolAddress values from its rows.',
            network: net,
        }, false);
    }
    for (const addr of addresses) {
        if (rowsPushed >= cap || pastDeadline()) break;
        const p = new URLSearchParams({ aggregate: String(agg), limit: String(candles) });
        const d = await getJson(`${API}/networks/${encodeURIComponent(net)}/pools/${encodeURIComponent(addr)}/ohlcv/${tf}?${p}`);
        const list = d?.data?.attributes?.ohlcv_list;
        if (!Array.isArray(list) || !list.length) {
            await flushRow({
                note: `No ${tf} candles returned for pool ${addr} on ${net}.${throttled ? ' The venue rate limited this run, so this may be throttling rather than an empty pool.' : ''}`,
                network: net,
                poolAddress: addr,
            }, false);
            continue;
        }
        for (const c of list) {
            if (rowsPushed >= cap) break;
            // [timestamp(SECONDS), open, high, low, close, volume]
            const ts = num(c[0]);
            await flushRow({
                recordType: 'candle',
                network: net,
                poolAddress: addr,
                timeframe: tf,
                aggregate: agg,
                timestamp: ts,
                openedAt: ts != null ? new Date(ts * 1000).toISOString() : null,
                open: num(c[1]),
                high: num(c[2]),
                low: num(c[3]),
                close: num(c[4]),
                volumeUsd: num(c[5]),
                url: `https://www.geckoterminal.com/${net}/pools/${addr}`,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
    }
} else {
    const listPath = String(poolList).toLowerCase() === 'new' ? 'new_pools' : 'trending_pools';
    const d = await getJson(`${API}/networks/${encodeURIComponent(net)}/${listPath}`);
    const pools = d?.data || [];
    let filtered = 0;
    for (const p of pools) {
        if (rowsPushed >= cap) break;
        const row = poolRow(p);
        if (minLiq > 0 && (row.liquidityUsd == null || row.liquidityUsd < minLiq)) { filtered += 1; continue; }
        if (minVol > 0 && (row.volume24hUsd == null || row.volume24hUsd < minVol)) { filtered += 1; continue; }
        await flushRow(row);
        emitted += 1;
    }
    if (!pools.length) {
        await flushRow({
            note: throttled
                ? `The venue rate limited this run, so no pools were returned for ${net}. GeckoTerminal throttles shared datacenter IPs aggressively; raise requestGapMs or retry shortly.`
                : `No pools returned for network "${net}" (${listPath}). Run networks mode to list valid network ids.`,
            network: net,
        }, false);
    } else if (emitted === 0 && filtered > 0) {
        await flushRow({
            note: `All ${filtered} pool(s) on ${net} were filtered out by minLiquidityUsd=${minLiq} / minVolume24hUsd=${minVol}. Lower the thresholds to see them.`,
            network: net,
        }, false);
    }
}

if (throttled && emitted > 0) {
    await flushRow({
        note: 'The venue rate limited at least one request during this run, so results may be partial. GeckoTerminal throttles shared datacenter IPs aggressively; raise requestGapMs for larger pulls.',
        network: net,
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable), ${requests} request(s), throttled=${throttled}.`);
await Actor.exit();
