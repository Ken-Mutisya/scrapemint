// US Rent and Home Price Index
// What a typical home is worth and what typical rent costs, by state, metro,
// city or zip, from Zillow's published research indexes. Monthly, back to 2000
// for home values and 2015 for rent.
//
// Sources (keyless CSV on a static CDN, no proxy):
//   .../public_csvs/zhvi/{Level}_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv
//   .../public_csvs/zori/{Level}_zori_uc_sfrcondomfr_sm_month.csv
//
// Free tier: the first 2 rows of every run are free, then each region row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://files.zillowstatic.com/research/public_csvs';
const HEADERS = {
    'User-Agent': 'Scrapemint US Rent and Home Price Index (contact@scrapemint.com)',
    Accept: 'text/csv,text/plain',
};

// Zillow splits every metric across a file per geography. `zhviMb` is the rough
// download size: the city level home value file is ~93MB, an order of magnitude
// past the others, so it is allowed but never the default.
//
// `hasRent` is false for states because Zillow does not publish the rent index
// at state level at all (every ZORI State filename 404s). That is a gap in the
// source, not a download failure, and saying so beats logging an error.
const LEVELS = {
    state: { file: 'State', label: 'state', zhviMb: 0.3, hasRent: false },
    metro: { file: 'Metro', label: 'metro', zhviMb: 4.4, hasRent: true },
    county: { file: 'County', label: 'county', zhviMb: 13, hasRent: true },
    city: { file: 'City', label: 'city', zhviMb: 93, hasRent: true },
    zip: { file: 'Zip', label: 'zip', zhviMb: 60, hasRent: true },
};
const BIG_FILE_MB = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    geography = 'metro',
    regions = [],
    metrics = ['rent', 'homeValue'],
    historyFrom = '',
    historyTo = '',
    maxRows = 200,
} = input;

const level = LEVELS[String(geography).toLowerCase()] ? String(geography).toLowerCase() : 'metro';
if (!LEVELS[String(geography).toLowerCase()]) {
    log.warning(`Unknown geography "${geography}"; using metro. Choices: ${Object.keys(LEVELS).join(', ')}.`);
}
const isHistory = String(mode) === 'history';
const wantRent = (Array.isArray(metrics) ? metrics : []).map(String).includes('rent');
const wantHome = (Array.isArray(metrics) ? metrics : []).map(String).includes('homeValue');
const wantedMetrics = wantRent || wantHome ? { rent: wantRent, home: wantHome } : { rent: true, home: true };

const filters = (Array.isArray(regions) ? regions : [])
    .map((r) => String(r).trim().toLowerCase())
    .filter(Boolean);

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;

if (wantedMetrics.home && LEVELS[level].zhviMb >= BIG_FILE_MB) {
    log.warning(`The ${level} home value file is about ${LEVELS[level].zhviMb}MB and takes a while to download. Use geography "metro" or "state" if you do not need this level.`);
}

log.info(`Mode ${isHistory ? 'history' : 'latest'} | geography ${level} | metrics ${Object.entries(wantedMetrics).filter(([, v]) => v).map(([k]) => k).join(', ')}${filters.length ? ` | filter: ${filters.join(', ')}` : ''}`);

if (wantedMetrics.rent && !LEVELS[level].hasRent) {
    log.info(`Zillow does not publish the rent index at ${level} level, so rent fields will be null. Use metro, county, city or zip for rent.`);
}
const loadRent = wantedMetrics.rent && LEVELS[level].hasRent;
const rent = loadRent ? await loadSeries('zori', `${LEVELS[level].file}_zori_uc_sfrcondomfr_sm_month.csv`) : new Map();
const home = wantedMetrics.home ? await loadSeries('zhvi', `${LEVELS[level].file}_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv`) : new Map();

if (!rent.size && !home.size) {
    log.warning('No data loaded from Zillow; nothing to emit.');
    await Actor.exit();
}

// RegionID is the shared key across the two files: 719 of 734 metros carry both.
const regionIds = new Set([...rent.keys(), ...home.keys()]);
const merged = [];
for (const id of regionIds) {
    const r = rent.get(id);
    const h = home.get(id);
    const meta = r || h;
    if (!matchesFilter(meta)) continue;
    merged.push({ id, meta, rent: r, home: h });
}
// SizeRank alone repeats across regions, so name is the tiebreak and the sort
// cannot reorder equal-ranked regions between runs.
merged.sort((a, b) => numOr(a.meta.sizeRank, 1e9) - numOr(b.meta.sizeRank, 1e9)
    || String(a.meta.regionName).localeCompare(String(b.meta.regionName)));

log.info(`${merged.length} region(s) after filtering.`);

