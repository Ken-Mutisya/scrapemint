// Doctor Prescribing Patterns (Medicare Part D)
//
// Strategy
// --------
// CMS publishes what every Medicare Part D prescriber wrote, by drug, with
// claim counts, day supply, beneficiary counts and total drug cost. Three
// cuts of the same program are exposed as three separate keyless datasets
// on data.cms.gov, and this actor maps them to three modes:
//
//   prescribers     - by Provider and Drug (~28M rows): one row per
//                     doctor per drug. The flagship "who prescribes this
//                     drug, ranked by spend" view.
//   provider_totals - by Provider (~1.4M rows): one row per prescriber,
//                     totalled across every drug they wrote.
//   drug_geography  - by Geography and Drug (~118k rows): national and
//                     per-state totals for a drug, plus CMS's opioid,
//                     antibiotic and antipsychotic flags.
//
// Dataset ids are resolved at runtime from the data.json catalog by
// matching the distribution's `temporal` start year, so new program years
// appear without a code change.
//
// Source notes / gotchas
// ----------------------
//   * Filters are EXACT match but case-insensitive. There is no partial
//     match: a `contains` condition is SILENTLY IGNORED and the API
//     returns unfiltered rows, which on a per-row charge would bill the
//     buyer for garbage. So only exact filters on known fields are ever
//     sent, and a drug name that matches nothing returns a free note with
//     real suggestions taken from the national drug list.
//   * An unknown field name in a filter is also silently ignored, which is
//     why every field is hardcoded per mode rather than passed through.
//   * Sorting IS numeric here (unlike the NADAC tables), verified against
//     values where a text sort would differ, so ranking runs server-side.
//   * Field name casing differs between datasets (Prscrbr_NPI in the drug
//     cut, PRSCRBR_NPI in the provider cut), hence per-mode field maps.
//   * CMS suppresses counts below 11, so the smallest claim count is 11
//     and some 65+ columns are blanked with a suppression flag.
//
// Pay per event
// -------------
//   prescriber_row per returned row. Empty searches and error notes are
//   free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const CATALOG = 'https://data.cms.gov/data.json';
const DATA = 'https://data.cms.gov/data-api/v1/dataset';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 90000;
const SPACING_MS = 300;
const PAGE_SIZE = 1000;
const SUGGEST_SCAN = 4000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'prescribers', brandName = '', genericName = '', state = '',
    specialty = '', npi = '', lastName = '', year = '2024',
    sortBy = 'cost', maxRows = 200,
} = input;

const clean = (v) => String(v ?? '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const MODES = {
    prescribers: {
        title: 'Medicare Part D Prescribers - by Provider and Drug',
        npiField: 'Prscrbr_NPI',
        drugFields: true,
    },
    provider_totals: {
        title: 'Medicare Part D Prescribers - by Provider',
        npiField: 'PRSCRBR_NPI',
        drugFields: false,
    },
    drug_geography: {
        title: 'Medicare Part D Prescribers - by Geography and Drug',
        npiField: null,
        drugFields: true,
    },
};
const runMode = MODES[String(mode)] ? String(mode) : 'prescribers';
const cfg = MODES[runMode];

const STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
    KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
    MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
    NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
    WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', VI: 'Virgin Islands',
    GU: 'Guam', AE: 'Armed Forces Europe', AA: 'Armed Forces Central/South America',
    AP: 'Armed Forces Pacific',
};

const brand = clean(brandName);
const generic = clean(genericName);
const stateCode = clean(state).toUpperCase().slice(0, 2);
const spec = clean(specialty);
const npiFilter = clean(npi).replace(/[^0-9]/g, '');
const surname = clean(lastName);
const dataYear = clampNum(year, 2024, 2013, 2100);
const rowCap = clampNum(maxRows, 200, 1, 50000);
const SORTS = { cost: 'Tot_Drug_Cst', claims: 'Tot_Clms', beneficiaries: 'Tot_Benes' };
const sortField = SORTS[String(sortBy)] || SORTS.cost;

