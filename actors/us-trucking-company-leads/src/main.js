// US Trucking Company Leads
//
// Every interstate trucking company in the US has to register with the FMCSA
// and keep a census record current. That census is public, keyless and updated
// daily, which makes it the cleanest source of freshly formed carriers there
// is: roughly 390 new active carriers a day, most of them one to three trucks,
// with a phone number attached.
//
// Buyers are the people who sell to carriers on day one: freight brokers,
// factoring companies, truck insurance agents, ELD and telematics vendors,
// fuel card programmes.
//
// Source (keyless, no signup, Socrata):
//   https://datahub.transportation.gov/resource/az4n-8mr2.json
//
// Billing:
//   carrier_row ($0.02) charged per carrier pushed. First 2 rows per run free.
//   Note rows are never charged. With requireContact on (the default) a row is
//   only ever billed if it carries a phone or an email, so nobody pays for a
//   lead they cannot call.

import { Actor, log } from 'apify';

const DATASET = 'https://datahub.transportation.gov/resource/az4n-8mr2.json';
const FREE_TIER_ROWS = 2;
const PAGE_SIZE = 1000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'newCarriers',
    daysBack = 30,
    states = [],
    dotNumbers = [],
    minPowerUnits = null,
    maxPowerUnits = null,
    carrierOperation = 'any',
    requireContact = true,
    includeInactive = false,
    maxItems = 100,
} = input;

// Never outrun the platform timeout: derive the deadline from the environment
// rather than hardcoding a budget, so a longer run option actually helps.
const timeoutAt = Actor.getEnv().timeoutAt;
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - 15_000 : Date.now() + 570_000;
const outOfTime = () => Date.now() > deadline;

let rowsPushed = 0;
let charged = 0;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'carrier_row' });
            charged += 1;
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function note(text) {
    await Actor.pushData({ note: text });
}

/* ---------------------------------------------------------------- helpers */

// Number or null, never 0-from-absent. Number(null) and Number('') are both 0,
// so a bare cast would report a carrier as having 0 trucks when the census
// simply has no figure for it. A fleet of 0 is a real and different answer.
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function clean(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

// The census stores dates as YYYYMMDD strings. Comparisons stay string-typed
// (lexicographic order happens to equal chronological order for that format),
// but anything published is converted to a real ISO date.
function isoFromYmd(v) {
    const s = clean(v);
    if (!s || !/^\d{8}$/.test(s)) return null;
    const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
    const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? null : `${y}-${m}-${d}`;
}

function ymdDaysAgo(days) {
    const d = new Date(Date.now() - days * 86_400_000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const STATUS = { A: 'active', I: 'inactive', P: 'pending' };
const OPERATION = {
    A: 'interstate',
    B: 'intrastate hazmat',
    C: 'intrastate non-hazmat',
};

/* FMCSA leaves its own test records in the live dataset. They look like real
 * carriers and would be billed as leads, so they are dropped before charging. */
function isTestRecord(r) {
    const phone = clean(r.phone) || '';
    const email = (clean(r.email_address) || '').toLowerCase();
    const name = (clean(r.legal_name) || '').toUpperCase();
    return phone === '2025555555'
        || /^uat\d*@/.test(email)
        || email.endsWith('@dot.gov.test')
        || name.includes('FEDERAL MOTOR CARRIER SAFETY ADMINISTRATION');
}

function hasContact(r) {
    return Boolean(clean(r.phone) || clean(r.email_address));
}

function shapeRow(r) {
    const powerUnits = num(r.power_units);
    const drivers = num(r.total_drivers);
    const registered = isoFromYmd(r.add_date);
    return {
        dotNumber: clean(r.dot_number),
        legalName: clean(r.legal_name),
        dbaName: clean(r.dba_name),

        phone: clean(r.phone),
        email: clean(r.email_address),
        contactName: clean(r.company_officer_1),

        physicalAddress: {
            street: clean(r.phy_street),
            city: clean(r.phy_city),
            state: clean(r.phy_state),
            zip: clean(r.phy_zip),
            country: clean(r.phy_country),
        },
        mailingAddress: {
            street: clean(r.carrier_mailing_street),
            city: clean(r.carrier_mailing_city),
            state: clean(r.carrier_mailing_state),
            zip: clean(r.carrier_mailing_zip),
            country: clean(r.carrier_mailing_country),
        },

        powerUnits,
        truckUnits: num(r.truck_units),
        busUnits: num(r.bus_units),
        totalDrivers: drivers,
        cdlDrivers: num(r.total_cdl),
        // A one-truck operation buys very differently from a 50-truck fleet, so
        // the size band is precomputed rather than left to the buyer.
        fleetBand: powerUnits === null ? null
            : powerUnits <= 1 ? 'owner-operator'
                : powerUnits <= 5 ? 'micro (2-5)'
                    : powerUnits <= 20 ? 'small (6-20)'
                        : powerUnits <= 100 ? 'medium (21-100)' : 'large (100+)',

        operatingStatus: STATUS[clean(r.status_code)] || clean(r.status_code),
        carrierOperation: OPERATION[clean(r.carrier_operation)] || clean(r.carrier_operation),
        businessType: clean(r.business_org_desc),
        dunsNumber: clean(r.dun_bradstreet_no),
        carriesHazmat: clean(r.hm_ind) === 'Y',
        carriesGeneralFreight: clean(r.crgo_genfreight) === 'X',

        registeredDate: registered,
        lastCensusUpdate: isoFromYmd(r.mcs150_date),
        annualMileage: num(r.mcs150_mileage),
        annualMileageYear: num(r.mcs150_mileage_year),

        saferUrl: clean(r.dot_number)
            ? `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${clean(r.dot_number)}`
            : null,
        source: 'FMCSA Company Census (datahub.transportation.gov)',
    };
}

/* ------------------------------------------------------------ query build */

function buildWhere() {
    const w = [];

    // Half the census is defunct carriers. Selling those as leads is worse than
    // selling nothing, so active-only is the default.
    if (!includeInactive) w.push("status_code='A'");

    if (mode === 'newCarriers') w.push(`add_date > '${ymdDaysAgo(daysBack)}'`);

    if (mode === 'lookup' && dotNumbers.length) {
        const ids = dotNumbers.map((d) => `'${String(d).replace(/\D/g, '')}'`).filter((s) => s !== "''");
        if (ids.length) w.push(`dot_number in (${ids.join(',')})`);
    }

    const st = states.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
    if (st.length) w.push(`phy_state in (${st.map((s) => `'${s}'`).join(',')})`);

    // power_units is a TEXT column: `power_units > 5` fails with
    // query.soql.type-mismatch, so the cast is required, not cosmetic.
    if (num(minPowerUnits) !== null) w.push(`power_units::number >= ${num(minPowerUnits)}`);
    if (num(maxPowerUnits) !== null) w.push(`power_units::number <= ${num(maxPowerUnits)}`);

    if (carrierOperation !== 'any') {
        const code = Object.entries(OPERATION).find(([, v]) => v === carrierOperation)?.[0];
        if (code) w.push(`carrier_operation='${code}'`);
    }

    if (requireContact) w.push('(phone IS NOT NULL OR email_address IS NOT NULL)');

    return w.join(' AND ');
}

async function fetchPage(where, offset) {
    const url = new URL(DATASET);
    if (where) url.searchParams.set('$where', where);
    url.searchParams.set('$limit', String(PAGE_SIZE));
    url.searchParams.set('$offset', String(offset));
    if (mode === 'newCarriers') url.searchParams.set('$order', 'add_date DESC');

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: { accept: 'application/json' } });
            if (!res.ok) {
                const body = await res.text();
                // A SoQL mistake is permanent; retrying it just wastes the run.
                if (res.status === 400) throw new Error(`query rejected: ${body.slice(0, 200)}`);
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (attempt === 2 || String(err.message).startsWith('query rejected')) throw err;
            await new Promise((r) => { setTimeout(r, 1500 * (attempt + 1)); });
        }
    }
    return [];
}

