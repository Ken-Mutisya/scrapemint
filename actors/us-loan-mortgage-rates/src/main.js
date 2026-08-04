// US Loan and Mortgage Rates
// What Americans actually borrow at: 30 and 15 year mortgages, the bank prime
// rate, credit card APR, new car loans and personal loans, from the Federal
// Reserve's FRED service. Keyless, no browser, no proxy.
//
// Source (keyless CSV):
//   https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES_ID
//
// Free tier: the first 2 rows of every run are free, then each rate row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
// Deliberately NOT a browser User-Agent. FRED hangs on Mozilla/... strings
// rather than answering, which reads as a network fault instead of a block.
const HEADERS = {
    'User-Agent': 'Scrapemint US Loan and Mortgage Rates (contact@scrapemint.com)',
    Accept: 'text/csv,text/plain',
};
const REQ_SLEEP_MS = 150;

// A keyless catalogue: FRED's search endpoint needs an API key, so the ids are
// curated here. `staleAfterDays` is generous enough that an infrequent series is
// not mislabelled: the credit card and loan surveys genuinely publish about
// quarterly, so a 95 day gap is normal for them and alarming for a mortgage.
const CATALOGUE = {
    MORTGAGE30US: { label: '30-year fixed mortgage', category: 'mortgage', frequency: 'weekly', staleAfterDays: 30 },
    MORTGAGE15US: { label: '15-year fixed mortgage', category: 'mortgage', frequency: 'weekly', staleAfterDays: 30 },
    DPRIME: { label: 'Bank prime loan rate', category: 'benchmark', frequency: 'daily', staleAfterDays: 14 },
    DFF: { label: 'Federal funds effective rate', category: 'benchmark', frequency: 'daily', staleAfterDays: 14 },
    TERMCBCCALLNS: { label: 'Credit card interest rate, all accounts', category: 'credit card', frequency: 'quarterly', staleAfterDays: 220 },
    TERMCBAUTO48NS: { label: '48-month new car loan', category: 'auto loan', frequency: 'quarterly', staleAfterDays: 220 },
    RIFLPBCIANM60NM: { label: '60-month new car loan', category: 'auto loan', frequency: 'quarterly', staleAfterDays: 220 },
    TERMCBPER24NS: { label: '24-month personal loan', category: 'personal loan', frequency: 'quarterly', staleAfterDays: 220 },
    // House prices, so a run answers what a home costs alongside what it costs
    // to borrow. These are NOT rates, so they carry their own units and must
    // never be averaged or ranked against the percentages above.
    CSUSHPINSA: { label: 'Case-Shiller national home price index', category: 'house price', frequency: 'monthly', staleAfterDays: 100, unit: 'index, January 2000 = 100' },
    MSPUS: { label: 'Median sale price of houses sold', category: 'house price', frequency: 'quarterly', staleAfterDays: 220, unit: 'US dollars' },
    ASPUS: { label: 'Average sale price of houses sold', category: 'house price', frequency: 'quarterly', staleAfterDays: 220, unit: 'US dollars' },
    // Discontinued upstream. They still answer with their final observation, so
    // they are excluded unless asked for and always carry isStale true.
    MORTGAGE5US: { label: '5/1 adjustable rate mortgage', category: 'mortgage', frequency: 'weekly', staleAfterDays: 30, discontinued: true },
    MMNRNJ: { label: 'Money market account rate', category: 'deposit', frequency: 'weekly', staleAfterDays: 30, discontinued: true },
};
const LIVE_IDS = Object.keys(CATALOGUE).filter((id) => !CATALOGUE[id].discontinued);
const DEFAULT_UNIT = 'percent per year';
// Declared up here, not beside diffFrom, because the main loop runs at top level
// before a const further down the file would be initialised.
const MIN_WINDOW_DAYS = { daily: 1, weekly: 7, monthly: 28, quarterly: 90 };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    series = [],
    includeDiscontinued = false,
    percentileYears = 5,
    historyFrom = '',
    historyTo = '',
    maxRows = 500,
} = input;

const isHistory = String(mode) === 'history';
const requested = (Array.isArray(series) ? series : [])
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);

const unknown = requested.filter((id) => !CATALOGUE[id]);
if (unknown.length) {
    log.warning(`Not in this actor's catalogue, ignoring: ${unknown.join(', ')}. Available: ${Object.keys(CATALOGUE).join(', ')}.`);
}
let ids = requested.filter((id) => CATALOGUE[id]);
if (!ids.length) ids = includeDiscontinued ? Object.keys(CATALOGUE) : LIVE_IDS;
else if (!includeDiscontinued) ids = ids.filter((id) => !CATALOGUE[id].discontinued || requested.includes(id));

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 500);
let pushed = 0;

log.info(`Mode ${isHistory ? 'history' : 'latest'} | series: ${ids.join(', ')}`);

