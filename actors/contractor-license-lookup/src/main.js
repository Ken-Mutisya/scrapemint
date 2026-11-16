// Contractor License Lookup: WA, OR, TX, NY
//
// Strategy
// --------
// Four state licensing boards publish their full contractor license rolls on
// Socrata open-data portals, refreshed daily:
//   WA  Labor & Industries contractor licenses   data.wa.gov/m8qx-ubtq
//   OR  Construction Contractors Board (active)  data.oregon.gov/g77e-6bhs
//   TX  TDLR all licenses (contractor trades)    data.texas.gov/7358-krk7
//   NY  DOL Contractor Registry certificates     data.ny.gov/i4jv-zkey
// Each adapter turns the input into a SoQL filter (license number, name,
// city, ZIP, trade keyword, issued-since date) so only matching rows are
// downloaded, then maps the row to one shared schema: license, status, dates,
// trade, phone, address, principal, bond and insurance where published.
// No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   license ($0.002) per license row. The first FREE_TIER_ROWS rows of every
//   run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const PAGE = 1000;
const FETCH_TIMEOUT_MS = 60000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

// TDLR licenses that are construction / building trades (the file also holds barbers, cosmetologists, etc.).
const TX_TRADES = ['A/C Contractor', 'A/C Technician', 'Electrical Contractor', 'Master Electrician', 'Journeyman Electrician', 'Electrical Sign Contractor',
    'Master Sign Electrician', 'Appliance Installation Contractor', 'Appliance Installer', 'Residential Wireman', 'Water Well Driller/Pump Installer',
    'Elevator Contractor', 'Elevator Responsible Party', 'Journeyman Industrial Electrician', 'Maintenance Electrician', 'Journeyman Lineman'];

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    states = ['WA', 'OR', 'TX', 'NY'],
    licenseNumbers = [],
    businessNames = [],
    trades = [],
    cities = [],
    zipCodes = [],
    issuedWithinDays = 0,
    activeOnly = true,
    requirePhone = false,
    maxRows = 500,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const like = (field, s) => `upper(${field}) like ${q(`%${String(s).toUpperCase()}%`)}`;
const anyOf = (parts) => (parts.length ? `(${parts.join(' OR ')})` : null);
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 500));
const lic = arr(licenseNumbers);
const names = arr(businessNames).slice(0, 20);
const tradeKw = arr(trades).slice(0, 20);
const cityList = arr(cities).map((s) => s.toUpperCase()).slice(0, 30);
const zips = arr(zipCodes).map((s) => s.replace(/\D/g, '')).filter(Boolean).slice(0, 50);
const sinceDays = Math.max(0, Math.min(3650, Number(issuedWithinDays) || 0));
const since = sinceDays ? new Date(Date.now() - sinceDays * 86400000) : null;
const sinceIso = since ? since.toISOString().slice(0, 10) : null;
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
const phone = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : (d || null); };
const mdy = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const day = (s) => (s ? String(s).slice(0, 10) : null);
const csz = (s) => { const m = String(s || '').trim().match(/^(.*?)\s*,?\s+([A-Z]{2})\s+(\d{5})(?:-?\d{4})?$/); return m ? { city: m[1].trim(), state: m[2], zip: m[3] } : { city: String(s || '').trim() || null, state: null, zip: null }; };
const zip5 = (z) => (String(z || '').replace(/\D/g, '').slice(0, 5) || null);

