// Crypto Long/Short Ratio: trader positioning by exchange
//
// Strategy
// --------
// Public market-data endpoints, no key, reachable from Apify datacenter IPs
// (verified 2026-11-27). Binance and Bybit refuse US/cloud IPs (451/403), so
// the actor uses the three large venues that answer:
//   OKX     /api/v5/rubik/stat/contracts/long-short-account-ratio-contract        all accounts
//           /api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader
//           /api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader
//           /api/v5/rubik/stat/taker-volume-contract                                taker buy/sell
//   Bitget  /api/v2/mix/market/long-short            all accounts
//           /api/v2/mix/market/account-long-short    elite (top) trader accounts
//           /api/v2/mix/market/position-long-short   elite (top) trader positions
//   Gate    /api/v4/futures/usdt/contract_stats      all + top accounts, top positions,
//                                                    taker ratio, open interest, liquidations
// Every source is mapped onto one schema; a ratio r becomes longPct = r/(1+r).
//
// Pay per event
// -------------
//   snapshot ($0.002)        latest reading for one coin on one exchange
//   history_point ($0.0005)  one past reading (history mode)
//   The first row of every run is free. Notes are free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 1;
const PERIODS = {
    '5m': { okx: '5m', bitget: '5m', gate: '5m', ms: 300e3 },
    '15m': { okx: '15m', bitget: '15m', gate: '15m', ms: 900e3 },
    '1h': { okx: '1H', bitget: '1h', gate: '1h', ms: 3600e3 },
    '4h': { okx: '4H', bitget: '4h', gate: '4h', ms: 4 * 3600e3 },
    '1d': { okx: '1D', bitget: '1d', gate: '1d', ms: 86400e3 },
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    symbols = ['BTC', 'ETH', 'SOL'],
    exchanges = ['okx', 'bitget', 'gate'],
    period = '1h',
    mode = 'snapshot',
    historyPoints = 24,
    maxRows = 2000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;\s]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const pctOf = (ratio) => (ratio === null || ratio === undefined ? null : r4((ratio / (1 + ratio)) * 100));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Math.min(50000, Number(maxRows) || 2000));
const per = PERIODS[String(period).toLowerCase()] ?? PERIODS['1h'];
const isHistory = String(mode).toLowerCase() === 'history';
const points = Math.max(1, Math.min(100, Number(historyPoints) || 24));
const exs = list(exchanges).map((e) => e.toLowerCase()).filter((e) => ['okx', 'bitget', 'gate'].includes(e));
if (!exs.length) exs.push('okx', 'bitget', 'gate');

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            if (res.ok) return await res.json();
            if (res.status === 400 || res.status === 404) return null;
            log.warning(`HTTP ${res.status} ${url.slice(0, 110)} (attempt ${attempt})`);
        } catch (err) { log.warning(`${err.message} (attempt ${attempt})`); }
        await sleep(1200 * attempt);
    }
    return null;
}

// Each loader returns Map<timeMs, partialRow>
function put(map, t, fields) {
    const k = Math.floor(Number(t) / per.ms) * per.ms;
    map.set(k, { ...(map.get(k) ?? {}), ...fields });
}

async function okx(coin) {
    const inst = `${coin}-USDT-SWAP`;
    const q = `instId=${inst}&period=${per.okx}&limit=${isHistory ? points + 1 : 3}`;
    const base = 'https://www.okx.com/api/v5/rubik/stat';
    const [all, topAcc, topPos, taker] = await Promise.all([
        getJson(`${base}/contracts/long-short-account-ratio-contract?${q}`),
        getJson(`${base}/contracts/long-short-account-ratio-contract-top-trader?${q}`),
        getJson(`${base}/contracts/long-short-position-ratio-contract-top-trader?${q}`),
        getJson(`${base}/taker-volume-contract?${q}`),
    ]);
    const m = new Map();
    for (const [t, v] of all?.data ?? []) put(m, t, { allAccountsRatio: num(v) });
    for (const [t, v] of topAcc?.data ?? []) put(m, t, { topTraderAccountRatio: num(v) });
    for (const [t, v] of topPos?.data ?? []) put(m, t, { topTraderPositionRatio: num(v) });
    for (const [t, sell, buy] of taker?.data ?? []) {
        // OKX taker-volume-contract rows are [ts, sellVol, buyVol] in contracts.
        const b = num(buy); const s = num(sell);
        put(m, t, { takerBuyVolume: b, takerSellVolume: s, takerBuySellRatio: b && s ? r4(b / s) : null });
    }
    return { market: inst, rows: m };
}

