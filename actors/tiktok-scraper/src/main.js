// TikTok Scraper
// Extracts videos, profiles, hashtags, search results, and music data from TikTok.
//
// Flow:
//   1. Build initial requests from hashtags, profiles, searchQueries, videoUrls
//   2. For a feed page (hashtag, profile, search): scroll to load videos, collect URLs, enqueue
//   3. For a video page: parse embedded JSON state and extract full detail record
//   4. Push one row per video with dedupeKey = video id
//
// TikTok renders feeds client side and embeds full data in a JSON blob at
// __UNIVERSAL_DATA_FOR_REHYDRATION__. When that blob is available, parse it.
// When it is missing (old layout or blocked), fall back to DOM scraping.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    hashtags = [],
    profiles = [],
    searchQueries = [],
    videoUrls = [],
    resultsPerPage = 100,
    profileScrapeSections = 'videos',
    searchSection = 'videos',
    downloadVideos = false,
    downloadSubtitles = false,
    subtitleLanguages = ['en'],
    scrapeComments = false,
    maxCommentsPerVideo = 0,
    countryCode = '',
    dedupe = true,
    maxVideosTotal = 500,
    proxyConfiguration: proxyInput,
} = input;

const cleanList = (arr) =>
    Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || '')).map((v) => v.trim()).filter(Boolean)
        : [];

const tags = cleanList(hashtags).map((t) => t.replace(/^#/, '').toLowerCase());
const profs = cleanList(profiles).map(normalizeProfile);
const queries = cleanList(searchQueries);
const directVideos = cleanList(videoUrls);

if (tags.length === 0 && profs.length === 0 && queries.length === 0 && directVideos.length === 0) {
    log.warning('No input provided. Add a video URL, profile, hashtag, or search query and run again.');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('tiktok-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-ids')) || [];
    for (const id of prev) seen.add(id);
}

const initialRequests = [];
for (const tag of tags) {
    initialRequests.push({
        url: `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,
        userData: { type: 'hashtag', source: tag, pushedForSource: 0 },
        uniqueKey: `hashtag:${tag}`,
    });
}
for (const handle of profs) {
    const section = profileScrapeSections === 'videos' ? '' : `/${profileScrapeSections}`;
    initialRequests.push({
        url: `https://www.tiktok.com/@${handle}${section}`,
        userData: { type: 'profile', source: handle, section: profileScrapeSections, pushedForSource: 0 },
        uniqueKey: `profile:${handle}:${profileScrapeSections}`,
    });
}
for (const q of queries) {
    const path = searchSection === 'top' ? 'search' : `search/${searchSection}`;
    initialRequests.push({
        url: `https://www.tiktok.com/${path}?q=${encodeURIComponent(q)}`,
        userData: { type: 'search', source: q, section: searchSection, pushedForSource: 0 },
        uniqueKey: `search:${searchSection}:${q}`,
    });
}
for (const url of directVideos) {
    initialRequests.push({ url, userData: { type: 'video' } });
}

let videosPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
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
                locales: countryCode ? [`en-${countryCode.toUpperCase()}`] : ['en-US'],
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
        if (videosPushed >= maxVideosTotal) {
            log.info(`Cap reached (${videosPushed}/${maxVideosTotal}), skipping ${request.url}`);
            return;
        }

        await page.setViewportSize({ width: 1440, height: 1800 });
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);

        const { type } = request.userData;

        if (type === 'video') {
            await handleVideo(page, request);
        } else {
            await handleFeed(page, request, c);
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && videosPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen]);
}

log.info(`Run complete. Pushed ${videosPushed} videos.`);
await Actor.exit();

// ---------- helpers ----------

