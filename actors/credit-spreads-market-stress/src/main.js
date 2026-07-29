// Credit Spreads, VIX & Financial Stress: Market Risk Data
//
// What it does
// ------------
// The risk dashboard a macro desk actually watches, as clean rows: what
// lenders charge risky borrowers over government debt, how much equity and
// commodity volatility is priced, where the yield curve sits, and what the
// official financial conditions indexes say. Credit spreads widen before
// equities break, which is why they are the first panel on the screen.
//
//   latest      one row per series: the newest value, the move over a week,
//               a month, three months and a year, and where the level sits
//               inside its own trailing range
//   history     one row per series per date over any window
//   catalogue   the series this actor covers, with units and frequency
//
// A level on its own says nothing. A high yield spread of 2.8 per cent is
// either the calmest credit market in a decade or a warning, depending on
// where it sits in its own history, so every latest row carries the
// percentile rank and the distance from its trailing high and low.
//
// Distinct from our government-bond-yields-worldwide (the level of risk free
// rates) and us-treasury-rates-scraper (one country in depth). This is the
// risk premium on top and the stress gauges around it.
//
// Pay per event
// -------------
//   indicator_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 250;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    categories = ['credit', 'volatility'],
    series = [],
    lookbackDays = 365,
    daysBack = 90,
    startDate = '',
    endDate = '',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A holiday inside a daily series comes back as an EMPTY field rather than a
// missing row, so the 10 year yield on Independence Day reads as an empty
// string. Number('') is 0, which would publish a 0.00 per cent yield as if it
// were real.
const numOrNull = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '.' || s === 'NA') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const normDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);
const shiftDays = (iso, days) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000));

