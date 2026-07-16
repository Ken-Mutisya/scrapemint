// Restaurant Inspection Leads: Health Violations by City
//
// Strategy
// --------
// Pull recent restaurant health inspections from official city/county
// open-data APIs (keyless Socrata + CKAN JSON), normalize each source's
// schema into one row per inspection (business name, address, phone where
// published, date, result, score/grade, grouped violation texts), filter by
// violation keyword and window, and dedupe by city+inspection id. Optional
// cross-run dedupe turns a scheduled run into a daily feed of fresh
// violations per city.
//
// Pay per event
// -------------
//   inspection_row ($0.01) charged per inspection pushed. First 2 rows per
//   run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_CITY = 5;
const FETCH_TIMEOUT_MS = 30000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    cities = [],
    keywords = [],
    onlyWithViolations = false,
    sinceDays = 14,
    maxRows = 25,
    dedupe = false,
} = input;

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[$,%]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const iso = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const clean = (v) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    return s || null;
};
const joinParts = (...parts) => parts.map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null;

// Chicago publishes all violations of an inspection pipe-joined in one field.
function chicagoViolations(r) {
    if (!r.violations) return [];
    return String(r.violations).split(' | ').map((v) => clean(v)).filter(Boolean);
}

// Each source yields raw records; `group` maps a record to an inspection key
// so per-violation datasets (NYC, King County, Boston) collapse into one row
// per inspection, and `map` builds the row from the grouped records.
const CITIES = {
    nyc: {
        label: 'New York City, NY',
        driver: 'socrata',
        base: 'https://data.cityofnewyork.us/resource/43nn-pn8j.json',
        dateField: 'inspection_date',
        group: (r) => `${r.camis}|${r.inspection_date}`,
        map: (rs) => {
            const r = rs[0];
            const violations = rs
                .filter((v) => v.violation_description)
                .map((v) => clean(`${v.violation_code ? `[${v.violation_code}${/^Critical$/i.test(v.critical_flag || '') ? ', critical' : ''}] ` : ''}${v.violation_description}`));
            return {
                inspectionId: `${r.camis}-${iso(r.inspection_date)}`,
                businessName: clean(r.dba),
                businessType: clean(r.cuisine_description),
                address: (() => {
                    const street = joinParts(r.building, r.street);
                    if (!street) return clean(r.boro);
                    return r.boro ? `${street}, ${r.boro}` : street;
                })(),
                zip: clean(r.zipcode),
                phone: clean(r.phone),
                inspectionDate: iso(r.inspection_date),
                inspectionType: clean(r.inspection_type),
                result: clean(r.action),
                score: num(r.score),
                grade: clean(r.grade),
                violations,
                criticalCount: rs.filter((v) => /^Critical$/i.test(v.critical_flag || '')).length,
                latitude: num(r.latitude),
                longitude: num(r.longitude),
            };
        },
    },
    chicago: {
        label: 'Chicago, IL',
        driver: 'socrata',
        base: 'https://data.cityofchicago.org/resource/4ijn-s7e5.json',
        dateField: 'inspection_date',
        group: (r) => String(r.inspection_id),
        map: (rs) => {
            const r = rs[0];
            const violations = chicagoViolations(r);
            return {
                inspectionId: String(r.inspection_id),
                businessName: clean(r.dba_name) || clean(r.aka_name),
                businessType: clean(r.facility_type),
                address: clean(r.address),
                zip: clean(r.zip),
                phone: null,
                inspectionDate: iso(r.inspection_date),
                inspectionType: clean(r.inspection_type),
                result: clean(r.results),
                score: null,
                grade: null,
                violations,
                criticalCount: null,
                latitude: num(r.latitude),
                longitude: num(r.longitude),
            };
        },
    },
    austin: {
        label: 'Austin, TX',
        driver: 'socrata',
        base: 'https://data.austintexas.gov/resource/ecmv-9xxi.json',
        dateField: 'inspection_date',
        group: (r) => `${r.facility_id}|${r.inspection_date}`,
        map: (rs) => {
            const r = rs[0];
            return {
                inspectionId: `${r.facility_id}-${iso(r.inspection_date)}`,
                businessName: clean(r.restaurant_name),
                businessType: null,
                address: clean(r.address),
                zip: clean(r.zip_code),
                phone: null,
                inspectionDate: iso(r.inspection_date),
                inspectionType: clean(r.process_description),
                result: null,
                score: num(r.score),
                grade: null,
                violations: [],
                criticalCount: null,
                latitude: null,
                longitude: null,
            };
        },
    },
    boston: {
        label: 'Boston, MA',
        driver: 'ckan-sql',
        base: 'https://data.boston.gov/api/3/action/datastore_search_sql',
        resource: '4582bec6-2b4f-4f9e-bc55-cbaa73117f4c',
        dateField: 'resultdttm',
        group: (r) => `${r.licenseno}|${r.resultdttm}`,
        map: (rs) => {
            const r = rs[0];
            const violations = rs
                .filter((v) => v.violdesc)
                .map((v) => clean(`${v.violdesc}${v.comments ? ` - ${v.comments}` : ''}`));
            return {
                inspectionId: `${r.licenseno}-${iso(r.resultdttm)}`,
                businessName: clean(r.businessname) || clean(r.dbaname),
                businessType: clean(r.descript),
                address: joinParts(r.address, r.city),
                zip: clean(r.zip),
                phone: null,
                inspectionDate: iso(r.resultdttm),
                inspectionType: null,
                result: clean(r.result),
                score: null,
                grade: null,
                violations,
                criticalCount: rs.filter((v) => String(v.viol_level || '').includes('***')).length,
                latitude: null,
                longitude: null,
            };
        },
    },
    seattle: {
        label: 'Seattle / King County, WA',
        driver: 'socrata',
        base: 'https://data.kingcounty.gov/resource/f29f-zza5.json',
        dateField: 'inspection_date',
        group: (r) => String(r.inspection_serial_num || `${r.business_id}|${r.inspection_date}`),
        map: (rs) => {
            const r = rs[0];
            const violations = rs
                .filter((v) => v.violation_description)
                .map((v) => clean(v.violation_description));
            return {
                inspectionId: String(r.inspection_serial_num || `${r.business_id}-${iso(r.inspection_date)}`),
                businessName: clean(r.name) || clean(r.program_identifier),
                businessType: clean(r.description),
                address: joinParts(r.address, r.city),
                zip: clean(r.zip_code),
                phone: clean(r.phone),
                inspectionDate: iso(r.inspection_date),
                inspectionType: clean(r.inspection_type),
                result: clean(r.inspection_result),
                score: num(r.inspection_score),
                grade: clean(r.grade),
                violations,
                criticalCount: rs.filter((v) => /red/i.test(v.violation_type || '')).length,
                latitude: num(r.latitude),
                longitude: num(r.longitude),
            };
        },
    },
};

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const requested = asList(cities).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
const cityKeys = requested.length ? requested.filter((c) => CITIES[c]) : Object.keys(CITIES);
const unknown = requested.filter((c) => !CITIES[c]);
if (unknown.length) log.warning(`Unknown cities skipped: ${unknown.join(', ')}. Supported: ${Object.keys(CITIES).join(', ')}.`);
const kws = asList(keywords).map((k) => k.toLowerCase());
const days = Math.max(1, Math.min(365, Number(sinceDays) || 14));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 25));
const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

