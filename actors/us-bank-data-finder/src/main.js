// US Bank Data Finder: FDIC Banks, Branches & Failures
//
// Strategy
// --------
// Official FDIC BankFind Suite API (api.fdic.gov/banks — the old
// banks.data.fdic.gov host 301s here), keyless JSON:
//   /institutions?search=NAME:x   name lookup
//   /institutions?filters=...     state browse (Elasticsearch-style
//                                 filters: STALP:CA AND ACTIVE:1 AND
//                                 ASSET:[min TO *]), sorted ASSET desc
//   /locations?filters=CERT:n     branch list per bank
//   /failures?filters=FAILYR:[y TO *]  failure history
// Money fields (ASSET, DEP, EQ, NETINC, QBFASSET, COST...) are reported
// in THOUSANDS of dollars — converted to plain USD in output rows.
// ESTYMD dates arrive as M/D/YYYY — converted to ISO.
//
// Pay per event
// -------------
//   bank_row per bank, branch or failure row. No-match searches and
//   unknown states are free note rows. First 2 chargeable rows per run
//   are free.

import { Actor, log } from 'apify';

const API = 'https://api.fdic.gov/banks';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 250;

const BKCLASS = {
    N: 'National bank (OCC)', SM: 'State member bank (Fed)', NM: 'State nonmember bank (FDIC)',
    SB: 'Savings bank', SA: 'Savings association', OI: 'Insured US branch of foreign bank',
};
const SERVTYPE = {
    11: 'Full service, brick and mortar', 12: 'Full service, retail', 13: 'Full service, cyber',
    21: 'Limited service, administrative', 22: 'Limited service, military', 23: 'Limited service, drive-through',
    24: 'Limited service, loan production', 25: 'Limited service, consumer credit', 26: 'Limited service, contractual',
    27: 'Limited service, messenger', 28: 'Limited service, retail', 29: 'Limited service, mobile/seasonal', 30: 'Limited service, trust',
};
const US_STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'GU', 'VI', 'AS', 'MP']);

const INST_FIELDS = 'NAME,CERT,ADDRESS,CITY,STALP,ZIP,WEBADDR,ESTYMD,ACTIVE,BKCLASS,REGAGNT,ASSET,DEP,EQ,NETINC,ROA,ROE,OFFICES,DATEUPDT';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    bankNames = [], maxResultsPerQuery = 5, states = [], maxPerState = 50,
    activeOnly = true, minAssetsMillions = 0,
    includeBranches = false, maxBranchesPerBank = 100,
    failuresSinceYear = 2023, maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const nameList = [...new Set(asTokens(bankNames))];
const stateList = [...new Set(asTokens(states).map((s) => s.toUpperCase()))];
const perQuery = clampNum(maxResultsPerQuery, 5, 1, 100);
const perState = clampNum(maxPerState, 50, 1, 5000);
const branchCap = clampNum(maxBranchesPerBank, 100, 1, 5000);
const minAssets = clampNum(minAssetsMillions, 0, 0, 10000000);
const failYear = clampNum(failuresSinceYear, 0, 0, 2100);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);

if (nameList.length === 0 && stateList.length === 0 && !failYear) {
    log.warning('No bank names, states or failure year given. Add a name like "JPMorgan Chase" or a state like "TX".');
    await Actor.exit();
}

