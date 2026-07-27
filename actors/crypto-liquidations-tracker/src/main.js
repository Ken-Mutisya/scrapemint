// Crypto Liquidations Tracker: Forced Long & Short Closeouts
//
// Strategy
// --------
// Funding rates and open interest show positioning building up. Liquidations
// show it breaking. Two keyless venues publish forced closeouts on their public
// APIs: OKX (deep, thousands of events per coin per day) and Gate (thin, tens).
// Binance and Bybit block Apify datacenter IPs, and Bitget publishes no
// liquidation endpoint at all, so this is the reachable set.
//
//   summary       one row per coin per venue: long vs short liquidated in USD,
//                 event counts, largest single hit, and the long/short ratio
//   liquidations  one row per forced closeout, newest first, in USD
//   positioning   OKX long/short account ratio over time, the leading
//                 indicator: a crowded long book is what makes a cascade
//
// The number that matters
// -----------------------
// Sizes are quoted in CONTRACTS, not coins. An OKX BTC swap contract is 0.01
// BTC, a Gate BTC contract is 0.0001 BTC, and multipliers differ per contract
// (ETH is 0.1 on OKX, 0.01 on Gate). Every row is converted through the venue's
// own contract table before it is reported in dollars. Skipping that step
// misreports size by orders of magnitude, which is exactly how a sibling actor
// once printed BTC open interest as $7.5 trillion.
//
// Other source quirks handled
// ---------------------------
//   - OKX returns 16 entries in `data` but 15 of them are JSON `$ref` pointers
//     back to `$.data[0]`; only the first carries real details. Anything that
//     naively concatenates every entry multiplies the event count by 16.
//   - OKX posSide is the side that GOT liquidated; `side` is the offsetting
//     trade the engine placed (a liquidated short shows posSide short, side
//     buy). Reporting `side` instead would invert every row.
//   - Gate signs the position instead: negative size = a short was closed. Its
//     `size` is the REMAINING position as the engine works it down, and
//     `order_size` is what each event actually closed; consecutive rows differ
//     by exactly the previous order_size. Summing `size` double counts a single
//     liquidation across all of its partial fills.
//
// Pay per event
// -------------
//   liquidation_row ($0.003) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 45000;
const MAX_COINS = 30;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'summary',
    coins = ['BTC', 'ETH', 'SOL'],
    venues = ['okx', 'gate'],
    side = 'both',
    minValueUsd = 0,
    period = '1H',
    positioningPoints = 48,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['summary', 'liquidations', 'positioning'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'summary';
const coinList = [...new Set(asList(coins).map((c) => c.toUpperCase().replace(/[-_/].*$/, '')))].slice(0, MAX_COINS);
if (!coinList.length) coinList.push('BTC');
const venueKeys = asList(venues).map((v) => v.toLowerCase()).filter((v) => ['okx', 'gate'].includes(v));
if (!venueKeys.length) venueKeys.push('okx', 'gate');
const wantSide = ['long', 'short'].includes(String(side).toLowerCase()) ? String(side).toLowerCase() : 'both';
const valueFloor = Math.max(0, Number(minValueUsd) || 0);
const thePeriod = ['5m', '15m', '30m', '1H', '4H', '1D'].includes(String(period)) ? String(period) : '1H';
const points = Math.max(1, Math.min(1440, Number(positioningPoints) || 48));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed for ${url.slice(0, 80)}: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'liquidation_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Contract multipliers, fetched once per venue and reused for every coin.
const multipliers = { okx: new Map(), gate: new Map() };

async function loadOkxContracts() {
    const j = await getJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
    for (const x of j?.data || []) {
        const ctVal = num(x.ctVal);
        // Only linear USDT contracts are sized in the base coin; inverse
        // contracts are quoted in USD and are excluded rather than guessed at.
        if (ctVal && x.ctValCcy && x.ctValCcy !== 'USD' && x.ctValCcy !== 'USDT') {
            multipliers.okx.set(x.instId, ctVal);
        }
    }
    log.info(`OKX: ${multipliers.okx.size} swap contract multipliers loaded`);
}

async function loadGateContracts() {
    const j = await getJson('https://api.gateio.ws/api/v4/futures/usdt/contracts');
    for (const x of j || []) {
        const m = num(x.quanto_multiplier);
        if (m) multipliers.gate.set(x.name, m);
    }
    log.info(`Gate: ${multipliers.gate.size} futures contract multipliers loaded`);
}

// Returns a normalised event list: { venue, coin, instrument, side, price,
// contracts, coinAmount, valueUsd, timeMs }.
async function okxEvents(coin) {
    const instId = `${coin}-USDT-SWAP`;
    const mult = multipliers.okx.get(instId);
    if (!mult) { log.warning(`OKX: no USDT swap contract for ${coin}`); return null; }
    const j = await getJson(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&state=filled&uly=${encodeURIComponent(`${coin}-USDT`)}`);
    if (!j || j.code !== '0') return null;
    const out = [];
    for (const entry of j.data || []) {
        // Skip the $ref pointer entries; only real detail arrays count.
        if (entry.$ref || !Array.isArray(entry.details)) continue;
        for (const d of entry.details) {
            const price = num(d.bkPx);
            const contracts = num(d.sz);
            if (price == null || contracts == null) continue;
            const coinAmount = contracts * mult;
            out.push({
                venue: 'OKX',
                coin,
                instrument: entry.instId || instId,
                // posSide is the side that was liquidated, not the offsetting trade.
                side: d.posSide === 'long' ? 'long' : 'short',
                price,
                contracts,
                coinAmount: round(coinAmount, 8),
                valueUsd: round(coinAmount * price, 2),
                timeMs: num(d.ts) ?? num(d.time),
            });
        }
    }
    return out;
}

async function gateEvents(coin) {
    const contract = `${coin}_USDT`;
    const mult = multipliers.gate.get(contract);
    if (!mult) { log.warning(`Gate: no USDT futures contract for ${coin}`); return null; }
    const j = await getJson(`https://api.gateio.ws/api/v4/futures/usdt/liq_orders?contract=${encodeURIComponent(contract)}&limit=100`);
    if (!Array.isArray(j)) return null;
    const out = [];
    for (const d of j) {
        const price = num(d.fill_price);
        const size = num(d.size);
        // `size` is the REMAINING position as it is worked down, not the amount
        // closed: consecutive rows differ by exactly the previous order_size.
        // Summing it double counts one liquidation across all its partial
        // fills, so the quantity comes from order_size and only the DIRECTION
        // comes from the sign of size.
        const filled = num(d.order_size);
        if (price == null || size == null || filled == null) continue;
        const coinAmount = Math.abs(filled) * mult;
        out.push({
            venue: 'Gate.io',
            coin,
            instrument: contract,
            // Gate signs the position: a negative size closed a short.
            side: size < 0 ? 'short' : 'long',
            price,
            contracts: Math.abs(filled),
            coinAmount: round(coinAmount, 8),
            valueUsd: round(coinAmount * price, 2),
            timeMs: d.time ? d.time * 1000 : null,
        });
    }
    return out;
}

const fetchers = { okx: okxEvents, gate: gateEvents };

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Crypto liquidations ${theMode} | ${coinList.join(', ')} | ${venueKeys.join(', ')}`
    + (theMode === 'positioning' ? ` | period ${thePeriod}` : '') + ` | cap ${cap} rows`);

if (theMode === 'positioning') {
    for (const coin of coinList) {
        if (stopEarly()) break;
        const j = await getJson(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${encodeURIComponent(coin)}&period=${thePeriod}`);
        const rows = (j?.data || []).slice(0, points);
        if (!rows.length) {
            log.warning(`OKX: no long/short ratio for ${coin}`);
            await flushRow({ type: 'note', coin, found: false, note: 'no long/short account ratio published for this coin; not charged' }, false);
            continue;
        }
        for (const [ts, ratio] of rows) {
            if (stopEarly()) break;
            const r = num(ratio);
            await flushRow({
                mode: 'positioning',
                venue: 'OKX',
                coin,
                timestamp: new Date(num(ts)).toISOString(),
                longShortAccountRatio: r,
                // Same figure as a share of accounts, which reads more easily.
                longAccountPercent: r != null ? round((r / (1 + r)) * 100, 2) : null,
                period: thePeriod,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
    }
} else {
    if (venueKeys.includes('okx')) await loadOkxContracts();
    if (venueKeys.includes('gate')) await loadGateContracts();

    for (const coin of coinList) {
        if (stopEarly()) break;
        for (const key of venueKeys) {
            if (stopEarly()) break;
            const events = await fetchers[key](coin);
            if (events == null) {
                await flushRow({
                    type: 'note', venue: key, coin, found: false,
                    note: 'no liquidation feed available for this coin on this venue; not charged',
                }, false);
                continue;
            }
            const kept = events.filter((e) => (wantSide === 'both' || e.side === wantSide)
                && (!valueFloor || (e.valueUsd ?? 0) >= valueFloor));

            if (theMode === 'liquidations') {
                kept.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
                if (!kept.length) {
                    await flushRow({
                        type: 'note', venue: key, coin, found: false,
                        note: `no liquidations matched the filters on ${key}; not charged`,
                    }, false);
                }
                for (const e of kept) {
                    if (stopEarly()) break;
                    const { timeMs, ...rest } = e;
                    await flushRow({
                        mode: 'liquidations', ...rest,
                        liquidatedAt: timeMs ? new Date(timeMs).toISOString() : null,
                        scrapedAt: new Date().toISOString(),
                    });
                    emitted += 1;
                }
                continue;
            }

            // summary: aggregate the window this venue happens to return.
            if (!kept.length) {
                await flushRow({
                    type: 'note', venue: key, coin, found: false,
                    note: `no liquidations matched the filters on ${key}; not charged`,
                }, false);
                continue;
            }
            let longUsd = 0; let shortUsd = 0; let longN = 0; let shortN = 0; let biggest = null;
            let minT = Infinity; let maxT = -Infinity;
            for (const e of kept) {
                const v = e.valueUsd ?? 0;
                if (e.side === 'long') { longUsd += v; longN += 1; } else { shortUsd += v; shortN += 1; }
                if (!biggest || v > (biggest.valueUsd ?? 0)) biggest = e;
                if (e.timeMs != null) { if (e.timeMs < minT) minT = e.timeMs; if (e.timeMs > maxT) maxT = e.timeMs; }
            }
            const total = longUsd + shortUsd;
            await flushRow({
                mode: 'summary',
                venue: kept[0].venue,
                coin,
                instrument: kept[0].instrument,
                events: kept.length,
                longEvents: longN,
                shortEvents: shortN,
                longLiquidatedUsd: round(longUsd, 2),
                shortLiquidatedUsd: round(shortUsd, 2),
                totalLiquidatedUsd: round(total, 2),
                // Above 1 means longs took the pain, which is the capitulation
                // read; below 1 means shorts were squeezed.
                longShortLiquidationRatio: shortUsd > 0 ? round(longUsd / shortUsd, 3) : null,
                largestLiquidationUsd: biggest?.valueUsd ?? null,
                largestLiquidationSide: biggest?.side ?? null,
                averageLiquidationUsd: round(total / kept.length, 2),
                windowStart: Number.isFinite(minT) ? new Date(minT).toISOString() : null,
                windowEnd: Number.isFinite(maxT) ? new Date(maxT).toISOString() : null,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
