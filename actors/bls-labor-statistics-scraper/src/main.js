// Labor Statistics Scraper (BLS): Inflation, Jobs & Wages
//
// Strategy
// --------
// BLS Public Data API (api.bls.gov/publicAPI), keyless JSON POST. Friendly
// metric presets map to BLS series IDs; raw series IDs pass through. All
// requested series go in ONE POST (v1 allows 25 series / 10-year span; a
// buyer's free registration key switches to v2 with 50 series / 20 years
// and a 500/day quota instead of the shared 25/day).
//
// Quota note: the keyless daily limit (25 queries/day per IP) is shared on
// Apify. If BLS reports the threshold is reached, the run stops cleanly and
// suggests adding a free key (the sanctioned buyer-owned-credential pattern).
//
// Pay per event
// -------------
//   data_row per (series, period) data point. Unknown series and empty
//   requests are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 40000;

// Friendly preset -> { series id, label, unit }.
const PRESETS = {
    'cpi-inflation': { id: 'CUUR0000SA0', label: 'Consumer Price Index (CPI-U, all items)', unit: 'index (1982-84=100)' },
    'unemployment-rate': { id: 'LNS14000000', label: 'Unemployment rate', unit: 'percent' },
    'labor-force-participation': { id: 'LNS11300000', label: 'Labor force participation rate', unit: 'percent' },
    'nonfarm-employment': { id: 'CES0000000001', label: 'Total nonfarm employment', unit: 'thousands of jobs' },
    'avg-hourly-earnings': { id: 'CES0500000003', label: 'Average hourly earnings, private', unit: 'US dollars' },
    'avg-weekly-hours': { id: 'CES0500000002', label: 'Average weekly hours, private', unit: 'hours' },
    'producer-price-index': { id: 'WPUFD4', label: 'Producer Price Index (final demand)', unit: 'index' },
    'job-openings': { id: 'JTS000000000000000JOL', label: 'Job openings (JOLTS)', unit: 'thousands' },
    'quits-rate': { id: 'JTS000000000000000QUR', label: 'Quits rate (JOLTS)', unit: 'percent' },
};

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    metrics = [], seriesIds = [], startYear = 2020, endYear = 2025,
    registrationKey = '', maxRows = 5000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const key = String(registrationKey || '').trim();
const maxSpan = key ? 20 : 10;
let sy = clampNum(startYear, 2020, 1913, 2100);
let ey = clampNum(endYear, 2025, 1913, 2100);
if (ey < sy) [sy, ey] = [ey, sy];
if (ey - sy + 1 > maxSpan) { sy = ey - maxSpan + 1; log.warning(`Year range capped at ${maxSpan} years (${sy}-${ey})${key ? '' : '; add a free BLS key for up to 20'}.`); }
const rowCap = clampNum(maxRows, 5000, 1, HARD_CAP);

// Build the ordered series list: presets first (with labels), then raw ids.
const seriesMeta = new Map(); // seriesID -> { metric, label, unit }
for (const m of metrics) {
    const p = PRESETS[m];
    if (p) seriesMeta.set(p.id, { metric: m, label: p.label, unit: p.unit });
}
for (const raw of asTokens(seriesIds)) {
    const id = raw.toUpperCase();
    if (!seriesMeta.has(id)) seriesMeta.set(id, { metric: id, label: null, unit: null });
}
const idList = [...seriesMeta.keys()];

if (idList.length === 0) {
    log.warning('No metrics or series IDs selected. Pick a metric like "Inflation (CPI-U)" or paste a BLS series ID.');
    await Actor.exit();
}
const maxSeries = key ? 50 : 25;
const requestIds = idList.slice(0, maxSeries);
if (idList.length > maxSeries) log.warning(`Requesting the first ${maxSeries} series${key ? '' : '; add a free BLS key to raise the limit to 50'}.`);

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'data_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const PERIOD_LABEL = (p) => {
    if (/^M\d\d$/.test(p)) return 'monthly';
    if (/^Q0[1-4]$/.test(p)) return 'quarterly';
    if (p === 'A01') return 'annual';
    return p;
};
const monthOf = (p) => (/^M(\d\d)$/.test(p) ? Number(p.slice(1)) : null);

async function fetchSeries() {
    const version = key ? 'v2' : 'v1';
    const url = `https://api.bls.gov/publicAPI/${version}/timeseries/data/`;
    const body = { seriesid: requestIds, startyear: String(sy), endyear: String(ey) };
    if (key) body.registrationkey = key;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
            const json = await res.json().catch(() => null);
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok || !json) return { error: `HTTP ${res.status}` };
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

log.info(`Fetching ${requestIds.length} BLS series for ${sy}-${ey}${key ? ' (with key, v2)' : ' (keyless, v1)'}...`);

const json = await fetchSeries();
if (json?.error || json?.status === 'REQUEST_NOT_PROCESSED') {
    const msg = json?.error || (json?.message || []).join('; ') || 'request not processed';
    const quota = /threshold|limit|request/i.test(msg);
    log.warning(`BLS request failed: ${msg}`);
    await flushRow({ type: 'note', found: false, note: quota
        ? 'BLS daily request limit reached (25/day per IP is shared). Add a free BLS key (data.bls.gov/registrationEngine) to raise it to 500/day. Not charged.'
        : `BLS request failed (${msg}); not charged, try again later.` }, false);
    await Actor.exit();
}

const returned = json?.Results?.series || [];
const returnedIds = new Set(returned.map((s) => s.seriesID));
for (const id of requestIds) {
    if (!returnedIds.has(id)) {
        const meta = seriesMeta.get(id) || {};
        await flushRow({ type: 'note', input: id, found: false, note: `series "${id}"${meta.label ? ` (${meta.label})` : ''} returned no data (check the ID at data.bls.gov); not charged` }, false);
    }
}

for (const s of returned) {
    if (rowsPushed >= rowCap || pastDeadline()) break;
    const meta = seriesMeta.get(s.seriesID) || {};
    const data = (s.data || []).filter((p) => Number(p.year) >= sy && Number(p.year) <= ey);
    if (data.length === 0) {
        await flushRow({ type: 'note', input: s.seriesID, found: false, note: 'no data points in the selected years; not charged' }, false);
        continue;
    }
    for (const p of data) {
        if (rowsPushed >= rowCap || pastDeadline()) break;
        // Not-yet-released periods come back with no value — skip them so we
        // never emit or charge for an empty data point.
        const value = p.value !== undefined && p.value !== '' ? Number(p.value) : null;
        if (value === null || Number.isNaN(value)) continue;
        await flushRow({
            type: 'data_point',
            metric: meta.metric || s.seriesID,
            label: meta.label || null,
            unit: meta.unit || null,
            seriesId: s.seriesID,
            year: Number(p.year),
            period: p.period,
            periodName: p.periodName,
            month: monthOf(p.period),
            frequency: PERIOD_LABEL(p.period),
            value,
            footnotes: (p.footnotes || []).map((f) => f?.text).filter(Boolean),
        }, true);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
