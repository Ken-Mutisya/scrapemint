// FMCSA Trucking Carrier Leads
//
// Strategy
// --------
// The US DOT publishes FMCSA's Company Census File (every registered motor
// carrier, broker and shipper with a USDOT number) on its open-data portal
// (data.transportation.gov, Socrata dataset az4n-8mr2). It is refreshed daily
// and carries the contact details carriers file on their MCS-150: phone,
// email, company officers, physical and mailing address, plus fleet size,
// drivers, operation type, cargo classes and authority dockets.
//
// Two modes:
//   new     newly registered carriers (add_date within the last N days): the
//           lead feed for insurance, factoring, ELD, fuel cards, dispatch,
//           truck sales and compliance services.
//   lookup  specific USDOT numbers, MC numbers or company names.
// Filters are pushed down into SoQL so only matching rows are downloaded.
// No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   carrier ($0.003) per carrier row. The first FREE_TIER_ROWS rows of every
//   run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const BASE = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const PAGE = 1000;
const FETCH_TIMEOUT_MS = 60000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

const CARGO = {
    general_freight: ['crgo_genfreight', 'General freight'],
    household_goods: ['crgo_household', 'Household goods'],
    metal_sheets_coils: ['crgo_metalsheet', 'Metal: sheets, coils, rolls'],
    motor_vehicles: ['crgo_motoveh', 'Motor vehicles'],
    driveaway_towaway: ['crgo_drivetow', 'Drive/tow away'],
    logs_poles_lumber: ['crgo_logpole', 'Logs, poles, beams, lumber'],
    building_materials: ['crgo_bldgmat', 'Building materials'],
    mobile_homes: ['crgo_mobilehome', 'Mobile homes'],
    machinery_large_objects: ['crgo_machlrg', 'Machinery, large objects'],
    fresh_produce: ['crgo_produce', 'Fresh produce'],
    liquids_gases: ['crgo_liqgas', 'Liquids/gases'],
    intermodal_containers: ['crgo_intermodal', 'Intermodal containers'],
    passengers: ['crgo_passengers', 'Passengers'],
    oilfield_equipment: ['crgo_oilfield', 'Oilfield equipment'],
    livestock: ['crgo_livestock', 'Livestock'],
    grain_feed_hay: ['crgo_grainfeed', 'Grain, feed, hay'],
    coal_coke: ['crgo_coalcoke', 'Coal/coke'],
    meat: ['crgo_meat', 'Meat'],
    garbage_refuse: ['crgo_garbage', 'Garbage/refuse'],
    us_mail: ['crgo_usmail', 'US mail'],
    chemicals: ['crgo_chem', 'Chemicals'],
    dry_bulk: ['crgo_drybulk', 'Commodities dry bulk'],
    refrigerated_food: ['crgo_coldfood', 'Refrigerated food'],
    beverages: ['crgo_beverages', 'Beverages'],
    paper_products: ['crgo_paperprod', 'Paper products'],
    utilities: ['crgo_utility', 'Utilities'],
    agricultural_supplies: ['crgo_farmsupp', 'Agricultural/farm supplies'],
    construction: ['crgo_construct', 'Construction'],
    water_well: ['crgo_waterwell', 'Water well'],
    other: ['crgo_cargoothr', 'Other'],
};
const OPERATION = { A: 'Interstate', B: 'Intrastate hazmat', C: 'Intrastate non-hazmat' };
const STATUS = { A: 'Active', I: 'Inactive', P: 'Pending' };

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    mode = 'new',
    addedWithinDays = 7,
    states = [],
    dotNumbers = [],
    mcNumbers = [],
    companyNames = [],
    operation = 'any',
    authorizedForHireOnly = false,
    minPowerUnits = 0,
    maxPowerUnits = 0,
    cargoTypes = [],
    hazmatOnly = false,
    activeOnly = true,
    requireEmail = false,
    requirePhone = false,
    maxRows = 500,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 500));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const isoDate = (s) => (/^\d{8}$/.test(String(s || '')) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

const where = [];
const dots = arr(dotNumbers).map((s) => s.replace(/\D/g, '')).filter(Boolean);
const mcs = arr(mcNumbers).map((s) => s.replace(/\D/g, '')).filter(Boolean);
const names = arr(companyNames).map((s) => s.toUpperCase());
if (mode === 'lookup') {
    const ors = [];
    if (dots.length) ors.push(`dot_number in (${dots.map(q).join(',')})`);
    if (mcs.length) ors.push(`(${['docket1', 'docket2', 'docket3'].map((d) => `${d} in (${mcs.map(q).join(',')})`).join(' OR ')})`);
    for (const n of names.slice(0, 20)) ors.push(`(upper(legal_name) like ${q(`%${n}%`)} OR upper(dba_name) like ${q(`%${n}%`)})`);
    if (!ors.length) {
        await Actor.pushData({ note: 'Lookup mode needs dotNumbers, mcNumbers or companyNames. Not charged.' });
        await Actor.exit();
    }
    where.push(`(${ors.join(' OR ')})`);
} else {
    const days = Math.max(1, Math.min(365, Number(addedWithinDays) || 7));
    where.push(`add_date >= ${q(ymd(new Date(Date.now() - days * 86400000)))}`);
}
const st = arr(states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
if (st.length) where.push(`phy_state in (${st.map(q).join(',')})`);
if (operation === 'interstate') where.push(`carrier_operation = 'A'`);
if (operation === 'intrastate') where.push(`carrier_operation in ('B','C')`);
if (authorizedForHireOnly) where.push(`classdef like '%AUTHORIZED FOR HIRE%'`);
if (hazmatOnly) where.push(`hm_ind = 'Y'`);
if (activeOnly && mode !== 'lookup') where.push(`status_code = 'A'`);
if (requireEmail) where.push(`email_address IS NOT NULL`);
if (requirePhone) where.push(`phone IS NOT NULL`);
// power_units is stored as text; cast for numeric comparison.
if (num(minPowerUnits) > 0) where.push(`power_units::number >= ${Math.floor(num(minPowerUnits))}`);
if (num(maxPowerUnits) > 0) where.push(`power_units::number <= ${Math.floor(num(maxPowerUnits))}`);
const cargo = arr(cargoTypes).map((c) => c.toLowerCase()).filter((c) => CARGO[c]);
const badCargo = arr(cargoTypes).filter((c) => !CARGO[c.toLowerCase()]);
if (badCargo.length) log.warning(`Unknown cargo types ignored: ${badCargo.join(', ')}. Known: ${Object.keys(CARGO).join(', ')}`);
if (cargo.length) where.push(`(${cargo.map((c) => `${CARGO[c][0]} = 'X'`).join(' OR ')})`);

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            log.warning(`HTTP ${res.status}, retrying`);
        } catch (err) {
            if (attempt === 3 || /^HTTP 4/.test(err.message)) throw err;
            log.warning(`${err.message}, retrying`);
        } finally { clearTimeout(t); }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return [];
}

