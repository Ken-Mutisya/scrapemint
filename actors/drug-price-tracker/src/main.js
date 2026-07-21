// Prescription Drug Price Tracker (CMS NADAC)
//
// Strategy
// --------
// National Average Drug Acquisition Cost (NADAC) is the federal benchmark
// for what retail pharmacies actually pay for a drug. CMS republishes it
// weekly on the keyless Medicaid DKAN API (data.medicaid.gov). Per-year
// dataset ids are resolved at runtime from the metastore, so a new program
// year works without a code change.
//
// Three modes:
//   prices  - current NADAC per unit for a drug (latest row per NDC)
//   changes - week-over-week price moves from the "NADAC Comparison"
//             table, with old/new price, percent change and CMS's stated
//             reason; supports a newOnly monitor for price-move alerts
//   history - the weekly price series for a drug or NDC over one year
//
// Source notes / gotchas
// ----------------------
//   * EVERY numeric column is stored as a STRING. The API's comparison
//     operators and sorts are therefore lexicographic: asking for
//     percent_change > 50 happily returns "6.51", and sorting desc puts
//     "9.90" above "50.00". So all numeric thresholds and ranking are done
//     client-side here; only date and text conditions are pushed to the
//     server. ISO dates (YYYY-MM-DD) are safe to compare as strings.
//   * The price tables carry one row per NDC per weekly publication, so a
//     drug name matches thousands of rows across a year. Prices mode sorts
//     by effective_date desc and keeps the first row seen per NDC.
//   * classification_for_rate_setting is G (generic) or B (brand).
//   * A drug name can map to many NDCs (one per labeler/package), which is
//     expected, not duplication.
//
// Pay per event
// -------------
//   drug_row per price, change or history row. Empty searches and error
//   notes are free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://data.medicaid.gov/api/1';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 300;
const PAGE_SIZE = 1000;
const SCAN_CAP = 40000;
const SEEN_MAX = 20000;
const COMPARISON_TITLE = 'NADAC Comparison';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'prices', drugName = '', ndc = '', drugType = 'any',
    year = '2026', sinceDays = 30, minPercentChange = 0,
    newOnly = false, maxRows = 200,
} = input;

