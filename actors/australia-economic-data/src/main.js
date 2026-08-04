// Australia Property Prices and Economic Data
// Mean residential dwelling price by state, consumer price inflation and wage
// growth, straight from the Australian Bureau of Statistics.
//
// Source (keyless SDMX-JSON):
//   https://data.api.abs.gov.au/rest/data/ABS,{dataflow},{version}/all?lastNObservations=N
//
// Free tier: the first 2 rows of every run are free, then each data row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://data.api.abs.gov.au/rest/data/ABS';
const HEADERS = {
    'User-Agent': 'Scrapemint Australia Economic Data (contact@scrapemint.com)',
    Accept: 'application/vnd.sdmx.data+json',
};
const REQ_SLEEP_MS = 250;

// The dataflow VERSION differs per dataset and a wrong one returns 404 with
// "Could not find Dataflow", which reads as a missing dataset rather than a
// version mistake. These are pinned from the ABS dataflow list.
//
// RPPI (Residential Property Price Index) is deliberately absent: it was
// discontinued and its newest observation is 2021-Q4, but it still answers 200
// with a full looking payload, so building on it would publish figures five
// years out of date as current.
const CATALOGUE = {
    dwellings: {
        flow: 'RES_DWELL_ST', version: '1.0.0', freq: 'quarterly',
        label: 'Residential dwellings', unit: 'see measure',
        // Without a measure filter this returns dwelling stock totals in the
        // billions alongside the mean price, which are not comparable numbers.
        defaultMeasure: /mean price/i,
    },
    inflation: {
        flow: 'CPI', version: '2.0.0', freq: 'quarterly',
        label: 'Consumer price index', unit: 'index or percent',
        defaultMeasure: /^index numbers$/i,
        defaultExtra: { INDEX: /^all groups cpi$/i },
    },
    wages: {
        flow: 'WPI', version: '1.2.0', freq: 'quarterly',
        label: 'Wage price index', unit: 'index or percent',
        // ABS names this measure "Quarterly Index", not "Index Numbers" as the
        // CPI flow does. Assuming a shared vocabulary returned zero rows.
        defaultMeasure: /quarterly index/i,
        defaultExtra: {
            INDEX: /total hourly rates of pay including bonuses/i,
            SECTOR: /^private and public$/i,
            INDUSTRY: /^all industries$/i,
            TSEST: /^original$/i,
        },
    },
};

// A quarterly series more than this far past its newest observation is flagged
// rather than presented as current, which is how the discontinued RPPI would
// otherwise have looked.
const STALE_AFTER_DAYS = 250;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    datasets = ['dwellings', 'inflation', 'wages'],
    regions = ['Australia'],
    periods = 1,
    allMeasures = false,
    maxRows = 200,
} = input;

const wanted = (Array.isArray(datasets) ? datasets : []).map((d) => String(d).trim()).filter((d) => CATALOGUE[d]);
const unknown = (Array.isArray(datasets) ? datasets : []).map((d) => String(d).trim()).filter((d) => d && !CATALOGUE[d]);
if (unknown.length) log.warning(`Not in the catalogue, ignoring: ${unknown.join(', ')}. Choices: ${Object.keys(CATALOGUE).join(', ')}.`);
if (!wanted.length) {
    log.warning(`No valid datasets. Choose from: ${Object.keys(CATALOGUE).join(', ')}.`);
    await Actor.exit();
}

