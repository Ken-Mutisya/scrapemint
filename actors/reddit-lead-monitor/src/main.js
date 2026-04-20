// Reddit Lead Monitor
// Polls subreddits and/or runs global search queries against Reddit's public
// JSON listing endpoints, filters by keyword/upvotes/age, dedupes post IDs
// across runs via the KV store, and pushes only new matches to the dataset.
//
// Endpoints used:
//   https://www.reddit.com/r/{sub}/{sort}.json?limit=100&after={t3_id}
//   https://www.reddit.com/search.json?q={q}&sort={sort}&t={t}&limit=100
// Both are the same endpoints Reddit's own web UI hits. No auth, no OAuth.
//
// Free tier: first 50 posts per run are free. After that charge per post.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

const FREE_TIER_POSTS = 50;
// Reddit now blocks browser-style UAs on www.reddit.com JSON. old.reddit.com
// still serves JSON directly when you send a descriptive, non-browser UA
// (Reddit's stated policy is that scripts identify themselves clearly).
const USER_AGENT = 'reddit-lead-monitor/0.1 (by scrapemint; Apify actor)';
const REDDIT_HOST = 'https://old.reddit.com';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    subreddits = [],
    searchQueries = [],
    keywords = [],
    sortBy = 'new',
    timeWindow = 'day',
    maxPostsPerSource = 100,
    maxAgeHours = 24,
    minUpvotes = 0,
    minComments = 0,
    includeNSFW = false,
    dedupe = true,
    maxPostsTotal = 200,
    proxyConfiguration: proxyInput,
} = input;

