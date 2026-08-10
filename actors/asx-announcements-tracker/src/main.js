// ASX Company & Announcement Tracker
// Australian Securities Exchange company data and company announcements from
// the keyless public JSON that asx.com.au itself reads. No key, no login, no
// browser, no proxy.
//
// Endpoints (all keyless, need a browser-like User-Agent):
//   /asx-research/1.0/companies/directory              -> every listed company, ONE request
//   /asx-research/1.0/companies/{code}/announcements    -> latest 5 announcements
//   /asx-research/1.0/companies/{code}/key-statistics   -> fundamentals, dividend, franking
//
// Why this source is worth billing for: ASX listing rules require a company to
// mark an announcement that a reasonable person would expect to move the price.
// `isPriceSensitive` is therefore a REGULATOR'S flag, not our guess, which
// makes it a clean market-moving event feed with no text classification.
//
// Free tier: first 2 rows per run are free, then each row is charged. It has to
// sit BELOW what the prefill returns, or every default run is free by
// construction and recurring buyers ride free forever.

import { Actor, log } from 'apify';
import { num, metric } from './numeric-helpers.js';

await Actor.init();

const API = 'https://asx.api.markitdigital.com/asx-research/1.0';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-AU,en;q=0.9',
};
const FREE_TIER_ROWS = 2;
const REQUEST_GAP_MS = 250;
const FETCH_TIMEOUT_MS = 25000;
// The per-company endpoints cost about 850ms each from a datacenter, so a
// sweep of all 1840 listed companies would need ~26 minutes and cannot finish
// inside a sane timeout. The fan-out is capped and driven off a directory
// filter instead of pretending a whole-market announcement scan is available.
const MAX_SYMBOL_FANOUT = 250;

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'directory',
    symbols = [],
    industry = '',
    minMarketCap = 0,
    minFiveDayMovePct = null,
    recentListingsOnly = false,
    priceSensitiveOnly = false,
    newOnly = false,
    maxRows = 200,
} = input;

const modeNorm = String(mode).trim().toLowerCase();
const wanted = (Array.isArray(symbols) ? symbols : [])
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);
const industryFilter = String(industry || '').trim().toLowerCase();
const capFloor = num(minMarketCap) ?? 0;
const moveFloor = num(minFiveDayMovePct);
const rowCap = Math.max(1, Math.min(Number(maxRows) || 200, 5000));

// Wall-clock budget from the platform, never a hardcoded guess: a run that is
// killed mid-flight loses the rows it already pushed AND the charges for them.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT - 45000;
const pastDeadline = () => Date.now() > SOFT_DEADLINE_AT;

let rowsPushed = 0;
let chargeable = 0;
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

