// Court Records Scraper: Case Law & Dockets
//
// Strategy
// --------
// CourtListener Search API v4 (courtlistener.com/api/rest/v4/search),
// keyless JSON. Each query runs its own search; recordType picks the index
// (type=o opinions/case-law, type=r dockets/RECAP). Court and date filters
// (court, filed_after, filed_before) and ordering are shared. Paging
// follows the cursor in the response's `next` URL (~20 results/page).
// absolute_url fields are site-relative and are expanded to full links.
//
// Pay per event
// -------------
//   case_row per record. Empty searches are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://www.courtlistener.com';
const SEARCH = `${BASE}/api/rest/v4/search/`;
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 40000;
const SPACING_MS = 400;
const SNIPPET_CAP = 1200;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [], recordType = 'opinions', courts = [], filedAfter = '', filedBefore = '',
    sortBy = 'relevance', maxPerQuery = 40, maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const queryList = [...new Set(asTokens(queries))];
const type = recordType === 'dockets' ? 'r' : 'o';
const courtList = [...new Set(asTokens(courts).map((c) => c.toLowerCase()))];
const perQuery = clampNum(maxPerQuery, 40, 1, 2000);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
const after = isDate(filedAfter) ? filedAfter.trim() : '';
const before = isDate(filedBefore) ? filedBefore.trim() : '';

const ORDER = {
    relevance: 'score desc', newest: 'dateFiled desc', oldest: 'dateFiled asc',
    most_cited: type === 'o' ? 'citeCount desc' : 'dateFiled desc',
};
const orderBy = ORDER[sortBy] || ORDER.relevance;

if (queryList.length === 0) {
    log.warning('No search queries given. Add a keyword, party name or case name.');
    await Actor.exit();
}

async function apiGet(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Court Records actor (admin@scrapemint.com)' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: json?.detail || `HTTP ${res.status}` };
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
// Two ways the same record reached the dataset twice, both of them billed: the
// API pages by cursor and can repeat a record across pages, and a case matching
// two of the supplied queries was emitted once per query. Keyed on the record's
// absolute URL, which is stable and unique per opinion or docket, so the second
// sighting is skipped whichever way it arrives.
const emittedKeys = new Set();
let duplicatesSkipped = 0;
const rowKey = (row) => row.opinionUrl || row.docketUrl
    || JSON.stringify({ ...row, query: undefined });
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'case_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const fullUrl = (path) => (path ? (String(path).startsWith('http') ? path : `${BASE}${path}`) : null);
const firstCitation = (c) => {
    if (Array.isArray(c)) return c[0] || null;
    if (typeof c === 'string') { const m = c.match(/'([^']+)'|"([^"]+)"/); return m ? (m[1] || m[2]) : (c || null); }
    return c || null;
};
const clean = (s) => (s == null ? null : String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CAP) || null);

function opinionRow(r, label) {
    const op = (r.opinions || [])[0] || {};
    return {
        recordType: 'opinion',
        caseName: r.caseName || r.caseNameFull || null,
        court: r.court || null,
        courtId: r.court_id || null,
        jurisdiction: r.court_jurisdiction || null,
        dateFiled: r.dateFiled || null,
        dateArgued: r.dateArgued || null,
        citation: firstCitation(r.citation),
        neutralCitation: r.neutralCite || null,
        citationCount: r.citeCount ?? null,
        precedentialStatus: r.status || null,
        docketNumber: r.docketNumber || null,
        judge: r.judge || null,
        natureOfSuit: r.suitNature || null,
        snippet: clean(op.snippet),
        opinionUrl: fullUrl(r.absolute_url),
        documentUrl: op.download_url || fullUrl(op.local_path) || null,
        query: label,
    };
}

function docketRow(r, label) {
    return {
        recordType: 'docket',
        caseName: r.caseName || r.case_name_full || null,
        court: r.court || null,
        courtId: r.court_id || null,
        docketNumber: r.docketNumber || null,
        dateFiled: r.dateFiled || null,
        dateTerminated: r.dateTerminated || null,
        assignedJudge: r.assignedTo || null,
        natureOfSuit: r.suitNature || r.cause || null,
        cause: r.cause || null,
        bankruptcyChapter: r.chapter || null,
        docketUrl: fullUrl(r.docket_absolute_url || r.absolute_url),
        query: label,
    };
}

function buildUrl(q) {
    const usp = new URLSearchParams({ q, type, order_by: orderBy });
    for (const c of courtList) usp.append('court', c);
    if (after) usp.set('filed_after', after);
    if (before) usp.set('filed_before', before);
    return `${SEARCH}?${usp}`;
}

log.info(`Searching ${queryList.length} quer(ies) in ${type === 'o' ? 'case law' : 'dockets'}`
    + `${courtList.length ? `, courts=${courtList.join('/')}` : ''}${after ? `, after ${after}` : ''}${before ? `, before ${before}` : ''}...`);

for (const q of queryList) {
    if (shouldStop()) break;
    let url = buildUrl(q);
    let emitted = 0;
    let matched = 0; // hits from the API, before dedupe
    let total = null;
    let failed = null;
    while (url && emitted < perQuery && !shouldStop()) {
        const json = await apiGet(url);
        if (json?.error) { failed = json.error; break; }
        if (total === null) total = json.count ?? 0;
        const results = json.results || [];
        if (results.length === 0) break;
        for (const r of results) {
            if (emitted >= perQuery || shouldStop()) break;
            const row = type === 'o' ? opinionRow(r, q) : docketRow(r, q);
            matched += 1;
            const k = rowKey(row);
            if (emittedKeys.has(k)) { duplicatesSkipped += 1; continue; }
            emittedKeys.add(k);
            await flushRow(row, true);
            emitted += 1;
        }
        url = json.next || null;
    }
    if (failed && emitted === 0) {
        await flushRow({ type: 'note', input: q, found: false, note: `search failed (${failed}); not charged, try again later` }, false);
    } else if (emitted === 0 && matched > 0) {
        // Every hit was already returned by an earlier query, so the search did
        // match; saying "no records matched" here would be wrong.
        await flushRow({ type: 'note', input: q, found: true, note: `${matched} record(s) matched but were already returned by an earlier query; not charged twice` }, false);
    } else if (emitted === 0) {
        await flushRow({ type: 'note', input: q, found: false, note: 'no court records matched this search; not charged' }, false);
    } else {
        log.info(`"${q}": ${emitted} record(s) of ${total} total.`);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${duplicatesSkipped ? ` — ${duplicatesSkipped} duplicate record(s) skipped, not charged` : ''}`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
