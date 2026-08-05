// Stock Dividend Calendar Scraper
// Upcoming ex-dividend, record and payment dates from Nasdaq's keyless public
// JSON API. One row per company per ex-dividend date. No browser, no proxy.
//
// Endpoint (keyless, needs a normal User-Agent):
//   /api/calendar/dividends?date=YYYY-MM-DD
//
// Free tier: first 2 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const NASDAQ = 'https://api.nasdaq.com/api';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
};
const POLITE_SLEEP_MS = 150;
const MAX_RANGE_DAYS = 90;
// Cross-run memory for monitor mode. MUST be named: an unnamed key value store
// is recreated per run, so cross-run dedupe would silently never fire.
const SEEN_STORE = 'dividend-calendar-seen';
const SEEN_KEY = 'seen-keys';
const SEEN_CAP = 20000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom,
    dateTo,
    tickers = [],
    minDividendRate,
    newOnly = false,
    maxRows = 500,
} = input;

const today = new Date();
const start = parseDate(dateFrom) || atMidnight(today);
let end = parseDate(dateTo) || addDays(start, 30);
if (end < start) end = addDays(start, 30);
if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    end = addDays(start, MAX_RANGE_DAYS);
    log.warning(`Range capped at ${MAX_RANGE_DAYS} days (ends ${fmt(end)}).`);
}

const tickerSet = new Set(
    (Array.isArray(tickers) ? tickers : [])
        .map((t) => String(t).trim().toUpperCase())
        .filter(Boolean),
);
const minRate = toNum(minDividendRate);

// Wall-clock budget: exit cleanly before the platform hard-kills the run.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const store = newOnly ? await Actor.openKeyValueStore(SEEN_STORE) : null;
const seenAcrossRuns = new Set(newOnly ? ((await store.getValue(SEEN_KEY)) ?? []) : []);
const seenThisRun = new Set();

let pushed = 0;
let blocked = false;

log.info(
    `Dividend calendar ${fmt(start)} -> ${fmt(end)}`
    + `${tickerSet.size ? ` | watchlist=${[...tickerSet].join(',')}` : ''}`
    + `${minRate !== null ? ` | minRate=${minRate}` : ''}`
    + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
);

for (const day of eachDay(start, end)) {
    if (done()) break;
    const ds = fmt(day);

    const payload = await fetchJson(`${NASDAQ}/calendar/dividends?date=${ds}`);
    if (blocked) break;
    // Nasdaq reports failures inside a 200 body, so the HTTP status alone is
    // not a success signal.
    const rCode = payload?.status?.rCode;
    if (rCode && rCode !== 200) {
        log.warning(`Nasdaq rCode ${rCode} for ${ds}; skipping day.`);
        await sleep(POLITE_SLEEP_MS);
        continue;
    }

    const rows = payload?.data?.calendar?.rows || payload?.data?.rows || [];
    for (const r of rows) {
        if (done()) break;
        const exDate = usDate(r.dividend_Ex_Date);
        await pushRow({
            symbol: r.symbol,
            companyName: cleanName(r.companyName),
            exDividendDate: exDate,
            recordDate: usDate(r.record_Date),
            paymentDate: usDate(r.payment_Date),
            announcementDate: usDate(r.announcement_Date),
            // Absent stays null. A dividend of 0 is a different claim from a
            // dividend Nasdaq did not report.
            dividendRate: toNum(r.dividend_Rate),
            indicatedAnnualDividend: toNum(r.indicated_Annual_Dividend),
            daysUntilExDividend: daysFromToday(exDate),
        });
    }

    await sleep(POLITE_SLEEP_MS);
}

if (newOnly) {
    const merged = [...seenAcrossRuns, ...seenThisRun].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} keys for the next run.`);
}

log.info(`Done. Pushed ${pushed} dividend rows.`);
await Actor.exit();

// ---------- helpers ----------

function done() {
    if (blocked) return true;
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

async function pushRow(row) {
    if (!row.symbol) return;
    const sym = String(row.symbol).toUpperCase();
    if (tickerSet.size && !tickerSet.has(sym)) return;
    if (minRate !== null && !(row.dividendRate !== null && row.dividendRate >= minRate)) return;

    const key = `${sym}:${row.exDividendDate ?? 'na'}`;
    if (seenThisRun.has(key)) return;
    seenThisRun.add(key);
    if (newOnly && seenAcrossRuns.has(key)) return;

    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'dividend_row' })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
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
        // Strip a UTF-8 BOM before parsing: Nasdaq sometimes prefixes one and
        // JSON.parse rejects it.
        const text = (await res.text()).replace(/^﻿/, '');
        if (/^\s*</.test(text)) {
            // Rapid paging earns an HTML block page rather than an error status.
            // Stopping here keeps a partial dataset instead of a run of silent
            // empty days that looks like "no dividends scheduled".
            log.error('Nasdaq returned an HTML block page; stopping early with partial results.');
            blocked = true;
            return null;
        }
        return JSON.parse(text);
    } catch (err) {
        log.warning(`fetch failed ${url}: ${err?.message}`);
        return null;
    }
}

function cleanName(s) {
    if (!s) return null;
    return String(s).replace(/\s+/g, ' ').trim() || null;
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function daysFromToday(isoDate) {
    if (!isoDate) return null;
    const d = parseDate(isoDate);
    if (!d) return null;
    return Math.round((d.getTime() - atMidnight(new Date()).getTime()) / 86400000);
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
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
