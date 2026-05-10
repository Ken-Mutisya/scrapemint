// LinkedIn Hashtag & Topic Post Tracker (No Cookies)
//
// Strategy
// --------
// LinkedIn's hashtag feed pages are gated to anonymous viewers. Two anonymous
// surfaces stay reachable:
//   1. /embed/feed/update/urn:li:activity:{id}/   public post embed (no auth)
//   2. /posts/{vanity}_{slug}-activity-{id}-{code}   public share page (no auth)
//
// We discover candidate /posts/ URLs by querying a search engine for the
// hashtag text inside the public share-page index, then load each match via
// the embed endpoint to extract author, body, posted date, and engagement.
// Each post is verified by matching the hashtag against the rendered body
// before being pushed.
//
// Pay-per-event:
//   post_row ($0.015) charged when a post row is pushed. First 3 posts per
//   run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_POSTS = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    hashtags = [],
    topicSlugs = [],
    maxPostsPerHashtag = 25,
    postedLimitDate = '',
    minReactions = 0,
    sortBy = 'engagement',
    searchDepth = 5,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const hashtagList = [];
const seenTagKey = new Set();
for (const raw of hashtags) {
    const v = typeof raw === 'string' ? raw : raw?.value || raw?.tag || '';
    const cleaned = String(v).trim().replace(/^#+/, '').toLowerCase();
    if (!cleaned) continue;
    if (!/^[a-z0-9_]+$/.test(cleaned)) continue;
    if (seenTagKey.has(`tag:${cleaned}`)) continue;
    seenTagKey.add(`tag:${cleaned}`);
    hashtagList.push({ kind: 'hashtag', tag: cleaned, key: `tag:${cleaned}` });
}

for (const raw of topicSlugs) {
    const v = typeof raw === 'string' ? raw : raw?.value || raw?.slug || '';
    const cleaned = String(v).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!cleaned) continue;
    if (!/^[a-z0-9-]+$/.test(cleaned)) continue;
    if (seenTagKey.has(`topic:${cleaned}`)) continue;
    seenTagKey.add(`topic:${cleaned}`);
    hashtagList.push({ kind: 'topic', tag: cleaned, key: `topic:${cleaned}` });
}

if (hashtagList.length === 0) {
    log.warning('No hashtags or topicSlugs provided. Examples: hashtags=["ai", "devrel"], topicSlugs=["artificial-intelligence"].');
    await Actor.exit();
}

const cutoffMs = parsePostedLimitDate(postedLimitDate);
const perTagCap = Number(maxPostsPerHashtag) > 0 ? Number(maxPostsPerHashtag) : Infinity;
const reactionFloor = Math.max(0, Number(minReactions) || 0);
const maxSearchPages = Math.max(1, Math.min(15, Number(searchDepth) || 5));
const sortMode = sortBy === 'recency' ? 'recency' : 'engagement';

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

// One queue of candidate post rows per tag, flushed once the crawler finishes
// so we can sort by engagement / recency before pushing.
const candidatesByTag = new Map();
hashtagList.forEach((t) => candidatesByTag.set(t.key, []));

const seenActivities = new Set();
const tagByKey = new Map(hashtagList.map((t) => [t.key, t]));

