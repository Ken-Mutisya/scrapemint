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
// Four modes:
//   symbols  - a watchlist over the last N trading days, one row per
//              symbol per day, for trending short volume
//   screen   - one trading day, every symbol ranked by short volume
//              percent, with a liquidity floor
//   interest - a watchlist of settled SHORT INTEREST, one row per symbol
//              per settlement date, with the build/cover versus the
//              previous settlement
//   interest_screen - one settlement date, the whole market ranked by
//              short interest, days to cover or the change
//
// Short volume and short interest are different measurements and both
// belong here. Short volume is how much of a day's trading was sold
// short, published every session. Short interest is the settled open
// short position, published twice a month by FINRA. Volume says what
// happened today, interest says how big the bet actually is.
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
// Short interest source notes / gotchas
// -------------------------------------
//   * FINRA's consolidated short interest covers the WHOLE tape, NYSE,
//     Nasdaq, AMEX, ARCA, BZX and OTC. Nasdaq's own per-symbol endpoint
//     was tried first and only carries Nasdaq-listed names: JPM, XOM, F
//     and PFE all came back rCode 200 with a null body, which reads as
//     "no short interest" rather than "not covered". That silent empty
//     is why this uses FINRA instead.
//   * settlementDate is a PARTITION KEY. Sorting is rejected outright
//     unless an EQUAL compareFilter pins settlementDate, so every query
//     resolves a settlement date first and filters on it.
//   * A date with no settlement returns an EMPTY BODY, not an empty JSON
//     array, so the response has to be checked before it is parsed.
//   * daysToCoverQuantity 999.99 is a SENTINEL, not a real figure. It is
//     ~17% of rows, and most of those have zero average daily volume, so
//     it means "undefined" and is published as null with a flag. Ranking
//     by days to cover without excluding it returns nothing but garbage.
//   * The valid numeric compare types are GREATER and LESSER. Lowercase
//     "lt" fails with "Unable to parse request body".
//   * marketClassCode is not just NYSE/OTC: NNM and SC are Nasdaq tiers,
//     and ARCA, BZX and AMEX all appear. Anything not OTC is exchange
//     listed.
//
// Pay per event
// -------------
//   short_volume_row per symbol per day, and per symbol per settlement
//   date in the short interest modes. Days with no session and empty
//   searches are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://cdn.finra.org/equity/regsho/daily/CNMSshvol';
const FINRA_API = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
// FINRA publishes a settlement about eight business days after the fact,
// and settlements land twice a month, so a month of scanning always finds
// the newest one.
const MAX_SETTLEMENT_SCAN_DAYS = 40;
const SETTLEMENT_GAP_DAYS = 9;
const DTC_SENTINEL = 999.99;
const API_PAGE = 5000;
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
    settlements = 1, minAvgDailyVolume = 500000, sortBy = 'short_interest',
    includeOtc = false, minShortInterest = 100000,
} = input;

