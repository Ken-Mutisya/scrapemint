// Book Data Scraper: ISBN & Title Lookup
//
// Strategy
// --------
// Open Library search API (openlibrary.org/search.json, Internet Archive),
// keyless JSON, verified reachable from Apify DC IPs. Both modes use the same
// endpoint: ISBN mode queries q=isbn:<isbn> (limit 1, exact), search mode
// queries free text (limit maxResultsPerQuery). The search index returns
// work-level records with author names already resolved — one call per input,
// no follow-up author fetches.
//
// Small pool with spacing keeps request rates polite (Open Library asks for
// an identifying user agent and reasonable rates).
//
// Pay per event
// -------------
//   book_found per matched book row. ISBNs and searches that match nothing
//   are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const SEARCH_URL = 'https://openlibrary.org/search.json';
const FIELDS = 'key,title,author_name,first_publish_year,number_of_pages_median,publisher,subject,language,edition_count,ratings_average,ratings_count,cover_i,isbn';
const UA = 'scrapemint-book-data-scraper/0.1 (+https://apify.com; kennedymutisya@icloud.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const POOL_SIZE = 3;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { isbns = [], queries = [], maxResultsPerQuery = 1, maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);

// Check digits catch mistyped and mis-scanned numbers before they hit the
// API (and catch placeholder junk like 9999999999999 that exists in the
// catalogue attached to real books).
function isbnChecksumOk(clean) {
    if (clean.length === 10) {
        let sum = 0;
        for (let i = 0; i < 10; i += 1) sum += (clean[i].toUpperCase() === 'X' ? 10 : Number(clean[i])) * (10 - i);
        return sum % 11 === 0;
    }
    let sum = 0;
    for (let i = 0; i < 13; i += 1) sum += Number(clean[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
}

const jobs = [];
const seen = new Set();
for (const raw of asTokens(isbns)) {
    const clean = raw.replace(/[\s-]/g, '');
    if (!/^(\d{9}[\dXx]|\d{13})$/.test(clean)) {
        jobs.push({ mode: 'isbn', input: raw, error: 'not a valid ISBN-10 or ISBN-13' });
        continue;
    }
    if (!isbnChecksumOk(clean)) {
        jobs.push({ mode: 'isbn', input: raw, error: 'not a valid ISBN (check digit failed — probably a typo or bad scan)' });
        continue;
    }
    if (seen.has(`i:${clean}`)) continue;
    seen.add(`i:${clean}`);
    jobs.push({ mode: 'isbn', input: raw, isbn: clean });
}
for (const q of asTokens(queries)) {
    const key = `q:${q.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ mode: 'search', input: q });
}

const perQuery = Math.max(1, Math.min(20, Number(maxResultsPerQuery) || 1));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (jobs.length === 0) {
    log.warning('No ISBNs or searches given. Paste at least one ISBN or a title like "atomic habits".');
    await Actor.exit();
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
}

let rowsPushed = 0;
let chargeableRows = 0;
let found = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'book_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

function toRow(job, doc) {
    return {
        input: job.input,
        mode: job.mode,
        title: doc.title || null,
        authors: doc.author_name || [],
        firstPublishYear: doc.first_publish_year ?? null,
        pages: doc.number_of_pages_median ?? null,
        publishers: (doc.publisher || []).slice(0, 3),
        subjects: (doc.subject || []).slice(0, 8),
        languages: (doc.language || []).slice(0, 5),
        editionCount: doc.edition_count ?? null,
        rating: doc.ratings_average ? Number(doc.ratings_average.toFixed(2)) : null,
        ratingsCount: doc.ratings_count ?? null,
        isbns: job.isbn ? [job.isbn] : (doc.isbn || []).slice(0, 10),
        coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
        openLibraryUrl: doc.key ? `https://openlibrary.org${doc.key}` : null,
    };
}

log.info(`Looking up ${jobs.length} input(s) (${perQuery} match(es) per search)...`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= jobs.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const job = jobs[i];

        if (job.error) {
            await flushRow({ input: job.input, mode: job.mode, found: false, note: job.error }, false);
            continue;
        }

        const q = job.mode === 'isbn' ? `isbn:${job.isbn}` : job.input;
        const limit = job.mode === 'isbn' ? 1 : perQuery;
        const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
        const { status, json, error } = await fetchJson(url);

        if (status !== 200 || !json) {
            await flushRow({ input: job.input, mode: job.mode, found: false, note: `could not look up (${error || `HTTP ${status}`}); not charged, try again later` }, false);
            log.warning(`${job.input}: HTTP ${status} ${error || ''}`);
            continue;
        }

        let docs = json.docs || [];
        // Open Library's q=isbn: can fuzzy-match unrelated books for numbers it
        // does not have; only accept a doc that really carries the queried ISBN.
        if (job.mode === 'isbn') docs = docs.filter((doc) => (doc.isbn || []).includes(job.isbn));
        if (docs.length === 0) {
            await flushRow({ input: job.input, mode: job.mode, found: false, note: 'no book found' }, false);
            continue;
        }
        for (const doc of docs) {
            if (rowsPushed >= cap) { stopped = true; break; }
            found += 1;
            await flushRow({ ...toRow(job, doc), found: true }, true);
        }
        await sleep(150);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, jobs.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} book(s) found `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; not-found and bad input are free).`);
await Actor.exit();
