// Threads Intelligence
// Scrapes public Meta Threads pages via PlaywrightCrawler. Captures GraphQL
// response payloads (the same data the Threads web UI consumes), normalizes
// each post into a flat row, and dedupes by post code.
//
// Three input modes:
//   - usernames:  https://www.threads.com/@<handle>           (creator feed)
//   - searchTerms: https://www.threads.com/search?q=<term>    (keyword discovery)
//   - postUrls:   https://www.threads.com/@<user>/post/<code> (single post hydrate)
//
// Threads renders nothing useful in raw HTML — the SPA hydrates from GraphQL
// after first paint. We listen on `response` for /api/graphql and walk the
// JSON for any `thread_items` arrays, which is where every post lives.
//
// Free tier: first 50 posts per run are free. Charge per post after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 50;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    usernames = [],
    searchTerms = [],
    postUrls = [],
    minLikes = 0,
    minReplies = 0,
    verifiedOnly = false,
    maxItemsPerSource = 25,
    maxItemsTotal = 100,
    scrollPasses = 3,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const handles = cleanList(usernames).map(normalizeHandle).filter(Boolean);
const queries = cleanList(searchTerms);
const directUrls = cleanList(postUrls).filter((u) => /^https?:\/\/(www\.)?threads\.(com|net)\//i.test(u));

if (handles.length === 0 && queries.length === 0 && directUrls.length === 0) {
    log.warning('No input provided. Add a handle, search term, or post URL and run again.');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('threads-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-codes')) || [];
    for (const k of prev) seen.add(k);
}

let totalPushed = 0;

const initialRequests = [];
for (const handle of handles) {
    initialRequests.push({
        url: `https://www.threads.com/@${encodeURIComponent(handle)}`,
        userData: { type: 'username', source: handle, perSourceCount: 0 },
        uniqueKey: `username:${handle}`,
    });
}
for (const q of queries) {
    initialRequests.push({
        url: `https://www.threads.com/search?q=${encodeURIComponent(q)}&serp_type=default`,
        userData: { type: 'search', source: q, perSourceCount: 0 },
        uniqueKey: `search:${q}`,
    });
}
for (const u of directUrls) {
    initialRequests.push({
        url: u,
        userData: { type: 'post', source: u, perSourceCount: 0 },
        uniqueKey: `post:${u}`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 2,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 25, sessionOptions: { maxUsageCount: 20 } },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                operatingSystems: ['macos', 'windows'],
                locales: ['en-US'],
            },
        },
    },
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ page, request }) {
        if (totalPushed >= maxItemsTotal) {
            log.info(`Total cap reached (${totalPushed}/${maxItemsTotal}), skipping ${request.url}`);
            return;
        }

        const sourceLabel = `${request.userData.type}:${request.userData.source}`;
        const collectedCodes = new Set();

        const onResponse = async (resp) => {
            try {
                const url = resp.url();
                if (!/\/api\/graphql/i.test(url) && !/graphql\/query/i.test(url)) return;
                const ct = resp.headers()['content-type'] || '';
                if (!/json/i.test(ct)) return;
                const json = await resp.json().catch(() => null);
                if (!json) return;
                const posts = extractPostsFromGraphql(json);
                for (const p of posts) {
                    if (!p.code || collectedCodes.has(p.code)) continue;
                    collectedCodes.add(p.code);
                    if (totalPushed >= maxItemsTotal) break;
                    if (request.userData.perSourceCount >= maxItemsPerSource) break;
                    await maybePushPost(p, request, sourceLabel);
                }
            } catch (err) {
                log.debug(`response handler error: ${err?.message}`);
            }
        };

        page.on('response', onResponse);

        try {
            await page.setViewportSize({ width: 1440, height: 1800 });
            await page.waitForLoadState('domcontentloaded');
            await dismissConsent(page);

            if (await isBlocked(page)) {
                throw new Error(`Blocked by Threads: ${page.url()}`);
            }

            // Wait briefly for the first GraphQL hydration burst.
            await page.waitForTimeout(2500);

            // Scroll to trigger lazy loaded posts. Each scroll pass typically
            // fires another GraphQL request which the response handler picks up.
            const passes = Math.max(0, Math.min(30, Number(scrollPasses) || 0));
            for (let i = 0; i < passes; i++) {
                if (totalPushed >= maxItemsTotal) break;
                if (request.userData.perSourceCount >= maxItemsPerSource) break;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1800);
            }

            // Final settle so trailing responses still arrive.
            await page.waitForTimeout(1200);

            // For post URL mode, fall back to DOM extraction if no GraphQL
            // payload exposed the post (some single-post pages only ship
            // hydration in a different shape).
            if (request.userData.type === 'post' && request.userData.perSourceCount === 0) {
                const fallback = await readPostFromDom(page).catch(() => null);
                if (fallback) {
                    await maybePushPost(fallback, request, sourceLabel);
                }
            }

            log.info(`Done ${sourceLabel}: ${request.userData.perSourceCount} posts (${totalPushed}/${maxItemsTotal} total)`);
        } finally {
            page.off('response', onResponse);
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && totalPushed > 0) {
    await seenStore.setValue('seen-codes', [...seen]);
}

