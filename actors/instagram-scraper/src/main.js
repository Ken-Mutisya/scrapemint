// Instagram Scraper
// All in one scraper for posts, reels, comments, mentions, profiles, hashtags,
// places, and user search. Computes engagement rate per profile and flags
// sponsored posts.
//
// Strategy:
//   Instagram renders most data client side after login. For anonymous visits,
//   these paths ship real data in the initial HTML:
//     * profile: JSON-LD + og tags + window.__additionalData props
//     * post: JSON-LD with image, caption, likes, comments summary
//     * reel: same post JSON-LD
//   For hashtag, place, and user search, the anon web app redirects to login
//   or renders no data. Those paths are documented as limited.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    contentType = 'posts',
    urls = [],
    searchQueries = [],
    resultsLimit = 100,
    filterByDate = '',
    includeEngagementMetrics = true,
    detectSponsoredPosts = true,
    downloadMedia = false,
    scrapeCommentsPerPost = 0,
    includeMediaMetadata = true,
    dedupe = true,
    maxItemsTotal = 500,
    proxyConfiguration: proxyInput,
} = input;

const cleanList = (arr) =>
    Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || '')).map((v) => v.trim()).filter(Boolean)
        : [];

const inputUrls = cleanList(urls);
const queries = cleanList(searchQueries);

const cutoffDate = parseCutoff(filterByDate);

if (inputUrls.length === 0 && queries.length === 0) {
    inputUrls.push('https://www.instagram.com/humansofny/');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('instagram-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-ids')) || [];
    for (const id of prev) seen.add(id);
}

const initialRequests = buildRequests(contentType, inputUrls, queries);
if (initialRequests.length === 0) {
    log.warning('No valid requests to run.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

let itemsPushed = 0;
const profileAggregators = new Map();

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 420,
    maxRequestRetries: 4,
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
            },
        },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    async requestHandler({ page, request, crawler: c }) {
        if (itemsPushed >= maxItemsTotal) {
            log.info(`Cap reached (${itemsPushed}/${maxItemsTotal}), skipping ${request.url}`);
            return;
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);

        const { type } = request.userData;

        switch (type) {
            case 'profile':
                await handleProfile(page, request, c);
                break;
            case 'profile-grid':
                await handleProfileGrid(page, request, c);
                break;
            case 'post':
            case 'reel':
                await handlePost(page, request, type);
                break;
            case 'hashtag':
                await handleHashtagOrPlace(page, request, c, 'hashtag');
                break;
            case 'place':
                await handleHashtagOrPlace(page, request, c, 'place');
                break;
            case 'user-search':
                await handleUserSearch(page, request);
                break;
            case 'mentions':
                await handleMentions(page, request);
                break;
            case 'comments':
                await handleComments(page, request);
                break;
            default:
                log.warning(`Unknown type ${type}: ${request.url}`);
        }
    },
    async failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
        await finalizeProfileAggregation(request, null);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

for (const agg of profileAggregators.values()) {
    if (!agg.resolved) await pushProfileRow(agg);
}

if (seenStore && itemsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen]);
}