const regionWanted = (Array.isArray(regions) ? regions : []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
const nPeriods = Math.max(1, Math.min(200, Number(periods) || 1));
// Set per dataset once the region list is known; see regionMatches().
let exactRegionExists = false;

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;

log.info(`Datasets: ${wanted.join(', ')} | regions: ${regionWanted.join(', ') || 'all'} | last ${nPeriods} period(s)`);

for (const key of wanted) {
    if (done()) break;
    const meta = CATALOGUE[key];
    const doc = await fetchFlow(meta);
    if (!doc) {
        log.warning(`${key}: request failed; skipping.`);
        continue;
    }
    exactRegionExists = regionWanted.length > 0 && hasExactRegion(doc);
    let emitted = 0;
    for (const row of decode(doc, key, meta)) {
        if (done()) break;
        await pushRow(row);
        emitted += 1;
    }
    log.info(`${key}: ${emitted} row(s).`);
    await sleep(REQ_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- source ----------

async function fetchFlow(meta) {
    const url = `${BASE},${meta.flow},${meta.version}/all?lastNObservations=${nPeriods}`;
    return fetchJson(url);
}

// SDMX-JSON keys each series by a colon-joined list of POSITIONAL indexes into
// structures[0].dimensions.series, and each observation by an index into
// dimensions.observation[0]. Both have to be resolved through those value lists
// rather than assumed, because dimension order differs per dataflow.
function* decode(doc, key, meta) {
    const structure = doc?.data?.structures?.[0];
    const dataSet = doc?.data?.dataSets?.[0];
    if (!structure || !dataSet?.series) return;

    const dims = structure.dimensions?.series || [];
    const times = (structure.dimensions?.observation?.[0]?.values || []).map((v) => v.id);
    const attrDefs = structure.attributes?.series || [];
    const multPos = attrDefs.findIndex((a) => /^unit_mult$/i.test(a.id));
    const unitPos = attrDefs.findIndex((a) => /^unit_measure$/i.test(a.id));
    const freqPos = dims.findIndex((d) => /^freq$/i.test(d.id));
    const measurePos = dims.findIndex((d) => /^measure$/i.test(d.id));
    const regionPos = dims.findIndex((d) => /^region$/i.test(d.id) || /region|state/i.test(d.name || ''));

    const newest = times[times.length - 1];
    const stale = isStale(newest);

    for (const [seriesKey, series] of Object.entries(dataSet.series)) {
        const idx = seriesKey.split(':').map(Number);
        const names = {};
        for (let i = 0; i < dims.length; i += 1) {
            const v = dims[i].values?.[idx[i]];
            names[dims[i].id] = v ? v.name : null;
        }
        const measureName = measurePos >= 0 ? names[dims[measurePos].id] : null;
        const regionName = regionPos >= 0 ? names[dims[regionPos].id] : 'Australia';

        if (!allMeasures && meta.defaultMeasure && measureName && !meta.defaultMeasure.test(measureName)) continue;
        if (!allMeasures && meta.defaultExtra) {
            let skip = false;
            for (const [dimId, re] of Object.entries(meta.defaultExtra)) {
                const val = names[dimId];
                if (val && !re.test(val)) skip = true;
            }
            if (skip) continue;
        }
        if (regionWanted.length && !regionMatches(regionName)) continue;

        // ABS reports magnitude separately in UNIT_MULT, so a mean dwelling
        // price arrives as 1111.1 with "Thousands". Publishing the raw figure
        // would understate every price by a factor of a thousand.
        const attrs = series.attributes || [];
        const multName = multPos >= 0 ? attrDefs[multPos]?.values?.[attrs[multPos]]?.name : null;
        const unitName = unitPos >= 0 ? attrDefs[unitPos]?.values?.[attrs[unitPos]]?.name : null;
        const factor = multiplierFor(multName);
        const seriesFreq = freqPos >= 0 ? names[dims[freqPos].id] : meta.freq;

        for (const [obsIdx, obs] of Object.entries(series.observations || {})) {
            const period = times[Number(obsIdx)];
            if (!period) continue;
            const raw = num(Array.isArray(obs) ? obs[0] : obs);
            yield {
                dataset: key,
                label: meta.label,
                measure: measureName,
                region: regionName,
                period,
                // A suppressed or unavailable observation must stay null: a mean
                // dwelling price of 0 would read as a real figure.
                value: raw === null ? null : round(raw * factor, 2),
                rawValue: raw,
                unitMultiplier: multName || null,
                unit: unitName || meta.unit,
                frequency: seriesFreq || meta.freq,
                isStale: stale,
                newestPeriodInSeries: newest ?? null,
                dataflow: `${meta.flow} ${meta.version}`,
                sourceUrl: `${BASE},${meta.flow},${meta.version}/all`,
            };
        }
    }
}

// True when some region in this dataset matches a requested name exactly.
function hasExactRegion(doc) {
    const dims = doc?.data?.structures?.[0]?.dimensions?.series || [];
    const rd = dims.find((d) => /^region$/i.test(d.id));
    return (rd?.values || []).some((v) => regionWanted.includes(String(v.name || '').toLowerCase()));
}

// "Australia" is a substring of South Australia and Western Australia, so a
// plain includes() filter silently returns three states when one was asked for.
// An exact name match wins outright; partial matching only applies when no
// region matches exactly.
function regionMatches(name) {
    const n = String(name || '').toLowerCase();
    if (regionWanted.some((r) => n === r)) return true;
    if (exactRegionExists) return false;
    return regionWanted.some((r) => n.includes(r));
}

// Periods arrive as 2026-Q1 or 2025-09. Anything older than the threshold is
// flagged, which is what catches a dataflow that was quietly discontinued.
function isStale(period) {
    if (!period) return true;
    const q = String(period).match(/^(\d{4})-Q([1-4])$/);
    const m = String(period).match(/^(\d{4})-(\d{2})$/);
    let end = null;
    if (q) end = Date.UTC(Number(q[1]), Number(q[2]) * 3, 0);
    else if (m) end = Date.UTC(Number(m[1]), Number(m[2]), 0);
    if (end === null) return false;
    return (Date.now() - end) / 86400000 > STALE_AFTER_DAYS;
}

async function fetchJson(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                // 404 here almost always means the pinned version is wrong, not
                // that the dataset is gone.
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2) {
                log.warning(`fetch failed ${url}: ${err?.message}`);
                return null;
            }
            await sleep(1500 * (attempt + 1));
        }
    }
    return null;
}

// ---------- plumbing ----------

function multiplierFor(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('billion')) return 1e9;
    if (n.includes('million')) return 1e6;
    if (n.includes('thousand')) return 1e3;
    return 1;
}

function round(n, dp) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
}

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
        await Actor.charge({ eventName: 'data_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
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
