// European Economic Indicators: Inflation, Jobs and Growth by Country
//
// What it does
// ------------
// The EU statistics office publishes inflation, unemployment, growth,
// industrial output and public debt for every member state, monthly or
// quarterly rather than once a year. This reads that publication directly and
// returns one row per country per period.
//
//   latest    the most recent value each country has actually published, with
//             the previous period and the change
//   history   every period in the window, per country
//   dataset   any dataset code with your own dimension filters
//
// Distinct from our world-economic-indicators-scraper, which reads World Bank
// annual series for the whole world. This is higher frequency and deeper on
// Europe.
//
// The two traps this handles
// -------------------------
// The response is JSON-stat: values arrive in a SPARSE object keyed by a flat
// index across every dimension. Reading it as a dense list shifts each number
// onto the wrong country, silently, because nothing is missing from the
// output, it is merely wrong. Every value here is decoded back to its
// coordinates through the dimension sizes.
//
// The country list also carries aggregates: the EU, the euro area in several
// vintages, and historic groupings. Ranking or averaging a list that contains
// both the euro area and its members counts the same economies repeatedly, so
// aggregates are labelled and excluded by default.
//
// Pay per event
// -------------
//   indicator_row ($0.003) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 45000;
const SPACING_MS = 700;
const API = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    indicators = ['inflation', 'unemployment', 'gdp_growth'],
    countries = [],
    periods = 6,
    includeAggregates = false,
    datasetCode = '',
    datasetParams = '',
    maxRows = 300,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Curated series, each verified to return data with these exact dimension
// filters. A dataset whose filters do not resolve returns an empty dimension
// rather than an error, so anything not verified is left out on purpose.
const INDICATORS = {
    inflation: {
        dataset: 'prc_hicp_manr',
        params: 'coicop=CP00',
        name: 'Inflation, annual rate of change',
        unitHint: 'percent change on the same month a year earlier',
        frequency: 'monthly',
    },
    unemployment: {
        dataset: 'une_rt_m',
        params: 's_adj=SA&age=TOTAL&unit=PC_ACT&sex=T',
        name: 'Unemployment rate',
        unitHint: 'percent of the active population, seasonally adjusted',
        frequency: 'monthly',
    },
    gdp_growth: {
        dataset: 'namq_10_gdp',
        params: 'unit=CLV_PCH_PRE&s_adj=SCA&na_item=B1GQ',
        name: 'GDP growth on the previous quarter',
        unitHint: 'percent change on the previous quarter, chain linked volumes',
        frequency: 'quarterly',
    },
    industrial_production: {
        dataset: 'sts_inpr_m',
        params: 'nace_r2=B-D&s_adj=SCA&unit=PCH_PRE',
        name: 'Industrial production, change on previous month',
        unitHint: 'percent change on the previous month, seasonally adjusted',
        frequency: 'monthly',
    },
    government_debt: {
        dataset: 'gov_10q_ggdebt',
        params: 'unit=PC_GDP&sector=S13&na_item=GD',
        name: 'General government gross debt',
        unitHint: 'percent of GDP',
        frequency: 'quarterly',
    },
};

// Aggregates published alongside the countries: the EU in its various
// vintages, the euro area, the European Economic Area and EFTA.
const AGGREGATE = /^(EU|EA|EEA|EFTA)(\d|_|$)/;

