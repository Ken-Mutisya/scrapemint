// Yahoo Finance Scraper: quotes with full fundamentals, valuation, analyst
// targets and ratings, earnings dates and company profile for any stock,
// ETF, index, crypto or currency on Yahoo Finance, plus Yahoo's market
// lists (gainers, losers, most active, trending, 52-week movers, top ETFs,
// crypto) and its research screeners.
//
// Strategy
// --------
// Yahoo's JSON API (query1/query2.finance.yahoo.com) answers 429 to
// datacenter IPs, crumb or not. The finance.yahoo.com pages themselves load,
// and they are server-rendered with the same API responses embedded as
// <script type="application/json" data-sveltekit-fetched data-url="...">
// blocks. So:
// - quote page /quote/{SYMBOL}/ -> quoteSummary (price, summaryDetail,
//   defaultKeyStatistics, financialData, summaryProfile, calendarEvents,
//   earnings, recommendationTrend, upgradeDowngradeHistoryLatest,
//   equityPerformance) and the v7 quote.
// - list pages /markets/stocks/gainers/?start=0&count=100 etc. and
//   /research-hub/screener/{id}/ -> the predefined screener, top 100 rows
//   (server rendering ignores start past the first page).
// Tested from Apify with no proxy on 2026-10-17.
//
// Pay per event
// -------------
//   quote_row ($0.004) one symbol with fundamentals, analysts and profile
//   list_row  ($0.001) one row of a market list or screener
// No start fee. A run that finds nothing is free; unknown symbols are free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const BASE = 'https://finance.yahoo.com';
const LISTS = {
    gainers: '/markets/stocks/gainers/',
    losers: '/markets/stocks/losers/',
    most_active: '/markets/stocks/most-active/',
    trending: '/markets/stocks/trending/',
    '52_week_gainers': '/markets/stocks/52-week-gainers/',
    '52_week_losers': '/markets/stocks/52-week-losers/',
    top_etfs: '/markets/etfs/top/',
    crypto: '/markets/crypto/all/',
    crypto_gainers: '/markets/crypto/gainers/',
    crypto_losers: '/markets/crypto/losers/',
    crypto_most_active: '/markets/crypto/most-active/',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    lists = [],
    screeners = [],
    listDetails = false,
    maxListRows = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v.raw ?? null) : (v ?? null));
const r4 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const iso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const listCap = Math.min(100, Math.max(1, Number(maxListRows) || 100));