log.info(`Run complete. Pushed ${itemsPushed} items.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ----- request building -----

function buildRequests(type, urls, queries) {
    const out = [];
    for (const url of urls) {
        const parsed = classifyUrl(url);
        if (!parsed) {
            log.warning(`Unrecognized URL, skipping: ${url}`);
            continue;
        }
        out.push({ url: parsed.normalized, userData: { type: resolveType(type, parsed.kind), source: url } });
    }
    for (const q of queries) {
        const search = q.replace(/^#/, '').trim();
        if (!search) continue;
        const built = buildSearchUrl(type, search);
        if (built) {
            out.push({ url: built, userData: { type: searchType(type), source: search, query: search } });
        }
    }
    return out;
}

function classifyUrl(url) {
    const m = url.match(/instagram\.com\/(p|reel|reels|explore)\/([^/?#]+)/i);
    if (m) {
        const kind = m[1].toLowerCase();
        if (kind === 'p') return { kind: 'post', normalized: `https://www.instagram.com/p/${m[2]}/` };
        if (kind === 'reel' || kind === 'reels') return { kind: 'reel', normalized: `https://www.instagram.com/reel/${m[2]}/` };
        if (kind === 'explore') {
            const tag = url.match(/\/explore\/tags\/([^/?#]+)/i);
            if (tag) return { kind: 'hashtag', normalized: `https://www.instagram.com/explore/tags/${tag[1]}/` };
            const loc = url.match(/\/explore\/locations\/([^/?#]+)(?:\/([^/?#]+))?/i);
            if (loc) return { kind: 'place', normalized: `https://www.instagram.com/explore/locations/${loc[1]}/` };
        }
    }
    const profile = url.match(/instagram\.com\/([A-Za-z0-9_.]+)\/?$/i);
    if (profile) {
        return { kind: 'profile', normalized: `https://www.instagram.com/${profile[1]}/` };
    }
    return null;
}

function resolveType(requested, urlKind) {
    if (requested === 'comments') return 'comments';
    if (requested === 'mentions') return 'mentions';
    if (requested === 'profile') return 'profile';
    if (urlKind === 'post' || urlKind === 'reel') return urlKind;
    if (urlKind === 'hashtag') return 'hashtag';
    if (urlKind === 'place') return 'place';
    if (urlKind === 'profile' && (requested === 'posts' || requested === 'reels')) return 'profile-grid';
    if (urlKind === 'profile') return 'profile';
    return requested;
}

function searchType(requested) {
    if (requested === 'user-search') return 'user-search';
    if (requested === 'place') return 'place';
    return 'hashtag';
}

function buildSearchUrl(type, query) {
    const encoded = encodeURIComponent(query);
    if (type === 'user-search') return `https://www.instagram.com/web/search/topsearch/?query=${encoded}`;
    if (type === 'place') return `https://www.instagram.com/explore/locations/?q=${encoded}`;
    return `https://www.instagram.com/explore/tags/${encoded}/`;
}

// ----- page handlers -----

async function dismissConsent(page) {
    const selectors = [
        'button:has-text("Allow all cookies")',
        'button:has-text("Only allow essential cookies")',
        'button:has-text("Accept all")',
        'button:has-text("Decline optional cookies")',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        } catch {}
    }
    await page.keyboard.press('Escape').catch(() => {});
}

async function handleProfile(page, request, crawler) {
    await page.waitForTimeout(2500);
    const data = await readProfileData(page);
    if (!data || !data.username) {
        log.warning(`No profile data: ${request.url}`);
        return;
    }

    await scrollForGrid(page);
    const recentPosts = await readRecentPostsFromProfile(page, resultsLimit);

    const skeleton = {
        type: 'profile',
        id: data.id || data.username,
        url: `https://www.instagram.com/${data.username}/`,
        username: data.username,
        fullName: data.fullName || null,
        biography: data.biography || null,
        externalUrl: data.externalUrl || null,
        category: data.category || null,
        verified: !!data.verified,
        isPrivate: !!data.isPrivate,
        isBusinessAccount: !!data.isBusinessAccount,
        profilePicUrl: data.profilePicUrl || null,
        followers: num(data.followers),
        following: num(data.following),
        postsCount: num(data.postsCount),
        scrapedAt: new Date().toISOString(),
    };

    if (recentPosts.length === 0) {
        await Actor.pushData({ ...skeleton, recentPostsSample: 0 });
        itemsPushed += 1;
        if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        seen.add(skeleton.id);
        log.info(`Pushed profile @${skeleton.username} with no post sample`);
        return;
    }

    const key = data.username;
    profileAggregators.set(key, {
        skeleton,
        followers: skeleton.followers,
        posts: [],
        pending: recentPosts.length,
        resolved: false,
    });

    const follow = [];
    for (const p of recentPosts) {
        follow.push({
            url: p.url,
            userData: {
                type: p.kind === 'reel' ? 'reel' : 'post',
                sourceType: 'profile',
                source: data.username,
                profileAggregatorKey: key,
            },
            uniqueKey: `profile:${key}:${p.id}`,
        });
    }
    await crawler.addRequests(follow);
    log.info(`Queued ${follow.length} posts for @${skeleton.username}`);
}

async function handleProfileGrid(page, request, crawler) {
    await page.waitForTimeout(2500);
    await scrollForGrid(page);
    const recentPosts = await readRecentPostsFromProfile(page, resultsLimit);
    if (recentPosts.length === 0) {
        log.warning(`No posts found on profile grid: ${request.url}`);
        return;
    }
    const source = request.userData.source || request.url;
    const follow = recentPosts.map((p) => ({
        url: p.url,
        userData: {
            type: p.kind === 'reel' ? 'reel' : 'post',
            sourceType: 'profile',
            source,
        },
        uniqueKey: `grid:${source}:${p.id}`,
    }));
    await crawler.addRequests(follow);
    log.info(`Queued ${follow.length} posts from grid: ${source}`);
}

async function scrollForGrid(page) {
    try {
        await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 15000 });
    } catch {
        return;
    }
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
        await page.waitForTimeout(1800);
        const count = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) => els.length).catch(() => 0);
        if (count >= resultsLimit) break;
    }
}

