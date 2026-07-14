// Currency Exchange Rates: Live & History for 160+ Currencies
//
// Strategy
// --------
// Two keyless public feeds, both verified reachable from Apify DC IPs:
//   latest  -> open.er-api.com /v6/latest/{BASE}: 166 currencies, one GET per
//              base currency, updated daily.
//   history -> api.frankfurter.dev /v1/{start}..{end} (ECB reference rates):
//              ~30 major currencies, daily values back to 1999, one GET per
//              base covers the whole range and every target.
// No browser, no proxy, no API key. One row per (base, target[, date]).
//
// Pay per event
// -------------
//   rate_row per pushed rate row. Unsupported currency codes produce a free
//   note row. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const ERAPI_URL = 'https://open.er-api.com/v6/latest/';
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;
const FETCH_TIMEOUT_MS = 30000;
const EARLIEST_ECB_DATE = '1999-01-04';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    baseCurrencies = [], targetCurrencies = [], dataType = 'latest',
    startDate = '', endDate = '', maxRows = 1000,
} = input;

const asCodes = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\n,;\s]+/))
    .map((s) => String(s || '').trim().toUpperCase())
    .filter((s) => /^[A-Z]{3}$/.test(s)))];

const bases = asCodes(baseCurrencies);
const targets = asCodes(targetCurrencies);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (bases.length === 0) {
    log.warning('No valid base currencies given. Use 3 letter codes like USD, EUR, KES.');
    await Actor.exit();
}

const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
const today = new Date().toISOString().slice(0, 10);

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'user-agent': 'scrapemint-currency-exchange-rates/0.1 (+https://apify.com)', accept: 'application/json' },
            });
            const body = await res.text();
            let json = null;
            try { json = JSON.parse(body); } catch { /* keep null */ }
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
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'rate_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function runLatest() {
    for (const base of bases) {
        if (rowsPushed >= cap) return;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); return; }

        const { status, json, error } = await fetchJson(`${ERAPI_URL}${base}`);
        if (status !== 200 || json?.result !== 'success' || !json?.rates) {
            const note = json?.['error-type'] === 'unsupported-code'
                ? 'this currency code is not supported'
                : `could not fetch rates (${json?.['error-type'] || error || `HTTP ${status}`})`;
            log.warning(`${base}: ${note}`);
            await flushRow({ base, valid: false, note }, false);
            continue;
        }

        const date = json.time_last_update_utc ? new Date(json.time_last_update_utc).toISOString().slice(0, 10) : today;
        const wanted = targets.length ? targets : Object.keys(json.rates);
        for (const target of wanted) {
            if (rowsPushed >= cap) return;
            if (target === base) continue;
            const rate = json.rates[target];
            if (typeof rate !== 'number') {
                await flushRow({ base, target, valid: false, note: 'this currency code is not supported' }, false);
                continue;
            }
            await flushRow({
                base, target, rate, inverseRate: rate ? Number((1 / rate).toPrecision(8)) : null,
                date, source: 'open.er-api.com', nextUpdateUtc: json.time_next_update_utc || null, valid: true,
            });
        }
        log.info(`${base}: latest rates for ${wanted.length} currencies pushed.`);
    }
}

async function runHistory() {
    const start = isoDate(startDate) || EARLIEST_ECB_DATE;
    let end = isoDate(endDate) || today;
    if (end > today) end = today;
    if (start > end) {
        log.warning(`Start date ${start} is after end date ${end}; nothing to fetch.`);
        return;
    }
    const symbolsParam = targets.length ? `&symbols=${targets.join(',')}` : '';

    for (const base of bases) {
        if (rowsPushed >= cap) return;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); return; }

        const { status, json, error } = await fetchJson(`${FRANKFURTER_URL}${start}..${end}?base=${base}${symbolsParam}`);
        if (status !== 200 || !json?.rates) {
            const note = status === 404
                ? 'no historical data for this currency (history covers ~30 major currencies)'
                : `could not fetch history (${error || `HTTP ${status}`})`;
            log.warning(`${base}: ${note}`);
            await flushRow({ base, valid: false, note }, false);
            continue;
        }

        let baseRows = 0;
        for (const date of Object.keys(json.rates).sort()) {
            for (const [target, rate] of Object.entries(json.rates[date])) {
                if (rowsPushed >= cap) { log.info(`${base}: row cap reached at ${date}.`); return; }
                if (target === base || typeof rate !== 'number') continue;
                await flushRow({
                    base, target, rate, inverseRate: rate ? Number((1 / rate).toPrecision(8)) : null,
                    date, source: 'ECB via frankfurter.dev', valid: true,
                });
                baseRows += 1;
            }
        }
        log.info(`${base}: ${baseRows} historical rate row(s) pushed (${start}..${end}).`);
    }
}

log.info(`Mode: ${dataType}; ${bases.length} base currenc${bases.length === 1 ? 'y' : 'ies'}, `
    + `${targets.length ? targets.length : 'all available'} target(s), max ${cap} rows.`);

if (dataType === 'history') await runHistory();
else await runLatest();

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; unsupported codes are free).`);
await Actor.exit();
