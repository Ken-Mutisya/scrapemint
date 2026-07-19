// Crime Data Scraper (US Cities)
//
// Strategy
// --------
// Official city open-data (Socrata SODA) police incident datasets, keyless
// JSON, one vendored endpoint + field map per city. Every city is
// normalized to the same row shape. SoQL per request:
//   $where=<dateField> >= '<floor>' AND <dateField> IS NOT NULL
//   $order=<dateField> DESC, $limit/$offset pagination.
// The IS NOT NULL guard matters: Socrata DESC sorts put null dates FIRST.
//
// City notes:
//   * NYC's complaint dataset refreshes quarterly (documented in the
//     input and README).
//   * Los Angeles was probed and EXCLUDED - its dataset stopped updating
//     in 2024 (NIBRS transition).
//   * Dallas's date1 column compares lexicographically (text-ish format
//     "YYYY-MM-DD hh:mm:ss..."), which still works for >= 'YYYY-MM-DD'.
//   * Socrata omits null fields from rows entirely, so every accessor
//     tolerates missing keys.
//
// Pay per event
// -------------
//   incident_row per incident. Empty windows and unreachable feeds are
//   free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 500;
const PAGE_SIZE = 1000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { cities = ['chicago'], crimeType = '', sinceDays = 30, newOnly = false, maxPerCity = 200, maxRows = 500 } = input;

