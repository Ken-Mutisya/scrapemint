// Hacker News Lead Monitor
// Polls HN firehose feeds (via the official Firebase API) and/or runs
// full text search queries (via the HN Algolia API), filters by keyword,
// score, comment count, and age, dedupes item IDs across runs via a named
// key value store, and pushes only new matches to the dataset.
//
// Endpoints:
//   https://hacker-news.firebaseio.com/v0/{feed}stories.json  -> up to 500 IDs
//   https://hacker-news.firebaseio.com/v0/item/{id}.json       -> one item
//   https://hn.algolia.com/api/v1/search_by_date?query={q}     -> search
// All three are public, no auth, no keys, no rate limits worth mentioning.
//
// Free tier: first 2 items per run are free. After that charge per item.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 2;
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

const FEED_ENDPOINTS = {
    new: `${FIREBASE}/newstories.json`,
    top: `${FIREBASE}/topstories.json`,
    best: `${FIREBASE}/beststories.json`,
    ask: `${FIREBASE}/askstories.json`,
    show: `${FIREBASE}/showstories.json`,
    jobs: `${FIREBASE}/jobstories.json`,
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    feeds = [],
    keywords = [],
    searchType = 'stories',
    sortBy = 'newest',
    maxAgeHours = 168,
    minScore = 0,
    minComments = 0,
    maxItemsPerSource = 100,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const queries = (Array.isArray(searchQueries) ? searchQueries : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

const feedList = (Array.isArray(feeds) ? feeds : [])
    .map((f) => String(f).trim().toLowerCase())
    .filter((f) => FEED_ENDPOINTS[f]);

if (queries.length === 0 && feedList.length === 0) {
    throw new Error('Provide at least one query in searchQueries or one feed in feeds.');
}

const kwList = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

// Named store so SEEN_IDS persists across runs.
const store = await Actor.openKeyValueStore('hn-lead-monitor-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const ageCutoffMs = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600 * 1000 : null;

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

for (const q of queries) {
    if (totalPushed >= maxItemsTotal) break;
    await harvestSearch(q);
}
for (const feed of feedList) {
    if (totalPushed >= maxItemsTotal) break;
    await harvestFeed(feed);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---- search (Algolia) ----

async function harvestSearch(query) {
    const endpoints = searchType === 'comments'
        ? ['search_by_date?tags=comment']
        : searchType === 'both'
            ? [sortBy === 'popularity' ? 'search?tags=story' : 'search_by_date?tags=story',
               sortBy === 'popularity' ? 'search?tags=comment' : 'search_by_date?tags=comment']
            : [sortBy === 'popularity' ? 'search?tags=story' : 'search_by_date?tags=story'];

    for (const endpoint of endpoints) {
        if (totalPushed >= maxItemsTotal) break;
        let page = 0;
        let pulled = 0;
        const perPage = Math.min(100, maxItemsPerSource);

        while (pulled < maxItemsPerSource && totalPushed < maxItemsTotal) {
            const url = `${ALGOLIA}/${endpoint}&query=${encodeURIComponent(query)}&hitsPerPage=${perPage}&page=${page}`;
            log.info(`Algolia search:"${query}" ep=${endpoint.split('?')[0]} page=${page}`);

            let json;
            try {
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) {
                    log.warning(`Algolia HTTP ${res.status}`);
                    break;
                }
                json = await res.json();
            } catch (err) {
                log.warning(`Algolia fetch failed: ${err?.message}`);
                break;
            }

            const hits = Array.isArray(json?.hits) ? json.hits : [];
            if (hits.length === 0) break;

            for (const hit of hits) {
                if (totalPushed >= maxItemsTotal) break;
                if (pulled >= maxItemsPerSource) break;
                pulled += 1;
                totalSeen += 1;
                await handleAlgoliaHit(hit, query);
            }

            page += 1;
            if (page >= (json.nbPages || 1)) break;
            await sleep(300);
        }
    }
}

async function handleAlgoliaHit(hit, query) {
    const id = hit.objectID;
    if (!id) return;
    if (dedupe && seen.has(id)) { deduped += 1; return; }

    const isComment = hit._tags?.includes('comment') || !!hit.comment_text;
    const createdMs = (hit.created_at_i || 0) * 1000;

    if (ageCutoffMs !== null && createdMs < ageCutoffMs) { filteredOut += 1; return; }
    if (!isComment) {
        if (minScore > 0 && (hit.points || 0) < minScore) { filteredOut += 1; return; }
        if (minComments > 0 && (hit.num_comments || 0) < minComments) { filteredOut += 1; return; }
    }

    const title = hit.title || hit.story_title || '';
    const text = hit.comment_text || hit.story_text || '';
    let matchedKeywords = [];
    if (kwList.length > 0) {
        const hay = `${title}\n${text}`.toLowerCase();
        matchedKeywords = kwList.filter((kw) => hay.includes(kw));
        if (matchedKeywords.length === 0) { filteredOut += 1; return; }
    }

    const permalink = `https://news.ycombinator.com/item?id=${id}`;

    await Actor.pushData({
        itemId: id,
        itemType: isComment ? 'comment' : 'story',
        title: title || null,
        text: stripHtml(text) || null,
        rawHtml: text || null,
        url: hit.url || null,
        permalink,
        author: hit.author || null,
        points: isComment ? null : (hit.points ?? 0),
        numComments: isComment ? null : (hit.num_comments ?? 0),
        parentId: hit.parent_id ?? null,
        storyId: hit.story_id ?? null,
        createdAt: createdMs ? new Date(createdMs).toISOString() : null,
        tags: Array.isArray(hit._tags) ? hit._tags : [],
        matchedKeywords,
        sourceKind: 'search',
        sourceValue: query,
        scrapedAt: new Date().toISOString(),
    });

    newSeen.add(id);
    totalPushed += 1;
    maybeCharge();
}

// ---- feeds (Firebase) ----

async function harvestFeed(feedName) {
    const url = FEED_ENDPOINTS[feedName];
    log.info(`Firebase feed:${feedName}`);

    let ids;
    try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
            log.warning(`feed ${feedName} HTTP ${res.status}`);
            return;
        }
        ids = await res.json();
    } catch (err) {
        log.warning(`feed ${feedName} failed: ${err?.message}`);
        return;
    }

    if (!Array.isArray(ids)) return;
    const slice = ids.slice(0, maxItemsPerSource);

    for (const id of slice) {
        if (totalPushed >= maxItemsTotal) break;
        totalSeen += 1;
        const strId = String(id);

        if (dedupe && seen.has(strId)) { deduped += 1; continue; }

        let item;
        try {
            const r = await fetch(`${FIREBASE}/item/${id}.json`, { headers: { 'Accept': 'application/json' } });
            if (!r.ok) continue;
            item = await r.json();
        } catch { continue; }

        if (!item || item.deleted || item.dead) { filteredOut += 1; continue; }

        const createdMs = (item.time || 0) * 1000;
        if (ageCutoffMs !== null && createdMs < ageCutoffMs) { filteredOut += 1; continue; }
        if (minScore > 0 && (item.score || 0) < minScore) { filteredOut += 1; continue; }
        if (minComments > 0 && (item.descendants || 0) < minComments) { filteredOut += 1; continue; }

        const title = item.title || '';
        const text = item.text || '';
        let matchedKeywords = [];
        if (kwList.length > 0) {
            const hay = `${title}\n${text}`.toLowerCase();
            matchedKeywords = kwList.filter((kw) => hay.includes(kw));
            if (matchedKeywords.length === 0) { filteredOut += 1; continue; }
        }

        await Actor.pushData({
            itemId: strId,
            itemType: item.type || 'story',
            title: title || null,
            text: stripHtml(text) || null,
            rawHtml: text || null,
            url: item.url || null,
            permalink: `https://news.ycombinator.com/item?id=${id}`,
            author: item.by || null,
            points: item.score ?? 0,
            numComments: item.descendants ?? 0,
            parentId: item.parent ?? null,
            storyId: null,
            createdAt: createdMs ? new Date(createdMs).toISOString() : null,
            tags: [item.type, feedName].filter(Boolean),
            matchedKeywords,
            sourceKind: 'feed',
            sourceValue: feedName,
            scrapedAt: new Date().toISOString(),
        });

        newSeen.add(strId);
        totalPushed += 1;
        maybeCharge();

        await sleep(50);
    }
}

// ---- helpers ----

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        __chargeJobs.push(Actor.charge({ eventName: 'lead_match' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }));
    }
}

function stripHtml(s) {
    if (!s) return s;
    return String(s)
        .replace(/<p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2F;/g, '/')
        .trim();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
