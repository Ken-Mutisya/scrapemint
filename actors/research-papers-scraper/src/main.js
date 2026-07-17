// Research Papers Scraper: Citations, Authors & Experts
//
// Strategy
// --------
// OpenAlex API (api.openalex.org), keyless JSON over 250M+ works across
// every field. Four modes:
//   queries       -> /works?search= with year/citation/open-access filters,
//                    cursor pagination (per-page up to 200)
//   expertQueries -> /works?search=&group_by=authorships.author.id ranks the
//                    most-published authors on a topic; their profiles are
//                    then batch-fetched via /authors?filter=ids.openalex:A|A
//   authorNames   -> /authors?search= (matches names, NOT topics — that is
//                    what expertQueries is for)
//   dois          -> /works/https://doi.org/{doi} lookups
//
// Abstracts arrive as an inverted index (word -> positions) and are
// reconstructed locally. The mailto param opts into OpenAlex's polite pool
// (faster, more reliable; limits 10 req/s, 100k/day are far above what a
// run uses).
//
// Pay per event
// -------------
//   research_row per paper, expert or author row. Empty searches and
//   unknown DOIs are free note rows. First 2 chargeable rows per run free.

import { Actor, log } from 'apify';

const API = 'https://api.openalex.org';
const MAILTO = 'admin@scrapemint.com';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 30000;
const PAGE_MAX = 200;
const AUTHOR_BATCH = 50;
const SPACING_MS = 150;
const ABSTRACT_CAP = 2500;
const AUTHORS_PER_PAPER = 25;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [], maxPerQuery = 15, sortBy = 'relevance', yearFrom = 0, yearTo = 0,
    minCitations = 0, openAccessOnly = false,
    expertQueries = [], maxExpertsPerQuery = 10,
    authorNames = [], maxAuthorsPerName = 3,
    dois = [], maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const queryList = [...new Set(asTokens(queries))];
const expertList = [...new Set(asTokens(expertQueries))];
const nameList = [...new Set(asTokens(authorNames))];
const doiList = [...new Set(asTokens(dois).map((d) => d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()).filter(Boolean))];
const perQuery = clampNum(maxPerQuery, 15, 1, 2000);
const expertsPer = clampNum(maxExpertsPerQuery, 10, 1, 100);
const authorsPerName = clampNum(maxAuthorsPerName, 3, 1, 25);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);
const yFrom = clampNum(yearFrom, 0, 0, 2100);
const yTo = clampNum(yearTo, 0, 0, 2100);
const minCited = clampNum(minCitations, 0, 0, 1000000);

if (queryList.length === 0 && expertList.length === 0 && nameList.length === 0 && doiList.length === 0) {
    log.warning('No searches, expert topics, author names or DOIs given. Add a search like "large language models".');
    await Actor.exit();
}