const hasFilter = Boolean(brand || generic || stateCode || spec || npiFilter || surname);
// The provider cuts are far too large to browse. The geography cut is
// small enough that an unfiltered "top drugs nationally" run is useful.
if (runMode !== 'drug_geography' && !hasFilter) {
    log.warning('Add a drug name, state, specialty, NPI or last name. The Part D prescriber table holds tens of millions of rows, so it is filter-first by design.');
    await Actor.exit();
}
if (runMode === 'provider_totals' && (brand || generic)) {
    log.warning('Provider totals cover every drug a prescriber wrote, so they cannot be filtered by drug. Use the "prescribers" mode for a per-drug view.');
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Part D prescriber actor (admin@scrapemint.com)' },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const json = await res.json();
            await sleep(SPACING_MS);
            return { json };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// Resolve "<dataset title>" + data year -> data-api dataset id. The
// distribution's `temporal` range ("2024-01-01/2024-12-31") is the data
// year; the release date in the title is not, and the newest year appears
// twice because CMS also publishes a "latest" alias.
let catalog = null;
async function resolveDatasetId(title, y) {
    if (!catalog) {
        const { json, error } = await getJson(CATALOG);
        if (error) return { error };
        catalog = json?.dataset || [];
    }
    const ds = catalog.find((x) => clean(x.title) === title);
    if (!ds) return { error: 'dataset-not-found' };
    const dists = (ds.distribution || []).filter((d) => String(d.accessURL || '').includes('/data-api/'));
    const hit = dists.find((d) => String(d.temporal || '').startsWith(`${y}-`));
    if (!hit) {
        const years = [...new Set(dists.map((d) => String(d.temporal || '').slice(0, 4)).filter(Boolean))].sort();
        return { error: 'year-not-published', years };
    }
    return { id: String(hit.accessURL).split('/dataset/')[1].split('/')[0] };
}

function filterParams() {
    const f = {};
    if (runMode === 'drug_geography') {
        if (brand) f.Brnd_Name = brand;
        if (generic) f.Gnrc_Name = generic;
        if (stateCode) f.Prscrbr_Geo_Desc = STATES[stateCode] || stateCode;
    } else {
        if (cfg.drugFields && brand) f.Brnd_Name = brand;
        if (cfg.drugFields && generic) f.Gnrc_Name = generic;
        if (stateCode) f.Prscrbr_State_Abrvtn = stateCode;
        if (spec) f.Prscrbr_Type = spec;
        if (npiFilter) f[cfg.npiField] = npiFilter;
        if (surname) f.Prscrbr_Last_Org_Name = surname;
    }
    return f;
}

function queryUrl(datasetId, offset, size) {
    const usp = new URLSearchParams({ size: String(size), offset: String(offset), sort: `-${sortField}` });
    for (const [k, v] of Object.entries(filterParams())) usp.set(`filter[${k}]`, v);
    return `${DATA}/${datasetId}/data?${usp}`;
}

const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && clean(v) !== '' ? n : null;
};
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);
const yn = (v) => (clean(v) ? clean(v).toUpperCase() === 'Y' : null);
const title = (v) => clean(v) || null;

