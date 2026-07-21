// Short Selling Data Tracker (FINRA)
//
// Strategy
// --------
// FINRA publishes a consolidated daily short sale volume file covering
// every US equity: how much of the day's reported volume was sold short.
// One pipe-delimited file per trading day, keyless, about 12,150 symbols
// and 530KB:
//
//   https://cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt
//   Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
//
// Two modes:
//   symbols - a watchlist over the last N trading days, one row per
//             symbol per day, for trending short interest
//   screen  - one trading day, every symbol ranked by short volume
//             percent, with a liquidity floor
//
// Source notes / gotchas
// ----------------------
//   * A date with no session returns HTTP 403, NOT 404. Weekends,
//     holidays and today-before-publication all 403. That is "no file for
//     that date", not a block and not an outage, so it must never be
//     retried as an error or reported as a failure. Verified from the
//     Apify datacenter: a trading day returns 200 there and a Sunday
//     returns 403.
//   * The LAST line of every file is a record count ("12149"), not data.
//     Any line that does not split into 6 fields is skipped.
//   * Volumes are published as fractions, not whole shares, because they
//     are consolidated across reporting venues.
//   * A 100% short volume reading is usually a thinly traded warrant or
//     small cap where a market maker took the other side of nearly every
//     print. It is a reporting artifact, not a squeeze signal, which is
//     why screen mode applies a liquidity floor by default.
//
// Pay per event
// -------------
//   short_volume_row per symbol per day. Days with no session and empty
//   searches are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://cdn.finra.org/equity/regsho/daily/CNMSshvol';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 250;
const MAX_SCAN_DAYS = 40;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'symbols', symbols = [], days = 5, date = '',
    minTotalVolume = 2000000, minShortPercent = 0, maxRows = 200,
} = input;

const clean = (v) => String(v ?? '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => clean(s).toUpperCase()).filter(Boolean);

const runMode = String(mode) === 'screen' ? 'screen' : 'symbols';
const tickers = new Set(asList(symbols));
const lookback = clampNum(days, 5, 1, 30);
const volFloor = Math.max(0, Number(minTotalVolume) || 0);
const pctFloor = clampNum(minShortPercent, 0, 0, 100);
const rowCap = clampNum(maxRows, 200, 1, 50000);

if (runMode === 'symbols' && tickers.size === 0) {
    log.warning('Add at least one ticker symbol, or switch to screen mode to rank the whole market for one day.');
    await Actor.exit();
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const iso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

// Returns {rows} for a trading day, {absent:true} when FINRA has no file
// for that date (HTTP 403), or {error} for a genuine failure.
async function fetchDay(yyyymmdd) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`${BASE}${yyyymmdd}.txt`, {
                signal: controller.signal,
                headers: { accept: 'text/plain', 'User-Agent': 'Scrapemint FINRA short volume actor (admin@scrapemint.com)' },
            });
            // 403 is FINRA's "no file for this date". Never retry it and
            // never surface it as an error.
            if (res.status === 403 || res.status === 404) return { absent: true };
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const text = await res.text();
            await sleep(SPACING_MS);
            return { rows: parseFile(text) };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

function parseFile(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        const p = line.split('|');
        // The trailing record-count line has a single field; skip anything
        // that is not a full record.
        if (p.length !== 6) continue;
        const total = Number(p[4]);
        const short = Number(p[2]);
        if (!Number.isFinite(total) || !Number.isFinite(short)) continue;
        out.push({
            date: iso(clean(p[0])),
            symbol: clean(p[1]).toUpperCase(),
            shortVolume: Math.round(short),
            shortExemptVolume: Math.round(Number(p[3]) || 0),
            totalVolume: Math.round(total),
            shortVolumePercent: total > 0 ? Math.round((short / total) * 10000) / 100 : null,
            reportingVenues: clean(p[5]) || null,
        });
    }
    return out;
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'short_volume_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// Walk back from a start date collecting trading days, skipping the 403
// gaps that weekends and holidays leave.
async function collectDays(startDate, wanted) {
    const found = [];
    let cursor = new Date(startDate);
    let scanned = 0;
    let failure = null;
    while (found.length < wanted && scanned < MAX_SCAN_DAYS && !pastDeadline()) {
        const key = stamp(cursor);
        const { rows, absent, error } = await fetchDay(key);
        scanned += 1;
        if (error) { failure = error; break; }
        if (!absent && rows) found.push({ key, rows });
        cursor = new Date(cursor.getTime() - 86400000);
    }
    return { found, failure, scanned };
}

// --- run ---------------------------------------------------------------------------

const requested = clean(date);
let start = new Date();
if (requested) {
    const parsed = Date.parse(`${requested}T12:00:00Z`);
    if (Number.isNaN(parsed)) {
        await flushRow({ type: 'note', input: requested, found: false, note: 'date must look like 2026-07-20; not charged' }, false);
        await Actor.exit();
    }
    start = new Date(parsed);
}

const label = runMode === 'screen'
    ? `market screen${requested ? ` for ${requested}` : ''}`
    : `${[...tickers].slice(0, 8).join(', ')}${tickers.size > 8 ? ` +${tickers.size - 8} more` : ''}`;
log.info(`FINRA short volume, ${runMode} mode: ${label}${runMode === 'symbols' ? `, last ${lookback} trading day(s)` : ''}...`);

const wanted = runMode === 'screen' ? 1 : lookback;
const { found, failure, scanned } = await collectDays(start, wanted);

if (found.length === 0) {
    const note = failure
        ? `could not reach FINRA (${failure}); not charged, try again later`
        : `no FINRA short volume file found in the ${scanned} day(s) before ${requested || 'today'}. Files exist for trading days only, and the current day is published after the close. Not charged.`;
    await flushRow({ type: 'note', input: label, found: false, note }, false);
    await Actor.exit();
}

if (runMode === 'screen') {
    const day = found[0];
    const ranked = day.rows
        .filter((r) => r.totalVolume >= volFloor && (r.shortVolumePercent ?? -1) >= pctFloor)
        .sort((a, b) => (b.shortVolumePercent ?? 0) - (a.shortVolumePercent ?? 0))
        .slice(0, rowCap);
    if (ranked.length === 0) {
        await flushRow({ type: 'note', input: label, found: false, note: `no symbols on ${iso(day.key)} cleared a ${volFloor.toLocaleString()} share volume floor at ${pctFloor}%+ short; lower the floor. Not charged.` }, false);
    } else {
        for (const r of ranked) {
            if (pastDeadline()) break;
            await flushRow(r, true);
        }
        log.info(`Screened ${day.rows.length} symbols for ${iso(day.key)}; ${ranked.length} returned.`);
    }
} else {
    // Newest day first so a capped run still shows the latest reading.
    let matched = 0;
    for (const day of found) {
        if (rowsPushed >= rowCap || pastDeadline()) break;
        for (const r of day.rows) {
            if (rowsPushed >= rowCap || pastDeadline()) break;
            if (!tickers.has(r.symbol)) continue;
            matched += 1;
            await flushRow(r, true);
        }
    }
    if (matched === 0) {
        await flushRow({ type: 'note', input: label, found: false, note: `none of those symbols appear in FINRA's short volume files for the last ${found.length} trading day(s). Check the ticker spelling; the file covers US equities only. Not charged.` }, false);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
