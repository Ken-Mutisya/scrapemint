// Reddit Lead Monitor
// Polls subreddits and/or runs global search queries against Reddit's public
// Atom RSS feeds, filters by keyword/age, dedupes post IDs across runs via the
// KV store, and pushes only new matches to the dataset.
//
// Endpoints used (RSS, not JSON):
//   https://www.reddit.com/r/{sub}/{sort}.rss?limit=100&after={t3_id}
//   https://www.reddit.com/search.rss?q={q}&sort={sort}&t={t}&type=link&limit=100
// Reddit now returns HTTP 403 on the .json listing/search endpoints (it gates
// those behind OAuth), but the equivalent .rss feeds still serve publicly.
// RSS carries title, author, permalink, subreddit, body and timestamp, but NOT
// vote or comment counts, so minUpvotes/minComments cannot be enforced here.
//
// Free tier: first 2 posts per run are free. After that charge per post.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

const FREE_TIER_POSTS = 2;
// Reddit asks scripts to identify themselves with a descriptive UA.
const USER_AGENT = 'reddit-lead-monitor/0.2 (by scrapemint; Apify actor)';
const REDDIT_HOST = 'https://www.reddit.com';

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

// RSS does not expose vote/comment counts; these filters cannot be honoured.
if (minUpvotes > 0 || minComments > 0) {
    log.warning('minUpvotes/minComments are ignored: Reddit RSS does not expose vote or comment counts.');
}

// Reddit blocks Apify datacenter IPs. Default to RESIDENTIAL proxy when no
// explicit proxyConfiguration is passed. If APIFY_PROXY_PASSWORD is unset
// (local dev), fall back to direct fetch.
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

        let xml;
        try {
            const res = await gotScraping({
                url,
                // Reddit's RSS endpoint returns 403 to got-scraping's default
                // browser fingerprint (generated headers + HTTP/2). Disabling
                // both makes it behave like a plain HTTP client, which Reddit
                // serves. Plain curl/got get 200; the browser fingerprint 403s.
                useHeaderGenerator: false,
                http2: false,
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/atom+xml, application/xml, text/xml' },
                proxyUrl,
                throwHttpErrors: false,
                timeout: { request: 30_000 },
                responseType: 'text',
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
            xml = res.body;
        } catch (err) {
            log.warning(`${label} fetch failed: ${err?.message}`);
            break;
        }

        const entries = parseAtom(xml);
        if (entries.length === 0) break;

        let lastId = null;
        for (const entry of entries) {
            if (totalPushed >= maxPostsTotal) break;
            if (pulled >= maxPostsPerSource) break;
            // Only Reddit posts (t3_*). Search RSS also returns community (t5_)
            // and user results, which carry no t3_ id and no post body.
            if (!entry.fullId || !entry.fullId.startsWith('t3_')) continue;

            lastId = entry.fullId;
            pulled += 1;
            totalSeen += 1;

            if (dedupe && seen.has(entry.fullId)) {
                deduped += 1;
                continue;
            }

            const createdMs = entry.createdMs;
            if (ageCutoffMs !== null && createdMs && createdMs < ageCutoffMs) {
                filteredOut += 1;
                continue;
            }
            if (!includeNSFW && entry.over18) {
                filteredOut += 1;
                continue;
            }

            const title = entry.title || '';
            const selftext = entry.selftext || '';
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
                postId: entry.postId,
                fullId: entry.fullId,
                subreddit: entry.subreddit,
                subredditPrefixed: entry.subreddit ? `r/${entry.subreddit}` : null,
                title,
                selftext,
                author: entry.author,
                authorFullname: null,
                url: entry.permalink,
                permalink: entry.permalink,
                domain: null,
                flair: null,
                // Vote/comment metrics are not available via RSS.
                upvotes: null,
                downvotes: null,
                upvoteRatio: null,
                numComments: null,
                score: null,
                createdAt: createdMs ? new Date(createdMs).toISOString() : null,
                isSelf: !!selftext,
                isVideo: false,
                over18: !!entry.over18,
                spoiler: false,
                locked: false,
                stickied: false,
                thumbnail: null,
                matchedKeywords,
                sourceKind: kind,
                sourceValue: value,
                scrapedAt: new Date().toISOString(),
            });

            newSeen.add(entry.fullId);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_POSTS) {
                await Actor.charge({ eventName: 'lead_match' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        // RSS pages by the last fullname. Stop if the feed did not advance.
        if (!lastId || lastId === after) break;
        after = lastId;
        await sleep(1200); // polite delay between pages
    }

    log.info(`${label}: pulled ${pulled} raw, pushed so far ${totalPushed}`);
}

function buildListingUrl({ kind, value, after }) {
    const params = new URLSearchParams({ limit: '100' });
    if (after) params.set('after', after);
    if (kind === 'subreddit') {
        const sort = ['new', 'hot', 'top', 'rising'].includes(sortBy) ? sortBy : 'new';
        if (sort === 'top') params.set('t', timeWindow);
        return `${REDDIT_HOST}/r/${encodeURIComponent(value)}/${sort}.rss?${params.toString()}`;
    }
    // search
    params.set('q', value);
    params.set('sort', ['new', 'hot', 'top', 'relevance', 'comments'].includes(sortBy) ? sortBy : 'new');
    params.set('t', timeWindow);
    params.set('type', 'link');
    return `${REDDIT_HOST}/search.rss?${params.toString()}`;
}

// Minimal Atom parser tailored to Reddit feeds. Avoids a heavyweight XML dep.
function parseAtom(xml) {
    if (typeof xml !== 'string' || !xml.includes('<entry')) return [];
    const out = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) !== null) {
        const e = m[1];
        const fullId = tag(e, 'id');
        const titleRaw = tag(e, 'title');
        const linkM = e.match(/<link[^>]*href="([^"]+)"/i);
        const permalink = linkM ? unescapeHtml(linkM[1]) : null;
        const authorBlock = e.match(/<author>([\s\S]*?)<\/author>/i);
        const authorName = authorBlock ? tag(authorBlock[1], 'name') : '';
        const published = tag(e, 'published') || tag(e, 'updated');
        const catM = e.match(/<category[^>]*term="([^"]*)"/i);
        const contentRaw = tag(e, 'content');
        const contentText = stripTags(unescapeHtml(contentRaw));

        // Derive subreddit from category term, else from the permalink path.
        let subreddit = catM ? catM[1] : null;
        if (!subreddit && permalink) {
            const sm = permalink.match(/\/r\/([^/]+)\//i);
            if (sm) subreddit = sm[1];
        }

        const createdMs = published ? Date.parse(published) : null;
        out.push({
            fullId: (fullId || '').trim(),
            postId: (fullId || '').replace(/^t3_/, '').trim() || null,
            title: unescapeHtml(titleRaw).trim(),
            author: (authorName || '').replace(/^\/u\//, '').trim() || null,
            permalink,
            subreddit,
            selftext: contentText.trim(),
            createdMs: Number.isFinite(createdMs) ? createdMs : null,
            over18: /\bnsfw\b/i.test(titleRaw) || /\bnsfw\b/i.test(contentRaw),
        });
    }
    return out;
}

function tag(s, name) {
    const m = s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? m[1] : '';
}

function stripTags(s) {
    return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Reddit double-escapes HTML inside <content> (e.g. &amp;#39; for an
// apostrophe), so decode in two passes to fully resolve entities.
function unescapeHtml(s) {
    let out = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    for (let i = 0; i < 2; i += 1) out = decodeEntities(out);
    return out;
}

function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

function safeCodePoint(cp) {
    try {
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
    } catch {
        return '';
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