async function finalizeProfileAggregation(request, post) {
    const key = request.userData?.profileAggregatorKey;
    if (!key) return;
    const agg = profileAggregators.get(key);
    if (!agg || agg.resolved) return;
    if (post) {
        agg.posts.push({
            likes: post.likes ?? null,
            comments: post.comments ?? null,
            createdAt: post.createdAt ?? null,
        });
    }
    agg.pending -= 1;
    if (agg.pending <= 0) await pushProfileRow(agg);
}

async function pushProfileRow(agg) {
    if (agg.resolved) return;
    agg.resolved = true;
    const filtered = applyDateFilter(agg.posts);
    const row = { ...agg.skeleton, recentPostsSample: filtered.length };
    if (includeEngagementMetrics && filtered.length > 0) {
        row.engagement = computeEngagement(filtered, agg.followers);
    }
    await Actor.pushData(row);
    itemsPushed += 1;
    if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    seen.add(row.id);
    log.info(`Pushed profile @${row.username} (followers=${row.followers}, sample=${filtered.length}, er=${row.engagement?.engagementRate ?? 'n/a'})`);
}

async function handlePost(page, request, kind) {
    await page.waitForTimeout(2000);
    const post = await readPostData(page, kind);
    if (!post || !post.id) {
        log.warning(`No post data: ${request.url}`);
        await finalizeProfileAggregation(request, null);
        return;
    }
    if (dedupe && seen.has(post.id)) {
        log.info(`Skipped duplicate: ${post.id}`);
        await finalizeProfileAggregation(request, post);
        return;
    }

    const row = enrichPostRow(post, request.userData);
    row.type = kind;

    if (scrapeCommentsPerPost > 0) {
        row.topComments = await scrapeTopComments(page, scrapeCommentsPerPost);
    }

    await Actor.pushData(row);
    seen.add(post.id);
    itemsPushed += 1;
    if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    log.info(`Pushed ${kind} ${post.id} by @${post.ownerUsername || '?'} (${itemsPushed}/${maxItemsTotal})`);
    await finalizeProfileAggregation(request, post);
}

