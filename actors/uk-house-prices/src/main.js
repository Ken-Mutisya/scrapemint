// UK House Prices
// Average sale price, index, monthly and annual change and sales volume for any
// UK region, from HM Land Registry's official UK House Price Index. Broken down
// by property type, by first time buyer against former owner occupier, by cash
// against mortgage, and by new build against existing.
//
// Source (keyless JSON, official government data):
//   https://landregistry.data.gov.uk/data/ukhpi/region/{region}/month/{YYYY-MM}.json
//
// Free tier: the first 2 rows of every run are free, then each region row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://landregistry.data.gov.uk/data/ukhpi/region';
const HEADERS = {
    'User-Agent': 'Scrapemint UK House Prices (contact@scrapemint.com)',
    Accept: 'application/json',
};
const REQ_SLEEP_MS = 200;
// The index is published about two months in arrears, so the newest month that
// exists has to be discovered rather than assumed from today's date.
const MAX_MONTH_LOOKBACK = 8;

// Suffixes shared by the averagePrice / housePriceIndex / percentageChange /
// percentageAnnualChange families. '' is the all-property headline figure.
const BREAKDOWNS = [
    ['', 'all property'],
    ['Detached', 'detached'],
    ['SemiDetached', 'semi detached'],
    ['Terraced', 'terraced'],
    ['FlatMaisonette', 'flat or maisonette'],
    ['NewBuild', 'new build'],
    ['ExistingProperty', 'existing property'],
    ['FirstTimeBuyer', 'first time buyer'],
    ['FormerOwnerOccupier', 'former owner occupier'],
    ['Cash', 'cash buyer'],
    ['Mortgage', 'mortgage buyer'],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    regions = ['united-kingdom', 'england', 'london'],
    mode = 'latest',
    monthFrom = '',
    monthTo = '',
    breakdowns = [],
    maxRows = 200,
} = input;

const regionList = (Array.isArray(regions) ? regions : [])
    .map((r) => slugify(r))
    .filter(Boolean);
if (!regionList.length) {
    log.warning('No regions given. Set "regions", e.g. ["england","london","manchester"].');
    await Actor.exit();
}

const isHistory = String(mode) === 'history';
const wantedBreakdowns = (Array.isArray(breakdowns) ? breakdowns : []).map(String).filter(Boolean);

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;

const months = await resolveMonths();
if (!months.length) {
    log.warning('Could not find any month with published data. Set "monthFrom" and "monthTo" explicitly, e.g. 2026-01.');
    await Actor.exit();
}
log.info(`Regions: ${regionList.join(', ')} | months: ${months[0]}${months.length > 1 ? ` to ${months[months.length - 1]}` : ''}`);

for (const region of regionList) {
    if (done()) break;
    let found = 0;
    for (const month of months) {
        if (done()) break;
        const topic = await fetchMonth(region, month);
        if (!topic) continue;
        found += 1;
        await pushRow(buildRow(region, month, topic));
        await sleep(REQ_SLEEP_MS);
    }
    if (!found) log.warning(`${region}: no published data in the requested months. Check the region slug, e.g. "city-of-bristol".`);
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- rows ----------

function buildRow(region, month, t) {
    const row = {
        region: prettyRegion(region),
        regionSlug: region,
        month,
        refPeriodStart: str(t.refPeriodStart),
        averagePrice: num(t.averagePrice),
        averagePriceSeasonallyAdjusted: num(t.averagePriceSA),
        housePriceIndex: num(t.housePriceIndex),
        percentageChangeMonth: num(t.percentageChange),
        percentageChangeYear: num(t.percentageAnnualChange),
        salesVolume: num(t.salesVolume),
        salesVolumeCash: num(t.salesVolumeCash),
        salesVolumeMortgage: num(t.salesVolumeMortgage),
        salesVolumeNewBuild: num(t.salesVolumeNewBuild),
        salesVolumeExistingProperty: num(t.salesVolumeExistingProperty),
        currency: 'GBP',
        sourceUrl: monthUrl(region, month),
    };
    for (const [suffix, label] of BREAKDOWNS) {
        if (!suffix) continue;
        if (wantedBreakdowns.length && !wantedBreakdowns.includes(suffix) && !wantedBreakdowns.includes(label)) continue;
        row[`averagePrice${suffix}`] = num(t[`averagePrice${suffix}`]);
        row[`percentageChangeMonth${suffix}`] = num(t[`percentageChange${suffix}`]);
        row[`percentageChangeYear${suffix}`] = num(t[`percentageAnnualChange${suffix}`]);
    }
    return row;
}

// ---------- source ----------

function monthUrl(region, month) {
    return `${BASE}/${encodeURIComponent(region)}/month/${encodeURIComponent(month)}.json`;
}

// The figures live at result.primaryTopic, NOT result.items: reading `items`
// returns an empty array for every month and reads as "this region has no data"
// when the data is actually there. When a month is unpublished primaryTopic is a
// bare URI STRING rather than an object, so it has to be type checked before use.
async function fetchMonth(region, month) {
    const data = await fetchJson(monthUrl(region, month));
    const topic = data?.result?.primaryTopic;
    return topic && typeof topic === 'object' && !Array.isArray(topic) ? topic : null;
}

async function resolveMonths() {
    const from = normMonth(monthFrom);
    const to = normMonth(monthTo);
    if (isHistory && (from || to)) {
        const start = from || to;
        const end = to || from;
        const out = [];
        let cur = start;
        for (let i = 0; i < 600 && cur <= end; i += 1) {
            out.push(cur);
            cur = addMonth(cur, 1);
        }
        return out;
    }
    if (from) return [from];

    // Walk back from this month until one is published for the first region.
    const probe = regionList[0];
    const now = new Date();
    let cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    for (let i = 0; i < MAX_MONTH_LOOKBACK; i += 1) {
        if (await fetchMonth(probe, cur)) {
            if (!isHistory) return [cur];
            const out = [];
            let m = addMonth(cur, -11);
            for (let j = 0; j < 12; j += 1) { out.push(m); m = addMonth(m, 1); }
            return out;
        }
        cur = addMonth(cur, -1);
        await sleep(REQ_SLEEP_MS);
    }
    return [];
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

// ---------- helpers ----------

// Land Registry values arrive as numbers, but a missing breakdown is simply
// absent. Number(undefined) is NaN and Number(null) is 0, so both are mapped to
// null: a 0 would read as a real average price of nothing.
function num(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function str(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return v._value ?? v.label ?? null;
    return String(v);
}

function slugify(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, '-');
}

function prettyRegion(slug) {
    return String(slug).split('-').map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function normMonth(s) {
    const m = String(s || '').trim().match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : '';
}

function addMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'region_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
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
