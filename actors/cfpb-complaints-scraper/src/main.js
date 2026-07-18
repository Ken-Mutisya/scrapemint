// Consumer Complaints Scraper (CFPB)
//
// Strategy
// --------
// CFPB Consumer Complaint Database public search API
// (consumerfinance.gov/data-research/consumer-complaints/search/api/v1),
// keyless JSON. Each company or search term becomes its own query with the
// shared product/state/date/narrative filters.
//
// Two quirks found and handled:
//   * The `frm` offset param does NOT paginate (every offset returns the
//     same first page). Instead we sort newest-first and walk the date
//     window: after each page we set date_received_max to the oldest day
//     seen and dedupe by complaint_id. A day denser than one page is
//     detected (no new ids) and the cursor steps back a day so we never
//     stall. `format=json` is avoided — it streams the entire filtered set
//     and ignores size.
//   * Responses occasionally contain invalid JSON escapes inside consumer
//     narratives, so bodies are read as text and parsed defensively
//     (sanitize then retry; skip the page if still unparseable).
//
// Pay per event
// -------------
//   complaint_row per complaint. Empty searches are free note rows. First
//   2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';
const DETAIL = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;
const FETCH_TIMEOUT_MS = 45000;
const PAGE_SIZE = 100;
const SPACING_MS = 300;
const NARRATIVE_CAP = 5000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [], searchTerms = [], product = '', state = '', sinceDays = 90,
    withNarrativeOnly = false, includeNarrativeText = true, newOnly = false,
    maxPerQuery = 100, maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const companyList = [...new Set(asTokens(companies))];
const termList = [...new Set(asTokens(searchTerms))];
const productFilter = String(product || '').trim();
const stateCode = String(state || '').trim().toUpperCase().slice(0, 2);
const perQuery = clampNum(maxPerQuery, 100, 1, 20000);
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);
const days = clampNum(sinceDays, 90, 0, 7300);
const dateMin = days > 0 ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;

if (companyList.length === 0 && termList.length === 0 && !productFilter && !stateCode) {
    log.warning('Nothing to search. Add a company, a search term, or a product/state filter.');
    await Actor.exit();
}

// Read as text and parse defensively — CFPB narratives sometimes carry
// invalid JSON escape sequences.
function safeParse(text) {
    try { return JSON.parse(text); } catch { /* fall through */ }
    try {
        // Escape stray backslashes that are not part of a valid JSON escape.
        const fixed = text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
        return JSON.parse(fixed);
    } catch { return null; }
}

let rateLimited = false;
async function apiGet(params) {
    const usp = new URLSearchParams({ size: String(PAGE_SIZE), sort: 'created_date_desc', no_aggs: 'true' });
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
    }
    const url = `${API}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint CFPB Complaints actor (admin@scrapemint.com)' } });
            if (res.status === 429) {
                if (attempt === 3) { rateLimited = true; return { error: 'HTTP 429' }; }
                await sleep(8000);
                continue;
            }
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const json = safeParse(text);
            if (!json) return { error: 'unparseable response' };
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
            await Actor.charge({ eventName: 'complaint_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline() || rateLimited;

const dayMinus = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

function toRow(s, label) {
    const narrative = s.complaint_what_happened ? String(s.complaint_what_happened).trim().slice(0, NARRATIVE_CAP) : null;
    return {
        complaintId: s.complaint_id || null,
        dateReceived: s.date_received ? s.date_received.slice(0, 10) : null,
        product: s.product || null,
        subProduct: s.sub_product || null,
        issue: s.issue || null,
        subIssue: s.sub_issue || null,
        company: s.company || null,
        state: s.state || null,
        zipCode: s.zip_code || null,
        submittedVia: s.submitted_via || null,
        companyResponse: s.company_response || null,
        companyPublicResponse: s.company_public_response || null,
        timelyResponse: s.timely || null,
        consumerDisputed: s.consumer_disputed || null,
        dateSentToCompany: s.date_sent_to_company ? s.date_sent_to_company.slice(0, 10) : null,
        tags: s.tags || null,
        hasNarrative: Boolean(narrative),
        ...(includeNarrativeText ? { narrative } : {}),
        url: s.complaint_id ? `${DETAIL}${s.complaint_id}` : null,
        query: label,
    };
}

// --- monitor state -----------------------------------------------------------

const store = newOnly ? await Actor.openKeyValueStore('cfpb-complaints-seen') : null;
const SEEN_KEY = 'seen-complaint-ids';
const SEEN_MAX = 400000;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- build jobs --------------------------------------------------------------

const baseFilter = {};
if (productFilter) baseFilter.product = productFilter;
if (stateCode) baseFilter.state = stateCode;
if (dateMin) baseFilter.date_received_min = dateMin;
if (withNarrativeOnly) baseFilter.has_narrative = 'true';

const jobs = [];
for (const c of companyList) jobs.push({ label: c, params: { ...baseFilter, company: c } });
for (const t of termList) jobs.push({ label: t, params: { ...baseFilter, search_term: t } });
if (jobs.length === 0) jobs.push({ label: `${productFilter || 'all products'}${stateCode ? ` / ${stateCode}` : ''}`, params: { ...baseFilter } });

// --- run ---------------------------------------------------------------------

log.info(`Running ${jobs.length} quer(ies)${productFilter ? `, product "${productFilter}"` : ''}${stateCode ? `, state ${stateCode}` : ''}`
    + `${dateMin ? `, since ${dateMin}` : ''}${newOnly ? ', NEW complaints only' : ''}...`);

for (const job of jobs) {
    if (shouldStop()) break;
    const jobSeen = new Set();
    let emitted = 0;
    let cursorMax = null;
    let anyHit = false;
    let stalls = 0;
    while (emitted < perQuery && !shouldStop()) {
        const params = { ...job.params };
        if (cursorMax) params.date_received_max = cursorMax;
        const json = await apiGet(params);
        if (json?.error) {
            if (emitted === 0) await flushRow({ type: 'note', input: job.label, found: false, note: `search failed (${json.error}); not charged, try again later` }, false);
            break;
        }
        const hits = json?.hits?.hits || [];
        if (hits.length === 0) break;
        anyHit = true;
        let newInPage = 0;
        let oldestDay = null;
        for (const h of hits) {
            const s = h._source || {};
            const id = s.complaint_id;
            const day = s.date_received ? s.date_received.slice(0, 10) : null;
            if (day && (!oldestDay || day < oldestDay)) oldestDay = day;
            if (!id || jobSeen.has(id)) continue;
            jobSeen.add(id);
            newInPage += 1;
            if (emitted >= perQuery || shouldStop()) break;
            if (newOnly && seen.has(id)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(id);
            await flushRow(toRow(s, job.label), true);
            emitted += 1;
        }
        if (hits.length < PAGE_SIZE) break; // last page for this window
        if (!oldestDay) break;
        // Advance the date window. A day denser than one page yields no new
        // ids — step the cursor back a day so we always make progress.
        if (newInPage === 0) {
            stalls += 1;
            cursorMax = dayMinus(oldestDay, 1);
            if (stalls > 5) break;
        } else {
            stalls = 0;
            cursorMax = oldestDay;
        }
    }
    if (!anyHit && !shouldStop()) {
        await flushRow({ type: 'note', input: job.label, found: false, note: 'no complaints matched (for an exact company name, check the spelling on consumerfinance.gov, or use a search term); not charged' }, false);
    }
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} complaint id(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${rateLimited ? ' — stopped early on API rate limit' : ''}${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