const clean = (v) => String(v ?? '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => clean(s).toUpperCase()).filter(Boolean);
// Null-safe: an absent measurement must stay null and never coerce to 0,
// because 0 short interest is a real and very different reading.
const num = (v) => (v === null || v === undefined || v === '' ? null
    : (Number.isFinite(Number(v)) ? Number(v) : null));

const MODES = new Set(['symbols', 'screen', 'interest', 'interest_screen']);
const runMode = MODES.has(String(mode)) ? String(mode) : 'symbols';
const isInterest = runMode === 'interest' || runMode === 'interest_screen';
const tickers = new Set(asList(symbols));
const lookback = clampNum(days, 5, 1, 30);
const volFloor = Math.max(0, Number(minTotalVolume) || 0);
const pctFloor = clampNum(minShortPercent, 0, 0, 100);
const rowCap = clampNum(maxRows, 200, 1, 50000);
const settlementCount = clampNum(settlements, 1, 1, 12);
const avgVolFloor = Math.max(0, Number(minAvgDailyVolume) || 0);
const siFloor = Math.max(0, Number(minShortInterest) || 0);
const SORTS = {
    short_interest: '-currentShortPositionQuantity',
    change_percent: '-changePercent',
    days_to_cover: '-daysToCoverQuantity',
};
const sortField = SORTS[String(sortBy)] || SORTS.short_interest;

if ((runMode === 'symbols' || runMode === 'interest') && tickers.size === 0) {
    log.warning('Add at least one ticker symbol, or switch to a screen mode to rank the whole market.');
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

// --- short interest (FINRA consolidated, twice a month) -----------------------------

const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Returns {rows} on success, or {error}. An empty body means "no data for
// this query", which is a normal answer here and comes back as rows: [].
async function queryFinra(body) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(FINRA_API, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    accept: 'application/json',
                    'User-Agent': 'Scrapemint FINRA short interest actor (admin@scrapemint.com)',
                },
                body: JSON.stringify(body),
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const text = (await res.text()).trim();
            if (!res.ok) return { error: `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}` };
            // No settlement for that date: FINRA answers 200 with nothing.
            if (!text) return { rows: [] };
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                // An HTML body here is an edge block page, not data.
                return { error: `non-JSON response (${text.slice(0, 80)})` };
            }
            if (!Array.isArray(parsed)) {
                return { error: parsed?.message ? `FINRA: ${parsed.message}` : 'unexpected response shape' };
            }
            await sleep(SPACING_MS);
            return { rows: parsed };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

const dateFilter = (iso) => ({ fieldName: 'settlementDate', fieldValue: iso, compareType: 'equal' });

async function isSettlementDate(iso) {
    const { rows, error } = await queryFinra({ limit: 1, compareFilters: [dateFilter(iso)] });
    if (error) return { error };
    return { hit: (rows?.length ?? 0) > 0 };
}

// Walk back from a start date to find real settlement dates. Settlements
// land twice a month, so after a hit the cursor jumps back a week and a
// bit rather than crawling day by day.
async function findSettlementDates(startDate, wanted) {
    const dates = [];
    let cursor = new Date(startDate);
    let scanned = 0;
    let failure = null;
    const budget = MAX_SETTLEMENT_SCAN_DAYS + (wanted - 1) * 20;
    while (dates.length < wanted && scanned < budget && !pastDeadline()) {
        const dow = cursor.getUTCDay();
        if (dow === 0 || dow === 6) {
            cursor = new Date(cursor.getTime() - 86400000);
            continue;
        }
        const iso = ymd(cursor);
        const { hit, error } = await isSettlementDate(iso);
        scanned += 1;
        if (error) { failure = error; break; }
        if (hit) {
            dates.push(iso);
            cursor = new Date(cursor.getTime() - SETTLEMENT_GAP_DAYS * 86400000);
            continue;
        }
        cursor = new Date(cursor.getTime() - 86400000);
    }
    return { dates, failure, scanned };
}

function mapInterestRow(r) {
    const current = num(r.currentShortPositionQuantity);
    const previous = num(r.previousShortPositionQuantity);
    const rawDtc = num(r.daysToCoverQuantity);
    // 999.99 is FINRA's "undefined", usually a name with no volume to
    // cover into. Publishing it as a number would invent a 999 day squeeze.
    const capped = rawDtc !== null && rawDtc >= DTC_SENTINEL;
    const changeShares = num(r.changePreviousNumber);
    let direction = null;
    if (changeShares !== null) direction = changeShares > 0 ? 'build' : (changeShares < 0 ? 'cover' : 'flat');
    const marketClass = clean(r.marketClassCode) || null;
    return {
        symbol: clean(r.symbolCode).toUpperCase() || null,
        issueName: clean(r.issueName) || null,
        settlementDate: clean(r.settlementDate) || null,
        marketClass,
        exchangeListed: marketClass ? marketClass !== 'OTC' : null,
        shortInterest: current,
        previousShortInterest: previous,
        changeShares,
        changePercent: num(r.changePercent),
        direction,
        averageDailyVolume: num(r.averageDailyVolumeQuantity),
        daysToCover: capped ? null : rawDtc,
        daysToCoverUndefined: capped,
        splitAdjusted: r.stockSplitFlag ? true : false,
        revised: r.revisionFlag ? true : false,
    };
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

const watchlistLabel = `${[...tickers].slice(0, 8).join(', ')}${tickers.size > 8 ? ` +${tickers.size - 8} more` : ''}`;

if (isInterest) {
    const iLabel = runMode === 'interest_screen'
        ? `short interest screen${requested ? ` for ${requested}` : ''}`
        : watchlistLabel;
    log.info(`FINRA consolidated short interest, ${runMode} mode: ${iLabel}...`);

    const wantedSettlements = runMode === 'interest_screen' ? 1 : settlementCount;
    const { dates, failure: findFail, scanned: daysScanned } = await findSettlementDates(start, wantedSettlements);

    if (dates.length === 0) {
        const note = findFail
            ? `could not reach FINRA (${findFail}); not charged, try again later`
            : `no FINRA short interest settlement found in the ${daysScanned} weekday(s) before ${requested || 'today'}. Short interest settles twice a month and is published about eight business days later. Not charged.`;
        await flushRow({ type: 'note', input: iLabel, found: false, note }, false);
        await Actor.exit();
    }

    let matched = 0;
    let reachFailure = null;

    if (runMode === 'interest_screen') {
        const settlement = dates[0];
        const filters = [dateFilter(settlement)];
        if (avgVolFloor > 0) {
            filters.push({ fieldName: 'averageDailyVolumeQuantity', fieldValue: avgVolFloor, compareType: 'GREATER' });
        }
        // Keep the 999.99 sentinel out of the ranking at the source rather
        // than filling the page with it and dropping it afterwards.
        if (sortField === SORTS.days_to_cover) {
            filters.push({ fieldName: 'daysToCoverQuantity', fieldValue: DTC_SENTINEL, compareType: 'LESSER' });
        }
        if (siFloor > 0) {
            filters.push({ fieldName: 'currentShortPositionQuantity', fieldValue: siFloor, compareType: 'GREATER' });
            // A percent change needs a real denominator. Ranking without
            // this floor puts a warrant that went from 239 shares to
            // 232,477 on top at +97,170%, which is arithmetic, not a
            // signal. The volume floor does not catch it, because the
            // problem is the size of the previous position, not liquidity.
            if (sortField === SORTS.change_percent) {
                filters.push({ fieldName: 'previousShortPositionQuantity', fieldValue: siFloor, compareType: 'GREATER' });
            }
        }
        // Exclude OTC at the source. Dropping it client side instead would
        // make a page of N rows yield fewer than N and silently under-fill
        // the run, because the offset can only advance by what was fetched.
        if (!includeOtc) {
            filters.push({ fieldName: 'marketClassCode', fieldValue: 'OTC', compareType: 'NOT_EQUAL' });
        }
        let offset = 0;
        while (rowsPushed < rowCap && !pastDeadline()) {
            const limit = Math.min(API_PAGE, rowCap - rowsPushed);
            const { rows, error } = await queryFinra({ limit, offset, sortFields: [sortField], compareFilters: filters });
            if (error) { reachFailure = error; break; }
            if (!rows.length) break;
            offset += rows.length;
            for (const raw of rows) {
                if (rowsPushed >= rowCap || pastDeadline()) break;
                const row = mapInterestRow(raw);
                // Belt and braces: if the source filter ever stops applying,
                // drop OTC here rather than publishing it.
                if (!includeOtc && row.exchangeListed === false) continue;
                matched += 1;
                await flushRow(row, true);
            }
            if (rows.length < limit) break;
        }
        if (matched > 0) log.info(`Screened settlement ${settlement}; ${matched} row(s) returned.`);
    } else {
        // Newest settlement first so a capped run still shows the latest reading.
        for (const settlement of dates) {
            if (rowsPushed >= rowCap || pastDeadline()) break;
            for (const symbol of tickers) {
                if (rowsPushed >= rowCap || pastDeadline()) break;
                const { rows, error } = await queryFinra({
                    limit: 5,
                    compareFilters: [dateFilter(settlement), { fieldName: 'symbolCode', fieldValue: symbol, compareType: 'equal' }],
                });
                if (error) { reachFailure = error; break; }
                for (const raw of rows) {
                    matched += 1;
                    await flushRow(mapInterestRow(raw), true);
                }
            }
            if (reachFailure) break;
        }
    }

    if (matched === 0) {
        const note = reachFailure
            ? `could not reach FINRA (${reachFailure}); not charged, try again later`
            : (runMode === 'interest_screen'
                ? `no symbols in settlement ${dates[0]} cleared a ${avgVolFloor.toLocaleString()} average daily volume floor${includeOtc ? '' : ' among exchange listed names'}; lower the floor or allow OTC. Not charged.`
                : `none of those symbols appear in FINRA's consolidated short interest for settlement ${dates.join(', ')}. Check the ticker spelling; the file covers US equities and OTC only. Not charged.`);
        await flushRow({ type: 'note', input: iLabel, found: false, note }, false);
    }

    log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
        + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
    await Actor.exit();
}

const label = runMode === 'screen'
    ? `market screen${requested ? ` for ${requested}` : ''}`
    : watchlistLabel;
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
