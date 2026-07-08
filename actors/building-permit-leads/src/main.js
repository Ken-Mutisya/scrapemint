// Building Permit Leads Scraper: New Permits by City & Trade
//
// Strategy
// --------
// Pull recently issued building permits from official city open-data APIs
// (keyless Socrata/Carto/CKAN JSON), normalize each city's schema into one
// row shape (permit id, issue date, type, work description, address,
// valuation, contractor where the city publishes it), filter by work
// keyword, minimum valuation, and issue window, and dedupe by city+permit
// id. Optional cross-run dedupe turns a scheduled run into a daily feed of
// new permits per trade.
//
// Pay per event
// -------------
//   permit_row ($0.01) charged per permit pushed. First 2 rows per run
//   are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_CITY = 10;
const FETCH_TIMEOUT_MS = 30000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    cities = [],
    keywords = [],
    minValuation,
    sinceDays = 7,
    maxPermits = 50,
    dedupe = false,
} = input;

const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const iso = (v) => {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const joinParts = (...parts) => parts.map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null;

// Chicago publishes contractors as one of up to 15 generic contact slots.
function chicagoContractor(r) {
    for (let i = 1; i <= 15; i++) {
        const type = r[`contact_${i}_type`];
        if (type && /CONTRACTOR/i.test(String(type))) return r[`contact_${i}_name`] || null;
    }
    return null;
}

const CITIES = {
    chicago: {
        label: 'Chicago, IL',
        driver: 'socrata',
        base: 'https://data.cityofchicago.org/resource/ydr8-5enu.json',
        dateField: 'issue_date',
        map: (r) => ({
            permitId: r.permit_ || r.id,
            issueDate: iso(r.issue_date),
            permitType: r.permit_type || null,
            workClass: r.work_type || null,
            description: r.work_description || null,
            address: joinParts(r.street_number, r.street_direction, r.street_name),
            zip: null,
            valuation: num(r.reported_cost),
            contractorName: chicagoContractor(r),
            contractorPhone: null,
            status: r.permit_status || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
        }),
    },
    nyc: {
        label: 'New York City, NY',
        driver: 'socrata',
        base: 'https://data.cityofnewyork.us/resource/rbx6-tga4.json',
        dateField: 'issued_date',
        map: (r) => ({
            permitId: joinParts(r.job_filing_number, r.work_permit) || r.job_filing_number,
            issueDate: iso(r.issued_date),
            permitType: r.work_type || null,
            workClass: r.filing_reason || null,
            description: r.job_description || null,
            address: joinParts(r.house_no, r.street_name) + (r.borough ? `, ${r.borough}` : ''),
            zip: null,
            valuation: num(r.estimated_job_costs),
            contractorName: r.applicant_business_name || null,
            contractorPhone: null,
            status: null,
            latitude: null,
            longitude: null,
        }),
    },
    austin: {
        label: 'Austin, TX',
        driver: 'socrata',
        base: 'https://data.austintexas.gov/resource/3syk-w9eu.json',
        dateField: 'issue_date',
        map: (r) => ({
            permitId: r.permit_number || null,
            issueDate: iso(r.issue_date),
            permitType: r.permit_type_desc || null,
            workClass: r.work_class || null,
            description: r.description || null,
            address: r.original_address1 || r.permit_location || null,
            zip: r.original_zip || null,
            valuation: num(r.total_job_valuation) ?? num(r.total_valuation_remodel),
            contractorName: r.contractor_company_name || r.contractor_full_name || null,
            contractorPhone: r.contractor_phone || null,
            status: r.status_current || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
        }),
    },
    sanfrancisco: {
        label: 'San Francisco, CA',
        driver: 'socrata',
        base: 'https://data.sfgov.org/resource/i98e-djp9.json',
        dateField: 'issued_date',
        map: (r) => ({
            permitId: r.permit_number || null,
            issueDate: iso(r.issued_date),
            permitType: r.permit_type_definition || null,
            workClass: null,
            description: r.description || null,
            address: joinParts(r.street_number, r.street_name, r.street_suffix),
            zip: r.zipcode || null,
            valuation: num(r.estimated_cost) ?? num(r.revised_cost),
            contractorName: null,
            contractorPhone: null,
            status: r.status || null,
            latitude: null,
            longitude: null,
        }),
    },
    seattle: {
        label: 'Seattle, WA',
        driver: 'socrata',
        base: 'https://data.seattle.gov/resource/76t5-zqzr.json',
        dateField: 'issueddate',
        map: (r) => ({
            permitId: r.permitnum || null,
            issueDate: iso(r.issueddate),
            permitType: r.permittypedesc || null,
            workClass: r.permitclassmapped || null,
            description: r.description || null,
            address: r.originaladdress1 || null,
            zip: r.originalzip || null,
            valuation: num(r.estprojectcost),
            contractorName: r.contractorcompanyname || null,
            contractorPhone: null,
            status: r.statuscurrent || null,
            latitude: num(r.latitude),
            longitude: num(r.longitude),
        }),
    },
    philadelphia: {
        label: 'Philadelphia, PA',
        driver: 'carto',
        base: 'https://phl.carto.com/api/v2/sql',
        table: 'permits',
        dateField: 'permitissuedate',
        map: (r) => ({
            permitId: r.permitnumber || null,
            issueDate: iso(r.permitissuedate),
            permitType: r.permitdescription || null,
            workClass: r.typeofwork || null,
            description: r.approvedscopeofwork || null,
            address: r.address || null,
            zip: r.zip || null,
            valuation: null,
            contractorName: r.contractorname || null,
            contractorPhone: null,
            status: r.status || null,
            latitude: null,
            longitude: null,
        }),
    },
    boston: {
        label: 'Boston, MA',
        driver: 'ckan',
        base: 'https://data.boston.gov/api/3/action/datastore_search',
        resource: '6ddcd912-32a0-43df-9908-63574f8c7e77',
        dateField: 'issued_date',
        map: (r) => ({
            permitId: r.permitnumber || null,
            issueDate: iso(r.issued_date),
            permitType: r.permittypedescr || null,
            workClass: r.worktype || null,
            description: joinParts(r.description, r.comments && r.comments !== r.description ? `- ${r.comments}` : ''),
            address: joinParts(r.address, r.city) || null,
            zip: r.zip || null,
            valuation: num(r.declared_valuation),
            contractorName: r.applicant || null,
            contractorPhone: null,
            status: r.status || null,
            latitude: num(r.gpsy),
            longitude: num(r.gpsx),
        }),
    },
};

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const requested = asList(cities).map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
const cityKeys = requested.length ? requested.filter((c) => CITIES[c]) : Object.keys(CITIES);
const unknown = requested.filter((c) => !CITIES[c]);
if (unknown.length) log.warning(`Unknown cities skipped: ${unknown.join(', ')}. Supported: ${Object.keys(CITIES).join(', ')}.`);
const kws = asList(keywords).map((k) => k.toLowerCase());
const minVal = Number.isFinite(Number(minValuation)) && minValuation != null ? Number(minValuation) : null;
const days = Math.max(1, Math.min(90, Number(sinceDays) || 7));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxPermits) || 50));
const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

