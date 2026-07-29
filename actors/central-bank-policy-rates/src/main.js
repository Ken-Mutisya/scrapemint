// Central Bank Interest Rates: Policy Rates and Rate Changes
//
// What it does
// ------------
// What each major central bank currently charges, and the thing nobody
// publishes as one clean table: the history of every rate DECISION. When each
// bank last moved, by how many basis points, in which direction, how long it
// has held, and whether it is tightening, easing or on hold.
//
//   latest    one row per central bank: the current rate, how long it has
//             been at that level, the last change and the 12 month picture
//   changes   one row per rate change: date, from, to, move in basis points
//   history   one row per published observation
//
// Covered: US Federal Reserve, European Central Bank, Bank of England, Bank
// of Canada, Reserve Bank of Australia, and Japan as a clearly labelled
// proxy. All keyless, no browser.
//
// Pay per event
// -------------
//   rate_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 250;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    banks = ['fed', 'ecb', 'boe', 'boc', 'rba', 'boj'],
    yearsBack = 3,
    startDate = '',
    endDate = '',
    maxRows = 300,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An empty cell is a rate that has not been published yet, never a rate of
// zero. Both the Bank of England and the Reserve Bank of Australia publish a
// row for today with the rate column still blank.
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const theMode = ['latest', 'changes', 'history'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'latest';
const years = Math.max(1, Math.min(60, Number(yearsBack) || 3));
const todayIso = isoDay(new Date());
const to = normDay(endDate) || todayIso;
const from = normDay(startDate)
    || isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - years * 365.25 * 86400000));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 300));

const BANKS = {
    fed: {
        name: 'US Federal Reserve', country: 'United States', currency: 'USD',
        rateName: 'federal funds target range',
        // The Fed sets a RANGE, not a single number. Reporting the upper
        // bound alone as "the Fed rate" hides half the policy setting.
        kind: 'range',
        sourceName: 'Federal Reserve Bank of St Louis (FRED)',
        sourceUrl: 'https://fred.stlouisfed.org/series/DFEDTARU',
    },
    ecb: {
        name: 'European Central Bank', country: 'Euro area', currency: 'EUR',
        rateName: 'deposit facility rate',
        // The ECB publishes three key rates. Since 2022 the deposit facility
        // is the one that steers market rates, so it is the headline here and
        // the other two ship alongside it rather than being left out.
        kind: 'multi',
        sourceName: 'Federal Reserve Bank of St Louis (FRED), ECB data',
        sourceUrl: 'https://fred.stlouisfed.org/series/ECBDFR',
    },
    boe: {
        name: 'Bank of England', country: 'United Kingdom', currency: 'GBP',
        rateName: 'Bank Rate',
        sourceName: 'Bank of England (IADB)',
        sourceUrl: 'https://www.bankofengland.co.uk/boeapps/database',
    },
    boc: {
        name: 'Bank of Canada', country: 'Canada', currency: 'CAD',
        rateName: 'target for the overnight rate',
        sourceName: 'Bank of Canada (Valet)',
        sourceUrl: 'https://www.bankofcanada.ca/valet/',
    },
    rba: {
        name: 'Reserve Bank of Australia', country: 'Australia', currency: 'AUD',
        rateName: 'cash rate target',
        sourceName: 'Reserve Bank of Australia (table F1)',
        sourceUrl: 'https://www.rba.gov.au/statistics/tables/',
    },
    boj: {
        name: 'Bank of Japan', country: 'Japan', currency: 'JPY',
        rateName: 'immediate rate (call money), monthly average',
        // Japan has no clean keyless series for the BoJ's own published
        // target. This is an OECD compiled monthly rate that tracks policy
        // closely but is NOT the announced target, and it lags. Shipping it
        // unlabelled would be the dishonest option; leaving Japan out of a
        // world policy rate table would be the unhelpful one.
        isProxy: true,
        proxyNote: 'this is an OECD compiled monthly average of the overnight call rate, not the Bank of Japan published policy target, and it lags by roughly two months',
        sourceName: 'Federal Reserve Bank of St Louis (FRED), OECD data',
        sourceUrl: 'https://fred.stlouisfed.org/series/IRSTCI01JPM156N',
    },
};