const subs = (Array.isArray(subreddits) ? subreddits : [])
    .map((s) => String(s).trim().replace(/^r\//i, ''))
    .filter(Boolean);

const queries = (Array.isArray(searchQueries) ? searchQueries : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

if (subs.length === 0 && queries.length === 0) {
    throw new Error('Provide at least one subreddit in subreddits or one query in searchQueries.');
}

const kwList = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

// Reddit blocks Apify datacenter IPs with 403. Default to RESIDENTIAL proxy
// when no explicit proxyConfiguration is passed. If APIFY_PROXY_PASSWORD is
// unset (local dev), fall back to direct fetch.
const effectiveProxyInput = proxyInput ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
let proxyConfiguration = null;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(effectiveProxyInput);
} catch (err) {
    log.warning(`Proxy unavailable, falling back to direct fetch: ${err?.message}`);
}
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
if (proxyUrl) log.info('Routing Reddit requests through Apify proxy.');

// Use a NAMED store so SEEN_IDS persists across runs of this actor.
// Default unnamed stores are scoped to a single run on the Apify platform.
const store = await Actor.openKeyValueStore('reddit-lead-monitor-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const ageCutoffMs = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600 * 1000 : null;

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

for (const sub of subs) {
    if (totalPushed >= maxPostsTotal) break;
    await harvestSource({ kind: 'subreddit', value: sub });
}
for (const q of queries) {
    if (totalPushed >= maxPostsTotal) break;
    await harvestSource({ kind: 'search', value: q });
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Actor.exit();

// ---- helpers ----

async function harvestSource({ kind, value }) {
    const label = kind === 'subreddit' ? `r/${value}` : `search:${value}`;
    let after = null;
    let pulled = 0;

    while (pulled < maxPostsPerSource && totalPushed < maxPostsTotal) {
        const url = buildListingUrl({ kind, value, after });
        log.info(`Fetching ${label} after=${after ?? 'null'}`);

        let json;
        try {
            const res = await gotScraping({
                url,
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
                proxyUrl,
                throwHttpErrors: false,
                timeout: { request: 30_000 },
                responseType: 'json',
            });
            if (res.statusCode === 429) {
                log.warning(`${label} rate limited (429). Waiting 5s.`);
                await sleep(5000);
                continue;
            }
            if (res.statusCode !== 200) {
                log.warning(`${label} HTTP ${res.statusCode}`);
                break;
            }
            json = res.body;
        } catch (err) {
            log.warning(`${label} fetch failed: ${err?.message}`);
            break;
        }

        const children = json?.data?.children;
        if (!Array.isArray(children) || children.length === 0) break;

        for (const child of children) {
            if (totalPushed >= maxPostsTotal) break;
            if (pulled >= maxPostsPerSource) break;
            const raw = child?.data;
            if (!raw?.id) continue;

            pulled += 1;
            totalSeen += 1;

            const fullId = raw.name || `t3_${raw.id}`;
            if (dedupe && seen.has(fullId)) {
                deduped += 1;
                continue;
            }

            if (!includeNSFW && raw.over_18) {
                filteredOut += 1;
                continue;
            }
            if (minUpvotes > 0 && (raw.ups || 0) < minUpvotes) {
                filteredOut += 1;
                continue;
            }
            if (minComments > 0 && (raw.num_comments || 0) < minComments) {
                filteredOut += 1;
                continue;
            }
            const createdMs = (raw.created_utc || 0) * 1000;
            if (ageCutoffMs !== null && createdMs < ageCutoffMs) {
                filteredOut += 1;
                continue;
            }

            const title = raw.title || '';
            const selftext = raw.selftext || '';
            let matchedKeywords = [];
            if (kwList.length > 0) {
                const hay = `${title}\n${selftext}`.toLowerCase();
                matchedKeywords = kwList.filter((kw) => hay.includes(kw));
                if (matchedKeywords.length === 0) {
                    filteredOut += 1;
                    continue;
                }
            }

            await Actor.pushData({
                postId: raw.id,
                fullId,
                subreddit: raw.subreddit,
                subredditPrefixed: raw.subreddit_name_prefixed,
                title,
                selftext,
                author: raw.author,
                authorFullname: raw.author_fullname ?? null,
                url: raw.url,
                permalink: raw.permalink ? `https://www.reddit.com${raw.permalink}` : null,
                domain: raw.domain ?? null,
                flair: raw.link_flair_text ?? null,
                upvotes: raw.ups ?? 0,
                downvotes: raw.downs ?? 0,
                upvoteRatio: raw.upvote_ratio ?? null,
                numComments: raw.num_comments ?? 0,
                score: raw.score ?? 0,
                createdAt: createdMs ? new Date(createdMs).toISOString() : null,
                isSelf: !!raw.is_self,
                isVideo: !!raw.is_video,
                over18: !!raw.over_18,
                spoiler: !!raw.spoiler,
                locked: !!raw.locked,
                stickied: !!raw.stickied,
                thumbnail: raw.thumbnail && raw.thumbnail.startsWith('http') ? raw.thumbnail : null,
                matchedKeywords,
                sourceKind: kind,
                sourceValue: value,
                scrapedAt: new Date().toISOString(),
            });

            newSeen.add(fullId);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_POSTS) {
                await Actor.charge({ eventName: 'post_extracted' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        after = json?.data?.after;
        if (!after) break;
        await sleep(1200); // polite delay between pages
    }

    log.info(`${label}: pulled ${pulled} raw, pushed so far ${totalPushed}`);
}

function buildListingUrl({ kind, value, after }) {
    const params = new URLSearchParams({ limit: '100', raw_json: '1' });
    if (after) params.set('after', after);
    if (kind === 'subreddit') {
        const sort = ['new', 'hot', 'top', 'rising'].includes(sortBy) ? sortBy : 'new';
        if (sort === 'top') params.set('t', timeWindow);
        return `${REDDIT_HOST}/r/${encodeURIComponent(value)}/${sort}.json?${params.toString()}`;
    }
    // search
    params.set('q', value);
    params.set('sort', ['new', 'hot', 'top', 'relevance', 'comments'].includes(sortBy) ? sortBy : 'new');
    params.set('t', timeWindow);
    params.set('type', 'link');
    return `${REDDIT_HOST}/search.json?${params.toString()}`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
