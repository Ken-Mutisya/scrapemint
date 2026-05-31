// LinkedIn Top Voice & Creator Engagement Ranker (No Cookies)
//
// Strategy
// --------
// Discovery: Brave Search SERP for `site:linkedin.com/posts/{handle}_` returns
// public post share URLs that contain the activity id.
// Fetch: each activity is loaded via the public embed endpoint
// `/embed/feed/update/urn:li:activity:{id}/`, which renders the full post card
// without auth and exposes the engagement counts.
// Rank: posts are filtered to the lookback window, then aggregated per creator
// into total reactions, avg reactions per post, posts-per-day, and the top
// post by engagement.
//
// Output: one row per creator. Posts are not pushed individually so the buyer
// is only charged once per ranked creator, not per post.
//
// Pay-per-event:
//   creator_ranked ($0.05) charged when a creator row is pushed.
//   First 3 creators per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_CREATORS = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    creatorUrls = [],
    lookbackDays = 30,
    maxPostsPerCreator = 30,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const creators = [];
for (const raw of creatorUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseCreatorUrl(String(v).trim());
    if (parsed && !creators.some((c) => c.key === parsed.key)) creators.push(parsed);
}

if (creators.length === 0) {
    log.warning('No valid LinkedIn creator URLs provided. Examples: https://www.linkedin.com/in/satyanadella/, https://www.linkedin.com/company/openai/');
    await Actor.exit();
}

const cutoffMs = Date.now() - (Math.max(1, Number(lookbackDays) || 30) * 86400000);
const perCreatorCap = Math.max(5, Math.min(200, Number(maxPostsPerCreator) || 30));

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const creatorByKey = new Map(creators.map((c) => [c.key, c]));
const postsByCreator = new Map(creators.map((c) => [c.key, []]));
const seenActivities = new Set();

const initialRequests = creators.map((c) => ({
    url: buildSearchUrl(c, 0),
    userData: { type: 'search', creatorKey: c.key, page: 0 },
    uniqueKey: `search:${c.key}:0`,
}));

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
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
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

// Aggregate and ship one row per creator.
const rows = [];
for (const creator of creators) {
    const posts = postsByCreator.get(creator.key) || [];
    const inWindow = posts.filter((p) => p.postedAtMs && p.postedAtMs >= cutoffMs);
    rows.push(buildCreatorRow(creator, inWindow, posts.length));
}

