// Crypto Funding Rates & Open Interest Tracker
//
// Strategy
// --------
// Perpetual futures never expire, so exchanges use a periodic funding
// payment to tether them to spot: positive funding means longs pay shorts
// (crowded longs), negative means shorts pay longs. This actor reads
// funding and open interest across four venues, each in one or two bulk
// calls, and lines them up per coin.
//
//   OKX     funding-rate?instId=ANY (bulk, 512) + open-interest?instType=SWAP
//   Gate.io futures/usdt/tickers + futures/usdt/contracts (interval, multiplier)
//   Bitget  mix/market/tickers + mix/market/contracts (fundInterval)
//   KuCoin  contracts/active (funding, OI, interval, multiplier in one)
//
// Binance and Bybit are deliberately absent: both geo-block the Apify
// datacenter (verified from DC before this was built). The README says so
// rather than letting a buyer discover it.
//
// Source notes / gotchas
// ----------------------
//   * Funding intervals DIFFER by venue and by contract (8h is common, but
//     4h and 1h exist). Comparing raw rates across venues is therefore
//     wrong, so every rate is also annualized using the interval each
//     venue reports, and the interval is on every row.
//   * Symbol naming differs everywhere: BTC_USDT (Gate), BTCUSDT (Bitget),
//     XBTUSDTM (KuCoin, which calls Bitcoin XBT), BTC-USDT-SWAP (OKX).
//     All are reduced to a base asset so coins line up across venues.
//   * Open interest is quoted in different units per venue (contracts,
//     base coins, USD), so each is converted to USD with that venue's
//     multiplier and mark price. OKX publishes oiUsd directly.
//   * A venue failing must never kill the run: each source is fetched
//     independently and a dead venue is reported, not thrown.
//
// Pay per event
// -------------
//   funding_row per coin (compare mode) or per venue contract (screen and
//   watchlist). Empty results are free note rows. First 2 chargeable rows
//   per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 45000;
const HOURS_PER_YEAR = 24 * 365;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'compare', coins = [], exchanges = ['okx', 'gate', 'bitget', 'kucoin'],
    sortBy = 'spread', minOpenInterestUsd = 1000000, maxRows = 200,
} = input;

