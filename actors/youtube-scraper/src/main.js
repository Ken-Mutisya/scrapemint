// YouTube Scraper Pro
//
// Scrape YouTube videos, channels, playlists, shorts, and live streams.
// Each row ships video metadata, channel intelligence, engagement, transcripts
// in multiple languages, top comments with replies, chapters, most replayed
// heatmap, related videos, and music credits.
//
// Strategy
// --------
// 1. Parse each input (search terms, URLs, video IDs, channel handles) into a
//    typed request: search, watch, channel, playlist, hashtag.
// 2. Listing handlers walk ytInitialData and queue watch requests for every
//    video they find, scrolling until the cap is hit.
// 3. Watch handler reads ytInitialData + ytInitialPlayerResponse and parses
//    every enrichment field the user asked for (transcript, comments, chapters,
//    most replayed, music, related, end screens, streams).
// 4. Channel stats are resolved once per distinct channel ID and cached.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const YT_HOST = 'https://www.youtube.com';

const SORT_PARAM = {
    relevance: 'CAASAhAB',
    uploadDate: 'CAI%3D',
    viewCount: 'CAMSAhAB',
    rating: 'CAESAhAB',
};

const UPLOAD_DATE_PARAM = {
    hour: 'EgIIAQ%3D%3D',
    today: 'EgIIAg%3D%3D',
    week: 'EgIIAw%3D%3D',
    month: 'EgIIBA%3D%3D',
    year: 'EgIIBQ%3D%3D',
};

const DURATION_PARAM = {
    short: 'EgIYAQ%3D%3D',
    medium: 'EgIYAw%3D%3D',
    long: 'EgIYAg%3D%3D',
};

