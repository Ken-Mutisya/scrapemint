// Crypto Order Book Depth: Liquidity and Slippage by Exchange
//
// What it does
// ------------
// A price quote tells you nothing about whether you can trade on it. This
// reads the live order book on four exchanges and answers the question a
// desk actually asks: how much can I move here, and what will it cost me.
//
//   depth      one row per coin per venue: best bid and ask, the spread, and
//              how much sits within 0.5, 1 and 2 per cent of mid on each side
//   slippage   one row per coin per venue per order size: the average fill
//              price a market order would get and the slippage in basis
//              points against mid
//   compare    one row per coin per order size: which venue fills that size
//              cheapest, and how much worse the worst venue is
//
// Venues: OKX, Gate, Bitget, KuCoin. All keyless, all spot, all reachable
// from a datacentre. Binance and Bybit block Apify addresses and are not
// included.
//
// Pay per event
// -------------
//   book_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 20000;
const SPACING_MS = 250;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
// Depth bands are fixed rather than user supplied so that every row has the
// same columns and two runs are always comparable.
const BANDS = [0.5, 1, 2];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'depth',
    symbols = ['BTC', 'ETH', 'SOL'],
    venues = ['okx', 'gate', 'bitget', 'kucoin'],
    quoteAsset = 'USDT',
    orderSizesUsd = [10000, 100000, 1000000],
    side = 'both',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const theMode = ['depth', 'slippage', 'compare'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'depth';
const theSide = ['both', 'buy', 'sell'].includes(String(side).toLowerCase())
    ? String(side).toLowerCase() : 'both';
const quote = String(quoteAsset || 'USDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'USDT';
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const sizes = [...new Set(asList(orderSizesUsd).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0))]
    .sort((a, b) => a - b).slice(0, 12);

// A buyer may type BTC, BTC-USDT, BTC/USDT or btcusdt. Everything is reduced
// to a base asset and then rebuilt in each venue's own format.
const parseSymbol = (raw) => {
    const s = String(raw || '').toUpperCase().replace(/\s+/g, '');
    const m = /^([A-Z0-9]+)[-_/]([A-Z0-9]+)$/.exec(s);
    if (m) return { base: m[1], quote: m[2] };
    if (s.endsWith(quote) && s.length > quote.length) return { base: s.slice(0, -quote.length), quote };
    return { base: s, quote };
};

const wantSymbols = asList(symbols).map(parseSymbol).filter((x) => x.base);
const VENUE_IDS = ['okx', 'gate', 'bitget', 'kucoin'];
const wantVenues = (() => {
    const raw = asList(venues).map((v) => v.toLowerCase());
    const ok = raw.filter((v) => VENUE_IDS.includes(v));
    return { ids: ok.length ? [...new Set(ok)] : VENUE_IDS, unknown: raw.filter((v) => !VENUE_IDS.includes(v)) };
})();

// The public books are not the same size on every venue. Gate serves a
// thousand levels, OKX four hundred, Bitget one hundred and fifty, KuCoin one
// hundred. That difference is the single biggest trap in comparing venues:
// a shallower book is not a less liquid venue, it is a shorter answer.
const VENUES = {
    okx: {
        name: 'OKX',
        maxLevels: 400,
        instrument: ({ base, quote: q }) => `${base}-${q}`,
        url: (inst) => `https://www.okx.com/api/v5/market/books?instId=${inst}&sz=400`,
        parse: (body) => {
            const d = JSON.parse(body);
            // HTTP 200 with an error code in the envelope: the status line is
            // not the success signal here.
            if (String(d.code) !== '0') return { error: `${d.msg || 'error'} (code ${d.code})` };
            const book = d.data?.[0];
            if (!book) return { error: 'no book returned' };
            return { bids: book.bids, asks: book.asks, sourceTime: numOrNull(book.ts) };
        },
    },
    gate: {
        name: 'Gate',
        maxLevels: 1000,
        instrument: ({ base, quote: q }) => `${base}_${q}`,
        url: (inst) => `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${inst}&limit=1000`,
        parse: (body) => {
            const d = JSON.parse(body);
            if (d.label) return { error: `${d.label}: ${d.message || ''}`.trim() };
            if (!d.bids || !d.asks) return { error: 'no book returned' };
            return { bids: d.bids, asks: d.asks, sourceTime: numOrNull(d.current) };
        },
    },
    bitget: {
        name: 'Bitget',
        // Asking for more than 150 does not fail, it silently returns 150.
        maxLevels: 150,
        instrument: ({ base, quote: q }) => `${base}${q}`,
        url: (inst) => `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${inst}&limit=150`,
        parse: (body) => {
            const d = JSON.parse(body);
            if (String(d.code) !== '00000') return { error: `${d.msg || 'error'} (code ${d.code})` };
            if (!d.data?.bids || !d.data?.asks) return { error: 'no book returned' };
            return { bids: d.data.bids, asks: d.data.asks, sourceTime: numOrNull(d.data.ts) };
        },
    },
    kucoin: {
        name: 'KuCoin',
        maxLevels: 100,
        instrument: ({ base, quote: q }) => `${base}-${q}`,
        url: (inst) => `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${inst}`,
        parse: (body) => {
            const d = JSON.parse(body);
            // An unknown symbol comes back as HTTP 200 with a null payload
            // rather than an error, so a missing book must be checked for.
            if (!d.data) return { error: 'unknown symbol or no book returned' };
            if (!d.data.bids || !d.data.asks) return { error: 'no book returned' };
            return { bids: d.data.bids, asks: d.data.asks, sourceTime: numOrNull(d.data.time) };
        },
    },
};

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'book_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

async function fetchBook(venueId, sym) {
    const venue = VENUES[venueId];
    const inst = venue.instrument(sym);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const fetchedAt = Date.now();
    try {
        const res = await fetch(venue.url(inst), {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': UA },
        });
        const body = await res.text();
        let parsed;
        try { parsed = venue.parse(body); }
        catch { return { error: 'response was not JSON', instrument: inst }; }
        if (parsed.error) return { error: parsed.error, instrument: inst };

        // Sort defensively rather than trusting the published order: bids
        // high to low, asks low to high.
        const bids = (parsed.bids || []).map((l) => [numOrNull(l[0]), numOrNull(l[1])])
            .filter((l) => l[0] != null && l[1] != null && l[1] > 0)
            .sort((a, b) => b[0] - a[0]);
        const asks = (parsed.asks || []).map((l) => [numOrNull(l[0]), numOrNull(l[1])])
            .filter((l) => l[0] != null && l[1] != null && l[1] > 0)
            .sort((a, b) => a[0] - b[0]);
        if (!bids.length || !asks.length) return { error: 'book had no usable levels', instrument: inst };
        return { bids, asks, instrument: inst, fetchedAt, sourceTime: parsed.sourceTime };
    } catch (err) {
        return { error: err?.message || 'fetch failed', instrument: inst };
    } finally { clearTimeout(timer); }
}

// Quantity is quoted in the base asset on all four venues, so notional is
// price times quantity in every case.
function bandDepth(levels, mid, pct, direction) {
    const limit = direction === 'bid' ? mid * (1 - pct / 100) : mid * (1 + pct / 100);
    let base = 0;
    let notional = 0;
    let used = 0;
    for (const [price, qty] of levels) {
        if (direction === 'bid' ? price < limit : price > limit) break;
        base += qty;
        notional += price * qty;
        used += 1;
    }
    // If every returned level fell inside the band, the book ran out before
    // the band did and this figure is a floor, not a measurement.
    const covered = used < levels.length;
    return { base, notional, used, covered };
}

function walkBook(levels, sizeUsd, direction) {
    let remaining = sizeUsd;
    let baseFilled = 0;
    let spent = 0;
    let used = 0;
    for (const [price, qty] of levels) {
        const levelNotional = price * qty;
        const take = Math.min(remaining, levelNotional);
        const baseTake = take / price;
        baseFilled += baseTake;
        spent += take;
        remaining -= take;
        used += 1;
        if (remaining <= 1e-9) break;
    }
    if (remaining > 1e-9) {
        // The visible book cannot absorb the order. Returning the price of a
        // partial fill as if it were the whole order would understate the
        // cost of the trade, so nothing is returned but the shortfall.
        return {
            filled: false, avgPrice: null, levelsUsed: used,
            fillableUsd: round(spent, 2), shortfallUsd: round(remaining, 2),
        };
    }
    return {
        filled: true, avgPrice: spent / baseFilled, levelsUsed: used,
        fillableUsd: round(spent, 2), shortfallUsd: 0,
    };
}

log.info(`Order book ${theMode} | ${wantSymbols.map((s) => s.base).join(',')} vs ${quote} | ${wantVenues.ids.join(',')}`);
if (wantVenues.unknown.length) {
    await note({
        unknownVenues: wantVenues.unknown,
        note: `not a covered venue: ${wantVenues.unknown.join(', ')}; covered venues are okx, gate, bitget, kucoin; Binance and Bybit block datacentre addresses and cannot be added; not charged`,
    });
}
if (!wantSymbols.length) {
    await note({ note: 'no symbols supplied; pass a coin such as BTC or a pair such as BTC-USDT; not charged' });
}

// Fetch every book once, then derive all three modes from the same snapshots.
const books = new Map();   // `${base}|${venueId}` -> book
const failures = [];
for (const sym of wantSymbols) {
    for (const venueId of wantVenues.ids) {
        if (pastDeadline()) break;
        const book = await fetchBook(venueId, sym);
        if (book.error) {
            failures.push({ base: sym.base, venueId, instrument: book.instrument, error: book.error });
            log.info(`${VENUES[venueId].name} ${book.instrument}: ${book.error}`);
        } else {
            books.set(`${sym.base}|${venueId}`, { ...book, sym });
            log.info(`${VENUES[venueId].name} ${book.instrument}: ${book.bids.length} bid / ${book.asks.length} ask levels`);
        }
        await sleep(SPACING_MS);
    }
}

const summarise = (book) => {
    const bestBid = book.bids[0][0];
    const bestAsk = book.asks[0][0];
    const mid = (bestBid + bestAsk) / 2;
    return { bestBid, bestAsk, mid, spreadBp: ((bestAsk - bestBid) / mid) * 10000 };
};

const baseRow = (base, venueId, book) => {
    const { bestBid, bestAsk, mid, spreadBp } = summarise(book);
    return {
        symbol: base,
        pair: `${base}/${quote}`,
        venue: VENUES[venueId].name,
        instrument: book.instrument,
        bestBidPrice: bestBid,
        bestAskPrice: bestAsk,
        midPrice: round(mid, 8),
        spreadBasisPoints: round(spreadBp, 3),
        bidLevelsReturned: book.bids.length,
        askLevelsReturned: book.asks.length,
        // Every venue publishes a different number of levels, so a like for
        // like depth comparison is only valid where the band is covered.
        maxLevelsPublished: VENUES[venueId].maxLevels,
        snapshotAt: new Date(book.fetchedAt).toISOString(),
    };
};

if (theMode === 'depth') {
    for (const [key, book] of books) {
        if (emitted >= rowCap || pastDeadline()) break;
        const [base, venueId] = key.split('|');
        const { mid } = summarise(book);
        const row = { mode: 'depth', ...baseRow(base, venueId, book) };
        let allCovered = true;
        for (const pct of BANDS) {
            const bid = bandDepth(book.bids, mid, pct, 'bid');
            const ask = bandDepth(book.asks, mid, pct, 'ask');
            const tag = String(pct).replace('.', '_');
            row[`bidDepth${tag}PctBase`] = round(bid.base, 6);
            row[`bidDepth${tag}PctUsd`] = round(bid.notional, 2);
            row[`askDepth${tag}PctBase`] = round(ask.base, 6);
            row[`askDepth${tag}PctUsd`] = round(ask.notional, 2);
            const total = bid.notional + ask.notional;
            // Positive means more resting bids than offers within the band.
            row[`imbalance${tag}PctPercent`] = total > 0
                ? round(((bid.notional - ask.notional) / total) * 100, 2) : null;
            row[`band${tag}PctFullyCovered`] = bid.covered && ask.covered;
            if (!(bid.covered && ask.covered)) allCovered = false;
        }
        row.allBandsFullyCovered = allCovered;
        row.depthCaveat = allCovered ? null
            : 'the published book ended inside one of the bands, so those depth figures are a floor rather than a measurement';
        row.scrapedAt = new Date().toISOString();
        await push(row);
    }
} else if (theMode === 'slippage') {
    const sides = theSide === 'both' ? ['buy', 'sell'] : [theSide];
    for (const [key, book] of books) {
        const [base, venueId] = key.split('|');
        const { mid } = summarise(book);
        for (const sizeUsd of sizes) {
            for (const s of sides) {
                if (emitted >= rowCap || pastDeadline()) break;
                const levels = s === 'buy' ? book.asks : book.bids;
                const walk = walkBook(levels, sizeUsd, s);
                const slipBp = walk.filled
                    ? ((s === 'buy' ? walk.avgPrice - mid : mid - walk.avgPrice) / mid) * 10000
                    : null;
                await push({
                    mode: 'slippage',
                    ...baseRow(base, venueId, book),
                    side: s,
                    orderSizeUsd: sizeUsd,
                    filled: walk.filled,
                    averageFillPrice: walk.avgPrice != null ? round(walk.avgPrice, 8) : null,
                    slippageBasisPoints: slipBp != null ? round(slipBp, 3) : null,
                    costVersusMidUsd: slipBp != null ? round((slipBp / 10000) * sizeUsd, 2) : null,
                    levelsConsumed: walk.levelsUsed,
                    fillableUsd: walk.fillableUsd,
                    shortfallUsd: walk.shortfallUsd,
                    unfillableReason: walk.filled ? null
                        : 'the published book does not reach this order size; the remainder would trade beyond the visible depth',
                    scrapedAt: new Date().toISOString(),
                });
            }
        }
    }
} else {
    // compare: for each coin and size, which venue fills it cheapest.
    for (const sym of wantSymbols) {
        for (const sizeUsd of sizes) {
            if (emitted >= rowCap || pastDeadline()) break;
            const sides = theSide === 'both' ? ['buy', 'sell'] : [theSide];
            for (const s of sides) {
                if (emitted >= rowCap) break;
                const quotes = [];
                const unableToFill = [];
                for (const venueId of wantVenues.ids) {
                    const book = books.get(`${sym.base}|${venueId}`);
                    if (!book) continue;
                    const { mid } = summarise(book);
                    const walk = walkBook(s === 'buy' ? book.asks : book.bids, sizeUsd, s);
                    if (!walk.filled) {
                        unableToFill.push({
                            venue: VENUES[venueId].name,
                            fillableUsd: walk.fillableUsd,
                        });
                        continue;
                    }
                    quotes.push({
                        venue: VENUES[venueId].name,
                        avgPrice: walk.avgPrice,
                        mid,
                        slipBp: ((s === 'buy' ? walk.avgPrice - mid : mid - walk.avgPrice) / mid) * 10000,
                        snapshotAt: book.fetchedAt,
                    });
                }
                if (!quotes.length) {
                    await note({
                        symbol: sym.base, orderSizeUsd: sizeUsd, side: s,
                        note: `no venue could fill a ${sizeUsd} ${quote} ${s} order for ${sym.base} within its published book; not charged`,
                    });
                    continue;
                }
                // Cheapest means the best achieved price for the trader:
                // lowest average paid when buying, highest received when
                // selling. Note this is NOT the same ranking as least
                // slippage: slippage is measured against each venue's own
                // mid, and the venue quoting the better outright price can
                // still show a larger move against its own book. Both
                // answers are reported rather than picking one and letting
                // the other look like a contradiction.
                quotes.sort((a, b) => (s === 'buy' ? a.avgPrice - b.avgPrice : b.avgPrice - a.avgPrice));
                const best = quotes[0];
                const worst = quotes[quotes.length - 1];
                const byImpact = [...quotes].sort((a, b) => a.slipBp - b.slipBp);
                const gapBp = Math.abs((worst.avgPrice - best.avgPrice) / best.avgPrice) * 10000;
                const times = quotes.map((q) => q.snapshotAt);
                await push({
                    mode: 'compare',
                    symbol: sym.base,
                    pair: `${sym.base}/${quote}`,
                    side: s,
                    orderSizeUsd: sizeUsd,
                    venuesCompared: quotes.length,
                    bestVenue: best.venue,
                    bestAverageFillPrice: round(best.avgPrice, 8),
                    bestSlippageBasisPoints: round(best.slipBp, 3),
                    worstVenue: worst.venue,
                    worstAverageFillPrice: round(worst.avgPrice, 8),
                    worstSlippageBasisPoints: round(worst.slipBp, 3),
                    venueGapBasisPoints: round(gapBp, 3),
                    savingVersusWorstUsd: round((gapBp / 10000) * sizeUsd, 2),
                    // Ranked by outright price above; ranked by market impact
                    // here. The two can disagree because each venue's mid is
                    // its own.
                    lowestImpactVenue: byImpact[0].venue,
                    lowestImpactSlippageBasisPoints: round(byImpact[0].slipBp, 3),
                    rankingBasis: 'best and worst are ranked on the outright price achieved; slippage is measured against each venue\'s own mid, so the two rankings can differ',
                    venuesUnableToFill: unableToFill,
                    ranking: quotes.map((q) => ({
                        venue: q.venue,
                        averageFillPrice: round(q.avgPrice, 8),
                        slippageBasisPoints: round(q.slipBp, 3),
                    })),
                    // The books are read one after another, not in a single
                    // instant. This is how far apart the compared snapshots
                    // were taken, so a tight gap can be judged against it.
                    snapshotSkewMs: Math.max(...times) - Math.min(...times),
                    scrapedAt: new Date().toISOString(),
                });
            }
        }
    }
}

for (const f of failures) {
    if (emitted >= rowCap) break;
    await note({
        symbol: f.base, venue: VENUES[f.venueId].name, instrument: f.instrument,
        note: `${VENUES[f.venueId].name} did not return a book for ${f.instrument}: ${f.error}; not charged`,
    });
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the symbols and venues requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