for (const m of merged) {
    if (done()) break;
    if (isHistory) {
        for (const row of historyRows(m)) {
            if (done()) break;
            await pushRow(row);
        }
    } else {
        await pushRow(latestRow(m));
    }
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- rows ----------

function latestRow(m) {
    const rentLatest = lastPoint(m.rent);
    const homeLatest = lastPoint(m.home);
    return {
        regionId: Number(m.id),
        regionName: m.meta.regionName,
        regionType: LEVELS[level].label,
        state: m.meta.stateName || null,
        sizeRank: numOrNull(m.meta.sizeRank),
        rentIndex: rentLatest ? round(rentLatest.value, 2) : null,
        rentAsOf: rentLatest ? rentLatest.date : null,
        rentChangeMonthPct: pctChange(m.rent, rentLatest, 1),
        rentChangeYearPct: pctChange(m.rent, rentLatest, 12),
        homeValue: homeLatest ? round(homeLatest.value, 2) : null,
        homeValueAsOf: homeLatest ? homeLatest.date : null,
        homeChangeMonthPct: pctChange(m.home, homeLatest, 1),
        homeChangeYearPct: pctChange(m.home, homeLatest, 12),
        // Gross yield only exists when BOTH sides were published for this
        // region. A region with rent but no home value returns null, never 0.
        rentToPriceYieldPct: grossYield(rentLatest, homeLatest),
        rentUnit: 'US dollars per month',
        homeValueUnit: 'US dollars',
    };
}

function* historyRows(m) {
    const dates = new Set([...(m.rent?.points || []).map((p) => p.date), ...(m.home?.points || []).map((p) => p.date)]);
    const from = String(historyFrom || '').trim();
    const to = String(historyTo || '').trim();
    const rentBy = byDate(m.rent);
    const homeBy = byDate(m.home);
    for (const date of [...dates].sort()) {
        if (from && date < from) continue;
        if (to && date > to) continue;
        const rv = rentBy.get(date);
        const hv = homeBy.get(date);
        if (rv === undefined && hv === undefined) continue;
        yield {
            regionId: Number(m.id),
            regionName: m.meta.regionName,
            regionType: LEVELS[level].label,
            state: m.meta.stateName || null,
            observationDate: date,
            rentIndex: rv === undefined ? null : round(rv, 2),
            homeValue: hv === undefined ? null : round(hv, 2),
            rentUnit: 'US dollars per month',
            homeValueUnit: 'US dollars',
        };
    }
}

// Rent and home value have different histories (rent starts 2015, home values
// 2000), so a percentage move is only reported when the earlier month actually
// exists for that same series.
function pctChange(series, latest, monthsBack) {
    if (!series || !latest) return null;
    const idx = series.points.findIndex((p) => p.date === latest.date);
    const prev = series.points[idx - monthsBack];
    if (!prev || !Number.isFinite(prev.value) || prev.value === 0) return null;
    return round(((latest.value - prev.value) / prev.value) * 100, 2);
}

function grossYield(rentLatest, homeLatest) {
    if (!rentLatest || !homeLatest) return null;
    if (!Number.isFinite(homeLatest.value) || homeLatest.value === 0) return null;
    return round(((rentLatest.value * 12) / homeLatest.value) * 100, 2);
}

function lastPoint(series) {
    if (!series || !series.points.length) return null;
    return series.points[series.points.length - 1];
}

function byDate(series) {
    const m = new Map();
    for (const p of series?.points || []) m.set(p.date, p.value);
    return m;
}

function matchesFilter(meta) {
    if (!filters.length) return true;
    const hay = `${meta.regionName} ${meta.stateName || ''}`.toLowerCase();
    return filters.some((f) => hay.includes(f));
}

// ---------- source ----------

// The files are wide: five identifier columns then one column per month, so a
// row has to be pivoted into dated points. A blank cell means the index was not
// published for that month and is skipped rather than read as 0.
async function loadSeries(kind, filename) {
    const url = `${BASE}/${kind}/${filename}`;
    const text = await fetchText(url);
    const out = new Map();
    if (text === null) {
        log.warning(`Could not download ${kind} for ${level}.`);
        return out;
    }
    const lines = text.split('\n');
    const header = splitCsv(lines[0]);
    if (header[0] !== 'RegionID') {
        log.warning(`${url} did not return the expected CSV header.`);
        return out;
    }
    const dates = header.slice(5).map((d) => d.trim());
    for (let i = 1; i < lines.length; i += 1) {
        const cells = splitCsv(lines[i]);
        if (cells.length < 6 || !cells[0]) continue;
        const points = [];
        for (let c = 5; c < cells.length && c - 5 < dates.length; c += 1) {
            const v = parseNum(cells[c]);
            if (v === null) continue;
            points.push({ date: dates[c - 5], value: v });
        }
        if (!points.length) continue;
        out.set(cells[0], {
            regionName: cells[2],
            regionType: cells[3],
            stateName: cells[4],
            sizeRank: cells[1],
            points,
        });
    }
    log.info(`${kind}: ${out.size} region(s), latest ${dates[dates.length - 1]}.`);
    return out;
}

// Region names contain commas ("Austin, TX") so the identifier columns are
// quoted; a plain split on comma would shift every month column by one.
function splitCsv(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
            out.push(cur); cur = '';
        } else if (ch !== '\r') {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function parseNum(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

async function fetchText(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return await res.text();
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

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'region_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
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

function numOr(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function round(n, dp) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