const FEATURE_PARAM = {
    live: 'EgJAAQ%3D%3D',
    fourK: 'EgJwAQ%3D%3D',
    hd: 'EgIgAQ%3D%3D',
    subtitles: 'EgIoAQ%3D%3D',
    creativeCommons: 'EgIwAQ%3D%3D',
    vr360: 'EgJ4AQ%3D%3D',
    hdr: 'EgPIAQE%3D',
    purchased: 'EgJIAQ%3D%3D',
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    startUrls = [],
    videoIds = [],
    channelHandles = [],

    maxVideosPerSearch = 15,
    maxShortsPerSearch = 0,
    maxStreamsPerSearch = 0,
    maxVideosPerChannel = 25,
    maxVideosPerPlaylist = 50,

    uploadDate = 'any',
    duration = 'any',
    sortBy = 'relevance',
    features = [],
    dateFrom = '',
    dateTo = '',

    extractTranscript = false,
    transcriptLanguages = ['en'],
    extractTopComments = false,
    maxComments = 50,
    extractCommentReplies = false,
    extractChapters = true,
    extractRelatedVideos = false,
    extractChannelStats = true,
    extractMusicAndCredits = false,
    extractMostReplayed = false,
    extractStreamUrls = false,
    extractEndScreens = false,

    region = 'US',
    language = 'en',
    // Defaults to false. This is a search tool, not a monitor: a buyer who
    // repeats a query wants the full result set again, and the dedupe key is an
    // immutable id, so `true` suppressed each item permanently after its first
    // appearance. Verified 2026-08-11 by re-running each actor on its own
    // prefill against a warm store. Set it to true deliberately to poll for
    // new items only, accepting that a run finding nothing new returns no rows.

    dedupe = false,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const dateFromTs = parseDateBound(dateFrom);
const dateToTs = parseDateBound(dateTo);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('youtube-videos-seen') : null;
const seenVideoIds = new Set(seenStore ? (await seenStore.getValue('seen-video-ids')) || [] : []);
const channelStatsCache = new Map();
const channelStatsPending = new Set();
const sourceCounts = new Map();
let pushedRows = 0;

const initial = buildInitialRequests();
if (initial.length === 0) {
    log.warning('No valid input. Provide at least one search term, URL, video ID, or channel handle.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 150,
    maxRequestRetries: 4,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 40,
        sessionOptions: { maxUsageCount: 30 },
    },
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                operatingSystems: ['macos', 'windows'],
                locales: [`${language}-${region}`, 'en-US'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': `${language}-${region},${language};q=0.9,en;q=0.8`,
                'Upgrade-Insecure-Requests': '1',
            });
            try {
                await page.context().addCookies([
                    { name: 'CONSENT', value: 'YES+srp.gws-20230531-0-RC2.en-US+FX+1', domain: '.youtube.com', path: '/' },
                    { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.youtube.com', path: '/' },
                    { name: 'PREF', value: `tz=UTC&hl=${language}&gl=${region}&f6=40000000`, domain: '.youtube.com', path: '/' },
                    { name: 'VISITOR_INFO1_LIVE', value: 'oKckVSqvaGw', domain: '.youtube.com', path: '/' },
                    { name: 'YSC', value: 'BiCUU3-5Gdk', domain: '.youtube.com', path: '/' },
                ]);
            } catch {}
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData?.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'channel') return handleChannel(ctx);
        if (t === 'playlist') return handlePlaylist(ctx);
        if (t === 'hashtag') return handleHashtag(ctx);
        if (t === 'watch') return handleWatch(ctx);
        if (t === 'channelStats') return handleChannelStats(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initial);
await crawler.run();

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-video-ids', [...seenVideoIds]);

log.info(`Run complete. Videos pushed: ${pushedRows}.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Seed builders ----------

function buildInitialRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    for (const term of cleanArr(searchTerms)) {
        out.push(makeSearchRequest(term));
    }

    for (const url of cleanArr(startUrls)) {
        const parsed = parseYoutubeUrl(url);
        if (!parsed) continue;
        if (parsed.kind === 'watch') out.push(makeWatchRequest(parsed.videoId, url));
        else if (parsed.kind === 'channel') out.push(makeChannelRequest(parsed.channelKey, url));
        else if (parsed.kind === 'playlist') out.push(makePlaylistRequest(parsed.playlistId, url));
        else if (parsed.kind === 'hashtag') out.push(makeHashtagRequest(parsed.tag, url));
        else if (parsed.kind === 'search') out.push({
            url,
            userData: { type: 'search', sourceKey: `search:${url}`, term: parsed.q || url },
            uniqueKey: `search:${url}`,
        });
    }

    for (const id of cleanArr(videoIds)) {
        const cleaned = String(id).trim();
        const m = cleaned.match(/[A-Za-z0-9_-]{11}/);
        if (m) out.push(makeWatchRequest(m[0], null));
    }

    for (const handle of cleanArr(channelHandles)) {
        const h = String(handle).trim().replace(/^@/, '');
        if (!h) continue;
        out.push(makeChannelRequest(`@${h}`, null));
    }

    return out;
}

function makeSearchRequest(term) {
    const params = new URLSearchParams({ search_query: term, hl: language, gl: region });
    let url = `${YT_HOST}/results?${params.toString()}`;
    const sp = buildSearchSpFilter();
    if (sp) url += `&sp=${sp}`;
    const sourceKey = `search:${term}`;
    return {
        url,
        userData: { type: 'search', sourceKey, term },
        uniqueKey: sourceKey,
    };
}

function buildSearchSpFilter() {
    if (sortBy && sortBy !== 'relevance') return SORT_PARAM[sortBy];
    if (uploadDate && uploadDate !== 'any') return UPLOAD_DATE_PARAM[uploadDate];
    if (duration && duration !== 'any') return DURATION_PARAM[duration];
    if (Array.isArray(features) && features.length === 1) return FEATURE_PARAM[features[0]];
    return null;
}

function makeWatchRequest(videoId, originatingUrl) {
    return {
        url: `${YT_HOST}/watch?v=${videoId}&hl=${language}&gl=${region}`,
        userData: {
            type: 'watch',
            videoId,
            originatingStartUrl: originatingUrl || null,
            sourceKey: `watch:${videoId}`,
        },
        uniqueKey: `watch:${videoId}`,
    };
}

function makeChannelRequest(channelKey, originatingUrl) {
    const path = channelKey.startsWith('UC') ? `/channel/${channelKey}` : `/${channelKey}`;
    const url = `${YT_HOST}${path}/videos?hl=${language}&gl=${region}`;
    const sourceKey = `channel:${channelKey}`;
    return {
        url,
        userData: { type: 'channel', channelKey, sourceKey, originatingStartUrl: originatingUrl || null },
        uniqueKey: sourceKey,
    };
}

function makePlaylistRequest(playlistId, originatingUrl) {
    return {
        url: `${YT_HOST}/playlist?list=${playlistId}&hl=${language}&gl=${region}`,
        userData: { type: 'playlist', playlistId, sourceKey: `playlist:${playlistId}`, originatingStartUrl: originatingUrl || null },
        uniqueKey: `playlist:${playlistId}`,
    };
}

function makeHashtagRequest(tag, originatingUrl) {
    return {
        url: `${YT_HOST}/hashtag/${encodeURIComponent(tag)}?hl=${language}&gl=${region}`,
        userData: { type: 'hashtag', tag, sourceKey: `hashtag:${tag}`, originatingStartUrl: originatingUrl || null },
        uniqueKey: `hashtag:${tag}`,
    };
}

function parseYoutubeUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        if (!/^(youtube\.com|m\.youtube\.com|youtu\.be|music\.youtube\.com)$/.test(host)) return null;
        if (host === 'youtu.be') {
            const id = u.pathname.replace(/^\//, '').split('/')[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: 'watch', videoId: id } : null;
        }
        const path = u.pathname;
        if (path === '/watch' || path === '/watch/') {
            const v = u.searchParams.get('v');
            if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { kind: 'watch', videoId: v };
        }
        let m = path.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
        if (m) return { kind: 'watch', videoId: m[1] };
        m = path.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
        if (m) return { kind: 'watch', videoId: m[1] };
        if (path === '/playlist' || path === '/playlist/') {
            const list = u.searchParams.get('list');
            if (list) return { kind: 'playlist', playlistId: list };
        }
        m = path.match(/^\/(@[\w.\-]+)/);
        if (m) return { kind: 'channel', channelKey: m[1] };
        m = path.match(/^\/channel\/(UC[\w-]{20,24})/);
        if (m) return { kind: 'channel', channelKey: m[1] };
        m = path.match(/^\/(c|user)\/([\w.\-]+)/);
        if (m) return { kind: 'channel', channelKey: `${m[1]}/${m[2]}` };
        m = path.match(/^\/hashtag\/([^/?#]+)/);
        if (m) return { kind: 'hashtag', tag: decodeURIComponent(m[1]) };
        if (path === '/results' || path === '/results/') {
            const q = u.searchParams.get('search_query') || u.searchParams.get('q') || '';
            return { kind: 'search', q };
        }
        return null;
    } catch { return null; }
}

// ---------- Listing handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const sourceKey = request.userData.sourceKey;
    const have = sourceCounts.get(sourceKey) || 0;
    const cap = capForSource('search');
    if (have >= cap) return;

    await waitForRoot(page);
    await dismissConsent(page);
    await scrollUntilEnough(page, cap, () => countVideoCards(page));

    const items = await extractListingFromYtInitialData(page);
    log.info(`Search "${request.userData.term}": ${items.length} items collected.`);
    await queueVideos(c, items, sourceKey, 'search');
}

async function handleChannel({ page, request, crawler: c }) {
    const sourceKey = request.userData.sourceKey;
    const cap = maxVideosPerChannel || Infinity;
    if ((sourceCounts.get(sourceKey) || 0) >= cap) return;

    await waitForRoot(page);
    await dismissConsent(page);
    await scrollUntilEnough(page, cap, () => countVideoCards(page));

    const items = await extractListingFromYtInitialData(page);
    const filtered = items.filter((it) => withinDateBounds(it.publishedTimeText));
    log.info(`Channel ${request.userData.channelKey}: ${items.length} items (${filtered.length} after date filter).`);
    await queueVideos(c, filtered, sourceKey, 'channel');
}

async function handlePlaylist({ page, request, crawler: c }) {
    const sourceKey = request.userData.sourceKey;
    const cap = maxVideosPerPlaylist || Infinity;
    if ((sourceCounts.get(sourceKey) || 0) >= cap) return;

    await waitForRoot(page);
    await dismissConsent(page);
    await scrollUntilEnough(page, cap, () => countPlaylistRows(page));

    const items = await extractListingFromYtInitialData(page);
    const filtered = items.filter((it) => withinDateBounds(it.publishedTimeText));
    log.info(`Playlist ${request.userData.playlistId}: ${items.length} items (${filtered.length} after date filter).`);
    await queueVideos(c, filtered, sourceKey, 'playlist');
}

async function handleHashtag({ page, request, crawler: c }) {
    const sourceKey = request.userData.sourceKey;
    const cap = capForSource('hashtag');
    if ((sourceCounts.get(sourceKey) || 0) >= cap) return;

    await waitForRoot(page);
    await dismissConsent(page);
    await scrollUntilEnough(page, cap, () => countVideoCards(page));

    const items = await extractListingFromYtInitialData(page);
    log.info(`Hashtag #${request.userData.tag}: ${items.length} items collected.`);
    await queueVideos(c, items, sourceKey, 'hashtag');
}

async function queueVideos(c, items, sourceKey, sourceType) {
    const cap = capForSource(sourceType);
    const have = sourceCounts.get(sourceKey) || 0;
    const remaining = cap - have;
    if (remaining <= 0) return;

    const toQueue = [];
    for (const it of items) {
        if (toQueue.length >= remaining) break;
        if (!it.videoId) continue;
        if (sourceType === 'search') {
            if (it.isShort && (sourceCounts.get(`${sourceKey}:short`) || 0) >= (maxShortsPerSearch || 0)) continue;
            if (it.isLive && (sourceCounts.get(`${sourceKey}:live`) || 0) >= (maxStreamsPerSearch || 0)) continue;
            if (!it.isShort && !it.isLive && (sourceCounts.get(`${sourceKey}:video`) || 0) >= (maxVideosPerSearch || 0)) continue;
        }
        if (dedupe && seenVideoIds.has(it.videoId)) continue;
        toQueue.push(makeWatchRequest(it.videoId, sourceKey));
        if (it.isShort) sourceCounts.set(`${sourceKey}:short`, (sourceCounts.get(`${sourceKey}:short`) || 0) + 1);
        else if (it.isLive) sourceCounts.set(`${sourceKey}:live`, (sourceCounts.get(`${sourceKey}:live`) || 0) + 1);
        else sourceCounts.set(`${sourceKey}:video`, (sourceCounts.get(`${sourceKey}:video`) || 0) + 1);
    }
    if (toQueue.length > 0) {
        await c.addRequests(toQueue);
        sourceCounts.set(sourceKey, have + toQueue.length);
    }
}

function capForSource(sourceType) {
    if (sourceType === 'search' || sourceType === 'hashtag') {
        const total = (maxVideosPerSearch || 0) + (maxShortsPerSearch || 0) + (maxStreamsPerSearch || 0);
        return total > 0 ? total : Infinity;
    }
    if (sourceType === 'channel') return maxVideosPerChannel || Infinity;
    if (sourceType === 'playlist') return maxVideosPerPlaylist || Infinity;
    return Infinity;
}

// ---------- Watch handler ----------

async function handleWatch({ page, request, crawler: c }) {
    const videoId = request.userData.videoId;
    if (dedupe && seenVideoIds.has(videoId)) return;

    await waitForRoot(page);
    await dismissConsent(page);

    try { await page.waitForSelector('ytd-watch-flexy, #player, ytd-app', { timeout: 12000 }); } catch {}
    try { await page.waitForFunction(() => !!window.ytInitialPlayerResponse, { timeout: 8000 }); } catch {}

    if (extractTopComments) {
        await page.evaluate(() => window.scrollTo(0, 600)).catch(() => {});
        await sleepMs(800);
        await scrollPage(page, 4);
    }

    const raw = await extractWatchData(page, {
        wantStreams: extractStreamUrls,
        wantEndScreens: extractEndScreens,
        wantChapters: extractChapters,
        wantMostReplayed: extractMostReplayed,
        wantMusic: extractMusicAndCredits,
        wantRelated: extractRelatedVideos,
    });

    if (!raw || !raw.videoId) {
        const challenged = await page.evaluate(() => {
            const t = (document.body?.innerText || '');
            return /Sign in to confirm|not a bot|unusual traffic|This helps protect our community/i.test(t);
        }).catch(() => false);
        if (challenged) {
            request.session?.markBad();
            throw new Error('YouTube bot challenge');
        }
        log.warning(`No watch data for ${videoId}. Possibly age gated, removed, or region locked.`);
        return;
    }

    let transcript = null;
    if (extractTranscript && raw.captionTracks?.length > 0) {
        transcript = await fetchTranscript(page, raw.captionTracks, transcriptLanguages);
    }

    let comments = null;
    if (extractTopComments) {
        comments = await collectComments(page, maxComments, extractCommentReplies);
    }

    let channelStats = null;
    if (extractChannelStats && raw.channel?.channelId) {
        channelStats = channelStatsCache.get(raw.channel.channelId) || null;
        if (!channelStats && !channelStatsPending.has(raw.channel.channelId)) {
            channelStatsPending.add(raw.channel.channelId);
            await queueChannelStats(c, raw.channel.channelId, raw.channel.handle);
        }
    }

    const row = assembleVideoRow(raw, transcript, comments, channelStats);
    await Actor.pushData(row);
    seenVideoIds.add(videoId);
    pushedRows += 1;
    if (pushedRows > 1) __chargeJobs.push(Actor.charge({ eventName: 'video_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    log.info(`Pushed ${videoId} ${(row.title || '').slice(0, 60)} | ${row.engagement.viewCount ?? '?'} views (${pushedRows})`);
}

async function handleChannelStats({ page, request }) {
    const channelId = request.userData.channelId;
    if (channelStatsCache.has(channelId)) return;
    await waitForRoot(page);
    await dismissConsent(page);
    const stats = await extractChannelMetadata(page);
    if (stats) channelStatsCache.set(channelId, stats);
}

async function queueChannelStats(c, channelId, handle) {
    const url = handle
        ? `${YT_HOST}/${handle.startsWith('@') ? handle : `@${handle}`}/about?hl=${language}&gl=${region}`
        : `${YT_HOST}/channel/${channelId}/about?hl=${language}&gl=${region}`;
    try {
        await c.addRequests([{
            url,
            userData: { type: 'channelStats', channelId, sourceKey: `channelStats:${channelId}` },
            uniqueKey: `channelStats:${channelId}`,
        }]);
    } catch {}
}

// ---------- Page-side extractors ----------

async function extractListingFromYtInitialData(page) {
    return page.evaluate(() => {
        const text = (t) => {
            if (!t) return '';
            if (typeof t === 'string') return t;
            if (t.simpleText) return t.simpleText;
            if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
            if (t.content?.simpleText) return t.content.simpleText;
            return '';
        };
        const pullVideoId = (r) => {
            if (r.videoId) return r.videoId;
            if (r.entityId && /^[A-Za-z0-9_-]{11}$/.test(r.entityId)) return r.entityId;
            const reel = r.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId
                || r.onTap?.watchEndpoint?.videoId;
            if (reel) return reel;
            if (r.contentId && /^[A-Za-z0-9_-]{11}$/.test(r.contentId)) return r.contentId;
            return null;
        };
        const RENDERERS = [
            'videoRenderer',
            'compactVideoRenderer',
            'gridVideoRenderer',
            'playlistVideoRenderer',
            'reelItemRenderer',
            'shortsLockupViewModel',
            'videoCardRenderer',
            'playlistPanelVideoRenderer',
        ];
        const out = [];
        const seen = new Set();
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(visit); return; }
            for (const key of RENDERERS) {
                const r = node[key];
                if (r) {
                    const vid = pullVideoId(r);
                    if (vid && !seen.has(vid)) {
                        seen.add(vid);
                        const title = text(r.title) || text(r.headline) || text(r.metadata?.lockupMetadataViewModel?.title);
                        const channelText = text(r.longBylineText) || text(r.shortBylineText) || text(r.ownerText);
                        const channelEndpoint = r.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint
                            || r.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint
                            || r.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
                        const isShortRenderer = key === 'reelItemRenderer' || key === 'shortsLockupViewModel';
                        const badgesJson = JSON.stringify(r.badges || []);
                        const isLive = /LIVE/i.test(badgesJson) || !!r.upcomingEventData || /LIVE NOW/i.test(text(r.title));
                        out.push({
                            videoId: vid,
                            title,
                            channelName: channelText,
                            channelId: channelEndpoint?.browseId || null,
                            channelHandle: channelEndpoint?.canonicalBaseUrl || null,
                            publishedTimeText: text(r.publishedTimeText),
                            viewCountText: text(r.viewCountText) || text(r.shortViewCountText),
                            lengthText: text(r.lengthText),
                            descriptionSnippet: text(r.descriptionSnippet) || text(r.detailedMetadataSnippets?.[0]?.snippetText),
                            isShort: isShortRenderer,
                            isLive,
                            thumbnail: r.thumbnail?.thumbnails?.[r.thumbnail.thumbnails.length - 1]?.url || null,
                        });
                    }
                }
            }
            Object.values(node).forEach(visit);
        };
        visit(window.ytInitialData || {});
        return out;
    }).catch(() => []);
}

async function extractWatchData(page, opts) {
    return page.evaluate((opts) => {
        const parseFromScripts = (key) => {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
                const t = s.textContent || '';
                const idx = t.indexOf(`var ${key} = `);
                if (idx === -1) continue;
                const start = t.indexOf('{', idx);
                if (start === -1) continue;
                let depth = 0;
                let end = -1;
                let inStr = false;
                let strCh = '';
                let escape = false;
                for (let i = start; i < t.length; i += 1) {
                    const ch = t[i];
                    if (escape) { escape = false; continue; }
                    if (inStr) {
                        if (ch === '\\') { escape = true; continue; }
                        if (ch === strCh) inStr = false;
                        continue;
                    }
                    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
                    if (ch === '{') depth += 1;
                    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
                }
                if (end === -1) continue;
                try { return JSON.parse(t.slice(start, end + 1)); } catch {}
            }
            return null;
        };
        const data = window.ytInitialData || parseFromScripts('ytInitialData') || {};
        const player = window.ytInitialPlayerResponse || parseFromScripts('ytInitialPlayerResponse') || {};
        const text = (t) => {
            if (!t) return '';
            if (typeof t === 'string') return t;
            if (t.simpleText) return t.simpleText;
            if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
            return '';
        };
        const numFromText = (s) => {
            if (!s) return null;
            const m = String(s).replace(/[ ]/g, ' ').match(/([\d,\.]+)/);
            return m ? parseInt(m[1].replace(/[,\.]/g, ''), 10) : null;
        };

        const vd = player.videoDetails || {};
        const mf = player.microformat?.playerMicroformatRenderer || {};
        const videoId = vd.videoId || null;
        if (!videoId) return null;

        const contents = data.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
        const primary = contents.find((c) => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer || {};
        const secondary = contents.find((c) => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer || {};

        // Like count — modern YouTube ships this via frameworkUpdates entity mutations.
        let likeCount = null;
        try {
            const muts = data.frameworkUpdates?.entityBatchUpdate?.mutations || [];
            for (const m of muts) {
                const lc = m?.payload?.likeCountEntity;
                if (!lc) continue;
                const fields = [lc.expandedLikeCountIfLiked, lc.expandedLikeCountIfDisliked, lc.expandedLikeCountIfIndifferent, lc.likeCountIfLiked, lc.likeCountIfDisliked, lc.likeCountIfIndifferent];
                for (const f of fields) {
                    const v = text(f) || (typeof f === 'string' ? f : null);
                    if (v && /\d/.test(v)) {
                        const n = numFromText(v);
                        if (n != null && n > 0) { likeCount = n; break; }
                    }
                }
                if (likeCount) break;
            }
        } catch {}
        if (!likeCount) {
            try {
                const blob = JSON.stringify(primary.videoActions?.menuRenderer?.topLevelButtons || {});
                const labels = [...blob.matchAll(/"(?:accessibilityText|label)":"([^"]*?)"/g)].map((m) => m[1]);
                for (const label of labels) {
                    if (/like/i.test(label) && /\d/.test(label)) {
                        const n = numFromText(label);
                        if (n != null && n > 0) { likeCount = n; break; }
                    }
                }
            } catch {}
        }
        if (!likeCount) {
            try {
                const sel = document.querySelector('like-button-view-model button[aria-label*="like" i], button[aria-label*="like this video" i]');
                const lbl = sel?.getAttribute('aria-label') || '';
                if (lbl) {
                    const n = numFromText(lbl);
                    if (n != null && n > 0) likeCount = n;
                }
            } catch {}
        }

        const viewCountFromPrimary = text(primary.viewCount?.videoViewCountRenderer?.viewCount)
            || text(primary.viewCount?.videoViewCountRenderer?.shortViewCount);

        const ownerRenderer = secondary.owner?.videoOwnerRenderer || {};
        const channelEndpoint = ownerRenderer.navigationEndpoint?.browseEndpoint || {};
        const channelHandleRaw = channelEndpoint.canonicalBaseUrl || mf.ownerProfileUrl || '';
        const channelHandleClean = channelHandleRaw.replace(/^.*\/(?=@)/, '').replace(/^\/+/, '');
        const channelHandle = channelHandleClean
            ? (channelHandleClean.startsWith('@') ? channelHandleClean : null)
            : null;

        const subscriberText = text(ownerRenderer.subscriberCountText);
        const description = text(secondary.attributedDescription?.content) || vd.shortDescription || text(secondary.description);

        let chapters = null;
        if (opts.wantChapters) {
            const panels = data.engagementPanels || [];
            for (const p of panels) {
                const root = p?.engagementPanelSectionListRenderer;
                if (!root) continue;
                const idJson = JSON.stringify(root.panelIdentifier || root.targetId || '');
                if (!/chapter/i.test(idJson)) continue;
                const macro = root.content?.macroMarkersListRenderer
                    || root.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.macroMarkersListRenderer;
                const items = macro?.contents || [];
                const out = [];
                for (const c of items) {
                    const e = c.macroMarkersListItemRenderer;
                    if (!e) continue;
                    out.push({
                        title: text(e.title),
                        // gate-ignore zero-coercion: chapter 1 really does start
                        // at second 0, and InnerTube omits startTimeSeconds when
                        // it is zero. Here absent means 0, not unknown.
                        startSeconds: parseInt(e.onTap?.watchEndpoint?.startTimeSeconds || e.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds || '0', 10),
                        thumbnail: e.thumbnail?.thumbnails?.[e.thumbnail.thumbnails.length - 1]?.url || null,
                    });
                }
                if (out.length > 0) { chapters = out; break; }
            }
        }

        let mostReplayed = null;
        if (opts.wantMostReplayed) {
            const findHeatmap = (root) => {
                const muts = root?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
                for (const m of muts) {
                    const list = m?.payload?.macroMarkersListEntity?.markersList;
                    const type = list?.markerType || '';
                    if (/HEATMAP/i.test(type) && Array.isArray(list.markers)) return list.markers;
                }
                return null;
            };
            const hm = findHeatmap(data) || findHeatmap(player);
            if (hm) {
                mostReplayed = hm.slice(0, 200)
                    .map((p) => {
                        const startMs = numOrNull(p.startMillis);
                        const durationMs = numOrNull(p.durationMillis);
                        return {
                            startSeconds: startMs === null ? null : startMs / 1000,
                            durationSeconds: durationMs === null ? null : durationMs / 1000,
                            // 0 is a real intensity (a cold segment), so absent
                            // has to be null or the two are indistinguishable.
                            intensityScore: numOrNull(p.intensityScoreNormalized),
                        };
                    })
                    // A marker with no position on the timeline is not a marker;
                    // publishing it at 0 would put it at the start of the video.
                    .filter((m) => m.startSeconds !== null);
            }
        }

        let music = null;
        if (opts.wantMusic) {
            const panels = data.engagementPanels || [];
            for (const p of panels) {
                const ident = JSON.stringify(p?.engagementPanelSectionListRenderer?.panelIdentifier || '');
                if (!/music|description/i.test(ident)) continue;
                const items = p.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer?.items || [];
                const tracks = [];
                for (const it of items) {
                    const card = it.videoDescriptionMusicSectionRenderer;
                    if (!card) continue;
                    for (const c of (card.carouselLockups || [])) {
                        const lock = c.carouselLockupRenderer;
                        if (!lock) continue;
                        const meta = {};
                        for (const f of (lock.infoRows || [])) {
                            const r = f.infoRowRenderer;
                            if (!r) continue;
                            meta[text(r.title).toLowerCase()] = text(r.defaultMetadata) || text(r.expandedMetadata);
                        }
                        if (Object.keys(meta).length > 0) tracks.push(meta);
                    }
                }
                if (tracks.length > 0) { music = tracks; break; }
            }
        }

        let related = null;
        if (opts.wantRelated) {
            const sec = data.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
            const out = [];
            for (const item of sec.slice(0, 50)) {
                const r = item.compactVideoRenderer;
                if (!r?.videoId) continue;
                out.push({
                    videoId: r.videoId,
                    title: text(r.title),
                    channelName: text(r.longBylineText) || text(r.shortBylineText),
                    viewCountText: text(r.viewCountText) || text(r.shortViewCountText),
                    publishedTimeText: text(r.publishedTimeText),
                    lengthText: text(r.lengthText),
                });
            }
            if (out.length > 0) related = out;
        }

        let endScreens = null;
        if (opts.wantEndScreens) {
            const els = player.endscreen?.endscreenRenderer?.elements || [];
            const out = [];
            for (const el of els) {
                const e = el.endscreenElementRenderer;
                if (!e) continue;
                out.push({
                    style: e.style,
                    title: text(e.title),
                    target: e.endpoint?.urlEndpoint?.url
                        || e.endpoint?.watchEndpoint?.videoId
                        || e.endpoint?.browseEndpoint?.browseId
                        || null,
                });
            }
            if (out.length > 0) endScreens = out;
        }

        let streams = null;
        if (opts.wantStreams) {
            const fmts = (player.streamingData?.formats || []).map((f) => ({
                itag: f.itag,
                mimeType: f.mimeType,
                quality: f.qualityLabel || f.quality,
                bitrate: f.bitrate,
                width: f.width || null,
                height: f.height || null,
                url: f.url || null,
                hasSignatureCipher: !!f.signatureCipher,
            }));
            const adaptive = (player.streamingData?.adaptiveFormats || []).slice(0, 30).map((f) => ({
                itag: f.itag,
                mimeType: f.mimeType,
                quality: f.qualityLabel || f.quality,
                bitrate: f.bitrate,
                width: f.width || null,
                height: f.height || null,
                fps: f.fps || null,
                audioSampleRate: f.audioSampleRate || null,
                url: f.url || null,
                hasSignatureCipher: !!f.signatureCipher,
            }));
            streams = {
                formats: fmts,
                adaptiveFormats: adaptive,
                hlsManifestUrl: player.streamingData?.hlsManifestUrl || null,
                dashManifestUrl: player.streamingData?.dashManifestUrl || null,
            };
        }

        const captionTracks = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t) => ({
            languageCode: t.languageCode,
            name: text(t.name),
            kind: t.kind || null,
            baseUrl: t.baseUrl,
            isAutogenerated: t.kind === 'asr',
        }));

        const lengthSeconds = parseInt(vd.lengthSeconds || '0', 10) || null;
        const isShortHeuristic = lengthSeconds != null && lengthSeconds <= 60 && (() => {
            const s = JSON.stringify(data?.engagementPanels || []);
            return /shorts/i.test(s);
        })();

        return {
            videoId,
            title: vd.title || text(primary.title),
            description,
            lengthSeconds,
            isLive: !!vd.isLiveContent,
            isShort: isShortHeuristic,
            isFamilySafe: mf.isFamilySafe ?? null,
            isUnlisted: mf.isUnlisted ?? null,
            category: mf.category || null,
            publishDate: mf.publishDate || null,
            uploadDate: mf.uploadDate || null,
            availableCountries: mf.availableCountries || null,
            keywords: vd.keywords || [],
            channel: {
                name: vd.author || text(ownerRenderer.title),
                channelId: vd.channelId || channelEndpoint.browseId || null,
                handle: channelHandle,
                url: channelEndpoint.canonicalBaseUrl
                    ? `https://www.youtube.com${channelEndpoint.canonicalBaseUrl}`
                    : (vd.channelId ? `https://www.youtube.com/channel/${vd.channelId}` : null),
                subscriberText,
                avatar: ownerRenderer.thumbnail?.thumbnails?.[ownerRenderer.thumbnail.thumbnails.length - 1]?.url || null,
                isVerified: !!(ownerRenderer.badges?.some((b) => /VERIFIED/i.test(JSON.stringify(b)))),
                isArtist: !!(ownerRenderer.badges?.some((b) => /ARTIST/i.test(JSON.stringify(b)))),
            },
            engagement: {
                viewCount: parseInt(vd.viewCount || '0', 10) || numFromText(viewCountFromPrimary),
                viewCountText: viewCountFromPrimary || null,
                likeCount,
                commentCountText: (() => {
                    for (const c of contents) {
                        const r = c.itemSectionRenderer?.contents?.[0]?.commentsEntryPointHeaderRenderer;
                        if (r) return text(r.commentCount);
                    }
                    return null;
                })(),
            },
            thumbnails: {
                default: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
                medium: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                high: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                standard: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
                maxres: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
            },
            captionTracks,
            chapters,
            mostReplayed,
            music,
            related,
            endScreens,
            streams,
        };
    }, opts).catch((err) => {
        log.debug(`extractWatchData failed: ${err?.message}`);
        return null;
    });
}

async function extractChannelMetadata(page) {
    return page.evaluate(() => {
        const data = window.ytInitialData || {};
        const meta = data.metadata?.channelMetadataRenderer || {};
        const header = data.header?.c4TabbedHeaderRenderer || data.header?.pageHeaderRenderer || {};
        const text = (t) => {
            if (!t) return '';
            if (typeof t === 'string') return t;
            if (t.simpleText) return t.simpleText;
            if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
            return '';
        };
        const numFromText = (s) => {
            if (!s) return null;
            const m = String(s).replace(/[ ]/g, ' ').match(/([\d.]+)\s*([KMB]?)/i);
            if (!m) return null;
            let n = parseFloat(m[1]);
            const suf = (m[2] || '').toUpperCase();
            if (suf === 'K') n *= 1000;
            else if (suf === 'M') n *= 1000000;
            else if (suf === 'B') n *= 1000000000;
            return Math.round(n);
        };
        const subText = text(header.subscriberCountText) || (() => {
            try {
                const rows = header.metadata?.contentMetadataViewModel?.metadataRows || [];
                for (const row of rows) {
                    for (const part of (row.metadataParts || [])) {
                        const v = text(part.text);
                        if (/subscriber|abonné|abonn|abonnent|suscriptor/i.test(v)) return v;
                    }
                }
            } catch {}
            return '';
        })();
        const videoCount = text(header.videosCountText) || (() => {
            try {
                const rows = header.metadata?.contentMetadataViewModel?.metadataRows || [];
                for (const row of rows) {
                    for (const part of (row.metadataParts || [])) {
                        const v = text(part.text);
                        if (/video|vidéo|videos/i.test(v)) return v;
                    }
                }
            } catch {}
            return '';
        })();

        const links = [];
        try {
            const headerLinks = header.links || header.headerLinks?.channelHeaderLinksViewModel?.links || [];
            for (const l of headerLinks) {
                const lv = l.channelExternalLinkViewModel;
                if (lv) {
                    const url = lv.link?.content || lv.link?.runs?.[0]?.text;
                    if (url) links.push({ title: text(lv.title), url });
                }
            }
        } catch {}

        return {
            channelId: meta.externalId || null,
            title: meta.title || null,
            description: meta.description || null,
            handle: (meta.vanityChannelUrl || '').replace(/^.*\//, '') || null,
            avatar: meta.avatar?.thumbnails?.[meta.avatar.thumbnails.length - 1]?.url || null,
            subscriberCount: numFromText(subText),
            subscriberText: subText || null,
            videoCount: numFromText(videoCount),
            videoCountText: videoCount || null,
            country: meta.country || null,
            keywords: meta.keywords || null,
            isFamilySafe: meta.isFamilySafe ?? null,
            links,
        };
    }).catch(() => null);
}

// ---------- Browser helpers ----------

async function waitForRoot(page) {
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        // YouTube may redirect to consent.youtube.com; wait until we land on
        // the canonical host before evaluating any expressions.
        await page.waitForFunction(
            () => /(^|\.)youtube\.com$/.test(location.hostname) && !/^\/(consent|sorry)/.test(location.pathname),
            { timeout: 15000 },
        ).catch(() => {});
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForFunction(() => !!window.ytInitialData, { timeout: 12000 }).catch(() => {});
    } catch {}
}

async function dismissConsent(page) {
    try {
        const onConsent = /\/consent\?|consent\.youtube\.com/.test(page.url());
        if (onConsent) {
            await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
        }
        const sel = 'button[aria-label*="Accept" i], button[aria-label*="agree" i], form[action*="consent"] button';
        const btn = await page.$(sel).catch(() => null);
        if (btn) {
            await Promise.all([
                page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {}),
                btn.click({ timeout: 3000 }).catch(() => {}),
            ]);
            await page.waitForFunction(() => !!window.ytInitialData, { timeout: 12000 }).catch(() => {});
        }
    } catch {}
}

