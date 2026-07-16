// Kalshi Prediction Market Scraper
//
// Strategy
// --------
// Read live market data from Kalshi, the CFTC-regulated US event-contract
// exchange, through its keyless public trade API. Three modes:
//   1. eventTickers  -> GET /events/{ticker}?with_nested_markets=true
//   2. seriesTickers -> GET /markets?series_ticker=... (event fetched once
//      per unique event ticker for category/series metadata)
//   3. discovery     -> paginate /events?with_nested_markets=true and filter
//      by category and keywords client side (the API has no text search)
// GOTCHA: the API returns prices as *_dollars STRING fields ("0.0300") and
// sizes as *_fp fixed-point strings; the old integer-cent fields are gone
// and read as undefined. One row per market with yes/no bid/ask, last
// price, implied probability, volume, and open interest.
//
// Pay per event
// -------------
//   market_row ($0.004) charged per market pushed. Not-found tickers and
//   empty searches produce free note rows. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 150;
const MAX_DISCOVERY_PAGES = 8; // x200 events
const UA = 'KalshiPredictionMarketScraper/1.0 (+https://apify.com/scrapemint/kalshi-prediction-market-scraper)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    eventTickers = [],
    seriesTickers = [],
    categories = [],
    keywords = [],
    status = 'open',
    onlyPriced = true,
    minVolume = 0,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const wantedEvents = asList(eventTickers).map((t) => t.toUpperCase());
const wantedSeries = asList(seriesTickers).map((t) => t.toUpperCase());
const wantedCats = asList(categories).map((c) => c.toLowerCase());
const kws = asList(keywords).map((k) => k.toLowerCase());
const marketStatus = ['open', 'closed', 'settled'].includes(String(status).toLowerCase())
    ? String(status).toLowerCase() : 'open';
