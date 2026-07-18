// Hacker News Scraper: Stories, Comments & Search
//
// Strategy
// --------
// Algolia Hacker News Search API (hn.algolia.com/api/v1), keyless JSON.
//   /search          relevance-ranked
//   /search_by_date  newest first
// Filters map to Algolia params:
//   tags          story | comment, plus front_page/ask_hn/show_hn/poll and
//                 author_<name> (comma = AND)
//   numericFilters points>, num_comments>, created_at_i>  (comma = AND)
// Each query is one search, paged (hitsPerPage 100) until maxPerQuery. With
// no query, a category/author browse runs on the filters alone.
//
// Distinct from our HN lead actors (who-is-hiring company leads and the
// keyword lead-feed monitor): this is a general story/comment scraper with
// points, comment counts and full text.
//
// Pay per event
// -------------
//   item_row per story or comment. Empty searches are free note rows.
//   First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://hn.algolia.com/api/v1';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';
const USER_URL = 'https://news.ycombinator.com/user?id=';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;
const SPACING_MS = 200;
const TEXT_CAP = 5000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [], contentType = 'stories', category = 'any', author = '',
    minPoints = 0, minComments = 0, sinceDays = 0, sortBy = 'relevance',
    maxPerQuery = 50, maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const queryList = [...new Set(asTokens(queries))];
const ctype = ['stories', 'comments', 'all'].includes(contentType) ? contentType : 'stories';
const cat = ['front_page', 'ask_hn', 'show_hn', 'poll'].includes(category) ? category : 'any';
const authorName = String(author || '').trim().replace(/^@/, '');
const minPts = clampNum(minPoints, 0, 0, 100000);
const minCmt = clampNum(minComments, 0, 0, 100000);
const sinceDaysN = clampNum(sinceDays, 0, 0, 7300);
const perQuery = clampNum(maxPerQuery, 50, 1, 1000);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);
const endpoint = sortBy === 'newest' ? 'search_by_date' : 'search';

if (queryList.length === 0 && cat === 'any' && !authorName) {
    log.warning('Nothing to fetch. Add a search term, pick a category (e.g. front page), or set an author.');
    await Actor.exit();
}

function tagString() {
    const parts = [];
    if (ctype === 'stories') parts.push('story');
    else if (ctype === 'comments') parts.push('comment');
    if (cat !== 'any' && ctype !== 'comments') parts.push(cat);
    if (authorName) parts.push(`author_${authorName}`);
    return parts.join(',');
}
function numericFilters() {
    const f = [];
    if (minPts > 0) f.push(`points>${minPts - 1}`);
    if (minCmt > 0) f.push(`num_comments>${minCmt - 1}`);
    if (sinceDaysN > 0) f.push(`created_at_i>${Math.floor(Date.now() / 1000) - sinceDaysN * 86400}`);
    return f.join(',');
}

async function apiGet(query, page) {
    const usp = new URLSearchParams({ hitsPerPage: String(PAGE_SIZE), page: String(page) });
    if (query) usp.set('query', query);
    const tags = tagString();
    if (tags) usp.set('tags', tags);
    const nf = numericFilters();
    if (nf) usp.set('numericFilters', nf);
    const url = `${BASE}/${endpoint}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Hacker News Scraper (admin@scrapemint.com)' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
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
            await Actor.charge({ eventName: 'item_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const stripHtml = (s) => (s == null ? null : String(s).replace(/<[^>]+>/g, ' ').replace(/&#x2F;/g, '/').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim().slice(0, TEXT_CAP) || null);

function toRow(h) {
    const isComment = (h._tags || []).includes('comment') || (h.comment_text != null && h.title == null);
    if (isComment) {
        return {
            type: 'comment',
            id: h.objectID,
            text: stripHtml(h.comment_text),
            author: h.author || null,
            createdAt: h.created_at || null,
            storyId: h.story_id ?? null,
            storyTitle: h.story_title || null,
            storyUrl: h.story_url || null,
            parentId: h.parent_id ?? null,
            hnUrl: `${ITEM_URL}${h.objectID}`,
            authorUrl: h.author ? `${USER_URL}${h.author}` : null,
        };
    }
    return {
        type: 'story',
        id: h.objectID,
        title: h.title || null,
        url: h.url || `${ITEM_URL}${h.objectID}`,
        externalUrl: h.url || null,
        author: h.author || null,
        points: h.points ?? null,
        numComments: h.num_comments ?? null,
        createdAt: h.created_at || null,
        text: stripHtml(h.story_text),
        tags: (h._tags || []).filter((t) => !t.startsWith('author_')),
        hnUrl: `${ITEM_URL}${h.objectID}`,
        authorUrl: h.author ? `${USER_URL}${h.author}` : null,
    };
}

const jobs = queryList.length > 0 ? queryList : [null];
const label = (q) => q || `${cat !== 'any' ? cat : 'browse'}${authorName ? ` by ${authorName}` : ''}`;

log.info(`Fetching ${ctype}${cat !== 'any' ? ` (${cat})` : ''} for ${queryList.length || 'no'} search(es)`
    + `${authorName ? `, author ${authorName}` : ''}${minPts ? `, points>=${minPts}` : ''}, sort ${sortBy}...`);

for (const q of jobs) {
    if (shouldStop()) break;
    let emitted = 0;
    let page = 0;
    let nbPages = 1;
    let failed = null;
    let sawAny = false;
    const seen = new Set();
    while (emitted < perQuery && page < nbPages && !shouldStop()) {
        const json = await apiGet(q, page);
        if (json?.error) { failed = json.error; break; }
        nbPages = json.nbPages || 1;
        const hits = json.hits || [];
        if (hits.length > 0) sawAny = true;
        for (const h of hits) {
            if (emitted >= perQuery || shouldStop()) break;
            if (!h.objectID || seen.has(h.objectID)) continue;
            seen.add(h.objectID);
            await flushRow(toRow(h), true);
            emitted += 1;
        }
        page += 1;
        if (hits.length === 0) break;
    }
    if (failed && emitted === 0) {
        await flushRow({ type: 'note', input: label(q), found: false, note: `search failed (${failed}); not charged, try again later` }, false);
    } else if (!sawAny) {
        await flushRow({ type: 'note', input: label(q), found: false, note: 'no Hacker News items matched this search and filters; not charged' }, false);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