for (const id of ids) {
    if (done()) break;
    const meta = CATALOGUE[id];
    const obs = await fetchSeries(id);
    if (obs === null) {
        log.warning(`${id}: fetch failed, skipping.`);
        continue;
    }
    if (!obs.length) {
        log.warning(`${id}: no observations with a value.`);
        continue;
    }
    if (isHistory) {
        const from = String(historyFrom || '').trim();
        const to = String(historyTo || '').trim();
        const window = obs.filter((o) => (!from || o.date >= from) && (!to || o.date <= to));
        log.info(`${id}: ${window.length} observation(s) in range.`);
        for (const o of window) {
            if (done()) break;
            await pushRow({
                seriesId: id,
                label: meta.label,
                category: meta.category,
                rate: o.value,
                unit: meta.unit || DEFAULT_UNIT,
                observationDate: o.date,
                frequency: meta.frequency,
                sourceUrl: seriesUrl(id),
            });
        }
    } else {
        await pushRow(buildLatest(id, meta, obs));
    }
    await sleep(REQ_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} row(s).`);
await Actor.exit();

// ---------- rows ----------

function buildLatest(id, meta, obs) {
    const last = obs[obs.length - 1];
    const asOf = new Date(`${last.date}T00:00:00Z`).getTime();
    const ageDays = Math.floor((Date.now() - asOf) / 86400000);
    // A discontinued series keeps answering with its final value, which reads as
    // today's rate unless it is flagged. Age is measured against the series'
    // own publication rhythm, so a quarterly survey is not called stale for
    // behaving quarterly.
    const isStale = Boolean(meta.discontinued) || ageDays > meta.staleAfterDays;
    const windowStart = isoDaysAgo(Math.round(365.25 * (Number(percentileYears) || 5)));
    const windowVals = obs.filter((o) => o.date >= windowStart).map((o) => o.value);

    return {
        seriesId: id,
        label: meta.label,
        category: meta.category,
        rate: last.value,
        unit: meta.unit || DEFAULT_UNIT,
        observationDate: last.date,
        frequency: meta.frequency,
        // Every change is null when the series does not reach back that far, so
        // an absent comparison can never publish as a 0.00 point move.
        changeWeek: diffFrom(obs, last, 7, meta.frequency),
        changeMonth: diffFrom(obs, last, 30, meta.frequency),
        changeYear: diffFrom(obs, last, 365, meta.frequency),
        percentileRank: percentileOf(windowVals, last.value),
        windowYears: Number(percentileYears) || 5,
        windowLow: windowVals.length ? Math.min(...windowVals) : null,
        windowHigh: windowVals.length ? Math.max(...windowVals) : null,
        windowMedian: median(windowVals),
        isStale,
        discontinued: Boolean(meta.discontinued),
        daysSinceObservation: ageDays,
        sourceUrl: seriesUrl(id),
    };
}

// "A month ago" resolves to the newest observation at or before that date, never
// a fixed row offset: the catalogue mixes daily, weekly and quarterly series and
// an offset would make a quarterly series look a year stale.
//
// A window shorter than the series' own publication interval returns null (see
// MIN_WINDOW_DAYS up top). A quarterly survey has no weekly move, and resolving
// both "a week ago" and "a month ago" to the same prior quarter would report an
// identical figure for both, reading as a measured weekly change that was never
// observed.
function diffFrom(obs, last, daysBack, frequency) {
    if (daysBack < (MIN_WINDOW_DAYS[frequency] ?? 1)) return null;
    const target = isoDaysAgo(daysBack, new Date(`${last.date}T00:00:00Z`));
    let prev = null;
    for (const o of obs) {
        if (o.date <= target) prev = o;
        else break;
    }
    if (!prev || prev.date === last.date) return null;
    return round(last.value - prev.value, 4);
}

function percentileOf(values, v) {
    if (!values.length || typeof v !== 'number') return null;
    const below = values.filter((x) => x <= v).length;
    return Math.round((below / values.length) * 100);
}

function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2, 4);
}

// ---------- source ----------

function seriesUrl(id) {
    return `${BASE}?id=${encodeURIComponent(id)}`;
}

// One series per request. Asking for three or more ids at once makes FRED return
// a ZIP archive rather than CSV (two still come back as CSV), so batching here
// would silently produce an unparseable body.
async function fetchSeries(id) {
    const text = await fetchText(seriesUrl(id));
    if (text === null) return null;
    // An unknown id answers 200-looking HTML rather than CSV, so the header is
    // checked before anything is parsed.
    if (!text.startsWith('observation_date')) {
        log.warning(`${id}: response is not a FRED CSV (unknown series id?).`);
        return null;
    }
    const out = [];
    for (const line of text.split('\n').slice(1)) {
        const [date, raw] = line.split(',');
        if (!date) continue;
        const v = parseRate(raw);
        // A holiday or unsurveyed period keeps its row with an empty value, and
        // Number('') is 0. Dropping the row is the only safe reading; a 0.00%
        // mortgage would otherwise be published as fact.
        if (v === null) continue;
        out.push({ date: date.trim(), value: v });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
}

function parseRate(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!s || s === '.') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

async function fetchText(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1000 * (attempt + 1));
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
            await sleep(1000 * (attempt + 1));
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
        await Actor.charge({ eventName: 'rate_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
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

function isoDaysAgo(days, from = new Date()) {
    return new Date(from.getTime() - days * 86400000).toISOString().slice(0, 10);
}

function round(n, dp) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