const ADAPTERS = {
    WA: {
        url: 'https://data.wa.gov/resource/m8qx-ubtq.json', order: 'licenseeffectivedate DESC',
        where() {
            const w = [];
            if (lic.length) w.push(`contractorlicensenumber in (${lic.map((s) => q(s.toUpperCase())).join(',')})`);
            if (names.length) w.push(anyOf(names.map((n) => like('businessname', n))));
            if (tradeKw.length) w.push(anyOf(tradeKw.flatMap((t) => [like('specialtycode1desc', t), like('specialtycode2desc', t), like('contractorlicensetypecodedesc', t)])));
            if (cityList.length) w.push(`upper(city) in (${cityList.map(q).join(',')})`);
            if (zips.length) w.push(anyOf(zips.map((z) => `zip like ${q(`${z}%`)}`)));
            if (sinceIso) w.push(`licenseeffectivedate >= ${q(`${sinceIso}T00:00:00`)}`);
            if (activeOnly) w.push(`contractorlicensestatus = 'ACTIVE'`);
            if (requirePhone) w.push('phonenumber IS NOT NULL');
            return w;
        },
        map: (r) => ({
            licenseNumber: r.contractorlicensenumber, businessName: r.businessname, ownerOrPrincipal: r.primaryprincipalname || null,
            licenseType: r.contractorlicensetypecodedesc || null,
            trades: [r.specialtycode1desc, r.specialtycode2desc].filter(Boolean),
            status: r.contractorlicensestatus || null, issueDate: day(r.licenseeffectivedate), expirationDate: day(r.licenseexpirationdate),
            phone: phone(r.phonenumber), street: [r.address1, r.address2].filter(Boolean).join(', ') || null, city: r.city || null, state: r.state || null, zip: zip5(r.zip),
            businessType: r.businesstypecodedesc || null, stateBusinessId: r.ubi ? String(r.ubi) : null,
            lookupUrl: `https://secure.lni.wa.gov/verify/Detail.aspx?LIC=${encodeURIComponent(r.contractorlicensenumber || '')}`,
        }),
    },
    OR: {
        url: 'https://data.oregon.gov/resource/g77e-6bhs.json', order: 'license_number DESC',
        where() {
            const w = [];
            if (lic.length) w.push(`license_number in (${lic.map(q).join(',')})`);
            if (names.length) w.push(anyOf(names.map((n) => like('full_name', n))));
            if (tradeKw.length) w.push(anyOf(tradeKw.flatMap((t) => [like('endorsement_text', t), like('license_type', t)])));
            if (cityList.length) w.push(`upper(city) in (${cityList.map(q).join(',')})`);
            if (zips.length) w.push(anyOf(zips.map((z) => `zip_code like ${q(`${z}%`)}`)));
            // orig_regis_date is text (MM/DD/YYYY): narrow by year in SoQL, exact date filter below.
            if (since) w.push(anyOf([...new Set([since.getUTCFullYear(), new Date().getUTCFullYear()])].map((y) => `orig_regis_date like ${q(`%/${y}`)}`)));
            if (requirePhone) w.push('phone_number IS NOT NULL');
            return w;
        },
        post: (row) => !sinceIso || (row.issueDate && row.issueDate >= sinceIso),
        map: (r) => ({
            licenseNumber: r.license_number, businessName: r.full_name, ownerOrPrincipal: r.rmi_name || null,
            licenseType: r.license_type || null, trades: r.endorsement_text ? [r.endorsement_text] : [],
            status: 'ACTIVE', issueDate: mdy(r.orig_regis_date), expirationDate: mdy(r.lic_exp_date),
            phone: phone(r.phone_number), street: r.address || null, city: r.city || null, state: r.state || null, zip: zip5(r.zip_code), county: r.county_name || null,
            bondCompany: r.bond_company || null, bondAmount: num(r.bond_amount), bondExpiration: mdy(r.bond_exp_date),
            insuranceCompany: r.ins_company || null, insuranceAmount: num(r.ins_amount), insuranceExpiration: mdy(r.ins_exp_date),
            exempt: r.exempt_text || null,
            lookupUrl: `https://search.ccb.state.or.us/search/business_details.aspx?id=${encodeURIComponent(r.license_number || '')}`,
        }),
    },
    TX: {
        url: 'https://data.texas.gov/resource/7358-krk7.json', order: 'license_number DESC',
        where() {
            const w = [];
            if (sinceIso) return null; // TDLR publishes no issue date.
            if (lic.length) w.push(`license_number in (${lic.map(q).join(',')})`);
            if (names.length) w.push(anyOf(names.flatMap((n) => [like('business_name', n), like('owner_name', n)])));
            if (tradeKw.length) w.push(anyOf(tradeKw.map((t) => like('license_type', t))));
            else if (!lic.length) w.push(`license_type in (${TX_TRADES.map(q).join(',')})`);
            if (cityList.length) w.push(anyOf(cityList.map((c) => `upper(business_city_state_zip) like ${q(`${c}%`)}`)));
            if (zips.length) w.push(anyOf(zips.map((z) => `business_city_state_zip like ${q(`% ${z}%`)}`)));
            if (requirePhone) w.push('(business_telephone IS NOT NULL OR owner_telephone IS NOT NULL)');
            return w;
        },
        map: (r) => {
            const a = csz(r.business_city_state_zip || r.mailing_address_city_state_zip);
            return {
                licenseNumber: r.license_number, businessName: r.business_name || r.owner_name, ownerOrPrincipal: r.owner_name || null,
                licenseType: r.license_type || null, trades: [r.license_type, r.license_subtype].filter(Boolean),
                status: 'ACTIVE', issueDate: null, expirationDate: mdy(r.license_expiration_date_mmddccyy),
                phone: phone(r.business_telephone || r.owner_telephone),
                street: [r.business_address_line1, r.business_address_line2].filter(Boolean).join(', ') || [r.mailing_address_line1, r.mailing_address_line2].filter(Boolean).join(', ') || null,
                city: a.city, state: a.state || 'TX', zip: a.zip, county: r.business_county || r.mailing_address_county || null,
                lookupUrl: `https://www.tdlr.texas.gov/LicenseSearch/SearchResultDetail.asp?1=${encodeURIComponent(r.license_number || '')}`,
            };
        },
    },
    NY: {
        url: 'https://data.ny.gov/resource/i4jv-zkey.json', order: 'issued_date DESC',
        where() {
            const w = [];
            if (lic.length) w.push(`certificate_number in (${lic.map(q).join(',')})`);
            if (names.length) w.push(anyOf(names.flatMap((n) => [like('business_name', n), like('dba_name', n)])));
            if (tradeKw.length) w.push(anyOf(tradeKw.flatMap((t) => [like('business_name', t), like('dba_name', t)])));
            if (cityList.length) w.push(`upper(city) in (${cityList.map(q).join(',')})`);
            if (zips.length) w.push(anyOf(zips.map((z) => `zip_code like ${q(`${z}%`)}`)));
            if (sinceIso) w.push(`issued_date >= ${q(`${sinceIso}T00:00:00`)}`);
            if (activeOnly) w.push(`status = 'Active'`);
            if (requirePhone) w.push('phone IS NOT NULL');
            return w;
        },
        map: (r) => ({
            licenseNumber: r.certificate_number, businessName: r.business_name, dbaName: r.dba_name || null, ownerOrPrincipal: r.business_officers || null,
            licenseType: 'Contractor Registry Certificate', trades: [],
            status: r.status ? r.status.toUpperCase() : null, issueDate: day(r.issued_date), expirationDate: day(r.expiration_date),
            phone: phone(r.phone), street: [r.address, r.address_2].filter(Boolean).join(', ') || null, city: r.city || null, state: r.state || null, zip: zip5(r.zip_code),
            businessType: r.business_type || null, mwbeOwned: r.business_is_mwbe_owned === 'Yes',
            workersCompInsurance: r.business_has_workers_compensation_insurance === 'Yes',
            debarred: r.business_has_been_debarred === 'Yes', wageAssessmentsOutstanding: r.business_has_outstanding_wage_assessments === 'Yes',
            lookupUrl: 'https://dol.ny.gov/contractor-registry',
        }),
    },
};

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
            if (res.ok) return await res.json();
            const body = (await res.text()).slice(0, 200);
            if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}: ${body}`);
            log.warning(`HTTP ${res.status}, retrying`);
        } catch (err) {
            if (attempt === 3 || /^HTTP 4/.test(err.message)) throw err;
            log.warning(`${err.message}, retrying`);
        } finally { clearTimeout(t); }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return [];
}

const wanted = arr(states).map((s) => s.toUpperCase()).filter((s) => ADAPTERS[s]);
const unknown = arr(states).map((s) => s.toUpperCase()).filter((s) => !ADAPTERS[s]);
if (unknown.length) await Actor.pushData({ note: `States not covered yet: ${unknown.join(', ')}. Covered: WA, OR, TX, NY. Not charged.` });
const perState = Math.max(1, Math.ceil(cap / Math.max(1, wanted.length)));
let pushed = 0;
const summary = {};
for (const st of wanted) {
    if (pushed >= cap || pastDeadline()) break;
    const A = ADAPTERS[st];
    const w = A.where();
    if (w === null) { summary[st] = 'skipped: no issue dates published'; await Actor.pushData({ licensingState: st, note: 'Texas TDLR does not publish license issue dates, so issuedWithinDays skips Texas. Not charged.' }); continue; }
    const whereSql = w.filter(Boolean).join(' AND ');
    log.info(`${st}: ${whereSql || '(no filter)'}`);
    let offset = 0; let got = 0;
    const budget = Math.min(perState, cap - pushed);
    while (got < budget && !pastDeadline()) {
        const params = new URLSearchParams({ $order: A.order, $limit: String(PAGE), $offset: String(offset) });
        if (whereSql) params.set('$where', whereSql);
        let rows;
        try { rows = await getJson(`${A.url}?${params}`); } catch (err) {
            log.error(`${st}: ${err.message}`);
            await Actor.pushData({ licensingState: st, note: `${st} licensing data could not be loaded (${err.message.slice(0, 100)}). Not charged.` });
            break;
        }
        if (!rows.length) break;
        for (const r of rows) {
            if (got >= budget) break;
            const row = { licensingState: st, ...A.map(r) };
            if (A.post && !A.post(row)) continue;
            await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
            got += 1; pushed += 1;
            if (pushed > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'license' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
        offset += rows.length;
        if (rows.length < PAGE) break;
    }
    summary[st] = got;
}
if (!pushed) await Actor.pushData({ note: 'No licenses matched. Check spelling, widen the filters or add states. Not charged.' });
await Actor.setValue('SUMMARY', { perState: summary, total: pushed });
log.info(`Done. ${pushed} licenses ${JSON.stringify(summary)}`);
await Actor.exit();
