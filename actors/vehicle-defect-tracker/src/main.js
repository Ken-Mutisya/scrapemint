// Vehicle Defect Tracker
//
// Owner-reported defect complaints from the keyless NHTSA API, joined to open
// recalls so you can see which components owners keep reporting that no recall
// covers. Complaints are the leading indicator: they arrive years before a
// recall, if a recall ever comes.
//
// Endpoints (all keyless):
//   /complaints/complaintsByVehicle    owner complaints, full narrative
//   /recalls/recallsByVehicle          recall campaigns
//   /products/vehicle/models           model names valid for an endpoint
//
// Three upstream shapes that a naive read gets wrong:
//
//   * The same complaint is returned under every body-style variant of a model.
//     A 2021 F-150 has six variants returning 5,026 rows for 1,202 distinct
//     complaints, because 956 of them appear five times each. Summing the
//     per-variant counts, which is the obvious way to combine them, overstates
//     the total by roughly four times. Rows are deduped on the ODI number.
//
//   * The two endpoints disagree about model names. The complaint endpoint
//     rejects "F-150" with HTTP 400 and serves "F-150 SUPER CREW"; the recall
//     endpoint does the exact opposite. A 400 here means "wrong name for this
//     endpoint", not "no data", so it is retried against the variant list
//     rather than reported as an empty result.
//
//   * Complaint dates are MM/DD/YYYY and recall dates are DD/MM/YYYY, in the
//     same API. Reading a recall as MM/DD turns 10 November into 11 October
//     without erroring, which quietly breaks any comparison of when owners
//     complained against when the recall landed.
//
// And one that changes what the data means: a complaint carries both
// dateOfIncident and dateComplaintFiled, and they are far apart. Across one
// model year the median gap is 15 days but the 90th percentile is 278 days and
// the longest is over 20,000. Trending on the filing date -- the tidier field --
// puts old failures in recent buckets and destroys the only thing this data is
// good for. Everything here trends on the incident date.
//
// Free tier: first 3 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';
import {
    parseComplaintDate, parseRecallDate, daysBetween, variantsFor, dedupeComplaints,
    splitComplaintComponents, topLevelComponent, severityOf, meetsSeverity,
    intOrNull, componentTrends,
} from './nhtsa.js';

const FREE_TIER_ROWS = 3;
const BASE = 'https://api.nhtsa.gov';
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 250;
const SEEN_STORE = 'vehicle-defect-seen';
const SEEN_KEY = 'seen-complaints';
const SEEN_CAP = 50000;

/* Declared up here, not beside the fetchers that use them. The mode dispatch
 * below is a top-level await, so the module body is already running by the time
 * those fetchers execute: an arrow function assigned to a `const` further down
 * would still be in its temporal dead zone and throw, even though the hoisted
 * `function` declarations around it resolve fine. */
const complaintsUrl = (mk, md, y) => `${BASE}/complaints/complaintsByVehicle`
    + `?make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}&modelYear=${encodeURIComponent(y)}`;
const recallsUrl = (mk, md, y) => `${BASE}/recalls/recallsByVehicle`
    + `?make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}&modelYear=${encodeURIComponent(y)}`;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'complaints',
    make = '',
    model = '',
    yearFrom,
    yearTo,
    components = [],
    minSeverity = 'all',
    dateFrom,
    dateTo,
    includeRecallCheck = true,
    includeSummary = true,
    newOnly = false,
    maxRows = 200,
} = input;

const wantMode = ['complaints', 'componentTrends'].includes(mode) ? mode : 'complaints';
const wantMake = String(make ?? '').trim();
const wantModel = String(model ?? '').trim();
const thisYear = new Date().getUTCFullYear();
const y1 = intOrNull(yearFrom);
const y2 = intOrNull(yearTo);
const years = buildYears(y1, y2);
const componentFilter = new Set(
    (Array.isArray(components) ? components : [components])
        .map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean),
);
const wantSeverity = ['all', 'crashOrFire', 'injuryOrDeath'].includes(minSeverity)
    ? minSeverity : 'all';
const from = isDate(dateFrom) ? dateFrom : null;
const to = isDate(dateTo) ? dateTo : null;

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const store = newOnly ? await Actor.openKeyValueStore(SEEN_STORE) : null;
const seenAcrossRuns = new Set(newOnly ? ((await store.getValue(SEEN_KEY)) ?? []) : []);
const seenThisRun = new Set();
const modelListCache = new Map();
let pushed = 0;
let stop = false;

if (!wantMake || !wantModel || !years.length) {
    log.warning('Need a make, a model and at least one model year.');
} else {
    log.info(
        `${wantMode} | ${wantMake} ${wantModel} | years ${years[0]}-${years[years.length - 1]}`
        + ` | severity>=${wantSeverity}${componentFilter.size ? ` | components=${[...componentFilter].join(',')}` : ''}`
        + `${from || to ? ` | incident ${from ?? 'any'} to ${to ?? 'any'}` : ''}`
        + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
    );
    await run();
}