const initialRequests = [];
for (const tag of hashtagList) {
    initialRequests.push({
        url: buildSearchUrl(tag, 0),
        userData: { type: 'search', tagKey: tag.key, page: 0 },
        uniqueKey: `search:${tag.key}:0`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 6)),
    headless: true,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 8, maxErrorScore: 1 },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 45000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'post') return handlePost(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

let totalPushed = 0;
for (const tag of hashtagList) {
    const rows = candidatesByTag.get(tag.key) || [];
    const sorted = sortMode === 'recency'
        ? rows.slice().sort((a, b) => (b._sortKey.posted || 0) - (a._sortKey.posted || 0))
        : rows.slice().sort((a, b) => (b._sortKey.engagement || 0) - (a._sortKey.engagement || 0));

    const cap = perTagCap === Infinity ? sorted.length : Math.min(perTagCap, sorted.length);
    let rank = 0;
    for (const row of sorted.slice(0, cap)) {
        rank += 1;
        const { _sortKey, ...clean } = row;
        clean.rankInTag = rank;
        await Actor.pushData(clean);
        totalPushed += 1;
        if (totalPushed > FREE_TIER_POSTS) {
            Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
        }
    }
    log.info(`Tag ${tag.key}: ${rows.length} candidates -> ${Math.min(rank, cap)} pushed.`);
}

log.info(`Run complete. Tags: ${hashtagList.length}. Posts pushed: ${totalPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const tag = tagByKey.get(request.userData.tagKey);
    if (!tag) return;

    const candidates = candidatesByTag.get(tag.key);
    if (candidates && candidates.length >= perTagCap * 3 && perTagCap !== Infinity) {
        // Already collected 3x the cap. More candidates won't change the top set much.
        return;
    }

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/posts\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    for (const raw of links) {
        const cleaned = unwrapPostUrl(raw);
        const activityId = extractActivityId(cleaned);
        if (!activityId) continue;
        const dedupeKey = `${tag.key}:${activityId}`;
        if (seenActivities.has(dedupeKey)) continue;
        seenActivities.add(dedupeKey);
        queued += 1;

        await c.addRequests([{
            url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/`,
            userData: {
                type: 'post',
                tagKey: tag.key,
                activityId,
                shareUrl: cleaned,
            },
            uniqueKey: `post:${tag.key}:${activityId}`,
        }]);
    }

    log.info(`Search page ${request.userData.page} for ${tag.key}: ${links.length} raw links, ${queued} new posts queued.`);

    const nextPage = (request.userData.page || 0) + 1;
    if (queued > 0 && nextPage < maxSearchPages) {
        await c.addRequests([{
            url: buildSearchUrl(tag, nextPage),
            userData: { type: 'search', tagKey: tag.key, page: nextPage },
            uniqueKey: `search:${tag.key}:${nextPage}`,
        }]);
    }
}

