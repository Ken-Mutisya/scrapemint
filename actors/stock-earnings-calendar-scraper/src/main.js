// Stock Earnings Calendar Scraper
// Pulls the forward-looking market calendar from Nasdaq's keyless public JSON
// API and pushes one clean row per event. No browser, no proxy.
//
// Endpoints (all keyless JSON, require a normal User-Agent):
//   /api/calendar/earnings?date=YYYY-MM-DD   -> companies reporting, EPS estimates
//   /api/calendar/dividends?date=YYYY-MM-DD   -> ex-div / record / payment dates
//   /api/calendar/splits?date=YYYY-MM-DD      -> splits from that date forward (see note)
//   /api/ipo/calendar?date=YYYY-MM            -> priced + upcoming IPOs (monthly)
//
// Free tier: first 15 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 15;
const NASDAQ = 'https://api.nasdaq.com/api';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
};
const POLITE_SLEEP_MS = 150;
const MAX_RANGE_DAYS = 31;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom,
    dateTo,
    tickers = [],
    includeEarnings = true,
    includeDividends = true,
    includeIPOs = true,
    includeSplits = true,
    maxRows = 1000,
    dedupe = true,
} = input;

const today = new Date();
const start = parseDate(dateFrom) || atMidnight(today);
let end = parseDate(dateTo) || addDays(start, 7);
if (end < start) end = addDays(start, 7);
if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    end = addDays(start, MAX_RANGE_DAYS);
    log.warning(`Range capped at ${MAX_RANGE_DAYS} days (ends ${fmt(end)}).`);
}

const tickerSet = new Set(
    (Array.isArray(tickers) ? tickers : [])
        .map((t) => String(t).trim().toUpperCase())
        .filter(Boolean),
);

// Wall-clock budget: exit cleanly before the platform hard-kills the run.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

let pushed = 0;
const seen = new Set();
const emittedTypes = new Set();

log.info(`Calendar ${fmt(start)} -> ${fmt(end)} | earnings=${includeEarnings} dividends=${includeDividends} ipos=${includeIPOs} splits=${includeSplits}${tickerSet.size ? ` | watchlist=${[...tickerSet].join(',')}` : ''}`);

// ---- per-day endpoints: earnings + dividends ----
for (const day of eachDay(start, end)) {
    if (done()) break;
    const ds = fmt(day);

    if (includeEarnings) {
        const rows = (await fetchJson(`${NASDAQ}/calendar/earnings?date=${ds}`))?.data?.rows || [];
        for (const r of rows) {
            if (done()) break;
            await pushRow({
                eventType: 'earnings',
                symbol: r.symbol,
                companyName: r.name,
                date: ds,
                reportTime: cleanTime(r.time),
                epsForecast: r.epsForecast || null,
                numAnalystEstimates: toNum(r.noOfEsts),
                lastYearEps: r.lastYearEPS || null,
                lastYearReportDate: r.lastYearRptDt || null,
                fiscalQuarterEnding: r.fiscalQuarterEnding || null,
                marketCap: r.marketCap || null,
            });
        }
    }

    if (includeDividends && !done()) {
        const dd = (await fetchJson(`${NASDAQ}/calendar/dividends?date=${ds}`))?.data;
        const rows = dd?.calendar?.rows || dd?.rows || [];
        for (const r of rows) {
            if (done()) break;
            await pushRow({
                eventType: 'dividend',
                symbol: r.symbol,
                companyName: r.companyName,
                date: usDate(r.dividend_Ex_Date) || ds,
                exDividendDate: usDate(r.dividend_Ex_Date),
                recordDate: usDate(r.record_Date),
                paymentDate: usDate(r.payment_Date),
                announcementDate: usDate(r.announcement_Date),
                dividendRate: r.dividend_Rate ?? null,
                indicatedAnnualDividend: r.indicated_Annual_Dividend ?? null,
            });
        }
    }

    await sleep(POLITE_SLEEP_MS);
}

// ---- splits ----
// `date` sets the START of the window and the response runs from there to the
// furthest scheduled split; it is NOT a single-day filter, and `asOf` in the
// payload always reports today whatever you ask for, so it cannot be used to
// tell which window came back. Calling this endpoint bare, as it was until
// 2026-08-10, returns only today forward, so any range starting in the past was
// filtered down to nothing: a June range finished SUCCEEDED with zero split
// rows while the API held 227 for that window.
if (includeSplits && !done()) {
    const rows = (await fetchJson(`${NASDAQ}/calendar/splits?date=${fmt(start)}`))?.data?.rows || [];
    for (const r of rows) {
        if (done()) break;
        const d = parseUsDate(r.executionDate);
        if (!d || d < start || d > end) continue;
        const split = parseSplitRatio(r.ratio);
        await pushRow({
            // A ratio like "5%" is a stock dividend, not a split, and it used to
            // be emitted as eventType "split" with an unparseable ratio.
            eventType: split.kind === 'stockDividend' ? 'stockDividend' : 'split',
            symbol: r.symbol,
            companyName: r.name,
            date: fmt(d),
            ratio: r.ratio || null,
            splitFrom: split.from,
            splitTo: split.to,
            // The distress signal: a reverse split concentrates shares to lift
            // the price, most often to cure a listing rule breach.
            reverseSplit: split.reverse,
            executionDate: usDate(r.executionDate),
        });
    }
}

