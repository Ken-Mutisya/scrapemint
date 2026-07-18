// NIH Research Grant Finder: Awards & PIs
//
// Strategy
// --------
// NIH RePORTER API v2 (api.reporter.nih.gov/v2/projects/search), keyless
// JSON POST over every NIH-funded research project. Each keyword becomes
// its own search; the organization / PI / state / fiscal-year / min-award
// filters are shared across all of them. With no keyword, a single search
// runs on the filters alone.
//
// Paging: limit maxes at 500 per request and offset caps at ~15,000, so a
// single query returns at most 15,000 grants (narrow with filters to go
// deeper). Award amounts are whole US dollars.
//
// Pay per event
// -------------
//   grant_row per grant. Empty searches are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://api.reporter.nih.gov/v2/projects/search';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 45000;
const PAGE_LIMIT = 500;
const OFFSET_CAP = 14999;
const SPACING_MS = 300;
const ABSTRACT_CAP = 4000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchText = [], organizations = [], principalInvestigators = [], states = [],
    fiscalYears = [], minAwardUsd = 0, includeAbstract = true,
    sortBy = 'award_desc', maxPerQuery = 100, maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const termList = [...new Set(asTokens(searchText))];
const orgList = [...new Set(asTokens(organizations))];
const piList = [...new Set(asTokens(principalInvestigators))];
const stateList = [...new Set(asTokens(states).map((s) => s.toUpperCase().slice(0, 2)))];
const fyList = [...new Set(asTokens(fiscalYears).map((y) => parseInt(y, 10)).filter((y) => y >= 1985 && y <= 2100))];
const minAward = clampNum(minAwardUsd, 0, 0, 1000000000);
const perQuery = clampNum(maxPerQuery, 100, 1, 15000);
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);

const SORTS = {
    award_desc: { sort_field: 'award_amount', sort_order: 'desc' },
    award_asc: { sort_field: 'award_amount', sort_order: 'asc' },
    newest: { sort_field: 'project_start_date', sort_order: 'desc' },
};
const sort = SORTS[sortBy] || SORTS.award_desc;

if (termList.length === 0 && orgList.length === 0 && piList.length === 0 && stateList.length === 0 && fyList.length === 0) {
    log.warning('Nothing to search. Add a keyword, an institution, a PI, a state or a fiscal year.');
    await Actor.exit();
}

const INCLUDE_FIELDS = ['ProjectTitle', 'ProjectNum', 'FiscalYear', 'AwardAmount', 'Organization',
    'PrincipalInvestigators', 'AgencyIcAdmin', 'ProjectStartDate', 'ProjectEndDate', 'Terms',
    'ProjectDetailUrl', ...(includeAbstract ? ['AbstractText'] : [])];

function baseCriteria() {
    const c = {};
    if (orgList.length) c.org_names = orgList;
    if (piList.length) c.pi_names = piList.map((n) => ({ any_name: n }));
    if (stateList.length) c.org_states = stateList;
    if (fyList.length) c.fiscal_years = fyList;
    if (minAward > 0) c.award_amount_range = { min_amount: minAward, max_amount: 1000000000 };
    return c;
}

async function apiPost(criteria, offset) {
    const body = JSON.stringify({ criteria, include_fields: INCLUDE_FIELDS, offset, limit: PAGE_LIMIT, ...sort });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(API, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: (Array.isArray(json) ? json[0] : json?.message) || `HTTP ${res.status}` };
            if (Array.isArray(json)) return { error: json[0] || 'API error' };
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
            await Actor.charge({ eventName: 'grant_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const stripHtml = (s) => (s == null ? null : String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ABSTRACT_CAP) || null);

function toRow(r, label) {
    const org = r.organization || {};
    const ic = r.agency_ic_admin || {};
    const pis = (r.principal_investigators || []).map((p) => ({
        name: (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`).trim() || null,
        isContact: p.is_contact_pi ?? null,
    })).filter((p) => p.name);
    return {
        projectTitle: r.project_title || null,
        projectNumber: r.project_num || null,
        fiscalYear: r.fiscal_year ?? null,
        awardAmountUsd: r.award_amount ?? null,
        organization: org.org_name || null,
        orgCity: org.org_city || null,
        orgState: org.org_state || null,
        orgCountry: org.org_country || null,
        principalInvestigators: pis.map((p) => p.name),
        contactPi: (pis.find((p) => p.isContact) || pis[0] || {}).name || null,
        fundingAgency: typeof ic === 'object' ? (ic.abbreviation || ic.name || null) : ic,
        projectStartDate: r.project_start_date ? r.project_start_date.slice(0, 10) : null,
        projectEndDate: r.project_end_date ? r.project_end_date.slice(0, 10) : null,
        terms: r.terms ? String(r.terms).split(/[;<>]/).map((t) => t.trim()).filter(Boolean).slice(0, 40) : [],
        ...(includeAbstract ? { abstract: stripHtml(r.abstract_text) } : {}),
        detailUrl: r.project_detail_url || null,
        searchQuery: label,
    };
}

const jobs = termList.length > 0
    ? termList.map((t) => ({ label: t, text: t }))
    : [{ label: '(filters only)', text: null }];

log.info(`Running ${jobs.length} search(es)`
    + `${orgList.length ? `, orgs=${orgList.length}` : ''}${stateList.length ? `, states=${stateList.join('/')}` : ''}`
    + `${fyList.length ? `, FY=${fyList.join('/')}` : ''}${minAward ? `, min $${minAward}` : ''}...`);

for (const job of jobs) {
    if (shouldStop()) break;
    const criteria = baseCriteria();
    if (job.text) {
        criteria.advanced_text_search = { operator: 'and', search_field: 'projecttitle,abstracttext,terms', search_text: job.text };
    }
    let emitted = 0;
    let offset = 0;
    let total = null;
    let failed = null;
    while (emitted < perQuery && offset <= OFFSET_CAP && !shouldStop()) {
        const json = await apiPost(criteria, offset);
        if (json?.error) { failed = json.error; break; }
        if (total === null) total = json.meta?.total ?? 0;
        const results = json.results || [];
        if (results.length === 0) break;
        for (const r of results) {
            if (emitted >= perQuery || shouldStop()) break;
            await flushRow(toRow(r, job.label), true);
            emitted += 1;
        }
        offset += PAGE_LIMIT;
        if (offset >= total) break;
    }
    if (failed && emitted === 0) {
        await flushRow({ type: 'note', input: job.label, found: false, note: `search failed (${failed}); not charged, try again later` }, false);
    } else if (emitted === 0) {
        await flushRow({ type: 'note', input: job.label, found: false, note: 'no grants matched this search and filters; not charged' }, false);
    } else {
        log.info(`"${job.label}": ${emitted} grant(s) of ${total} total.`);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
