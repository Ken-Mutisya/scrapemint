// Financial Advisor & Broker Check (FINRA)
//
// Strategy
// --------
// FINRA's public BrokerCheck API (api.brokercheck.finra.org), the JSON
// backend of brokercheck.finra.org - keyless. Name queries hit
// /search/individual or /search/firm; an all-digits query is treated as a
// CRD number and fetched via the detail path directly. With
// includeDetails on, each individual match gets one extra detail request.
//
// Source quirks handled:
//   * The detail endpoint returns a single hit whose _source has ONE key,
//     "content" - a JSON document encoded as a string that needs a second
//     JSON.parse.
//   * Sanctions live under basicInformation.sanctions with a
//     permanentBar flag; search results carry the same flag flat as
//     ind_permanent_bar.
//   * This is FINRA's own site-backing API - public and stable for years
//     but undocumented; field names are accessed defensively throughout.
//
// Pay per event
// -------------
//   broker_row per record found. Queries with no match are free note
//   rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://api.brokercheck.finra.org';
const IND_URL = 'https://brokercheck.finra.org/individual/summary/';
const FIRM_URL = 'https://brokercheck.finra.org/firm/summary/';
const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 400;
const DISCLOSURES_CAP = 15;
const EMPLOYMENTS_CAP = 10;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { queries = [], searchType = 'individuals', includeDetails = true, maxPerQuery = 10, maxRows = 100 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const queryList = [...new Set(asTokens(queries))];
const firms = String(searchType) === 'firms';
const perQuery = clampNum(maxPerQuery, 10, 1, 100);
const rowCap = clampNum(maxRows, 100, 1, 10000);

if (queryList.length === 0) {
    log.warning('No names or CRD numbers given.');
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', Referer: 'https://brokercheck.finra.org/' } });
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

const yn = (v) => (v === 'Y' ? true : v === 'N' ? false : null);
const fullName = (...parts) => parts.filter(Boolean).join(' ').trim() || null;

// The detail _source carries one "content" key: a JSON string that needs
// a second parse.
async function fetchDetail(crd) {
    const { json, error } = await getJson(`${API}/search/individual/${crd}?query=${crd}&hits=1&wt=json`);
    if (error) return { error };
    const src = json?.hits?.hits?.[0]?._source;
    if (!src?.content) return { error: 'no detail record' };
    try { return { detail: JSON.parse(src.content) }; } catch { return { error: 'unparseable detail' }; }
}

function detailFields(detail) {
    const b = detail?.basicInformation || {};
    const sanctions = (b.sanctions?.sanctionDetails || []).map((s) => [s.category, s.regulator].filter(Boolean).join(' by ')).filter(Boolean);
    const disclosures = (detail?.disclosures || []).slice(0, DISCLOSURES_CAP).map((d) => ({
        type: d.disclosureType || null,
        date: d.eventDate || null,
        resolution: d.disclosureResolution || null,
    }));
    const employments = [...(detail?.currentEmployments || []), ...(detail?.previousEmployments || [])].slice(0, EMPLOYMENTS_CAP)
        .map((e) => ({ firm: e.firmName || null, firmCrd: e.firmId ?? null, city: e.branchOfficeLocations?.[0]?.city || e.city || null, state: e.branchOfficeLocations?.[0]?.state || e.state || null, from: e.registrationBeginDate || null, to: e.registrationEndDate || null }));
    return {
        permanentBar: yn(b.sanctions?.permanentBar) ?? (sanctions.some((s) => s.startsWith('BAR')) || null),
        sanctions,
        disclosureCount: Array.isArray(detail?.disclosures) ? detail.disclosures.length : 0,
        disclosures,
        stateExams: detail?.examsCount?.stateExamCount ?? null,
        principalExams: detail?.examsCount?.principalExamCount ?? null,
        productExams: detail?.examsCount?.productExamCount ?? null,
        registeredStates: Array.isArray(detail?.registeredStates) ? detail.registeredStates.length : null,
        registeredSROs: detail?.registeredSROs || [],
        employments,
    };
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
            await Actor.charge({ eventName: 'broker_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

async function emitIndividual(src, query) {
    const crd = src.ind_source_id || null;
    let extra = {};
    if (includeDetails && crd && !pastDeadline()) {
        const { detail } = await fetchDetail(crd);
        if (detail) extra = detailFields(detail);
    }
    await flushRow({
        recordType: 'individual',
        crd,
        name: fullName(src.ind_firstname, src.ind_middlename, src.ind_lastname),
        otherNames: src.ind_other_names || [],
        brokerScope: src.ind_bc_scope || null,
        advisorScope: src.ind_ia_scope || null,
        hasDisclosures: yn(src.ind_bc_disclosure_fl),
        permanentBar: yn(src.ind_permanent_bar),
        yearsInIndustry: src.ind_industry_days ? Math.round((Number(src.ind_industry_days) / 365) * 10) / 10 : null,
        currentFirms: (src.ind_current_employments || []).map((e) => ({ firm: e.firm_name || null, firmCrd: e.firm_id ?? null, city: e.branch_city || null, state: e.branch_state || null })),
        ...extra,
        url: crd ? `${IND_URL}${crd}` : null,
        query,
    }, true);
}

async function emitFirm(src, query) {
    const crd = src.firm_source_id || null;
    await flushRow({
        recordType: 'firm',
        crd,
        name: src.firm_name || null,
        otherNames: src.firm_other_names || [],
        secNumber: src.firm_bd_full_sec_number || src.firm_bd_sec_number || null,
        scope: src.firm_scope || null,
        hasDisclosures: yn(src.firm_bc_disclosure_fl) ?? yn(src.firm_ia_disclosure_fl),
        branchesCount: src.firm_branches_count ?? null,
        expelledDate: src.firm_expelled_date || null,
        url: crd ? `${FIRM_URL}${crd}` : null,
        query,
    }, true);
}

// --- run ---------------------------------------------------------------------------

log.info(`Checking ${queryList.length} quer(ies) against BrokerCheck ${firms ? 'firms' : 'individuals'}${includeDetails && !firms ? ' with full details' : ''}...`);

for (const q of queryList) {
    if (shouldStop()) break;
    const isCrd = /^\d{1,10}$/.test(q);

    if (isCrd && !firms) {
        const { detail, error } = await fetchDetail(q);
        if (!detail) {
            await flushRow({ type: 'note', input: q, found: false, note: `no BrokerCheck record for CRD ${q}${error && !/no detail/.test(error) ? ` (${error})` : ''}; not charged` }, false);
            continue;
        }
        const b = detail.basicInformation || {};
        await flushRow({
            recordType: 'individual',
            crd: String(b.individualId ?? q),
            name: fullName(b.firstName, b.middleName, b.lastName),
            otherNames: b.otherNames || [],
            brokerScope: b.bcScope || null,
            advisorScope: b.iaScope || null,
            hasDisclosures: detail.disclosureFlag === 'Y' ? true : detail.disclosureFlag === 'N' ? false : null,
            yearsInIndustry: b.daysInIndustry ? Math.round((Number(b.daysInIndustry) / 365) * 10) / 10 : null,
            currentFirms: (detail.currentEmployments || []).map((e) => ({ firm: e.firmName || null, firmCrd: e.firmId ?? null })),
            ...detailFields(detail),
            url: `${IND_URL}${b.individualId ?? q}`,
            query: q,
        }, true);
        continue;
    }

    const endpoint = firms ? 'firm' : 'individual';
    const { json, error } = await getJson(`${API}/search/${endpoint}?query=${encodeURIComponent(q)}&hits=${perQuery}&sort=score+desc&wt=json`);
    if (error) {
        await flushRow({ type: 'note', input: q, found: false, note: `search failed (${error}); not charged, try again later` }, false);
        continue;
    }
    const hits = json?.hits?.hits || [];
    if (hits.length === 0) {
        await flushRow({ type: 'note', input: q, found: false, note: 'no BrokerCheck match (try last name only, or the CRD number); not charged' }, false);
        continue;
    }
    for (const h of hits) {
        if (shouldStop()) break;
        const src = h._source || {};
        if (firms) await emitFirm(src, q);
        else await emitIndividual(src, q);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