const theMode = ['latest', 'history', 'dataset'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'latest';
const wantIndicators = asList(indicators).map((s) => s.toLowerCase().replace(/[\s-]+/g, '_'));
const wantCountries = new Set(asList(countries).map((s) => s.toUpperCase()));
const periodCount = Math.max(1, Math.min(120, Number(periods) || 6));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 300));

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        if (attempt < 2) {
            await sleep(900 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 120)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'indicator_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

// JSON-stat decoding. `value` is keyed by a flat index over the dimensions in
// `id` order, row major, and it is SPARSE: missing observations are simply
// absent. Walking it as a dense array would attach each number to whichever
// country happened to sit at that position.
function decode(json) {
    const ids = json?.id || [];
    const sizes = json?.size || [];
    if (!ids.length || ids.length !== sizes.length) return [];
    const strides = new Array(ids.length).fill(1);
    for (let i = ids.length - 2; i >= 0; i -= 1) strides[i] = strides[i + 1] * sizes[i + 1];

    // position -> code, per dimension
    const inverse = {};
    const labels = {};
    for (const dim of ids) {
        const cat = json.dimension?.[dim]?.category || {};
        const idx = cat.index || {};
        const inv = {};
        if (Array.isArray(idx)) idx.forEach((code, pos) => { inv[pos] = code; });
        else for (const [code, pos] of Object.entries(idx)) inv[pos] = code;
        inverse[dim] = inv;
        labels[dim] = cat.label || {};
    }

    const status = json.status || {};
    const out = [];
    for (const [flatKey, value] of Object.entries(json.value || {})) {
        const flat = Number(flatKey);
        if (!Number.isFinite(flat)) continue;
        const coords = {};
        let rest = flat;
        for (let i = 0; i < ids.length; i += 1) {
            const pos = Math.floor(rest / strides[i]);
            rest -= pos * strides[i];
            coords[ids[i]] = inverse[ids[i]]?.[pos] ?? null;
        }
        out.push({
            coords,
            labels: Object.fromEntries(ids.map((d) => [d, labels[d]?.[coords[d]] ?? null])),
            value: typeof value === 'number' ? value : null,
            // Eurostat marks provisional, estimated and break-in-series
            // observations with a status flag against the same index.
            flag: clean(status[flatKey]),
        });
    }
    return out;
}

const wantedGeo = (code) => {
    if (!code) return false;
    const isAgg = AGGREGATE.test(code);
    if (isAgg && !includeAggregates) return false;
    if (wantCountries.size && !wantCountries.has(code)) return false;
    return true;
};

async function fetchSeries(dataset, params, periodsWanted) {
    const url = `${API}/${encodeURIComponent(dataset)}?format=JSON&lang=EN&lastTimePeriod=${periodsWanted}${params ? `&${params}` : ''}`;
    const json = await getJson(url);
    await sleep(SPACING_MS);
    if (!json) return null;
    return { json, decoded: decode(json) };
}

log.info(`Eurostat ${theMode} | ${theMode === 'dataset' ? datasetCode : wantIndicators.join(', ')} | ${periodCount} period(s)`);

async function runIndicator(key) {
    const spec = INDICATORS[key];
    if (!spec) {
        await flushRow({
            type: 'note', found: false, requested: key,
            note: `unknown indicator; use ${Object.keys(INDICATORS).join(', ')}, or switch to dataset mode with any Eurostat dataset code; not charged`,
        }, false);
        return;
    }
    const result = await fetchSeries(spec.dataset, spec.params, theMode === 'latest' ? Math.max(2, periodCount) : periodCount);
    if (!result || !result.decoded.length) {
        await flushRow({
            type: 'note', found: false, indicator: key, dataset: spec.dataset,
            note: 'the series returned no observations; not charged',
        }, false);
        return;
    }
    const { json, decoded } = result;
    const unitLabel = clean(json.dimension?.unit?.category?.label?.[Object.keys(json.dimension?.unit?.category?.index || {})[0]]);

    const byGeo = new Map();
    for (const obs of decoded) {
        const geo = obs.coords.geo;
        if (!wantedGeo(geo)) continue;
        if (obs.value == null) continue;
        if (!byGeo.has(geo)) byGeo.set(geo, []);
        byGeo.get(geo).push(obs);
    }

    const rows = [];
    for (const [geo, list] of byGeo) {
        // Period codes sort correctly as strings for both months (2026-06)
        // and quarters (2026-Q1).
        list.sort((a, b) => String(a.coords.time).localeCompare(String(b.coords.time)));
        const base = {
            indicator: key,
            indicatorName: spec.name,
            dataset: spec.dataset,
            geo,
            country: clean(list[0].labels.geo),
            isAggregate: AGGREGATE.test(geo),
            unit: unitLabel || spec.unitHint,
            unitDescription: spec.unitHint,
            frequency: spec.frequency,
            lastUpdated: clean(json.updated),
            source: 'Eurostat',
            scrapedAt: new Date().toISOString(),
        };
        if (theMode === 'latest') {
            const last = list[list.length - 1];
            const prev = list.length > 1 ? list[list.length - 2] : null;
            rows.push({
                mode: 'latest',
                ...base,
                period: last.coords.time,
                value: round(last.value, 4),
                flag: last.flag,
                previousPeriod: prev ? prev.coords.time : null,
                previousValue: prev ? round(prev.value, 4) : null,
                change: prev ? round(last.value - prev.value, 4) : null,
                direction: prev ? (last.value > prev.value ? 'up' : (last.value < prev.value ? 'down' : 'flat')) : null,
                // Countries publish on different schedules, so the latest
                // period is not the same date for everyone.
                periodsAvailable: list.length,
            });
        } else {
            for (const obs of list) {
                rows.push({
                    mode: 'history',
                    ...base,
                    period: obs.coords.time,
                    value: round(obs.value, 4),
                    flag: obs.flag,
                });
            }
        }
    }
    rows.sort((a, b) => String(b.period).localeCompare(String(a.period))
        || String(a.geo).localeCompare(String(b.geo)));
    for (const row of rows) {
        if (emitted >= rowCap) break;
        await push(row);
    }
    log.info(`${key}: ${rows.length} row(s) from ${byGeo.size} reporter(s)`);
}

if (theMode === 'dataset') {
    const code = clean(datasetCode);
    if (!code) {
        await flushRow({ type: 'note', found: false, note: 'dataset mode needs a dataset code, for example prc_hicp_manr; not charged' }, false);
    } else {
        const result = await fetchSeries(code, String(datasetParams || '').replace(/^[?&]/, ''), periodCount);
        if (!result || !result.decoded.length) {
            await flushRow({
                type: 'note', found: false, dataset: code,
                note: 'no observations returned; a filter value that does not exist in this dataset yields an empty dimension rather than an error, so check the dimension codes; not charged',
            }, false);
        } else {
            const { json, decoded } = result;
            const rows = decoded
                .filter((o) => o.value != null && wantedGeo(o.coords.geo ?? 'NA'))
                .map((o) => ({
                    mode: 'dataset',
                    dataset: code,
                    datasetName: clean(json.label),
                    geo: o.coords.geo ?? null,
                    country: clean(o.labels.geo),
                    isAggregate: o.coords.geo ? AGGREGATE.test(o.coords.geo) : null,
                    period: o.coords.time ?? null,
                    value: round(o.value, 6),
                    flag: o.flag,
                    // Every remaining dimension of the cube, so a row is
                    // self describing whatever the dataset measures.
                    dimensions: Object.fromEntries(Object.entries(o.coords).filter(([k]) => !['geo', 'time'].includes(k))),
                    dimensionLabels: Object.fromEntries(Object.entries(o.labels).filter(([k]) => !['geo', 'time'].includes(k))),
                    lastUpdated: clean(json.updated),
                    source: 'Eurostat',
                    scrapedAt: new Date().toISOString(),
                }));
            rows.sort((a, b) => String(b.period).localeCompare(String(a.period)));
            for (const row of rows) {
                if (emitted >= rowCap) break;
                await push(row);
            }
            log.info(`${code}: ${rows.length} row(s)`);
        }
    }
} else {
    for (const key of wantIndicators) {
        if (emitted >= rowCap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        await runIndicator(key);
    }
}

// Only explain once: a more specific note has usually already been pushed.
if (!emitted && !notePushed) {
    await flushRow({
        type: 'note', found: false,
        note: 'no rows returned; check the indicator names, widen the country filter, or turn on includeAggregates if you only asked for EU wide figures; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