async function handleHashtagOrPlace(page, request, crawler, kind) {
    await page.waitForTimeout(3000);
    const title = await page.title().catch(() => '');
    if (/login|sign up/i.test(title)) {
        log.warning(`${kind} "${request.userData.source}" requires login, skipping`);
        return;
    }
    const data = await readTagOrPlaceData(page, kind);
    if (!data) {
        log.warning(`No ${kind} data: ${request.url}`);
        return;
    }
    const row = {
        type: kind,
        id: data.id || `${kind}:${request.userData.source}`,
        url: request.url,
        name: data.name || request.userData.source,
        postsCount: num(data.postsCount),
        topPostsSample: data.topPosts?.length || 0,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(row);
    itemsPushed += 1;
    if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    log.info(`Pushed ${kind} "${row.name}" (postsCount=${row.postsCount})`);

    if (data.topPosts?.length) {
        for (const p of data.topPosts.slice(0, Math.min(resultsLimit, maxItemsTotal - itemsPushed))) {
            if (itemsPushed >= maxItemsTotal) break;
            const postRow = enrichPostRow(p, { sourceType: kind, source: row.name });
            if (dedupe && seen.has(postRow.id)) continue;
            await Actor.pushData(postRow);
            seen.add(postRow.id);
            itemsPushed += 1;
            if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        }
    }
}

async function handleUserSearch(page, request) {
    try {
        const json = await page.evaluate(() => {
            const body = document.body?.innerText || '';
            try {
                return JSON.parse(body);
            } catch {
                return null;
            }
        });
        if (!json?.users) {
            log.warning(`No user search results: ${request.userData.query}`);
            return;
        }
        for (const entry of json.users.slice(0, Math.min(resultsLimit, maxItemsTotal - itemsPushed))) {
            if (itemsPushed >= maxItemsTotal) break;
            const u = entry.user || entry;
            const row = {
                type: 'user-search-result',
                id: u.pk || u.id,
                username: u.username,
                fullName: u.full_name || null,
                verified: !!u.is_verified,
                isPrivate: !!u.is_private,
                profilePicUrl: u.profile_pic_url || null,
                followers: num(u.follower_count),
                query: request.userData.query,
                scrapedAt: new Date().toISOString(),
            };
            if (dedupe && row.id && seen.has(row.id)) continue;
            await Actor.pushData(row);
            if (row.id) seen.add(row.id);
            itemsPushed += 1;
            if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        }
    } catch (err) {
        log.warning(`User search failed: ${err.message}`);
    }
}

async function handleMentions(page, request) {
    await page.waitForTimeout(3000);
    const posts = await readRecentPostsFromProfile(page, resultsLimit);
    const mentionMap = new Map();
    for (const p of posts) {
        const tags = extractMentions(p.caption);
        for (const tag of tags) {
            const current = mentionMap.get(tag) || { mentionedUsername: tag, count: 0, posts: [] };
            current.count += 1;
            current.posts.push({ id: p.id, url: p.url, createdAt: p.createdAt });
            mentionMap.set(tag, current);
        }
    }
    const rows = [...mentionMap.values()].sort((a, b) => b.count - a.count).slice(0, resultsLimit);
    for (const r of rows) {
        if (itemsPushed >= maxItemsTotal) break;
        await Actor.pushData({
            type: 'mention',
            sourceProfile: request.userData.source,
            ...r,
            scrapedAt: new Date().toISOString(),
        });
        itemsPushed += 1;
        if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    }
    log.info(`Pushed ${rows.length} mention rows from ${posts.length} posts`);
}

async function handleComments(page, request) {
    await page.waitForTimeout(2500);
    const post = await readPostData(page, 'post');
    if (!post?.id) {
        log.warning(`No post context for comments: ${request.url}`);
        return;
    }
    const comments = await scrapeTopComments(page, resultsLimit);
    for (const c of comments) {
        if (itemsPushed >= maxItemsTotal) break;
        await Actor.pushData({
            type: 'comment',
            postId: post.id,
            postUrl: request.url,
            postOwner: post.ownerUsername || null,
            ...c,
            scrapedAt: new Date().toISOString(),
        });
        itemsPushed += 1;
        if (itemsPushed > 2) __chargeJobs.push(Actor.charge({ eventName: 'post_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    }
    log.info(`Pushed ${comments.length} comments from post ${post.id}`);
}

// ----- data extraction -----

async function readProfileData(page) {
    return page.evaluate(() => {
        const meta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') || null;
        const jsonLd = (() => {
            const nodes = document.querySelectorAll('script[type="application/ld+json"]');
            for (const n of nodes) {
                try {
                    const j = JSON.parse(n.textContent);
                    if (j?.['@type'] === 'ProfilePage' || j?.mainEntity) return j;
                } catch {}
            }
            return null;
        })();

        const parseHeaderNum = (label) => {
            const nodes = document.querySelectorAll('header li, header span');
            for (const n of nodes) {
                const t = n.textContent?.trim() || '';
                if (t.toLowerCase().includes(label)) {
                    const m = t.match(/([\d,.]+)\s*([KMB]?)/);
                    if (m) {
                        const base = parseFloat(m[1].replace(/,/g, ''));
                        const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1;
                        return Math.round(base * mult);
                    }
                }
            }
            return null;
        };

        const ogDesc = meta('og:description') || '';
        const m = ogDesc.match(/([\d,.]+[KMB]?)\s+Followers,\s*([\d,.]+[KMB]?)\s+Following,\s*([\d,.]+[KMB]?)\s+Posts/i);
        const toNum = (s) => {
            if (!s) return null;
            const mm = s.match(/([\d,.]+)\s*([KMB]?)/);
            if (!mm) return null;
            const base = parseFloat(mm[1].replace(/,/g, ''));
            const mult = mm[2] === 'K' ? 1e3 : mm[2] === 'M' ? 1e6 : mm[2] === 'B' ? 1e9 : 1;
            return Math.round(base * mult);
        };

        return {
            id: jsonLd?.mainEntity?.identifier?.value || null,
            username: jsonLd?.mainEntity?.alternateName?.replace(/^@/, '') || document.location.pathname.split('/').filter(Boolean)[0],
            fullName: jsonLd?.mainEntity?.name || meta('og:title')?.replace(/^\s*Login\s*•\s*/, '')?.replace(/\s*\(@[^)]+\).*/, '').trim() || null,
            biography: (() => {
                const headerText = document.querySelector('header section')?.innerText || '';
                const lines = headerText.split('\n').map((s) => s.trim()).filter(Boolean);
                const afterCounts = lines.findIndex((l) => /\d[\d.,KM]*\s*(posts|followers|following)/i.test(l));
                if (afterCounts >= 0 && lines.length > afterCounts + 3) {
                    const bio = lines.slice(afterCounts + 3).filter((l) => !l.startsWith('@') && l.length > 2).join(' ');
                    if (bio) return bio;
                }
                if (jsonLd?.mainEntity?.description) return jsonLd.mainEntity.description;
                const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                const mm = desc.match(/Instagram:\s*["'“”](.+?)["'“”]\s*$/);
                if (mm) return mm[1].trim();
                return null;
            })(),
            followers: m ? toNum(m[1]) : parseHeaderNum('followers'),
            following: m ? toNum(m[2]) : parseHeaderNum('following'),
            postsCount: m ? toNum(m[3]) : parseHeaderNum('posts'),
            profilePicUrl: meta('og:image') || null,
            verified: ogDesc.includes('✓') || !!jsonLd?.mainEntity?.identifier?.verified,
            isPrivate: /This Account is Private/i.test(document.body.innerText || ''),
            isBusinessAccount: null,
            category: null,
            externalUrl: null,
        };
    });
}

async function readRecentPostsFromProfile(page, cap) {
    return page.evaluate((cap) => {
        const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
        const out = [];
        const seen = new Set();
        for (const a of links) {
            const href = a.href.split('?')[0];
            const m = href.match(/\/(p|reel)\/([^/]+)/);
            if (!m) continue;
            if (seen.has(m[2])) continue;
            seen.add(m[2]);
            const img = a.querySelector('img');
            out.push({
                id: m[2],
                shortcode: m[2],
                url: href,
                kind: m[1] === 'reel' ? 'reel' : 'post',
                cover: img?.src || null,
                altText: img?.getAttribute('alt') || null,
            });
            if (out.length >= cap) break;
        }
        return out;
    }, cap);
}

async function readPostData(page, kind) {
    return page.evaluate(() => {
        const meta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') || null;
        const jsonLd = (() => {
            const nodes = document.querySelectorAll('script[type="application/ld+json"]');
            for (const n of nodes) {
                try {
                    const j = JSON.parse(n.textContent);
                    if (j?.['@type'] === 'SocialMediaPosting' || j?.caption) return j;
                } catch {}
            }
            return null;
        })();

        const url = window.location.href.split('?')[0];
        const m = url.match(/\/(p|reel|reels)\/([^/]+)/);
        if (!m) return null;
        const shortcode = m[2];
        const ownerFromPath = (() => {
            const um = window.location.pathname.match(/^\/([A-Za-z0-9_.]+)\/(p|reel|reels)\//);
            return um ? um[1] : null;
        })();
        const timeEl = document.querySelector('time[datetime]');
        const timeAttr = timeEl?.getAttribute('datetime') || null;
        const articleTime = document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || null;

        const parseCount = (txt) => {
            if (!txt) return null;
            const mm = txt.match(/([\d,.]+)\s*([KMB]?)/);
            if (!mm) return null;
            const base = parseFloat(mm[1].replace(/,/g, ''));
            const mult = mm[2] === 'K' ? 1e3 : mm[2] === 'M' ? 1e6 : mm[2] === 'B' ? 1e9 : 1;
            return Math.round(base * mult);
        };

        const ogDesc = meta('og:description') || '';
        const likesMatch = ogDesc.match(/([\d,.]+[KMB]?)\s*likes?,\s*([\d,.]+[KMB]?)\s*comments?/i);

        const owner = (() => {
            const t = meta('og:title') || '';
            const mm = t.match(/\(@([A-Za-z0-9_.]+)\)/);
            if (mm) return mm[1];
            return ownerFromPath;
        })();

        const caption = jsonLd?.caption || jsonLd?.articleBody || (() => {
            const mm = ogDesc.match(/[""""](.+?)[""""]/s);
            return mm ? mm[1] : null;
        })();

        return {
            id: shortcode,
            shortcode,
            url,
            ownerUsername: owner,
            caption,
            likes: likesMatch ? parseCount(likesMatch[1]) : null,
            comments: likesMatch ? parseCount(likesMatch[2]) : null,
            createdAt: jsonLd?.dateCreated || jsonLd?.datePublished || timeAttr || articleTime || null,
            image: meta('og:image') || null,
            video: meta('og:video') || null,
            locationName: jsonLd?.contentLocation?.name || null,
            hashtags: caption ? (caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1).toLowerCase()) : [],
            mentions: caption ? (caption.match(/@[A-Za-z0-9_.]+/g) || []).map((m) => m.slice(1).replace(/\.+$/, '')) : [],
        };
    });
}

async function readTagOrPlaceData(page, kind) {
    return page.evaluate((kind) => {
        const meta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') || null;
        const title = document.title || '';
        const ogDesc = meta('og:description') || '';
        const m = ogDesc.match(/([\d,.]+[KMB]?)\s*Posts?/i);
        const parse = (s) => {
            if (!s) return null;
            const mm = s.match(/([\d,.]+)\s*([KMB]?)/);
            if (!mm) return null;
            const base = parseFloat(mm[1].replace(/,/g, ''));
            const mult = mm[2] === 'K' ? 1e3 : mm[2] === 'M' ? 1e6 : mm[2] === 'B' ? 1e9 : 1;
            return Math.round(base * mult);
        };

        const name = (() => {
            if (kind === 'hashtag') {
                const mm = title.match(/#([^\s|]+)/);
                return mm ? mm[1] : null;
            }
            const mm = title.split(/[\|•]/)[0].trim();
            return mm || null;
        })();

        const topPosts = Array.from(document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]')).slice(0, 12).map((a) => {
            const href = a.href.split('?')[0];
            const idm = href.match(/\/(p|reel)\/([^/]+)/);
            const img = a.querySelector('img');
            return idm ? {
                id: idm[2],
                shortcode: idm[2],
                url: href,
                kind: idm[1] === 'reel' ? 'reel' : 'post',
                cover: img?.src || null,
                altText: img?.getAttribute('alt') || null,
            } : null;
        }).filter(Boolean);

        return {
            id: null,
            name,
            postsCount: m ? parse(m[1]) : null,
            topPosts,
        };
    }, kind);
}

async function scrapeTopComments(page, cap) {
    try {
        await page.waitForSelector('ul > div[role="button"], article ul', { timeout: 6000 });
    } catch {}
    let prev = 0;
    for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(1000);
        const count = await page.$$eval('article ul li', (els) => els.length).catch(() => 0);
        if (count >= cap || count === prev) break;
        prev = count;
    }
    return page.evaluate((cap) => {
        const nodes = Array.from(document.querySelectorAll('article ul li')).slice(0, cap);
        return nodes.map((n) => {
            const authorEl = n.querySelector('a');
            const textEl = n.querySelector('span');
            return {
                author: authorEl?.textContent?.trim() || null,
                text: textEl?.textContent?.trim() || null,
                profileUrl: authorEl?.href || null,
            };
        }).filter((c) => c.author || c.text);
    }, cap);
}

// ----- helpers -----

function num(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

function parseCutoff(str) {
    if (!str) return null;
    const trimmed = String(str).trim().toLowerCase();
    const abs = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (abs) return new Date(`${abs[1]}-${abs[2]}-${abs[3]}T00:00:00Z`);
    const rel = trimmed.match(/^(\d+)\s*(day|week|month|year)s?\s*ago$/);
    if (rel) {
        const n = parseInt(rel[1], 10);
        const unit = rel[2];
        const d = new Date();
        if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
        if (unit === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
        if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
        if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
        return d;
    }
    return null;
}

function applyDateFilter(posts) {
    if (!cutoffDate) return posts;
    return posts.filter((p) => {
        if (!p.createdAt) return true;
        const d = new Date(p.createdAt);
        return Number.isFinite(d.getTime()) && d >= cutoffDate;
    });
}

function enrichPostRow(post, userData) {
    const row = {
        type: post.kind || 'post',
        id: post.id,
        shortcode: post.shortcode,
        url: post.url,
        caption: post.caption || null,
        hashtags: post.hashtags || [],
        mentions: post.mentions || [],
        likes: num(post.likes),
        comments: num(post.comments),
        createdAt: post.createdAt || null,
        ownerUsername: post.ownerUsername || null,
        image: post.image || null,
        video: post.video || null,
        locationName: post.locationName || null,
        cover: post.cover || null,
        altText: includeMediaMetadata ? post.altText || null : undefined,
        sourceType: userData?.sourceType || null,
        source: userData?.source || null,
        scrapedAt: new Date().toISOString(),
    };
    if (detectSponsoredPosts) {
        row.isSponsored = isSponsored(row);
        row.sponsorSignals = sponsorSignals(row);
    }
    if (downloadMedia) {
        row.downloadUrl = row.video || row.image || row.cover || null;
    }
    return row;
}

function isSponsored(row) {
    const text = (row.caption || '').toLowerCase();
    if (/#ad\b|#sponsored|#paidpartnership|paid partnership|in partnership with/i.test(text)) return true;
    const tagBrands = row.mentions || [];
    if (tagBrands.some((m) => /brand|official|store|shop/i.test(m))) return true;
    return false;
}

function sponsorSignals(row) {
    const signals = [];
    const text = (row.caption || '').toLowerCase();
    if (/#ad\b/.test(text)) signals.push('#ad');
    if (/#sponsored/.test(text)) signals.push('#sponsored');
    if (/#paidpartnership/.test(text)) signals.push('#paidpartnership');
    if (/paid partnership/.test(text)) signals.push('paid_partnership_label');
    if (/in partnership with/.test(text)) signals.push('in_partnership_with');
    return signals;
}

function extractMentions(caption) {
    if (!caption) return [];
    const matches = caption.match(/@[A-Za-z0-9_.]+/g) || [];
    return [...new Set(matches.map((m) => m.slice(1).replace(/\.+$/, '').toLowerCase()))];
}

function computeEngagement(posts, followers) {
    const withLikes = posts.filter((p) => typeof p.likes === 'number');
    const withComments = posts.filter((p) => typeof p.comments === 'number');
    const avgLikes = withLikes.length ? Math.round(sum(withLikes.map((p) => p.likes)) / withLikes.length) : null;
    const avgComments = withComments.length ? Math.round(sum(withComments.map((p) => p.comments)) / withComments.length) : null;
    const engagementRate = avgLikes && followers ? +(((avgLikes + (avgComments || 0)) / followers) * 100).toFixed(3) : null;
    const dates = posts.map((p) => p.createdAt ? new Date(p.createdAt) : null).filter((d) => d && Number.isFinite(d.getTime()));
    let postsPerWeek = null;
    if (dates.length >= 2) {
        const newest = Math.max(...dates.map((d) => d.getTime()));
        const oldest = Math.min(...dates.map((d) => d.getTime()));
        const weeks = (newest - oldest) / (1000 * 60 * 60 * 24 * 7);
        if (weeks > 0) postsPerWeek = +(dates.length / weeks).toFixed(2);
    }
    return { avgLikes, avgComments, engagementRate, postsPerWeek, sampleSize: posts.length };
}

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