const theMode = ['latest', 'history', 'catalogue'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'latest';
const lookback = Math.max(30, Math.min(3650, Number(lookbackDays) || 365));
const back = Math.max(1, Math.min(3650, Number(daysBack) || 90));
const toDay = normDay(endDate) || isoDay(new Date());
const fromDay = normDay(startDate) || shiftDays(toDay, -back);
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// Units are NOT interchangeable. An option adjusted spread is a percentage
// over government debt, a volatility index is annualised per cent, a
// conditions index is standard deviations from its own mean. Averaging or
// ranking across them is meaningless, so the unit rides on every row.
const UNIT = {
    SPREAD: 'percentage points over government bonds (option adjusted spread)',
    YIELD: 'per cent per annum',
    VOL: 'index points (annualised implied volatility, per cent)',
    STDEV: 'standard deviations from the series own average (0 is average conditions)',
    INDEX: 'index level',
};

// Every series here was verified live before shipping. A series that did not
// return data was dropped rather than shipped broken.
const CATALOGUE = [
    { id: 'BAMLH0A0HYM2', name: 'US high yield corporate bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLC0A0CM', name: 'US investment grade corporate bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLC0A4CBBB', name: 'US BBB rated corporate bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLH0A3HYC', name: 'US CCC and lower rated bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLHE00EHYIOAS', name: 'Euro high yield corporate bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLEMCBPIOAS', name: 'Emerging markets corporate bond spread', category: 'credit', unit: UNIT.SPREAD, frequency: 'daily' },
    { id: 'BAMLH0A0HYM2EY', name: 'US high yield effective yield', category: 'credit', unit: UNIT.YIELD, frequency: 'daily' },

    { id: 'VIXCLS', name: 'S&P 500 volatility index (VIX)', category: 'volatility', unit: UNIT.VOL, frequency: 'daily' },
    { id: 'VXNCLS', name: 'Nasdaq 100 volatility index', category: 'volatility', unit: UNIT.VOL, frequency: 'daily' },
    { id: 'OVXCLS', name: 'Crude oil volatility index', category: 'volatility', unit: UNIT.VOL, frequency: 'daily' },
    { id: 'GVZCLS', name: 'Gold volatility index', category: 'volatility', unit: UNIT.VOL, frequency: 'daily' },

    { id: 'T10Y2Y', name: '10 year minus 2 year Treasury spread', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'T10Y3M', name: '10 year minus 3 month Treasury spread', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'DGS10', name: '10 year Treasury yield', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'DGS2', name: '2 year Treasury yield', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'DFII10', name: '10 year inflation protected (real) yield', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'T10YIE', name: '10 year inflation expectations (breakeven)', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },
    { id: 'T5YIFR', name: '5 year forward inflation expectation rate', category: 'rates', unit: UNIT.YIELD, frequency: 'daily' },

    { id: 'NFCI', name: 'Chicago Fed national financial conditions index', category: 'conditions', unit: UNIT.STDEV, frequency: 'weekly' },
    { id: 'ANFCI', name: 'Chicago Fed adjusted financial conditions index', category: 'conditions', unit: UNIT.STDEV, frequency: 'weekly' },
    { id: 'STLFSI4', name: 'St Louis Fed financial stress index', category: 'conditions', unit: UNIT.STDEV, frequency: 'weekly' },

    { id: 'DTWEXBGS', name: 'US dollar index, broad trade weighted', category: 'dollar', unit: UNIT.INDEX, frequency: 'daily' },
    { id: 'DTWEXAFEGS', name: 'US dollar index against advanced economies', category: 'dollar', unit: UNIT.INDEX, frequency: 'daily' },
];

const BY_ID = new Map(CATALOGUE.map((s) => [s.id, s]));
const CATEGORIES = [...new Set(CATALOGUE.map((s) => s.category))];

// Which series this run should read.
const requestedIds = asList(series).map((s) => s.toUpperCase());
// Catalogue mode is a directory, so with no explicit filter it lists every
// series rather than inheriting the data modes' default categories.
const categoriesSupplied = Object.prototype.hasOwnProperty.call(input, 'categories')
    && asList(input.categories).length > 0;
const requestedCats = (categoriesSupplied || theMode !== 'catalogue' ? asList(categories) : [])
    .map((s) => s.toLowerCase());
const unknownIds = requestedIds.filter((id) => !BY_ID.has(id));
const unknownCats = requestedCats.filter((c) => !CATEGORIES.includes(c));

const askedForSomething = requestedIds.length > 0 || requestedCats.length > 0;
let selected;
if (requestedIds.length) {
    selected = requestedIds.filter((id) => BY_ID.has(id)).map((id) => BY_ID.get(id));
} else if (requestedCats.length) {
    selected = CATALOGUE.filter((s) => requestedCats.includes(s.category));
} else {
    // No filter at all: the catalogue lists everything, the data modes read
    // the whole set too.
    selected = CATALOGUE.slice();
}
// If the caller named series or categories and none of them resolved, the
// run ends with an explanation. Falling back to a default set would bill for
// rows nobody asked for.
const nothingResolved = askedForSomething && selected.length === 0;

let emitted = 0;
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

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

// One request per series: asking for several ids at once returns a ZIP
// archive rather than CSV, which is not what a caller expecting a table
// would get.
async function fetchSeries(id, from, to, attempt = 0) {
    const url = `${BASE}?id=${encodeURIComponent(id)}&cosd=${from}&coed=${to}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'text/csv', 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        // An unrecognised id answers 404 with an HTML page, so a body that
        // does not start with the CSV header is never parsed as data.
        if (res.status === 404) return { error: 'series not published under that identifier' };
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const body = await res.text();
        if (!/^observation_date/i.test(body.trim())) return { error: 'response was not the expected CSV' };
        const observations = [];
        for (const line of body.trim().split(/\r?\n/).slice(1)) {
            const [date, raw] = line.split(',');
            const day = normDay(date);
            const value = numOrNull(raw);
            // A holiday keeps its row with an empty value. Dropping it is
            // right; recording it as zero is not.
            if (!day || value == null) continue;
            observations.push({ date: day, value });
        }
        observations.sort((a, b) => a.date.localeCompare(b.date));
        return { observations };
    } catch (err) {
        if (attempt < 2) {
            await sleep(800 * (attempt + 1));
            return fetchSeries(id, from, to, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// Series publish on different calendars, so "a month ago" must resolve to the
// most recent observation at or before that date rather than counting rows
// back. Counting rows would make a weekly index look a month older than it is.
const valueAsOf = (observations, targetDate) => {
    let found = null;
    for (const o of observations) {
        if (o.date <= targetDate) found = o; else break;
    }
    return found;
};

const percentileRank = (values, value) => {
    if (!values.length) return null;
    const below = values.filter((v) => v < value).length;
    const equal = values.filter((v) => v === value).length;
    return ((below + equal / 2) / values.length) * 100;
};

const todayIso = isoDay(new Date());
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

log.info(`Market stress ${theMode} | ${selected.length} series | ${theMode === 'history' ? `${fromDay} to ${toDay}` : `lookback ${lookback}d`}`);
if (unknownIds.length) {
    await note({
        unknownSeries: unknownIds,
        note: `not in this actor's catalogue: ${unknownIds.join(', ')}; run catalogue mode to list every covered series; not charged`,
    });
}
if (unknownCats.length) {
    await note({
        unknownCategories: unknownCats,
        note: `not a covered category: ${unknownCats.join(', ')}; categories are ${CATEGORIES.join(', ')}; not charged`,
    });
}

