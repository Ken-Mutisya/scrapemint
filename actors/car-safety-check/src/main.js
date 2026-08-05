// Car Info & Safety Check: VIN Decoder & Recalls
//
// Strategy
// --------
// Three keyless NHTSA (US government) JSON APIs, no browser, no proxy:
//   1. vPIC DecodeVINValuesBatch — decodes up to 50 VINs per POST into
//      make/model/year/engine/etc.
//   2. recalls/recallsByVehicle — open safety recalls per make+model+year.
//   3. complaints/complaintsByVehicle — owner complaint counts per
//      make+model+year.
//
// Two modes:
//   - VIN mode (vins given): one row per VIN with decoded details plus the
//     safety problems for that make+model+year. Safety lookups are cached
//     per make|model|year within the run, so 1,000 VINs of similar cars stay
//     at a handful of HTTP calls.
//   - Vehicle mode (no vins, make+model+year given): one row per safety
//     recall for that car; a single summary row when the car has none.
//
// Pay per event
// -------------
//   car_report per pushed row. VINs that fail to decode are pushed for
//   transparency but NOT charged. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const VPIC_BATCH = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/';
const RECALLS_URL = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
const COMPLAINTS_URL = 'https://api.nhtsa.gov/complaints/complaintsByVehicle';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const VIN_BATCH_SIZE = 50;
const FETCH_TIMEOUT_MS = 25000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    vins = [],
    make = null,
    model = null,
    year = null,
    includeComplaints = true,
    maxRows = 200,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const vinList = [...new Set(asTokens(vins).map((s) => s.toUpperCase().replace(/\s+/g, '')))];
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const vehicleMode = vinList.length === 0;

if (vehicleMode && !(make && model && Number(year))) {
    log.warning('Nothing to check. Either paste car ID numbers (VINs), or fill in make, model and year.');
    await Actor.exit();
}

