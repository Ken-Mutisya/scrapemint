// Stock Price History Scraper
// Daily OHLCV (open, high, low, close, volume) for any stock or ETF ticker over
// a date range, from Nasdaq's keyless JSON API. No browser, no proxy.
//
// Endpoint (keyless JSON, needs a normal User-Agent):
//   /api/quote/{SYMBOL}/historical?assetclass=stocks&fromdate=YYYY-MM-DD&todate=YYYY-MM-DD&limit=9999
//   -> data.tradesTable.rows = [{ date:"M/D/YYYY", open:"$..", high, low, close, volume:"1,234" }]
//
// Free tier: first 20 rows per run are free, then each price row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 20;
const NASDAQ = 'https://api.nasdaq.com/api';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
};
const POLITE_SLEEP_MS = 200;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    fromDate,
    toDate,
    assetClass = 'auto',
    maxRowsPerTicker = 5000,
    maxRowsTotal = 50000,
} = input;

const symbols = (Array.isArray(tickers) ? tickers : [])
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);

if (symbols.length === 0) {
    log.warning('No tickers provided. Set "tickers", e.g. ["AAPL","MSFT"].');
    await Actor.exit();
}

const today = new Date();
const from = parseDate(fromDate) || addDays(atMidnight(today), -30);
const to = parseDate(toDate) || atMidnight(today);
const fromStr = fmt(from);
const toStr = fmt(to);

const CLASSES = assetClass === 'auto' ? ['stocks', 'etf', 'index'] : [assetClass];

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

let pushed = 0;

log.info(`Price history ${fromStr} -> ${toStr} for ${symbols.length} ticker(s): ${symbols.join(', ')}`);

for (const symbol of symbols) {
    if (done()) break;
    const rows = await fetchHistory(symbol);
    if (!rows) {
        log.warning(`No data for ${symbol} (unknown symbol or no trades in range).`);
        continue;
    }
    let perTicker = 0;
    for (const r of rows) {
        if (done() || perTicker >= maxRowsPerTicker) break;
        const date = usDate(r.date);
        if (!date) continue;
        await pushRow({
            symbol,
            date,
            open: money(r.open),
            high: money(r.high),
            low: money(r.low),
            close: money(r.close),
            volume: toInt(r.volume),
        });
        perTicker += 1;
    }
    log.info(`${symbol}: pushed ${perTicker} rows.`);
    await sleep(POLITE_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} price rows.`);
await Actor.exit();

// ---------- core ----------

async function fetchHistory(symbol) {
    for (const cls of CLASSES) {
        const url = `${NASDAQ}/quote/${encodeURIComponent(symbol)}/historical`
            + `?assetclass=${cls}&fromdate=${fromStr}&todate=${toStr}&limit=9999`;
        const data = (await fetchJson(url))?.data;
        const rows = data?.tradesTable?.rows;
        if (Array.isArray(rows) && rows.length) return rows;
    }
    return null;
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'price_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 100 === 0) log.info(`Pushed ${pushed} rows...`);
}

function done() {
    if (pushed >= maxRowsTotal) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            log.warning(`HTTP ${res.status} for ${url}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`fetch failed ${url}: ${err?.message}`);
        return null;
    }
}

// ---------- parsing helpers ----------

function money(s) {
    if (s === null || s === undefined || s === '' || s === 'N/A') return null;
    const n = Number(String(s).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
}
function toInt(s) {
    if (s === null || s === undefined || s === '' || s === 'N/A') return null;
    const n = Number(String(s).replace(/[^0-9]/g, ''));
    return Number.isFinite(n) ? n : null;
}
function usDate(s) {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
function parseDate(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}
function atMidnight(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d, n) {
    return new Date(d.getTime() + n * 86400000);
}
function fmt(d) {
    return d.toISOString().slice(0, 10);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