if (nothingResolved) {
    await note({
        note: 'nothing in this run resolved to a covered series, so no rows were returned and nothing was charged; run catalogue mode to list every covered series and category',
    });
} else if (theMode === 'catalogue') {
    for (const s of selected) {
        if (emitted >= rowCap) break;
        await push({
            mode: 'catalogue',
            seriesId: s.id,
            name: s.name,
            category: s.category,
            unit: s.unit,
            frequency: s.frequency,
            sourceName: 'Federal Reserve Bank of St Louis (FRED)',
            sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
            scrapedAt: new Date().toISOString(),
        });
    }
} else {
    const from = theMode === 'history' ? fromDay : shiftDays(todayIso, -(lookback + 30));
    const to = theMode === 'history' ? toDay : todayIso;

    for (const s of selected) {
        if (emitted >= rowCap || pastDeadline()) break;
        const res = await fetchSeries(s.id, from, to);
        if (res.error || !res.observations?.length) {
            await note({
                seriesId: s.id, name: s.name,
                note: `${s.name} (${s.id}) returned no data: ${res.error || 'empty series in this window'}; not charged`,
            });
            await sleep(SPACING_MS);
            continue;
        }
        const obs = res.observations;
        log.info(`${s.id}: ${obs.length} observation(s), latest ${obs[obs.length - 1].date}`);

        if (theMode === 'history') {
            for (const o of obs) {
                if (emitted >= rowCap) break;
                await push({
                    mode: 'history',
                    seriesId: s.id,
                    name: s.name,
                    category: s.category,
                    date: o.date,
                    value: o.value,
                    unit: s.unit,
                    frequency: s.frequency,
                    sourceName: 'Federal Reserve Bank of St Louis (FRED)',
                    sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
                    scrapedAt: new Date().toISOString(),
                });
            }
            await sleep(SPACING_MS);
            continue;
        }

        const latest = obs[obs.length - 1];
        const previous = obs.length > 1 ? obs[obs.length - 2] : null;
        const window = obs.filter((o) => o.date >= shiftDays(latest.date, -lookback));
        const values = window.map((o) => o.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const sorted = [...values].sort((a, b) => a - b);
        const median = sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);

        const moveTo = (days) => {
            const ref = valueAsOf(obs, shiftDays(latest.date, -days));
            if (!ref || ref.date === latest.date) return { change: null, refDate: null };
            return { change: round(latest.value - ref.value, 4), refDate: ref.date };
        };
        const w1 = moveTo(7);
        const m1 = moveTo(30);
        const m3 = moveTo(91);
        const y1 = moveTo(365);
        const isSpreadLike = s.unit === UNIT.SPREAD || s.unit === UNIT.YIELD;
        const lag = daysBetween(latest.date, todayIso);
        // A series that stopped publishing still answers with its final value,
        // which would otherwise read as today's level.
        const staleLimit = s.frequency === 'weekly' ? 21 : 10;

        await push({
            mode: 'latest',
            seriesId: s.id,
            name: s.name,
            category: s.category,
            unit: s.unit,
            frequency: s.frequency,
            latestValue: latest.value,
            latestDate: latest.date,
            publicationLagDays: lag,
            isStale: lag > staleLimit,
            previousValue: previous ? previous.value : null,
            previousDate: previous ? previous.date : null,
            changeFromPrevious: previous ? round(latest.value - previous.value, 4) : null,
            changeFromPreviousBasisPoints: previous && isSpreadLike
                ? round((latest.value - previous.value) * 100, 1) : null,
            change1Week: w1.change,
            change1WeekFromDate: w1.refDate,
            change1Month: m1.change,
            change1MonthFromDate: m1.refDate,
            change3Months: m3.change,
            change3MonthsFromDate: m3.refDate,
            change1Year: y1.change,
            change1YearFromDate: y1.refDate,
            // Context is the point: a level means nothing without knowing
            // where it sits in its own recent history.
            lookbackDays: lookback,
            observationsInLookback: values.length,
            percentileRankInLookback: round(percentileRank(values, latest.value), 1),
            zScoreInLookback: sd > 0 ? round((latest.value - mean) / sd, 3) : null,
            lookbackLow: round(min, 4),
            lookbackHigh: round(max, 4),
            lookbackMedian: round(median, 4),
            aboveLookbackMedian: latest.value > median,
            atLookbackHigh: latest.value >= max,
            atLookbackLow: latest.value <= min,
            unitsCaveat: 'levels are only comparable within the same unit; spreads, volatility indexes and conditions indexes are different measures',
            sourceName: 'Federal Reserve Bank of St Louis (FRED)',
            sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`,
            scrapedAt: new Date().toISOString(),
        });
        await sleep(SPACING_MS);
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the series ids or categories requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
