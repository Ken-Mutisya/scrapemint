// arXiv Papers Scraper: AI & Science Research Tracker
//
// Strategy
// --------
// Query arXiv's official open API (export.arxiv.org/api/query, Atom XML) by
// keyword, category, and author, paginate politely (the API asks for ~3s
// between requests), and push one normalized row per paper. The API is
// sanctioned for programmatic use: no key, no browser, no proxy, ever.
//
// Pay per event
// -------------
//   paper_row ($0.003) charged per paper pushed. Queries that match nothing
//   cost nothing. First 2 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { XMLParser } from 'fast-xml-parser';

const FREE_TIER_ROWS = 2;
const HARD_CAP_PAPERS = 1000;
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 30000;
const PAGE_DELAY_MS = 3100; // arXiv API politeness guidance
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 4000;
let lastFetchError = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    categories = ['cs.AI'],
    authors = [],
    dateFrom = '',
    sortBy = 'submittedDate',
    maxPapers = 25,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const keywords = asList(searchQueries);
const cats = asList(categories);
const auths = asList(authors);
const paperCap = Math.max(1, Math.min(HARD_CAP_PAPERS, Number(maxPapers) || 25));
const sort = ['submittedDate', 'lastUpdatedDate', 'relevance'].includes(sortBy) ? sortBy : 'submittedDate';
const dateFloor = dateFrom && /^\d{4}-\d{2}-\d{2}/.test(String(dateFrom).trim())
    ? Date.parse(String(dateFrom).trim()) : null;

if (!keywords.length && !cats.length && !auths.length) {
    log.warning('Provide at least one of "searchQueries", "categories", or "authors".');
    await Actor.exit();
}

// arXiv query grammar: field:"term", OR within a group, AND between groups.
const quote = (s) => `"${s.replace(/"/g, '')}"`;
const groups = [];
if (keywords.length) groups.push(`(${keywords.map((k) => `all:${quote(k)}`).join(' OR ')})`);
if (cats.length) groups.push(`(${cats.map((c) => `cat:${c}`).join(' OR ')})`);
if (auths.length) groups.push(`(${auths.map((a) => `au:${quote(a)}`).join(' OR ')})`);
const searchQuery = groups.join(' AND ');

const seenStore = dedupe ? await Actor.openKeyValueStore('arxiv-papers-seen') : null;
const seen = new Set();
if (seenStore) {
    for (const id of (await seenStore.getValue('seen-ids')) || []) seen.add(id);
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function fetchPage(start) {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}`
        + `&start=${start}&max_results=${Math.min(PAGE_SIZE, paperCap)}`
        + `&sortBy=${sort}&sortOrder=descending`;
    // arXiv rate-limits bursts with 429 and occasionally 503s under load. This
    // used to warn once and return null, so a single 429 on the FIRST page
    // ended the run with zero rows and a SUCCEEDED status -- the buyer got an
    // empty dataset and no reason. Found 2026-09-15 by the health check.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'ArxivPapersScraper/1.0 (+https://apify.com/scrapemint/arxiv-papers-scraper)' },
            });
            if (res.ok) return parser.parse(await res.text());

            const retryable = res.status === 429 || res.status >= 500;
            lastFetchError = `HTTP ${res.status}`;
            if (!retryable || attempt === MAX_ATTEMPTS - 1) {
                log.warning(`arXiv API HTTP ${res.status}${retryable ? ' after retries' : ''}`);
                return null;
            }
            // Honour Retry-After when arXiv sends it, otherwise back off.
            const hinted = Number(res.headers.get('retry-after'));
            const waitMs = Number.isFinite(hinted) && hinted > 0
                ? Math.min(hinted * 1000, 30000)
                : BACKOFF_BASE_MS * (2 ** attempt);
            log.warning(`arXiv API HTTP ${res.status}; waiting ${Math.round(waitMs / 1000)}s then retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
            await sleep(waitMs);
        } catch (err) {
            lastFetchError = err?.message ?? String(err);
            if (attempt === MAX_ATTEMPTS - 1) {
                log.warning(`arXiv API fetch failed after ${MAX_ATTEMPTS} attempts: ${lastFetchError}`);
                return null;
            }
            await sleep(BACKOFF_BASE_MS * (2 ** attempt));
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

const one = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;

function normalizeEntry(e) {
    const absUrl = clean(e.id);
    const arxivId = absUrl ? absUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '') : null;
    const links = one(e.link);
    const pdf = links.find((l) => l['@_title'] === 'pdf' || l['@_type'] === 'application/pdf');
    const doiLink = links.find((l) => l['@_title'] === 'doi');
    return {
        arxivId,
        url: absUrl,
        pdfUrl: pdf ? pdf['@_href'] : (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null),
        title: clean(e.title),
        abstract: clean(e.summary),
        authors: one(e.author).map((a) => clean(a?.name)).filter(Boolean),
        primaryCategory: e['arxiv:primary_category']?.['@_term'] || null,
        categories: one(e.category).map((c) => c['@_term']).filter(Boolean),
        published: clean(e.published),
        updated: clean(e.updated),
        doi: clean(e['arxiv:doi']) || (doiLink ? doiLink['@_href'] : null),
        comment: clean(e['arxiv:comment']),
        journalRef: clean(e['arxiv:journal_ref']),
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData({ ...row, searchQuery, scrapedAt: new Date().toISOString() });
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'paper_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Query: ${searchQuery} | sort ${sort} | up to ${paperCap} paper(s).`);

let start = 0;
let dateFloorHit = false;
while (rowsPushed < paperCap && !dateFloorHit) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const feed = (await fetchPage(start))?.feed;
    const entries = one(feed?.entry).filter((e) => e && e.id);
    if (!entries.length) break;
    for (const e of entries) {
        if (rowsPushed >= paperCap) break;
        const row = normalizeEntry(e);
        // With date sorts the feed is descending, so the first row past the
        // floor means everything after it is older too.
        if (dateFloor) {
            const ts = Date.parse((sort === 'lastUpdatedDate' ? row.updated : row.published) || '');
            if (Number.isFinite(ts) && ts < dateFloor) {
                if (sort !== 'relevance') { dateFloorHit = true; break; }
                continue;
            }
        }
        if (row.arxivId && seen.has(row.arxivId)) continue;
        if (row.arxivId) seen.add(row.arxivId);
        await flushRow(row);
    }
    start += entries.length;
    if (entries.length < Math.min(PAGE_SIZE, paperCap)) break;
    if (rowsPushed < paperCap && !dateFloorHit) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen].slice(-50000));
}

// A run that returns nothing must say why. Returning a bare empty dataset is
// indistinguishable from a broken actor, which is exactly how this one looked
// when arXiv rate-limited it. Note rows are never charged.
if (rowsPushed === 0) {
    await Actor.pushData({
        rowType: 'note',
        note: lastFetchError
            ? `arXiv did not answer (${lastFetchError}) after ${MAX_ATTEMPTS} attempts with backoff, so no papers could be read. This is arXiv rate-limiting or refusing the request, not an empty search. Nothing was charged; try again shortly.`
            : `No papers matched this search. Nothing was charged. Query: ${searchQuery}`,
        query: searchQuery,
        scrapedAt: new Date().toISOString(),
    });
}

log.info(`Done. ${rowsPushed} paper row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
