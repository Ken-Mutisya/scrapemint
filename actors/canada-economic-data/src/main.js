// Canada Economic and Housing Data
// Monthly Canadian statistics straight from Statistics Canada: consumer price
// index, new housing prices, housing starts, employment and GDP, for Canada as
// a whole or by province and city.
//
// Source (keyless JSON, official government data, POST):
//   https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata
//   https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods
//
// Free tier: the first 2 rows of every run are free, then each data row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const HEADERS = { 'User-Agent': 'Scrapemint Canada Economic Data (contact@scrapemint.com)', 'Content-Type': 'application/json' };
const REQ_SLEEP_MS = 250;

// Curated tables. Statistics Canada has thousands, and there is no keyless
// search, so the set is pinned here the same way the FRED and CME catalogues are.
const CATALOGUE = {
    cpi: { pid: 18100004, label: 'Consumer price index', unit: 'index, 2002 = 100' },
    housingPrices: { pid: 18100205, label: 'New housing price index', unit: 'index, 2016 = 100' },
    housingStarts: { pid: 34100143, label: 'Housing starts', unit: 'units' },
    employment: { pid: 14100287, label: 'Labour force characteristics', unit: 'persons or percent' },
    gdp: { pid: 36100434, label: 'GDP at basic prices by industry', unit: 'chained 2017 dollars' },
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    datasets = ['cpi', 'housingPrices', 'housingStarts'],
    geographies = ['Canada'],
    periods = 1,
    maxRows = 200,
} = input;

const wanted = (Array.isArray(datasets) ? datasets : [])
    .map((d) => String(d).trim())
    .filter((d) => CATALOGUE[d]);
const unknown = (Array.isArray(datasets) ? datasets : [])
    .map((d) => String(d).trim())
    .filter((d) => d && !CATALOGUE[d]);
if (unknown.length) log.warning(`Not in the catalogue, ignoring: ${unknown.join(', ')}. Choices: ${Object.keys(CATALOGUE).join(', ')}.`);
if (!wanted.length) {
    log.warning(`No valid datasets. Choose from: ${Object.keys(CATALOGUE).join(', ')}.`);
    await Actor.exit();
}

const geoWanted = (Array.isArray(geographies) ? geographies : [])
    .map((g) => String(g).trim().toLowerCase())
    .filter(Boolean);
const nPeriods = Math.max(1, Math.min(240, Number(periods) || 1));

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;

log.info(`Datasets: ${wanted.join(', ')} | geographies: ${geoWanted.join(', ') || 'all'} | last ${nPeriods} period(s)`);

for (const key of wanted) {
    if (done()) break;
    const meta = CATALOGUE[key];
    const cube = await cubeMetadata(meta.pid);
    if (!cube) {
        log.warning(`${key}: could not read cube metadata for ${meta.pid}; skipping.`);
        continue;
    }
    const dims = cube.dimension || [];
    const geoDim = dims.find((d) => /geograph/i.test(d.dimensionNameEn || '')) || dims[0];
    const geoMembers = (geoDim?.member || []).filter((m) => matchesGeo(m.memberNameEn));
    if (!geoMembers.length) {
        log.warning(`${key}: no geography matched ${geoWanted.join(', ')}. Try "Canada" or a province name.`);
        continue;
    }

    // Every dimension other than geography is pinned to its FIRST member, which
    // is Statistics Canada's convention for the headline total (for example
    // "Total (house and land)" on the housing index). Without that the
    // coordinate is ambiguous and the API returns the wrong slice silently.
    const coordTail = dims.map((d) => (d === geoDim ? null : firstMemberId(d)));

    const requests = [];
    for (const gm of geoMembers) {
        const parts = dims.map((d, i) => (d === geoDim ? gm.memberId : coordTail[i]));
        while (parts.length < 10) parts.push(0);
        requests.push({ geoName: gm.memberNameEn, coordinate: parts.slice(0, 10).join('.') });
    }

    const results = await fetchCoords(meta.pid, requests.map((r) => r.coordinate));
    if (!results) {
        log.warning(`${key}: data request failed; skipping.`);
        continue;
    }
    let emitted = 0;
    for (let i = 0; i < requests.length; i += 1) {
        if (done()) break;
        const res = results[i];
        // An invalid coordinate comes back status FAILED with productId 0 rather
        // than an HTTP error, so a bad slice looks like a successful empty run
        // unless the per-item status is checked.
        if (!res || res.status !== 'SUCCESS' || !res.object) continue;
        for (const p of res.object.vectorDataPoint || []) {
            if (done()) break;
            await pushRow({
                dataset: key,
                label: meta.label,
                geography: requests[i].geoName,
                referencePeriod: str(p.refPer),
                value: num(p.value),
                unit: meta.unit,
                productId: meta.pid,
                vectorId: res.object.vectorId ?? null,
                sourceUrl: `https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=${meta.pid}`,
            });
            emitted += 1;
        }
    }
    log.info(`${key}: ${emitted} row(s) from ${requests.length} coordinate(s).`);
    await sleep(REQ_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- source ----------

async function cubeMetadata(pid) {
    const out = await postJson('getCubeMetadata', [{ productId: pid }]);
    const first = Array.isArray(out) ? out[0] : null;
    return first?.status === 'SUCCESS' ? first.object : null;
}

async function fetchCoords(pid, coordinates) {
    const body = coordinates.map((coordinate) => ({ productId: pid, coordinate, latestN: nPeriods }));
    const out = await postJson('getDataFromCubePidCoordAndLatestNPeriods', body);
    return Array.isArray(out) ? out : null;
}

async function postJson(path, body) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(`${WDS}/${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1200 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${path}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2) {
                log.warning(`request failed ${path}: ${err?.message}`);
                return null;
            }
            await sleep(1200 * (attempt + 1));
        }
    }
    return null;
}

// ---------- helpers ----------

function firstMemberId(dim) {
    const m = (dim?.member || [])[0];
    return m ? m.memberId : 0;
}

function matchesGeo(name) {
    if (!geoWanted.length) return true;
    const n = String(name || '').toLowerCase();
    return geoWanted.some((g) => n === g || n.includes(g));
}

// Statistics Canada suppresses values for confidentiality and returns them as
// null. Number(null) is 0, and a housing start count of 0 is a specific claim,
// so suppressed figures stay null.
function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function str(v) {
    return v === undefined || v === null || v === '' ? null : String(v);
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
