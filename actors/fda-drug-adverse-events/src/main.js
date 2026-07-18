// FDA Drug Adverse Events & Side Effects (openFDA)
//
// Strategy
// --------
// openFDA drug/event API (api.fda.gov/drug/event.json), keyless JSON over
// the FDA Adverse Event Reporting System (FAERS). Each drug becomes its
// own query with the shared serious / country / since-year filters.
//   reactions -> count=patient.reaction.reactionmeddrapt.exact ranks the
//                most reported side effects for a drug (one call).
//   reports   -> individual safety reports, paged via skip (limit 100,
//                skip capped at 25,000), newest first.
// openFDA returns 404 when nothing matches (treated as "no data", free),
// and allows 1,000 requests/day per IP (shared here); a buyer's free
// api_key raises that to 120,000/day.
//
// Distinct from our other FDA actors, which cover recalls (enforcement),
// device registrations and drug approvals — this is adverse-event reports.
//
// Pay per event
// -------------
//   event_row per reaction-summary row or individual report. Unknown drugs
//   and empty results are free note rows. First 2 chargeable rows free.

import { Actor, log } from 'apify';

const API = 'https://api.fda.gov/drug/event.json';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 40000;
const PAGE_LIMIT = 100;
const SKIP_CAP = 25000;
const SPACING_MS = 300;

const OUTCOME = { 1: 'Recovered/resolved', 2: 'Recovering/resolving', 3: 'Not recovered/not resolved', 4: 'Recovered with lasting effects', 5: 'Fatal', 6: 'Unknown' };
const SEX = { 0: 'Unknown', 1: 'Male', 2: 'Female' };
const REPORTER = { 1: 'Physician', 2: 'Pharmacist', 3: 'Other health professional', 4: 'Lawyer', 5: 'Consumer / non-health professional' };
const SERIOUS_FLAGS = [
    ['seriousnessdeath', 'death'], ['seriousnesslifethreatening', 'life-threatening'],
    ['seriousnesshospitalization', 'hospitalization'], ['seriousnessdisabling', 'disability'],
    ['seriousnesscongenitalanomali', 'congenital anomaly'], ['seriousnessother', 'other serious'],
];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    drugs = [], mode = 'reactions', seriousOnly = false, country = '', sinceYear = 0,
    topReactions = 25, maxPerDrug = 50, apiKey = '', maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const drugList = [...new Set(asTokens(drugs))];
const runMode = mode === 'reports' ? 'reports' : 'reactions';
const serious = Boolean(seriousOnly);
const countryCode = String(country || '').trim().toUpperCase().slice(0, 2);
const since = clampNum(sinceYear, 0, 0, 2100);
const topN = clampNum(topReactions, 25, 1, 1000);
const perDrug = clampNum(maxPerDrug, 50, 1, 5000);
const key = String(apiKey || '').trim();
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);

if (drugList.length === 0) {
    log.warning('No drugs given. Add a drug name like "OZEMPIC".');
    await Actor.exit();
}

