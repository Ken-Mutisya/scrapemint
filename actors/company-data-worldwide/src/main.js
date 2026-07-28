// Company Data Worldwide: Industry, Founding, Owners and Listings
//
// What it does
// ------------
// Structured company facts for anywhere on earth: when a company was founded,
// where it is based, what industry it is in, who owns it, which exchanges it
// trades on under which ticker, and how many people it employs.
//
//   search        companies matching a country, industry or founding window
//   company       full profile for named companies
//   subsidiaries  what a parent company owns
//
// Distinct from our global-company-verification, which confirms that a legal
// entity is registered through VAT and LEI records. This describes what the
// company IS and who controls it.
//
// The honest limit
// ----------------
// This is an encyclopedic knowledge base, not a companies registry. Large and
// notable firms are described in depth; a small local business may be absent
// entirely. It is the right tool for mapping an industry, tracing ownership or
// enriching a list of known companies, and the wrong tool for proving that a
// given small company exists.
//
// Pay per event
// -------------
//   company_row ($0.005) charged per company returned. First 2 rows per run
//   free. Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const FETCH_TIMEOUT_MS = 90000;
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const SEARCH_URL = 'https://www.wikidata.org/w/api.php';
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'search',
    country = 'United States',
    industry = '',
    foundedFrom = 0,
    foundedTo = 0,
    listedOnly = false,
    companies = [],
    parentCompany = '',
    maxResults = 50,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['search', 'company', 'subsidiaries'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'search';
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 50));

// Classes that mean "a company" in this knowledge base. Walking the subclass
// tree instead is far more expensive and times the query out.
const COMPANY_CLASSES = ['Q4830453', 'Q891723', 'Q6881511', 'Q783794'];

