// Prediction Market Odds Comparison: Kalshi, Polymarket and PredictIt
//
// Strategy
// --------
// The same real-world question is often listed on SEVERAL prediction venues,
// yet they frequently price the YES outcome differently. This actor pulls
// live binary (Yes/No) markets from each venue through their keyless public
// APIs, matches equivalent questions across venues by token overlap, and
// reports the YES-price gap so traders can see the cross-venue spread in one
// place (buy YES on the cheaper side).
//
//   Kalshi:     GET api.elections.kalshi.com/trade-api/v2/events
//                   ?with_nested_markets=true (prices are *_dollars STRINGS)
//   Polymarket: GET gamma-api.polymarket.com/markets
//                   (outcomes / outcomePrices are JSON STRING arrays)
//   PredictIt:  GET www.predictit.org/api/marketdata/all/
//                   (one call returns every market; contracts nest inside)
//
// Only binary Yes/No markets are compared, so the YES probability is directly
// comparable. A venue's multi-outcome market is expanded into its independent
// Yes/No legs (Kalshi markets inside an event, PredictIt contracts inside a
// market); Polymarket questions that are not exactly Yes/No are skipped.
//
// With three venues a single question can produce up to three pairs (one per
// venue combination). Dedupe is therefore per venue-pair, not global, so the
// Kalshi leg of a question can appear against both Polymarket and PredictIt.
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
const PREDICTIT_API = 'https://www.predictit.org/api/marketdata/all/';
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 200;
const POOL_HARD_CAP = 2000;
const UA = 'PredictionMarketOddsComparison/1.0 (+https://apify.com/scrapemint/prediction-market-odds-comparison)';

const ALL_VENUES = ['kalshi', 'polymarket', 'predictit'];

// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    venues = ALL_VENUES,
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

// Comparison needs two venues. A selection with fewer falls back to all three
// rather than running a pass that can never produce a pair.
let selected = asList(venues).map((v) => v.toLowerCase()).filter((v) => ALL_VENUES.includes(v));
selected = ALL_VENUES.filter((v) => selected.includes(v));
if (selected.length < 2) {
    log.warning(`venues=${JSON.stringify(venues)} selects fewer than 2 known venues; comparing all three instead.`);
    selected = [...ALL_VENUES];
}

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
const pct = (p) => Math.round(p * 10000) / 100;
// Width of a venue's own YES bid/ask, in probability points. Null whenever a
// side of the book is empty: an absent quote is unknown width, not zero.
const bookWidth = (bid, ask) => (bid != null && ask != null && ask >= bid ? pct(ask - bid) : null);

// ---- Text normalisation for matching -----------------------------------
const STOPWORDS = new Set([
    'will', 'the', 'be', 'a', 'an', 'of', 'to', 'in', 'on', 'by', 'at', 'for',
    'is', 'are', 'was', 'were', 'or', 'and', 'market', 'markets', 'who', 'what',
    'when', 'which', 'this', 'that', 'before', 'after', 'next', 'yes', 'no', 'do',
    'does', 'have', 'has', 'it', 'its', 'their', 'his', 'her', 'as', 'with',
]);
// Boost recall across the venues' phrasing.
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