// Sort by engagementVelocity descending, then assign rank.
rows.sort((a, b) => (b.engagementVelocity || 0) - (a.engagementVelocity || 0));
let pushed = 0;
for (let i = 0; i < rows.length; i += 1) {
    rows[i].rank = i + 1;
    await Actor.pushData(rows[i]);
    pushed += 1;
    if (pushed > FREE_TIER_CREATORS) {
        Actor.charge({ eventName: 'creator_ranked' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Rank ${rows[i].rank}: ${rows[i].handle} - ${rows[i].postsInWindow} posts, ${rows[i].totalReactions} reactions, ${rows[i].avgReactionsPerPost} avg.`);
}

log.info(`Run complete. Creators: ${creators.length}. Rows pushed: ${pushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const creator = creatorByKey.get(request.userData.creatorKey);
    if (!creator) return;
    const have = (postsByCreator.get(creator.key) || []).length;
    if (have >= perCreatorCap) return;

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/posts\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    const remaining = perCreatorCap - have;

    for (const raw of links) {
        if (queued >= remaining) break;
        const cleaned = unwrapPostUrl(raw);
        const activityId = extractActivityId(cleaned);
        if (!activityId) continue;
        if (seenActivities.has(activityId)) continue;
        if (!postUrlMatchesCreator(cleaned, creator)) continue;

        seenActivities.add(activityId);
        queued += 1;

        await c.addRequests([{
            url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/`,
            userData: {
                type: 'post',
                creatorKey: creator.key,
                activityId,
                shareUrl: cleaned,
            },
            uniqueKey: `post:${activityId}`,
        }]);
    }

    log.info(`Search page ${request.userData.page} for ${creator.key}: ${links.length} raw links, ${queued} queued.`);

    const nextPage = (request.userData.page || 0) + 1;
    if (queued > 0 && nextPage < 6 && have + queued < perCreatorCap) {
        await c.addRequests([{
            url: buildSearchUrl(creator, nextPage),
            userData: { type: 'search', creatorKey: creator.key, page: nextPage },
            uniqueKey: `search:${creator.key}:${nextPage}`,
        }]);
    }
}

async function handlePost({ page, request }) {
    const { creatorKey, activityId, shareUrl } = request.userData;
    const creator = creatorByKey.get(creatorKey);
    if (!creator) return;

    try {
        await page.waitForSelector(
            'article, .feed-shared-update-v2, .commentary, .feed-shared-actor, .feed-shared-text',
            { timeout: 12000 },
        );
    } catch {}

    const data = await page.evaluate(() => {
        const sel = (s, root = document) => root.querySelector(s);
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const attr = (el, a) => (el && el.getAttribute(a)) || null;
        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        const authorBlock = sel('.feed-shared-actor, .actor');
        const authorName = text(sel('.feed-shared-actor__name, .actor-name, .feed-shared-actor__title', authorBlock || document));
        const authorHeadline = text(sel('.feed-shared-actor__description, .actor-description, .feed-shared-actor__sub-description', authorBlock || document));

        const timeEl = sel('time, .feed-shared-actor__sub-description time, .feed-shared-actor__sub-description');
        const timeIso = attr(timeEl, 'datetime');
        const timeText = text(timeEl);

        const bodyEl = sel('.feed-shared-update-v2__description, .feed-shared-text, .commentary, .attributed-text-segment-list__container');
        const bodyText = text(bodyEl);

        const reactions = text(sel('.social-counts-reactions__count, .social-details-social-counts__reactions-count, [data-test-id="social-counts-reactions"]'));
        const comments = text(sel('.social-counts-comments, .social-details-social-counts__comments, [data-test-id="social-counts-comments"]'));
        const reposts = text(sel('.social-counts-shares, .social-details-social-counts__shares, [data-test-id="social-counts-reposts"]'));

        const ogImage = meta('og:image');

        return {
            authorName,
            authorHeadline,
            timeIso,
            timeText,
            bodyText: bodyText || meta('og:description'),
            reactionsText: reactions,
            commentsText: comments,
            repostsText: reposts,
            ogImage,
        };
    });

    const postedAtMs = parseTimeText(data.timeIso || data.timeText, activityId);
    const reactions = parseCount(data.reactionsText) || 0;
    const comments = parseCount(data.commentsText) || 0;
    const reposts = parseCount(data.repostsText) || 0;
    const total = reactions + comments + reposts;

    const post = {
        activityId,
        shareUrl: shareUrl || `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
        postedAtMs,
        bodyText: data.bodyText || null,
        reactions,
        comments,
        reposts,
        total,
        authorName: data.authorName || null,
        authorHeadline: data.authorHeadline || null,
    };

    const arr = postsByCreator.get(creatorKey) || [];
    arr.push(post);
    postsByCreator.set(creatorKey, arr);
    log.info(`Post ${activityId} for ${creatorKey}: postedAtMs=${postedAtMs}, posted=${postedAtMs ? new Date(postedAtMs).toISOString().slice(0,10) : 'unknown'}, reactions=${reactions}, comments=${comments}, body="${(data.bodyText || '').slice(0, 60)}"`);
}

// ---------- Aggregation ----------

function buildCreatorRow(creator, postsInWindow, postsTotalDiscovered) {
    const total = postsInWindow.length;
    const totalReactions = postsInWindow.reduce((s, p) => s + (p.reactions || 0), 0);
    const totalComments = postsInWindow.reduce((s, p) => s + (p.comments || 0), 0);
    const totalReposts = postsInWindow.reduce((s, p) => s + (p.reposts || 0), 0);
    const totalEngagement = totalReactions + totalComments + totalReposts;
    const avgReactionsPerPost = total ? Math.round(totalReactions / total) : 0;
    const avgEngagementPerPost = total ? Math.round(totalEngagement / total) : 0;
    const lookbackDaysActual = Math.max(1, Number(lookbackDays) || 30);
    const postsPerDay = total ? Number((total / lookbackDaysActual).toFixed(2)) : 0;
    const engagementVelocity = total ? Math.round(totalEngagement / lookbackDaysActual) : 0;

    let topPost = null;
    if (postsInWindow.length > 0) {
        topPost = postsInWindow.reduce((best, p) => (p.total > (best?.total ?? -1) ? p : best), null);
    }

    const sampleAuthor = postsInWindow[0] || null;
    return {
        rank: null, // filled in by caller after sort
        handle: creator.handle,
        kind: creator.kind,
        url: creator.canonicalUrl,
        creatorName: sampleAuthor?.authorName || creator.handle,
        creatorHeadline: sampleAuthor?.authorHeadline || null,
        lookbackDays: lookbackDaysActual,
        postsInWindow: total,
        postsDiscovered: postsTotalDiscovered,
        totalReactions,
        totalComments,
        totalReposts,
        totalEngagement,
        avgReactionsPerPost,
        avgEngagementPerPost,
        postsPerDay,
        engagementVelocity,
        topPost: topPost ? {
            url: topPost.shareUrl,
            postedAt: topPost.postedAtMs ? new Date(topPost.postedAtMs).toISOString() : null,
            reactions: topPost.reactions,
            comments: topPost.comments,
            reposts: topPost.reposts,
            total: topPost.total,
            textSnippet: topPost.bodyText ? topPost.bodyText.slice(0, 280) : null,
        } : null,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- URL helpers ----------

function parseCreatorUrl(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)linkedin\.com$/.test(host)) return null;

    const path = u.pathname.replace(/\/+$/, '');
    let m = path.match(/^\/in\/([^/]+)/i);
    if (m) {
        const handle = decodeURIComponent(m[1]).toLowerCase();
        return { kind: 'person', handle, key: `person:${handle}`, canonicalUrl: `https://www.linkedin.com/in/${handle}/` };
    }
    m = path.match(/^\/(company|school|showcase)\/([^/]+)/i);
    if (m) {
        const kindPath = m[1].toLowerCase();
        const handle = decodeURIComponent(m[2]).toLowerCase();
        const kind = kindPath === 'company' ? 'company' : kindPath;
        return { kind, handle, key: `${kindPath}:${handle}`, canonicalUrl: `https://www.linkedin.com/${kindPath}/${handle}/` };
    }
    m = path.match(/^\/posts\/([^_/]+)/i);
    if (m) {
        const handle = decodeURIComponent(m[1]).toLowerCase();
        return { kind: 'unknown', handle, key: `unknown:${handle}`, canonicalUrl: `https://www.linkedin.com/in/${handle}/` };
    }
    return null;
}

function buildSearchUrl(creator, pageIndex) {
    const q = `site:linkedin.com/posts/${creator.handle}_`;
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

function postUrlMatchesCreator(url, creator) {
    if (creator.kind === 'unknown') return true;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (!/(^|\.)linkedin\.com$/.test(host)) return false;
        const m = u.pathname.match(/^\/posts\/([^_]+)_/i);
        if (!m) return false;
        const slug = decodeURIComponent(m[1]).toLowerCase();
        return slug === creator.handle;
    } catch { return false; }
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

function parseTimeText(raw, activityId) {
    if (!raw) return idToMs(activityId);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const t = Date.parse(raw);
        if (!Number.isNaN(t)) return t;
    }
    const m = raw.match(/(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|yr|year)s?\s*(?:ago)?/i);
    if (m) {
        const n = Number(m[1]);
        const unit = m[2].toLowerCase();
        const factor = { s: 1, sec: 1, second: 1,
            m: 60, min: 60, minute: 60,
            h: 3600, hr: 3600, hour: 3600,
            d: 86400, day: 86400,
            w: 604800, week: 604800,
            mo: 2592000, month: 2592000,
            y: 31536000, yr: 31536000, year: 31536000 }[unit] || 86400;
        return Date.now() - n * factor * 1000;
    }
    return idToMs(activityId);
}

function idToMs(activityId) {
    if (!activityId) return null;
    try {
        const big = BigInt(activityId);
        const ms = Number(big >> 22n);
        if (ms > 1e12) return ms;
    } catch {}
    return null;
}