const nowYmd = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Build the openFDA search expression for a drug.
function searchExpr(drug) {
    const esc = drug.replace(/"/g, '');
    const parts = [`patient.drug.medicinalproduct:"${esc}"`];
    if (serious) parts.push('serious:1');
    if (countryCode) parts.push(`occurcountry:"${countryCode}"`);
    if (since > 0) parts.push(`receivedate:[${since}0101 TO ${nowYmd}]`);
    return parts.join(' AND ');
}

let quotaExhausted = false;
async function apiGet(params) {
    if (quotaExhausted) return { error: 'daily quota exhausted' };
    const usp = new URLSearchParams(params);
    if (key) usp.set('api_key', key);
    const url = `${API}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint FDA Adverse Events actor (admin@scrapemint.com)' } });
            if (res.status === 404) return { notFound: true };
            if (res.status === 429) { quotaExhausted = true; return { error: 'openFDA daily/rate limit reached' }; }
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: json?.error?.message || `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'event_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline() || quotaExhausted;

const toIso = (ymd) => {
    const m = String(ymd || '').match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

async function runReactions(drug) {
    const json = await apiGet({ search: searchExpr(drug), count: 'patient.reaction.reactionmeddrapt.exact', limit: String(topN) });
    if (json?.notFound) {
        await flushRow({ type: 'note', input: drug, found: false, note: 'no adverse-event reports found for this drug (check the spelling); not charged' }, false);
        return;
    }
    if (json?.error) {
        await flushRow({ type: 'note', input: drug, found: false, note: `lookup failed (${json.error}); not charged` }, false);
        return;
    }
    const results = json.results || [];
    const totalForDrug = results.reduce((s, r) => s + (r.count || 0), 0);
    let rank = 0;
    for (const r of results) {
        if (shouldStop()) break;
        rank += 1;
        await flushRow({
            type: 'reaction_summary',
            drug,
            rank,
            reaction: r.term || null,
            reportCount: r.count ?? null,
            shareOfTopPct: totalForDrug ? Math.round((r.count / totalForDrug) * 1000) / 10 : null,
            filteredSeriousOnly: serious,
            country: countryCode || null,
        }, true);
    }
}

function reportRow(r, drug) {
    const p = r.patient || {};
    const seriousness = SERIOUS_FLAGS.filter(([f]) => r[f] === '1').map(([, label]) => label);
    const reactions = (p.reaction || []).map((x) => x.reactionmeddrapt).filter(Boolean);
    const outcomes = [...new Set((p.reaction || []).map((x) => OUTCOME[Number(x.reactionoutcome)]).filter(Boolean))];
    const drugsInReport = (p.drug || []).map((x) => x.medicinalproduct).filter(Boolean);
    let ageYears = null;
    if (p.patientonsetage != null) {
        const n = Number(p.patientonsetage);
        const unit = String(p.patientonsetageunit || '801'); // 801 = years
        ageYears = unit === '801' ? n : unit === '802' ? Math.round(n / 12 * 10) / 10 : unit === '800' ? n : n;
    }
    return {
        type: 'report',
        searchedDrug: drug,
        reportId: r.safetyreportid || null,
        receiveDate: toIso(r.receivedate),
        serious: r.serious === '1',
        seriousness,
        reactions,
        outcomes,
        patientSex: SEX[Number(p.patientsex)] || null,
        patientAgeYears: ageYears,
        reporterType: REPORTER[Number(r.primarysource?.qualification)] || null,
        occurCountry: r.occurcountry || null,
        drugsInReport,
    };
}

async function runReports(drug) {
    let emitted = 0;
    let skip = 0;
    let total = null;
    let anyHit = false;
    while (emitted < perDrug && skip <= SKIP_CAP && !shouldStop()) {
        const json = await apiGet({ search: searchExpr(drug), limit: String(Math.min(PAGE_LIMIT, perDrug - emitted)), skip: String(skip), sort: 'receivedate:desc' });
        if (json?.notFound) break;
        if (json?.error) {
            if (emitted === 0) await flushRow({ type: 'note', input: drug, found: false, note: `lookup failed (${json.error}); not charged` }, false);
            break;
        }
        if (total === null) total = json.meta?.results?.total ?? 0;
        const results = json.results || [];
        if (results.length === 0) break;
        anyHit = true;
        for (const r of results) {
            if (emitted >= perDrug || shouldStop()) break;
            await flushRow(reportRow(r, drug), true);
            emitted += 1;
        }
        skip += results.length;
        if (skip >= (total || 0)) break;
    }
    if (!anyHit && emitted === 0 && !shouldStop()) {
        await flushRow({ type: 'note', input: drug, found: false, note: 'no adverse-event reports found for this drug (check the spelling); not charged' }, false);
    }
}

log.info(`Querying ${drugList.length} drug(s) in ${runMode} mode${serious ? ', serious only' : ''}`
    + `${countryCode ? `, country ${countryCode}` : ''}${since ? `, since ${since}` : ''}...`);

for (const drug of drugList) {
    if (shouldStop()) break;
    if (runMode === 'reactions') await runReactions(drug);
    else await runReports(drug);
}

if (quotaExhausted) {
    log.warning('openFDA request limit reached (1,000/day per IP is shared). Add a free openFDA api_key to raise it to 120,000/day.');
    await flushRow({ type: 'note', found: false, note: 'stopped: openFDA daily limit reached (add a free openFDA API key for 120,000/day); remaining drugs not charged' }, false);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
