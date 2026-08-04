// Europe House Prices
// Eurostat's official house price index for 38 European countries: the index
// level, the quarterly change and the annual change, for all dwellings or split
// into new and existing homes.
//
// Source (keyless JSON-stat, official EU statistics):
//   https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_q
//
// Free tier: the first 2 rows of every run are free, then each country row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const DATASET = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_q';
const HEADERS = {
    'User-Agent': 'Scrapemint Europe House Prices (contact@scrapemint.com)',
    Accept: 'application/json',
};
const REQ_SLEEP_MS = 200;

// Eurostat unit codes, mapped to the column each becomes on the output row.
const UNITS = {
    I15_Q: { field: 'index2015', label: 'index, 2015 = 100' },
    RCH_A: { field: 'changeYearPct', label: 'percentage change on same quarter of previous year' },
    RCH_Q: { field: 'changeQuarterPct', label: 'percentage change on previous quarter' },
};
const PURCHASES = { TOTAL: 'all dwellings', DW_NEW: 'new dwellings', DW_EXST: 'existing dwellings' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = [],
    purchase = 'TOTAL',
    mode = 'latest',
    periods = 1,
    maxRows = 200,
} = input;

const geoFilter = new Set((Array.isArray(countries) ? countries : [])
    .map((c) => String(c).trim().toUpperCase())
    .filter(Boolean));
const purchaseCode = PURCHASES[String(purchase).toUpperCase()] ? String(purchase).toUpperCase() : 'TOTAL';
if (!PURCHASES[String(purchase).toUpperCase()]) {
    log.warning(`Unknown purchase "${purchase}"; using TOTAL. Choices: ${Object.keys(PURCHASES).join(', ')}.`);
}
const isHistory = String(mode) === 'history';
const nPeriods = isHistory ? Math.max(1, Math.min(120, Number(periods) || 12)) : 1;

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;

log.info(`Mode ${isHistory ? 'history' : 'latest'} | purchase ${purchaseCode} (${PURCHASES[purchaseCode]}) | last ${nPeriods} quarter(s)${geoFilter.size ? ` | countries ${[...geoFilter].join(', ')}` : ''}`);

// One request per unit. Eurostat returns a separate cube per unit code, so the
// three measures are fetched independently and joined on country and quarter.
const byKey = new Map();
const labels = new Map();
let unitsWithData = 0;
for (const [code, meta] of Object.entries(UNITS)) {
    if (done()) break;
    const cube = await fetchCube(code);
    if (!cube) {
        log.warning(`Unit ${code} returned no data; that column will be null.`);
        continue;
    }
    unitsWithData += 1;
    for (const point of decode(cube)) {
        if (geoFilter.size && !geoFilter.has(point.geo)) continue;
        const key = `${point.geo}|${point.time}`;
        if (!byKey.has(key)) byKey.set(key, { geo: point.geo, time: point.time });
        byKey.get(key)[meta.field] = point.value;
        if (point.geoLabel) labels.set(point.geo, point.geoLabel);
    }
    await sleep(REQ_SLEEP_MS);
}

if (!unitsWithData) {
    log.warning('Eurostat returned no data for any unit. Check the country codes, e.g. DE, FR, ES.');
    await Actor.exit();
}

const rows = [...byKey.values()].sort((a, b) => String(b.time).localeCompare(String(a.time))
    || String(labels.get(a.geo) || a.geo).localeCompare(String(labels.get(b.geo) || b.geo)));

log.info(`${rows.length} country-quarter row(s).`);
for (const r of rows) {
    if (done()) break;
    await pushRow({
        country: labels.get(r.geo) || r.geo,
        geoCode: r.geo,
        quarter: r.time,
        purchase: purchaseCode,
        purchaseLabel: PURCHASES[purchaseCode],
        // Any measure Eurostat did not publish for this country-quarter stays
        // null. A 0 would read as a flat market rather than a missing figure.
        index2015: r.index2015 ?? null,
        changeQuarterPct: r.changeQuarterPct ?? null,
        changeYearPct: r.changeYearPct ?? null,
        indexUnit: UNITS.I15_Q.label,
        sourceUrl: `${DATASET}?purchase=${purchaseCode}&geo=${r.geo}`,
    });
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- source ----------

async function fetchCube(unitCode) {
    const url = `${DATASET}?format=JSON&lang=EN&unit=${unitCode}&purchase=${purchaseCode}`
        + `&lastTimePeriod=${nPeriods}`;
    const data = await fetchJson(url);
    if (!data || !data.dimension || !data.value) return null;
    return data;
}

// JSON-stat packs every observation into a flat map whose keys are row-major
// indexes over the dimensions listed in `id`, with lengths in `size`. Decoding
// has to walk that product rather than assume a shape: the dimension order is
// freq, purchase, unit, geo, time here, and hardcoding positions would silently
// mislabel every value if Eurostat reordered them.
function* decode(cube) {
    const ids = cube.id || [];
    const sizes = cube.size || [];
    const geoPos = ids.indexOf('geo');
    const timePos = ids.indexOf('time');
    if (geoPos < 0 || timePos < 0) return;

    const geoIndex = invert(cube.dimension.geo?.category?.index);
    const timeIndex = invert(cube.dimension.time?.category?.index);
    const geoLabels = cube.dimension.geo?.category?.label || {};

    // stride[i] = product of every size to the right of i
    const strides = new Array(ids.length).fill(1);
    for (let i = ids.length - 2; i >= 0; i -= 1) strides[i] = strides[i + 1] * (sizes[i + 1] || 1);

    for (const [flat, value] of Object.entries(cube.value)) {
        const n = Number(flat);
        if (!Number.isFinite(n)) continue;
        const v = num(value);
        if (v === null) continue;
        const geoKey = geoIndex[Math.floor(n / strides[geoPos]) % (sizes[geoPos] || 1)];
        const timeKey = timeIndex[Math.floor(n / strides[timePos]) % (sizes[timePos] || 1)];
        if (!geoKey || !timeKey) continue;
        yield { geo: geoKey, time: timeKey, value: v, geoLabel: geoLabels[geoKey] };
    }
}

function invert(indexObj) {
    const out = {};
    for (const [k, v] of Object.entries(indexObj || {})) out[v] = k;
    return out;
}

async function fetchJson(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                if (res.status !== 404) log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2) {
                log.warning(`fetch failed ${url}: ${err?.message}`);
                return null;
            }
            await sleep(1000 * (attempt + 1));
        }
    }
    return null;
}

// ---------- plumbing ----------

// Eurostat omits unavailable observations entirely, but a null slipping through
// must not become 0: Number(null) is 0 and would publish as a real index.
function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'country_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 100 === 0) log.info(`Pushed ${pushed} rows...`);
}

function done() {
    if (pushed >= rowCap) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
