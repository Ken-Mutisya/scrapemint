// Kalshi Trades: the live trade tape, whale trades and price history.
//
// Strategy
// --------
// Kalshi's public trade API (/markets/trades) returns every fill, newest
// first, 1,000 per page with a cursor. It filters by ONE market ticker and by
// time (min_ts / max_ts) only; event_ticker and series_ticker are silently
// ignored, so events and series are resolved to their market tickers first.
//
//   1. Tickers given (markets, events or series): page each market's trades
//      back to the lookback window.
//   2. Nothing given: whale scan. Page the whole exchange's tape back
//      whaleScanMinutes (~6,000 fills a minute in Oct 2026) and keep fills
//      at or above minNotionalUsd, largest first.
//   3. Optional candles: /series/{s}/markets/{t}/candlesticks per market,
//      1 minute, 1 hour or 1 day, over the same lookback.
//
// Notional is what the taker paid: contracts x the price of the side taken
// (yes_price for a YES taker, no_price for a NO taker). Market titles come
// from /markets/{ticker}, cached, and only for rows that survive the filters.
//
// No key, no proxy. Tested from Apify on 2026-10-18.
//
// Pay per event
// -------------
//   trade_row  ($0.0008) one fill
//   candle_row ($0.0004) one candle
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'KalshiTradesTracker/1.0 (+https://apify.com/scrapemint/kalshi-trades-tracker)';
const GAP_MS = 120;
const MAX_MARKETS = 300;
const INTERVALS = { '1m': 1, '1h': 60, '1d': 1440 };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    marketTickers = [],
    eventTickers = [],
    seriesTickers = [],
    lookbackHours = 24,
    whaleScanMinutes = 30,
    minNotionalUsd,
    minContracts = 0,
    maxTakerPrice = 0.97,
    takerSide = 'any',
    includeTrades = true,
    includeCandles = false,
    candleInterval = '1h',
    maxRows = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);
const cap = Math.max(1, Number(maxRows) || 1000);
const seriesOf = (ticker) => String(ticker || '').split('-')[0] || null;
const urlOf = (ticker) => `https://kalshi.com/markets/${String(seriesOf(ticker)).toLowerCase()}`;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) {
                last = new Error(`HTTP ${r.status}`);
                await sleep(2000 * (attempt + 1));
                continue;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            last = err;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

// ---- market metadata (cached) ----
const markets = new Map();
function remember(m) {
    if (!m?.ticker) return;
    markets.set(m.ticker, {
        title: m.title || null,
        outcome: m.yes_sub_title || null,
        eventTicker: m.event_ticker || null,
        status: m.status || null,
        closeTime: m.close_time || null,
        lastPrice: num(m.last_price_dollars),
    });
}
async function meta(ticker) {
    if (!markets.has(ticker)) {
        await sleep(GAP_MS);
        const d = await getJson(`${KALSHI}/markets/${encodeURIComponent(ticker)}`).catch(() => null);
        if (d?.market) remember(d.market);
        else markets.set(ticker, null);
    }
    return markets.get(ticker);
}

async function marketsWhere(params) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 20 && out.length < MAX_MARKETS; page++) {
        const q = new URLSearchParams({ limit: '1000', ...params });
        if (cursor) q.set('cursor', cursor);
        await sleep(GAP_MS);
        const d = await getJson(`${KALSHI}/markets?${q}`).catch((err) => { log.warning(`markets ${q}: ${err.message}`); return null; });
        for (const m of d?.markets || []) { remember(m); out.push(m.ticker); }
        cursor = d?.cursor || '';
        if (!cursor) break;
    }
    return out;
}

// ---- resolve the markets to read ----
const wanted = new Set(list(marketTickers));
for (const e of list(eventTickers)) for (const t of await marketsWhere({ event_ticker: e })) wanted.add(t);
// A series can hold thousands of settled markets; open ones are what people track.
for (const s of list(seriesTickers)) for (const t of await marketsWhere({ series_ticker: s, status: 'open' })) wanted.add(t);
const tickers = [...wanted].slice(0, MAX_MARKETS);
if (wanted.size > MAX_MARKETS) log.warning(`${wanted.size} markets resolved; reading the first ${MAX_MARKETS}.`);