const minVol = Math.max(0, Number(minVolume) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rateLimited = false;

async function getJson(url, retried = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 404) return { notFound: true };
        if (res.status === 429) {
            if (!retried) {
                log.warning('Kalshi rate limit hit; backing off 10s...');
                await sleep(10000);
                return getJson(url, true);
            }
            rateLimited = true;
            return null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

function toRow(m, event) {
    const last = num(m.last_price_dollars);
    const yesBid = num(m.yes_bid_dollars);
    const yesAsk = num(m.yes_ask_dollars);
    // Best probability estimate: mid of the book, else last trade.
    const mid = yesBid != null && yesAsk != null && yesAsk > 0 ? (yesBid + yesAsk) / 2 : null;
    const prob = mid ?? last;
    return {
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        seriesTicker: clean(event?.series_ticker),
        category: clean(event?.category),
        eventTitle: clean(event?.title) || clean(m.title),
        outcome: clean(m.yes_sub_title) || clean(m.subtitle),
        yesBid,
        yesAsk,
        noBid: num(m.no_bid_dollars),
        noAsk: num(m.no_ask_dollars),
        lastPrice: last,
        impliedProbabilityPct: prob != null ? Math.round(prob * 10000) / 100 : null,
        volume: num(m.volume_fp),
        volume24h: num(m.volume_24h_fp),
        openInterest: num(m.open_interest_fp),
        liquidityDollars: num(m.liquidity_dollars),
        status: clean(m.status),
        result: clean(m.result),
        openTime: clean(m.open_time),
        closeTime: clean(m.close_time),
        rules: clean(m.rules_primary),
        url: event?.series_ticker ? `https://kalshi.com/markets/${String(event.series_ticker).toLowerCase()}` : null,
    };
}

function marketOk(m) {
    if (onlyPriced) {
        const priced = num(m.yes_bid_dollars) > 0 || num(m.last_price_dollars) > 0;
        if (!priced) return false;
    }
    if (minVol > 0 && (num(m.volume_fp) ?? 0) < minVol) return false;
    if (kws.length) {
        const hay = `${m.title || ''} ${m.yes_sub_title || ''} ${m.subtitle || ''}`.toLowerCase();
        if (!kws.some((k) => hay.includes(k))) return false;
    }
    return true;
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'market_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const mode = wantedEvents.length ? 'events' : wantedSeries.length ? 'series' : 'discovery';
log.info(`Kalshi ${mode} mode, status=${marketStatus}${wantedCats.length ? `, categories ~ ${wantedCats.join(', ')}` : ''}${kws.length ? `, keywords ${kws.join(', ')}` : ''}${onlyPriced ? ', priced only' : ''}${minVol ? `, min volume ${minVol}` : ''}. Cap ${cap} rows.`);

const eventCache = new Map();
async function getEvent(ticker) {
    if (eventCache.has(ticker)) return eventCache.get(ticker);
    await sleep(REQUEST_GAP_MS);
    const d = await getJson(`${API}/events/${ticker}`);
    const ev = d?.event || null;
    eventCache.set(ticker, ev);
    return ev;
}

async function emitMarkets(markets, event) {
    let n = 0;
    for (const m of markets) {
        if (rowsPushed >= cap) return n;
        if (!marketOk(m)) continue;
        const ev = event || await getEvent(m.event_ticker);
        // Keyword filter also gets the event title in ticker/series modes.
        if (kws.length && ev?.title) {
            const hay = `${ev.title} ${m.title || ''} ${m.yes_sub_title || ''}`.toLowerCase();
            if (!kws.some((k) => hay.includes(k))) continue;
        }
        await flushRow({ ...toRow(m, ev), scrapedAt: new Date().toISOString() });
        n += 1;
    }
    return n;
}

if (mode === 'events') {
    for (const ticker of wantedEvents) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        if (rateLimited || rowsPushed >= cap) break;
        await sleep(REQUEST_GAP_MS);
        const d = await getJson(`${API}/events/${ticker}?with_nested_markets=true`);
        if (!d || d.notFound || !d.event) {
            await flushRow({ eventTicker: ticker, note: 'Event ticker not found on Kalshi.' }, false);
            continue;
        }
        const n = await emitMarkets(d.event.markets || [], d.event);
        log.info(`${ticker}: ${n} market row(s).`);
    }
} else if (mode === 'series') {
    for (const ticker of wantedSeries) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        if (rateLimited || rowsPushed >= cap) break;
        let cursor = '';
        let n = 0;
        for (let page = 0; page < 10; page++) {
            await sleep(REQUEST_GAP_MS);
            const p = new URLSearchParams({ series_ticker: ticker, status: marketStatus, limit: '200' });
            if (cursor) p.set('cursor', cursor);
            const d = await getJson(`${API}/markets?${p.toString()}`);
            if (!d?.markets?.length) break;
            n += await emitMarkets(d.markets, null);
            cursor = d.cursor || '';
            if (!cursor || rowsPushed >= cap) break;
        }
        if (n === 0) await flushRow({ seriesTicker: ticker, note: 'No matching markets for this series ticker.' }, false);
        log.info(`${ticker}: ${n} market row(s).`);
    }
} else {
    let cursor = '';
    let emitted = 0;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        if (rateLimited || rowsPushed >= cap) break;
        await sleep(REQUEST_GAP_MS);
        const p = new URLSearchParams({ status: marketStatus, with_nested_markets: 'true', limit: '200' });
        if (cursor) p.set('cursor', cursor);
        const d = await getJson(`${API}/events?${p.toString()}`);
        if (!d?.events?.length) break;
        for (const ev of d.events) {
            if (rowsPushed >= cap) break;
            if (wantedCats.length && !wantedCats.some((c) => String(ev.category || '').toLowerCase().includes(c))) continue;
            if (kws.length) {
                const hay = `${ev.title || ''} ${(ev.markets || []).map((m) => `${m.yes_sub_title || ''} ${m.subtitle || ''}`).join(' ')}`.toLowerCase();
                if (!kws.some((k) => hay.includes(k))) continue;
            }
            emitted += await emitMarkets(ev.markets || [], ev);
        }
        cursor = d.cursor || '';
        if (!cursor) break;
    }
    if (emitted === 0) {
        await flushRow({ note: `No markets matched${wantedCats.length ? ` categories ${wantedCats.join(', ')}` : ''}${kws.length ? ` keywords ${kws.join(', ')}` : ''}. Try broader filters or a specific eventTicker.` }, false);
    }
}

if (rateLimited) log.warning('Stopped early on a persistent Kalshi rate limit; results are partial.');
log.info(`Done. ${rowsPushed} market row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