const aliases = {
    fed: 'fed', us: 'fed', usa: 'fed', fomc: 'fed', 'federal reserve': 'fed',
    ecb: 'ecb', eu: 'ecb', euro: 'ecb', 'euro area': 'ecb', eurozone: 'ecb',
    boe: 'boe', uk: 'boe', 'bank of england': 'boe', england: 'boe', britain: 'boe',
    boc: 'boc', canada: 'boc', 'bank of canada': 'boc',
    rba: 'rba', australia: 'rba', aus: 'rba',
    boj: 'boj', japan: 'boj', 'bank of japan': 'boj',
};
const requested = asList(banks);
const bankKeys = [];
const unknownBanks = [];
for (const b of requested) {
    const k = aliases[String(b).toLowerCase()];
    if (k) { if (!bankKeys.includes(k)) bankKeys.push(k); } else unknownBanks.push(b);
}
const useBanks = bankKeys.length ? bankKeys : Object.keys(BANKS);

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'rate_row' }); }
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

async function fetchText(url, { attempt = 0, accept = '*/*' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal, redirect: 'follow',
            headers: { accept, 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { body: await res.text() };
    } catch (err) {
        if (attempt < 2) {
            await sleep(800 * (attempt + 1));
            return fetchText(url, { attempt: attempt + 1, accept });
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// Each loader returns [{ date, value }] sorted ascending, missing values
// dropped rather than zeroed.
async function fredSeries(id) {
    const res = await fetchText(`${FRED}?id=${id}&cosd=${from}&coed=${to}`, { accept: 'text/csv' });
    if (res.error || !res.body || !/^observation_date/i.test(res.body.trim())) {
        return { error: res.error || 'unexpected response' };
    }
    const out = [];
    for (const line of res.body.trim().split(/\r?\n/).slice(1)) {
        const [date, raw] = line.split(',');
        const day = normDay(date);
        const value = numOrNull(raw);
        if (day && value != null) out.push({ date: day, value });
    }
    return { series: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

async function boeSeries() {
    const fmt = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${MONTHS[Number(m) - 1]}/${y}`; };
    const url = 'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes'
        + `&Datefrom=${encodeURIComponent(fmt(from))}&Dateto=${encodeURIComponent(fmt(to))}`
        + '&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N';
    const res = await fetchText(url, { accept: 'text/csv' });
    if (res.error || !res.body || !/^DATE/i.test(res.body.trim())) {
        return { error: res.error || 'unexpected response' };
    }
    const out = [];
    for (const line of res.body.trim().split(/\r?\n/).slice(1)) {
        const cells = line.split(',');
        const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(cells[0]).trim());
        const value = numOrNull(cells[1]);
        if (!m || value == null) continue;
        const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
        if (month < 0) continue;
        out.push({ date: `${m[3]}-${pad(month + 1)}-${pad(Number(m[1]))}`, value });
    }
    return { series: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

async function bocSeries() {
    const url = `https://www.bankofcanada.ca/valet/observations/V39079/json?start_date=${from}&end_date=${to}`;
    const res = await fetchText(url, { accept: 'application/json' });
    if (res.error || !res.body) return { error: res.error || 'no response' };
    let data;
    try { data = JSON.parse(res.body); } catch { return { error: 'response was not JSON' }; }
    const out = [];
    for (const o of data?.observations || []) {
        const day = normDay(o.d);
        const value = numOrNull(o.V39079?.v);
        if (day && value != null) out.push({ date: day, value });
    }
    return { series: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

// The Australian table dates its rows as 29-Jul-2026 in the daily file and
// 30/06/2026 in the monthly one, from the same publisher, so both forms are
// accepted rather than assuming either.
const parseAuDay = (s) => {
    const raw = String(s || '').trim();
    let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
    if (m) {
        const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
        return month < 0 ? null : `${m[3]}-${pad(month + 1)}-${pad(Number(m[1]))}`;
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
    if (m) return `${m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
    return null;
};

async function rbaSeries() {
    const res = await fetchText('https://www.rba.gov.au/statistics/tables/csv/f1-data.csv', { accept: 'text/csv' });
    if (res.error || !res.body) return { error: res.error || 'no response' };
    const lines = res.body.replace(/^﻿/, '').split(/\r?\n/);
    const idRow = lines.findIndex((l) => /^Series ID,/i.test(l.trim()));
    if (idRow < 0) return { error: 'could not find the series identifier row' };
    const header = lines[idRow].split(',').map((s) => s.trim());
    const col = header.indexOf('FIRMMCRTD');
    if (col < 0) return { error: 'cash rate target column not found' };
    const out = [];
    for (const line of lines.slice(idRow + 1)) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        const day = parseAuDay(cells[0]);
        const value = numOrNull(cells[col]);
        if (!day || value == null || day < from || day > to) continue;
        out.push({ date: day, value });
    }
    return { series: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

async function loadBank(key) {
    if (key === 'fed') {
        const [upper, lower] = await Promise.all([fredSeries('DFEDTARU'), fredSeries('DFEDTARL')]);
        if (upper.error) return { error: upper.error };
        return { series: upper.series, extra: { lower: lower.series || [] } };
    }
    if (key === 'ecb') {
        const [dep, mro, mlf] = await Promise.all([
            fredSeries('ECBDFR'), fredSeries('ECBMRRFR'), fredSeries('ECBMLFR'),
        ]);
        if (dep.error) return { error: dep.error };
        return { series: dep.series, extra: { mro: mro.series || [], mlf: mlf.series || [] } };
    }
    if (key === 'boe') return boeSeries();
    if (key === 'boc') return bocSeries();
    if (key === 'rba') return rbaSeries();
    return fredSeries('IRSTCI01JPM156N');
}

// A policy rate series repeats the same number every day it is unchanged, so
// a decision is a CHANGE IN VALUE, not a new observation. A gap in publication
// is not a change either, which is why missing values were dropped rather than
// carried as zeros.
function changeEvents(series) {
    const events = [];
    for (let i = 1; i < series.length; i += 1) {
        const prev = series[i - 1];
        const cur = series[i];
        if (cur.value === prev.value) continue;
        events.push({
            date: cur.date,
            from: prev.value,
            to: cur.value,
            deltaBasisPoints: round((cur.value - prev.value) * 100, 1),
            direction: cur.value > prev.value ? 'increase' : 'decrease',
            previousLevelSince: (() => {
                let since = prev.date;
                for (let j = i - 1; j > 0; j -= 1) {
                    if (series[j - 1].value !== prev.value) break;
                    since = series[j - 1].date;
                }
                return since;
            })(),
        });
    }
    return events;
}

const valueAsOf = (series, date) => {
    let found = null;
    for (const o of series) { if (o.date <= date) found = o; else break; }
    return found;
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

log.info(`Central bank rates ${theMode} | ${useBanks.join(', ')} | ${from} to ${to}`);
if (unknownBanks.length) {
    await note({
        unknownBanks,
        note: `not a covered central bank: ${unknownBanks.join(', ')}; covered are ${Object.keys(BANKS).join(', ')}; not charged`,
    });
}

const loaded = new Map();
for (const key of useBanks) {
    if (pastDeadline()) break;
    const res = await loadBank(key);
    if (res.error || !res.series?.length) {
        await note({
            bank: BANKS[key].name,
            note: `${BANKS[key].name} returned no data: ${res.error || 'empty series in this window'}; not charged`,
        });
        await sleep(SPACING_MS);
        continue;
    }
    loaded.set(key, res);
    log.info(`${BANKS[key].name}: ${res.series.length} observation(s), latest ${res.series[res.series.length - 1].date} = ${res.series[res.series.length - 1].value}`);
    await sleep(SPACING_MS);
}

const bankBase = (key) => {
    const b = BANKS[key];
    return {
        centralBank: b.name,
        bankKey: key,
        country: b.country,
        currency: b.currency,
        rateName: b.rateName,
        isProxyRate: !!b.isProxy,
        proxyCaveat: b.proxyNote || null,
        sourceName: b.sourceName,
        sourceUrl: b.sourceUrl,
        scrapedAt: new Date().toISOString(),
    };
};

if (theMode === 'latest') {
    for (const key of loaded.keys()) {
        if (emitted >= rowCap) break;
        const { series, extra } = loaded.get(key);
        const latest = series[series.length - 1];
        const events = changeEvents(series);
        const last = events.length ? events[events.length - 1] : null;
        const prior = events.length > 1 ? events[events.length - 2] : null;
        const yearAgo = valueAsOf(series, isoDay(new Date(Date.parse(`${latest.date}T00:00:00Z`) - 365 * 86400000)));
        const eventsLastYear = events.filter((e) => daysBetween(e.date, latest.date) <= 365);
        const hikes = eventsLastYear.filter((e) => e.direction === 'increase').length;
        const cuts = eventsLastYear.filter((e) => e.direction === 'decrease').length;

        // A proxy series is a market average, so it drifts by fractions of a
        // point between months. Those movements are NOT rate decisions, and
        // presenting them as "the last change" would invent a policy move the
        // central bank never announced.
        const isProxy = !!BANKS[key].isProxy;
        const row = {
            mode: 'latest',
            ...bankBase(key),
            currentRatePercent: latest.value,
            asOfDate: latest.date,
            publicationLagDays: daysBetween(latest.date, todayIso),
            atCurrentLevelSince: isProxy ? null : (last ? last.date : series[0].date),
            daysAtCurrentLevel: isProxy ? null : daysBetween(last ? last.date : series[0].date, latest.date),
            lastChangeDate: isProxy || !last ? null : last.date,
            lastChangeFromPercent: isProxy || !last ? null : last.from,
            lastChangeToPercent: isProxy || !last ? null : last.to,
            lastChangeBasisPoints: isProxy || !last ? null : last.deltaBasisPoints,
            lastChangeDirection: isProxy || !last ? null : last.direction,
            previousChangeDate: isProxy || !prior ? null : prior.date,
            previousChangeBasisPoints: isProxy || !prior ? null : prior.deltaBasisPoints,
            changesInLast12Months: isProxy ? null : eventsLastYear.length,
            increasesInLast12Months: isProxy ? null : hikes,
            decreasesInLast12Months: isProxy ? null : cuts,
            // A level comparison is still valid on a proxy series, unlike a
            // decision count.
            netChange12MonthsBasisPoints: yearAgo ? round((latest.value - yearAgo.value) * 100, 1) : null,
            // What the run of decisions says, rather than a single move.
            policyStance: isProxy ? null
                : (eventsLastYear.length === 0 ? 'on hold'
                    : (hikes && !cuts ? 'tightening' : (cuts && !hikes ? 'easing' : 'mixed'))),
            decisionHistoryAvailable: !isProxy,
            decisionHistoryNote: isProxy
                ? 'no decision history is derived for this bank: the series is a monthly market average that drifts between months, so its movements are not announced rate changes'
                : null,
            observationsInWindow: series.length,
            windowStart: from,
        };
        if (key === 'fed') {
            const lower = (extra?.lower || []);
            const lowerNow = lower.length ? lower[lower.length - 1] : null;
            row.targetRangeUpperPercent = latest.value;
            row.targetRangeLowerPercent = lowerNow ? lowerNow.value : null;
            row.targetRangeMidpointPercent = lowerNow ? round((latest.value + lowerNow.value) / 2, 4) : null;
            row.rateIsARange = true;
        }
        if (key === 'ecb') {
            const mro = extra?.mro || [];
            const mlf = extra?.mlf || [];
            row.mainRefinancingRatePercent = mro.length ? mro[mro.length - 1].value : null;
            row.marginalLendingRatePercent = mlf.length ? mlf[mlf.length - 1].value : null;
            row.headlineRateNote = 'the deposit facility rate is the one steering market rates; the main refinancing and marginal lending rates are reported alongside it';
        }
        await push(row);
    }
} else if (theMode === 'changes') {
    const all = [];
    for (const key of loaded.keys()) {
        // Skipped rather than filled with noise: a monthly market average
        // moves every month, and billing those as rate decisions would put
        // dozens of announcements in the output that never happened.
        if (BANKS[key].isProxy) {
            await note({
                bank: BANKS[key].name,
                note: `${BANKS[key].name} is excluded from the decision history: ${BANKS[key].proxyNote}, so its month to month movements are drift rather than announced changes; not charged`,
            });
            continue;
        }
        for (const e of changeEvents(loaded.get(key).series)) all.push({ key, e });
    }
    all.sort((a, b) => b.e.date.localeCompare(a.e.date));
    for (const { key, e } of all) {
        if (emitted >= rowCap || pastDeadline()) break;
        await push({
            mode: 'changes',
            ...bankBase(key),
            changeDate: e.date,
            fromPercent: e.from,
            toPercent: e.to,
            changeBasisPoints: e.deltaBasisPoints,
            direction: e.direction,
            previousLevelHeldSince: e.previousLevelSince,
            daysAtPreviousLevel: daysBetween(e.previousLevelSince, e.date),
            // A 25 basis point move is the usual step; anything larger is the
            // interesting one.
            isLargerThanUsualStep: Math.abs(e.deltaBasisPoints) > 25,
        });
    }
} else {
    // Pooled and sorted newest first across every bank, so a row cap returns
    // a balanced recent window rather than exhausting itself on whichever
    // bank happened to be loaded first.
    const all = [];
    for (const key of loaded.keys()) {
        for (const o of loaded.get(key).series) all.push({ key, o });
    }
    all.sort((a, b) => b.o.date.localeCompare(a.o.date) || a.key.localeCompare(b.key));
    for (const { key, o } of all) {
        if (emitted >= rowCap || pastDeadline()) break;
        await push({
            mode: 'history',
            ...bankBase(key),
            date: o.date,
            ratePercent: o.value,
        });
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; widen the window or pick different central banks; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