log.info(`Run complete. Pushed ${totalPushed} Threads posts.`);
await Actor.exit();

// ---------- push pipeline ----------

async function maybePushPost(p, request, sourceLabel) {
    if (totalPushed >= maxItemsTotal) return;
    if (request.userData.perSourceCount >= maxItemsPerSource) return;

    if (verifiedOnly && !p.author?.verified) return;
    if (Number.isFinite(p.likeCount) && p.likeCount < minLikes) return;
    if (Number.isFinite(p.replyCount) && p.replyCount < minReplies) return;

    const dedupeKey = p.code || p.id;
    if (dedupe && dedupeKey && seen.has(dedupeKey)) return;
    if (dedupeKey) seen.add(dedupeKey);

    const out = {
        ...p,
        sourceType: request.userData.type,
        source: sourceLabel,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(out);
    totalPushed += 1;
    request.userData.perSourceCount += 1;
    maybeCharge();
}

// ---------- GraphQL response walker ----------

function extractPostsFromGraphql(json) {
    const out = [];
    const seenCodes = new Set();

    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const x of node) visit(x);
            return;
        }
        // A "thread item" wraps a post object; the post object itself has
        // a `code` and a `caption` plus engagement counts.
        const candidate = node.post || node;
        if (candidate && typeof candidate === 'object'
            && typeof candidate.code === 'string'
            && (candidate.caption !== undefined || typeof candidate.text_post_app_info === 'object' || typeof candidate.user === 'object')) {
            const row = mapPost(candidate);
            if (row && row.code && !seenCodes.has(row.code)) {
                seenCodes.add(row.code);
                out.push(row);
            }
        }
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') visit(v);
        }
    };

    visit(json);
    return out;
}

