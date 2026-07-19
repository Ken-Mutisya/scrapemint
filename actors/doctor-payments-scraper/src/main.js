// Doctor Payments Scraper (CMS Open Payments)
//
// Strategy
// --------
// Federal Open Payments general-payment data via the CMS DKAN API
// (openpaymentsdata.cms.gov). Per-year dataset ids are resolved at
// runtime from the metastore (so new program years work without a code
// change), then queried through the datastore endpoint with AND
// conditions: last/first name (exact, case-insensitive via upper()),
// company name (LIKE %...%), and state. Datastore paginates with
// limit/offset.
//
// The general-payment table is ~10M rows per year, so there is no
// browse-everything mode - at least one filter (name or company) is
// required. Doctor-totals mode pulls a physician's payment rows and
// aggregates them client-side into one summary row.
//
// Source notes:
//   * Dataset ids come from metastore items titled "<year> General
//     Payment Data"; if the year is not published yet, that is a clean
//     free note.
//   * Money fields are strings; specialties use a "A|B|C" taxonomy path,
//     reduced to the leaf.
//
// Pay per event
// -------------
//   payment_row per payment (payments mode) or per doctor summary
//   (doctor_totals mode). Empty searches are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://openpaymentsdata.cms.gov/api/1';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 400;
const PAGE_SIZE = 500;
const AGG_SCAN_CAP = 20000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'payments', doctorLastName = '', doctorFirstName = '', companyName = '',
    state = '', year = 2024, maxRows = 200,
} = input;