const whaleMode = tickers.length === 0;
const asked = list(marketTickers).length + list(eventTickers).length + list(seriesTickers).length;
const nowS = Math.floor(Date.now() / 1000);
const lookbackS = whaleMode
    ? Math.min(240, Math.max(1, Number(whaleScanMinutes) || 30)) * 60
    : Math.min(24 * 90, Math.max(1, Number(lookbackHours) || 24)) * 3600;
const minTs = nowS - lookbackS;
const minUsd = Math.max(0, num(minNotionalUsd) ?? (whaleMode ? 1000 : 0));
const minQty = Math.max(0, Number(minContracts) || 0);
const side = String(takerSide).toLowerCase();
// Fills at 98-99.9c on contracts about to settle are large but say nothing.
const maxPrice = Math.min(1, Math.max(0.01, num(maxTakerPrice) ?? 0.97));

// ---- charging ----
let rowsOut = 0;
let stop = false;
async function emit(row, eventName) {
    await Actor.pushData(row);
    rowsOut++;
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    if (rowsOut >= cap) stop = true;
}

function tradeRow(t, m) {
    const contracts = num(t.count_fp);
    const yes = num(t.yes_price_dollars);
    const no = num(t.no_price_dollars);
    const takerPrice = t.taker_side === 'yes' ? yes : t.taker_side === 'no' ? no : null;
    return {
        type: 'trade',
        time: t.created_time,
        marketTicker: t.ticker,
        marketTitle: m?.title ?? null,
        outcome: m?.outcome ?? null,
        takerSide: t.taker_side || null,
        contracts,
        yesPrice: yes,
        noPrice: no,
        takerPrice,
        notionalUsd: contracts != null && takerPrice != null ? r2(contracts * takerPrice) : null,
        isBlockTrade: t.is_block_trade ?? null,
        eventTicker: m?.eventTicker ?? null,
        seriesTicker: seriesOf(t.ticker),
        marketStatus: m?.status ?? null,
        tradeId: t.trade_id,
        url: urlOf(t.ticker),
    };
}

const keep = (t) => {
    const contracts = num(t.count_fp) ?? 0;
    const price = t.taker_side === 'yes' ? num(t.yes_price_dollars) : num(t.no_price_dollars);
    if (contracts < minQty) return false;
    if (price != null && price > maxPrice) return false;
    if (minUsd > 0 && (price == null || contracts * price < minUsd)) return false;
    if (side !== 'any' && t.taker_side !== side) return false;
    return true;
};

async function* tape(ticker) {
    let cursor = '';
    for (let page = 0; page < 2000; page++) {
        if (pastDeadline()) { log.warning('Close to the run timeout; stopping the tape early.'); return; }
        const q = new URLSearchParams({ limit: '1000', min_ts: String(minTs), max_ts: String(nowS) });
        if (ticker) q.set('ticker', ticker);
        if (cursor) q.set('cursor', cursor);
        await sleep(GAP_MS);
        const d = await getJson(`${KALSHI}/markets/trades?${q}`);
        for (const t of d?.trades || []) yield t;
        cursor = d?.cursor || '';
        if (!cursor || !d?.trades?.length) return;
    }
}

let tradesSeen = 0;
const failures = [];

