// LinkedIn Profile & Company Post Tracker (No Cookies)
//
// Strategy
// --------
// LinkedIn's authenticated /voyager/ API requires a session cookie. Two surfaces
// are usable without one:
//   1. /embed/feed/update/urn:li:activity:{id}/   public post embed (no auth)
//   2. /posts/{vanity}_{slug}-activity-{id}-{code}   public share page (no auth)
//
// Discovery: search engine site queries find public post URLs from a target
// profile or company. Brave Search exposes a clean HTML SERP that we parse for
// linkedin.com/posts/{handle}_... links. Each link contains the activity id.
// Once we have an activity id, the embed endpoint returns a fully rendered
// post card we can parse for author, body, timestamp, engagement, and media.
//
// Output rows
// -----------
// One row per post. Optional reaction rows and comment rows are pushed as
// separate dataset items when scrapeReactions / scrapeComments are enabled,
// so each enrichment item is charged separately by the PPE pricing model.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    targetUrls = [],
    maxPosts = 20,
    postedLimitDate = '',
    includeQuotePosts = true,
    includeReposts = true,
    scrapeReactions = false,
    maxReactions = 50,
    scrapeComments = false,
    maxComments = 50,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const profiles = [];
for (const raw of targetUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseProfileUrl(String(v).trim());
    if (parsed && !profiles.some((p) => p.key === parsed.key)) profiles.push(parsed);
}

if (profiles.length === 0) {
    log.warning('No valid LinkedIn profile or company URLs provided. Examples: https://www.linkedin.com/in/satyanadella/, https://www.linkedin.com/company/openai/');
    await Actor.exit();
}

const cutoffMs = parsePostedLimitDate(postedLimitDate);
const perProfileCap = Number(maxPosts) > 0 ? Number(maxPosts) : Infinity;
const reactionsCap = Number(maxReactions) > 0 ? Number(maxReactions) : Infinity;
const commentsCap = Number(maxComments) > 0 ? Number(maxComments) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const counts = new Map();
const seenActivities = new Set();
profiles.forEach((p) => counts.set(p.key, 0));

const initialRequests = profiles.map((p) => ({
    url: buildSearchUrl(p, 0),
    userData: { type: 'search', profileKey: p.key, page: 0 },
    uniqueKey: `search:${p.key}:0`,
}));