async function apiGet(path, params) {
    const usp = new URLSearchParams({ format: 'json', ...params });
    const url = `${API}${path}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: json?.error?.message || `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
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
            await Actor.charge({ eventName: 'bank_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const thousandsToUsd = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 1000));
const toIsoDate = (mdY) => {
    const m = String(mdY || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function bankRow(d, extra = {}) {
    return {
        type: 'bank',
        name: d.NAME || null,
        fdicCert: d.CERT || null,
        address: d.ADDRESS || null,
        city: d.CITY || null,
        state: d.STALP || null,
        zip: d.ZIP || null,
        website: d.WEBADDR || null,
        established: toIsoDate(d.ESTYMD),
        active: d.ACTIVE === '1' || d.ACTIVE === 1,
        charterClass: BKCLASS[d.BKCLASS] || d.BKCLASS || null,
        primaryRegulator: d.REGAGNT || null,
        totalAssetsUsd: thousandsToUsd(d.ASSET),
        totalDepositsUsd: thousandsToUsd(d.DEP),
        equityUsd: thousandsToUsd(d.EQ),
        netIncomeUsd: thousandsToUsd(d.NETINC),
        returnOnAssetsPct: toNum(d.ROA) !== null ? Math.round(Number(d.ROA) * 100) / 100 : null,
        returnOnEquityPct: toNum(d.ROE) !== null ? Math.round(Number(d.ROE) * 100) / 100 : null,
        officeCount: toNum(d.OFFICES),
        dataUpdated: toIsoDate(d.DATEUPDT),
        ...extra,
    };
}

const seenCerts = new Set();
const matchedBanks = []; // for branch expansion

function baseFilters() {
    const f = [];
    if (activeOnly) f.push('ACTIVE:1');
    if (minAssets > 0) f.push(`ASSET:[${minAssets * 1000} TO *]`);
    return f;
}

async function emitInstitutions(rows, extra) {
    for (const r of rows) {
        if (shouldStop()) break;
        const d = r?.data || {};
        if (!d.CERT || seenCerts.has(d.CERT)) continue;
        seenCerts.add(d.CERT);
        matchedBanks.push({ cert: d.CERT, name: d.NAME });
        await flushRow(bankRow(d, extra), true);
    }
}

// --- mode 1: name searches ---------------------------------------------------

for (const name of nameList) {
    if (shouldStop()) break;
    const filters = baseFilters().join(' AND ');
    const json = await apiGet('/institutions', {
        search: `NAME:${name}`, ...(filters ? { filters } : {}),
        fields: INST_FIELDS, limit: String(perQuery),
    });
    if (json?.error) {
        await flushRow({ type: 'note', input: name, found: false, note: `search failed (${json.error}); not charged, try again later` }, false);
        continue;
    }
    const rows = json.data || [];
    if (rows.length === 0) {
        await flushRow({ type: 'note', input: name, found: false, note: 'no FDIC-insured bank matched this name (credit unions are NCUA, not FDIC); not charged' }, false);
        continue;
    }
    await emitInstitutions(rows, { searchTerm: name });
}

// --- mode 2: state browse ----------------------------------------------------

for (const st of stateList) {
    if (shouldStop()) break;
    if (!US_STATES.has(st)) {
        await flushRow({ type: 'note', input: st, found: false, note: 'not a US state or territory code; not charged' }, false);
        continue;
    }
    const filters = [`STALP:${st}`, ...baseFilters()].join(' AND ');
    const json = await apiGet('/institutions', {
        filters, fields: INST_FIELDS, limit: String(perState), sort_by: 'ASSET', sort_order: 'DESC',
    });
    if (json?.error || (json.data || []).length === 0) {
        await flushRow({ type: 'note', input: st, found: false, note: json?.error ? `browse failed (${json.error}); not charged` : 'no banks matched these filters in this state; not charged' }, false);
        continue;
    }
    await emitInstitutions(json.data, { searchTerm: st });
}

// --- branches for every matched bank ----------------------------------------

if (includeBranches) {
    for (const bank of matchedBanks) {
        if (shouldStop()) break;
        const json = await apiGet('/locations', {
            filters: `CERT:${bank.cert}`,
            fields: 'NAME,ADDRESS,CITY,STALP,ZIP,COUNTY,SERVTYPE,ESTYMD',
            limit: String(branchCap),
        });
        if (json?.error) {
            await flushRow({ type: 'note', input: bank.name, found: false, note: `branch fetch failed (${json.error}); not charged` }, false);
            continue;
        }
        for (const r of json.data || []) {
            if (shouldStop()) break;
            const d = r?.data || {};
            await flushRow({
                type: 'branch',
                bankName: bank.name,
                fdicCert: bank.cert,
                address: d.ADDRESS || null,
                city: d.CITY || null,
                state: d.STALP || null,
                zip: d.ZIP || null,
                county: d.COUNTY || null,
                serviceType: SERVTYPE[Number(d.SERVTYPE)] || (d.SERVTYPE ? `code ${d.SERVTYPE}` : null),
                established: toIsoDate(d.ESTYMD),
            }, true);
        }
    }
}

// --- failures ----------------------------------------------------------------

if (failYear && !shouldStop()) {
    const json = await apiGet('/failures', {
        filters: `FAILYR:[${failYear} TO *]`,
        fields: 'NAME,CITYST,FAILDATE,FAILYR,QBFASSET,QBFDEP,RESTYPE,COST,SAVR,CERT',
        limit: '2000', sort_by: 'FAILYR', sort_order: 'DESC',
    });
    if (json?.error) {
        await flushRow({ type: 'note', input: `failures since ${failYear}`, found: false, note: `failures fetch failed (${json.error}); not charged` }, false);
    } else if ((json.data || []).length === 0) {
        await flushRow({ type: 'note', input: `failures since ${failYear}`, found: false, note: 'no bank failures in this window; not charged' }, false);
    } else {
        const failures = (json.data || [])
            .map((r) => r.data || {})
            .sort((a, b) => (Date.parse(b.FAILDATE) || 0) - (Date.parse(a.FAILDATE) || 0));
        for (const d of failures) {
            if (shouldStop()) break;
            await flushRow({
                type: 'failure',
                name: d.NAME || null,
                fdicCert: d.CERT || null,
                cityState: d.CITYST || null,
                failDate: toIsoDate(d.FAILDATE),
                assetsAtFailureUsd: thousandsToUsd(d.QBFASSET),
                depositsAtFailureUsd: thousandsToUsd(d.QBFDEP),
                estimatedLossUsd: thousandsToUsd(d.COST),
                resolutionType: d.RESTYPE || null,
                insuranceFund: d.SAVR || null,
            }, true);
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
