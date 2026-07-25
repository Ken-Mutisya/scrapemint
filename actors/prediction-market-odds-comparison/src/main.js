// Prediction Market Odds Comparison: Kalshi vs Polymarket Price Gaps
//
// Strategy
// --------
// The same real-world question is often listed on BOTH Kalshi (the CFTC
// regulated US exchange) and Polymarket (the crypto book), yet the two
// venues frequently price the YES outcome differently. This actor pulls
// live binary (Yes/No) markets from each venue through their keyless public
// APIs, matches the equivalent questions across venues by token overlap,
// and reports the YES-price gap so traders can see the cross-venue spread
// in one place (buy YES on the cheaper side).
//
//   Kalshi:     GET api.elections.kalshi.com/trade-api/v2/events
//                   ?with_nested_markets=true (prices are *_dollars STRINGS)
//   Polymarket: GET gamma-api.polymarket.com/markets
//                   (outcomes / outcomePrices are JSON STRING arrays)
//
// Only binary Yes/No markets are compared, so the YES probability is
// directly comparable. Multi-outcome markets (Who will win?) are skipped.
//
// Pay per event
// -------------
//   pair_row ($0.005) charged per matched cross-venue pair pushed. Runs
//   with no matches emit a free note row. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const KALSHI_API = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_API = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 200;
const POOL_HARD_CAP = 2000;
const UA = 'PredictionMarketOddsComparison/1.0 (+https://apify.com/scrapemint/prediction-market-odds-comparison)';

// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    minSpreadPct = 0,
    minMatchScore = 0.5,
    minKalshiVolume = 0,
    minPolymarketVolume24h = 0,
    maxPairs = 100,
    poolPerVenue = 600,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(searchQueries).map((k) => k.toLowerCase());
const minSpread = Math.max(0, Number(minSpreadPct) || 0);
const minScore = Math.min(1, Math.max(0, Number(minMatchScore) || 0.5));
const minKVol = Math.max(0, Number(minKalshiVolume) || 0);
const minPVol = Math.max(0, Number(minPolymarketVolume24h) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxPairs) || 100));
const pool = Math.max(50, Math.min(POOL_HARD_CAP, Number(poolPerVenue) || 600));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retried = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 429) {
            if (!retried) {
                log.warning('Rate limit hit; backing off 10s...');
                await sleep(10000);
                return getJson(url, true);
            }
            return null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
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
const parseJsonArr = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    try { return JSON.parse(v); } catch { return []; }
};

// ---- Text normalisation for matching -----------------------------------
const STOPWORDS = new Set([
    'will', 'the', 'be', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'at', 'for',
    'is', 'are', 'was', 'were', 'or', 'and', 'market', 'markets', 'who', 'what',
    'when', 'which', 'this', 'that', 'before', 'after', 'next', 'yes', 'no', 'do',
    'does', 'have', 'has', 'it', 'its', 'their', 'his', 'her', 'as', 'with',
]);
// Boost recall across the two venues' phrasing.
const SYNONYMS = {
    btc: 'bitcoin', eth: 'ethereum', sol: 'solana', doge: 'dogecoin',
    xrp: 'ripple', usa: 'us', 'u.s.': 'us', 'u.s': 'us',
    jan: 'january', feb: 'february', mar: 'march', apr: 'april',
    jun: 'june', jul: 'july', aug: 'august', sep: 'september', sept: 'september',
    oct: 'october', nov: 'november', dec: 'december', gop: 'republican',
    dems: 'democrat', democrats: 'democratic', reps: 'republican',
};

