// Crypto Liquidation Map: where the biggest leveraged positions on
// Hyperliquid get liquidated, as price levels (a liquidation heatmap) and as
// the individual positions closest to liquidation.
//
// Strategy
// --------
// Liquidation heatmaps on centralised exchanges are estimates: nobody outside
// the exchange can see positions. Hyperliquid is on-chain, so every
// position's real liquidation price is public.
//
//   1. POST api.hyperliquid.xyz/info {type: metaAndAssetCtxs} for the mark
//      price of every perp.
//   2. GET stats-data.hyperliquid.xyz/Mainnet/leaderboard (~47,000 accounts,
//      ~38 MB) and take the largest accounts by account value.
//   3. POST /info {type: clearinghouseState, user} per account for its open
//      positions: size, entry, leverage, liquidationPx. ~6 lookups a second
//      at concurrency 6 without 429s (2026-10-18).
//   4. Bucket liquidation prices per coin into bands of bucketPct around the
//      mark. Longs liquidate below the mark, shorts above. Cumulative
//      notional runs outward from the mark, so "how much gets liquidated if
//      BTC drops 5%" is one row.
//
// Positions with no liquidation price (enough collateral that it can't be
// liquidated) count in the coin summary but not on the map.
//
// No key, no proxy. Tested from Apify on 2026-10-18.
//
// Pay per event
// -------------
//   level_row    ($0.002) one price band for one coin
//   position_row ($0.001) one position
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const INFO = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const UA = 'CryptoLiquidationMap/1.0 (+https://apify.com/scrapemint/crypto-liquidation-map)';
const CONCURRENCY = 6;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    coins = ['BTC', 'ETH', 'SOL'],
    topAccounts = 2000,
    minPositionUsd = 10000,
    bucketPct = 1,
    rangePct = 25,
    output = 'both',
    maxPositions = 200,
    maxDistancePct,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const sig = (n) => (n == null ? null : Number(n.toPrecision(6)));
const wantCoins = new Set(list(coins));
const nAccounts = Math.min(3000, Math.max(10, Number(topAccounts) || 2000));
const minUsd = Math.max(0, Number(minPositionUsd) || 0);
const band = Math.min(10, Math.max(0.1, Number(bucketPct) || 1));
const range = Math.min(90, Math.max(band, Number(rangePct) || 25));
const mode = ['levels', 'positions', 'both'].includes(output) ? output : 'both';
const posCap = Math.max(0, Number(maxPositions) ?? 200);
const maxDist = num(maxDistancePct);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

