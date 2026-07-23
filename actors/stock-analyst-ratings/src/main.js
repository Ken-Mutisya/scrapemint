// Stock Analyst Ratings: Price Targets, Upgrades & Downgrades
//
// Strategy
// --------
// One keyless source: the official NASDAQ analyst endpoints. For each ticker the
// buyer supplies we pull three light JSON calls:
//   - /api/quote/{S}/info        current price + company name
//   - /api/analyst/{S}/targetprice   consensus: mean/high/low price target,
//                                    and the buy / hold / sell analyst split
//   - /api/analyst/{S}/ratings       the consensus rating (Buy/Hold/Sell), the
//                                    analyst count, and recent upgrade/downgrade
//                                    events with the brokerage firm
// From the price + mean target we compute the upside percent analysts imply —
// the number traders act on. Endpoints 403 without a browser-like User-Agent.
//
// Pay per event
// -------------
//   rating_row ($0.005) charged per ticker row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    includeHistory = false,
    minUpside = 0,
    onlyWithRatingChange = false,
    maxRows = 500,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[$,%\s]/g, '');
    if (s === '' || /^(N\/A|--|UNCH)$/i.test(String(v).trim())) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

const tickers = [...new Set(asList(symbols).map((s) => s.toUpperCase()))].slice(0, HARD_CAP);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

if (!tickers.length) {
    log.warning('Provide at least one ticker, e.g. AAPL, NVDA, TSLA.');
    await Actor.exit();
}

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 2500)); return await getJson(url); }
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'rating_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

async function buildRow(symbol) {
    const [quote, target, ratings] = await Promise.all([
        getJson(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`),
        getJson(`https://api.nasdaq.com/api/analyst/${symbol}/targetprice`),
        getJson(`https://api.nasdaq.com/api/analyst/${symbol}/ratings`),
    ]);

    const co = target?.data?.consensusOverview || {};
    const rd = ratings?.data || {};
    const priceTargetMean = num(co.priceTarget);
    const consensusRating = clean(rd.meanRatingType);

    // Skip tickers with no analyst coverage at all (don't charge for empty).
    if (priceTargetMean == null && !consensusRating) {
        log.info(`${symbol}: no analyst coverage; skipped.`);
        return null;
    }

    const currentPrice = num(quote?.data?.primaryData?.lastSalePrice);
    const companyName = clean(quote?.data?.companyName);
    const summary = clean(rd.ratingsSummary) || '';
    const analystCount = num((summary.match(/(\d+)\s+analyst/i) || [])[1]);

    const changes = (Array.isArray(rd.upgradesDowngrades) ? rd.upgradesDowngrades : []).map((u) => ({
        firm: clean(u.brokerageFirm),
        from: clean(u.changedFrom),
        to: clean(u.changedTo),
        date: clean(u.date),
    })).filter((c) => c.firm || c.to);

    const upsidePercent = (priceTargetMean != null && currentPrice)
        ? Math.round(((priceTargetMean - currentPrice) / currentPrice) * 1000) / 10
        : null;

    const row = {
        symbol,
        companyName,
        currentPrice,
        consensusRating,
        analystCount,
        priceTargetMean,
        priceTargetHigh: num(co.highPriceTarget),
        priceTargetLow: num(co.lowPriceTarget),
        upsidePercent,
        buyCount: num(co.buy),
        holdCount: num(co.hold),
        sellCount: num(co.sell),
        recentRatingChanges: changes,
        scrapedAt: new Date().toISOString(),
    };
    if (includeHistory) {
        row.consensusHistory = (target?.data?.historicalConsensus || []).map((h) => ({
            date: clean(h?.z?.date),
            consensus: clean(h?.z?.consensus),
            buy: num(h?.z?.buy),
            hold: num(h?.z?.hold),
            sell: num(h?.z?.sell),
            price: num(h?.y),
        }));
    }
    return row;
}

log.info(`Fetching analyst ratings for ${tickers.length} ticker(s). Cap ${cap} rows.`);

let emitted = 0;
const queue = tickers.slice();
let stop = false;

async function worker() {
    while (queue.length && !stop) {
        if (deadlineMs && Date.now() > deadlineMs) { stop = true; log.warning('Approaching run timeout; stopping early.'); break; }
        if (emitted >= cap) { stop = true; break; }
        const symbol = queue.shift();
        let row;
        try { row = await buildRow(symbol); }
        catch (err) { log.warning(`${symbol}: ${err?.message}`); continue; }
        if (!row) continue;
        if (onlyWithRatingChange && (!row.recentRatingChanges || row.recentRatingChanges.length === 0)) continue;
        if (minUpside && (row.upsidePercent == null || row.upsidePercent < minUpside)) continue;
        if (emitted >= cap || stop) break;
        await flushRow(row);
        emitted += 1;
    }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));

log.info(`Done. ${emitted} ticker row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
