// Care Facility Ratings Scraper (CMS Care Compare)
//
// Strategy
// --------
// Medicare Care Compare quality data via the CMS provider-data DKAN API
// (data.cms.gov/provider-data), keyless. One vendored dataset id + field
// map per facility type (nursing homes, hospitals, home health), each
// normalized to a shared row shape. The datastore query takes AND
// conditions (name LIKE, state/city exact) with limit/offset paging.
//
// Notes:
//   * Field names differ per dataset (facility_id vs
//     cms_certification_number_ccn, facility_name vs provider_name,
//     hospital_overall_rating vs overall_rating vs
//     quality_of_patient_care_star_rating) - hence the per-type map.
//   * Ratings are strings "1".."5" or "" / "Not Available"; parsed to
//     numbers, missing -> null.
//   * minRating is applied client-side (some rows have no rating and must
//     be excluded when a minimum is set).
//
// Pay per event
// -------------
//   facility_row per facility. Empty searches are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://data.cms.gov/provider-data/api/1/datastore/query';
const COMPARE = 'https://www.medicare.gov/care-compare';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 400;
const PAGE_SIZE = 500;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { facilityType = 'nursing_homes', facilityName = '', state = '', city = '', minRating = '0', maxRows = 500 } = input;

const clean = (v) => String(v || '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const rating = (v) => {
    const n = Number(clean(v));
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
const int = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && clean(v) !== '' ? n : null;
};
const str = (v) => {
    const s = clean(v);
    return s && !/^not available$/i.test(s) ? s : null;
};

const name = clean(facilityName);
const stateCode = clean(state).toUpperCase().slice(0, 2);
const cityName = clean(city);
const minStars = clampNum(minRating, 0, 0, 5);
const rowCap = clampNum(maxRows, 500, 1, 50000);

// Per-type dataset id, name field for the LIKE filter, and normalizer.
const TYPES = {
    nursing_homes: {
        label: 'Nursing home',
        ds: '4pq5-n9py',
        nameField: 'provider_name',
        toRow: (r) => ({
            ccn: str(r.cms_certification_number_ccn),
            name: str(r.provider_name),
            overallRating: rating(r.overall_rating),
            healthInspectionRating: rating(r.health_inspection_rating),
            staffingRating: rating(r.staffing_rating),
            qualityRating: rating(r.qm_rating),
            certifiedBeds: int(r.number_of_certified_beds),
            avgResidentsPerDay: int(r.average_number_of_residents_per_day),
            totalFinesUsd: int(r.total_amount_of_fines_in_dollars),
            ownership: str(r.ownership_type),
            program: str(r.provider_type),
        }),
    },
    hospitals: {
        label: 'Hospital',
        ds: 'xubh-q36u',
        nameField: 'facility_name',
        toRow: (r) => ({
            ccn: str(r.facility_id),
            name: str(r.facility_name),
            overallRating: rating(r.hospital_overall_rating),
            hospitalType: str(r.hospital_type),
            emergencyServices: /^yes$/i.test(clean(r.emergency_services)) ? true : /^no$/i.test(clean(r.emergency_services)) ? false : null,
            ownership: str(r.hospital_ownership),
        }),
    },
    home_health: {
        label: 'Home health agency',
        ds: '6jpm-sxkc',
        nameField: 'provider_name',
        toRow: (r) => ({
            ccn: str(r.cms_certification_number_ccn),
            name: str(r.provider_name),
            overallRating: rating(r.quality_of_patient_care_star_rating),
            offersNursing: /^yes$/i.test(clean(r.offers_nursing_care_services)) ? true : null,
            ownership: str(r.type_of_ownership),
        }),
    },
};

const type = TYPES[facilityType] ? facilityType : 'nursing_homes';
const conf = TYPES[type];

if (!name && !stateCode && !cityName) {
    log.warning('Add a facility name, a state, or a city to search.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Care Compare actor (admin@scrapemint.com)' } });
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

function queryUrl(offset, limit) {
    const usp = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const conds = [];
    if (name) conds.push({ property: conf.nameField, value: `%${name.toUpperCase()}%`, operator: 'like' });
    if (stateCode) conds.push({ property: 'state', value: stateCode, operator: '=' });
    if (cityName) conds.push({ property: 'citytown', value: cityName.toUpperCase(), operator: '=' });
    conds.forEach((c, i) => {
        usp.set(`conditions[${i}][property]`, c.property);
        usp.set(`conditions[${i}][value]`, c.value);
        usp.set(`conditions[${i}][operator]`, c.operator);
    });
    return `${BASE}/${conf.ds}/0?${usp}`;
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

const label = [name && `"${name}"`, cityName, stateCode].filter(Boolean).join(', ');
log.info(`CMS Care Compare ${conf.label.toLowerCase()}s: ${label}${minStars ? `, ${minStars}+ stars` : ''}...`);

let anyHit = false;
let failed = null;
let skippedLowRating = 0;
for (let offset = 0; !shouldStop(); offset += PAGE_SIZE) {
    const { json, error } = await getJson(queryUrl(offset, PAGE_SIZE));
    if (error) { failed = error; break; }
    const results = json?.results || [];
    if (results.length === 0) break;
    anyHit = true;
    for (const r of results) {
        if (shouldStop()) break;
        const row = conf.toRow(r);
        if (!row.ccn && !row.name) continue;
        if (minStars > 0 && (row.overallRating === null || row.overallRating < minStars)) { skippedLowRating += 1; continue; }
        await flushRow({
            facilityType: conf.label,
            ...row,
            address: str(r.address) || str(r.provider_address),
            city: str(r.citytown),
            state: str(r.state),
            zip: str(r.zip_code),
            county: str(r.countyparish),
            url: COMPARE,
            source: `${BASE}/${conf.ds}`,
        }, true);
    }
    if (results.length < PAGE_SIZE) break;
}

if (failed && !anyHit) {
    await flushRow({ type: 'note', input: label, found: false, note: `search failed (${failed}); not charged, try again later` }, false);
} else if (rowsPushed === 0) {
    const why = minStars > 0 && skippedLowRating > 0 ? `no ${conf.label.toLowerCase()}s met the ${minStars}+ star filter` : `no ${conf.label.toLowerCase()}s matched`;
    await flushRow({ type: 'note', input: label, found: false, note: `${why}; not charged` }, false);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${minStars ? `, ${skippedLowRating} below ${minStars} stars skipped` : ''}${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
