// TradingView Stock Screener Scraper (No Login)
//
// Strategy
// --------
// TradingView powers its public screener with a keyless JSON endpoint:
//   POST https://scanner.tradingview.com/<market>/scan
// Body: { filter:[{left,operation,right}], columns:[...], sort:{...}, range:[start,end] }
// Response: { totalCount, data:[{ s:"EXCH:SYM", d:[<values aligned to columns>] }] }
//
// One HTTP POST returns hundreds of matching symbols with live price, %
// change, volume, market cap, P/E, dividend yield, RSI, sector, industry,
// exchange, country, and YTD performance. No browser, no login, no API key.
//
// We accept friendly filters (marketCapMin, priceMax, sectors, peRatioMax,
// dividendYieldMin, rsiMin/Max, changeMin, volumeMin) plus a raw `filters`
// passthrough for power users, build the scanner request, page through the
// result set in chunks, and emit one tidy row per symbol.
//
// Pay per event
// -------------
//   screener_row ($0.004) charged when a screener row is pushed.
//   First 1 row per run is free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const PAGE_SIZE = 100;
const HARD_CAP = 5000;

// Output field name <- TradingView column id (order defines the `d` array).
const COLUMN_MAP = [
    ['symbol', 'name'],
    ['name', 'description'],
    ['price', 'close'],
    ['changePercent', 'change'],
    ['changeAbs', 'change_abs'],
    ['volume', 'volume'],
    ['marketCap', 'market_cap_basic'],
    ['peRatio', 'price_earnings_ttm'],
    ['dividendYield', 'dividend_yield_recent'],
    ['rsi', 'RSI'],
    ['sector', 'sector'],
    ['industry', 'industry'],
    ['exchange', 'exchange'],
    ['country', 'country'],
    ['perfYTD', 'Perf.YTD'],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    market = 'america',
    marketCapMin,
    marketCapMax,
    priceMin,
    priceMax,
    volumeMin,
    sectors = [],
    peRatioMin,
    peRatioMax,
    dividendYieldMin,
    rsiMin,
    rsiMax,
    changeMin,
    filters: rawFilters = [],
    sortBy = 'market_cap_basic',
    sortOrder = 'desc',
    maxResults = 100,
    proxyConfiguration: proxyInput,
} = input;

const cleanMarket = String(market || 'america').trim().toLowerCase().replace(/[^a-z]/g, '') || 'america';
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 100));

// Build TradingView filter objects from friendly inputs.
const filter = [];
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const pushRange = (left, min, max) => {
    const lo = num(min);
    const hi = num(max);
    if (lo !== null && hi !== null) filter.push({ left, operation: 'in_range', right: [lo, hi] });
    else if (lo !== null) filter.push({ left, operation: 'egreater', right: lo });
    else if (hi !== null) filter.push({ left, operation: 'eless', right: hi });
};
pushRange('market_cap_basic', marketCapMin, marketCapMax);
pushRange('close', priceMin, priceMax);
pushRange('price_earnings_ttm', peRatioMin, peRatioMax);
pushRange('RSI', rsiMin, rsiMax);
if (num(volumeMin) !== null) filter.push({ left: 'volume', operation: 'egreater', right: num(volumeMin) });
if (num(dividendYieldMin) !== null) filter.push({ left: 'dividend_yield_recent', operation: 'egreater', right: num(dividendYieldMin) });
if (num(changeMin) !== null) filter.push({ left: 'change', operation: 'egreater', right: num(changeMin) });
const cleanSectors = (Array.isArray(sectors) ? sectors : [sectors]).map((s) => String(s || '').trim()).filter(Boolean);
if (cleanSectors.length) filter.push({ left: 'sector', operation: 'in_range', right: cleanSectors });
if (Array.isArray(rawFilters)) {
    for (const f of rawFilters) {
        if (f && f.left && f.operation) filter.push(f);
    }
}

const columns = COLUMN_MAP.map(([, tv]) => tv);

// Optional proxy: this is a tolerant public JSON API, so proxy is off by
// default; honor it when the buyer supplies one.
let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
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

const endpoint = `https://scanner.tradingview.com/${cleanMarket}/scan`;

async function scan(start, end) {
    const body = {
        filter,
        columns,
        sort: { sortBy: String(sortBy || 'market_cap_basic'), sortOrder: String(sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc' },
        range: [start, end],
    };
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Origin': 'https://www.tradingview.com',
            'Referer': 'https://www.tradingview.com/',
        },
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`scanner HTTP ${res.status} for ${endpoint}`);
    return res.json();
}

function mapRow(item) {
    const d = item.d || [];
    const row = { tickerId: item.s || null };
    COLUMN_MAP.forEach(([out], i) => { row[out] = d[i] ?? null; });
    if (row.symbol) row.url = `https://www.tradingview.com/symbols/${encodeURIComponent(row.symbol)}/`;
    row.market = cleanMarket;
    row.scrapedAt = new Date().toISOString();
    return row;
}

let totalRowsPushed = 0;
// pushData and charge must be awaited so a fast actor exit cannot drop the
// buffered write/charge (see charge-event audit + forexfactory feed-path bug).
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'screener_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Screening market="${cleanMarket}" with ${filter.length} filter(s), up to ${cap} rows.`);

let fetched = 0;
let totalCount = null;
const seen = new Set();
while (fetched < cap) {
    const start = fetched;
    const end = Math.min(cap, start + PAGE_SIZE);
    let json;
    try {
        json = await scan(start, end);
    } catch (err) {
        log.warning(`Scan page [${start},${end}) failed: ${err?.message}`);
        break;
    }
    if (totalCount === null) {
        totalCount = json.totalCount ?? 0;
        log.info(`Matched ${totalCount} symbol(s) total.`);
    }
    const data = Array.isArray(json.data) ? json.data : [];
    if (data.length === 0) break;
    for (const item of data) {
        if (item.s && seen.has(item.s)) continue;
        if (item.s) seen.add(item.s);
        await flushRow(mapRow(item));
        if (totalRowsPushed >= cap) break;
    }
    fetched += data.length;
    if (totalCount !== null && fetched >= totalCount) break;
    if (data.length < (end - start)) break;
}

log.info(`Done. Pushed ${totalRowsPushed} row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
