// SOFR & Money Market Rates: Daily Benchmarks and Fed Operations
//
// What it does
// ------------
// SOFR is the reference rate under most floating rate debt written today, and
// it is set from roughly three trillion dollars of overnight repo trades. This
// reads the official daily publication: the secured and unsecured benchmarks,
// the distribution behind each one, and the results of the central bank's own
// repo operations.
//
//   rates       one row per benchmark per day: the rate, the volume behind
//               it, and the 1st, 25th, 75th and 99th percentiles
//   spreads     one row per day: every benchmark side by side, the SOFR to
//               EFFR spread, where SOFR sits in the policy target range, and
//               how far its 99th percentile tail is stretched
//   operations  one row per repo or reverse repo operation and collateral
//               type: amounts submitted and accepted, and the award rate
//
// Distinct from our us-treasury-rates-scraper, which reads the Treasury yield
// curve. This is the overnight funding market underneath it.
//
// Pay per event
// -------------
//   rate_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 400;
const API = 'https://markets.newyorkfed.org/api';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'rates',
    daysBack = 7,
    startDate = '',
    endDate = '',
    rateTypes = [],
    operationType = 'all',
    operationCount = 10,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const theMode = ['rates', 'spreads', 'operations'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'rates';
const wantTypes = new Set(asList(rateTypes).map((s) => s.toUpperCase()));
const opType = ['all', 'repo', 'reverserepo'].includes(String(operationType).toLowerCase())
    ? String(operationType).toLowerCase() : 'all';
const opCount = Math.max(1, Math.min(200, Number(operationCount) || 10));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const normDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);
const back = Math.max(0, Math.min(3650, Number(daysBack) || 7));
const from = normDay(startDate) || isoDay(new Date(Date.now() - back * 86400000));
const to = normDay(endDate) || isoDay(new Date());

// What each published benchmark actually measures. Buyers should not have to
// know the acronyms to read the output.
const RATE_NAMES = {
    SOFR: ['Secured Overnight Financing Rate', 'secured'],
    SOFRAI: ['SOFR averages and index', 'secured'],
    BGCR: ['Broad General Collateral Rate', 'secured'],
    TGCR: ['Tri-Party General Collateral Rate', 'secured'],
    EFFR: ['Effective Federal Funds Rate', 'unsecured'],
    OBFR: ['Overnight Bank Funding Rate', 'unsecured'],
};

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
            await sleep(700 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 110)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'rate_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
let notePushed = false;
const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

// SOFRAI is published in the same list as the benchmarks but is NOT a rate:
// it carries no percentRate and no percentiles, only the 30, 90 and 180 day
// compounded averages and the index used to settle contracts. Treating it as
// a benchmark yields a row of nulls where a rate should be, and averaging the
// list would mix an index level in with overnight rates.
function shapeRate(r) {
    const type = String(r.type || '').toUpperCase();
    const [name, family] = RATE_NAMES[type] || [null, null];
    const base = {
        rateType: type,
        rateName: name,
        family,
        effectiveDate: clean(r.effectiveDate),
        revised: clean(r.revisionIndicator) ? true : false,
        source: 'Federal Reserve Bank of New York',
        scrapedAt: new Date().toISOString(),
    };
    if (type === 'SOFRAI') {
        return {
            ...base,
            kind: 'sofr_averages_index',
            average30Day: numOrNull(r.average30day),
            average90Day: numOrNull(r.average90day),
            average180Day: numOrNull(r.average180day),
            indexLevel: numOrNull(r.index),
            percentRate: null,
        };
    }
    const rate = numOrNull(r.percentRate);
    const p99 = numOrNull(r.percentPercentile99);
    const p1 = numOrNull(r.percentPercentile1);
    return {
        ...base,
        kind: 'benchmark_rate',
        percentRate: rate,
        percentile1: p1,
        percentile25: numOrNull(r.percentPercentile25),
        percentile75: numOrNull(r.percentPercentile75),
        percentile99: p99,
        // How far the expensive tail of the market is trading above the
        // published rate, the first thing to move when funding tightens.
        tailSpreadBasisPoints: rate != null && p99 != null ? round((p99 - rate) * 100, 1) : null,
        rangeBasisPoints: p1 != null && p99 != null ? round((p99 - p1) * 100, 1) : null,
        volumeInBillions: numOrNull(r.volumeInBillions),
        targetRateFrom: numOrNull(r.targetRateFrom),
        targetRateTo: numOrNull(r.targetRateTo),
    };
}

log.info(`Money market ${theMode} | ${theMode === 'operations' ? `${opType}, last ${opCount}` : `${from} to ${to}`}`);

