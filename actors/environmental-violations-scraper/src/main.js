// Environmental Violations Scraper (EPA ECHO)
//
// Strategy
// --------
// EPA ECHO REST services (echodata.epa.gov), keyless. Two-step flow:
//   1. get_facilities with the search filters returns a QueryID (a server
//      side result handle) and QueryRows (the match count).
//   2. get_qid pages that handle, `responseset` rows per page, via pageno.
// The default field set is rich (compliance status per program,
// inspections, penalties) so no column selection is needed - the useful
// fields are picked into each row.
//
// Source notes:
//   * get_facilities can return QueryRows=0 with Success - that is a clean
//     "no match" free note, not an error.
//   * FacSNCFlg / compliance-status fields are the violation signal;
//     violatorsOnly filters on them client-side (ECHO's own violation
//     flag param is inconsistent across programs).
//   * Money/count fields arrive as strings; parsed defensively.
//
// Pay per event
// -------------
//   facility_row per facility. Empty searches and unreachable service are
//   free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://echodata.epa.gov/echo';
const DETAIL = 'https://echo.epa.gov/detailed-facility-report?fid=';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 90000;
const SPACING_MS = 500;
const PAGE_SIZE = 1000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { companyName = '', state = '', naicsCode = '', violatorsOnly = false, activeOnly = true, maxRows = 500 } = input;

const clean = (v) => String(v || '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const company = clean(companyName);
const stateCode = clean(state).toUpperCase().slice(0, 2);
const naics = clean(naicsCode).replace(/[^0-9]/g, '');
const rowCap = clampNum(maxRows, 500, 1, 50000);

if (!company && !stateCode && !naics) {
    log.warning('Add a company name, a state, or a NAICS industry code.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint EPA ECHO actor (admin@scrapemint.com)' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const json = await res.json();
            await sleep(SPACING_MS);
            return { json };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 5000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};
const str = (v) => {
    const s = clean(v);
    return s && s !== '-' ? s : null;
};
// A status string signals a violation only when it affirmatively says so.
// Guard against "No Violation Identified", which contains "violation" as a
// substring and must NOT count as a violator.
const statusIsViolation = (raw) => {
    const s = clean(raw).toLowerCase();
    if (!s || s.startsWith('no ') || s.includes('no violation')) return false;
    return s.includes('violation') || s.includes('significant') || s.includes('non-compliance') || s.includes('noncompliance');
};
const inViolation = (f) => {
    if (clean(f.FacSNCFlg).toUpperCase() === 'Y') return true;
    if ((num(f.FacQtrsWithNC) || 0) > 0) return true;
    return [f.FacComplianceStatus, f.CAAComplianceStatus, f.CWAComplianceStatus, f.RCRAComplianceStatus, f.SDWAComplianceStatus].some(statusIsViolation);
};

function toRow(f) {
    return {
        facilityName: str(f.FacName),
        registryId: str(f.RegistryID),
        address: str(f.FacStreet),
        city: str(f.FacCity),
        state: str(f.FacState),
        zip: str(f.FacZip),
        county: str(f.FacCounty),
        latitude: num(f.FacLat),
        longitude: num(f.FacLong),
        sicCodes: str(f.FacSICCodes),
        naicsCodes: str(f.FacNAICSCodes),
        complianceStatus: str(f.FacComplianceStatus),
        significantNonComplier: clean(f.FacSNCFlg).toUpperCase() === 'Y',
        quartersInNonCompliance: num(f.FacQtrsWithNC),
        cleanAirStatus: str(f.CAAComplianceStatus),
        cleanWaterStatus: str(f.CWAComplianceStatus),
        wasteStatus: str(f.RCRAComplianceStatus),
        drinkingWaterStatus: str(f.SDWAComplianceStatus),
        inspectionCount: num(f.FacInspectionCount),
        lastInspectionDate: str(f.FacDateLastInspection),
        lastFormalActionDate: str(f.FacDateLastFormalAction),
        penaltyCount: num(f.FacPenaltyCount),
        lastPenaltyDate: str(f.FacDateLastPenalty),
        caaPenaltiesUsd: num(f.CAAPenalties),
        active: clean(f.FacActiveFlag).toUpperCase() !== 'N',
        url: str(f.RegistryID) ? `${DETAIL}${clean(f.RegistryID)}` : null,
    };
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
            await Actor.charge({ eventName: 'facility_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- run ---------------------------------------------------------------------------

const label = [company && `"${company}"`, stateCode, naics && `NAICS ${naics}`].filter(Boolean).join(', ');
log.info(`EPA ECHO facilities: ${label}${violatorsOnly ? ', in violation only' : ''}...`);

const q = new URLSearchParams({ output: 'JSON', responseset: String(PAGE_SIZE) });
if (company) q.set('p_fn', company);
if (stateCode) q.set('p_st', stateCode);
if (naics) q.set('p_ncs', naics);
if (activeOnly) q.set('p_act', 'Y');

const { json: head, error: headErr } = await getJson(`${BASE}/echo_rest_services.get_facilities?${q}`);
if (headErr) {
    await flushRow({ type: 'note', input: label, found: false, note: `ECHO service unavailable (${headErr}); not charged, try again later` }, false);
    await Actor.exit();
}
const results = head?.Results || {};
const queryId = results.QueryID;
const totalRows = num(results.QueryRows) || 0;
if (!queryId || totalRows === 0) {
    await flushRow({ type: 'note', input: label, found: false, note: 'no facilities matched (check the name, or broaden the filters); not charged' }, false);
    await Actor.exit();
}
log.info(`${totalRows} facilit(ies) match; paging...`);

let skippedNonViolators = 0;
for (let pageno = 1; !shouldStop(); pageno += 1) {
    const pq = new URLSearchParams({ output: 'JSON', qid: String(queryId), pageno: String(pageno), responseset: String(PAGE_SIZE) });
    const { json, error } = await getJson(`${BASE}/echo_rest_services.get_qid?${pq}`);
    if (error) {
        if (rowsPushed === 0) await flushRow({ type: 'note', input: label, found: false, note: `paging failed (${error}); not charged, try again later` }, false);
        break;
    }
    const facs = json?.Results?.Facilities || [];
    if (facs.length === 0) break;
    for (const f of facs) {
        if (shouldStop()) break;
        if (violatorsOnly && !inViolation(f)) { skippedNonViolators += 1; continue; }
        await flushRow(toRow(f), true);
    }
    if (facs.length < PAGE_SIZE) break;
}

if (rowsPushed === 0 && violatorsOnly) {
    await flushRow({ type: 'note', input: label, found: false, note: `matched ${totalRows} facilit(ies) but none currently in violation; not charged` }, false);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${violatorsOnly ? `, ${skippedNonViolators} non-violators skipped` : ''}${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
