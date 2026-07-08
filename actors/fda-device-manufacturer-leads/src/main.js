// FDA Medical Device Manufacturer Leads: Registered Establishments
//
// Strategy
// --------
// Query openFDA's device registration & listing endpoint (keyless public
// JSON on the FDA establishment registry) per state x product-code combo,
// optionally narrowed by establishment type and firm-name keyword,
// paginate 1000 rows at a time, dedupe by registration number, and push
// one row per establishment with firm, address, the official
// correspondent's name and phone, and the devices it makes. Optional
// cross-run dedupe turns a scheduled run into a new-registration feed.
//
// Pay per event
// -------------
//   manufacturer_contact_row ($0.01) per establishment pushed WITH a
//   correspondent name or phone. manufacturer_row ($0.005) for the rest.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 1000;
const MAX_SKIP = 25000; // openFDA hard limit
const FETCH_TIMEOUT_MS = 30000;
const BASE = 'https://api.fda.gov/device/registrationlisting.json';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    states = [],
    productCodes = [],
    establishmentType,
    nameKeyword,
    usOnly = false,
    maxManufacturers = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const sts = asList(states).map((s) => s.toUpperCase());
const codes = asList(productCodes).map((c) => c.toUpperCase());
const estType = String(establishmentType || '').trim();
const nameKw = String(nameKeyword || '').trim();
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxManufacturers) || 50));

const seenStore = dedupe ? await Actor.openKeyValueStore('fda-device-seen') : null;
const seen = new Set();
if (seenStore) for (const r of (await seenStore.getValue('seen-regs')) || []) seen.add(String(r));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'FdaDeviceManufacturerLeads/1.0 (+https://apify.com/scrapemint/fda-device-manufacturer-leads)' },
        });
        // openFDA returns 404 for a search that matches nothing.
        if (res.status === 404) return { results: [], notFound: true };
        if (!res.ok) { log.warning(`openFDA HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// openFDA search: terms AND-joined; phrases quoted; spaces as +.
const phrase = (v) => `"${String(v).replace(/"/g, '')}"`;
function buildSearch(state, code) {
    const terms = [];
    if (state) terms.push(`registration.state_code:${state}`);
    if (code) terms.push(`products.product_code:${code}`);
    if (estType) terms.push(`establishment_type:${phrase(estType)}`);
    if (nameKw) terms.push(`registration.name:${phrase(nameKw)}`);
    if (usOnly) terms.push('registration.iso_country_code:US');
    return terms.join('+AND+').replace(/ /g, '+');
}

function toRow(r, matched) {
    const reg = r.registration || {};
    const oo = reg.owner_operator || {};
    const oc = oo.official_correspondent || {};
    const contactName = [oc.first_name, oc.middle_initial, oc.last_name]
        .map((s) => String(s || '').trim()).filter(Boolean).join(' ') || null;
    // Phones arrive like "x-201-5746985-x"; strip sentinel x's and separators.
    const rawPhone = oc.phone_number || null;
    const phone = rawPhone ? (rawPhone.replace(/^x-|-x$/g, '').replace(/[^\d+]/g, '') || null) : null;
    const products = (r.products || []).map((p) => ({
        productCode: p.product_code || null,
        deviceName: p.openfda?.device_name || null,
        medicalSpecialty: p.openfda?.medical_specialty_description || null,
        deviceClass: p.openfda?.device_class || null,
        regulationNumber: p.openfda?.regulation_number || null,
    }));
    const specialties = [...new Set(products.map((p) => p.medicalSpecialty).filter(Boolean))];
    return {
        firmName: reg.name || null,
        registrationNumber: reg.registration_number || null,
        feiNumber: reg.fei_number || null,
        establishmentType: (r.establishment_type || [])[0] || null,
        establishmentTypes: r.establishment_type || null,
        ownerOperator: oo.firm_name || null,
        contactName,
        contactPhone: phone,
        address: [reg.address_line_1, reg.address_line_2].map((s) => String(s || '').trim()).filter(Boolean).join(', ') || null,
        city: reg.city || null,
        state: reg.state_code || null,
        zip: reg.zip_code || null,
        country: reg.iso_country_code || null,
        registrationExpiryYear: reg.reg_expiry_date_year || null,
        deviceCount: products.length,
        medicalSpecialties: specialties.length ? specialties : null,
        products: products.length ? products.slice(0, 25) : null,
        matchedState: matched.state || null,
        matchedProductCode: matched.code || null,
        scrapedAt: new Date().toISOString(),
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- state x product-code combos (empty lists collapse to one blank pass) ---
const combos = [];
for (const s of sts.length ? sts : ['']) {
    for (const c of codes.length ? codes : ['']) combos.push({ state: s, code: c });
}

// Give each combo a fair share so a large first combo can't starve the rest.
const perComboCap = Math.ceil(cap / combos.length);
log.info(`Searching openFDA device registry: ${combos.length} combo(s), cap ${cap} (${perComboCap}/combo)${estType ? `, type "${estType}"` : ''}${nameKw ? `, name "${nameKw}"` : ''}.`);

outer:
for (const combo of combos) {
    const search = buildSearch(combo.state, combo.code);
    const searchParam = search ? `search=${search}&` : '';
    let skip = 0;
    let comboRows = 0;
    while (rowsPushed < cap && comboRows < perComboCap && skip <= MAX_SKIP) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const d = await getJson(`${BASE}?${searchParam}limit=${PAGE_SIZE}&skip=${skip}`);
        if (!d) break;
        const results = d.results || [];
        if (!results.length) break;
        for (const r of results) {
            if (rowsPushed >= cap || comboRows >= perComboCap) break;
            const row = toRow(r, combo);
            if (!row.registrationNumber) continue;
            if (seen.has(row.registrationNumber)) continue;
            seen.add(row.registrationNumber);
            const hasContact = Boolean(row.contactName || row.contactPhone);
            await flushRow(row, hasContact ? 'manufacturer_contact_row' : 'manufacturer_row');
            comboRows += 1;
        }
        if (results.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
    }
    log.info(`Combo${combo.state ? ` ${combo.state}` : ''}${combo.code ? `/${combo.code}` : ''}: ${comboRows} establishment(s). Total ${rowsPushed}.`);
    if (rowsPushed >= cap) break;
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-regs', [...seen].slice(-400000));
}

log.info(`Done. ${rowsPushed} manufacturer row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