async function scrollPage(page, steps = 4) {
    await page.evaluate(async (n) => {
        const h = document.body.scrollHeight;
        for (let i = 1; i <= n; i++) {
            window.scrollTo(0, (h * i) / n);
            await new Promise((r) => setTimeout(r, 400));
        }
    }, steps).catch(() => {});
}

async function scrollUntilEnough(page, cap, countFn) {
    const target = !cap || cap === Infinity ? 10000 : cap;
    let stagnant = 0;
    let last = 0;
    for (let i = 0; i < 30; i++) {
        const have = await countFn().catch(() => 0);
        if (have >= target) break;
        if (have === last) stagnant += 1; else stagnant = 0;
        if (stagnant >= 3) break;
        last = have;
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
        await sleepMs(900);
    }
}

async function countVideoCards(page) {
    return page.evaluate(() => document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model').length).catch(() => 0);
}

async function countPlaylistRows(page) {
    return page.evaluate(() => document.querySelectorAll('ytd-playlist-video-renderer').length).catch(() => 0);
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Comments + transcript ----------

async function fetchTranscript(page, captionTracks, prefs) {
    let pick = null;
    for (const lang of prefs) {
        pick = captionTracks.find((t) => t.languageCode === lang) || null;
        if (pick) break;
    }
    if (!pick) pick = captionTracks[0];
    if (!pick?.baseUrl) return null;

    let segments = [];
    for (const fmt of ['', '&fmt=srv3', '&fmt=json3']) {
        try {
            const body = await page.evaluate(async (url) => {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.text();
            }, `${pick.baseUrl}${fmt}`);
            segments = fmt === '&fmt=json3' ? parseJsonTranscript(body) : parseTimedText(body);
            if (segments.length > 0) break;
        } catch {}
    }

    if (segments.length === 0) {
        segments = await openTranscriptPanelAndRead(page);
    }

    if (segments.length === 0) return null;
    return {
        language: pick.languageCode,
        languageName: pick.name,
        isAutogenerated: !!pick.isAutogenerated,
        segments,
        text: segments.map((s) => s.text).join(' '),
    };
}

async function openTranscriptPanelAndRead(page) {
    try {
        // Expand description so the "Show transcript" button is visible.
        const expandSel = '#description tp-yt-paper-button#expand, ytd-text-inline-expander #expand';
        const expand = await page.$(expandSel);
        if (expand) await expand.click({ timeout: 1500 }).catch(() => {});
        await sleepMs(500);

        const opened = await page.evaluate(() => {
            const candidates = [...document.querySelectorAll('button, ytd-button-renderer, yt-button-shape')];
            for (const el of candidates) {
                const txt = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
                if (txt.includes('show transcript') || txt.includes('transcript')) {
                    el.click();
                    return true;
                }
            }
            return false;
        });
        if (!opened) return [];

        await page.waitForSelector('ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer', { timeout: 6000 }).catch(() => {});
        await sleepMs(700);

        return page.evaluate(() => {
            const out = [];
            const rows = [...document.querySelectorAll('ytd-transcript-segment-renderer')];
            const toSeconds = (text) => {
                const parts = String(text).trim().split(':').map((n) => parseInt(n, 10) || 0);
                if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                if (parts.length === 2) return parts[0] * 60 + parts[1];
                return 0;
            };
            for (const r of rows) {
                const ts = (r.querySelector('.segment-timestamp')?.textContent || '').trim();
                const text = (r.querySelector('.segment-text, yt-formatted-string.segment-text')?.textContent || '').replace(/\s+/g, ' ').trim();
                if (!text) continue;
                out.push({ start: toSeconds(ts), duration: 0, text });
            }
            for (let i = 0; i < out.length - 1; i += 1) {
                out[i].duration = Math.max(0, out[i + 1].start - out[i].start);
            }
            return out;
        }).catch(() => []);
    } catch {
        return [];
    }
}

function parseJsonTranscript(body) {
    if (!body) return [];
    try {
        const data = JSON.parse(body);
        const events = data.events || [];
        const out = [];
        for (const e of events) {
            const segs = e.segs || [];
            const txt = segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
            if (!txt || txt === '\n') continue;
            const start = (e.tStartMs || 0) / 1000;
            const duration = (e.dDurationMs || 0) / 1000;
            out.push({ start, duration, text: txt });
        }
        return out;
    } catch { return []; }
}

function parseTimedText(xml) {
    if (!xml) return [];
    const out = [];
    const decode = (s) => s
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
    const re = /<p[^>]*\bt="(\d+)"[^>]*(?:\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(xml))) {
        const startMs = parseInt(m[1], 10);
        const durMs = parseInt(m[2] || '0', 10);
        const inner = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!inner) continue;
        out.push({ start: startMs / 1000, duration: durMs / 1000, text: decode(inner) });
    }
    if (out.length === 0) {
        const re2 = /<text[^>]*\bstart="([^"]+)"[^>]*(?:\bdur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
        let m2;
        while ((m2 = re2.exec(xml))) {
            const inner = m2[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (!inner) continue;
            out.push({
                start: parseFloat(m2[1]),
                // Deliberately 0, not null: `dur` is an optional attribute and
                // all three transcript parsers here treat a missing duration as
                // 0, one of them as a placeholder it backfills from the next
                // cue's start. A cue duration is also summed downstream, so a
                // null would poison the arithmetic.
                // gate-ignore zero-coercion
                duration: parseFloat(m2[2] || '0'),
                text: decode(inner),
            });
        }
    }
    return out;
}