// Candles first: they are few per market, and a busy tape would otherwise
// use up maxRows before any candle is written.
if (includeCandles && !stop) {
    const interval = INTERVALS[candleInterval] ?? 60;
    // A 1-minute series over 90 days would be 130k candles per market; keep the window sane.
    const span = Math.min(lookbackS, interval === 1 ? 2 * 86400 : interval === 60 ? 60 * 86400 : 2 * 365 * 86400);
    const candleMarkets = whaleMode ? [] : tickers;
    if (whaleMode) log.warning('Candles need market, event or series tickers; skipped in the whale scan.');
    for (const ticker of candleMarkets) {
        if (stop || pastDeadline()) break;
        const m = await meta(ticker);
        await sleep(GAP_MS);
        const q = new URLSearchParams({ start_ts: String(nowS - span), end_ts: String(nowS), period_interval: String(interval) });
        let d;
        try {
            d = await getJson(`${KALSHI}/series/${seriesOf(m?.eventTicker || ticker)}/markets/${encodeURIComponent(ticker)}/candlesticks?${q}`);
        } catch (err) { failures.push({ scope: `${ticker} candles`, error: err.message }); continue; }
        for (const c of d?.candlesticks || []) {
            if (stop) break;
            const p = c.price || {};
            await emit({
                type: 'candle',
                time: new Date(c.end_period_ts * 1000).toISOString(),
                interval: candleInterval in INTERVALS ? candleInterval : '1h',
                marketTicker: ticker,
                marketTitle: m?.title ?? null,
                outcome: m?.outcome ?? null,
                open: num(p.open_dollars),
                high: num(p.high_dollars),
                low: num(p.low_dollars),
                close: num(p.close_dollars),
                meanPrice: r4(num(p.mean_dollars)),
                yesBidClose: num(c.yes_bid?.close_dollars),
                yesAskClose: num(c.yes_ask?.close_dollars),
                volume: num(c.volume_fp),
                openInterest: num(c.open_interest_fp),
                eventTicker: m?.eventTicker ?? null,
                seriesTicker: seriesOf(ticker),
                url: urlOf(ticker),
            }, 'candle_row');
        }
    }
}


if (includeTrades && whaleMode) {
    if (asked) log.warning('None of the given tickers matched a Kalshi market; running the whale scan instead.');
    log.info(`Whale scan: whole exchange, last ${lookbackS / 60} min, fills >= $${minUsd}.`);
    const hits = [];
    try {
        for await (const t of tape(null)) {
            tradesSeen++;
            if (keep(t)) hits.push(t);
        }
    } catch (err) { failures.push({ scope: 'whale scan', error: err.message }); }
    hits.sort((a, b) => {
        const v = (t) => num(t.count_fp) * (t.taker_side === 'yes' ? num(t.yes_price_dollars) : num(t.no_price_dollars));
        return v(b) - v(a);
    });
    for (const t of hits) {
        if (stop) break;
        await emit(tradeRow(t, await meta(t.ticker)), 'trade_row');
    }
} else if (includeTrades) {
    log.info(`Trades for ${tickers.length} market(s), last ${lookbackS / 3600} h${minUsd ? `, fills >= $${minUsd}` : ''}.`);
    for (const ticker of tickers) {
        if (stop) break;
        const m = await meta(ticker);
        try {
            for await (const t of tape(ticker)) {
                tradesSeen++;
                if (!keep(t)) continue;
                await emit(tradeRow(t, m), 'trade_row');
                if (stop) break;
            }
        } catch (err) { failures.push({ scope: ticker, error: err.message }); }
    }
}

if (rowsOut === 0) {
    const why = whaleMode
        ? `No fills of $${minUsd} or more in the last ${lookbackS / 60} minutes. Lower minNotionalUsd or raise whaleScanMinutes.`
        : `No trades matched in the last ${lookbackS / 3600} hours for ${tickers.length} market(s).`;
    await Actor.pushData({ type: 'note', note: `${why} Not charged.` });
}

await Actor.setValue('SUMMARY', { rows: rowsOut, tradesScanned: tradesSeen, markets: tickers.length, whaleMode, lookbackMinutes: lookbackS / 60, minNotionalUsd: minUsd, failures });
log.info(`Done: ${rowsOut} row(s) from ${tradesSeen} trade(s) scanned.`);
await Actor.exit();