const clean = (v) => String(v ?? '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const runMode = ['prices', 'changes', 'history'].includes(String(mode)) ? String(mode) : 'prices';
const nameFilter = clean(drugName);
const ndcFilter = clean(ndc).replace(/[^0-9]/g, '');
const typeCode = { generic: 'G', brand: 'B' }[String(drugType)] || '';
const progYear = clampNum(year, 2026, 2013, 2100);
const days = clampNum(sinceDays, 30, 1, 3650);
const minPct = Math.abs(Number(minPercentChange) || 0);
const rowCap = clampNum(maxRows, 200, 1, 50000);

// The price tables hold every drug in the country, so they need a filter.
// The changes table is already bounded by its date window, so an unfiltered
// "what moved this month" report is allowed there.
if (runMode !== 'changes' && !nameFilter && !ndcFilter) {
    log.warning('Add a drug name or an NDC code. NADAC lists every drug in the US, so prices and history are too large to browse without a filter. Price-changes mode can run unfiltered.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { accept: 'application/json', 'User-Agent': 'Scrapemint NADAC drug price actor (admin@scrapemint.com)' },
            });
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

// Resolve a dataset title to its id from the metastore, so new program
// years and republished tables need no code change.
let catalog = null;
async function resolveDatasetId(title) {
    if (!catalog) {
        const { json, error } = await getJson(`${BASE}/metastore/schemas/dataset/items?show-reference-ids`);
        if (error) return { error };
        catalog = Array.isArray(json) ? json : [];
    }
    const wanted = title.toLowerCase();
    const item = catalog.find((it) => clean(it.title).toLowerCase() === wanted);
    if (!item) return { error: 'not-published' };
    return { id: item.identifier };
}

function conditions({ dateFloor = '' } = {}) {
    const c = [];
    if (nameFilter) c.push({ property: 'ndc_description', value: `%${nameFilter.toUpperCase()}%`, operator: 'like' });
    if (ndcFilter) c.push({ property: 'ndc', value: ndcFilter, operator: '=' });
    if (typeCode) c.push({ property: 'classification_for_rate_setting', value: typeCode, operator: '=' });
    // ISO dates compare correctly as strings, unlike the numeric columns.
    if (dateFloor) c.push({ property: 'effective_date', value: dateFloor, operator: '>=' });
    return c;
}

function queryUrl(datasetId, offset, limit, opts = {}) {
    const usp = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    conditions(opts).forEach((cond, i) => {
        usp.set(`conditions[${i}][property]`, cond.property);
        usp.set(`conditions[${i}][value]`, cond.value);
        usp.set(`conditions[${i}][operator]`, cond.operator);
    });
    usp.set('sorts[0][property]', 'effective_date');
    usp.set('sorts[0][order]', 'desc');
    return `${BASE}/datastore/query/${datasetId}/0?${usp}`;
}

const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const typeName = (c) => ({ G: 'generic', B: 'brand' }[clean(c)] || null);
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

function priceRow(r) {
    return {
        ndc: r.ndc || null,
        drugName: r.ndc_description || null,
        pricePerUnit: num(r.nadac_per_unit),
        pricingUnit: r.pricing_unit || null,
        drugType: typeName(r.classification_for_rate_setting),
        effectiveDate: r.effective_date || null,
        otc: clean(r.otc).toUpperCase() === 'Y',
        pharmacyTypeIndicator: r.pharmacy_type_indicator || null,
        genericEquivalentPricePerUnit: num(r.corresponding_generic_drug_nadac_per_unit),
        asOfDate: r.as_of_date || null,
    };
}

function changeRow(r) {
    const oldP = num(r.old_nadac_per_unit);
    const newP = num(r.new_nadac_per_unit);
    const pct = num(r.percent_change);
    return {
        ndc: r.ndc || null,
        drugName: r.ndc_description || null,
        oldPricePerUnit: oldP,
        newPricePerUnit: newP,
        percentChange: pct,
        direction: pct === null ? null : (pct > 0 ? 'increase' : (pct < 0 ? 'decrease' : 'flat')),
        reason: r.primary_reason || null,
        drugType: typeName(r.classification_for_rate_setting),
        effectiveDate: r.effective_date || null,
        priorPeriodStart: r.start_date || null,
        priorPeriodEnd: r.end_date || null,
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
            await Actor.charge({ eventName: 'drug_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const label = [nameFilter && `"${nameFilter}"`, ndcFilter && `NDC ${ndcFilter}`, typeCode && `${drugType} only`].filter(Boolean).join(', ') || 'all drugs';

// --- run ---------------------------------------------------------------------------

if (runMode === 'changes') {
    const { id: datasetId, error: idError } = await resolveDatasetId(COMPARISON_TITLE);
    if (idError) {
        await flushRow({ type: 'note', input: label, found: false, note: `could not reach the NADAC comparison table (${idError}); not charged, try again later` }, false);
        await Actor.exit();
    }

    const floor = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const store = newOnly ? await Actor.openKeyValueStore('drug-price-seen') : null;
    const SEEN_KEY = 'seen-change-keys';
    const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
    const seenAtStart = seen.size;
    let skippedSeen = 0;

    log.info(`NADAC price changes for ${label} since ${floor}${minPct ? `, at least ${minPct}% move` : ''}${newOnly ? ', NEW only' : ''}...`);

    // Numeric ranking cannot be pushed to the server (string columns), so
    // collect the window, then threshold and rank client-side.
    const collected = [];
    let scanned = 0;
    let failed = null;
    for (let offset = 0; scanned < SCAN_CAP && !pastDeadline(); offset += PAGE_SIZE) {
        const { json, error } = await getJson(queryUrl(datasetId, offset, PAGE_SIZE, { dateFloor: floor }));
        if (error) { failed = error; break; }
        const results = json?.results || [];
        if (results.length === 0) break;
        for (const r of results) {
            scanned += 1;
            const row = changeRow(r);
            if (row.percentChange === null || Math.abs(row.percentChange) < minPct) continue;
            const seenKey = `${row.ndc}|${row.effectiveDate}`;
            if (newOnly && seen.has(seenKey)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(seenKey);
            collected.push(row);
        }
        if (results.length < PAGE_SIZE) break;
    }

    collected.sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange));
    const out = collected.slice(0, rowCap);
    if (out.length === 0) {
        await flushRow({ type: 'note', input: label, found: false, note: `${failed ? `search failed (${failed}); ` : `no price changes matched in the last ${days} day(s)${minPct ? ` at or above ${minPct}%` : ''}${newOnly ? ' (or all already seen)' : ''}; try a longer window or a lower threshold; `}not charged` }, false);
    } else {
        for (const row of out) {
            if (pastDeadline()) break;
            await flushRow(row, true);
        }
        if (scanned >= SCAN_CAP) log.warning(`Hit the ${SCAN_CAP}-row scan cap; ranked the most recent changes only. Narrow with a drug name or a shorter window for a complete ranking.`);
    }

    if (newOnly) {
        const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
        await store.setValue(SEEN_KEY, toSave);
        log.info(`Monitor state saved: ${toSave.length} change key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
    }
} else {
    const title = `NADAC (National Average Drug Acquisition Cost) ${progYear}`;
    const { id: datasetId, error: idError } = await resolveDatasetId(title);
    if (idError) {
        const note = idError === 'not-published'
            ? `NADAC has no ${progYear} table published yet; try an earlier year; not charged`
            : `could not reach the NADAC catalog (${idError}); not charged, try again later`;
        await flushRow({ type: 'note', input: label, found: false, note }, false);
        await Actor.exit();
    }

    const currentOnly = runMode === 'prices';
    log.info(`NADAC ${currentOnly ? 'current prices' : `${progYear} price history`} for ${label}...`);

    const seenKeys = new Set();
    let scanned = 0;
    let failed = null;
    let pushed = 0;
    for (let offset = 0; scanned < SCAN_CAP && pushed < rowCap && !pastDeadline(); offset += PAGE_SIZE) {
        const { json, error } = await getJson(queryUrl(datasetId, offset, PAGE_SIZE));
        if (error) { failed = error; break; }
        const results = json?.results || [];
        if (results.length === 0) break;
        for (const r of results) {
            if (pushed >= rowCap || pastDeadline()) break;
            scanned += 1;
            const row = priceRow(r);
            // Rows arrive newest-first. In prices mode the first row seen for
            // an NDC is its current price. In history mode the weekly files
            // repeat an unchanged price under the same effective date (~86% of
            // rows for a typical NDC), so collapse to one row per distinct
            // price point rather than charge for the repeats.
            const dedupeKey = currentOnly ? row.ndc : `${row.ndc}|${row.effectiveDate}`;
            if (!row.ndc || seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);
            await flushRow(row, true);
            pushed += 1;
        }
        if (results.length < PAGE_SIZE) break;
    }

    if (pushed === 0) {
        await flushRow({ type: 'note', input: label, found: false, note: `${failed ? `search failed (${failed}); ` : `no NADAC entries matched in ${progYear}; check the spelling (NADAC uses labels like "ATORVASTATIN 20 MG TABLET"), or try another year; `}not charged` }, false);
    } else if (scanned >= SCAN_CAP) {
        log.warning(`Hit the ${SCAN_CAP}-row scan cap; narrow with a more specific drug name or an NDC.`);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