const profileByKey = new Map(profiles.map((p) => [p.key, p]));

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
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'post') return handlePost(ctx);
        if (t === 'reactions') return handleReactions(ctx);
        if (t === 'comments') return handleComments(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Profiles: ${profiles.length}. Posts pushed: ${[...counts.values()].reduce((a, b) => a + b, 0)}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const profile = profileByKey.get(request.userData.profileKey);
    if (!profile) return;
    const have = counts.get(profile.key) || 0;
    if (have >= perProfileCap) return;

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/posts\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    const remaining = perProfileCap - have;

    for (const raw of links) {
        if (queued >= remaining) break;
        const cleaned = unwrapPostUrl(raw);
        const activityId = extractActivityId(cleaned);
        if (!activityId) continue;
        if (seenActivities.has(activityId)) continue;
        if (!postUrlMatchesProfile(cleaned, profile)) continue;

        seenActivities.add(activityId);
        queued += 1;

        await c.addRequests([{
            url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/`,
            userData: {
                type: 'post',
                profileKey: profile.key,
                activityId,
                shareUrl: cleaned,
            },
            uniqueKey: `post:${activityId}`,
        }]);
    }

    log.info(`Search page ${request.userData.page} for ${profile.key}: ${links.length} raw links, ${queued} new posts queued.`);

    const nextPage = (request.userData.page || 0) + 1;
    if (queued > 0 && nextPage < 6 && have + queued < perProfileCap) {
        await c.addRequests([{
            url: buildSearchUrl(profile, nextPage),
            userData: { type: 'search', profileKey: profile.key, page: nextPage },
            uniqueKey: `search:${profile.key}:${nextPage}`,
        }]);
    }
}

async function handlePost({ page, request, crawler: c }) {
    const { profileKey, activityId, shareUrl } = request.userData;
    const profile = profileByKey.get(profileKey);
    if (!profile) return;
    if ((counts.get(profileKey) || 0) >= perProfileCap) return;

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

        const reshareEl = sel('.feed-shared-mini-update-v2, .feed-shared-update-v2__update-content-wrapper .feed-shared-update-v2');

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
            hasReshare: !!reshareEl,
        };
    });

    const postType = inferPostType(data, !!data.hasReshare);
    if (!includeQuotePosts && postType === 'quote') return;
    if (!includeReposts && postType === 'repost') return;

    const postedAtMs = parseTimeText(data.timeIso || data.timeText, activityId);
    if (cutoffMs && postedAtMs && postedAtMs < cutoffMs) {
        log.info(`Skipping ${activityId}: posted ${new Date(postedAtMs).toISOString()} before cutoff.`);
        return;
    }

    const reactions = parseCount(data.reactionsText);
    const comments = parseCount(data.commentsText);
    const reposts = parseCount(data.repostsText);

    const row = {
        id: activityId,
        urn: `urn:li:activity:${activityId}`,
        url: shareUrl || `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
        embedUrl: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/`,
        type: postType,
        author: {
            name: data.authorName || profile.handle,
            url: cleanLinkedInUrl(data.authorUrl) || profile.url,
            headline: data.authorHeadline || null,
            kind: profile.kind,
        },
        target: {
            handle: profile.handle,
            url: profile.url,
            kind: profile.kind,
        },
        text: data.bodyText || data.ogDescription || null,
        textHtml: data.bodyHtml || null,
        postedAt: postedAtMs ? new Date(postedAtMs).toISOString() : null,
        postedText: data.timeText || null,
        engagement: {
            reactions,
            comments,
            reposts,
            total: (reactions || 0) + (comments || 0) + (reposts || 0),
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
    };

    await Actor.pushData(row);
    counts.set(profileKey, (counts.get(profileKey) || 0) + 1);
    log.info(`Pushed post ${activityId} for ${profile.key} (${counts.get(profileKey)}/${perProfileCap === Infinity ? '∞' : perProfileCap}). type=${postType}, reactions=${reactions ?? '?'}.`);

    if (scrapeReactions && reactions !== 0) {
        await c.addRequests([{
            url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/?showReactions=true`,
            userData: { type: 'reactions', activityId, profileKey },
            uniqueKey: `reactions:${activityId}`,
        }]);
    }
    if (scrapeComments && comments !== 0) {
        await c.addRequests([{
            url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${activityId}/?showComments=true`,
            userData: { type: 'comments', activityId, profileKey },
            uniqueKey: `comments:${activityId}`,
        }]);
    }
}

async function handleReactions({ page, request }) {
    const { activityId, profileKey } = request.userData;
    try {
        await page.waitForSelector('.social-details-reactors-tab-body, .reactions-row, .feed-shared-social-action-bar', { timeout: 8000 });
    } catch {}

    const items = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]').forEach((a) => {
            const href = a.href.split('?')[0];
            if (!/linkedin\.com\/(in|company)\//.test(href)) return;
            if (seen.has(href)) return;
            const card = a.closest('li, div, article');
            const name = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (!name) return;
            const reactionImg = card?.querySelector('img[alt*="reaction"], img[data-test-icon]');
            const reactionType = reactionImg?.getAttribute('alt') || reactionImg?.getAttribute('data-test-icon') || null;
            seen.add(href);
            out.push({ name, profileUrl: href, reactionType });
        });
        return out;
    });

    let pushed = 0;
    for (const r of items) {
        if (pushed >= reactionsCap) break;
        await Actor.pushData({
            kind: 'reaction',
            postId: activityId,
            postUrn: `urn:li:activity:${activityId}`,
            postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
            target: { handle: profileByKey.get(profileKey)?.handle, kind: profileByKey.get(profileKey)?.kind },
            reactor: { name: r.name, profileUrl: cleanLinkedInUrl(r.profileUrl) },
            reactionType: r.reactionType,
            scrapedAt: new Date().toISOString(),
        });
        pushed += 1;
    }
    if (pushed > 0) log.info(`Pushed ${pushed} reactions for ${activityId}.`);
}

async function handleComments({ page, request }) {
    const { activityId, profileKey } = request.userData;
    try {
        await page.waitForSelector('.comments-comment-item, .comments-comments-list, .feed-shared-comments-list', { timeout: 8000 });
    } catch {}

    const items = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.comments-comment-item, [data-test-id="comment"], article.comment').forEach((el) => {
            const link = el.querySelector('a[href*="/in/"], a[href*="/company/"]');
            const profileUrl = link?.href ? link.href.split('?')[0] : null;
            const nameEl = el.querySelector('.comments-post-meta__name-text, .comments-post-meta__name, .comments-comment-item__name-text');
            const name = (nameEl?.textContent || link?.textContent || '').replace(/\s+/g, ' ').trim();
            const headlineEl = el.querySelector('.comments-post-meta__headline, .comments-comment-item__headline');
            const headline = (headlineEl?.textContent || '').replace(/\s+/g, ' ').trim();
            const bodyEl = el.querySelector('.comments-comment-item__main-content, .feed-shared-main-content--comment, .comment-body, .attributed-text-segment-list__container');
            const text = (bodyEl?.textContent || '').replace(/\s+/g, ' ').trim();
            const time = el.querySelector('time')?.getAttribute('datetime') || null;
            if (name || text) out.push({ name, profileUrl, headline, text, time });
        });
        return out;
    });

    let pushed = 0;
    for (const c of items) {
        if (pushed >= commentsCap) break;
        await Actor.pushData({
            kind: 'comment',
            postId: activityId,
            postUrn: `urn:li:activity:${activityId}`,
            postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
            target: { handle: profileByKey.get(profileKey)?.handle, kind: profileByKey.get(profileKey)?.kind },
            commenter: {
                name: c.name || null,
                profileUrl: cleanLinkedInUrl(c.profileUrl),
                headline: c.headline || null,
            },
            text: c.text || null,
            commentedAt: c.time || null,
            scrapedAt: new Date().toISOString(),
        });
        pushed += 1;
    }
    if (pushed > 0) log.info(`Pushed ${pushed} comments for ${activityId}.`);
}

// ---------- URL helpers ----------

function parseProfileUrl(raw) {
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
        return { kind: 'person', handle, key: `person:${handle}`, url: `https://www.linkedin.com/in/${handle}/` };
    }
    m = path.match(/^\/(company|school|showcase)\/([^/]+)/i);
    if (m) {
        const kindPath = m[1].toLowerCase();
        const handle = decodeURIComponent(m[2]).toLowerCase();
        return { kind: kindPath === 'company' ? 'company' : kindPath, handle, key: `${kindPath}:${handle}`, url: `https://www.linkedin.com/${kindPath}/${handle}/` };
    }
    m = path.match(/^\/posts\/([^_/]+)/i);
    if (m) {
        const handle = decodeURIComponent(m[1]).toLowerCase();
        return { kind: 'unknown', handle, key: `unknown:${handle}`, url: `https://www.linkedin.com/in/${handle}/` };
    }
    return null;
}

function buildSearchUrl(profile, pageIndex) {
    const q = `site:linkedin.com/posts/${profile.handle}_`;
    const offset = pageIndex * 20;
    const params = new URLSearchParams({ q, source: 'web' });
    if (offset > 0) params.set('offset', String(offset));
    return `https://search.brave.com/search?${params.toString()}`;
}

// Strip search-engine redirect wrappers and LinkedIn login_redirect / signup
// wrappers, leaving the canonical /posts/{handle}_... URL.
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

function postUrlMatchesProfile(url, profile) {
    if (profile.kind === 'unknown') return true;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        // Country prefixed LinkedIn hosts like ec.linkedin.com, ap.linkedin.com,
        // gt.linkedin.com all serve the same /posts/ route. Accept any *.linkedin.com.
        if (!/(^|\.)linkedin\.com$/.test(host)) return false;
        const m = u.pathname.match(/^\/posts\/([^_]+)_/i);
        if (!m) return false;
        const slug = decodeURIComponent(m[1]).toLowerCase();
        return slug === profile.handle;
    } catch { return false; }
}

function cleanLinkedInUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return href;
        return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return href; }
}

// ---------- Parsing helpers ----------

function inferPostType(data, hasReshare) {
    if (hasReshare) {
        if (data.bodyText && data.bodyText.length > 0) return 'quote';
        return 'repost';
    }
    return 'original';
}

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

// LinkedIn activity ids are Snowflake-style. The top 41 bits are a millisecond
// timestamp offset from epoch. This gives us the post time within ~1 minute
// when the rendered timestamp text fails to parse.
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