async function handlePost({ page, request }) {
    const { tagKey, activityId, shareUrl } = request.userData;
    const tag = tagByKey.get(tagKey);
    if (!tag) return;

    try {
        await page.waitForSelector(
            'article, .feed-shared-update-v2, .commentary, .feed-shared-actor, .feed-shared-text',
            { timeout: 12000 },
        );
    } catch {}

    const data = await page.evaluate(() => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const attr = (el, a) => (el && el.getAttribute(a)) || null;

        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        const authorBlock = sel('.feed-shared-actor, .actor');
        const authorName = text(sel('.feed-shared-actor__name, .actor-name, .feed-shared-actor__title', authorBlock || document))
            || text(sel('h3 a span[dir="ltr"]'));
        const authorLinkEl = sel('a.feed-shared-actor__container-link, a.actor__container-link, .feed-shared-actor a[href*="/in/"], .feed-shared-actor a[href*="/company/"]', document);
        const authorUrl = authorLinkEl?.href || null;
        const authorHeadline = text(sel('.feed-shared-actor__description, .actor-description, .feed-shared-actor__sub-description', authorBlock || document));

        const timeEl = sel('time, .feed-shared-actor__sub-description time, .feed-shared-actor__sub-description');
        const timeIso = attr(timeEl, 'datetime');
        const timeText = text(timeEl);

        const bodyEl = sel('.feed-shared-update-v2__description, .feed-shared-text, .commentary, .attributed-text-segment-list__container');
        const bodyText = text(bodyEl);
        const bodyHtml = bodyEl?.innerHTML || null;

        const ogDescription = meta('og:description');
        const ogImage = meta('og:image');

        const images = all('.feed-shared-image img, .ivm-view-attr__img--centered, .update-components-image img')
            .map((img) => img.getAttribute('data-delivered-src') || img.src)
            .filter(Boolean);

        const videoEl = sel('video');
        const videoUrl = videoEl ? (videoEl.getAttribute('src') || videoEl.querySelector('source')?.getAttribute('src') || null) : null;
        const videoPoster = videoEl?.getAttribute('poster') || null;

        const articleEl = sel('a.feed-shared-article__meta-link, .feed-shared-article a');
        const articleUrl = articleEl?.href || null;
        const articleTitle = text(sel('.feed-shared-article__title'));

        const reactions = text(sel('.social-counts-reactions__count, .social-details-social-counts__reactions-count, [data-test-id="social-counts-reactions"]'));
        const comments = text(sel('.social-counts-comments, .social-details-social-counts__comments, [data-test-id="social-counts-comments"]'));
        const reposts = text(sel('.social-counts-shares, .social-details-social-counts__shares, [data-test-id="social-counts-reposts"]'));

        const hashtagLinks = all('a[href*="/feed/hashtag/"]')
            .map((a) => {
                const m = a.href.match(/\/feed\/hashtag\/(?:\?keywords=)?([^/?&]+)/i);
                return m ? decodeURIComponent(m[1]).toLowerCase() : null;
            })
            .filter(Boolean);

        return {
            authorName,
            authorUrl,
            authorHeadline,
            timeIso,
            timeText,
            bodyText,
            bodyHtml,
            ogDescription,
            ogImage,
            images,
            videoUrl,
            videoPoster,
            articleUrl,
            articleTitle,
            reactionsText: reactions,
            commentsText: comments,
            repostsText: reposts,
            hashtagLinks,
        };
    });

    const bodyForMatch = `${data.bodyText || ''} ${data.ogDescription || ''}`.toLowerCase();
    const renderedTags = new Set([
        ...(data.hashtagLinks || []),
        ...extractHashtagsFromText(bodyForMatch),
    ]);

    const expectedTag = tag.kind === 'hashtag' ? tag.tag : tag.tag.replace(/-/g, '');
    const matched = tag.kind === 'hashtag'
        ? renderedTags.has(tag.tag) || bodyForMatch.includes(`#${tag.tag}`)
        : bodyForMatch.includes(tag.tag.replace(/-/g, ' ')) || renderedTags.has(expectedTag);

    if (!matched) {
        log.info(`Skipping ${activityId}: post body does not contain ${tag.key}.`);
        return;
    }

    const postedAtMs = parseTimeText(data.timeIso || data.timeText, activityId);
    if (cutoffMs && postedAtMs && postedAtMs < cutoffMs) {
        log.info(`Skipping ${activityId}: posted ${new Date(postedAtMs).toISOString()} before cutoff.`);
        return;
    }

    const reactions = parseCount(data.reactionsText) || 0;
    const comments = parseCount(data.commentsText) || 0;
    const reposts = parseCount(data.repostsText) || 0;
    const totalEngagement = reactions + comments + reposts;

    if (reactionFloor && reactions < reactionFloor) {
        log.info(`Skipping ${activityId}: ${reactions} reactions below floor ${reactionFloor}.`);
        return;
    }

    const row = {
        id: activityId,
        urn: `urn:li:activity:${activityId}`,
        url: shareUrl || `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
        embedUrl: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/`,
        matchedVia: {
            kind: tag.kind,
            value: tag.tag,
        },
        hashtags: [...renderedTags].sort(),
        author: {
            name: data.authorName || null,
            url: cleanLinkedInUrl(data.authorUrl),
            headline: data.authorHeadline || null,
            kind: inferAuthorKind(data.authorUrl),
        },
        text: data.bodyText || data.ogDescription || null,
        textHtml: data.bodyHtml || null,
        postedAt: postedAtMs ? new Date(postedAtMs).toISOString() : null,
        postedText: data.timeText || null,
        engagement: {
            reactions,
            comments,
            reposts,
            total: totalEngagement,
        },
        media: {
            images: dedupe(data.images),
            videoUrl: data.videoUrl,
            videoPoster: data.videoPoster,
            articleUrl: data.articleUrl,
            articleTitle: data.articleTitle || null,
            ogImage: data.ogImage,
        },
        scrapedAt: new Date().toISOString(),
        _sortKey: {
            engagement: totalEngagement,
            posted: postedAtMs || 0,
        },
    };

    const bucket = candidatesByTag.get(tag.key);
    if (bucket) bucket.push(row);
    log.info(`Collected post ${activityId} for ${tag.key}: reactions=${reactions}, comments=${comments}, total=${totalEngagement}.`);
}

// ---------- URL & search helpers ----------

