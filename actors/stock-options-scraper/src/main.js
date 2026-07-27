// Stock Options Scraper: Unusual Activity, IV & Open Interest
//
// Strategy
// --------
// One keyless source: the Cboe delayed-quote option chain
// (cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json). One GET
// returns the entire listed chain for an underlying plus the underlying's own
// quote and its 30-day implied volatility. Three modes:
//   - unusual   contracts trading far above their existing open interest
//               (volume / OI), the daily scan options traders run first
//   - chain     the option chain filtered to what a buyer actually wants:
//               expiry, moneyness window, minimum OI/volume, calls or puts
//   - summary   one row per symbol: put/call ratios on both volume and open
//               interest, totals, iv30, and the single most active contract
//
// Quotes are delayed roughly 15 minutes. Greeks and theoretical prices are
// Cboe's own published values, not recomputed here.
//
// Source quirks handled
// ---------------------
//   - Index chains live under an underscore prefix: _SPX, _VIX, _NDX, _RUT.
//     A bare index root 403s, so "SPX" and "^SPX" are both normalised and a
//     bare symbol that 403s is retried once with the prefix.
//   - An unknown symbol returns 403, NOT 404, so a 403 means "no chain here"
//     rather than "we are blocked". Those symbols get a free note row.
//   - Deep in-the-money contracts publish iv 0.0 with delta ~1; that is the
//     source's value and is passed through untouched.
//   - Contracts with zero open interest cannot have a volume/OI ratio. They
//     are reported with a null ratio and newContract true, and qualify for
//     the unusual scan on the volume floor alone.
//
// Pay per event
// -------------
//   option_row ($0.004) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const MAX_SYMBOLS = 25;
const FETCH_TIMEOUT_MS = 60000;
const SYMBOL_SPACING_MS = 250;
const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'unusual',
    symbols = ['NVDA', 'TSLA', 'SPY'],
    optionType = 'both',
    minVolume = 500,
    minVolumeOiRatio = 5,
    minOpenInterest = 0,
    expiries = [],
    maxDaysToExpiry = 0,
    moneynessPercent = 0,
    sortBy = 'volume',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['unusual', 'chain', 'summary'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'unusual';
const symList = asList(symbols).map((s) => s.toUpperCase()).slice(0, MAX_SYMBOLS);
if (!symList.length) symList.push('SPY');
const wantType = String(optionType).toLowerCase();
const volFloor = Math.max(0, Number(minVolume) || 0);
const ratioFloor = Math.max(0, Number(minVolumeOiRatio) || 0);
const oiFloor = Math.max(0, Number(minOpenInterest) || 0);
const expiryFilter = new Set(asList(expiries));
const dteMax = Math.max(0, Number(maxDaysToExpiry) || 0);
const moneyBand = Math.max(0, Number(moneynessPercent) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// Index roots are only served under an underscore prefix.
const normalise = (s) => (s.startsWith('^') || s.startsWith('_') ? `_${s.replace(/^[\^_]+/, '')}` : s);

// OCC symbol: root + YYMMDD + C|P + strike * 1000 padded to 8. Root length
// varies (BRK.B, SPXW), so parse from the fixed-width tail backwards.
function parseContract(occ) {
    const s = String(occ || '');
    const m = s.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
    if (!m) return null;
    const [, root, ymd, t, strikeRaw] = m;
    const year = 2000 + Number(ymd.slice(0, 2));
    const month = Number(ymd.slice(2, 4));
    const day = Number(ymd.slice(4, 6));
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const expiryMs = Date.UTC(year, month - 1, day);
    return {
        root,
        expiry: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        expiryMs,
        optionType: t === 'C' ? 'call' : 'put',
        strike: Number(strikeRaw) / 1000,
    };
}

async function getChain(symbol) {
    const attempts = [normalise(symbol)];
    // A bare root that 403s may still be an index the caller typed without ^.
    if (attempts[0] === symbol) attempts.push(`_${symbol}`);
    let lastStatus = null;
    for (const candidate of attempts) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`${BASE}/${encodeURIComponent(candidate)}.json`, {
                signal: controller.signal,
                headers: { accept: 'application/json', 'User-Agent': UA },
            });
            lastStatus = res.status;
            if (res.ok) {
                const j = await res.json();
                if (j?.data?.options) return { data: j.data, status: 200 };
                lastStatus = 'empty';
                continue;
            }
        } catch (err) {
            log.warning(`${symbol}: request failed (${err?.message})`);
            lastStatus = 'error';
        } finally { clearTimeout(timer); }
    }
    return { data: null, status: lastStatus };
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'option_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Notes explain an empty result and are never charged, so they are pushed raw.
const pushNote = async (row) => { await Actor.pushData(row); };