function tokenize(text) {
    const raw = String(text || '')
        .toLowerCase()
        .replace(/[$,]/g, '')            // $150,000 -> 150000
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const out = new Set();
    for (let t of raw) {
        if (SYNONYMS[t]) t = SYNONYMS[t];
        if (STOPWORDS.has(t)) continue;
        if (t.length < 2 && !/\d/.test(t)) continue;
        out.add(t);
    }
    return out;
}
const isStrong = (t) => /\d/.test(t) || t.length >= 4;
// Jaccard must clear this floor for a pair to count. Overlap coefficient
// alone lets near-duplicate-but-different questions through (e.g. two
// "next PM of X" markets naming different candidates share everything but
// the name); the Jaccard floor rejects those while keeping true matches.
const JACCARD_FLOOR = 0.5;
// Reported score is the overlap coefficient (intersection / smaller set):
// it handles a short Kalshi title vs a long Polymarket question well. The
// return is gated on a shared strong token AND the Jaccard floor.
function scorePair(a, b) {
    if (!a.tokens.size || !b.tokens.size) return 0;
    let inter = 0;
    let sharedStrong = false;
    const [small, big] = a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
    for (const t of small) {
        if (big.has(t)) { inter += 1; if (isStrong(t)) sharedStrong = true; }
    }
    if (!sharedStrong || inter === 0) return 0; // never pair on stopword-like tokens alone
    const union = a.tokens.size + b.tokens.size - inter;
    if (inter / union < JACCARD_FLOOR) return 0; // reject wrong-candidate near-dupes
    return inter / small.size;
}

// ---- Kalshi pool -------------------------------------------------------
async function fetchKalshiPool() {
    const items = [];
    let cursor = '';
    for (let page = 0; page < 20 && items.length < pool; page++) {
        if (pastDeadline()) break;
        await sleep(REQUEST_GAP_MS);
        const p = new URLSearchParams({ status: 'open', with_nested_markets: 'true', limit: '200' });
        if (cursor) p.set('cursor', cursor);
        const d = await getJson(`${KALSHI_API}/events?${p.toString()}`);
        if (!d?.events?.length) break;
        for (const ev of d.events) {
            for (const m of ev.markets || []) {
                const yesBid = num(m.yes_bid_dollars);
                const yesAsk = num(m.yes_ask_dollars);
                const last = num(m.last_price_dollars);
                const mid = yesBid != null && yesAsk != null && yesAsk > 0 ? (yesBid + yesAsk) / 2 : null;
                const yes = mid ?? last;
                if (yes == null || yes <= 0) continue;            // unpriced
                const vol = num(m.volume_fp) ?? 0;
                if (minKVol > 0 && vol < minKVol) continue;
                const title = clean(m.title) || clean(ev.title);
                const sub = clean(m.yes_sub_title) || clean(m.subtitle);
                const text = [title, sub].filter(Boolean).join(' ');
                if (!text) continue;
                if (kws.length && !kws.some((k) => text.toLowerCase().includes(k))) continue;
                items.push({
                    venue: 'kalshi',
                    ticker: m.ticker,
                    text,
                    tokens: tokenize(text),
                    yesPct: Math.round(yes * 10000) / 100,
                    volume: vol,
                    category: clean(ev.category),
                    closeTime: clean(m.close_time),
                    url: ev.series_ticker ? `https://kalshi.com/markets/${String(ev.series_ticker).toLowerCase()}` : 'https://kalshi.com',
                });
                if (items.length >= pool) break;
            }
            if (items.length >= pool) break;
        }
        cursor = d.cursor || '';
        if (!cursor) break;
    }
    return items;
}

// ---- Polymarket pool ---------------------------------------------------
function polyYesPrice(m) {
    const outcomes = parseJsonArr(m.outcomes).map((o) => String(o).toLowerCase());
    const prices = parseJsonArr(m.outcomePrices).map((x) => num(x));
    // Binary only: outcomes must be exactly yes/no in some order.
    if (outcomes.length !== 2) return null;
    const set = new Set(outcomes);
    if (!(set.has('yes') && set.has('no'))) return null;
    const yesIdx = outcomes.indexOf('yes');
    const price = prices[yesIdx];
    return price != null ? price : num(m.lastTradePrice);
}
async function fetchPolyPool() {
    const items = [];
    let offset = 0;
    for (let page = 0; page < 30 && items.length < pool; page++) {
        if (pastDeadline()) break;
        await sleep(REQUEST_GAP_MS);
        const p = new URLSearchParams({
            active: 'true', closed: 'false', archived: 'false',
            order: 'volume24hr', ascending: 'false', limit: '100', offset: String(offset),
        });
        const batch = await getJson(`${POLY_API}/markets?${p.toString()}`);
        // A failed page (null) is skipped so one transient 422 does not abort
        // the whole pool; only a genuine empty array means end of data.
        if (batch === null) { offset += 100; continue; }
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const m of batch) {
            const yes = polyYesPrice(m);
            if (yes == null || yes <= 0) continue;               // not binary / unpriced
            const vol24 = num(m.volume24hr) ?? 0;
            if (minPVol > 0 && vol24 < minPVol) continue;
            const text = clean(m.question);
            if (!text) continue;
            if (kws.length && !kws.some((k) => text.toLowerCase().includes(k))) continue;
            items.push({
                venue: 'polymarket',
                text,
                tokens: tokenize(text),
                yesPct: Math.round(yes * 10000) / 100,
                volume24hr: vol24,
                volumeTotal: num(m.volumeNum) ?? num(m.volume),
                endDate: clean(m.endDate),
                url: m.slug ? `https://polymarket.com/market/${m.slug}` : 'https://polymarket.com',
            });
            if (items.length >= pool) break;
        }
        offset += batch.length;
        if (batch.length < 100) break;
    }
    return items;
}