const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const perCity = clampNum(maxPerCity, 200, 1, 50000);
const rowCap = clampNum(maxRows, 500, 1, 100000);
const days = clampNum(sinceDays, 30, 1, 3650);
const typeFilter = String(crimeType || '').trim().toUpperCase().replace(/'/g, "''");
const floor = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const toIso = (v) => {
    if (!v) return null;
    const t = Date.parse(String(v).replace(' ', 'T'));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// One entry per city: Socrata host, dataset id, date column, columns the
// crime-type filter searches, and the normalizer to the shared row shape.
const CITIES = {
    chicago: {
        label: 'Chicago, IL',
        host: 'data.cityofchicago.org',
        ds: 'ijzp-q8t2',
        dateField: 'date',
        searchFields: ['primary_type', 'description'],
        toRow: (r) => ({
            incidentId: r.case_number || r.id || null,
            occurredAt: toIso(r.date),
            category: r.primary_type || null,
            description: r.description || null,
            address: r.block || null,
            area: r.ward ? `Ward ${r.ward}` : null,
            place: r.location_description || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
            arrest: typeof r.arrest === 'boolean' ? r.arrest : null,
            status: null,
        }),
    },
    nyc: {
        label: 'New York City, NY',
        host: 'data.cityofnewyork.us',
        ds: '5uac-w243',
        dateField: 'cmplnt_fr_dt',
        searchFields: ['ofns_desc', 'pd_desc'],
        toRow: (r) => ({
            incidentId: r.cmplnt_num || null,
            occurredAt: toIso(r.cmplnt_fr_dt),
            category: r.ofns_desc || null,
            description: r.pd_desc || null,
            address: null,
            area: r.boro_nm || null,
            place: r.prem_typ_desc || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
            arrest: null,
            status: r.law_cat_cd || null,
        }),
    },
    san_francisco: {
        label: 'San Francisco, CA',
        host: 'data.sfgov.org',
        ds: 'wg3w-h783',
        dateField: 'incident_datetime',
        searchFields: ['incident_category', 'incident_description'],
        toRow: (r) => ({
            incidentId: r.incident_id || r.row_id || null,
            occurredAt: toIso(r.incident_datetime),
            category: r.incident_category || null,
            description: r.incident_description || null,
            address: r.intersection || null,
            area: r.analysis_neighborhood || r.police_district || null,
            place: null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
            arrest: r.resolution ? /arrest/i.test(r.resolution) : null,
            status: r.resolution || null,
        }),
    },
    seattle: {
        label: 'Seattle, WA',
        host: 'data.seattle.gov',
        ds: 'tazs-3rd5',
        dateField: 'offense_date',
        searchFields: ['offense_category', 'nibrs_offense_code_description'],
        toRow: (r) => ({
            incidentId: r.offense_id || r.report_number || null,
            occurredAt: toIso(r.offense_date),
            category: r.offense_category || null,
            description: r.nibrs_offense_code_description || null,
            address: r.block_address || null,
            area: r.neighborhood && r.neighborhood !== '-' ? r.neighborhood : null,
            place: null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
            arrest: null,
            status: null,
        }),
    },
    austin: {
        label: 'Austin, TX',
        host: 'data.austintexas.gov',
        ds: 'fdj4-gpfu',
        dateField: 'occ_date',
        searchFields: ['crime_type'],
        toRow: (r) => ({
            incidentId: r.incident_report_number || null,
            occurredAt: toIso(r.occ_date) || toIso(r.occ_date_time),
            category: r.crime_type || null,
            description: null,
            address: r.address || null,
            area: r.sector ? `Sector ${r.sector}` : null,
            place: r.location_type || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
            arrest: r.clearance_status ? /^c/i.test(r.clearance_status) : null,
            status: r.clearance_status || null,
        }),
    },
    dallas: {
        label: 'Dallas, TX',
        host: 'www.dallasopendata.com',
        ds: 'qv6i-rri7',
        dateField: 'date1',
        searchFields: ['nibrs_crime_category', 'offincident'],
        toRow: (r) => ({
            incidentId: r.incidentnum || null,
            occurredAt: toIso(r.date1),
            category: r.nibrs_crime_category || null,
            description: r.offincident || null,
            address: r.incident_address || null,
            area: r.division || null,
            place: r.premise || null,
            latitude: num(r.geocoded_column?.latitude),
            longitude: num(r.geocoded_column?.longitude),
            arrest: null,
            status: r.status || null,
        }),
    },
};

const cityKeys = [...new Set((Array.isArray(cities) ? cities : [cities]).map((c) => String(c || '').trim().toLowerCase()))].filter((c) => CITIES[c]);
if (cityKeys.length === 0) {
    log.warning(`No valid city given. Options: ${Object.keys(CITIES).join(', ')}.`);
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Crime Data actor (admin@scrapemint.com)' } });
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

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'incident_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const store = newOnly ? await Actor.openKeyValueStore('crime-data-seen') : null;
const SEEN_KEY = 'seen-incident-keys';
const SEEN_MAX = 400000;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- run ---------------------------------------------------------------------------

log.info(`Pulling ${cityKeys.length} cit(ies) since ${floor}${typeFilter ? `, crime type contains "${typeFilter}"` : ''}${newOnly ? ', NEW incidents only' : ''}...`);

for (const key of cityKeys) {
    if (shouldStop()) break;
    const c = CITIES[key];
    let emitted = 0;
    let anyHit = false;
    let failed = null;
    for (let offset = 0; emitted < perCity && !shouldStop(); offset += PAGE_SIZE) {
        // Socrata DESC sorts put null dates first - the IS NOT NULL guard is required.
        let where = `${c.dateField} >= '${floor}' AND ${c.dateField} IS NOT NULL`;
        if (typeFilter) {
            where += ` AND (${c.searchFields.map((f) => `upper(${f}) like '%${typeFilter}%'`).join(' OR ')})`;
        }
        const url = `https://${c.host}/resource/${c.ds}.json?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(`${c.dateField} DESC`)}&$limit=${PAGE_SIZE}&$offset=${offset}`;
        const { json, error } = await getJson(url);
        if (error || !Array.isArray(json)) { failed = error || 'unexpected response'; break; }
        if (json.length === 0) break;
        anyHit = anyHit || json.length > 0;
        for (const r of json) {
            if (emitted >= perCity || shouldStop()) break;
            const row = c.toRow(r);
            if (!row.incidentId && !row.occurredAt) continue;
            const seenKey = `${key}|${row.incidentId || row.occurredAt}`;
            if (newOnly && seen.has(seenKey)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(seenKey);
            await flushRow({ city: c.label, cityKey: key, ...row, source: `https://${c.host}/resource/${c.ds}.json` }, true);
            emitted += 1;
        }
        if (json.length < PAGE_SIZE) break;
    }
    if (failed && emitted === 0) {
        await flushRow({ type: 'note', input: key, found: false, note: `city feed failed (${failed}); not charged, try again later` }, false);
    } else if (emitted === 0 && !shouldStop()) {
        await flushRow({ type: 'note', input: key, found: false, note: `no ${newOnly ? 'new ' : ''}incidents matched in the last ${days} day(s)${key === 'nyc' ? ' (NYC refreshes quarterly - try 90+ days)' : ''}; not charged` }, false);
    }
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} incident key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