// ---- IPOs: monthly endpoint, priced + upcoming, filter to range ----
if (includeIPOs && !done()) {
    for (const month of eachMonth(start, end)) {
        if (done()) break;
        const data = (await fetchJson(`${NASDAQ}/ipo/calendar?date=${month}`))?.data || {};
        const priced = data?.priced?.rows || [];
        const upcoming = data?.upcoming?.upcomingTable?.rows || [];
        for (const r of priced) {
            if (done()) break;
            const d = parseUsDate(r.pricedDate);
            if (d && (d < start || d > end)) continue;
            await pushRow({
                eventType: 'ipo',
                symbol: r.proposedTickerSymbol,
                companyName: r.companyName,
                date: usDate(r.pricedDate),
                ipoStatus: 'priced',
                exchange: r.proposedExchange || null,
                sharePrice: r.proposedSharePrice || null,
                sharesOffered: r.sharesOffered || null,
                dealValue: r.dollarValueOfSharesOffered || null,
            });
        }
        for (const r of upcoming) {
            if (done()) break;
            const d = parseUsDate(r.expectedPriceDate);
            if (d && (d < start || d > end)) continue;
            await pushRow({
                eventType: 'ipo',
                symbol: r.proposedTickerSymbol,
                companyName: r.companyName,
                date: usDate(r.expectedPriceDate),
                ipoStatus: 'upcoming',
                exchange: r.proposedExchange || null,
                sharePrice: r.proposedSharePrice || null,
                sharesOffered: r.sharesOffered || null,
                dealValue: r.dollarValueOfSharesOffered || null,
            });
        }
        await sleep(POLITE_SLEEP_MS);
    }
}

// Event types are fetched in a fixed order and share one row budget, so a wide
// range fills maxRows on earnings alone and the later sections never run. That
// used to be silent: switching includeSplits on and getting no splits back
// looked like "no splits scheduled" rather than "the budget ran out first".
// The note is pushed directly rather than through pushRow, so it is free and
// skips the ticker filter.
if (pushed >= maxRows) {
    const missing = [
        includeEarnings && !emittedTypes.has('earnings') && 'earnings',
        includeDividends && !emittedTypes.has('dividend') && 'dividends',
        includeSplits && !emittedTypes.has('split') && !emittedTypes.has('stockDividend') && 'splits',
        includeIPOs && !emittedTypes.has('ipo') && 'IPOs',
    ].filter(Boolean);
    if (missing.length) {
        await Actor.pushData({
            eventType: 'note',
            note: `Stopped at the ${maxRows} row limit before reading ${missing.join(', ')}. `
                + `Raise maxRows, shorten the date range, set a tickers watchlist, or switch off the event types you do not need. Not charged.`,
        });
        log.warning(`Row limit reached before ${missing.join(', ')}.`);
    }
}

log.info(`Done. Pushed ${pushed} calendar rows.`);
await Actor.exit();

// ---------- helpers ----------

function done() {
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

async function pushRow(row) {
    if (!row.symbol) return;
    if (tickerSet.size && !tickerSet.has(String(row.symbol).toUpperCase())) return;
    if (dedupe) {
        const k = `${row.eventType}:${row.symbol}:${row.date}`;
        if (seen.has(k)) return;
        seen.add(k);
    }
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    emittedTypes.add(row.eventType);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'calendar_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 25 === 0) log.info(`Pushed ${pushed} rows...`);
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            log.warning(`HTTP ${res.status} for ${url}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`fetch failed ${url}: ${err?.message}`);
        return null;
    }
}

function cleanTime(t) {
    if (!t) return null;
    return String(t).replace(/^time-/, '').replace(/-/g, ' ') || null;
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

// Nasdaq writes a split ratio as "4 : 1" (four new shares for one old, a
// forward split) or "1 : 10" (a reverse split). It also files stock dividends
// on the same endpoint with a percentage in the ratio field, such as "5%",
// which is not a split at all. Anything unrecognised returns nulls rather than
// zeros, so a buyer can filter on reverseSplit === true instead of being told
// a 0 : 0 split is happening.
function parseSplitRatio(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return { kind: 'unknown', from: null, to: null, reverse: null };
    if (s.endsWith('%')) return { kind: 'stockDividend', from: null, to: null, reverse: false };
    const m = s.match(/^([\d.]+)\s*:\s*([\d.]+)$/);
    if (!m) return { kind: 'unknown', from: null, to: null, reverse: null };
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
        return { kind: 'unknown', from: null, to: null, reverse: null };
    }
    return { kind: 'split', from, to, reverse: from < to };
}

// US date "M/D/YYYY" -> normalized "YYYY-MM-DD" string
function usDate(s) {
    const d = parseUsDate(s);
    return d ? fmt(d) : null;
}
function parseUsDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    return Number.isNaN(d.getTime()) ? null : d;
}
function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}
function atMidnight(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d, n) {
    return new Date(d.getTime() + n * 86400000);
}
function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
}
function fmt(d) {
    return d.toISOString().slice(0, 10);
}
function* eachDay(a, b) {
    for (let d = new Date(a); d <= b; d = addDays(d, 1)) yield d;
}
function* eachMonth(a, b) {
    const seenM = new Set();
    for (let d = new Date(a); d <= b; d = addDays(d, 1)) {
        const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (!seenM.has(m)) {
            seenM.add(m);
            yield m;
        }
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