async function apiGet(path, params = {}) {
    const usp = new URLSearchParams({ mailto: MAILTO });
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
    }
    const url = `${API}${path}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (res.status === 404) return { notFound: true };
            if (!res.ok || !json) return { error: json?.message || `HTTP ${res.status}` };
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
            await Actor.charge({ eventName: 'research_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// abstract_inverted_index: { word: [positions...] } -> readable text
function abstractFrom(inv) {
    if (!inv || typeof inv !== 'object') return null;
    const words = [];
    for (const [word, positions] of Object.entries(inv)) {
        for (const p of positions) words[p] = word;
    }
    const text = words.filter((w) => w !== undefined).join(' ').trim();
    return text ? text.slice(0, ABSTRACT_CAP) : null;
}

const idTail = (id) => (id ? String(id).replace(/^https?:\/\/openalex\.org\//, '') : null);

function paperRow(w, extra = {}) {
    const authorships = w.authorships || [];
    return {
        type: 'paper',
        title: w.title || w.display_name || null,
        doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : null,
        url: w.doi || w.id || null,
        openalexId: idTail(w.id),
        publicationDate: w.publication_date || null,
        year: w.publication_year ?? null,
        docType: w.type || null,
        journal: w.primary_location?.source?.display_name || null,
        authors: authorships.slice(0, AUTHORS_PER_PAPER).map((a) => a.author?.display_name).filter(Boolean),
        moreAuthors: Math.max(0, authorships.length - AUTHORS_PER_PAPER),
        firstAuthorInstitutions: (authorships[0]?.institutions || []).map((i) => i.display_name).filter(Boolean),
        citedByCount: w.cited_by_count ?? null,
        fwci: w.fwci ?? null,
        isOpenAccess: w.open_access?.is_oa ?? null,
        pdfUrl: w.best_oa_location?.pdf_url || null,
        topic: w.primary_topic?.display_name || null,
        abstract: abstractFrom(w.abstract_inverted_index),
        ...extra,
    };
}

function authorRow(a, type, extra = {}) {
    return {
        type,
        name: a.display_name || null,
        orcid: a.orcid || null,
        hIndex: a.summary_stats?.h_index ?? null,
        worksCount: a.works_count ?? null,
        citedByCount: a.cited_by_count ?? null,
        institutions: (a.last_known_institutions || []).map((i) => i.display_name).filter(Boolean),
        institutionCountries: [...new Set((a.last_known_institutions || []).map((i) => i.country_code).filter(Boolean))],
        openalexId: idTail(a.id),
        openalexUrl: a.id || null,
        ...extra,
    };
}

function workFilters() {
    const f = [];
    if (yFrom) f.push(`from_publication_date:${yFrom}-01-01`);
    if (yTo) f.push(`to_publication_date:${yTo}-12-31`);
    if (minCited > 0) f.push(`cited_by_count:>${minCited - 1}`);
    if (openAccessOnly) f.push('is_oa:true');
    return f.join(',');
}
const SORTS = { citations: 'cited_by_count:desc', newest: 'publication_date:desc' };

// --- mode 1: paper searches --------------------------------------------------

const seenWorks = new Set();

for (const q of queryList) {
    if (shouldStop()) break;
    let cursor = '*';
    let pushed = 0;
    let sawAny = false;
    let failed = null;
    while (pushed < perQuery && cursor && !shouldStop()) {
        const json = await apiGet('/works', {
            search: q, filter: workFilters(), sort: SORTS[sortBy],
            'per-page': Math.min(PAGE_MAX, perQuery - pushed), cursor,
        });
        if (json?.error) { failed = json.error; break; }
        const results = json.results || [];
        if (results.length > 0) sawAny = true;
        for (const w of results) {
            if (pushed >= perQuery || shouldStop()) break;
            if (!w.id || seenWorks.has(w.id)) continue;
            seenWorks.add(w.id);
            await flushRow(paperRow(w, { searchTerm: q }), true);
            pushed += 1;
        }
        cursor = results.length > 0 ? json.meta?.next_cursor : null;
    }
    if (failed) {
        await flushRow({ type: 'note', input: q, found: false, note: `search failed (${failed}); not charged, try again later` }, false);
    } else if (!sawAny) {
        await flushRow({ type: 'note', input: q, found: false, note: 'no papers matched this search and filters; not charged' }, false);
    }
}

// --- mode 2: top experts per topic ------------------------------------------

async function fetchAuthorsByIds(ids) {
    const byId = new Map();
    for (let i = 0; i < ids.length; i += AUTHOR_BATCH) {
        const chunk = ids.slice(i, i + AUTHOR_BATCH);
        const json = await apiGet('/authors', { filter: `ids.openalex:${chunk.join('|')}`, 'per-page': AUTHOR_BATCH });
        for (const a of json?.results || []) byId.set(idTail(a.id), a);
    }
    return byId;
}

for (const topic of expertList) {
    if (shouldStop()) break;
    const json = await apiGet('/works', { search: topic, filter: workFilters(), group_by: 'authorships.author.id' });
    if (json?.error) {
        await flushRow({ type: 'note', input: topic, found: false, note: `expert search failed (${json.error}); not charged, try again later` }, false);
        continue;
    }
    const groups = (json.group_by || [])
        .filter((g) => /^https?:\/\/openalex\.org\/A\d+$/.test(g.key || ''))
        .slice(0, expertsPer);
    if (groups.length === 0) {
        await flushRow({ type: 'note', input: topic, found: false, note: 'no authors found for this topic; not charged' }, false);
        continue;
    }
    const detailed = await fetchAuthorsByIds(groups.map((g) => idTail(g.key)));
    let rank = 0;
    for (const g of groups) {
        if (shouldStop()) break;
        rank += 1;
        const a = detailed.get(idTail(g.key));
        if (!a) continue;
        await flushRow(authorRow(a, 'expert', { topic, topicRank: rank, worksOnTopic: g.count }), true);
    }
}

// --- mode 3: author name lookups --------------------------------------------

for (const name of nameList) {
    if (shouldStop()) break;
    const json = await apiGet('/authors', { search: name, 'per-page': authorsPerName });
    if (json?.error) {
        await flushRow({ type: 'note', input: name, found: false, note: `author search failed (${json.error}); not charged, try again later` }, false);
        continue;
    }
    const results = (json.results || []).slice(0, authorsPerName);
    if (results.length === 0) {
        await flushRow({ type: 'note', input: name, found: false, note: 'no researcher matched this name; not charged' }, false);
        continue;
    }
    for (const a of results) {
        if (shouldStop()) break;
        await flushRow(authorRow(a, 'author', { searchedName: name }), true);
    }
}

// --- mode 4: DOI lookups -----------------------------------------------------

for (const doi of doiList) {
    if (shouldStop()) break;
    const json = await apiGet(`/works/https://doi.org/${doi}`);
    if (json?.notFound) {
        await flushRow({ type: 'note', input: doi, found: false, note: 'DOI not found in OpenAlex; not charged' }, false);
        continue;
    }
    if (json?.error) {
        await flushRow({ type: 'note', input: doi, found: false, note: `lookup failed (${json.error}); not charged, try again later` }, false);
        continue;
    }
    if (json.id && !seenWorks.has(json.id)) {
        seenWorks.add(json.id);
        await flushRow(paperRow(json, { searchTerm: null, lookedUpDoi: doi }), true);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