async function req(url, body) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, {
                method: body ? 'POST' : 'GET',
                body: body ? JSON.stringify(body) : undefined,
                headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
                signal: AbortSignal.timeout(60_000),
            });
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(2000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            last = err;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

// ---- 1. mark prices ----
const [meta, ctxs] = await req(INFO, { type: 'metaAndAssetCtxs' });
const mark = new Map();
meta.universe.forEach((u, i) => { const px = num(ctxs[i]?.markPx); if (px) mark.set(u.name, px); });
const unknown = [...wantCoins].filter((c) => !mark.has(c));
if (unknown.length) log.warning(`Not Hyperliquid perps, skipped: ${unknown.join(', ')}`);
const coinOk = (c) => (wantCoins.size ? wantCoins.has(c) : true) && mark.has(c);

// ---- 2. accounts ----
log.info('Reading the Hyperliquid leaderboard...');
const lb = await req(LEADERBOARD);
const accounts = (lb?.leaderboardRows || [])
    .map((r) => ({ address: r.ethAddress, accountValue: num(r.accountValue) ?? 0, name: r.displayName || null }))
    .sort((a, b) => b.accountValue - a.accountValue)
    .slice(0, nAccounts);
log.info(`Reading positions of the ${accounts.length} largest accounts...`);

// ---- 3. positions ----
const positions = [];
let read = 0;
let failed = 0;
let next = 0;
async function worker() {
    while (next < accounts.length && !pastDeadline()) {
        const a = accounts[next++];
        try {
            const s = await req(INFO, { type: 'clearinghouseState', user: a.address });
            read++;
            for (const { position: p } of s?.assetPositions || []) {
                if (!coinOk(p.coin)) continue;
                const size = num(p.szi);
                const value = num(p.positionValue);
                if (!size || value == null || value < minUsd) continue;
                const px = mark.get(p.coin);
                const liq = num(p.liquidationPx);
                positions.push({
                    coin: p.coin,
                    side: size > 0 ? 'long' : 'short',
                    sizeCoins: Math.abs(size),
                    notionalUsd: r2(value),
                    entryPrice: num(p.entryPx),
                    markPrice: px,
                    liquidationPrice: liq != null && liq > 0 ? sig(liq) : null,
                    distanceToLiquidationPct: liq != null && liq > 0 ? r2(((liq - px) / px) * 100) : null,
                    leverage: num(p.leverage?.value),
                    marginType: p.leverage?.type || null,
                    unrealizedPnlUsd: r2(num(p.unrealizedPnl)),
                    returnOnEquityPct: r2((num(p.returnOnEquity) ?? 0) * 100),
                    marginUsedUsd: r2(num(p.marginUsed)),
                    fundingSinceOpenUsd: r2(num(p.cumFunding?.sinceOpen)),
                    address: a.address,
                    accountName: a.name,
                    accountValueUsd: r2(a.accountValue),
                    accountUrl: `https://app.hyperliquid.xyz/explorer/address/${a.address}`,
                });
            }
        } catch (err) {
            failed++;
            if (failed <= 3) log.warning(`${a.address}: ${err.message}`);
        }
        if (read % 100 === 0 && read) log.info(`${read}/${accounts.length} accounts read, ${positions.length} positions.`);
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (pastDeadline()) log.warning(`Close to the run timeout; mapped ${read} of ${accounts.length} accounts.`);

// ---- 4. output ----
let rowsOut = 0;
let stop = false;
async function emit(row, eventName) {
    await Actor.pushData(row);
    rowsOut++;
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

const byCoin = new Map();
for (const p of positions) {
    if (!byCoin.has(p.coin)) byCoin.set(p.coin, []);
    byCoin.get(p.coin).push(p);
}
const coinOrder = [...byCoin.keys()].sort((a, b) => byCoin.get(b).reduce((s, p) => s + p.notionalUsd, 0) - byCoin.get(a).reduce((s, p) => s + p.notionalUsd, 0));

if (mode !== 'positions') {
    for (const coin of coinOrder) {
        if (stop) break;
        const px = mark.get(coin);
        const ps = byCoin.get(coin);
        const longOI = ps.filter((p) => p.side === 'long').reduce((s, p) => s + p.notionalUsd, 0);
        const shortOI = ps.filter((p) => p.side === 'short').reduce((s, p) => s + p.notionalUsd, 0);
        for (const side of ['long', 'short']) {
            // Band k covers k*band% to (k+1)*band% away from the mark, below for longs, above for shorts.
            const bands = new Map();
            for (const p of ps) {
                if (p.side !== side || p.distanceToLiquidationPct == null) continue;
                const d = side === 'long' ? -p.distanceToLiquidationPct : p.distanceToLiquidationPct;
                if (d < 0 || d >= range) continue; // already past the mark (being liquidated) or out of range
                const k = Math.floor(d / band);
                const b = bands.get(k) || { notional: 0, count: 0, largest: 0 };
                b.notional += p.notionalUsd; b.count++; b.largest = Math.max(b.largest, p.notionalUsd);
                bands.set(k, b);
            }
            let cumulative = 0;
            for (const k of [...bands.keys()].sort((a, b) => a - b)) {
                if (stop) break;
                const b = bands.get(k);
                cumulative += b.notional;
                const near = px * (1 + (side === 'long' ? -1 : 1) * (k * band) / 100);
                const far = px * (1 + (side === 'long' ? -1 : 1) * ((k + 1) * band) / 100);
                await emit({
                    type: 'level',
                    coin,
                    side,
                    markPrice: px,
                    priceFrom: sig(Math.min(near, far)),
                    priceTo: sig(Math.max(near, far)),
                    distancePct: r2((side === 'long' ? -1 : 1) * (k + 0.5) * band),
                    liquidationNotionalUsd: r2(b.notional),
                    positions: b.count,
                    largestPositionUsd: r2(b.largest),
                    cumulativeNotionalUsd: r2(cumulative),
                    sideOpenInterestMappedUsd: r2(side === 'long' ? longOI : shortOI),
                    accountsScanned: read,
                }, 'level_row');
            }
        }
    }
}

if (mode !== 'levels' && !stop) {
    const ranked = positions
        .filter((p) => p.distanceToLiquidationPct != null && (maxDist == null || Math.abs(p.distanceToLiquidationPct) <= maxDist))
        .sort((a, b) => Math.abs(a.distanceToLiquidationPct) - Math.abs(b.distanceToLiquidationPct));
    for (const p of ranked.slice(0, posCap)) {
        if (stop) break;
        await emit({ type: 'position', ...p }, 'position_row');
    }
}

if (rowsOut === 0) {
    await Actor.pushData({ type: 'note', note: `No positions of $${minUsd} or more with a liquidation price in ${wantCoins.size ? [...wantCoins].join(', ') : 'any coin'} among the ${read} largest accounts. Not charged.` });
}
await Actor.setValue('SUMMARY', {
    rows: rowsOut,
    accountsRead: read,
    accountsFailed: failed,
    positions: positions.length,
    perCoin: Object.fromEntries(coinOrder.map((c) => [c, { positions: byCoin.get(c).length, notionalUsd: r2(byCoin.get(c).reduce((s, p) => s + p.notionalUsd, 0)), markPrice: mark.get(c) }])),
});
log.info(`Done: ${rowsOut} row(s) from ${positions.length} position(s) in ${read} account(s).`);
await Actor.exit();