function mapPost(p) {
    if (!p || typeof p !== 'object') return null;
    const user = p.user || {};
    const caption = p.caption || {};
    const text = (typeof caption.text === 'string' ? caption.text : '') || '';
    const tpa = p.text_post_app_info || {};

    const code = p.code || null;
    const username = user.username || null;
    const url = code && username ? `https://www.threads.com/@${username}/post/${code}` : null;

    const takenAt = Number(p.taken_at) || null;
    const createdAt = takenAt ? new Date(takenAt * 1000).toISOString() : null;

    const mediaUrls = collectMediaUrls(p);

    const mentions = [...new Set((text.match(/@([A-Za-z0-9_.]{1,30})/g) || []).map((m) => m.slice(1).toLowerCase()))];
    const hashtags = [...new Set((text.match(/#([A-Za-z0-9_]{1,140})/g) || []).map((h) => h.slice(1).toLowerCase()))];

    const likeCount = numOrNull(p.like_count);
    const replyCount = numOrNull(tpa.direct_reply_count ?? p.reply_count);
    const repostCount = numOrNull(tpa.repost_count ?? p.repost_count);
    const quoteCount = numOrNull(tpa.quote_count ?? p.quote_count);

    return {
        id: p.pk || p.id || null,
        code,
        url,
        author: {
            id: user.pk || user.id || null,
            username,
            displayName: user.full_name || null,
            verified: !!(user.is_verified || user.verified),
            followerCount: numOrNull(user.follower_count),
            profilePicUrl: user.profile_pic_url || user.hd_profile_pic_url_info?.url || null,
        },
        text,
        createdAt,
        likeCount,
        replyCount,
        repostCount,
        quoteCount,
        mentions,
        hashtags,
        mediaUrls,
        isReply: !!(tpa.is_reply || p.is_reply || tpa.reply_to_author),
        language: caption.language || p.language || null,
    };
}

function collectMediaUrls(p) {
    const urls = new Set();
    const candidates = [];
    if (Array.isArray(p.image_versions2?.candidates)) candidates.push(...p.image_versions2.candidates);
    if (Array.isArray(p.carousel_media)) {
        for (const c of p.carousel_media) {
            if (Array.isArray(c.image_versions2?.candidates)) candidates.push(...c.image_versions2.candidates);
            if (Array.isArray(c.video_versions)) candidates.push(...c.video_versions);
        }
    }
    if (Array.isArray(p.video_versions)) candidates.push(...p.video_versions);
    let best = null;
    let bestArea = 0;
    for (const c of candidates) {
        const area = (c.width || 0) * (c.height || 0);
        if (c.url && area > bestArea) { best = c.url; bestArea = area; }
        if (c.url) urls.add(c.url);
    }
    // Return the highest-resolution per medium plus the rest.
    return [...urls];
}

function numOrNull(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ---------- DOM fallback for single post URLs ----------

async function readPostFromDom(page) {
    return page.evaluate(() => {
        const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
        const text = meta('meta[property="og:description"]')
            || document.querySelector('article')?.innerText
            || '';
        const ogUrl = meta('meta[property="og:url"]') || location.href;
        const codeMatch = ogUrl.match(/\/post\/([A-Za-z0-9_-]+)/);
        const userMatch = ogUrl.match(/@([A-Za-z0-9_.]+)/);
        if (!codeMatch) return null;
        return {
            id: null,
            code: codeMatch[1],
            url: ogUrl,
            author: {
                id: null,
                username: userMatch ? userMatch[1] : null,
                displayName: meta('meta[property="og:title"]') || null,
                verified: false,
                followerCount: null,
                profilePicUrl: meta('meta[property="og:image"]') || null,
            },
            text: typeof text === 'string' ? text.trim() : '',
            createdAt: null,
            likeCount: null,
            replyCount: null,
            repostCount: null,
            quoteCount: null,
            mentions: [],
            hashtags: [],
            mediaUrls: [meta('meta[property="og:image"]')].filter(Boolean),
            isReply: false,
            language: document.documentElement.lang || null,
        };
    });
}

// ---------- input cleanup ----------

function cleanList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map((v) => (typeof v === 'string' ? v : v?.value || v?.url || ''))
        .map((v) => String(v).trim())
        .filter(Boolean);
}

function normalizeHandle(raw) {
    return String(raw).trim().replace(/^@+/, '').replace(/[^A-Za-z0-9_.]/g, '').toLowerCase();
}

// ---------- page helpers ----------

async function dismissConsent(page) {
    const selectors = [
        'div[role="dialog"] button:has-text("Allow all cookies")',
        'div[role="dialog"] button:has-text("Accept")',
        'button:has-text("Allow all cookies")',
        'button:has-text("Accept all")',
        'button:has-text("Accept")',
        'button[aria-label="Close"]',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(400);
                break;
            }
        } catch {}
    }
}

async function isBlocked(page) {
    const url = page.url();
    if (/login|challenge|checkpoint|accounts\.threads/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/log in|sign up|page not found/i.test(title)) {
        // Threads sometimes shows a login wall but the body still hydrates.
        // Only flag as blocked if no main content loads.
        const hasBody = await page.$('main, [role="main"], article').catch(() => null);
        if (!hasBody) return true;
    }
    return false;
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'thread_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}