// "aapl", "https://finance.yahoo.com/quote/AAPL/" -> "AAPL"
function symbolOf(s) {
    const m = String(s).match(/\/quote\/([^/?#]+)/);
    return decodeURIComponent(m ? m[1] : s).trim().toUpperCase();
}

const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function page(path) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(BASE + path, {
                headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
                signal: AbortSignal.timeout(45_000),
            });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(4000 * (attempt + 1)); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const html = await r.text();
            // Every embedded API response on the page, keyed by its URL.
            const out = [];
            for (const m of html.matchAll(/<script type="application\/json" data-sveltekit-fetched data-url="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g)) {
                try {
                    const wrap = JSON.parse(m[2]);
                    out.push({ url: decodeEntities(m[1]), body: JSON.parse(wrap.body) });
                } catch { /* not JSON */ }
            }
            if (!out.length) { last = new Error('page had no embedded data'); await sleep(3000 * (attempt + 1)); continue; }
            return out;
        } catch (err) {
            last = err;
            await sleep(2500 * (attempt + 1));
        }
    }
    throw last;
}

// ---- quotes ----
async function quote(sym) {
    const blocks = await page(`/quote/${encodeURIComponent(sym)}/`);
    if (!blocks) return null;
    const qs = blocks.find((b) => b.url.includes(`/quoteSummary/${encodeURIComponent(sym)}`) || b.url.includes(`/quoteSummary/${sym}`))?.body?.quoteSummary?.result?.[0];
    const q = blocks.find((b) => b.url.includes('/v7/finance/quote?') && (b.body?.quoteResponse?.result || []).some((x) => x.symbol === sym))
        ?.body.quoteResponse.result.find((x) => x.symbol === sym);
    if (!qs && !q) return null;
    const pr = qs?.price || {};
    const sd = qs?.summaryDetail || {};
    const ks = qs?.defaultKeyStatistics || {};
    const fd = qs?.financialData || {};
    const sp = qs?.summaryProfile || qs?.assetProfile || {};
    const ce = qs?.calendarEvents || {};
    const perf = qs?.equityPerformance?.performanceOverview || qs?.quoteUnadjustedPerformanceOverview?.performanceOverview || {};
    const fp = qs?.fundProfile || null;
    const trend = (qs?.recommendationTrend?.trend || []).find((t) => t.period === '0m');
    const price = raw(pr.regularMarketPrice) ?? raw(q?.regularMarketPrice);
    const target = raw(fd.targetMeanPrice);
    const eq = (qs?.earnings?.earningsChart?.quarterly || []).map((e) => ({ quarter: e.date, actualEps: raw(e.actual), estimateEps: raw(e.estimate) }));
    return {
        type: 'quote',
        symbol: sym,
        name: pr.longName || pr.shortName || q?.longName || q?.shortName || null,
        quoteType: pr.quoteType || q?.quoteType || null,
        exchange: pr.exchangeName || q?.fullExchangeName || null,
        currency: pr.currency || q?.currency || null,
        marketState: pr.marketState || q?.marketState || null,
        price,
        change: raw(pr.regularMarketChange) ?? raw(q?.regularMarketChange),
        changePercent: r4((raw(pr.regularMarketChangePercent) ?? null) != null ? raw(pr.regularMarketChangePercent) * 100 : raw(q?.regularMarketChangePercent)),
        previousClose: raw(sd.previousClose) ?? raw(pr.regularMarketPreviousClose),
        open: raw(sd.open) ?? raw(pr.regularMarketOpen),
        dayLow: raw(sd.dayLow) ?? raw(pr.regularMarketDayLow),
        dayHigh: raw(sd.dayHigh) ?? raw(pr.regularMarketDayHigh),
        volume: raw(sd.volume) ?? raw(pr.regularMarketVolume),
        averageVolume3m: raw(sd.averageVolume) ?? raw(pr.averageDailyVolume3Month),
        preMarketPrice: raw(pr.preMarketPrice),
        postMarketPrice: raw(pr.postMarketPrice),
        marketTime: iso(pr.regularMarketTime),
        marketCap: raw(pr.marketCap) ?? raw(sd.marketCap),
        fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
        fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
        fiftyDayAverage: raw(sd.fiftyDayAverage),
        twoHundredDayAverage: raw(sd.twoHundredDayAverage),
        beta: raw(sd.beta) ?? raw(ks.beta),
        trailingPE: raw(sd.trailingPE),
        forwardPE: raw(sd.forwardPE) ?? raw(ks.forwardPE),
        pegRatio: raw(ks.pegRatio) ?? raw(ks.trailingPegRatio),
        priceToBook: raw(ks.priceToBook),
        priceToSales: raw(sd.priceToSalesTrailing12Months),
        enterpriseValue: raw(ks.enterpriseValue),
        evToRevenue: raw(ks.enterpriseToRevenue),
        evToEbitda: raw(ks.enterpriseToEbitda),
        trailingEps: raw(ks.trailingEps),
        forwardEps: raw(ks.forwardEps),
        dividendRate: raw(sd.dividendRate),
        dividendYield: raw(sd.dividendYield),
        payoutRatio: raw(sd.payoutRatio),
        exDividendDate: iso(raw(sd.exDividendDate) ?? raw(ce.exDividendDate)),
        sharesOutstanding: raw(ks.sharesOutstanding),
        floatShares: raw(ks.floatShares),
        shortPercentOfFloat: raw(ks.shortPercentOfFloat),
        shortRatio: raw(ks.shortRatio),
        heldPercentInsiders: raw(ks.heldPercentInsiders),
        heldPercentInstitutions: raw(ks.heldPercentInstitutions),
        revenue: raw(fd.totalRevenue),
        revenueGrowth: raw(fd.revenueGrowth),
        earningsGrowth: raw(fd.earningsGrowth),
        grossMargins: raw(fd.grossMargins),
        operatingMargins: raw(fd.operatingMargins),
        profitMargins: raw(fd.profitMargins) ?? raw(ks.profitMargins),
        ebitda: raw(fd.ebitda),
        totalCash: raw(fd.totalCash),
        totalDebt: raw(fd.totalDebt),
        debtToEquity: raw(fd.debtToEquity),
        currentRatio: raw(fd.currentRatio),
        returnOnEquity: raw(fd.returnOnEquity),
        returnOnAssets: raw(fd.returnOnAssets),
        freeCashflow: raw(fd.freeCashflow),
        operatingCashflow: raw(fd.operatingCashflow),
        recommendation: fd.recommendationKey && fd.recommendationKey !== 'none' ? fd.recommendationKey : null,
        recommendationMean: raw(fd.recommendationMean),
        analystCount: raw(fd.numberOfAnalystOpinions),
        targetMeanPrice: target,
        targetMedianPrice: raw(fd.targetMedianPrice),
        targetHighPrice: raw(fd.targetHighPrice),
        targetLowPrice: raw(fd.targetLowPrice),
        targetUpside: target != null && price ? r4(target / price - 1) : null,
        analystRatings: trend ? { strongBuy: trend.strongBuy, buy: trend.buy, hold: trend.hold, sell: trend.sell, strongSell: trend.strongSell } : null,
        latestRatingChanges: (qs?.upgradeDowngradeHistoryLatest?.history || []).slice(0, 10).map((h) => ({
            date: iso(h.epochGradeDate), firm: h.firm || null, action: h.action || null, fromGrade: h.fromGrade || null, toGrade: h.toGrade || null,
            priceTarget: raw(h.currentPriceTarget) || null,
        })),
        nextEarningsDate: iso(raw((ce.earnings?.earningsDate || [])[0])),
        earningsEstimateAvg: raw(ce.earnings?.earningsAverage),
        revenueEstimateAvg: raw(ce.earnings?.revenueAverage),
        recentQuarters: eq.length ? eq : null,
        returnYtd: raw(perf.ytdReturnPct),
        return1y: raw(perf.oneYearTotalReturn),
        return3y: raw(perf.threeYearTotalReturn),
        return5y: raw(perf.fiveYearTotalReturn),
        fundFamily: fp?.family || null,
        fundCategory: fp?.categoryName || ks.category || null,
        expenseRatio: raw(fp?.feesExpensesInvestment?.annualReportExpenseRatio) ?? raw(ks.annualReportExpenseRatio),
        totalAssets: raw(ks.totalAssets) ?? raw(sd.totalAssets),
        fundYield: raw(sd.yield),
        topHoldings: qs?.topHoldings?.holdings?.length
            ? qs.topHoldings.holdings.map((h) => ({ symbol: h.symbol || null, name: h.holdingName || null, weight: raw(h.holdingPercent) }))
            : null,
        sector: sp.sector || null,
        industry: sp.industry || null,
        employees: sp.fullTimeEmployees ?? null,
        website: sp.website || null,
        country: sp.country || null,
        city: sp.city || null,
        description: sp.longBusinessSummary || null,
        url: `${BASE}/quote/${encodeURIComponent(sym)}/`,
        scrapedAt: new Date().toISOString(),
    };
}

// ---- lists and screeners ----
const rowsIn = (b) => (b.body?.finance?.result?.[0]?.records || b.body?.finance?.result?.[0]?.quotes || []).length;
// Server-rendered list pages honour count (25/50/100) but not start past the
// first page, so each list or screener is its top 100.
async function listRows(name, path) {
    const blocks = await page(`${path}?start=0&count=100`);
    if (!blocks) throw new Error(`Yahoo has no list at ${path}`);
    // The page also carries a 5-row "most active" sidebar screener, so take
    // the screener block with the most rows.
    const scr = blocks.filter((b) => b.url.includes('/screener/')).sort((a, b) => rowsIn(b) - rowsIn(a))[0];
    const trend = name === 'trending' ? blocks.filter((b) => b.url.includes('/finance/trending/')).pop() : null;
    const res = (trend || scr)?.body?.finance?.result?.[0];
    const rows = (res?.records || res?.quotes || []).slice(0, listCap);
    return rows.map((x, i) => toListRow(name, res, x, i + 1));
}

function toListRow(name, res, x, rank) {
    const sym = x.ticker || x.symbol;
    return {
        type: 'list',
        list: name,
        listTitle: res?.title || null,
        rank,
        symbol: sym,
        name: x.companyName || x.longName || x.shortName || null,
        price: raw(x.regularMarketPrice) ?? raw(x.fulldayPrice),
        change: raw(x.regularMarketChange),
        changePercent: r4(raw(x.regularMarketChangePercent)),
        volume: raw(x.regularMarketVolume),
        averageVolume3m: raw(x.avgDailyVol3m) ?? raw(x.averageDailyVolume3Month),
        marketCap: raw(x.marketCap),
        peRatio: raw(x.peRatioLtm) ?? raw(x.trailingPE),
        fiftyTwoWeekLow: raw(x.fiftyTwoWeekLow),
        fiftyTwoWeekHigh: raw(x.fiftyTwoWeekHigh),
        fiftyTwoWeekChangePercent: r4(raw(x.fiftyTwoWeekChangePercent)),
        sector: x.sector || null,
        industry: x.industry || null,
        exchange: x.exchange || x.fullExchangeName || null,
        analystRating: x.averageRating || null,
        currency: x.currency || null,
        circulatingSupply: raw(x.circulatingSupply),
        url: sym ? `${BASE}/quote/${encodeURIComponent(sym)}/` : null,
        scrapedAt: new Date().toISOString(),
    };
}

// ---- run ----
let rowsOut = 0;
let keepGoing = true;
const failures = [];
const perSource = [];

async function charge(eventName) {
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function emitQuote(sym) {
    try {
        const row = await quote(sym);
        if (!row) {
            await Actor.pushData({ type: 'error', symbol: sym, error: `Yahoo Finance has no symbol "${sym}". Not charged.` });
            return;
        }
        await Actor.pushData(row);
        rowsOut += 1;
        if (!(await charge('quote_row'))) keepGoing = false;
    } catch (err) {
        failures.push({ source: sym, error: String(err.message) });
        await Actor.pushData({ type: 'error', symbol: sym, error: `${err.message}. Not charged.` });
    }
}

const syms = [...new Set(list(symbols).map(symbolOf))];
const listNames = list(lists).map((l) => l.toLowerCase().replace(/[\s-]+/g, '_'));
const screenerIds = list(screeners).map((s) => s.replace(/^.*\/screener\//, '').replace(/\/.*$/, '').trim()).filter(Boolean);
if (!syms.length && !listNames.length && !screenerIds.length) {
    await Actor.pushData({ type: 'error', error: 'Add symbols, market lists or screeners. Not charged.' });
}

// Quotes three at a time: each is one ~1 MB page.
for (let i = 0; i < syms.length && keepGoing; i += 3) {
    await Promise.all(syms.slice(i, i + 3).map((s) => emitQuote(s)));
}
if (syms.length) perSource.push({ source: 'quotes', rows: rowsOut });

const sources = [
    ...listNames.map((n) => ({ name: n, path: LISTS[n] })),
    ...screenerIds.map((id) => ({ name: id, path: `/research-hub/screener/${encodeURIComponent(id)}/` })),
];
for (const s of sources) {
    if (!keepGoing) break;
    if (!s.path) {
        await Actor.pushData({ type: 'error', list: s.name, error: `Unknown list "${s.name}". Use one of: ${Object.keys(LISTS).join(', ')}, or a screener id. Not charged.` });
        continue;
    }
    let n = 0;
    try {
        for (const r of await listRows(s.name, s.path)) {
            if (!keepGoing) break;
            if (listDetails && r.symbol) {
                await emitQuote(r.symbol);
            } else {
                await Actor.pushData(r);
                rowsOut += 1;
                if (!(await charge('list_row'))) keepGoing = false;
            }
            n += 1;
        }
    } catch (err) {
        log.warning(`${s.name}: ${err.message}`);
        failures.push({ source: s.name, error: String(err.message) });
    }
    log.info(`${s.name}: ${n} row(s).`);
    perSource.push({ source: s.name, rows: n });
}

if (!rowsOut && (syms.length || sources.length)) await Actor.pushData({ type: 'note', note: 'Nothing found. Not charged.' });
await Actor.setValue('SUMMARY', { rows: rowsOut, sources: perSource, failures });
log.info(`Done. ${rowsOut} row(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