if (!cityKeys.length) {
    log.warning(`No supported cities selected. Supported: ${Object.keys(CITIES).join(', ')}.`);
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('permits-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-permits')) || []) seen.add(String(k));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'BuildingPermitLeads/1.0 (+https://apify.com/scrapemint/building-permit-leads)' },
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
            // Null dates sort first in Socrata DESC order; exclude them.
            $where: `${c.dateField} >= '${sinceIso}'`,
        });
        return await getJson(`${c.base}?${p.toString()}`) || [];
    }
    if (c.driver === 'carto') {
        const sql = `SELECT * FROM ${c.table} WHERE ${c.dateField} >= '${sinceIso}' ORDER BY ${c.dateField} DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
        const d = await getJson(`${c.base}?q=${encodeURIComponent(sql)}`);
        return d?.rows || [];
    }
    if (c.driver === 'ckan') {
        const p = new URLSearchParams({
            resource_id: c.resource,
            limit: String(PAGE_SIZE),
            offset: String(offset),
            sort: `${c.dateField} desc`,
        });
        const d = await getJson(`${c.base}?${p.toString()}`);
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
            await Actor.charge({ eventName: 'permit_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const perCityCap = Math.ceil(cap / cityKeys.length);
log.info(`Scanning ${cityKeys.length} city(ies) for permits issued since ${sinceIso}${kws.length ? `, keywords: ${kws.join(', ')}` : ''}${minVal != null ? `, min valuation $${minVal}` : ''}. Cap ${cap} (${perCityCap}/city).`);

outer:
for (const city of cityKeys) {
    const c = CITIES[city];
    let cityRows = 0;
    let pastWindow = false;
    for (let page = 0; page < MAX_PAGES_PER_CITY && cityRows < perCityCap && rowsPushed < cap && !pastWindow; page++) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const records = await fetchPage(city, page * PAGE_SIZE);
        if (!records.length) break;
        for (const raw of records) {
            if (cityRows >= perCityCap || rowsPushed >= cap) break;
            const m = c.map(raw);
            if (!m.permitId) continue;
            // CKAN has no server-side date filter; rows are DESC so stop at the window edge.
            if (m.issueDate && m.issueDate < sinceIso) { pastWindow = true; break; }
            if (!m.issueDate) continue;
            const key = `${city}:${m.permitId}`;
            if (seen.has(key)) continue;
            const hay = `${m.description || ''} ${m.permitType || ''} ${m.workClass || ''}`.toLowerCase();
            const kw = kws.length ? kws.find((k) => hay.includes(k)) : null;
            if (kws.length && !kw) continue;
            if (minVal != null && (m.valuation == null || m.valuation < minVal)) continue;
            seen.add(key);
            await flushRow({
                city: c.label,
                cityKey: city,
                ...m,
                matchedKeyword: kw,
                scrapedAt: new Date().toISOString(),
            });
            cityRows += 1;
        }
        if (records.length < PAGE_SIZE) break;
    }
    log.info(`${c.label}: ${cityRows} permit row(s).`);
    if (rowsPushed >= cap) break;
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-permits', [...seen].slice(-400000));
}

log.info(`Done. ${rowsPushed} permit row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