const matchesKeywords = (text) => !kws.length || kws.some((k) => text.toLowerCase().includes(k));

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
                if (!matchesKeywords(text)) continue;
                items.push({
                    venue: 'kalshi',
                    key: `kalshi:${m.ticker}`,
                    ticker: m.ticker,
                    text,
                    tokens: tokenize(text),
                    yesPct: pct(yes),
                    bookWidthPct: bookWidth(yesBid, yesAsk),
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
    const yes = price != null ? price : num(m.lastTradePrice);
    if (yes == null) return null;
    // bestBid/bestAsk quote the FIRST outcome's token. When the venue lists No
    // first they describe the No side, so the YES book width is unknown rather
    // than assumed.
    const width = yesIdx === 0 ? bookWidth(num(m.bestBid), num(m.bestAsk)) : null;
    return { yes, bookWidthPct: width };
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
            const quote = polyYesPrice(m);
            const yes = quote?.yes;
            if (yes == null || yes <= 0) continue;               // not binary / unpriced
            const vol24 = num(m.volume24hr) ?? 0;
            if (minPVol > 0 && vol24 < minPVol) continue;
            const text = clean(m.question);
            if (!text) continue;
            if (!matchesKeywords(text)) continue;
            items.push({
                venue: 'polymarket',
                key: `polymarket:${m.slug || m.id || text}`,
                text,
                tokens: tokenize(text),
                yesPct: pct(yes),
                bookWidthPct: quote.bookWidthPct,
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

// ---- PredictIt pool ----------------------------------------------------
// One call returns every open market. A market holds one or more contracts,
// and EACH CONTRACT IS ITS OWN INDEPENDENT Yes/No bet (they are not mutually
// exclusive and their Yes prices do not sum to 1), so every contract becomes
// its own binary row rather than being folded into a multi-outcome market.
async function fetchPredictItPool() {
    const items = [];
    if (pastDeadline()) return items;
    const d = await getJson(PREDICTIT_API);
    const markets = Array.isArray(d?.markets) ? d.markets : [];
    if (!markets.length) {
        log.warning('PredictIt returned no markets.');
        return items;
    }
    for (const m of markets) {
        if (m.status && String(m.status).toLowerCase() !== 'open') continue;
        const marketName = clean(m.name) || clean(m.shortName);
        if (!marketName) continue;
        for (const c of m.contracts || []) {
            if (c.status && String(c.status).toLowerCase() !== 'open') continue;
            // bestBuyYesCost is the YES ask, bestSellYesCost the YES bid. Both
            // are null when that side of the book is empty, and Number(null)
            // is 0, which would publish a free-money 0% probability. Only take
            // a mid when BOTH sides exist; otherwise fall back to last traded.
            const ask = num(c.bestBuyYesCost);
            const bid = num(c.bestSellYesCost);
            const last = num(c.lastTradePrice);
            const mid = ask != null && bid != null ? (ask + bid) / 2 : null;
            const yes = mid ?? last;
            if (yes == null || yes <= 0) continue;               // unpriced
            const contractName = clean(c.name);
            // On single-contract markets the contract name repeats the market
            // name verbatim; joining both would double every token.
            const sameText = contractName
                && contractName.toLowerCase() === marketName.toLowerCase();
            const text = contractName && !sameText
                ? `${marketName} ${contractName}`
                : marketName;
            if (!matchesKeywords(text)) continue;
            items.push({
                venue: 'predictit',
                key: `predictit:${c.id}`,
                text,
                tokens: tokenize(text),
                yesPct: pct(yes),
                bookWidthPct: bookWidth(bid, ask),
                contract: contractName,
                bestBuyYesCost: ask,
                bestSellYesCost: bid,
                lastTradePrice: last,
                // dateEnd is the literal string "NA" on most contracts.
                dateEnd: clean(c.dateEnd) && c.dateEnd !== 'NA' ? clean(c.dateEnd) : null,
                url: clean(m.url) || `https://www.predictit.org/markets/detail/${m.id}`,
            });
            if (items.length >= pool) break;
        }
        if (items.length >= pool) break;
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

// ---- Venue-specific output columns -------------------------------------
// Every row carries a column block for all three venues so the shape is
// stable; the venue not in the pair reads null rather than being absent.
function venueColumns(byVenue) {
    const k = byVenue.kalshi;
    const p = byVenue.polymarket;
    const pi = byVenue.predictit;
    return {
        kalshiTitle: k?.text ?? null,
        kalshiYesPct: k?.yesPct ?? null,
        kalshiBookWidthPct: k?.bookWidthPct ?? null,
        kalshiVolume: k?.volume ?? null,
        kalshiCloseTime: k?.closeTime ?? null,
        kalshiUrl: k?.url ?? null,
        polymarketTitle: p?.text ?? null,
        polymarketYesPct: p?.yesPct ?? null,
        polymarketBookWidthPct: p?.bookWidthPct ?? null,
        polymarketVolume24h: p?.volume24hr ?? null,
        polymarketEndDate: p?.endDate ?? null,
        polymarketUrl: p?.url ?? null,
        predictitTitle: pi?.text ?? null,
        predictitYesPct: pi?.yesPct ?? null,
        predictitBookWidthPct: pi?.bookWidthPct ?? null,
        predictitContract: pi?.contract ?? null,
        predictitBestBuyYesCost: pi?.bestBuyYesCost ?? null,
        predictitBestSellYesCost: pi?.bestSellYesCost ?? null,
        predictitDateEnd: pi?.dateEnd ?? null,
        predictitUrl: pi?.url ?? null,
        // PredictIt publishes no volume field at all. Null means not reported
        // by the venue, never zero traded.
        predictitVolume: null,
    };
}

// ---- Run ---------------------------------------------------------------
log.info(`Comparing ${selected.join(' vs ')}${kws.length ? `, topics ~ ${kws.join(', ')}` : ' (top by volume)'}. minMatchScore=${minScore}, minSpreadPct=${minSpread}, pool<=${pool}/venue, cap ${cap} pairs.`);

const FETCHERS = {
    kalshi: fetchKalshiPool,
    polymarket: fetchPolyPool,
    predictit: fetchPredictItPool,
};
const fetched = await Promise.all(selected.map((v) => FETCHERS[v]()));
const pools = {};
selected.forEach((v, i) => { pools[v] = fetched[i]; });
log.info(`Pools: ${selected.map((v) => `${pools[v].length} ${v}`).join(', ')} binary markets.`);

// Score every cross-venue candidate across each venue combination.
const candidates = [];
for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
        const va = selected[i];
        const vb = selected[j];
        const combo = `${va}|${vb}`;
        for (const a of pools[va]) {
            for (const b of pools[vb]) {
                const s = scorePair(a, b);
                if (s >= minScore) candidates.push({ s, combo, a, b });
            }
        }
    }
}
candidates.sort((a, b) => b.s - a.s);
log.info(`${candidates.length} candidate pair(s) at score >= ${minScore} across ${selected.length} venue(s).`);

// Assign greedily one-to-one by descending score, PER venue combination, so
// the same question can still surface on every combination it appears in.
const used = new Set();
let emitted = 0;
for (const c of candidates) {
    if (rowsPushed >= cap) break;
    const ka = `${c.combo}|${c.a.key}`;
    const kb = `${c.combo}|${c.b.key}`;
    if (used.has(ka) || used.has(kb)) continue;
    const spread = Math.round(Math.abs(c.a.yesPct - c.b.yesPct) * 100) / 100;
    if (spread < minSpread) continue;
    used.add(ka);
    used.add(kb);

    const byVenue = { [c.a.venue]: c.a, [c.b.venue]: c.b };
    const cheaper = c.a.yesPct <= c.b.yesPct ? c.a : c.b;
    // Polymarket phrases questions in full prose, so it reads best as the
    // headline when it is one of the two sides.
    const headline = byVenue.polymarket?.text ?? c.a.text;

    // A cross-venue gap is only worth acting on if it survives crossing both
    // venues' own bid/ask. PredictIt in particular quotes books tens of points
    // wide on thin contracts, where a mid-to-mid "gap" is not tradeable at all.
    const widths = [c.a.bookWidthPct, c.b.bookWidthPct].filter((w) => w != null);
    const widest = widths.length === 2 ? Math.max(...widths) : null;
    const exceeds = widest == null ? null : spread > widest;
    const signal = exceeds === false
        ? `Gap of ${spread} pts is inside the quoted bid/ask (widest ${widest} pts), so it is not tradeable as shown.`
        : `Buy YES on ${cheaper.venue} (${cheaper.yesPct}%), it is ${spread} pts cheaper.${exceeds == null ? ' One venue did not quote both sides, so tradeability is unconfirmed.' : ''}`;

    await flushRow({
        question: headline,
        venueA: c.a.venue,
        venueB: c.b.venue,
        venueAYesPct: c.a.yesPct,
        venueBYesPct: c.b.yesPct,
        spreadPct: spread,
        cheaperYesVenue: cheaper.venue,
        widestBookWidthPct: widest,
        gapExceedsBookWidth: exceeds,
        buySignal: signal,
        matchScore: Math.round(c.s * 100) / 100,
        category: byVenue.kalshi?.category ?? null,
        ...venueColumns(byVenue),
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
}

if (emitted === 0) {
    await flushRow({
        note: `No cross-venue pairs found${kws.length ? ` for topics ${kws.join(', ')}` : ''} at minMatchScore=${minScore}${minSpread ? ` and minSpreadPct=${minSpread}` : ''}. Try lowering minMatchScore, widening searchQueries, or a larger poolPerVenue.`,
        venuesCompared: selected.join(', '),
        kalshiPool: pools.kalshi?.length ?? null,
        polymarketPool: pools.polymarket?.length ?? null,
        predictitPool: pools.predictit?.length ?? null,
    }, false);
}

log.info(`Done. ${emitted} cross-venue pair(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
