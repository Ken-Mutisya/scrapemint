// World Economic Indicators Scraper: GDP, Inflation & More by Country
//
// Strategy
// --------
// The World Bank's Indicators API is a keyless, global, documented JSON API
// covering ~265 economies and ~29,500 indicators (GDP, inflation,
// unemployment, population, life expectancy, trade, and much more) with
// decades of annual history. No API key, no browser, no proxy.
//
// The actor takes a set of countries and indicators plus a year range (or
// "most recent only") and returns one row per country-indicator-year. Each
// row is enriched with the country's region and income level from a single
// metadata call, so buyers can group by region/income without extra work.
//
// Pay per event
// -------------
//   data_point per pushed country-indicator-year row. First 2 rows per run
//   are free.

import { Actor, log } from 'apify';

const BASE = 'https://api.worldbank.org/v2';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const PER_PAGE = 1000;
const FETCH_TIMEOUT_MS = 25000;
const MAX_INDICATORS = 25;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = ['US', 'CN', 'IN', 'BR', 'KE'],
    indicators = ['NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'FP.CPI.TOTL.ZG'],
    startYear = null,
    endYear = null,
    mostRecentOnly = false,
    skipEmpty = true,
    maxRows = 200,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const countryTokens = asTokens(countries).map((s) => s.toUpperCase());
const countryParam = (countryTokens.length === 0 || countryTokens.includes('ALL'))
    ? 'all' : countryTokens.join(';');
const indicatorList = asTokens(indicators).slice(0, MAX_INDICATORS);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

if (indicatorList.length === 0) {
    log.warning('No indicators provided. Add at least one World Bank indicator id (e.g. NY.GDP.MKTP.CD).');
    await Actor.exit();
}

// Build the World Bank date parameter from the year range, if any.
function dateParam() {
    const s = Number(startYear), e = Number(endYear);
    const hasS = Number.isInteger(s) && s > 1900;
    const hasE = Number.isInteger(e) && e > 1900;
    if (hasS && hasE) return `${Math.min(s, e)}:${Math.max(s, e)}`;
    if (hasS) return `${s}:${new Date().getFullYear()}`;
    if (hasE) return `1960:${e}`;
    return null;
}
const DATE = dateParam();

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'scrapemint-world-economic-indicators/0.1 (+https://apify.com)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// World Bank returns [meta, records] on success, or [{message:[...]}] on error.
function unpack(json) {
    if (!Array.isArray(json) || json.length < 1) return { error: 'bad-response' };
    if (json[0] && Array.isArray(json[0].message)) {
        return { error: json[0].message.map((m) => m.value || m.key).join('; ') };
    }
    const meta = json[0] || {};
    const records = Array.isArray(json[1]) ? json[1] : [];
    return { meta, records };
}

// One metadata call to enrich every row with region + income level.
const geoByIso3 = new Map();
try {
    let page = 1, pages = 1;
    do {
        const j = await fetchJson(`${BASE}/country?format=json&per_page=400&page=${page}`);
        const { meta, records } = unpack(j);
        pages = meta?.pages || 1;
        for (const c of records) {
            geoByIso3.set(c.id, {
                region: c.region?.value?.trim() || null,
                incomeLevel: c.incomeLevel?.value?.trim() || null,
                capitalCity: c.capitalCity || null,
            });
        }
        page += 1;
    } while (page <= pages);
    log.info(`Loaded region/income metadata for ${geoByIso3.size} economies.`);
} catch (err) {
    log.warning(`Country metadata unavailable, continuing without region/income: ${err?.message}`);
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'data_point' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

function toRow(rec) {
    const iso3 = rec.countryiso3code || null;
    const geo = (iso3 && geoByIso3.get(iso3)) || {};
    return {
        country: rec.country?.value || null,
        countryCode: rec.country?.id || null,
        iso3,
        region: geo.region || null,
        incomeLevel: geo.incomeLevel || null,
        indicatorId: rec.indicator?.id || null,
        indicator: rec.indicator?.value || null,
        year: rec.date || null,
        value: rec.value,
        unit: rec.unit || null,
    };
}

log.info(`Countries: ${countryParam === 'all' ? 'all (~265)' : countryTokens.length} | indicators: ${indicatorList.length} | ${mostRecentOnly ? 'most recent only' : (DATE || 'all years')}`);

outer:
for (const ind of indicatorList) {
    let page = 1, pages = 1;
    do {
        if (rowsPushed >= cap) break outer;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break outer; }

        const params = new URLSearchParams({ format: 'json', per_page: String(PER_PAGE), page: String(page) });
        if (mostRecentOnly) params.set('mrv', '1');
        else if (DATE) params.set('date', DATE);
        const url = `${BASE}/country/${encodeURIComponent(countryParam)}/indicator/${encodeURIComponent(ind)}?${params}`;

        let json;
        try { json = await fetchJson(url); }
        catch (err) { log.warning(`${ind}: fetch failed (${err?.message}); skipping.`); break; }

        const { meta, records, error } = unpack(json);
        if (error) { log.warning(`${ind}: ${error}; skipping.`); break; }
        pages = meta?.pages || 1;

        for (const rec of records) {
            if (rowsPushed >= cap) break outer;
            if (skipEmpty && (rec.value === null || rec.value === undefined || rec.value === '')) continue;
            await flushRow(toRow(rec));
        }
        page += 1;
    } while (page <= pages);
}

log.info(`Done. ${rowsPushed} data point(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