function row(r) {
    const claims = num(r.Tot_Clms);
    const cost = num(r.Tot_Drug_Cst);
    const base = {
        year: dataYear,
        totalClaims: claims,
        total30DayFills: num(r.Tot_30day_Fills),
        totalDrugCostUsd: round2(cost),
        costPerClaimUsd: claims && cost ? round2(cost / claims) : null,
        totalBeneficiaries: num(r.Tot_Benes),
    };
    // The geography cut has no day-supply column, so only the prescriber
    // cuts carry it rather than emitting a permanently null field.
    if (runMode !== 'drug_geography') base.totalDaySupply = num(r.Tot_Day_Suply);
    if (runMode === 'drug_geography') {
        return {
            geoLevel: title(r.Prscrbr_Geo_Lvl),
            geoName: title(r.Prscrbr_Geo_Desc),
            brandName: title(r.Brnd_Name),
            genericName: title(r.Gnrc_Name),
            prescriberCount: num(r.Tot_Prscrbrs),
            ...base,
            isOpioid: yn(r.Opioid_Drug_Flag),
            isLongActingOpioid: yn(r.Opioid_LA_Drug_Flag),
            isAntibiotic: yn(r.Antbtc_Drug_Flag),
            isAntipsychotic: yn(r.Antpsyct_Drug_Flag),
        };
    }
    const out = {
        npi: title(r[cfg.npiField]),
        prescriberName: [title(r.Prscrbr_First_Name), title(r.Prscrbr_Last_Org_Name)].filter(Boolean).join(' ') || null,
        specialty: title(r.Prscrbr_Type),
        city: title(r.Prscrbr_City),
        state: title(r.Prscrbr_State_Abrvtn),
    };
    if (cfg.drugFields) {
        out.brandName = title(r.Brnd_Name);
        out.genericName = title(r.Gnrc_Name);
    } else {
        out.credentials = title(r.Prscrbr_Crdntls);
        out.zip = title(r.Prscrbr_zip5);
    }
    return { ...out, ...base };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(r, chargeable) {
    await Actor.pushData(r);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'prescriber_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// Exact-match-only filters mean a near-miss drug name returns nothing.
// Rather than a bare "no results", pull the national drug list (one row per
// drug) and offer real spellings that contain what was typed.
async function suggestDrugNames(term) {
    // Substring alone only rescues partial names ("zempic"). A typo like
    // "ozempik" contains no matching substring, so also try a shortened
    // prefix of what was typed, which still matches the real name.
    const full = term.toLowerCase();
    const stem = full.length >= 5 ? full.slice(0, 5) : full;
    const { id, error } = await resolveDatasetId(MODES.drug_geography.title, dataYear);
    if (error) return [];
    const found = new Set();
    const stemHits = new Set();
    for (let offset = 0; offset < SUGGEST_SCAN && !pastDeadline(); offset += PAGE_SIZE) {
        const usp = new URLSearchParams({ size: String(PAGE_SIZE), offset: String(offset) });
        usp.set('filter[Prscrbr_Geo_Desc]', 'National');
        const { json } = await getJson(`${DATA}/${id}/data?${usp}`);
        const items = Array.isArray(json) ? json : [];
        if (items.length === 0) break;
        for (const it of items) {
            for (const nameField of ['Brnd_Name', 'Gnrc_Name']) {
                const v = clean(it[nameField]);
                if (!v) continue;
                const lower = v.toLowerCase();
                if (lower.includes(full)) found.add(v);
                else if (stem !== full && lower.includes(stem)) stemHits.add(v);
            }
        }
        if (found.size >= 8 || items.length < PAGE_SIZE) break;
    }
    const out = found.size ? [...found] : [...stemHits];
    return out.slice(0, 8);
}

// --- run ---------------------------------------------------------------------------

const label = [
    brand && `brand "${brand}"`, generic && `generic "${generic}"`, surname && `prescriber "${surname}"`,
    npiFilter && `NPI ${npiFilter}`, spec && spec, stateCode && stateCode,
].filter(Boolean).join(', ') || 'all drugs';

log.info(`Part D ${runMode} ${dataYear}: ${label}, ranked by ${sortBy}...`);

const { id: datasetId, error: idError, years } = await resolveDatasetId(cfg.title, dataYear);
if (idError) {
    const note = idError === 'year-not-published'
        ? `Medicare Part D has no ${dataYear} data published yet; available years: ${(years || []).join(', ')}; not charged`
        : `could not reach the CMS catalog (${idError}); not charged, try again later`;
    await flushRow({ type: 'note', input: label, found: false, note }, false);
    await Actor.exit();
}

let failed = null;
for (let offset = 0; rowsPushed < rowCap && !pastDeadline(); offset += PAGE_SIZE) {
    const size = Math.min(PAGE_SIZE, rowCap - rowsPushed);
    const { json, error } = await getJson(queryUrl(datasetId, offset, size));
    if (error) { failed = error; break; }
    const items = Array.isArray(json) ? json : [];
    if (items.length === 0) break;
    for (const it of items) {
        if (rowsPushed >= rowCap || pastDeadline()) break;
        await flushRow(row(it), true);
    }
    if (items.length < size) break;
}

if (rowsPushed === 0) {
    let note = failed ? `search failed (${failed}); not charged, try again later` : null;
    if (!note) {
        const term = brand || generic;
        const hints = term ? await suggestDrugNames(term) : [];
        note = hints.length
            ? `no ${dataYear} rows matched. Drug names must match exactly (case does not matter). Did you mean: ${hints.join(', ')}? Not charged.`
            : `no ${dataYear} rows matched those filters. Names and specialties must match exactly (case does not matter), so check the spelling or drop a filter. Not charged.`;
    }
    await flushRow({ type: 'note', input: label, found: false, note }, false);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