if (newOnly) {
    const merged = [...new Set([...seenAcrossRuns, ...seenThisRun])].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} complaints for the next run.`);
}

log.info(`Done. Pushed ${pushed} rows.`);
await Actor.exit();

// ---------- flow ----------

async function run() {
    for (const year of years) {
        if (done()) break;

        const complaints = await fetchComplaints(wantMake, wantModel, year);
        if (!complaints.length) {
            log.warning(`No complaints found for ${wantMake} ${wantModel} ${year}.`);
            continue;
        }
        const recalls = includeRecallCheck ? await fetchRecalls(wantMake, wantModel, year) : [];

        const rows = complaints
            .map(({ complaint, variants }) => toComplaintRow(complaint, variants, year, recalls))
            .filter((r) => keep(r))
            /* Most recently filed first. NHTSA returns no meaningful order, and
             * for anyone watching a model the newest reports are the point. */
            .sort((a, b) => String(b.dateComplaintFiled ?? '').localeCompare(String(a.dateComplaintFiled ?? '')));

        log.info(
            `${wantMake} ${wantModel} ${year}: ${complaints.length} distinct complaints`
            + `${rows.length !== complaints.length ? `, ${rows.length} after filters` : ''}`
            + `${includeRecallCheck ? `, ${recalls.length} recalls` : ''}`,
        );

        if (wantMode === 'componentTrends') {
            for (const trend of componentTrends(rows, recalls)) {
                if (done()) break;
                if (componentFilter.size && !componentFilter.has(trend.component)) continue;
                await pushRow({
                    make: wantMake,
                    model: wantModel,
                    modelYear: year,
                    ...trend,
                    source: 'NHTSA Office of Defects Investigation',
                    scrapedAt: new Date().toISOString(),
                }, 'component_trend', `${year}:${trend.component}`);
            }
        } else {
            for (const row of rows) {
                if (done()) break;
                await pushRow(row, 'complaint', String(row.odiNumber));
            }
            /* Monitor mode remembers every complaint this run actually looked
             * at, not just the ones that fit under maxRows. The whole set was
             * fetched, so anything left out was seen and skipped, not missed.
             * Without this, maxRows doubles as a watermark and each run hands
             * back the next few complaints down the list instead of only what
             * has been filed since -- walking the archive a page at a time and
             * charging for it. */
            if (newOnly) for (const row of rows) seenThisRun.add(String(row.odiNumber));
        }
        await sleep(SPACING_MS);
    }
}

// ---------- upstream ----------

/**
 * Every distinct complaint for a vehicle.
 *
 * The requested name is tried first. A 400 from this endpoint means the name is
 * not how NHTSA stores this model rather than that no complaints exist, so the
 * body-style variants are tried instead and their results deduped.
 */
async function fetchComplaints(mk, md, year) {
    const batches = [];
    const exact = await getJson(complaintsUrl(mk, md, year));
    if (exact?.results?.length) {
        batches.push({ model: md.toUpperCase(), results: exact.results });
        return dedupeComplaints(batches);
    }

    const variants = variantsFor(await modelList(mk, year, 'c'), md);
    if (!variants.length) return [];
    log.info(
        `"${md}" is stored under ${variants.length} body-style variant(s) for ${year}; `
        + 'querying each and deduping on ODI number.',
    );
    for (const v of variants) {
        if (Date.now() > SOFT_DEADLINE_AT) break;
        const j = await getJson(complaintsUrl(mk, v, year));
        if (j?.results?.length) batches.push({ model: v, results: j.results });
        await sleep(SPACING_MS);
    }
    const deduped = dedupeComplaints(batches);
    const raw = batches.reduce((n, b) => n + b.results.length, 0);
    if (raw > deduped.length) {
        log.info(`${raw} rows across variants collapsed to ${deduped.length} distinct complaints.`);
    }
    return deduped;
}

/** Recalls, with the same exact-then-variants fallback in the other direction. */
async function fetchRecalls(mk, md, year) {
    const shape = (results) => results.map((r) => ({
        campaignNumber: r?.NHTSACampaignNumber ?? null,
        component: r?.Component ?? null,
        summary: r?.Summary ?? null,
        consequence: r?.Consequence ?? null,
        remedy: r?.Remedy ?? null,
        manufacturer: r?.Manufacturer ?? null,
        reportReceivedDate: parseRecallDate(r?.ReportReceivedDate),
        doNotDrive: r?.parkIt === true,
        parkOutside: r?.parkOutSide === true,
        overTheAirUpdate: r?.overTheAirUpdate === true,
    }));

    const exact = await getJson(recallsUrl(mk, md, year));
    if (exact?.results?.length) return shape(exact.results);

    const variants = variantsFor(await modelList(mk, year, 'r'), md);
    const byCampaign = new Map();
    for (const v of variants) {
        if (Date.now() > SOFT_DEADLINE_AT) break;
        const j = await getJson(recallsUrl(mk, v, year));
        for (const r of shape(j?.results ?? [])) {
            if (r.campaignNumber && !byCampaign.has(r.campaignNumber)) {
                byCampaign.set(r.campaignNumber, r);
            }
        }
        await sleep(SPACING_MS);
    }
    return [...byCampaign.values()];
}

async function modelList(mk, year, issueType) {
    const key = `${mk}|${year}|${issueType}`.toLowerCase();
    if (modelListCache.has(key)) return modelListCache.get(key);
    const j = await getJson(
        `${BASE}/products/vehicle/models?modelYear=${encodeURIComponent(year)}`
        + `&make=${encodeURIComponent(mk)}&issueType=${issueType}`,
    );
    const list = (j?.results ?? []).map((r) => r?.model).filter(Boolean);
    modelListCache.set(key, list);
    return list;
}

// ---------- shaping ----------

function toComplaintRow(c, variants, year, recalls) {
    const comps = splitComplaintComponents(c?.components);
    const incident = parseComplaintDate(c?.dateOfIncident);
    const filed = parseComplaintDate(c?.dateComplaintFiled);

    const recallComponents = new Set(
        recalls.map((r) => topLevelComponent(r.component)).filter(Boolean),
    );
    const matching = recalls.filter((r) => comps.includes(topLevelComponent(r.component)));

    return {
        odiNumber: c?.odiNumber ?? null,
        make: wantMake,
        model: wantModel,
        modelYear: year,
        manufacturer: c?.manufacturer ?? null,
        /* Which NHTSA body-style entries this complaint came back under. Proof
         * the dedupe happened, and the reason a naive sum inflates counts. */
        matchedModelVariants: variants,
        appearedUnderVariantCount: variants.length,

        components: comps.length ? comps : null,
        primaryComponent: comps.length ? comps[0] : null,

        crash: c?.crash === true,
        fire: c?.fire === true,
        numberOfInjuries: intOrNull(c?.numberOfInjuries),
        numberOfDeaths: intOrNull(c?.numberOfDeaths),
        severity: severityOf(c),

        /* Both dates are published because they answer different questions.
         * When the failure happened is what trends; when it was reported is
         * what NHTSA acted on. */
        dateOfIncident: incident,
        dateComplaintFiled: filed,
        filingLagDays: daysBetween(incident, filed),

        vin: c?.vin || null,
        summary: includeSummary ? (c?.summary ?? null) : null,

        /* Null when the recall check was switched off, so "this component has
         * no recall" stays distinct from "nobody looked". False here is a real
         * finding: recalls were fetched and none covers this component. */
        componentHasRecall: includeRecallCheck ? matching.length > 0 : null,
        matchingRecallCampaigns: matching.length
            ? [...new Set(matching.map((r) => r.campaignNumber).filter(Boolean))] : null,
        recallCheckPerformed: includeRecallCheck,
        vehicleRecallComponentCount: includeRecallCheck ? recallComponents.size : null,

        source: 'NHTSA Office of Defects Investigation',
        scrapedAt: new Date().toISOString(),
    };
}

function keep(row) {
    if (!meetsSeverity(row.severity, wantSeverity)) return false;
    if (componentFilter.size) {
        const hit = (row.components ?? []).some((c) => componentFilter.has(c));
        if (!hit) return false;
    }
    /* Date filters run on the incident date, never the filing date. A vehicle
     * that failed in 2020 and was reported in 2026 belongs in 2020. */
    if (from || to) {
        if (!row.dateOfIncident) return false;
        if (from && row.dateOfIncident < from) return false;
        if (to && row.dateOfIncident > to) return false;
    }
    return true;
}

// ---------- output ----------

async function pushRow(row, eventName, key) {
    if (seenThisRun.has(key)) return 'duplicate';
    seenThisRun.add(key);
    if (newOnly && seenAcrossRuns.has(key)) return 'alreadySeen';

    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 50 === 0) log.info(`Pushed ${pushed} rows...`);
    return 'pushed';
}

// ---------- helpers ----------

/* Model years, oldest first. Bounded so a typo cannot ask for two centuries of
 * requests. */
function buildYears(a, b) {
    const lo = a ?? b;
    const hi = b ?? a;
    if (lo === null || lo === undefined) return [];
    const start = Math.max(1949, Math.min(lo, hi));
    const end = Math.min(thisYear + 2, Math.max(lo, hi));
    if (end < start) return [];
    const out = [];
    for (let y = start; y <= end && out.length < 60; y += 1) out.push(y);
    return out;
}

function done() {
    if (stop) return true;
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        stop = true;
        return true;
    }
    return false;
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Scrapemint Vehicle Defect actor (admin@scrapemint.com)',
                    Accept: 'application/json',
                },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            /* A 400 is how this API says the model name is not one it stores,
             * which the caller handles by trying variants. It is not an error
             * worth logging on every lookup. */
            if (res.status === 400) return null;
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return JSON.parse(await res.text());
        } catch (err) {
            if (attempt === 3) {
                log.warning(`fetch failed: ${err?.message}`);
                return null;
            }
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

function isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
