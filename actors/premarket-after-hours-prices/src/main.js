// Premarket & After-Hours Stock Prices: Gaps Before the Open
//
// What it does
// ------------
// The regular session is only half the trading day. Earnings land after the
// close and news lands before the open, so by 09:30 the move has already
// happened. This reads the extended sessions: what a stock is trading at
// before the bell, how far it has gapped from yesterday's close, how much
// volume is behind that gap, and the high and low of the session so far.
//
//   scan       one row per stock in a universe you define, ranked by the size
//              of the gap: the morning gapper list
//   watchlist  one row per symbol you name, for the sessions you pick
//
// Distinct from our stock-market-movers, which reads the REGULAR session
// screener and cannot see either extended session.
//
// The honest limit
// ----------------
// The source publishes extended-session prices per symbol, and has no market
// wide premarket list to read. So a scan checks the universe you define,
// filtered by price, volume, market cap and sector, and ranked by regular
// session volume. Widening the universe finds more small caps and costs more
// requests. This is stated in the README rather than dressed up as a full
// market scan.
//
// Pay per event
// -------------
//   quote_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Symbols with no extended-session trading are skipped and never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const FETCH_TIMEOUT_MS = 30000;
const CONCURRENCY = 3;
const SPACING_MS = 250;
const NASDAQ = 'https://api.nasdaq.com/api';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'scan',
    session = 'auto',
    symbols = [],
    minPrice = 1,
    maxPrice = 50,
    minVolume = 1000000,
    minMarketCap = 0,
    sectors = [],
    universeSize = 40,
    minGapPercent = 0,
    minSessionVolume = 0,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Formatted strings arrive everywhere on this API. An empty field is a
// MISSING value, not a zero: Number('') is 0, which would report a stock that
// has not traded as unchanged.
const toNum = (v) => {
    const s = String(v ?? '').replace(/[$,%+\s]/g, '');
    if (!s || s === '-' || /^(N\/A|UNCH)$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

const theMode = ['scan', 'watchlist'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'scan';
const wantSymbols = asList(symbols).map((s) => s.toUpperCase());
const wantSectors = asList(sectors).map((s) => s.toLowerCase());
const universeCap = Math.max(1, Math.min(HARD_CAP, Number(universeSize) || 40));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const gapFloor = Math.max(0, Number(minGapPercent) || 0);
const sessionVolFloor = Math.max(0, Number(minSessionVolume) || 0);

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                // Without a browser User-Agent this API answers 403.
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                accept: 'application/json',
            },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        const text = await res.text();
        // Rapid requests draw an HTML block page carrying a 200 status, and
        // responses intermittently carry a UTF-8 BOM that breaks JSON.parse.
        if (text.trimStart().startsWith('<')) {
            if (attempt < 2) { await sleep(1200 * (attempt + 1)); return getJson(url, attempt + 1); }
            log.warning('blocked by an HTML page after retries');
            return null;
        }
        return JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
        if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 110)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'quote_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Which extended session to read. Auto follows the exchange clock: before the
// opening bell the premarket is the live one, after the close it is the
// after-hours session, and during regular hours the premarket that just
// finished is the most recent complete one.
function resolveSessions(marketInfo) {
    const want = String(session || 'auto').toLowerCase();
    if (['pre', 'premarket'].includes(want)) return ['pre'];
    if (['post', 'after', 'afterhours', 'after-hours'].includes(want)) return ['post'];
    if (want === 'both') return ['pre', 'post'];
    const nowEt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const hhmm = nowEt.split(', ')[1] || '12:00:00';
    const [hh, mm] = hhmm.split(':').map(Number);
    const minutes = hh * 60 + mm;
    if (minutes >= 16 * 60) return ['post'];
    if (marketInfo?.mrktStatus && minutes < 9 * 60 + 30) return ['pre'];
    return ['pre'];
}

function sessionIsLive(kind, marketInfo) {
    if (!marketInfo) return null;
    const now = Date.now();
    const parse = (s) => {
        const t = Date.parse(String(s || '').replace(' ET', '') + 'Z');
        return Number.isFinite(t) ? t : null;
    };
    // The raw fields carry no offset, so the window is compared in Eastern
    // wall-clock terms rather than assumed to be UTC.
    const nowEt = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T');
    const nowKey = Date.parse(`${nowEt}Z`);
    const open = parse(kind === 'pre' ? marketInfo.pmOpenRaw : marketInfo.closeRaw);
    const close = parse(kind === 'pre' ? marketInfo.openRaw : marketInfo.ahCloseRaw);
    if (!open || !close || !Number.isFinite(nowKey) || !now) return null;
    return nowKey >= open && nowKey < close;
}

// "$194.72 -1.79 (-0.91%)" -> price, change, percent. The change sign is the
// only thing that says which way the gap went, so a row without it keeps a
// null percent rather than a zero.
function parseConsolidated(text) {
    const s = String(text ?? '').trim();
    if (!s) return {};
    const m = s.match(/\$?(-?[\d,]+(?:\.\d+)?)\s*([+-][\d,]+(?:\.\d+)?)?\s*(?:\(([+-]?[\d.]+)%\))?/);
    if (!m) return {};
    return { price: toNum(m[1]), change: toNum(m[2]), percent: toNum(m[3]) };
}

// "$196.51 (08:04:17 AM)" -> price and the time it printed.
function parsePriceAndTime(text) {
    const s = String(text ?? '').trim();
    if (!s) return {};
    const price = toNum((s.match(/\$?(-?[\d,]+(?:\.\d+)?)/) || [])[1]);
    const time = (s.match(/\(([^)]+)\)/) || [])[1] || null;
    return { price, time: clean(time) };
}