// ---- Charge-aware emit -------------------------------------------------
let rowsPushed = 0;
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'pair_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// ---- Run ---------------------------------------------------------------
log.info(`Comparing Kalshi vs Polymarket${kws.length ? `, topics ~ ${kws.join(', ')}` : ' (top by volume)'}. minMatchScore=${minScore}, minSpreadPct=${minSpread}, pool<=${pool}/venue, cap ${cap} pairs.`);

const [kalshi, poly] = await Promise.all([fetchKalshiPool(), fetchPolyPool()]);
log.info(`Pools: ${kalshi.length} Kalshi binary markets, ${poly.length} Polymarket binary markets.`);

// Score every cross-venue candidate, then assign greedily one-to-one by
// descending score so each market is used at most once.
const candidates = [];
for (const k of kalshi) {
    for (const pm of poly) {
        const s = scorePair(k, pm);
        if (s >= minScore) candidates.push({ s, k, pm });
    }
}
candidates.sort((a, b) => b.s - a.s);
log.info(`${candidates.length} candidate pair(s) at score >= ${minScore}.`);

const usedK = new Set();
const usedP = new Set();
let emitted = 0;
for (const c of candidates) {
    if (rowsPushed >= cap) break;
    if (usedK.has(c.k.ticker) || usedP.has(c.pm.url)) continue;
    const spread = Math.round(Math.abs(c.k.yesPct - c.pm.yesPct) * 100) / 100;
    if (spread < minSpread) continue;
    usedK.add(c.k.ticker);
    usedP.add(c.pm.url);
    const cheaperYesVenue = c.k.yesPct < c.pm.yesPct ? 'kalshi' : 'polymarket';
    await flushRow({
        question: c.pm.text,
        kalshiTitle: c.k.text,
        polymarketTitle: c.pm.text,
        kalshiYesPct: c.k.yesPct,
        polymarketYesPct: c.pm.yesPct,
        spreadPct: spread,
        cheaperYesVenue,
        buySignal: `Buy YES on ${cheaperYesVenue} (${cheaperYesVenue === 'kalshi' ? c.k.yesPct : c.pm.yesPct}%), it is ${spread} pts cheaper.`,
        matchScore: Math.round(c.s * 100) / 100,
        category: c.k.category,
        kalshiVolume: c.k.volume,
        polymarketVolume24h: c.pm.volume24hr,
        kalshiCloseTime: c.k.closeTime,
        polymarketEndDate: c.pm.endDate,
        kalshiUrl: c.k.url,
        polymarketUrl: c.pm.url,
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
}

if (emitted === 0) {
    await flushRow({
        note: `No cross-venue pairs found${kws.length ? ` for topics ${kws.join(', ')}` : ''} at minMatchScore=${minScore}${minSpread ? ` and minSpreadPct=${minSpread}` : ''}. Try lowering minMatchScore, widening searchQueries, or a larger poolPerVenue.`,
        kalshiPool: kalshi.length,
        polymarketPool: poly.length,
    }, false);
}

log.info(`Done. ${emitted} cross-venue pair(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