const clean = (v) => String(v || '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const totalsMode = String(mode) === 'doctor_totals';
const lastName = clean(doctorLastName);
const firstName = clean(doctorFirstName);
const company = clean(companyName);
const stateCode = clean(state).toUpperCase().slice(0, 2);
const progYear = clampNum(year, 2024, 2013, 2100);
const rowCap = clampNum(maxRows, 200, 1, 50000);

if (!lastName && !company) {
    log.warning('Add a doctor last name or a paying company. The dataset is too large to browse without a filter.');
    await Actor.exit();
}
if (totalsMode && !lastName) {
    log.warning('Doctor totals mode needs a doctor last name.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Open Payments actor (admin@scrapemint.com)' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const json = await res.json();
            await sleep(SPACING_MS);
            return { json };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// Resolve "<year> General Payment Data" -> dataset id from the metastore.
async function resolveDatasetId(y) {
    const { json, error } = await getJson(`${BASE}/metastore/schemas/dataset/items?show-reference-ids`);
    if (error) return { error };
    const wanted = `${y} general payment data`;
    const item = (Array.isArray(json) ? json : []).find((it) => clean(it.title).toLowerCase() === wanted);
    if (!item) return { error: 'year-not-published' };
    return { id: item.identifier };
}

function buildConditions() {
    const c = [];
    if (lastName) c.push({ property: 'covered_recipient_last_name', value: lastName.toUpperCase(), operator: '=' });
    if (firstName) c.push({ property: 'covered_recipient_first_name', value: firstName.toUpperCase(), operator: '=' });
    if (company) c.push({ property: 'applicable_manufacturer_or_applicable_gpo_making_payment_name', value: `%${company.toUpperCase()}%`, operator: 'like' });
    if (stateCode) c.push({ property: 'recipient_state', value: stateCode, operator: '=' });
    return c;
}

function queryUrl(datasetId, offset, limit) {
    const usp = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    buildConditions().forEach((cond, i) => {
        usp.set(`conditions[${i}][property]`, cond.property);
        usp.set(`conditions[${i}][value]`, cond.value);
        usp.set(`conditions[${i}][operator]`, cond.operator);
    });
    return `${BASE}/datastore/query/${datasetId}/0?${usp}`;
}

const money = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const leaf = (taxo) => {
    const parts = String(taxo || '').split('|').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

function paymentRow(r) {
    return {
        recordId: r.record_id || null,
        programYear: progYear,
        date: r.date_of_payment || null,
        amountUsd: money(r.total_amount_of_payment_usdollars),
        natureOfPayment: r.nature_of_payment_or_transfer_of_value || null,
        doctorName: [r.covered_recipient_first_name, r.covered_recipient_last_name].filter(Boolean).join(' ').trim() || null,
        doctorType: r.covered_recipient_type || null,
        specialty: leaf(r.covered_recipient_specialty_1),
        npi: r.covered_recipient_npi || null,
        city: r.recipient_city || null,
        state: r.recipient_state || null,
        company: r.applicable_manufacturer_or_applicable_gpo_making_payment_name || null,
        productName: r.name_of_drug_or_biological_or_device_or_medical_supply_1 || null,
        paymentForm: r.form_of_payment_or_transfer_of_value || null,
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
            await Actor.charge({ eventName: 'payment_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- run ---------------------------------------------------------------------------

const label = [lastName && `Dr. ${firstName ? `${firstName} ` : ''}${lastName}`, company && `company "${company}"`, stateCode].filter(Boolean).join(', ');
log.info(`Open Payments ${progYear}, ${totalsMode ? 'doctor totals' : 'payments'}: ${label}...`);

const { id: datasetId, error: idError } = await resolveDatasetId(progYear);
if (idError) {
    const note = idError === 'year-not-published'
        ? `Open Payments has no "${progYear} General Payment Data" published yet; try an earlier year; not charged`
        : `could not reach the Open Payments catalog (${idError}); not charged, try again later`;
    await flushRow({ type: 'note', input: label, found: false, note }, false);
    await Actor.exit();
}

if (!totalsMode) {
    // Payments mode: stream one row per payment up to the cap.
    let anyHit = false;
    let failed = null;
    for (let offset = 0; !shouldStop(); offset += PAGE_SIZE) {
        const limit = Math.min(PAGE_SIZE, rowCap - rowsPushed);
        const { json, error } = await getJson(queryUrl(datasetId, offset, limit));
        if (error) { failed = error; break; }
        const results = json?.results || [];
        if (results.length === 0) break;
        anyHit = true;
        for (const r of results) {
            if (shouldStop()) break;
            await flushRow(paymentRow(r), true);
        }
        if (results.length < limit) break;
    }
    if (!anyHit) {
        await flushRow({ type: 'note', input: label, found: false, note: `${failed ? `search failed (${failed}); ` : 'no payments matched (check the spelling, or try without the state filter); '}not charged` }, false);
    }
} else {
    // Doctor totals mode: scan the doctor's payments, aggregate per (name,
    // city, state) so distinct doctors sharing a last name stay separate.
    const agg = new Map();
    let scanned = 0;
    let failed = null;
    for (let offset = 0; scanned < AGG_SCAN_CAP && !pastDeadline(); offset += PAGE_SIZE) {
        const { json, error } = await getJson(queryUrl(datasetId, offset, PAGE_SIZE));
        if (error) { failed = error; break; }
        const results = json?.results || [];
        if (results.length === 0) break;
        for (const r of results) {
            scanned += 1;
            const p = paymentRow(r);
            const keyId = p.npi || `${p.doctorName}|${p.city}|${p.state}`;
            let a = agg.get(keyId);
            if (!a) {
                a = { doctorName: p.doctorName, npi: p.npi, specialty: p.specialty, city: p.city, state: p.state, totalUsd: 0, paymentCount: 0, byCompany: new Map(), byNature: new Map() };
                agg.set(keyId, a);
            }
            a.totalUsd += p.amountUsd;
            a.paymentCount += 1;
            if (p.company) a.byCompany.set(p.company, (a.byCompany.get(p.company) || 0) + p.amountUsd);
            if (p.natureOfPayment) a.byNature.set(p.natureOfPayment, (a.byNature.get(p.natureOfPayment) || 0) + p.amountUsd);
            if (!a.specialty && p.specialty) a.specialty = p.specialty;
        }
        if (results.length < PAGE_SIZE) break;
    }
    const topN = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, amt]) => ({ name, amountUsd: round2(amt) }));
    const doctors = [...agg.values()].sort((x, y) => y.totalUsd - x.totalUsd).slice(0, rowCap);
    if (doctors.length === 0) {
        await flushRow({ type: 'note', input: label, found: false, note: `${failed ? `search failed (${failed}); ` : 'no payments matched for that doctor; '}not charged` }, false);
    } else {
        for (const a of doctors) {
            if (pastDeadline()) break;
            await flushRow({
                programYear: progYear,
                doctorName: a.doctorName,
                npi: a.npi,
                specialty: a.specialty,
                city: a.city,
                state: a.state,
                totalReceivedUsd: round2(a.totalUsd),
                paymentCount: a.paymentCount,
                companyCount: a.byCompany.size,
                topCompanies: topN(a.byCompany, 5),
                byPaymentType: topN(a.byNature, 8),
            }, true);
        }
        if (scanned >= AGG_SCAN_CAP) log.warning(`Hit the ${AGG_SCAN_CAP}-payment scan cap; totals reflect the most recent payments only. Narrow with first name/state for an exact figure.`);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