async function flushRow(row, billable = true) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!billable) return;
    chargeable += 1;
    if (chargeable > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'asx_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function getJson(path) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`${API}${path}`, { signal: controller.signal, headers: HEADERS });
            if (res.status === 404) return { notFound: true };
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            return { json: await res.json() };
        } catch (err) {
            if (attempt === 3) return { error: err?.message || 'request failed' };
            await new Promise((r) => setTimeout(r, attempt * 3000));
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const companyUrl = (sym) => `https://www.asx.com.au/markets/company/${String(sym).toUpperCase()}`;

// --- company directory -------------------------------------------------------------

function directoryRow(c) {
    return {
        rowType: 'company',
        symbol: clean(c.symbol),
        name: clean(c.displayName),
        industry: clean(c.industry),
        dateListed: clean(c.dateListed),
        // marketCap arrives as a non numeric string on some rows, so it goes
        // through num(): an unknown cap must stay null and never publish as 0.
        marketCapAud: num(c.marketCap),
        priceChangeFiveDayPct: metric(c.priceChangeFiveDayPercent, 2),
        recentListing: c.isRecentListing === true,
        statusCode: clean(c.statusCode),
        url: companyUrl(c.symbol),
        source: 'ASX company directory',
    };
}

function passesFilters(c) {
    if (industryFilter && !String(c.industry || '').toLowerCase().includes(industryFilter)) return false;
    const cap = num(c.marketCap);
    if (capFloor > 0 && (cap === null || cap < capFloor)) return false;
    if (moveFloor !== null) {
        const mv = num(c.priceChangeFiveDayPercent);
        if (mv === null || Math.abs(mv) < Math.abs(moveFloor)) return false;
    }
    if (recentListingsOnly && c.isRecentListing !== true) return false;
    return true;
}

async function fetchDirectory() {
    const { json, error } = await getJson('/companies/directory?itemsPerPage=5000');
    if (error) return { error };
    const items = json?.data?.items || [];
    return { items };
}

// --- announcements -----------------------------------------------------------------

function announcementRow(a, sym, name) {
    return {
        rowType: 'announcement',
        symbol: sym,
        name: clean(name),
        headline: clean(a.headline),
        announcementType: clean(a.announcementType),
        // The regulator's own flag: ASX listing rules require a company to mark
        // an announcement expected to move the price. Not our classification.
        priceSensitive: a.isPriceSensitive === true,
        announcedAt: clean(a.date),
        fileSize: clean(a.fileSize),
        documentKey: clean(a.documentKey),
        url: companyUrl(sym),
        source: 'ASX company announcements',
    };
}

// --- key statistics ----------------------------------------------------------------

function statsRow(d, sym, name) {
    return {
        rowType: 'keyStatistics',
        symbol: sym,
        name: clean(name),
        isin: clean(d.isin),
        priceClose: num(d.priceClose),
        priceDayHigh: num(d.priceDayHigh),
        priceDayLow: num(d.priceDayLow),
        priceFiftyTwoWeekHigh: num(d.priceFiftyTwoWeekHigh),
        priceFiftyTwoWeekLow: num(d.priceFiftyTwoWeekLow),
        volumeAverage: num(d.volumeAverage),
        sharesOnIssue: num(d.numOfShares),
        earningsPerShare: num(d.earningsPerShare),
        priceEarningsRatio: num(d.priceEarningsRatio),
        freeCashFlowYield: num(d.freeCashFlowYield),
        dividend: num(d.dividend),
        dividendCurrency: clean(d.dividendCurrency),
        dividendType: clean(d.dividendType),
        dividendYieldAnnualPct: metric(d.yieldAnnual, 2),
        // Franking is the Australian dividend imputation credit and is the
        // reason an AU investor reads this page at all. 100 means fully franked.
        frankingPercent: num(d.frankingPercent),
        exDividendDate: clean(d.dateExDate),
        payDate: clean(d.datePayDate),
        recordDate: clean(d.dateRecordDate),
        url: companyUrl(sym),
        source: 'ASX key statistics',
    };
}

// --- run ---------------------------------------------------------------------------

log.info(`ASX ${modeNorm}${wanted.length ? ` | ${wanted.length} symbol(s)` : ''}`
    + `${industryFilter ? ` | industry~"${industry}"` : ''}${capFloor ? ` | cap>=${capFloor}` : ''}`
    + `${moveFloor !== null ? ` | |5d move|>=${moveFloor}%` : ''}${recentListingsOnly ? ' | recent listings only' : ''}`
    + ` | cap ${rowCap} rows`);

if (modeNorm === 'directory') {
    const { items, error } = await fetchDirectory();
    if (error) {
        await flushRow({ rowType: 'note', found: false, note: `could not reach the ASX company directory (${error}); not charged, try again later` }, false);
    } else {
        const matched = items.filter(passesFilters);
        log.info(`${items.length} listed compan(ies); ${matched.length} match the filters.`);
        for (const c of matched) {
            if (shouldStop()) break;
            await flushRow(directoryRow(c));
        }
        if (matched.length === 0) {
            await flushRow({ rowType: 'note', found: false, note: `no companies matched: ${items.length} are listed, so loosen the industry, market cap or five day move filter; not charged` }, false);
        }
    }
} else {
    // Both per-symbol modes resolve their symbol list the same way: an explicit
    // watchlist, or the directory filtered down and capped, so that "every
    // Energy company over $50m" works without asking for 1840 requests.
    let targets = [];
    let dirIndex = new Map();
    const { items, error } = await fetchDirectory();
    if (items) for (const c of items) dirIndex.set(String(c.symbol || '').toUpperCase(), c);

    if (wanted.length) {
        targets = wanted;
    } else if (error) {
        await flushRow({ rowType: 'note', found: false, note: `could not reach the ASX company directory to build a symbol list (${error}); pass symbols instead; not charged` }, false);
    } else {
        targets = items.filter(passesFilters).map((c) => String(c.symbol).toUpperCase());
        if (targets.length > MAX_SYMBOL_FANOUT) {
            log.warning(`${targets.length} companies matched; reading the first ${MAX_SYMBOL_FANOUT}. Narrow the filters or pass symbols to choose which.`);
            targets = targets.slice(0, MAX_SYMBOL_FANOUT);
        }
    }

    // Cross-run dedupe needs a NAMED store. The default key value store is
    // recreated per run, so monitor mode would silently re-report every
    // announcement on every run and bill for all of them.
    const store = newOnly ? await Actor.openKeyValueStore('asx-announcements-seen') : null;
    const SEEN_KEY = 'seen-document-keys';
    const SEEN_MAX = 200000;
    const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
    const seenAtStart = seen.size;

    let emitted = 0;
    let skippedSeen = 0;
    let missing = 0;

    for (const sym of targets) {
        if (shouldStop()) break;
        await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
        const name = dirIndex.get(sym)?.displayName;

        if (modeNorm === 'keystatistics') {
            const { json, error: err, notFound } = await getJson(`/companies/${encodeURIComponent(sym)}/key-statistics`);
            if (notFound) { missing += 1; continue; }
            if (err) { log.warning(`${sym}: ${err}`); continue; }
            const d = json?.data;
            if (!d) { missing += 1; continue; }
            await flushRow(statsRow(d, sym, name));
            emitted += 1;
            continue;
        }

        const { json, error: err, notFound } = await getJson(`/companies/${encodeURIComponent(sym)}/announcements`);
        if (notFound) { missing += 1; continue; }
        if (err) { log.warning(`${sym}: ${err}`); continue; }
        const data = json?.data || {};
        for (const a of data.items || []) {
            if (shouldStop()) break;
            if (priceSensitiveOnly && a.isPriceSensitive !== true) continue;
            const key = a.documentKey || `${sym}|${a.date}|${a.headline}`;
            if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(key);
            await flushRow(announcementRow(a, sym, data.displayName || name));
            emitted += 1;
        }
    }

    if (newOnly) {
        const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
        await store.setValue(SEEN_KEY, toSave);
        log.info(`Monitor state: ${toSave.length} announcement(s) remembered (${seenAtStart} before, ${skippedSeen} already seen skipped).`);
    }

    if (emitted === 0 && targets.length) {
        const why = newOnly && skippedSeen
            ? 'no new announcements since the last run'
            : priceSensitiveOnly
                ? 'no price sensitive announcements for those companies; each company exposes only its 5 most recent, so switch priceSensitiveOnly off to see the rest'
                : 'no announcements returned for those companies';
        await flushRow({ rowType: 'note', found: false, note: `${why}; not charged` }, false);
    }
    if (missing) log.info(`${missing} symbol(s) had no data on ASX (check the code, e.g. BHP not BHP.AX).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeable - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near the run timeout' : ''}.`);
await Actor.exit();