const title = (s) => (s ? String(s).trim() : null);
const phone = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : (d ? d : null); };
const toRow = (r) => {
    const dockets = [1, 2, 3].map((i) => (r[`docket${i}`] ? { prefix: r[`docket${i}prefix`] || null, number: r[`docket${i}`], status: r[`docket${i}_status_code`] || null } : null)).filter(Boolean);
    const cargoList = Object.values(CARGO).filter(([f]) => r[f] === 'X').map(([, label]) => label);
    if (r.crgo_cargoothr_desc) cargoList.push(`Other: ${r.crgo_cargoothr_desc}`);
    return {
        dotNumber: r.dot_number,
        legalName: title(r.legal_name),
        dbaName: title(r.dba_name),
        status: STATUS[r.status_code] || r.status_code || null,
        addedDate: isoDate(r.add_date),
        mcs150Date: isoDate(String(r.mcs150_date || '').slice(0, 8)),
        email: r.email_address ? String(r.email_address).trim().toLowerCase() : null,
        phone: phone(r.phone),
        cellPhone: phone(r.cell_phone),
        fax: phone(r.fax),
        officer1: title(r.company_officer_1),
        officer2: title(r.company_officer_2),
        businessType: title(r.business_org_desc),
        street: title(r.phy_street),
        city: title(r.phy_city),
        state: r.phy_state || null,
        zip: r.phy_zip || null,
        country: r.phy_country || null,
        mailingStreet: title(r.carrier_mailing_street),
        mailingCity: title(r.carrier_mailing_city),
        mailingState: r.carrier_mailing_state || null,
        mailingZip: r.carrier_mailing_zip || null,
        operation: OPERATION[r.carrier_operation] || r.carrier_operation || null,
        classifications: r.classdef ? String(r.classdef).split(';').map((s) => s.trim()).filter(Boolean) : [],
        authorizedForHire: /AUTHORIZED FOR HIRE/.test(r.classdef || ''),
        hazmat: r.hm_ind === 'Y',
        powerUnits: num(r.power_units),
        trucks: num(r.truck_units),
        buses: num(r.bus_units),
        totalDrivers: num(r.total_drivers),
        cdlDrivers: num(r.total_cdl),
        interstateDrivers: num(r.driver_inter_total),
        operatingRadius: [
            r.interstate_beyond_100_miles === '1' && 'Interstate beyond 100 miles',
            r.interstate_within_100_miles === '1' && 'Interstate within 100 miles',
            r.intrastate_beyond_100_miles === '1' && 'Intrastate beyond 100 miles',
            r.intrastate_within_100_miles === '1' && 'Intrastate within 100 miles',
        ].filter(Boolean),
        cargoTypes: cargoList,
        mileage: num(r.mcs150_mileage) || null,
        mileageYear: num(r.mcs150_mileage_year) || null,
        dockets,
        mcNumber: dockets.find((d) => d.prefix === 'MC')?.number || null,
        safetyRating: r.safety_rating || null,
        safetyRatingDate: isoDate(r.safety_rating_date),
        saferUrl: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${r.dot_number}`,
        scrapedAt: new Date().toISOString(),
    };
};

const whereSql = where.join(' AND ');
log.info(`Query: ${whereSql}`);
let offset = 0;
let pushed = 0;
while (pushed < cap && !pastDeadline()) {
    const limit = Math.min(PAGE, cap - pushed);
    const url = `${BASE}?$where=${encodeURIComponent(whereSql)}&$order=${encodeURIComponent('add_date DESC, dot_number DESC')}&$limit=${limit}&$offset=${offset}`;
    let rows;
    try { rows = await getJson(url); } catch (err) {
        log.error(`Query failed: ${err.message}`);
        if (!pushed) await Actor.pushData({ note: `FMCSA open-data query failed (${err.message.slice(0, 120)}). Not charged.` });
        break;
    }
    if (!rows.length) break;
    for (const r of rows) {
        if (pushed >= cap) break;
        await Actor.pushData(toRow(r));
        pushed += 1;
        if (pushed > FREE_TIER_ROWS) {
            try { await Actor.charge({ eventName: 'carrier' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
        }
    }
    offset += rows.length;
    if (rows.length < limit) break;
}
if (!pushed) await Actor.pushData({ note: mode === 'lookup' ? 'No carriers matched. Not charged.' : 'No new carriers matched these filters. Widen addedWithinDays or remove filters. Not charged.' });
await Actor.setValue('SUMMARY', { mode, carriers: pushed, query: whereSql });
log.info(`Done. ${pushed} carriers.`);
await Actor.exit();