// lenient: the NHTSA complaints API answers 400 with a valid JSON body
// ({count: 0}) for model names it does not know, so parse those instead of
// throwing.
async function fetchJson(url, opts = {}, { lenient = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            ...opts,
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-car-safety-check/0.1 (+https://apify.com)', ...(opts.headers || {}) },
        });
        if (!res.ok && !(lenient && res.status === 400)) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const asBool = (v) => v === true || v === 'Yes' || v === 'true';

function recallToProblem(r) {
    return {
        campaignNumber: r.NHTSACampaignNumber || null,
        component: r.Component || null,
        problem: r.Summary || null,
        risk: r.Consequence || null,
        fix: r.Remedy || null,
        reportedDate: r.ReportReceivedDate || null,
        doNotDrive: asBool(r.parkIt),
        parkOutside: asBool(r.parkOutSide),
        fixedOverTheAir: asBool(r.overTheAirUpdate),
    };
}

// The complaints database splits some models into body-style variants
// ("F-150" is stored as "F-150 REGULAR CAB", "F-150 SUPER CREW", ...). When
// the exact name has no complaints, the variants are queried and their
// complaints counted by distinct ODI number -- never by adding the counts up.
// See complaintCountFor for why.
const complaintModelsCache = new Map();
async function complaintModelVariants(mk, yr) {
    const key = `${mk}|${yr}`.toLowerCase();
    if (complaintModelsCache.has(key)) return complaintModelsCache.get(key);
    let models = [];
    try {
        const j = await fetchJson(`https://api.nhtsa.gov/products/vehicle/models?modelYear=${encodeURIComponent(yr)}&make=${encodeURIComponent(mk)}&issueType=c`, {}, { lenient: true });
        models = [...new Set((j.results || []).map((r) => String(r.model || '').toUpperCase()).filter(Boolean))];
    } catch (err) {
        log.warning(`Complaint model list failed for ${mk} ${yr}: ${err?.message}`);
    }
    complaintModelsCache.set(key, models);
    return models;
}

/* A complaint is filed against a vehicle, not a body style, so NHTSA returns
 * the same ODI number under every variant it applies to. Adding the per-variant
 * counts therefore counts most complaints several times over: a 2021 F-150 sums
 * to 5,024 across its six variants when only 1,202 are distinct, because 956 of
 * them appear five times each. The counts are combined by distinct ODI number
 * instead. */
async function complaintCountFor(mk, md, yr) {
    const exact = await fetchJson(`${COMPLAINTS_URL}?make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}&modelYear=${encodeURIComponent(yr)}`, {}, { lenient: true });
    const exactCount = Number(exact.count ?? exact.Count) || 0;
    /* One name means one result set, so there is nothing to overlap. */
    if (exactCount > 0) return exactCount;

    const mdUp = String(md).toUpperCase();
    const variants = (await complaintModelVariants(mk, yr))
        .filter((v) => v !== mdUp && v.startsWith(`${mdUp} `)).slice(0, 8);

    const odiNumbers = new Set();
    let largestVariantCount = 0;
    for (const v of variants) {
        try {
            const j = await fetchJson(`${COMPLAINTS_URL}?make=${encodeURIComponent(mk)}&model=${encodeURIComponent(v)}&modelYear=${encodeURIComponent(yr)}`, {}, { lenient: true });
            for (const c of (j.results || [])) {
                if (c?.odiNumber !== null && c?.odiNumber !== undefined) odiNumbers.add(c.odiNumber);
            }
            largestVariantCount = Math.max(largestVariantCount, Number(j.count ?? j.Count) || 0);
        } catch { /* variant lookups are best effort */ }
    }
    /* If a response carried a count but no rows to dedupe, the biggest single
     * variant is used. Every complaint within one variant is distinct, so that
     * is a floor on the real figure and can never overstate it the way a sum
     * would. */
    return odiNumbers.size > 0 ? odiNumbers.size : largestVariantCount;
}

// Safety data per make|model|year, cached within the run.
const safetyCache = new Map();
async function getSafety(mk, md, yr) {
    const key = `${mk}|${md}|${yr}`.toLowerCase();
    if (safetyCache.has(key)) return safetyCache.get(key);
    const out = { recalls: [], recallCount: 0, complaintCount: null };
    const params = `make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}&modelYear=${encodeURIComponent(yr)}`;
    try {
        const j = await fetchJson(`${RECALLS_URL}?${params}`);
        out.recalls = (j.results || []).map(recallToProblem);
        out.recallCount = Number(j.Count) || out.recalls.length;
    } catch (err) {
        log.warning(`Recall lookup failed for ${mk} ${md} ${yr}: ${err?.message}`);
    }
    if (includeComplaints) {
        try {
            out.complaintCount = await complaintCountFor(mk, md, yr);
        } catch (err) {
            log.warning(`Complaint lookup failed for ${mk} ${md} ${yr}: ${err?.message}`);
        }
    }
    safetyCache.set(key, out);
    return out;
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, { chargeable = true } = {}) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'car_report' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const clean = (v) => {
    const s = String(v ?? '').trim();
    return s === '' ? null : s;
};

if (vehicleMode) {
    // One row per safety recall for the given make+model+year.
    const yr = Number(year);
    log.info(`Checking safety problems for ${make} ${model} ${yr}...`);
    const safety = await getSafety(make, model, yr);
    const base = {
        make: String(make), model: String(model), modelYear: yr,
        safetyProblemCount: safety.recallCount,
        complaintCount: safety.complaintCount,
    };
    if (safety.recalls.length === 0) {
        await flushRow({ ...base, message: 'No safety recalls found for this car.' });
    } else {
        for (const p of safety.recalls) {
            if (rowsPushed >= cap) break;
            await flushRow({ ...base, ...p });
        }
    }
} else {
    log.info(`Checking ${vinList.length} car ID number(s) in batches of ${VIN_BATCH_SIZE}...`);
    outer:
    for (let i = 0; i < vinList.length; i += VIN_BATCH_SIZE) {
        if (rowsPushed >= cap) break;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

        const batch = vinList.slice(i, i + VIN_BATCH_SIZE);
        let results;
        try {
            const j = await fetchJson(VPIC_BATCH, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: `DATA=${encodeURIComponent(batch.join(';'))}&format=json`,
            });
            results = j.Results || [];
        } catch (err) {
            log.warning(`VIN decode batch failed (${err?.message}); skipping ${batch.length} VIN(s).`);
            continue;
        }

        for (const r of results) {
            if (rowsPushed >= cap) break outer;
            if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break outer; }

            const mk = clean(r.Make), md = clean(r.Model), yr = clean(r.ModelYear);
            const decoded = Boolean(mk && yr);
            const row = {
                vin: clean(r.VIN),
                decoded,
                make: mk,
                model: md,
                modelYear: yr ? Number(yr) : null,
                trim: clean(r.Trim),
                series: clean(r.Series),
                bodyStyle: clean(r.BodyClass),
                vehicleType: clean(r.VehicleType),
                driveType: clean(r.DriveType),
                engineCylinders: clean(r.EngineCylinders),
                engineSizeL: clean(r.DisplacementL),
                fuelType: clean(r.FuelTypePrimary),
                transmission: clean(r.TransmissionStyle),
                doors: clean(r.Doors),
                plantCountry: clean(r.PlantCountry),
                manufacturer: clean(r.Manufacturer),
            };
            if (!decoded) {
                row.decodeNote = clean(r.ErrorText) || 'Could not decode this car ID number.';
                await flushRow(row, { chargeable: false });
                continue;
            }
            if (md) {
                const safety = await getSafety(mk, md, yr);
                row.safetyProblemCount = safety.recallCount;
                row.safetyProblems = safety.recalls;
                row.complaintCount = safety.complaintCount;
            } else {
                row.safetyProblemCount = null;
                row.safetyProblems = [];
                row.complaintCount = null;
            }
            await flushRow(row);
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${chargeableRows} chargeable (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; first ${FREE_TIER_ROWS} free).`);
await Actor.exit();