async function fetchExtended(symbol, kind, assetClass = 'stocks') {
    const url = `${NASDAQ}/quote/${encodeURIComponent(symbol)}/extended-trading?assetclass=${assetClass}&markettype=${kind}&time=1`;
    const json = await getJson(url);
    if (!json) return null;
    const rCode = json?.status?.rCode;
    const data = json?.data;
    // Exchange traded products answer "Symbol not exists" under the stocks
    // asset class and only resolve under etf.
    if ((rCode && rCode !== 200) || !data) {
        if (assetClass === 'stocks') { await sleep(SPACING_MS); return fetchExtended(symbol, kind, 'etf'); }
        return null;
    }
    const row = (data.infoTable?.rows || [])[0];
    // "Data last updated Jul 27, 2026 08:00 PM ET." -> which session this is.
    const sessionDate = clean((String((data.lastUpdateInfo || [])[0] || '')
        .match(/updated\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/) || [])[1]);
    // A quiet symbol returns a valid response with no rows: it simply did not
    // trade in that session. Not an error, and not charged.
    if (!row) return { empty: true, assetClass, sessionDate, dataAsOf: clean((data.lastUpdateInfo || [])[0]) };
    const c = parseConsolidated(row.consolidated);
    const hi = parsePriceAndTime(row.highPrice);
    const lo = parsePriceAndTime(row.lowPrice);
    const previousClose = toNum(String(data.previousInfo || '').split(':').pop())
        ?? (c.price != null && c.change != null ? round(c.price - c.change, 4) : null);
    return {
        assetClass,
        sessionDate,
        lastPrice: c.price ?? null,
        change: c.change ?? null,
        percentChange: c.percent ?? null,
        previousClose,
        // Premarket carries its own change; after-hours does not (see below).
        changeSource: c.change != null ? 'source' : null,
        sessionVolume: toNum(row.volume),
        sessionHigh: hi.price ?? null,
        sessionHighTime: hi.time ?? null,
        sessionLow: lo.price ?? null,
        sessionLowTime: lo.time ?? null,
        sessionRangePercent: hi.price != null && lo.price ? round(((hi.price - lo.price) / lo.price) * 100, 2) : null,
        direction: c.percent == null ? null : (c.percent > 0 ? 'up' : (c.percent < 0 ? 'down' : 'flat')),
        dataAsOf: clean((data.lastUpdateInfo || [])[0]),
    };
}

// The after-hours payload publishes a bare price: no change, no percent, no
// previous close, and delta "N/A". So the gap is computed here against that
// day's regular session close, and ONLY when the two belong to the same
// trading day. Read mid session, the after-hours block still holds YESTERDAY
// evening's prices, and measuring those against today's moving price would
// invent a gap, so it is left null with the reason stated on the row.
function todayEastern() {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date());
}
function applyAfterHoursGap(ext, regularClose) {
    if (ext.percentChange != null || ext.lastPrice == null) return ext;
    const sameDay = ext.sessionDate && todayEastern().replace(/\s+/g, ' ') === ext.sessionDate.replace(/\s+/g, ' ');
    if (!sameDay || regularClose == null || !regularClose) {
        ext.gapUnavailableReason = 'the source publishes no change for the after-hours session, and the regular session close it should be measured against is not from the same trading day';
        return ext;
    }
    ext.previousClose = regularClose;
    ext.change = round(ext.lastPrice - regularClose, 4);
    ext.percentChange = round(((ext.lastPrice - regularClose) / regularClose) * 100, 2);
    ext.direction = ext.percentChange > 0 ? 'up' : (ext.percentChange < 0 ? 'down' : 'flat');
    ext.changeSource = 'computed_vs_regular_close';
    return ext;
}

const marketInfo = (await getJson(`${NASDAQ}/market-info`))?.data ?? null;
const sessions = resolveSessions(marketInfo);
log.info(`Extended session ${theMode} | session(s) ${sessions.join(', ')} | market ${marketInfo?.mrktStatus ?? 'unknown'}`);

// One screener call returns the whole market, and doubles as the name, sector
// and market cap lookup for both modes.
const screener = await getJson(`${NASDAQ}/screener/stocks?download=true`);
const universeRows = screener?.data?.rows || [];
if (!universeRows.length) log.warning('market universe unavailable; rows will carry no company details');
const universe = new Map();
for (const r of universeRows) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (sym) {
        universe.set(sym, {
            companyName: clean(r.name),
            sector: clean(r.sector),
            industry: clean(r.industry),
            marketCap: toNum(r.marketCap),
            regularSessionLast: toNum(r.lastsale),
            regularSessionVolume: toNum(r.volume),
            regularSessionPercentChange: toNum(r.pctchange),
        });
    }
}
log.info(`Market universe: ${universe.size} symbol(s)`);