async function httpJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, accept: 'application/sparql-results+json, application/json' },
        });
        const text = await res.text();
        // A query that runs out of time comes back as an HTML or plain text
        // error page, not JSON, so anything that is not a brace is a failure.
        if (!text.trimStart().startsWith('{')) {
            return { ok: false, status: res.status, message: text.slice(0, 200).replace(/\s+/g, ' ') };
        }
        return { ok: true, json: JSON.parse(text) };
    } catch (err) {
        if (attempt < 2) {
            await sleep(1500 * (attempt + 1));
            return httpJson(url, attempt + 1);
        }
        return { ok: false, status: 0, message: err?.message };
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'company_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Free text to an entity id, so a buyer types "Germany" or "software" rather
// than looking up internal identifiers.
async function resolveEntity(term, hint = '') {
    const q = clean(term);
    if (!q) return null;
    if (/^Q\d+$/i.test(q)) return { id: q.toUpperCase(), label: q.toUpperCase(), exact: true };
    const url = `${SEARCH_URL}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=5&type=item&origin=*`;
    const res = await httpJson(url);
    await sleep(300);
    if (!res.ok) return null;
    const hits = res.json?.search || [];
    if (!hits.length) return null;
    // An exact label match wins. Ranking on the description instead resolved
    // "automotive industry" to "automotive industry in the Soviet Union".
    const lower = q.toLowerCase();
    const preferred = hits.find((h) => String(h.label || '').toLowerCase() === lower)
        || (hint ? hits.find((h) => `${h.description || ''}`.toLowerCase().includes(hint)) : null)
        || hits[0];
    return { id: preferred.id, label: clean(preferred.label), description: clean(preferred.description), exact: false };
}

async function runSparql(query) {
    const res = await httpJson(`${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`);
    if (!res.ok) {
        log.warning(`query failed (status ${res.status}): ${res.message}`);
        // 400 means the query was rejected, anything else means the service
        // was slow or unavailable. Reporting one as the other sends the buyer
        // chasing the wrong fix.
        return { failure: res.status === 400 ? 'rejected' : 'unavailable' };
    }
    return res.json?.results?.bindings || [];
}

const val = (b, k) => clean(b?.[k]?.value);

// "79500@2021; 86200@2025" -> the most recent figure, plus the full history.
function parseEmployees(text) {
    const pairs = String(text || '').split(';').map((s) => s.trim()).filter(Boolean)
        .map((chunk) => {
            const [countPart, yearPart] = chunk.split('@');
            const count = Number(String(countPart).replace(/[^\d.]/g, ''));
            const year = /^\d{4}$/.test(String(yearPart).trim()) ? Number(yearPart) : null;
            return Number.isFinite(count) ? { count, year } : null;
        })
        .filter(Boolean);
    if (!pairs.length) return { employees: null, employeesAsOf: null, employeeHistory: [] };
    const dated = pairs.filter((p) => p.year != null).sort((a, b) => b.year - a.year);
    // Prefer the newest dated figure; an undated one is used only if nothing
    // is dated, because the largest number is not the current one.
    const best = dated[0] || pairs[0];
    return {
        employees: best.count,
        employeesAsOf: best.year,
        employeeHistory: pairs.sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
    };
}

// "Nasdaq:CSCO; Hong Kong Stock Exchange:4333" -> structured listings.
function parseListings(text) {
    return String(text || '').split(';').map((s) => s.trim()).filter(Boolean)
        .map((chunk) => {
            const idx = chunk.lastIndexOf(':');
            if (idx === -1) return { exchange: chunk, ticker: null };
            return { exchange: chunk.slice(0, idx).trim(), ticker: chunk.slice(idx + 1).trim() || null };
        });
}

// The label service is unreliable inside a grouped query: it returned a bare
// entity id instead of "Cisco" in testing. Labels are therefore bound
// explicitly, and a company with no English label keeps its id rather than
// disappearing.
const SELECT_BLOCK = `
 (SAMPLE(?inception) AS ?founded)
 (SAMPLE(?website) AS ?site)
 (SAMPLE(?hqLabel) AS ?hq)
 (SAMPLE(?countryLabel) AS ?countryName)
 (SAMPLE(?legalFormLabel) AS ?legalForm)
 (SAMPLE(?ceoLabel) AS ?ceo)
 (SAMPLE(?parentLabel) AS ?parent)
 (GROUP_CONCAT(DISTINCT ?industryLabel; separator="; ") AS ?industries)
 (GROUP_CONCAT(DISTINCT ?exchangeTicker; separator="; ") AS ?listings)
 (GROUP_CONCAT(DISTINCT ?empPair; separator="; ") AS ?employeeHistory)`;

const OPTIONAL_BLOCK = `
  OPTIONAL { ?company rdfs:label ?companyLabel FILTER(lang(?companyLabel)="en") }
  OPTIONAL { ?company wdt:P571 ?inception }
  OPTIONAL { ?company wdt:P856 ?website }
  OPTIONAL { ?company wdt:P159 ?hq . ?hq rdfs:label ?hqLabel FILTER(lang(?hqLabel)="en") }
  OPTIONAL { ?company wdt:P17 ?ctry . ?ctry rdfs:label ?countryLabel FILTER(lang(?countryLabel)="en") }
  OPTIONAL { ?company wdt:P1454 ?legalForm . ?legalForm rdfs:label ?legalFormLabel FILTER(lang(?legalFormLabel)="en") }
  OPTIONAL { ?company wdt:P169 ?ceo . ?ceo rdfs:label ?ceoLabel FILTER(lang(?ceoLabel)="en") }
  OPTIONAL { ?company wdt:P749 ?parentOrg . ?parentOrg rdfs:label ?parentLabel FILTER(lang(?parentLabel)="en") }
  OPTIONAL { ?company wdt:P452 ?industry . ?industry rdfs:label ?industryLabel FILTER(lang(?industryLabel)="en") }
  OPTIONAL {
    ?company p:P414 ?listStmt . ?listStmt ps:P414 ?exchange .
    ?exchange rdfs:label ?exLabel FILTER(lang(?exLabel)="en")
    OPTIONAL { ?listStmt pq:P249 ?tk }
    BIND(CONCAT(?exLabel, IF(BOUND(?tk), CONCAT(":", ?tk), "")) AS ?exchangeTicker)
  }
  OPTIONAL {
    ?company p:P1128 ?empStmt . ?empStmt ps:P1128 ?emp .
    OPTIONAL { ?empStmt pq:P585 ?empDate }
    BIND(CONCAT(STR(?emp), "@", IF(BOUND(?empDate), STR(YEAR(?empDate)), "?")) AS ?empPair)
  }`;

function toRow(b, extra = {}) {
    const emp = parseEmployees(val(b, 'employeeHistory'));
    const id = (val(b, 'company') || '').split('/').pop();
    const founded = val(b, 'founded');
    return {
        company: val(b, 'companyLabel') || id,
        wikidataId: id,
        wikidataUrl: id ? `https://www.wikidata.org/wiki/${id}` : null,
        country: val(b, 'countryName'),
        headquarters: val(b, 'hq'),
        founded: founded ? founded.slice(0, 10) : null,
        foundedYear: founded ? Number(founded.slice(0, 4)) : null,
        industries: val(b, 'industries') ? val(b, 'industries').split('; ').filter(Boolean) : [],
        legalForm: val(b, 'legalForm'),
        chiefExecutive: val(b, 'ceo'),
        parentCompany: val(b, 'parent'),
        listings: parseListings(val(b, 'listings')),
        isListed: Boolean(val(b, 'listings')),
        tickers: parseListings(val(b, 'listings')).map((l) => l.ticker).filter(Boolean),
        employees: emp.employees,
        employeesAsOf: emp.employeesAsOf,
        employeeHistory: emp.employeeHistory,
        website: val(b, 'site'),
        source: 'Wikidata (CC0)',
        scrapedAt: new Date().toISOString(),
        ...extra,
    };
}

let emitted = 0;
const push = async (row) => {
    if (emitted >= cap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

log.info(`Company data ${theMode} | cap ${cap}`);

if (theMode === 'search') {
    const countryEntity = clean(country) ? await resolveEntity(country, 'country') : null;
    if (clean(country) && !countryEntity) {
        await flushRow({ type: 'note', found: false, requested: country, note: 'could not resolve that country; try the plain English name such as Germany, or an entity id such as Q183; not charged' }, false);
        log.error('country not resolved');
        await Actor.exit();
    }
    // Companies are tagged with "software industry" rather than "software",
    // and which phrasing is the real one varies by sector. Rather than guess,
    // both readings are resolved and the search keeps whichever actually
    // returns companies, so a wrong guess never looks like an empty sector.
    const industryCandidates = [];
    if (clean(industry)) {
        const term = clean(industry);
        const attempts = /\bindustry\b/i.test(term) ? [term] : [`${term} industry`, term];
        for (const attempt of attempts) {
            const hit = await resolveEntity(attempt, 'industry');
            if (hit && !industryCandidates.some((c) => c.id === hit.id)) industryCandidates.push(hit);
        }
        if (!industryCandidates.length) {
            await flushRow({ type: 'note', found: false, requested: industry, note: 'could not resolve that industry; try a plain term such as software, banking or pharmaceutical; not charged' }, false);
        }
    }

    // VALUES takes a space separated list; commas are a syntax error.
    const classes = COMPANY_CLASSES.map((c) => `wd:${c}`).join(' ');
    const buildFilters = (industryEntity) => {
    const filters = [];
    if (countryEntity) filters.push(`?company wdt:P17 wd:${countryEntity.id} .`);
    if (industryEntity) filters.push(`?company wdt:P452 wd:${industryEntity.id} .`);
    if (listedOnly) filters.push('?company wdt:P414 ?anyExchange .');
    const from = Number(foundedFrom) || 0;
    const to = Number(foundedTo) || 0;
    if (from || to) {
        filters.push('?company wdt:P571 ?foundedFilter .');
        if (from) filters.push(`FILTER(YEAR(?foundedFilter) >= ${from})`);
        if (to) filters.push(`FILTER(YEAR(?foundedFilter) <= ${to})`);
    }
    return filters;
    };
    const from = Number(foundedFrom) || 0;
    const to = Number(foundedTo) || 0;

    const buildQuery = (filters) => `SELECT ?company ?companyLabel${SELECT_BLOCK}
WHERE {
  VALUES ?class { ${classes} }
  ?company wdt:P31 ?class .
  ${filters.join('\n  ')}
  ${OPTIONAL_BLOCK}
}
GROUP BY ?company ?companyLabel
LIMIT ${cap}`;

    let industryEntity = null;
    let bindings = null;
    for (const candidate of (industryCandidates.length ? industryCandidates : [null])) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        log.info(`Searching: country ${countryEntity?.label ?? 'any'}${candidate ? `, industry ${candidate.label}` : ''}${from || to ? `, founded ${from || 'any'}-${to || 'any'}` : ''}${listedOnly ? ', listed only' : ''}`);
        const attempt = await runSparql(buildQuery(buildFilters(candidate)));
        industryEntity = candidate;
        bindings = attempt;
        if (attempt?.failure) break;
        if (attempt.length) break;
        if (candidate) log.info(`no companies under "${candidate.label}", trying the other reading of the term`);
    }
    if (bindings?.failure) {
        await flushRow({
            type: 'note', found: false, failure: bindings.failure,
            note: bindings.failure === 'rejected'
                ? 'the source rejected this combination of filters; try a simpler country or industry term; not charged'
                : 'the query service was slow or unavailable; narrow the search with a country, an industry or a founding year range, or lower maxResults, and try again; not charged',
        }, false);
    } else if (!bindings.length) {
        await flushRow({
            type: 'note', found: false, country: countryEntity?.label ?? null, industry: industryEntity?.label ?? null,
            note: 'no companies matched; the industry term may be too specific, or that combination may simply not be recorded; not charged',
        }, false);
    } else {
        const rows = bindings.map((b) => toRow(b, {
            matchedCountry: countryEntity?.label ?? null,
            matchedIndustry: industryEntity?.label ?? null,
        }));
        rows.sort((a, b) => (b.employees ?? -1) - (a.employees ?? -1));
        for (const row of rows) { if (!(await push(row))) break; }
    }
} else if (theMode === 'company') {
    const names = asList(companies);
    if (!names.length) {
        await flushRow({ type: 'note', found: false, note: 'company mode needs at least one company name or entity id; not charged' }, false);
        log.error('no companies given');
        await Actor.exit();
    }
    const ids = [];
    for (const name of names) {
        const hit = await resolveEntity(name, 'company');
        if (!hit) {
            await flushRow({ type: 'note', found: false, requested: name, note: 'no entity matched that name; try the full legal name, or pass an entity id; not charged' }, false);
            continue;
        }
        ids.push({ ...hit, requested: name });
    }
    if (ids.length) {
        const values = ids.map((i) => `wd:${i.id}`).join(' ');
        const query = `SELECT ?company ?companyLabel${SELECT_BLOCK}
WHERE {
  VALUES ?company { ${values} }
  ${OPTIONAL_BLOCK}
}
GROUP BY ?company ?companyLabel
LIMIT ${Math.max(ids.length, cap)}`;
        const bindings = await runSparql(query);
        if (bindings?.failure || !bindings?.length) {
            await flushRow({ type: 'note', found: false, note: 'the requested entities returned no company facts; not charged' }, false);
        } else {
            for (const b of bindings) {
                const id = (val(b, 'company') || '').split('/').pop();
                const asked = ids.find((i) => i.id === id);
                if (!(await push(toRow(b, { requestedName: asked?.requested ?? null })))) break;
            }
        }
    }
} else {
    const parent = await resolveEntity(parentCompany, 'company');
    if (!parent) {
        await flushRow({ type: 'note', found: false, requested: parentCompany, note: 'subsidiaries mode needs a parent company name or entity id that can be resolved; not charged' }, false);
        log.error('parent not resolved');
        await Actor.exit();
    }
    // Both directions are recorded and neither is complete on its own: some
    // groups list what they own, others are linked from the subsidiary.
    const query = `SELECT ?company ?companyLabel${SELECT_BLOCK}
WHERE {
  { wd:${parent.id} wdt:P355 ?company } UNION { ?company wdt:P749 wd:${parent.id} }
  ${OPTIONAL_BLOCK}
}
GROUP BY ?company ?companyLabel
LIMIT ${cap}`;
    log.info(`Subsidiaries of ${parent.label ?? parent.id}`);
    const bindings = await runSparql(query);
    if (bindings?.failure) {
        await flushRow({ type: 'note', found: false, failure: bindings.failure, note: 'the query service did not return subsidiaries; try again shortly; not charged' }, false);
    } else if (!bindings.length) {
        await flushRow({
            type: 'note', found: false, parent: parent.label ?? parent.id,
            note: 'no subsidiaries are recorded for that company; ownership coverage is strongest for large listed groups; not charged',
        }, false);
    } else {
        for (const b of bindings) {
            if (!(await push(toRow(b, { parentSearched: parent.label ?? parent.id })))) break;
        }
    }
}

if (!emitted && !notePushed) {
    await flushRow({ type: 'note', found: false, note: 'no companies returned; not charged' }, false);
}

log.info(`Done. ${emitted} company row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