async function bitget(coin) {
    const sym = `${coin}USDT`;
    const q = `symbol=${sym}&period=${per.bitget}`;
    const base = 'https://api.bitget.com/api/v2/mix/market';
    const [all, acc, pos] = await Promise.all([
        getJson(`${base}/long-short?${q}`),
        getJson(`${base}/account-long-short?${q}`),
        getJson(`${base}/position-long-short?${q}`),
    ]);
    const m = new Map();
    for (const x of all?.data ?? []) put(m, x.ts, { allAccountsRatio: num(x.longShortRatio) });
    for (const x of acc?.data ?? []) put(m, x.ts, { topTraderAccountRatio: num(x.longShortAccountRatio) });
    for (const x of pos?.data ?? []) put(m, x.ts, { topTraderPositionRatio: num(x.longShortPositionRatio) });
    return { market: sym, rows: m };
}

async function gate(coin) {
    const c = `${coin}_USDT`;
    const d = await getJson(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${c}&interval=${per.gate}&limit=${isHistory ? points + 1 : 3}`);
    const m = new Map();
    for (const x of Array.isArray(d) ? d : []) {
        put(m, Number(x.time) * 1000, {
            allAccountsRatio: num(x.lsr_account),
            topTraderAccountRatio: num(x.top_lsr_account),
            topTraderPositionRatio: num(x.top_lsr_size),
            takerBuySellRatio: r4(num(x.lsr_taker)),
            openInterestUsd: num(x.open_interest_usd) !== null ? Math.round(num(x.open_interest_usd)) : null,
            longLiquidationsUsd: num(x.long_liq_usd_new ?? x.long_liq_usd),
            shortLiquidationsUsd: num(x.short_liq_usd_new ?? x.short_liq_usd),
            markPrice: num(x.mark_price),
        });
    }
    return { market: c, rows: m };
}

const LOAD = { okx, bitget, gate };
let pushed = 0;
let billable = 0;
let stop = false;
async function emit(row, eventName) {
    if (pushed >= cap) { stop = true; return; }
    await Actor.pushData(row);
    pushed += 1;
    billable += 1;
    if (billable > FREE_TIER_ROWS) {
        try {
            const r = await Actor.charge({ eventName });
            if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

function shape(exchange, coin, market, t, f) {
    const all = r4(f.allAccountsRatio);
    const topA = r4(f.topTraderAccountRatio);
    const topP = r4(f.topTraderPositionRatio);
    return {
        exchange, symbol: coin, market, period: String(period).toLowerCase(), time: new Date(t).toISOString(),
        allAccountsRatio: all, allAccountsLongPct: pctOf(all),
        topTraderAccountRatio: topA, topTraderAccountLongPct: pctOf(topA),
        topTraderPositionRatio: topP, topTraderPositionLongPct: pctOf(topP),
        // Retail crowded long while top traders lean short (or the reverse).
        crowdVsTopTraders: all !== null && topP !== null ? (all > 1 && topP < 1 ? 'crowd long, top traders short' : (all < 1 && topP > 1 ? 'crowd short, top traders long' : 'aligned')) : null,
        takerBuySellRatio: f.takerBuySellRatio ?? null,
        takerBuyVolume: f.takerBuyVolume ?? null,
        takerSellVolume: f.takerSellVolume ?? null,
        openInterestUsd: f.openInterestUsd ?? null,
        longLiquidationsUsd: f.longLiquidationsUsd ?? null,
        shortLiquidationsUsd: f.shortLiquidationsUsd ?? null,
        markPrice: f.markPrice ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

const coins = [...new Set(list(symbols).map((s) => s.toUpperCase().replace(/[-_/]?USDT?$/, '')))];
if (!coins.length) coins.push('BTC');
log.info(`${coins.length} coin(s) x ${exs.join(', ')} | period ${period} | ${isHistory ? `history, ${points} points` : 'snapshot'}`);
for (const coin of coins) {
    for (const ex of exs) {
        if (stop) break;
        const { market, rows } = await LOAD[ex](coin);
        const times = [...rows.keys()].sort((a, b) => b - a);
        if (!times.length) {
            await Actor.pushData({ exchange: ex, symbol: coin, note: `${ex} has no ${coin} USDT perpetual (or no data for this period). Not charged.` });
            continue;
        }
        if (isHistory) {
            for (const t of times.filter((x) => x + per.ms <= Date.now()).slice(0, points)) { if (stop) break; await emit(shape(ex, coin, market, t, rows.get(t)), 'history_point'); }
        } else {
            // The newest bucket is the period still in progress, so its taker
            // volumes are partial. Use the latest COMPLETED period, the same on
            // every exchange; fall back to the newest if nothing has closed yet.
            const done = times.find((t) => t + per.ms <= Date.now()) ?? times[0];
            await emit(shape(ex, coin, market, done, rows.get(done)), 'snapshot');
        }
        await sleep(150);
    }
}
await Actor.setValue('SUMMARY', { coins, exchanges: exs, period, mode: isHistory ? 'history' : 'snapshot', rows: pushed });
log.info(`Done. ${pushed} row(s); first ${FREE_TIER_ROWS} free, notes free.`);
await Actor.exit();