// Expiry timestamps are UTC midnight, so compare against UTC midnight today.
// Using Date.now() here would report a contract expiring today as -1 days.
const nowDate = new Date();
const todayUtc = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
const daysTo = (ms) => (ms == null ? null : Math.round((ms - todayUtc) / 86400000));

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Cboe options ${theMode} | ${symList.join(', ')} | cap ${cap} rows`
    + (theMode === 'unusual' ? ` | volume >= ${volFloor}, volume/OI >= ${ratioFloor}` : ''));

for (const symbol of symList) {
    if (stopEarly()) break;

    const { data, status } = await getChain(symbol);
    if (!data) {
        // 403 here means the chain does not exist (unknown or non-optionable
        // symbol), not that we were blocked; Cboe uses 403 for both.
        log.warning(`${symbol}: no option chain (HTTP ${status})`);
        await pushNote({
            type: 'note', symbol, found: false,
            note: status === 403
                ? 'no option chain published for this symbol (Cboe returns 403 for unknown or non-optionable roots); not charged'
                : `could not load option chain (HTTP ${status}); not charged`,
        });
        continue;
    }

    const spot = num(data.current_price);
    const iv30 = num(data.iv30);
    const underlying = {
        symbol: data.symbol || symbol,
        underlyingPrice: spot,
        underlyingChange: num(data.price_change),
        underlyingChangePercent: round(num(data.price_change_percent), 3),
        iv30,
        iv30ChangePercent: round(num(data.iv30_change_percent), 3),
    };

    // Parse once, filter per mode.
    const all = [];
    for (const o of data.options || []) {
        const p = parseContract(o.option);
        if (!p) continue;
        const volume = num(o.volume) ?? 0;
        const oi = num(o.open_interest) ?? 0;
        all.push({ raw: o, ...p, volume, openInterest: oi });
    }

    if (theMode === 'summary') {
        let callVol = 0; let putVol = 0; let callOi = 0; let putOi = 0;
        let best = null; const expirySet = new Set(); let unusual = 0;
        for (const c of all) {
            expirySet.add(c.expiry);
            if (c.optionType === 'call') { callVol += c.volume; callOi += c.openInterest; }
            else { putVol += c.volume; putOi += c.openInterest; }
            if (!best || c.volume > best.volume) best = c;
            if (c.volume >= volFloor && (c.openInterest === 0 || c.volume / c.openInterest >= ratioFloor)) unusual += 1;
        }
        const expiryList = [...expirySet].sort();
        await flushRow({
            mode: 'summary',
            ...underlying,
            totalContracts: all.length,
            callVolume: callVol,
            putVolume: putVol,
            totalVolume: callVol + putVol,
            putCallVolumeRatio: callVol > 0 ? round(putVol / callVol, 3) : null,
            callOpenInterest: callOi,
            putOpenInterest: putOi,
            totalOpenInterest: callOi + putOi,
            putCallOiRatio: callOi > 0 ? round(putOi / callOi, 3) : null,
            expiryCount: expiryList.length,
            nearestExpiry: expiryList[0] ?? null,
            furthestExpiry: expiryList[expiryList.length - 1] ?? null,
            mostActiveContract: best?.raw?.option ?? null,
            mostActiveVolume: best?.volume ?? null,
            unusualContractCount: unusual,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
        await new Promise((r) => setTimeout(r, SYMBOL_SPACING_MS));
        continue;
    }

    const rows = [];
    for (const c of all) {
        if (wantType === 'call' || wantType === 'put') { if (c.optionType !== wantType) continue; }
        if (expiryFilter.size && !expiryFilter.has(c.expiry)) continue;
        const dte = daysTo(c.expiryMs);
        if (dteMax && (dte == null || dte > dteMax)) continue;
        if (c.openInterest < oiFloor) continue;
        if (moneyBand && spot) {
            if (Math.abs(c.strike - spot) / spot * 100 > moneyBand) continue;
        }
        const ratio = c.openInterest > 0 ? c.volume / c.openInterest : null;
        if (theMode === 'unusual') {
            if (c.volume < volFloor) continue;
            if (ratio != null && ratio < ratioFloor) continue;
        }
        const o = c.raw;
        const bid = num(o.bid); const ask = num(o.ask);
        rows.push({
            mode: theMode,
            ...underlying,
            contract: o.option,
            optionType: c.optionType,
            strike: c.strike,
            expiry: c.expiry,
            daysToExpiry: dte,
            moneyness: spot ? round(c.strike / spot, 4) : null,
            inTheMoney: spot == null ? null : (c.optionType === 'call' ? c.strike < spot : c.strike > spot),
            bid,
            ask,
            mid: bid != null && ask != null ? round((bid + ask) / 2, 4) : null,
            lastPrice: num(o.last_trade_price),
            lastTradeTime: o.last_trade_time || null,
            changePercent: round(num(o.percent_change), 3),
            volume: c.volume,
            openInterest: c.openInterest,
            volumeOiRatio: round(ratio, 3),
            newContract: c.openInterest === 0,
            impliedVolatility: round(num(o.iv), 4),
            delta: num(o.delta),
            gamma: num(o.gamma),
            theta: num(o.theta),
            vega: num(o.vega),
            rho: num(o.rho),
            theoreticalPrice: round(num(o.theo), 4),
            scrapedAt: new Date().toISOString(),
        });
    }

    const key = sortBy === 'openInterest' ? 'openInterest'
        : sortBy === 'volumeOiRatio' ? 'volumeOiRatio'
            : sortBy === 'impliedVolatility' ? 'impliedVolatility' : 'volume';
    rows.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));

    if (!rows.length) {
        await pushNote({
            type: 'note', symbol: underlying.symbol, found: false,
            note: theMode === 'unusual'
                ? `no contracts cleared volume >= ${volFloor} and volume/OI >= ${ratioFloor}; loosen the filters; not charged`
                : 'no contracts matched the chain filters; not charged',
        });
    }
    for (const row of rows) {
        if (stopEarly()) break;
        await flushRow(row);
        emitted += 1;
    }
    await new Promise((r) => setTimeout(r, SYMBOL_SPACING_MS));
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