function buildSearchUrl(tag, pageIndex) {
    const q = tag.kind === 'hashtag'
        ? `site:linkedin.com/posts/ "#${tag.tag}"`
        : `site:linkedin.com/posts/ "${tag.tag.replace(/-/g, ' ')}"`;
    const offset = pageIndex * 20;
    const params = new URLSearchParams({ q, source: 'web' });
    if (offset > 0) params.set('offset', String(offset));
    return `https://search.brave.com/search?${params.toString()}`;
}

function unwrapPostUrl(href) {
    if (!href) return href;
    let url = href;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (/bing\.com$/.test(host)) {
            const real = u.searchParams.get('u') || u.searchParams.get('r');
            if (real) {
                if (real.startsWith('a1')) {
                    try { url = Buffer.from(real.slice(2), 'base64').toString('utf8'); }
                    catch { url = real; }
                } else url = real;
            }
        } else if (/google\.com$/.test(host) && u.pathname.startsWith('/url')) {
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) url = real;
        } else if (/duckduckgo\.com$/.test(host) && u.pathname === '/l/') {
            const real = u.searchParams.get('uddg');
            if (real) url = decodeURIComponent(real);
        }
    } catch {}

    try {
        const u = new URL(url);
        if (/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
            if (u.pathname.startsWith('/login') || u.pathname.startsWith('/signup') || u.pathname.startsWith('/uas/')) {
                const inner = u.searchParams.get('session_redirect') || u.searchParams.get('redirect');
                if (inner) url = decodeURIComponent(inner);
            }
        }
    } catch {}

    return url;
}

function extractActivityId(url) {
    if (!url) return null;
    const m1 = url.match(/-activity-(\d{15,25})-/);
    if (m1) return m1[1];
    const m2 = url.match(/urn(?::|%3A)li(?::|%3A)activity(?::|%3A)(\d{15,25})/i);
    if (m2) return m2[1];
    return null;
}

function cleanLinkedInUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return href;
        return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return href; }
}

function inferAuthorKind(href) {
    if (!href) return 'unknown';
    if (/\/in\//i.test(href)) return 'person';
    if (/\/company\//i.test(href)) return 'company';
    if (/\/school\//i.test(href)) return 'school';
    if (/\/showcase\//i.test(href)) return 'showcase';
    return 'unknown';
}

function extractHashtagsFromText(text) {
    if (!text) return [];
    const out = [];
    const re = /#([a-z0-9_]{2,80})/gi;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
    return out;
}

// ---------- Parsing helpers ----------

function parseCount(text) {
    if (!text) return null;
    const t = text.replace(/,/g, '').toLowerCase().trim();
    const m = t.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}

function parsePostedLimitDate(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (/^\d{10,}$/.test(s)) {
        const n = Number(s);
        return s.length === 10 ? n * 1000 : n;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? 0 : t;
}

function parseTimeText(input, activityId) {
    if (!input) return activityIdToMs(activityId);
    if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
        const t = Date.parse(input);
        if (!Number.isNaN(t)) return t;
    }
    const txt = String(input).toLowerCase();
    const m = txt.match(/(\d+)\s*(second|minute|hour|day|week|month|year|s|m|h|d|w|mo|y)s?\s*(?:ago)?/);
    if (m) {
        const n = parseInt(m[1], 10);
        const unit = m[2];
        const now = Date.now();
        const factor =
            unit.startsWith('s') ? 1000 :
            unit === 'm' || unit === 'minute' ? 60 * 1000 :
            unit === 'h' || unit === 'hour' ? 3600 * 1000 :
            unit === 'd' || unit === 'day' ? 86400 * 1000 :
            unit === 'w' || unit === 'week' ? 7 * 86400 * 1000 :
            unit === 'mo' || unit === 'month' ? 30 * 86400 * 1000 :
            unit === 'y' || unit === 'year' ? 365 * 86400 * 1000 : 0;
        if (factor > 0) return now - n * factor;
    }
    return activityIdToMs(activityId);
}

// LinkedIn activity ids embed a millisecond timestamp in their top 41 bits.
function activityIdToMs(activityId) {
    if (!activityId) return null;
    try {
        const big = BigInt(activityId);
        const ms = Number(big >> 22n);
        if (ms > 1262304000000 && ms < 4102444800000) return ms;
    } catch {}
    return null;
}

function dedupe(arr) {
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.filter(Boolean))];
}
