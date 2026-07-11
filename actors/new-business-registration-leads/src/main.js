// New Business Registration Leads: Fresh LLC & Corp Filings by State
//
// Strategy
// --------
// Pull newly formed business entities from official state open-data feeds
// (Socrata JSON, keyless, updated daily): Colorado business entities,
// Connecticut business registry (includes business email + NAICS where
// filed), New York daily corporation filings (formation filing types
// only). Rows are normalized across states, filterable by keyword, city
// and lookback window. Optional cross-run dedupe turns a scheduled run
// into a daily new-business prospect feed.
//
// Pay per event
// -------------
//   lead_row ($0.01) per pushed business. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 1000;
const MAX_PAGES_PER_STATE = 10;
const FETCH_TIMEOUT_MS = 30000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    states = ['CO', 'CT', 'NY'],
    keywords = [],
    cities = [],
    daysBack = 7,
    maxRows = 100,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const stateList = asList(states).map((s) => s.toUpperCase()).filter((s) => ['CO', 'CT', 'NY'].includes(s));
const kws = asList(keywords).map((k) => k.toLowerCase());
const cityList = asList(cities).map((c) => c.toLowerCase());
const days = Math.max(1, Math.min(30, Number(daysBack) || 7));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

if (!stateList.length) {
    log.error('No valid states selected. Supported: CO, CT, NY.');
    await Actor.exit();
}

const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const cutoffSoql = `${cutoff}T00:00:00`;
log.info(`States: ${stateList.join(', ')} | registrations since ${cutoff} | cap ${cap} row(s).`);

const seenStore = dedupe ? await Actor.openKeyValueStore('nbr-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-ids')) || []) seen.add(String(k));

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                accept: 'application/json',
                'User-Agent': 'NewBusinessRegistrationLeads/1.0 (+https://apify.com/scrapemint/new-business-registration-leads)',
            },
        });
        if (!res.ok) {
            log.warning(`HTTP ${res.status} from ${url.split('?')[0]}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`Fetch failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function pageSocrata(base, params) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const url = `${base}?${params}&$limit=${PAGE_SIZE}&$offset=${page * PAGE_SIZE}`;
        const batch = await fetchJson(url);
        if (!batch || !Array.isArray(batch)) break;
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }
    return rows;
}

const val = (v) => {
    const s = String(v ?? '').trim();
    return s ? s : null;
};
const day = (v) => (v ? String(v).slice(0, 10) : null);
const yesNo = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    if (['yes', 'y', 'true', '1'].includes(s)) return true;
    if (['no', 'n', 'false', '0'].includes(s)) return false;
    return null;
};

// --- state adapters: each returns normalized rows ---

async function fetchCO() {
    const params = `$where=${encodeURIComponent(`entityformdate > '${cutoffSoql}'`)}&$order=entityformdate%20DESC`;
    const raw = await pageSocrata('https://data.colorado.gov/resource/4ykn-tg5h.json', params);
    return raw.map((r) => ({
        state: 'CO',
        businessName: val(r.entityname),
        entityType: val(r.entitytype),
        registrationKind: val(r.jurisdictonofformation) && val(r.jurisdictonofformation) !== 'CO' ? 'foreign_registration' : 'formation',
        registrationDate: day(r.entityformdate),
        status: val(r.entitystatus),
        street: val(r.principaladdress1),
        city: val(r.principalcity),
        regionState: val(r.principalstate),
        zip: val(r.principalzipcode),
        county: null,
        email: null,
        naicsCode: null,
        womanOwned: null,
        veteranOwned: null,
        minorityOwned: null,
        agentName: val(r.agentorganizationname) || [val(r.agentfirstname), val(r.agentlastname)].filter(Boolean).join(' ') || null,
        agentStreet: val(r.agentprincipaladdress1),
        agentCity: val(r.agentprincipalcity),
        agentState: val(r.agentprincipalstate),
        agentZip: val(r.agentprincipalzipcode),
        sourceId: val(r.entityid),
        sourceDataset: 'data.colorado.gov/4ykn-tg5h',
    }));
}

