// Prediction Market Arbitrage Finder: Kalshi, Polymarket and PredictIt
//
// Arbitrage (added 2026-10-18)
// ----------------------------
// For every matched pair, the two hedged trades are priced at the venues' own
// asks: YES on one venue plus NO on the other pays exactly $1 whichever way
// the question resolves. If YES ask + NO ask < $1 the difference is locked-in
// profit before fees. NO ask is Kalshi 1 - YES bid, Polymarket 1 - YES bid
// (or the NO token's ask when NO is listed first), PredictIt bestBuyNoCost.
// Fees are counted conservatively, as if both legs paid them:
//   Kalshi      taker fee 0.07 x P x (1 - P) per contract
//   PredictIt   10% of the profit on a winning contract, (1 - P) x 0.10
//   Polymarket  none on most markets
// Rows with a positive net return sort first.
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
// Kalshi lists ~1,800 markets per 200 events, so a small pool only ever saw
// the first few dozen events and matched almost nothing.
const POOL_HARD_CAP = 10000;
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
    poolPerVenue = 4000,
    onlyArbitrage = false,
    minNetReturnPct = 0,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(searchQueries).map((k) => k.toLowerCase());
const minSpread = Math.max(0, Number(minSpreadPct) || 0);
const minScore = Math.min(1, Math.max(0, Number(minMatchScore) || 0.5));
const minKVol = Math.max(0, Number(minKalshiVolume) || 0);
const minPVol = Math.max(0, Number(minPolymarketVolume24h) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxPairs) || 100));
const pool = Math.max(50, Math.min(POOL_HARD_CAP, Number(poolPerVenue) || 4000));
const minNetReturn = Number(minNetReturnPct) || 0;

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
    // The two venues name the same contest differently: Kalshi asks about a
    // "primary" or who will be the "nominee", Polymarket about the
    // "nomination". Without these the subject gate below reads a vocabulary
    // difference as a difference of subject and drops five true pairs.
    primary: 'nomination', primaries: 'nomination',
    nominee: 'nomination', nominated: 'nomination',
    midterm: 'election', midterms: 'election', elections: 'election',
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