async function collectComments(page, max, withReplies) {
    if (!max || max <= 0) return [];
    try { await page.waitForSelector('ytd-comments #contents, ytd-comments-header-renderer', { timeout: 8000 }); } catch { return []; }

    let stagnant = 0;
    let lastCount = 0;
    for (let i = 0; i < 50; i++) {
        const have = await page.evaluate(() => document.querySelectorAll('ytd-comment-thread-renderer').length).catch(() => 0);
        if (have >= max) break;
        if (have === lastCount) stagnant += 1; else stagnant = 0;
        if (stagnant >= 3) break;
        lastCount = have;
        await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
        await sleepMs(900);
    }

    if (withReplies) {
        try {
            const replyButtons = await page.$$('ytd-comment-thread-renderer ytd-button-renderer#more-replies');
            for (let i = 0; i < Math.min(replyButtons.length, 30); i++) {
                await replyButtons[i].click().catch(() => {});
                await sleepMs(400);
            }
        } catch {}
    }

    return page.evaluate((cap) => {
        const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
        const rows = [...document.querySelectorAll('ytd-comment-thread-renderer')].slice(0, cap);
        return rows.map((row) => {
            const a = row.querySelector('a#author-text, #author-text a');
            const channelHref = a?.getAttribute('href') || '';
            const replies = [...row.querySelectorAll('ytd-comment-replies-renderer ytd-comment-renderer')].map((r) => ({
                author: text(r.querySelector('a#author-text, #author-text a')),
                text: text(r.querySelector('#content-text')),
                likeCount: text(r.querySelector('#vote-count-middle')) || null,
                publishedTime: text(r.querySelector('.published-time-text')),
            }));
            return {
                author: text(a),
                channelHandle: (() => {
                    const last = (channelHref || '').split('/').filter(Boolean).pop() || null;
                    return last && last.startsWith('@') ? last : null;
                })(),
                channelUrl: channelHref ? `https://www.youtube.com${channelHref}` : null,
                text: text(row.querySelector('#content-text')),
                likeCount: text(row.querySelector('#vote-count-middle')) || null,
                publishedTime: text(row.querySelector('.published-time-text')),
                pinned: !!row.querySelector('#pinned-comment-badge:not([hidden])'),
                hearted: !!row.querySelector('ytd-creator-heart-renderer'),
                replyCountText: text(row.querySelector('#more-replies, ytd-button-renderer.more-button')) || null,
                replies,
            };
        });
    }, max).catch(() => []);
}