async function fetchCT() {
    const params = `$where=${encodeURIComponent(`date_registration > '${cutoffSoql}'`)}&$order=date_registration%20DESC`;
    const raw = await pageSocrata('https://data.ct.gov/resource/n7gp-d28j.json', params);
    return raw.map((r) => ({
        state: 'CT',
        businessName: val(r.name),
        entityType: val(r.business_type),
        registrationKind: /foreign/i.test(String(r.citizenship || '')) ? 'foreign_registration' : 'formation',
        registrationDate: day(r.date_registration),
        status: val(r.status),
        street: val(r.billingstreet),
        city: val(r.billingcity),
        regionState: val(r.billingstate),
        zip: val(r.billingpostalcode),
        county: null,
        email: val(r.business_email_address),
        naicsCode: val(r.naics_code),
        womanOwned: yesNo(r.woman_owned_organization),
        veteranOwned: yesNo(r.veteran_owned_organization),
        minorityOwned: yesNo(r.minority_owned_organization),
        agentName: null,
        agentStreet: null,
        agentCity: null,
        agentState: null,
        agentZip: null,
        sourceId: val(r.accountnumber) || val(r.id),
        sourceDataset: 'data.ct.gov/n7gp-d28j',
    }));
}

const NY_FORMATION_TYPES = [
    'ARTICLES OF ORGANIZATION',
    'CERTIFICATE OF INCORPORATION',
    'CERTIFICATE OF LIMITED PARTNERSHIP',
    'APPLICATION OF AUTHORITY',
];

async function fetchNY() {
    const inList = NY_FORMATION_TYPES.map((t) => `'${t}'`).join(',');
    const where = `filing_date > '${cutoffSoql}' AND filing_type in(${inList})`;
    const params = `$where=${encodeURIComponent(where)}&$order=filing_date%20DESC`;
    const raw = await pageSocrata('https://data.ny.gov/resource/k4vb-judh.json', params);
    return raw.map((r) => ({
        state: 'NY',
        businessName: val(r.corp_name),
        entityType: val(r.entity_type),
        registrationKind: r.filing_type === 'APPLICATION OF AUTHORITY' ? 'foreign_registration' : 'formation',
        registrationDate: day(r.filing_date),
        status: null,
        // NY daily filings publish the service-of-process address, not a
        // principal office street address; county is the best locator.
        street: val(r.sop_addr1),
        city: val(r.sop_city),
        regionState: val(r.sop_state),
        zip: val(r.sop_zip5),
        county: val(r.cnty_prin_ofc),
        email: null,
        naicsCode: null,
        womanOwned: null,
        veteranOwned: null,
        minorityOwned: null,
        agentName: val(r.filer_name),
        agentStreet: val(r.filer_addr1),
        agentCity: val(r.filer_city),
        agentState: val(r.filer_state),
        agentZip: val(r.filer_zip5),
        sourceId: val(r.film_num) || val(r.dos_id),
        sourceDataset: 'data.ny.gov/k4vb-judh',
    }));
}

const ADAPTERS = { CO: fetchCO, CT: fetchCT, NY: fetchNY };

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'lead_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- collect, filter, merge ---
const perState = await Promise.all(stateList.map(async (s) => {
    const rows = await ADAPTERS[s]();
    log.info(`${s}: ${rows.length} new registration(s) since ${cutoff}.`);
    return rows;
}));

const lists = perState.map((rows) => {
    let l = rows.filter((r) => r.businessName);
    if (kws.length) l = l.filter((r) => kws.some((k) => r.businessName.toLowerCase().includes(k)));
    if (cityList.length) l = l.filter((r) => r.city && cityList.includes(r.city.toLowerCase()));
    if (seen.size) l = l.filter((r) => !seen.has(`${r.state}:${r.sourceId}`));
    l.sort((a, b) => String(b.registrationDate).localeCompare(String(a.registrationDate)));
    return l;
});
// Interleave states round-robin (each newest-first) so a multi-state run
// samples every selected registry instead of only the freshest one.
const all = [];
for (let i = 0, more = true; more; i++) {
    more = false;
    for (const l of lists) {
        if (i < l.length) { all.push(l[i]); more = true; }
    }
}

if (!all.length) {
    log.warning('0 matching registrations. Widen daysBack or drop keyword/city filters.');
    await Actor.exit();
}
log.info(`${all.length} match(es) after filters; pushing up to ${cap}.`);

const scrapedAt = new Date().toISOString();
for (const row of all.slice(0, cap)) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    seen.add(`${row.state}:${row.sourceId}`);
    await flushRow({ ...row, scrapedAt });
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen].slice(-300000));
}

log.info(`Done. ${rowsPushed} lead row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