if (theMode === 'rates' || theMode === 'spreads') {
    const data = await getJson(`${API}/rates/all/search.json?startDate=${from}&endDate=${to}`);
    const refRates = data?.refRates || [];
    if (!refRates.length) {
        await flushRow({
            type: 'note', found: false, startDate: from, endDate: to,
            note: 'no published rates in this date range; rates publish on business days only, so a weekend or holiday window returns nothing; not charged',
        }, false);
    } else if (theMode === 'rates') {
        const shaped = refRates.map(shapeRate)
            .filter((r) => !wantTypes.size || wantTypes.has(r.rateType));
        shaped.sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate))
            || String(a.rateType).localeCompare(String(b.rateType)));
        for (const row of shaped) {
            if (emitted >= rowCap) break;
            await push({ mode: 'rates', ...row });
        }
        if (!shaped.length) {
            await flushRow({ type: 'note', found: false, note: 'no rates matched the requested types; valid types are SOFR, SOFRAI, BGCR, TGCR, EFFR, OBFR; not charged' }, false);
        }
    } else {
        // One row per day with every benchmark side by side.
        const byDate = new Map();
        for (const r of refRates) {
            const d = clean(r.effectiveDate);
            if (!d) continue;
            if (!byDate.has(d)) byDate.set(d, {});
            byDate.get(d)[String(r.type || '').toUpperCase()] = r;
        }
        const days = [...byDate.keys()].sort().reverse();
        for (const day of days) {
            if (emitted >= rowCap) break;
            if (deadlineMs && Date.now() > deadlineMs) break;
            const set = byDate.get(day);
            const sofr = numOrNull(set.SOFR?.percentRate);
            const effr = numOrNull(set.EFFR?.percentRate);
            const obfr = numOrNull(set.OBFR?.percentRate);
            const bgcr = numOrNull(set.BGCR?.percentRate);
            const tgcr = numOrNull(set.TGCR?.percentRate);
            const targetFrom = numOrNull(set.EFFR?.targetRateFrom);
            const targetTo = numOrNull(set.EFFR?.targetRateTo);
            const mid = targetFrom != null && targetTo != null ? (targetFrom + targetTo) / 2 : null;
            const sofrP99 = numOrNull(set.SOFR?.percentPercentile99);
            // The averages and index publish same day while the benchmarks
            // themselves publish the next business day, so the newest date
            // can carry no rate at all. Skip it rather than bill a row whose
            // rate columns are all empty.
            if ([sofr, effr, obfr, bgcr, tgcr].every((v) => v == null)) {
                log.info(`${day}: benchmarks not published yet, skipping (not charged)`);
                continue;
            }
            await push({
                mode: 'spreads',
                effectiveDate: day,
                sofr,
                effr,
                obfr,
                bgcr,
                tgcr,
                // Secured against unsecured: the classic funding stress read.
                sofrMinusEffrBasisPoints: sofr != null && effr != null ? round((sofr - effr) * 100, 1) : null,
                sofrMinusBgcrBasisPoints: sofr != null && bgcr != null ? round((sofr - bgcr) * 100, 1) : null,
                targetRateFrom: targetFrom,
                targetRateTo: targetTo,
                sofrVsTargetMidpointBasisPoints: sofr != null && mid != null ? round((sofr - mid) * 100, 1) : null,
                sofrAboveTargetCeiling: sofr != null && targetTo != null ? sofr > targetTo : null,
                sofrTailSpreadBasisPoints: sofr != null && sofrP99 != null ? round((sofrP99 - sofr) * 100, 1) : null,
                sofrVolumeInBillions: numOrNull(set.SOFR?.volumeInBillions),
                effrVolumeInBillions: numOrNull(set.EFFR?.volumeInBillions),
                sofrAverage30Day: numOrNull(set.SOFRAI?.average30day),
                sofrIndexLevel: numOrNull(set.SOFRAI?.index),
                source: 'Federal Reserve Bank of New York',
                scrapedAt: new Date().toISOString(),
            });
        }
    }
} else {
    const data = await getJson(`${API}/rp/${opType}/all/results/last/${opCount}.json`);
    const operations = data?.repo?.operations || [];
    if (!operations.length) {
        await flushRow({ type: 'note', found: false, operationType: opType, note: 'no operation results returned; not charged' }, false);
    }
    for (const op of operations) {
        if (emitted >= rowCap) break;
        if (deadlineMs && Date.now() > deadlineMs) break;
        const details = op.details && op.details.length ? op.details : [null];
        for (const d of details) {
            if (emitted >= rowCap) break;
            await push({
                mode: 'operations',
                operationId: clean(op.operationId),
                operationType: clean(op.operationType),
                operationMethod: clean(op.operationMethod),
                auctionStatus: clean(op.auctionStatus),
                operationDate: clean(op.operationDate),
                settlementDate: clean(op.settlementDate),
                maturityDate: clean(op.maturityDate),
                term: clean(op.term),
                termCalendarDays: numOrNull(op.termCalenderDays),
                securityType: d ? clean(d.securityType) : null,
                amountSubmitted: d ? numOrNull(d.amtSubmitted) : null,
                amountAccepted: d ? numOrNull(d.amtAccepted) : null,
                awardRatePercent: d ? numOrNull(d.percentOfferingRate ?? d.percentAwardRate ?? d.percentHighRate) : null,
                totalAmountSubmitted: numOrNull(op.totalAmtSubmitted),
                totalAmountAccepted: numOrNull(op.totalAmtAccepted),
                // Amounts are passed through exactly as published. The Fed
                // reports these in thousands of dollars; no conversion is
                // applied here so the figures always match the source.
                amountUnit: 'thousands of USD, as published',
                collateralTypesInOperation: (op.details || []).length,
                releaseTime: clean(op.releaseTime),
                closeTime: clean(op.closeTime),
                note: clean(op.note),
                source: 'Federal Reserve Bank of New York',
                scrapedAt: new Date().toISOString(),
            });
        }
    }
}

// Only explain once: a more specific note has usually already been pushed.
if (!emitted && !notePushed) {
    await flushRow({
        type: 'note', found: false,
        note: 'no rows returned; widen the date range, clear the rate type filter, or pick a different operation type; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