// ---------- Row assembly + parsers ----------

function assembleVideoRow(raw, transcript, comments, channelStats) {
    const lengthSeconds = raw.lengthSeconds || null;
    const isShort = raw.isShort || (lengthSeconds != null && lengthSeconds <= 60 && lengthSeconds > 0);
    const channel = {
        ...raw.channel,
        ...(channelStats ? {
            subscriberCount: channelStats.subscriberCount,
            videoCount: channelStats.videoCount,
            country: channelStats.country,
            description: channelStats.description,
            links: channelStats.links,
            keywords: channelStats.keywords,
        } : {}),
    };

    return {
        videoId: raw.videoId,
        url: `https://www.youtube.com/watch?v=${raw.videoId}`,
        shortsUrl: isShort ? `https://www.youtube.com/shorts/${raw.videoId}` : null,
        embedUrl: `https://www.youtube.com/embed/${raw.videoId}`,
        type: isShort ? 'short' : (raw.isLive ? 'live' : 'video'),
        title: raw.title,
        description: raw.description || null,
        durationSeconds: lengthSeconds,
        durationText: secondsToHHMMSS(lengthSeconds),
        publishDate: raw.publishDate || null,
        uploadDate: raw.uploadDate || null,
        category: raw.category || null,
        keywords: raw.keywords || [],
        channel,
        engagement: {
            viewCount: raw.engagement.viewCount,
            likeCount: raw.engagement.likeCount,
            commentCount: parseFlexibleNumber(raw.engagement.commentCountText),
            commentCountText: raw.engagement.commentCountText || null,
            engagementRate: computeEngagementRate(raw.engagement),
        },
        flags: {
            isLive: !!raw.isLive,
            isShort: !!isShort,
            isFamilySafe: raw.isFamilySafe,
            isUnlisted: raw.isUnlisted,
            availableCountries: raw.availableCountries,
            hasCaptions: (raw.captionTracks || []).length > 0,
            hasChapters: !!(raw.chapters && raw.chapters.length > 0),
            hasMostReplayed: !!(raw.mostReplayed && raw.mostReplayed.length > 0),
            hasMusicCredits: !!(raw.music && raw.music.length > 0),
        },
        thumbnails: raw.thumbnails,
        chapters: extractChapters ? raw.chapters : undefined,
        mostReplayed: extractMostReplayed ? raw.mostReplayed : undefined,
        music: extractMusicAndCredits ? raw.music : undefined,
        relatedVideos: extractRelatedVideos ? raw.related : undefined,
        endScreens: extractEndScreens ? raw.endScreens : undefined,
        captionTracks: (raw.captionTracks || []).map((t) => ({
            languageCode: t.languageCode,
            name: t.name,
            isAutogenerated: t.isAutogenerated,
        })),
        transcript: extractTranscript ? transcript : undefined,
        topComments: extractTopComments ? comments : undefined,
        streams: extractStreamUrls ? raw.streams : undefined,
        scrapedAt: new Date().toISOString(),
    };
}