let targets = [];
if (theMode === 'watchlist') {
    if (!wantSymbols.length) {
        await flushRow({ type: 'note', found: false, note: 'watchlist mode needs at least one symbol; add symbols or switch to scan mode; not charged' }, false);
        log.error('no symbols supplied');
        await Actor.exit();
    }
    targets = wantSymbols;
} else {
    const lo = Number(minPrice) || 0;
    const hi = Number(maxPrice) || 0;
    const volFloor = Number(minVolume) || 0;
    const capFloor = Number(minMarketCap) || 0;
    const filtered = [...universe.entries()].filter(([, u]) => {
        if (u.regularSessionLast == null) return false;
        if (lo && u.regularSessionLast < lo) return false;
        if (hi && u.regularSessionLast > hi) return false;
        if (volFloor && (u.regularSessionVolume ?? 0) < volFloor) return false;
        if (capFloor && (u.marketCap ?? 0) < capFloor) return false;
        if (wantSectors.length && !wantSectors.some((s) => String(u.sector || '').toLowerCase().includes(s))) return false;
        return true;
    });
    // Ranked by regular session volume: the names with attention on them are
    // the ones that gap on news.
    filtered.sort((a, b) => (b[1].regularSessionVolume ?? 0) - (a[1].regularSessionVolume ?? 0));
    targets = filtered.slice(0, universeCap).map(([sym]) => sym);
    log.info(`Universe filter kept ${filtered.length} symbol(s), checking the ${targets.length} most active`);
    if (!filtered.length) {
        await flushRow({ type: 'note', found: false, universeSize: universe.size, note: 'no stocks matched the universe filters; widen minPrice, maxPrice, minVolume or minMarketCap; not charged' }, false);
        log.error('empty universe');
        await Actor.exit();
    }
}

const jobs = [];
for (const sym of targets) for (const kind of sessions) jobs.push({ sym, kind });

const collected = [];
let noTrade = 0;
let unknown = 0;
let cursor = 0;
const worker = async () => {
    while (cursor < jobs.length) {
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached; returning what was collected'); return; }
        const job = jobs[cursor];
        cursor += 1;
        const ext = await fetchExtended(job.sym, job.kind);
        await sleep(SPACING_MS);
        if (!ext) { unknown += 1; continue; }
        if (ext.empty) { noTrade += 1; continue; }
        const u = universe.get(job.sym) || {};
        if (job.kind === 'post') applyAfterHoursGap(ext, u.regularSessionLast ?? null);
        collected.push({
            mode: theMode,
            symbol: job.sym,
            companyName: u.companyName ?? null,
            session: job.kind === 'pre' ? 'premarket' : 'after_hours',
            isLiveSession: sessionIsLive(job.kind, marketInfo),
            marketStatus: clean(marketInfo?.mrktStatus),
            tradeDate: clean(job.kind === 'pre' ? marketInfo?.preMarketOpeningTime : marketInfo?.afterHoursMarketOpeningTime),
            ...ext,
            sector: u.sector ?? null,
            industry: u.industry ?? null,
            marketCap: u.marketCap ?? null,
            regularSessionLast: u.regularSessionLast ?? null,
            regularSessionVolume: u.regularSessionVolume ?? null,
            regularSessionPercentChange: u.regularSessionPercentChange ?? null,
            scrapedAt: new Date().toISOString(),
        });
    }
};
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
log.info(`Checked ${cursor} symbol-session pair(s): ${collected.length} traded, ${noTrade} did not trade, ${unknown} unavailable`);

const rows = collected.filter((r) => {
    if (gapFloor && (r.percentChange == null || Math.abs(r.percentChange) < gapFloor)) return false;
    if (sessionVolFloor && (r.sessionVolume ?? 0) < sessionVolFloor) return false;
    return true;
});
// Biggest gap first, in either direction: the point of the list.
rows.sort((a, b) => Math.abs(b.percentChange ?? 0) - Math.abs(a.percentChange ?? 0));

let emitted = 0;
for (const row of rows.slice(0, rowCap)) {
    await flushRow(row);
    emitted += 1;
}

if (!emitted) {
    let note = 'no symbols traded in the extended session; before 04:00 or after 20:00 Eastern there is nothing to report, and a weekend or holiday returns nothing at all; not charged';
    if (collected.length) note = 'every symbol that traded was removed by the filters; lower minGapPercent or minSessionVolume; not charged';
    else if (unknown && !noTrade) note = 'no symbol returned data; check the symbols are US listed; not charged';
    await flushRow({
        type: 'note', found: false, checked: cursor, traded: collected.length,
        didNotTrade: noTrade, marketStatus: clean(marketInfo?.mrktStatus), note,
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