/* ------------------------------------------------------------------- main */

if (mode === 'lookup' && dotNumbers.length === 0) {
    await note('lookup mode needs at least one DOT number in dotNumbers; not charged');
    log.info('Done. 0 row(s) pushed.');
    await Actor.exit();
}

const where = buildWhere();
log.info(`mode=${mode} where=${where || '(none)'}`);

const cap = Math.max(1, Math.min(Number(maxItems) || 100, 50_000));
const seen = new Set();
let offset = 0;
let emitted = 0;
let skippedTest = 0;
let skippedNoContact = 0;

while (emitted < cap && !outOfTime()) {
    let page;
    try {
        page = await fetchPage(where, offset);
    } catch (err) {
        await note(`FMCSA census request failed: ${err.message}; not charged`);
        break;
    }
    if (!Array.isArray(page) || page.length === 0) break;

    for (const r of page) {
        if (emitted >= cap) break;

        if (isTestRecord(r)) { skippedTest += 1; continue; }
        if (requireContact && !hasContact(r)) { skippedNoContact += 1; continue; }

        // One carrier can appear more than once across pages; billing per row
        // means a duplicate is a duplicate charge.
        const key = clean(r.dot_number);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);

        await flushRow(shapeRow(r));
        emitted += 1;
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
}

if (emitted === 0) {
    const hint = mode === 'newCarriers'
        ? `no active carriers registered in the last ${daysBack} days matched; widen daysBack or drop the state filter`
        : 'no carriers matched those filters; loosen them or set requireContact to false';
    await note(`${hint}; not charged`);
}

if (skippedTest > 0) log.info(`skipped ${skippedTest} FMCSA test record(s)`);
if (skippedNoContact > 0) log.info(`skipped ${skippedNoContact} carrier(s) with no phone or email`);
if (outOfTime()) log.warning('stopped early: approaching the run timeout, partial results saved');

log.info(`Done. ${emitted} row(s) pushed (${charged} chargeable).`);
await Actor.exit();
