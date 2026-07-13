// Wikipedia Article Data: Summary, Facts & Images
//
// Strategy
// --------
// Official MediaWiki API (<lang>.wikipedia.org/w/api.php), keyless JSON, no
// browser, no proxy. Distinct from our Wikipedia Trends actor: this returns
// article CONTENT and facts, not view counts.
//   - list=search resolves a keyword to article titles (optional path).
//   - action=query with prop=extracts|pageimages|coordinates|categories|
//     langlinks|pageprops|info returns everything in one call for up to 50
//     titles at a time. Missing titles come back flagged `missing`.
//
// One row per requested/found article. Missing articles are emitted free.
//
// Pay per event
// -------------
//   article per found article. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const TITLES_PER_QUERY = 50;
const FETCH_TIMEOUT_MS = 25000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    titles = [],
    search = '',
    searchLimit = 20,
    language = 'en',
    maxRows = 500,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const lang = String(language || 'en').trim().toLowerCase().replace(/[^a-z-]/g, '') || 'en';
const API = `https://${lang}.wikipedia.org/w/api.php`;
const titleTokens = asTokens(titles);
const kw = String(search || '').trim();
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

if (titleTokens.length === 0 && !kw) {
    log.warning('Nothing to do. Add article titles, or a keyword to search for.');
    await Actor.exit();
}

async function apiGet(params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-wikipedia-article-data/0.1 (+https://apify.com)', accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function searchTitles(query, limit) {
    const out = [];
    let sroffset = 0;
    while (out.length < limit && !pastDeadline()) {
        const j = await apiGet({
            action: 'query', list: 'search', srsearch: query,
            srlimit: String(Math.min(50, limit - out.length)), sroffset: String(sroffset), srinfo: '',
        });
        const hits = j?.query?.search || [];
        for (const h of hits) out.push(h.title);
        if (hits.length === 0 || !j?.continue) break;
        sroffset = j.continue.sroffset;
    }
    return out.slice(0, limit);
}

function toRow(p) {
    if (p.missing || p.pageid == null) {
        return { title: p.title || null, found: false };
    }
    const coord = Array.isArray(p.coordinates) ? p.coordinates[0] : null;
    return {
        title: p.title,
        found: true,
        pageId: p.pageid,
        description: p.pageprops?.['wikibase-shortdesc'] || p.description || null,
        summary: (p.extract || '').trim() || null,
        thumbnail: p.thumbnail?.source || null,
        latitude: coord?.lat ?? null,
        longitude: coord?.lon ?? null,
        categories: (p.categories || []).map((c) => String(c.title || '').replace(/^Category:/, '')).slice(0, 50),
        languageCount: Array.isArray(p.langlinks) ? p.langlinks.length : 0,
        wikidataId: p.pageprops?.wikibase_item || null,
        pageLengthBytes: p.length ?? null,
        lastEdited: p.touched || null,
        url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title || '').replace(/ /g, '_'))}`,
        language: lang,
    };
}

async function fetchArticles(batch) {
    const j = await apiGet({
        action: 'query',
        titles: batch.join('|'),
        prop: 'extracts|pageimages|coordinates|categories|langlinks|pageprops|info',
        exintro: '1', explaintext: '1', exsentences: '5',
        piprop: 'thumbnail', pithumbsize: '320',
        cllimit: '500', clshow: '!hidden', lllimit: '500', inprop: 'url',
    });
    return j?.query?.pages || [];
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!row.found) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'article' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

let wanted = titleTokens;
if (wanted.length === 0) {
    log.info(`Searching ${lang}.wikipedia.org for "${kw}"...`);
    try {
        wanted = await searchTitles(kw, Math.max(1, Math.min(HARD_CAP, Number(searchLimit) || 20)));
    } catch (err) {
        log.warning(`Search failed: ${err?.message}`);
        wanted = [];
    }
    log.info(`Search returned ${wanted.length} article(s).`);
}
wanted = [...new Set(wanted)].slice(0, cap);

if (wanted.length === 0) {
    log.warning('No articles to fetch.');
    await Actor.exit();
}

log.info(`Fetching data for ${wanted.length} article(s) from ${lang}.wikipedia.org...`);

outer:
for (let i = 0; i < wanted.length; i += TITLES_PER_QUERY) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    const batch = wanted.slice(i, i + TITLES_PER_QUERY);
    let pages;
    try {
        pages = await fetchArticles(batch);
    } catch (err) {
        log.warning(`Batch at ${i} failed: ${err?.message}`);
        continue;
    }
    // Preserve request order where possible.
    const byTitle = new Map(pages.map((p) => [String(p.title || '').toLowerCase(), p]));
    for (const t of batch) {
        if (rowsPushed >= cap) break outer;
        const p = byTitle.get(t.toLowerCase());
        await flushRow(p ? toRow(p) : { title: t, found: false });
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; missing articles free).`);
await Actor.exit();