if (!cityKeys.length) {
    log.warning(`No supported cities selected. Supported: ${Object.keys(CITIES).join(', ')}.`);
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('inspections-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-inspections')) || []) seen.add(String(k));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'RestaurantInspectionLeads/1.0 (+https://apify.com/scrapemint/restaurant-inspection-leads)' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Each driver returns one DESC-ordered page of raw records for an offset.
async function fetchPage(city, offset) {
    const c = CITIES[city];
    if (c.driver === 'socrata') {
        const p = new URLSearchParams({
            $limit: String(PAGE_SIZE),
            $offset: String(offset),
            $order: `${c.dateField} DESC`,
            // Null dates sort first in Socrata DESC order; the window filter also excludes them.
            $where: `${c.dateField} >= '${sinceIso}'`,
        });
        return await getJson(`${c.base}?${p.toString()}`) || [];
    }
    if (c.driver === 'ckan-sql') {
        // Boston's plain datastore_search cannot exclude null dates; SQL can.
        const sql = `SELECT * FROM "${c.resource}" WHERE ${c.dateField} >= '${sinceIso}' ORDER BY ${c.dateField} DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
        const d = await getJson(`${c.base}?sql=${encodeURIComponent(sql)}`);
        return d?.result?.records || [];
    }
    return [];
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'inspection_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const perCityCap = Math.ceil(cap / cityKeys.length);
log.info(`Scanning ${cityKeys.length} city(ies) for inspections since ${sinceIso}${kws.length ? `, keywords: ${kws.join(', ')}` : ''}${onlyWithViolations ? ', violations only' : ''}. Cap ${cap} (${perCityCap}/city).`);

outer:
for (const city of cityKeys) {
    const c = CITIES[city];
    let cityRows = 0;

    // Collect the window's raw records first: per-violation datasets are not
    // guaranteed adjacent within a page, so group before emitting.
    const groups = new Map();
    for (let page = 0; page < MAX_PAGES_PER_CITY; page++) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const records = await fetchPage(city, page * PAGE_SIZE);
        if (!records.length) break;
        for (const raw of records) {
            const key = c.group(raw);
            if (!key || key.includes('undefined')) continue;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(raw);
        }
        if (records.length < PAGE_SIZE) break;
        // Enough groups collected to satisfy this city's cap even after filters.
        if (groups.size >= perCityCap * 4) break;
    }

    for (const rs of groups.values()) {
        if (cityRows >= perCityCap || rowsPushed >= cap) break;
        const m = c.map(rs);
        if (!m.inspectionId || !m.businessName) continue;
        if (!m.inspectionDate || m.inspectionDate < sinceIso) continue;
        if (onlyWithViolations && !m.violations.length) continue;
        const hay = `${m.violations.join(' ')} ${m.result || ''} ${m.businessName}`.toLowerCase();
        const kw = kws.length ? kws.find((k) => hay.includes(k)) : null;
        if (kws.length && !kw) continue;
        const dedupeKey = `${city}:${m.inspectionId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        await flushRow({
            city: c.label,
            cityKey: city,
            ...m,
            violationCount: m.violations.length,
            matchedKeyword: kw,
            scrapedAt: new Date().toISOString(),
        });
        cityRows += 1;
    }
    log.info(`${c.label}: ${cityRows} inspection row(s).`);
    if (rowsPushed >= cap) break;
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-inspections', [...seen].slice(-400000));
}

log.info(`Done. ${rowsPushed} inspection row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
