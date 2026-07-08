// Healthcare Provider Leads Scraper: NPI Contacts by Specialty
//
// Strategy
// --------
// Query the official CMS NPI registry (keyless public JSON API on NPPES
// data) per specialty x location combo, paginate 200 rows at a time,
// dedupe by NPI, and push one row per provider with practice phone,
// address, specialty taxonomy, and, for organizations, the authorized
// official (decision-maker name, title, and phone). Optional cross-run
// dedupe turns a scheduled run into a new-prospect feed.
//
// Pay per event
// -------------
//   provider_row ($0.01) charged per provider pushed WITH a phone number.
//   Providers without any phone are free rows. First 2 rows per run are
//   free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 200;
const MAX_SKIP = 5000;
const FETCH_TIMEOUT_MS = 25000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    specialties = [],
    states = [],
    cities = [],
    postalCodes = [],
    providerType = 'all',
    maxProviders = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const specs = asList(specialties);
const sts = asList(states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
const cts = asList(cities);
const zips = asList(postalCodes);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxProviders) || 50));
const enumType = providerType === 'individual' ? 'NPI-1' : providerType === 'organization' ? 'NPI-2' : null;

if (!specs.length && !cts.length && !zips.length) {
    log.warning('Provide at least one of "specialties", "cities", or "postalCodes" (the registry rejects state-only searches).');
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('npi-seen') : null;
const seen = new Set();
if (seenStore) for (const n of (await seenStore.getValue('seen-npis')) || []) seen.add(String(n));

async function getJson(params) {
    const p = new URLSearchParams({ version: '2.1', ...params });
    const url = `https://npiregistry.cms.hhs.gov/api/?${p.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'HealthcareProviderLeads/1.0 (+https://apify.com/scrapemint/healthcare-provider-leads)' },
        });
        if (!res.ok) { log.warning(`NPI registry HTTP ${res.status}`); return null; }
        const d = await res.json();
        if (d.Errors?.length) { log.warning(`NPI registry: ${d.Errors[0]?.description}`); return null; }
        return d;
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function toRow(r, matchedSpecialty) {
    const b = r.basic || {};
    const isOrg = r.enumeration_type === 'NPI-2';
    const addrs = r.addresses || [];
    const loc = addrs.find((a) => a.address_purpose === 'LOCATION') || addrs[0] || {};
    const taxes = r.taxonomies || [];
    const tax = taxes.find((t) => t.primary) || taxes[0] || {};
    const officialName = [b.authorized_official_first_name, b.authorized_official_last_name]
        .filter(Boolean).join(' ') || null;
    return {
        npi: String(r.number),
        providerType: isOrg ? 'organization' : 'individual',
        name: isOrg
            ? (b.organization_name || null)
            : ([b.first_name, b.last_name].filter(Boolean).join(' ') || null),
        credential: b.credential || null,
        specialty: tax.desc || null,
        taxonomyCode: tax.code || null,
        licenseNumber: tax.license || null,
        licenseState: tax.state || null,
        phone: loc.telephone_number || null,
        fax: loc.fax_number || null,
        address1: loc.address_1 || null,
        address2: loc.address_2 || null,
        city: loc.city || null,
        state: loc.state || null,
        postalCode: loc.postal_code || null,
        authorizedOfficialName: isOrg ? officialName : null,
        authorizedOfficialTitle: isOrg ? (b.authorized_official_title_or_position || null) : null,
        authorizedOfficialPhone: isOrg ? (b.authorized_official_telephone_number || null) : null,
        status: b.status || null,
        enumerationDate: b.enumeration_date || null,
        lastUpdated: b.last_updated || null,
        matchedSpecialty: matchedSpecialty || null,
        profileUrl: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
        scrapedAt: new Date().toISOString(),
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    const hasPhone = Boolean(row.phone || row.authorizedOfficialPhone);
    if (hasPhone && rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'provider_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- build specialty x location combos ---
const locs = [];
if (cts.length) {
    for (const c of cts) for (const s of sts.length ? sts : ['']) locs.push({ city: c, state: s });
} else if (zips.length) {
    for (const z of zips) locs.push({ postal: z });
} else if (sts.length) {
    for (const s of sts) locs.push({ state: s });
} else {
    locs.push({});
}
const combos = [];
for (const sp of specs.length ? specs : ['']) {
    for (const l of locs) {
        // The registry rejects state-only criteria; skip combos with nothing else.
        if (!sp && !l.city && !l.postal) continue;
        combos.push({ specialty: sp, ...l });
    }
}

log.info(`Searching NPI registry: ${combos.length} search combo(s), cap ${cap}${enumType ? `, type ${enumType}` : ''}.`);

outer:
for (const c of combos) {
    let skip = 0;
    while (rowsPushed < cap && skip <= MAX_SKIP) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const params = { limit: String(PAGE_SIZE), skip: String(skip) };
        if (c.specialty) params.taxonomy_description = c.specialty;
        if (c.state) params.state = c.state;
        if (c.city) params.city = c.city;
        if (c.postal) params.postal_code = c.postal;
        if (enumType) params.enumeration_type = enumType;
        const d = await getJson(params);
        const results = d?.results || [];
        if (!results.length) break;
        for (const r of results) {
            if (rowsPushed >= cap) break;
            const npi = String(r.number);
            if (seen.has(npi)) continue;
            seen.add(npi);
            await flushRow(toRow(r, c.specialty || null));
        }
        if (results.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
    }
    log.info(`Combo "${c.specialty || '(any)'}"${c.state ? `/${c.state}` : ''}${c.city ? `/${c.city}` : ''}${c.postal ? `/${c.postal}` : ''}: ${rowsPushed} row(s) total so far.`);
    if (rowsPushed >= cap) break;
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-npis', [...seen].slice(-500000));
}

log.info(`Done. ${rowsPushed} provider row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
