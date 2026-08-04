// IMF Economic Forecasts
// The IMF's World Economic Outlook numbers for ~230 countries and aggregates:
// GDP growth, inflation, government debt, unemployment and the current account,
// with the IMF's own projections for the years ahead.
//
// Source (keyless JSON):
//   https://www.imf.org/external/datamapper/api/v1/{INDICATOR}
//   https://www.imf.org/external/datamapper/api/v1/indicators | countries | groups | regions
//
// Free tier: the first 2 rows of every run are free, then each data row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://www.imf.org/external/datamapper/api/v1';
const HEADERS = { 'User-Agent': 'Scrapemint IMF Economic Forecasts (contact@scrapemint.com)', Accept: 'application/json' };
const REQ_SLEEP_MS = 250;

const DEFAULT_INDICATORS = ['NGDP_RPCH', 'PCPIPCH', 'GGXWDG_NGDP', 'LUR'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    indicators = DEFAULT_INDICATORS,
    countries = ['USA', 'GBR', 'DEU', 'CHN', 'IND'],
    fromYear = '',
    toYear = '',
    includeAggregates = false,
    maxRows = 300,
} = input;

const indicatorList = (Array.isArray(indicators) ? indicators : [])
    .map((i) => String(i).trim().toUpperCase()).filter(Boolean);
if (!indicatorList.length) {
    log.warning('No indicators given. Try ["NGDP_RPCH","PCPIPCH"].');
    await Actor.exit();
}
const entityWanted = (Array.isArray(countries) ? countries : [])
    .map((c) => String(c).trim()).filter(Boolean);

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 300);
let pushed = 0;

const yearFrom = intOrNull(fromYear);
const yearTo = intOrNull(toYear);

// The API mixes real countries with aggregates such as "Advanced economies"
// under the same value map, so the three reference lists are loaded to label
// each entity rather than presenting a bloc as if it were a country.
const [countryMap, groupMap, regionMap, indicatorMeta] = await Promise.all([
    refList('countries'), refList('groups'), refList('regions'), refList('indicators'),
]);
log.info(`Reference: ${countryMap.size} countries, ${groupMap.size} groups, ${regionMap.size} regions, ${indicatorMeta.size} indicators.`);

for (const code of indicatorList) {
    if (done()) break;
    const meta = indicatorMeta.get(code);
    if (!meta) {
        log.warning(`Unknown indicator "${code}"; skipping. See the indicators list for valid codes.`);
        continue;
    }
    const doc = await fetchJson(`${BASE}/${encodeURIComponent(code)}`);
    const values = doc?.values?.[code];
    if (!values) {
        log.warning(`${code}: no values returned; skipping.`);
        continue;
    }
    // The API does not flag which years are projections, so the boundary is
    // derived from the WEO vintage in the indicator metadata ("World Economic
    // Outlook (April 2026)"). Years from the vintage year onward are the IMF's
    // own forecasts rather than observed outcomes.
    const vintage = String(meta.source || '');
    const vintageYear = Number((vintage.match(/(\d{4})/) || [])[1]) || new Date().getUTCFullYear();

    let emitted = 0;
    for (const [entityCode, byYear] of Object.entries(values)) {
        if (done()) break;
        const entity = resolveEntity(entityCode);
        if (!entity) continue;
        if (!includeAggregates && entity.type !== 'country') continue;
        if (entityWanted.length && !entityMatches(entityCode, entity.label)) continue;

        for (const [year, raw] of Object.entries(byYear)) {
            if (done()) break;
            const y = intOrNull(year);
            if (y === null) continue;
            if (yearFrom !== null && y < yearFrom) continue;
            if (yearTo !== null && y > yearTo) continue;
            await pushRow({
                indicator: code,
                indicatorLabel: meta.label ?? null,
                unit: meta.unit ?? null,
                entity: entity.label,
                entityCode,
                entityType: entity.type,
                year: y,
                // A year the IMF has not published stays null rather than
                // becoming 0, which would read as zero growth.
                value: num(raw),
                isProjection: y >= vintageYear,
                weoVintage: vintage || null,
                sourceUrl: `${BASE}/${code}`,
            });
            emitted += 1;
        }
    }
    log.info(`${code} (${meta.label}): ${emitted} row(s), projections from ${vintageYear}.`);
    await sleep(REQ_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- reference data ----------

async function refList(path) {
    const doc = await fetchJson(`${BASE}/${path}`);
    const map = new Map();
    if (!doc) return map;
    // Each response nests its payload under a single key that is not "api".
    for (const [k, v] of Object.entries(doc)) {
        if (k === 'api' || typeof v !== 'object' || v === null) continue;
        for (const [code, meta] of Object.entries(v)) map.set(code, meta);
    }
    return map;
}

function resolveEntity(code) {
    if (countryMap.has(code)) return { label: countryMap.get(code)?.label ?? code, type: 'country' };
    if (groupMap.has(code)) return { label: groupMap.get(code)?.label ?? code, type: 'group' };
    if (regionMap.has(code)) return { label: regionMap.get(code)?.label ?? code, type: 'region' };
    return null;
}

// Accepts either an ISO3 code or a name. Codes are matched exactly so that a
// short code cannot partially match an unrelated country name.
function entityMatches(code, label) {
    const c = String(code).toUpperCase();
    const l = String(label || '').toLowerCase();
    return entityWanted.some((w) => {
        const u = w.toUpperCase();
        if (u === c) return true;
        return w.length > 3 && l.includes(w.toLowerCase());
    });
}

// ---------- plumbing ----------

async function fetchJson(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1200 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2) {
                log.warning(`fetch failed ${url}: ${err?.message}`);
                return null;
            }
            await sleep(1200 * (attempt + 1));
        }
    }
    return null;
}

function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
    const n = Number(String(v ?? '').trim());
    return Number.isInteger(n) && n !== 0 ? n : null;
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'data_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 200 === 0) log.info(`Pushed ${pushed} rows...`);
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
