// Federal Register Monitor: New Rules & Notices
//
// Strategy
// --------
// Official Federal Register API (www.federalregister.gov/api/v1), keyless
// JSON. Each keyword becomes one /documents.json query (agencies, document
// types, date window and the significant flag applied to all of them);
// no keywords = one query over just the filters. Pagination follows
// next_page_url. Agency inputs ("EPA", full names, slugs) are resolved
// against the /agencies endpoint, fetched once per run.
//
// Monitor mode (newOnly) keeps a set of already-emitted document numbers
// in the named key-value store 'fr-docs-seen' and only emits documents not
// in it — scheduled runs become a clean new-documents feed and quiet runs
// charge nothing.
//
// Pay per event
// -------------
//   document_row per document. Unmatched agencies, empty searches and
//   fetch failures are free note rows. First 2 chargeable rows per run
//   are free.

import { Actor, log } from 'apify';

const API = 'https://www.federalregister.gov/api/v1';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 250;
const SEEN_KEY = 'seen-document-numbers';
const SEEN_MAX = 100000;

const FIELDS = ['document_number', 'title', 'type', 'abstract', 'excerpts', 'publication_date',
    'effective_on', 'comments_close_on', 'significant', 'citation', 'docket_ids',
    'regulation_id_numbers', 'agencies', 'html_url', 'pdf_url'];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    terms = [], agencies = [], docTypes = [], sinceDays = 30,
    significantOnly = false, newOnly = false, maxPerQuery = 50, maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const termList = [...new Set(asTokens(terms))];
const agencyInputs = [...new Set(asTokens(agencies))];
const VALID_TYPES = ['RULE', 'PRORULE', 'NOTICE', 'PRESDOCU'];
const typeList = [...new Set(asTokens(docTypes).map((t) => t.toUpperCase()))].filter((t) => VALID_TYPES.includes(t));
const perQuery = clampNum(maxPerQuery, 50, 1, 1000);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);
const days = clampNum(sinceDays, 30, 1, 3650);
const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

async function apiGet(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}` };
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
            await Actor.charge({ eventName: 'document_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- agency resolution -------------------------------------------------------

const agencySlugs = [];
if (agencyInputs.length > 0) {
    const list = await apiGet(`${API}/agencies`);
    if (list?.error || !Array.isArray(list)) {
        log.error(`Could not load the agency list (${list?.error}); stopping so agency filters are not silently ignored.`);
        await flushRow({ type: 'note', found: false, note: `could not load agency list (${list?.error}); not charged, try again later` }, false);
        await Actor.exit();
    }
    for (const raw of agencyInputs) {
        const needle = raw.toLowerCase();
        const hit = list.find((a) => a.slug === needle)
            || list.find((a) => (a.short_name || '').toLowerCase() === needle)
            || list.find((a) => (a.name || '').toLowerCase() === needle)
            || list.find((a) => (a.name || '').toLowerCase().includes(needle));
        if (hit) {
            agencySlugs.push(hit.slug);
            log.info(`Agency "${raw}" -> ${hit.name} (${hit.slug})`);
        } else {
            await flushRow({ type: 'note', input: raw, found: false, note: 'agency not recognized (try the name as written on federalregister.gov); not charged' }, false);
        }
    }
    if (agencySlugs.length === 0) {
        log.warning('None of the given agencies matched; stopping rather than searching all agencies.');
        await Actor.exit();
    }
}

// --- seen-set for monitor mode ----------------------------------------------

const store = newOnly ? await Actor.openKeyValueStore('fr-docs-seen') : null;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;

// --- queries -----------------------------------------------------------------

function buildUrl(term) {
    const usp = new URLSearchParams();
    if (term) usp.set('conditions[term]', term);
    for (const slug of agencySlugs) usp.append('conditions[agencies][]', slug);
    for (const t of typeList) usp.append('conditions[type][]', t);
    usp.set('conditions[publication_date][gte]', sinceDate);
    if (significantOnly) usp.set('conditions[significant]', '1');
    usp.set('order', 'newest');
    usp.set('per_page', String(Math.min(perQuery, 1000)));
    for (const f of FIELDS) usp.append('fields[]', f);
    return `${API}/documents.json?${usp}`;
}

const stripTags = (s) => (s == null ? null : String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null);

function toRow(doc, term) {
    return {
        documentNumber: doc.document_number,
        title: doc.title || null,
        docType: doc.type || null,
        abstract: doc.abstract || null,
        excerpt: stripTags(doc.excerpts),
        agencies: [...new Set((doc.agencies || []).map((a) => a?.name).filter(Boolean))],
        publicationDate: doc.publication_date || null,
        effectiveDate: doc.effective_on || null,
        commentsCloseOn: doc.comments_close_on || null,
        significant: doc.significant ?? null,
        citation: doc.citation || null,
        docketIds: doc.docket_ids || [],
        regulationIdNumbers: doc.regulation_id_numbers || [],
        url: doc.html_url || null,
        pdfUrl: doc.pdf_url || null,
        searchTerm: term || null,
    };
}

const jobs = termList.length > 0 ? termList : [null];
const emitted = new Set(); // dedupe across overlapping keywords within the run
let skippedSeen = 0;

log.info(`Searching ${termList.length || 'no'} keyword(s), ${agencySlugs.length || 'all'} agencies, `
    + `types ${typeList.join('/') || 'all'}, since ${sinceDate}${significantOnly ? ', significant only' : ''}${newOnly ? ', NEW documents only' : ''}...`);

for (const term of jobs) {
    if (rowsPushed >= rowCap || pastDeadline()) break;
    let url = buildUrl(term);
    let pushedForJob = 0;
    let sawAny = false;
    while (url && pushedForJob < perQuery && rowsPushed < rowCap && !pastDeadline()) {
        const json = await apiGet(url);
        if (json?.error) {
            await flushRow({ type: 'note', input: term, found: false, note: `search failed (${json.error}); not charged, try again later` }, false);
            break;
        }
        const results = json.results || [];
        if (results.length > 0) sawAny = true;
        for (const doc of results) {
            if (pushedForJob >= perQuery || rowsPushed >= rowCap || pastDeadline()) break;
            if (!doc.document_number || emitted.has(doc.document_number)) continue;
            if (newOnly && seen.has(doc.document_number)) { skippedSeen += 1; continue; }
            emitted.add(doc.document_number);
            seen.add(doc.document_number);
            await flushRow(toRow(doc, term), true);
            pushedForJob += 1;
        }
        url = json.next_page_url || null;
    }
    if (!sawAny && !pastDeadline()) {
        await flushRow({
            type: 'note', input: term ?? '(all documents)', found: false,
            note: newOnly ? 'no documents matched (or all already seen); not charged' : 'no documents matched these filters; not charged',
        }, false);
    }
}

if (newOnly) {
    // Keep the newest entries if the set ever outgrows the cap.
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} document number(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped this run).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