// Token overlap cannot tell "qualify for the runoff" from "win", because the
// candidate name, the office and the year carry almost all the tokens and the
// outcome verb carries almost none. On 2026-08-09 every top "tradeable" gap was
// this error: Le Pen 80.5% to qualify for the 2027 runoff against 30.15% to win
// it, reported as a 50 point edge with matchScore 0.90. Qualifying is simply a
// likelier event than winning, so the gap is not a mispricing, and the wide gap
// is exactly why the book width check passed too.
//
// A claim family is the thing the question actually asks. Two questions may
// only be paired when they ask for the same one; a higher score threshold
// cannot separate these, since the false pairs score higher than many true
// ones.
const CLAIM_FAMILIES = [
    ['runoff', [/\brun ?off\b/, /\bsecond round\b/, /\bfirst round\b/, /\bqualify\b/, /\badvance\b/]],
    ['nomination', [/\bnominee\b/, /\bnominat/, /\bprimary\b/, /\bcaucus\b/]],
    ['candidacy', [/\bwho will run\b/, /\brun for\b/, /\brunning for\b/, /\bannounce\b/, /\bcandidacy\b/, /\bdeclare\b/, /\bfile to run\b/]],
    ['resign', [/\bresign\b/, /\bstep down\b/, /\bimpeach/, /\bremoved from office\b/, /\bout as\b/]],
    ['concede', [/\bconcede\b/, /\bconcession\b/]],
    // "Will X and Y not meet" is the opposite bet of "will X and Y meet". Paired, it read as a 729% arbitrage.
    ['negated', [/\bnot\b/, /\bwon'?t\b/, /\bfail to\b/, /\bfails to\b/]],
];
// Returns the sorted family names a question triggers. The empty set is the
// plain "will X win / will X happen" claim, which is the common case.
function claimFamilies(text) {
    const s = String(text || '').toLowerCase();
    const out = [];
    for (const [name, pats] of CLAIM_FAMILIES) {
        if (pats.some((p) => p.test(s))) out.push(name);
    }
    return out.sort().join('+');
}

// The same failure as the claim families, on the other axis: the subject. A
// Kalshi market names one candidate and a Polymarket grouped market names a
// different one, but the shared template ("who will win the 2028 Democratic
// presidential nomination") carries so many tokens that the name, one or two
// tokens, cannot move the score below the floor. That is how MrBeast at 19.5%
// was matched against Gavin Newsom at 0.15% and reported as a 19 point buy.
//
// The rule: if each side holds a strong token the other lacks, the two
// questions are about different things and must not be paired. One side being
// a superset of the other is the normal true match, since the venue that
// spells out the question simply says more.
function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}
// Eisenkot and Eizenkot are one person spelled two ways, so a small edit
// distance on a long token counts as agreement rather than a different subject.
const spellingVariant = (x, y) => Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= 2;
function subjectsAgree(a, b) {
    const aOnly = [...a.tokens].filter((t) => !b.tokens.has(t) && isStrong(t));
    const bOnly = [...b.tokens].filter((t) => !a.tokens.has(t) && isStrong(t));
    if (!aOnly.length || !bOnly.length) return true; // one side is a superset
    return aOnly.every((x) => bOnly.some((y) => spellingVariant(x, y)))
        && bOnly.every((y) => aOnly.some((x) => spellingVariant(y, x)));
}
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
    // Same question or no pair at all, whatever the token overlap says.
    if (claimFamilies(a.text) !== claimFamilies(b.text)) return 0;
    if (!subjectsAgree(a, b)) return 0;
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
                // Multivariate combos (parlays) exist only on Kalshi; they can never match.
                if (/^KXMVE/.test(m.ticker || '')) continue;
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
                    // A 0 bid or a $1 ask is an empty side of the book, not a price.
                    yesAsk: yesAsk > 0 && yesAsk < 1 ? yesAsk : null,
                    noAsk: yesBid > 0 && yesBid < 1 ? Math.round((1 - yesBid) * 10000) / 10000 : null,
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
    // The same quote read as YES ask and NO ask, whichever outcome it belongs to.
    const bid = num(m.bestBid);
    const ask = num(m.bestAsk);
    const live = (p) => (p != null && p > 0 && p < 1 ? p : null);
    const flip = (p) => (live(p) == null ? null : Math.round((1 - p) * 10000) / 10000);
    const yesAsk = yesIdx === 0 ? live(ask) : flip(bid);
    const noAsk = yesIdx === 0 ? flip(bid) : live(ask);
    return { yes, bookWidthPct: width, yesAsk, noAsk };
}
async function fetchPolyPool() {
    const items = [];
    let offset = 0;
    for (let page = 0; page < 60 && items.length < pool; page++) {
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
                yesAsk: quote.yesAsk,
                noAsk: quote.noAsk,
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
                yesAsk: ask > 0 && ask < 1 ? ask : null,
                noAsk: num(c.bestBuyNoCost) > 0 && num(c.bestBuyNoCost) < 1 ? num(c.bestBuyNoCost) : null,
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
        // scorePair needs a shared strong token, so only those pairs are scored.
        // Comparing every market with every other took 7 minutes at 4,000 per venue.
        const index = new Map();
        for (const b of pools[vb]) {
            for (const t of b.tokens) {
                if (!isStrong(t)) continue;
                if (!index.has(t)) index.set(t, []);
                index.get(t).push(b);
            }
        }
        for (const a of pools[va]) {
            const seen = new Set();
            for (const t of a.tokens) {
                if (!isStrong(t)) continue;
                for (const b of index.get(t) || []) {
                    if (seen.has(b)) continue;
                    seen.add(b);
                    const s = scorePair(a, b);
                    if (s >= minScore) candidates.push({ s, combo, a, b });
                }
            }
        }
    }
}
candidates.sort((a, b) => b.s - a.s);
log.info(`${candidates.length} candidate pair(s) at score >= ${minScore} across ${selected.length} venue(s).`);

