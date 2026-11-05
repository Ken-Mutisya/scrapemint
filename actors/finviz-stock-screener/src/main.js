// Finviz Stock Screener Scraper
//
// Strategy
// --------
// finviz.com/screener/stocks (and /screener/etf) server-renders the result
// table as a JSON island (<script data-ssr-props="ssr-island-1">) holding the
// rows for one 20-row page plus totalCount. The custom view (v=152) with every
// column id requested returns ~115 fields per ticker on the free tier:
// valuation, growth, margins, ownership, short interest, performance,
// technicals, analyst target, earnings date and latest headline. We accept
// any Finviz screener URL (old screener.ashx or new path), or build one from
// filter codes, a signal and a sort, then page through r=1,21,41,... No
// login, no API key, no browser, no proxy.
//
// Pay per event
// -------------
//   stock_row ($0.003) per ticker row pushed. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 900;
const ALL_COLUMNS = Array.from({ length: 160 }, (_, i) => i).join(',');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    screenerUrl = '',
    screenerType = 'stocks',
    filters = [],
    signal = '',
    tickers = [],
    sortBy = '',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// Build the query: a pasted URL wins for f/s/o/t; explicit inputs add to it.
let type = screenerType === 'etf' ? 'etf' : 'stocks';
const params = new URLSearchParams();
if (String(screenerUrl).trim()) {
    let u;
    try { u = new URL(String(screenerUrl).trim(), 'https://finviz.com'); } catch { u = null; }
    if (!u || !/finviz\.com$/i.test(u.hostname)) {
        await Actor.pushData({ note: '"screenerUrl" must be a finviz.com screener URL. Not charged.' });
        await Actor.exit();
    }
    if (/\/screener\/etf/i.test(u.pathname)) type = 'etf';
    for (const k of ['f', 's', 'o', 't', 'ft']) {
        const v = u.searchParams.get(k);
        if (v) params.set(k, v);
    }
}
const filterCodes = asList(filters).map((f) => f.toLowerCase());
if (filterCodes.length) {
    const prev = params.get('f');
    params.set('f', [...new Set([...(prev ? prev.split(',') : []), ...filterCodes])].join(','));
}
if (String(signal).trim()) params.set('s', String(signal).trim().toLowerCase());
const tickerList = asList(tickers).map((t) => t.toUpperCase().replace(/[^A-Z0-9.\-]/g, '')).filter(Boolean);
if (tickerList.length) params.set('t', tickerList.join(','));
if (String(sortBy).trim()) params.set('o', String(sortBy).trim());
params.set('v', '152');
params.set('c', ALL_COLUMNS);

async function fetchPage(firstRow) {
    const q = new URLSearchParams(params);
    if (firstRow > 1) q.set('r', String(firstRow));
    const url = `https://finviz.com/screener/${type}?${q}`;
    for (let attempt = 1; attempt <= 4; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
            });
            if (res.status === 429 || res.status >= 500) {
                log.warning(`Finviz HTTP ${res.status} on rows ${firstRow}+; retrying.`);
                await sleep(3000 * attempt);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const html = await res.text();
            const m = html.match(/<script type="application\/json" data-ssr-props="ssr-island-1">([\s\S]*?)<\/script>/);
            if (!m) throw new Error('screener data not found in page');
            return JSON.parse(m[1]);
        } catch (err) {
            if (attempt === 4) throw err;
            log.warning(`Rows ${firstRow}+: ${err?.message}; retrying.`);
            await sleep(2000 * attempt);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

// Finviz reports market cap, sales, income and EV in millions; pass through
// as-is with the unit in the field name so nobody misreads them.
const MILLIONS = new Set(['marketCap', 'sales', 'income', 'enterpriseValue', 'sharesOutstanding2', 'sharesFloat', 'shortInterest']);
const RENAME = {
    sharesOutstanding2: 'sharesOutstanding', PE: 'peRatio', forwardPE: 'forwardPe', PEG: 'pegRatio',
    PS: 'priceToSales', PB: 'priceToBook', PC: 'priceToCash', PFCF: 'priceToFreeCashFlow',
    recom: 'analystRecommendation', floatoutstandingpct: 'floatPercentOfOutstanding', changeopen: 'changeFromOpen',
};
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v ?? null);

function toRow(r, rank) {
    const t = r.text || {};
    const n = r.numbers || {};
    const row = {
        rank,
        ticker: t.ticker || null,
        company: t.company || null,
        sector: t.sector || null,
        industry: t.industry || null,
        country: t.country || null,
        exchange: t.exchange || null,
        index: t.index || null,
        securityType: t.securityType || null,
        website: t.www || null,
        optionable: t.optionable ? t.optionable === 'Yes' : null,
        shortable: t.shortable ? t.shortable === 'Yes' : null,
        earningsDate: t.earningsDate || null,
        ipoDate: t.ipoDate || null,
        dividendExDate: t.dividendExDate || null,
        latestNewsTitle: t.newsTitle || null,
        latestNewsUrl: t.newsUrl ? new URL(t.newsUrl, 'https://finviz.com').href : null,
        latestNewsTime: t.newsTime || null,
        whyItMoves: t.wiimDailyDigest || null,
    };
    for (const [k, v] of Object.entries(n)) {
        if (k === 'order') continue;
        const key = RENAME[k] || k;
        row[MILLIONS.has(k) ? `${key}Millions` : key] = round(v);
    }
    // Pass through any text fields we don't map explicitly (Finviz adds columns over time).
    for (const [k, v] of Object.entries(t)) {
        if (!(k in row) && !['www', 'newsUrl', 'newsTitle', 'newsTime', 'wiimDailyDigest', 'type', 'cardIndustry'].includes(k)) row[k] = v;
    }
    row.finvizUrl = t.ticker ? `https://finviz.com/quote.ashx?t=${encodeURIComponent(t.ticker)}` : null;
    row.scrapedAt = new Date().toISOString();
    return row;
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'stock_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const queryShown = new URLSearchParams(params);
queryShown.delete('c');
log.info(`Screening finviz.com/screener/${type}?${queryShown} (up to ${cap} rows).`);

let totalCount = null;
let firstRow = 1;
let pages = 0;
let error = null;
while (rowsPushed < cap) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    let d;
    try {
        d = await fetchPage(firstRow);
    } catch (err) {
        error = err?.message || String(err);
        log.error(`Finviz request failed: ${error}`);
        break;
    }
    pages += 1;
    const rows = d?.data?.rows || [];
    totalCount = d?.data?.totalCount ?? totalCount;
    if (pages === 1) log.info(`Finviz matched ${totalCount} ticker(s).`);
    for (const r of rows) {
        if (rowsPushed >= cap) break;
        await flushRow(toRow(r, firstRow + rows.indexOf(r)));
    }
    if (rows.length < PAGE_SIZE || totalCount == null || firstRow + PAGE_SIZE > totalCount) break;
    firstRow += PAGE_SIZE;
    await sleep(PAGE_DELAY_MS);
}

if (!rowsPushed) {
    await Actor.pushData({ note: error ? `Finviz could not be reached (${error}). Not charged.` : 'No tickers matched this screen. Not charged.' });
}
await Actor.setValue('SUMMARY', {
    screener: `https://finviz.com/screener/${type}?${queryShown}`,
    totalMatched: totalCount,
    rows: rowsPushed,
    pages,
    error,
});
log.info(`Done. ${rowsPushed} row(s) of ${totalCount ?? '?'} matched; ${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