function normalizeProfile(raw) {
    let v = String(raw).trim();
    if (!v) return '';
    if (v.startsWith('http')) {
        const m = v.match(/tiktok\.com\/@([^/?#]+)/i);
        if (m) v = m[1];
    }
    return v.replace(/^@/, '');
}

async function dismissConsent(page) {
    const selectors = [
        'button:has-text("Accept all")',
        'button:has-text("Allow all")',
        'button[aria-label*="Accept all"]',
        'div[data-e2e="modal-close-inner-button"]',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(600);
            }
        } catch {}
    }
}

async function readRehydrationState(page) {
    return page.evaluate(() => {
        const el = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (!el) return null;
        try {
            return JSON.parse(el.textContent || '{}');
        } catch {
            return null;
        }
    });
}

async function handleFeed(page, request, crawler) {
    const { type, source, section } = request.userData;
    const label = section ? `${type}/${section}` : type;
    log.info(`Feed: ${label} "${source}"`);

    try {
        await page.waitForSelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(3500);

    if (type === 'profile') {
        await pushProfileRow(page, source);
    }

    const cap = Math.min(resultsPerPage, maxVideosTotal - videosPushed);
    const maxScrolls = Math.max(4, Math.ceil(cap / 8) + 4);

    let prev = 0;
    let last = 0;
    let stable = 0;
    for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
        await page.waitForTimeout(1800);
        const count = await page.evaluate(
            () => document.querySelectorAll('a[href*="/video/"]').length,
        );
        log.debug(`scroll ${i + 1}/${maxScrolls} -> ${count} video links`);
        last = count;
        if (count >= cap) break;
        if (count === prev) {
            stable += 1;
            if (stable >= 2 && count > 0) break;
        } else {
            stable = 0;
        }
        prev = count;
    }

    if (last === 0) {
        const title = await page.title().catch(() => '');
        const finalUrl = page.url();
        if (/login|verify|captcha|unusual traffic/i.test(title + finalUrl)) {
            throw new Error(`Blocked on ${label}: title="${title}" url="${finalUrl}"`);
        }
        log.warning(`No feed items for ${label} "${source}" (title="${title}")`);
        return;
    }

    const urls = await page.evaluate((cap) => {
        const anchors = document.querySelectorAll('a[href*="/video/"]');
        const out = [];
        const s = new Set();
        for (const a of anchors) {
            const href = a.href.split('?')[0];
            if (!/\/video\/\d+/.test(href)) continue;
            if (!s.has(href)) {
                s.add(href);
                out.push(href);
                if (out.length >= cap) break;
            }
        }
        return out;
    }, cap);

    log.info(`${label} "${source}" -> ${urls.length} video URLs`);

    for (const url of urls) {
        await crawler.addRequests([
            {
                url,
                userData: { type: 'video', sourceType: type, source, section: section || null },
            },
        ]);
    }
}

async function handleVideo(page, request) {
    try {
        await page.waitForSelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(1200);

    const state = await readRehydrationState(page);

    const detailScope = state?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
    if (detailScope && detailScope.statusCode && detailScope.statusCode !== 0 && !detailScope.itemInfo) {
        log.warning(`Video unavailable (${detailScope.statusCode} ${detailScope.statusMsg}): ${request.url}`);
        return;
    }

    let record = null;
    if (state) record = extractFromState(state);
    if (!record) record = await extractFromDom(page);

    if (!record || !record.id) {
        log.warning(`No video data parsed: ${request.url}`);
        return;
    }

    if (dedupe && seen.has(record.id)) {
        log.info(`Skipped duplicate: ${record.id}`);
        return;
    }
    seen.add(record.id);

    const { sourceType, source, section } = request.userData;
    record.sourceType = sourceType || 'video';
    record.source = source || null;
    if (section) record.sourceSection = section;
    record.scrapedAt = new Date().toISOString();
    record.countryCode = countryCode || null;

    if (downloadVideos && record.downloadAddr) {
        record.downloadUrl = record.downloadAddr;
    }
    if (downloadSubtitles) {
        record.subtitles = pickSubtitles(record.subtitlesRaw, subtitleLanguages);
    }
    if (scrapeComments && maxCommentsPerVideo > 0) {
        record.comments = await scrapeTopComments(page, maxCommentsPerVideo);
    }

    delete record.subtitlesRaw;

    await Actor.pushData(record);
    videosPushed += 1;
    log.info(`Pushed video ${record.id} by @${record.authorUsername || '?'} (${videosPushed}/${maxVideosTotal})`);
}

async function pushProfileRow(page, handle) {
    const state = await readRehydrationState(page);
    const userDetail = state?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
    if (!userDetail?.user?.id) return;
    const user = userDetail.user;
    const stats = userDetail.stats || userDetail.statsV2 || {};
    const row = {
        type: 'profile',
        id: user.id,
        url: `https://www.tiktok.com/@${user.uniqueId}`,
        username: user.uniqueId,
        nickname: user.nickname || null,
        verified: !!user.verified,
        privateAccount: !!user.privateAccount,
        signature: user.signature || null,
        avatar: user.avatarLarger || user.avatarMedium || null,
        region: user.region || null,
        followers: num(stats.followerCount),
        following: num(stats.followingCount),
        hearts: num(stats.heartCount ?? stats.heart),
        videoCount: num(stats.videoCount),
        friendCount: num(stats.friendCount),
        source: handle,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(row);
    log.info(`Pushed profile @${row.username} (followers=${row.followers}, videos=${row.videoCount})`);
}

function extractFromState(state) {
    const scope =
        state?.__DEFAULT_SCOPE__ ||
        state?.['webapp.video-detail'] ||
        state;
    const detail = scope?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!detail) return null;

    const author = detail.author || {};
    const stats = detail.stats || detail.statsV2 || {};
    const music = detail.music || {};
    const video = detail.video || {};

    const hashtagsArr = (detail.textExtra || [])
        .filter((t) => t.hashtagName)
        .map((t) => t.hashtagName);

    return {
        type: 'video',
        id: detail.id,
        url: `https://www.tiktok.com/@${author.uniqueId}/video/${detail.id}`,
        text: detail.desc || null,
        createTime: detail.createTime ? new Date(detail.createTime * 1000).toISOString() : null,
        duration: video.duration || null,
        cover: video.cover || video.originCover || null,
        authorId: author.id || null,
        authorUsername: author.uniqueId || null,
        authorNickname: author.nickname || null,
        authorVerified: !!author.verified,
        authorSignature: author.signature || null,
        authorAvatar: author.avatarLarger || author.avatarMedium || null,
        authorFollowers: num(detail.authorStats?.followerCount),
        authorFollowing: num(detail.authorStats?.followingCount),
        authorHearts: num(detail.authorStats?.heartCount),
        authorVideoCount: num(detail.authorStats?.videoCount),
        plays: num(stats.playCount),
        likes: num(stats.diggCount),
        comments: num(stats.commentCount),
        shares: num(stats.shareCount),
        saves: num(stats.collectCount),
        hashtags: hashtagsArr,
        musicId: music.id || null,
        musicTitle: music.title || null,
        musicAuthor: music.authorName || null,
        musicOriginal: music.original === true,
        musicUrl: music.playUrl || null,
        downloadAddr: video.downloadAddr || video.playAddr || null,
        subtitlesRaw: video.subtitleInfos || null,
    };
}

function num(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
}

async function extractFromDom(page) {
    return page.evaluate(() => {
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;
        const url = window.location.href;
        const m = url.match(/\/@([^/]+)\/video\/(\d+)/);
        if (!m) return null;
        const parseCount = (s) => {
            if (!s) return null;
            const t = s.trim().toUpperCase().replace(',', '.');
            const mult = t.endsWith('K') ? 1e3 : t.endsWith('M') ? 1e6 : t.endsWith('B') ? 1e9 : 1;
            const n = parseFloat(t);
            return Number.isFinite(n) ? Math.round(n * mult) : null;
        };
        return {
            id: m[2],
            url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}`,
            text: text('h1[data-e2e="browse-video-desc"]') || text('[data-e2e="video-desc"]'),
            authorUsername: m[1],
            authorNickname: text('[data-e2e="browse-username"]') || text('[data-e2e="user-title"]'),
            likes: parseCount(text('[data-e2e="like-count"]') || text('[data-e2e="browse-like-count"]')),
            comments: parseCount(text('[data-e2e="comment-count"]') || text('[data-e2e="browse-comment-count"]')),
            shares: parseCount(text('[data-e2e="share-count"]') || text('[data-e2e="browse-share-count"]')),
            musicTitle: text('[data-e2e="browse-music"]') || text('[data-e2e="video-music"]'),
            cover: attr('img[alt*="created by"]', 'src'),
            hashtags: Array.from(document.querySelectorAll('a[href*="/tag/"]')).map((a) => a.textContent?.replace(/^#/, '').trim()).filter(Boolean),
        };
    });
}

function pickSubtitles(infos, langs) {
    if (!Array.isArray(infos) || infos.length === 0) return null;
    for (const lang of langs) {
        const match = infos.find((s) => (s.LanguageCodeName || s.LanguageID || '').toLowerCase().startsWith(lang.toLowerCase()));
        if (match) {
            return {
                language: match.LanguageCodeName || match.LanguageID,
                url: match.Url || match.UrlExpire,
                format: match.Format || 'webvtt',
            };
        }
    }
    const first = infos[0];
    return {
        language: first.LanguageCodeName || first.LanguageID,
        url: first.Url || first.UrlExpire,
        format: first.Format || 'webvtt',
    };
}

async function scrapeTopComments(page, cap) {
    try {
        await page.waitForSelector('[data-e2e="comment-level-1"]', { timeout: 8000 });
    } catch {
        return [];
    }
    let prev = 0;
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(1000);
        const count = await page.$$eval('[data-e2e="comment-level-1"]', (els) => els.length);
        if (count >= cap || count === prev) break;
        prev = count;
    }
    return page.evaluate((cap) => {
        const nodes = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]')).slice(0, cap);
        return nodes.map((n) => ({
            author: n.querySelector('[data-e2e="comment-username-1"]')?.textContent?.trim() || null,
            text: n.querySelector('[data-e2e="comment-level-1"] p')?.textContent?.trim() || n.textContent?.trim() || null,
            likes: (() => {
                const s = n.querySelector('[data-e2e="comment-like-count"]')?.textContent?.trim();
                if (!s) return null;
                const t = s.toUpperCase().replace(',', '.');
                const mult = t.endsWith('K') ? 1e3 : t.endsWith('M') ? 1e6 : 1;
                const x = parseFloat(t);
                return Number.isFinite(x) ? Math.round(x * mult) : null;
            })(),
        }));
    }, cap);
}