// Assign greedily one-to-one by descending score, PER venue combination, so
// the same question can still surface on every combination it appears in.
const FEE = {
    kalshi: (p) => 0.07 * p * (1 - p),
    predictit: (p) => 0.10 * (1 - p),
    polymarket: () => 0,
};
const r4 = (n) => Math.round(n * 10000) / 10000;
const MAX_SANE_GAP_PTS = 25;
// Pairs below this match score are shown for the odds gap but never called arbitrage.
const MIN_ARB_SCORE = 0.8;
// Best of the two hedges: YES on one venue + NO on the other pays $1 either way.
// A number on one side only (a district like NJ-04, a date like Jan 1) means
// the two questions differ in a detail; years are left out since "next" and
// "2026" routinely name the same election.
function numbersDiffer(a, b) {
    const nums = (x) => [...x.tokens].filter((t) => /\d/.test(t) && !/^(19|20)\d\d$/.test(t));
    const na = nums(a);
    const nb = nums(b);
    return na.some((t) => !b.tokens.has(t)) || nb.some((t) => !a.tokens.has(t));
}
function arbOf(a, b, score) {
    let best = null;
    for (const [y, n] of [[a, b], [b, a]]) {
        if (y.yesAsk == null || n.noAsk == null) continue;
        const cost = y.yesAsk + n.noAsk;
        const fees = FEE[y.venue](y.yesAsk) + FEE[n.venue](n.noAsk);
        const net = 1 - cost - fees;
        if (!best || net > best.net) best = { y, n, cost, fees, net };
    }
    if (!best) return null;
    // A one-sided book (a 1c ask with no bid, say) is usually a stale order, not a price you can fill.
    const twoSided = [a, b].every((v) => v.yesAsk != null && v.noAsk != null);
    // Venues rarely disagree by more than a few points on the same question. A
    // gap this wide almost always means the matcher paired two different questions.
    const suspect = Math.abs(a.yesPct - b.yesPct) > MAX_SANE_GAP_PTS || numbersDiffer(a, b) || score < MIN_ARB_SCORE;
    return {
        arbitrage: best.net > 0 && twoSided && !suspect,
        suspectedMismatch: suspect,
        bothBooksTwoSided: twoSided,
        arbStrategy: `Buy YES on ${best.y.venue} at ${best.y.yesAsk} + buy NO on ${best.n.venue} at ${best.n.noAsk} = ${r4(best.cost)} for a $1 payout`,
        arbYesVenue: best.y.venue,
        arbYesAsk: best.y.yesAsk,
        arbNoVenue: best.n.venue,
        arbNoAsk: best.n.noAsk,
        arbCostPerContract: r4(best.cost),
        grossProfitPerContract: r4(1 - best.cost),
        feesPerContract: r4(best.fees),
        netProfitPerContract: r4(best.net),
        netReturnPct: Math.round((best.net / best.cost) * 10000) / 100,
    };
}
const NO_ARB = {
    arbitrage: null, suspectedMismatch: null, bothBooksTwoSided: null, arbStrategy: null, arbYesVenue: null, arbYesAsk: null, arbNoVenue: null, arbNoAsk: null,
    arbCostPerContract: null, grossProfitPerContract: null, feesPerContract: null, netProfitPerContract: null, netReturnPct: null,
};

const used = new Set();
const pairs = [];
for (const c of candidates) {
    const ka = `${c.combo}|${c.a.key}`;
    const kb = `${c.combo}|${c.b.key}`;
    if (used.has(ka) || used.has(kb)) continue;
    const spread = Math.round(Math.abs(c.a.yesPct - c.b.yesPct) * 100) / 100;
    if (spread < minSpread) continue;
    used.add(ka);
    used.add(kb);
    const arb = arbOf(c.a, c.b, c.s);
    if (onlyArbitrage && !(arb?.arbitrage && arb.netReturnPct >= minNetReturn)) continue;
    pairs.push({ c, spread, arb });
}
// Locked-in profit first, best net return on top; then the widest gaps.
pairs.sort((x, y) => (y.arb?.arbitrage ? 1 : 0) - (x.arb?.arbitrage ? 1 : 0)
    || (y.arb?.arbitrage ? y.arb.netReturnPct - x.arb.netReturnPct : 0)
    || y.spread - x.spread);
log.info(`${pairs.length} matched pair(s), ${pairs.filter((p) => p.arb?.arbitrage).length} with a positive net arbitrage.`);

let emitted = 0;
for (const { c, spread, arb } of pairs) {
    if (rowsPushed >= cap) break;

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
        ...(arb ?? NO_ARB),
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
