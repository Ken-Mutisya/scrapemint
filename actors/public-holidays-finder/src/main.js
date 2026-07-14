// Public Holidays Finder: 187 Countries, Any Year
//
// Strategy
// --------
// Nager.Date public API (date.nager.at, MIT-licensed open project), keyless,
// verified reachable from Apify DC IPs. One GET per country-year returns that
// year's holidays computed from the country's rules (future years work).
// One row per holiday. Unsupported country codes 404 -> free note row.
//
// Pay per event
// -------------
//   holiday_row per holiday row. Unsupported countries and bad input are
//   free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://date.nager.at/api/v3/PublicHolidays';
const UA = 'scrapemint-public-holidays-finder/0.1 (+https://apify.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const MAX_RANGE_YEARS = 11;
const POOL_SIZE = 4;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { countries = [], startYear = 2026, endYear, maxRows = 5000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;\s]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const ccList = [];
const badCodes = [];
for (const raw of [...new Set(asTokens(countries).map((s) => s.toUpperCase()))]) {
    if (/^[A-Z]{2}$/.test(raw)) ccList.push(raw);
    else badCodes.push(raw);
}
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 5000));

if (ccList.length === 0) {
    log.warning('No valid country codes given. Use 2 letter codes like US, GB or KE.');
    await Actor.exit();
}

const y1 = Math.max(1975, Math.min(2075, Number(startYear) || new Date().getUTCFullYear()));
let y2 = Math.max(1975, Math.min(2075, Number(endYear) || y1));
if (y2 < y1) y2 = y1;
if (y2 - y1 + 1 > MAX_RANGE_YEARS) {
    y2 = y1 + MAX_RANGE_YEARS - 1;
    log.warning(`Year range capped at ${MAX_RANGE_YEARS} years: ${y1}..${y2}.`);
}
const years = [];
for (let y = y1; y <= y2; y += 1) years.push(y);

const countryName = (() => {
    try {
        const dn = new Intl.DisplayNames(['en'], { type: 'region' });
        return (code) => { try { return dn.of(code) || null; } catch { return null; } };
    } catch { return () => null; }
})();

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = res.status === 200 ? await res.json().catch(() => null) : null;
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 2000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
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
            await Actor.charge({ eventName: 'holiday_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

for (const bad of badCodes) {
    await flushRow({ country: bad, valid: false, note: 'not a 2 letter country code' }, false);
}

const tasks = [];
for (const cc of ccList) for (const year of years) tasks.push({ cc, year });
const unsupported = new Set();

log.info(`Fetching holidays for ${ccList.length} countr${ccList.length === 1 ? 'y' : 'ies'} x ${years.length} year(s)...`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const { cc, year } = tasks[i];
        if (unsupported.has(cc)) continue;

        const { status, json, error } = await fetchJson(`${BASE}/${year}/${cc}`);
        if (status === 404) {
            unsupported.add(cc);
            await flushRow({ country: cc, valid: false, note: 'country not covered (187 countries are; check the code)' }, false);
            continue;
        }
        if (status !== 200 || !Array.isArray(json)) {
            await flushRow({ country: cc, year, valid: false, note: `could not fetch (${error || `HTTP ${status}`}); not charged, try again later` }, false);
            log.warning(`${cc} ${year}: HTTP ${status} ${error || ''}`);
            continue;
        }

        let pushed = 0;
        for (const h of json) {
            if (rowsPushed >= cap) { stopped = true; break; }
            await flushRow({
                country: cc,
                countryName: countryName(cc),
                year,
                date: h.date || null,
                name: h.name || null,
                localName: h.localName || null,
                types: h.types || [],
                nationwide: h.global !== false,
                regions: h.counties || [],
                fixedDate: Boolean(h.fixed),
            }, true);
            pushed += 1;
        }
        log.info(`${cc} ${year}: ${pushed} holiday(s).`);
        await sleep(100);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tasks.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; unsupported countries are free).`);
await Actor.exit();