const clean = (v) => String(v ?? '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => clean(s).toUpperCase()).filter(Boolean);
const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const round = (n, dp) => (n === null || n === undefined ? null : Math.round(n * 10 ** dp) / 10 ** dp);

const VENUES = ['okx', 'gate', 'bitget', 'kucoin'];
const runMode = ['compare', 'screen', 'symbols'].includes(String(mode)) ? String(mode) : 'compare';
const wanted = new Set(asList(exchanges).map((s) => s.toLowerCase()).filter((s) => VENUES.includes(s)));
if (wanted.size === 0) VENUES.forEach((v) => wanted.add(v));
const coinSet = new Set(asList(coins).map((c) => (c === 'XBT' ? 'BTC' : c)));
const oiFloor = Math.max(0, Number(minOpenInterestUsd) || 0);
const rowCap = clampNum(maxRows, 200, 1, 50000);

if (runMode === 'symbols' && coinSet.size === 0) {
    log.warning('Add at least one coin, for example BTC or SOL, or switch to compare or screen mode.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { accept: 'application/json', 'User-Agent': 'Scrapemint funding rates actor (admin@scrapemint.com)' },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            return { json: await res.json() };
        } catch (err) {
            if (attempt === 3) return { error: err?.message || 'unreachable' };
            await new Promise((r) => setTimeout(r, attempt * 2500));
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// KuCoin denominates Bitcoin as XBT; everything else is stripped of its
// quote-currency suffix to leave the base asset.
const baseAsset = (raw) => {
    const s = clean(raw).toUpperCase();
    let b = s;
    if (s.includes('_')) b = s.split('_')[0];
    else if (s.includes('-')) b = s.split('-')[0];
    else b = s.replace(/USDTM$|USDM$|USDT$|USDC$|USD$/, '');
    return b === 'XBT' ? 'BTC' : b;
};

const contract = (exchange, symbol, rate, intervalHours, oiUsd, markPrice, nextFunding) => {
    const asset = baseAsset(symbol);
    if (!asset) return null;
    const r = num(rate);
    const iv = num(intervalHours);
    return {
        exchange,
        symbol: clean(symbol),
        asset,
        fundingRatePercent: r === null ? null : round(r * 100, 6),
        annualizedPercent: r === null || !iv ? null : round(r * (HOURS_PER_YEAR / iv) * 100, 2),
        fundingIntervalHours: iv || null,
        openInterestUsd: oiUsd === null ? null : Math.round(oiUsd),
        markPrice: round(num(markPrice), 6),
        nextFundingTime: nextFunding ? new Date(Number(nextFunding)).toISOString() : null,
    };
};

// ---------- venue readers: each returns {rows} or {error} ----------

async function readOkx() {
    const [f, oi, tk] = await Promise.all([
        getJson('https://www.okx.com/api/v5/public/funding-rate?instId=ANY'),
        getJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP'),
        getJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP'),
    ]);
    if (f.error) return { error: f.error };
    const oiBy = new Map(((oi.json || {}).data || []).map((x) => [x.instId, x]));
    const pxBy = new Map(((tk.json || {}).data || []).map((x) => [x.instId, x.last]));
    const rows = [];
    for (const x of (f.json || {}).data || []) {
        const id = x.instId;
        if (!id || !id.endsWith('-SWAP')) continue;
        // Interval comes from the gap between this funding and the next.
        const iv = x.nextFundingTime && x.fundingTime
            ? Math.round((Number(x.nextFundingTime) - Number(x.fundingTime)) / 3600000) || 8
            : 8;
        const o = oiBy.get(id);
        rows.push(contract('okx', id, x.fundingRate, iv, o ? num(o.oiUsd) : null, pxBy.get(id), x.nextFundingTime || x.fundingTime));
    }
    return { rows: rows.filter(Boolean) };
}

async function readGate() {
    const [t, c] = await Promise.all([
        getJson('https://api.gateio.ws/api/v4/futures/usdt/tickers'),
        getJson('https://api.gateio.ws/api/v4/futures/usdt/contracts'),
    ]);
    if (t.error) return { error: t.error };
    const meta = new Map((Array.isArray(c.json) ? c.json : []).map((x) => [x.name, x]));
    const rows = [];
    for (const x of Array.isArray(t.json) ? t.json : []) {
        const m = meta.get(x.contract) || {};
        const iv = m.funding_interval ? Number(m.funding_interval) / 3600 : 8;
        const mult = num(m.quanto_multiplier) ?? num(x.quanto_multiplier);
        const mark = num(x.mark_price);
        // total_size is in contracts; multiplier converts to base coins.
        const oiUsd = mult && mark && num(x.total_size) !== null ? num(x.total_size) * mult * mark : null;
        rows.push(contract('gate', x.contract, x.funding_rate, iv, oiUsd, mark, m.funding_next_apply ? Number(m.funding_next_apply) * 1000 : null));
    }
    return { rows: rows.filter(Boolean) };
}

async function readBitget() {
    const [t, c] = await Promise.all([
        getJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES'),
        getJson('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES'),
    ]);
    if (t.error) return { error: t.error };
    const meta = new Map(((c.json || {}).data || []).map((x) => [x.symbol, x]));
    const rows = [];
    for (const x of (t.json || {}).data || []) {
        const m = meta.get(x.symbol) || {};
        const iv = m.fundInterval ? Number(m.fundInterval) : 8;
        const px = num(x.lastPr);
        // holdingAmount is open interest in base coins.
        const oiUsd = px && num(x.holdingAmount) !== null ? num(x.holdingAmount) * px : null;
        rows.push(contract('bitget', x.symbol, x.fundingRate, iv, oiUsd, px, x.nextFundingTime));
    }
    return { rows: rows.filter(Boolean) };
}

async function readKucoin() {
    const r = await getJson('https://api-futures.kucoin.com/api/v1/contracts/active');
    if (r.error) return { error: r.error };
    const rows = [];
    for (const x of (r.json || {}).data || []) {
        const iv = x.fundingRateGranularity ? Number(x.fundingRateGranularity) / 3600000 : 8;
        const mark = num(x.markPrice);
        const mult = num(x.multiplier);
        const oi = num(x.openInterest);
        // Coin-margined (inverse) contracts are worth $1 each and carry a
        // multiplier of -1, so their open interest is ALREADY in USD.
        // Multiplying by mark price inflated BTC to $7.5 trillion.
        let oiUsd = null;
        if (oi !== null) {
            if (x.isInverse === true) oiUsd = oi;
            else if (mark && mult) oiUsd = oi * mult * mark;
        }
        rows.push(contract('kucoin', x.symbol, x.fundingFeeRate, iv, oiUsd, mark, x.nextFundingRateDateTime));
    }
    return { rows: rows.filter(Boolean) };
}

const READERS = { okx: readOkx, gate: readGate, bitget: readBitget, kucoin: readKucoin };

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'funding_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- run ---------------------------------------------------------------------------

const venueList = VENUES.filter((v) => wanted.has(v));
log.info(`Funding rates, ${runMode} mode, venues: ${venueList.join(', ')}${coinSet.size ? `, coins: ${[...coinSet].join(', ')}` : ''}...`);

const results = await Promise.all(venueList.map(async (v) => ({ v, ...(await READERS[v]()) })));
const all = [];
const failedVenues = [];
for (const r of results) {
    if (r.error || !r.rows) { failedVenues.push(`${r.v} (${r.error || 'no data'})`); continue; }
    all.push(...r.rows);
    log.info(`  ${r.v}: ${r.rows.length} contracts`);
}
if (failedVenues.length) log.warning(`venue(s) unavailable: ${failedVenues.join(', ')}`);

let pool = all.filter((r) => r.fundingRatePercent !== null);
if (coinSet.size) pool = pool.filter((r) => coinSet.has(r.asset));
if (oiFloor > 0) pool = pool.filter((r) => (r.openInterestUsd ?? 0) >= oiFloor);

if (pool.length === 0) {
    const reasons = [];
    if (coinSet.size) reasons.push(`those coins are not listed on ${venueList.join('/')}`);
    if (oiFloor > 0) reasons.push(`the $${oiFloor.toLocaleString()} open interest floor filtered everything out`);
    const fix = coinSet.size ? 'Check the coin symbols, or lower the floor.' : 'Lower the open interest floor.';
    const why = failedVenues.length === venueList.length
        ? `every selected venue was unreachable (${failedVenues.join(', ')}); not charged, try again later`
        : `nothing matched${reasons.length ? `: ${reasons.join(', or ')}` : ''}. ${fix} Not charged.`;
    await flushRow({ type: 'note', input: [...coinSet].join(', ') || venueList.join(', '), found: false, note: why }, false);
    await Actor.exit();
}

if (runMode === 'compare') {
    // One row per coin, with each venue's funding side by side. The spread
    // is the point: same asset, different cost to hold, per venue.
    const byAsset = new Map();
    for (const r of pool) {
        if (!byAsset.has(r.asset)) byAsset.set(r.asset, []);
        byAsset.get(r.asset).push(r);
    }
    const rows = [];
    for (const [asset, list] of byAsset) {
        const rated = list.filter((x) => x.annualizedPercent !== null);
        if (rated.length < 2) continue;
        const sorted = [...rated].sort((a, b) => b.annualizedPercent - a.annualizedPercent);
        const hi = sorted[0];
        const lo = sorted[sorted.length - 1];
        rows.push({
            asset,
            // A venue can list several contracts for one coin (USDT margined
            // and coin margined), so these are deliberately separate counts.
            contractCount: rated.length,
            venueCount: new Set(rated.map((x) => x.exchange)).size,
            spreadAnnualizedPercent: round(hi.annualizedPercent - lo.annualizedPercent, 2),
            highestVenue: hi.exchange,
            highestAnnualizedPercent: hi.annualizedPercent,
            lowestVenue: lo.exchange,
            lowestAnnualizedPercent: lo.annualizedPercent,
            totalOpenInterestUsd: Math.round(rated.reduce((s, x) => s + (x.openInterestUsd || 0), 0)),
            venues: sorted.map((x) => ({
                exchange: x.exchange,
                symbol: x.symbol,
                fundingRatePercent: x.fundingRatePercent,
                annualizedPercent: x.annualizedPercent,
                fundingIntervalHours: x.fundingIntervalHours,
                openInterestUsd: x.openInterestUsd,
                markPrice: x.markPrice,
            })),
        });
    }
    const key = { open_interest: (x) => x.totalOpenInterestUsd, funding_high: (x) => x.highestAnnualizedPercent, funding_low: (x) => -x.lowestAnnualizedPercent }[sortBy] || ((x) => x.spreadAnnualizedPercent);
    rows.sort((a, b) => key(b) - key(a));
    if (rows.length === 0) {
        await flushRow({ type: 'note', input: [...coinSet].join(', ') || 'all coins', found: false, note: 'no coin was listed on two or more of the selected venues, so there is nothing to compare. Add venues, lower the open interest floor, or use screen mode. Not charged.' }, false);
    } else {
        for (const r of rows.slice(0, rowCap)) {
            if (pastDeadline()) break;
            await flushRow(r, true);
        }
    }
} else {
    const key = { open_interest: (x) => x.openInterestUsd ?? 0, funding_low: (x) => -(x.annualizedPercent ?? 0) }[sortBy] || ((x) => x.annualizedPercent ?? 0);
    pool.sort((a, b) => key(b) - key(a));
    for (const r of pool.slice(0, rowCap)) {
        if (pastDeadline()) break;
        await flushRow(r, true);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