function computeEngagementRate({ viewCount, likeCount }) {
    if (!viewCount || !likeCount || viewCount <= 0) return null;
    return Math.round((likeCount / viewCount) * 1e5) / 1e5;
}

function secondsToHHMMSS(s) {
    if (!s || s <= 0) return null;
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (hh > 0) return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

function parseFlexibleNumber(text) {
    if (!text) return null;
    const m = String(text).replace(/[ ,]/g, ' ').match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1000;
    else if (suf === 'M') n *= 1000000;
    else if (suf === 'B') n *= 1000000000;
    return Math.round(n);
}

// Number or null, never 0-from-absent. Number(null) and Number('') are both 0,
// so a bare cast on an optional field publishes a reading we never took. That
// matters most for the heatmap, where 0 is also a legitimate value: a genuinely
// cold segment and a missing measurement would otherwise look identical.
function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseDateBound(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

function withinDateBounds(publishedTimeText) {
    if (!dateFromTs && !dateToTs) return true;
    if (!publishedTimeText) return true;
    const ts = relativeTimeToTimestamp(publishedTimeText);
    if (ts == null) return true;
    if (dateFromTs && ts < dateFromTs) return false;
    if (dateToTs && ts > dateToTs) return false;
    return true;
}

function relativeTimeToTimestamp(text) {
    const m = String(text).toLowerCase().match(/(\d+)\s*(second|minute|hour|day|week|month|year)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const ms = ({
        second: 1000,
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
        week: 604_800_000,
        month: 2_628_000_000,
        year: 31_536_000_000,
    })[m[2]];
    return Date.now() - n * ms;
}
