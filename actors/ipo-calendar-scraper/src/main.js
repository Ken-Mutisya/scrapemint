// IPO Calendar Scraper
// Upcoming, priced, filed and withdrawn US IPOs from Nasdaq's keyless public
// JSON API. One row per deal per status. No browser, no proxy.
//
// Endpoint (keyless, needs a normal User-Agent):
//   /api/ipo/calendar?date=YYYY-MM      -> priced / upcoming / filed / withdrawn
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
const POLITE_SLEEP_MS = 200;
const MAX_RANGE_DAYS = 366;
const ALL_STATUSES = ['priced', 'upcoming', 'filed', 'withdrawn'];
// Cross-run memory for monitor mode. MUST be named: an unnamed key value store
// is recreated per run, so cross-run dedupe would silently never fire.
const SEEN_STORE = 'ipo-calendar-seen';
const SEEN_KEY = 'seen-keys';
const SEEN_CAP = 20000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom,
    dateTo,
    statuses = ALL_STATUSES,
    tickers = [],
    minDealValueUsd,
    newOnly = false,
    maxRows = 300,
} = input;

const today = new Date();
const start = parseDate(dateFrom) || atMidnight(today);
let end = parseDate(dateTo) || addDays(start, 30);
if (end < start) end = addDays(start, 30);
if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    end = addDays(start, MAX_RANGE_DAYS);
    log.warning(`Range capped at ${MAX_RANGE_DAYS} days (ends ${fmt(end)}).`);
}

const wanted = new Set(
    (Array.isArray(statuses) && statuses.length ? statuses : ALL_STATUSES)
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => ALL_STATUSES.includes(s)),
);
if (!wanted.size) ALL_STATUSES.forEach((s) => wanted.add(s));

const tickerSet = new Set(
    (Array.isArray(tickers) ? tickers : [])
        .map((t) => String(t).trim().toUpperCase())
        .filter(Boolean),
);
const minDeal = toNum(minDealValueUsd);

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
    `IPO calendar ${fmt(start)} -> ${fmt(end)} | statuses=${[...wanted].join(',')}`
    + `${tickerSet.size ? ` | watchlist=${[...tickerSet].join(',')}` : ''}`
    + `${minDeal !== null ? ` | minDealValueUsd=${minDeal}` : ''}`
    + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
);

for (const month of eachMonth(start, end)) {
    if (done()) break;

    const payload = await fetchJson(`${NASDAQ}/ipo/calendar?date=${month}`);
    if (blocked) break;
    const rCode = payload?.status?.rCode;
    // Nasdaq reports failures inside a 200 body, so the HTTP status alone is
    // not a success signal.
    if (rCode && rCode !== 200) {
        log.warning(`Nasdaq rCode ${rCode} for ${month}; skipping month.`);
        await sleep(POLITE_SLEEP_MS);
        continue;
    }
    const data = payload?.data || {};

    for (const status of ALL_STATUSES) {
        if (!wanted.has(status) || done()) continue;
        for (const r of bucketRows(data[status])) {
            if (done()) break;
            const dates = {
                pricedDate: usDate(r.pricedDate),
                expectedPriceDate: usDate(r.expectedPriceDate),
                filedDate: usDate(r.filedDate),
                withdrawDate: usDate(r.withdrawDate ?? r.withdrawnDate),
            };
            const primary = dates.pricedDate ?? dates.expectedPriceDate
                ?? dates.filedDate ?? dates.withdrawDate;
            // A row whose date will not parse is kept rather than dropped: the
            // monthly endpoint already scopes it, and silently losing deals is
            // worse than a slightly wide range.
            if (primary && (primary < fmt(start) || primary > fmt(end))) continue;

            await pushRow({
                ipoStatus: status,
                symbol: r.proposedTickerSymbol,
                companyName: cleanText(r.companyName),
                date: primary ?? null,
                exchange: cleanText(r.proposedExchange),
                // Absent stays null. A share price or deal size of 0 is a
                // different claim from one Nasdaq has not published yet.
                ...priceFields(r.proposedSharePrice),
                sharesOffered: toNum(r.sharesOffered),
                dealValueUsd: toNum(r.dollarValueOfSharesOffered),
                ...dates,
                dealId: cleanText(r.dealID),
            });
        }
    }

    await sleep(POLITE_SLEEP_MS);
}

if (newOnly) {
    const merged = [...seenAcrossRuns, ...seenThisRun].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} keys for the next run.`);
}

log.info(`Done. Pushed ${pushed} IPO rows.`);
await Actor.exit();

// ---------- helpers ----------

/* Nasdaq nests `upcoming` one level deeper than the other buckets, and reports
 * an empty bucket as an error object in status.bCodeMessage ("Withdrawn:No
 * record found.") rather than an empty array. Both shapes must read as "no
 * rows" instead of throwing or inventing a row. */
function bucketRows(bucket) {
    if (!bucket || typeof bucket !== 'object') return [];
    const rows = bucket.rows ?? bucket.upcomingTable?.rows ?? [];
    return Array.isArray(rows) ? rows : [];
}

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
    if (!row.symbol && !row.companyName) return;
    const sym = row.symbol ? String(row.symbol).toUpperCase() : null;
    if (tickerSet.size && !(sym && tickerSet.has(sym))) return;
    if (minDeal !== null && !(row.dealValueUsd !== null && row.dealValueUsd >= minDeal)) return;

    const key = `${row.ipoStatus}:${row.dealId ?? sym ?? row.companyName}:${row.date ?? 'na'}`;
    if (seenThisRun.has(key)) return;
    seenThisRun.add(key);
    if (newOnly && seenAcrossRuns.has(key)) return;

    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'ipo_row' })
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
            // empty months that looks like "no IPOs scheduled".
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

/* An upcoming deal is marketed as a price RANGE ("16.00-18.00") and only
 * becomes a single number once it prices. Parsing that with a plain number cast
 * yields NaN and throws the range away, which is the one figure an IPO buyer
 * most wants. Low and high are always populated; the single price stays null
 * while the deal is still a range, so nothing implies a firm price too early. */
function priceFields(raw) {
    const s = cleanText(raw);
    if (!s) return { sharePriceUsd: null, sharePriceLowUsd: null, sharePriceHighUsd: null };
    const m = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (m) {
        return { sharePriceUsd: null, sharePriceLowUsd: toNum(m[1]), sharePriceHighUsd: toNum(m[2]) };
    }
    const one = toNum(s);
    return { sharePriceUsd: one, sharePriceLowUsd: one, sharePriceHighUsd: one };
}

function cleanText(s) {
    if (s === null || s === undefined) return null;
    return String(s).replace(/\s+/g, ' ').trim() || null;
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
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
