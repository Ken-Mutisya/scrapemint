// Bluesky Scraper: Profiles, Posts & Followers
//
// Strategy
// --------
// Bluesky public AppView (public.api.bsky.app/xrpc), keyless JSON, no
// account. Endpoints: getProfile / getProfiles (25 per call) for profile
// rows and enrichment, getAuthorFeed for posts, getFollowers / getFollows
// for audience lists, searchActors for people search, getPosts (25 per
// call) + getLikes for post lookups. Keyword POST search
// (app.bsky.feed.searchPosts) is auth-gated (403 without a session) and
// deliberately not offered.
//
// Follower / following / search / liker items arrive as slim ProfileViews
// without counts, so they are re-fetched through getProfiles in batches of
// 25 — every profile-shaped row carries follower/post counts and bio.
//
// Pay per event
// -------------
//   bluesky_row per row of any type. Unknown handles, bad URLs and empty
//   searches are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://public.api.bsky.app/xrpc';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;
const FETCH_TIMEOUT_MS = 30000;
const PAGE_LIMIT = 100;
const BATCH = 25;
const SPACING_MS = 120;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    handles = [], includeProfile = true, includePosts = true, maxPostsPerHandle = 15,
    includeReposts = false, includeReplies = false,
    includeFollowers = false, includeFollows = false, maxFollowersPerHandle = 200,
    searchQueries = [], maxAccountsPerQuery = 25,
    postUrls = [], includeLikers = false, maxLikersPerPost = 100,
    maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const handleList = [...new Set(asTokens(handles).map(parseActor).filter(Boolean))];
const queryList = [...new Set(asTokens(searchQueries))];
const postUrlList = [...new Set(asTokens(postUrls))];
const postsCap = clampNum(maxPostsPerHandle, 15, 1, 3000);
const followersCap = clampNum(maxFollowersPerHandle, 200, 1, 10000);
const accountsCap = clampNum(maxAccountsPerQuery, 25, 1, 1000);
const likersCap = clampNum(maxLikersPerPost, 100, 1, 5000);
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);

// "@user.bsky.social", "https://bsky.app/profile/user.bsky.social", "did:plc:..." -> actor id
function parseActor(raw) {
    let s = String(raw || '').trim();
    const m = s.match(/bsky\.app\/profile\/([^/?#\s]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').replace(/\/+$/, '');
    if (!s || /\s/.test(s)) return null;
    return decodeURIComponent(s);
}

// "https://bsky.app/profile/{actor}/post/{rkey}" or "at://did/app.bsky.feed.post/rkey"
function parsePostUrl(raw) {
    const s = String(raw || '').trim();
    const at = s.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/?#\s]+)$/i);
    if (at) return { actor: at[1], rkey: at[2] };
    const m = s.match(/bsky\.app\/profile\/([^/?#\s]+)\/post\/([^/?#\s]+)/i);
    if (m) return { actor: decodeURIComponent(m[1]), rkey: m[2] };
    return null;
}

if (handleList.length === 0 && queryList.length === 0 && postUrlList.length === 0) {
    log.warning('No accounts, people searches or post URLs given. Add a handle like "bsky.app".');
    await Actor.exit();
}

let rateLimited = false;

async function apiGet(path, params) {
    if (rateLimited) return { error: 'rate limited' };
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
        else if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
    }
    const url = `${API}/${path}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429) {
                if (attempt === 3) {
                    rateLimited = true;
                    log.warning('Bluesky API rate limit persists; stopping with partial data.');
                    return { error: 'HTTP 429' };
                }
                const reset = Number(res.headers.get('ratelimit-reset')) * 1000 - Date.now();
                const waitMs = Math.min(Math.max(reset || 0, 5000), 30000);
                log.info(`Rate limited; waiting ${Math.round(waitMs / 1000)}s...`);
                await sleep(waitMs);
                continue;
            }
            const json = await res.json().catch(() => null);
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: json?.message || json?.error || `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json ?? { error: 'empty response' };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'bluesky_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const capReached = () => rowsPushed >= rowCap;
const shouldStop = () => capReached() || pastDeadline() || rateLimited;

const extractUrls = (text) => {
    const found = String(text || '').match(/https?:\/\/[^\s)"'<>]+/g) || [];
    return [...new Set(found.map((u) => u.replace(/[.,;!?]+$/, '')))];
};

function profileRow(p, type, extra = {}) {
    return {
        type,
        handle: p.handle || null,
        did: p.did || null,
        displayName: p.displayName || null,
        bio: p.description || null,
        bioLinks: extractUrls(p.description),
        followersCount: p.followersCount ?? null,
        followsCount: p.followsCount ?? null,
        postsCount: p.postsCount ?? null,
        profileUrl: p.handle && p.handle !== 'handle.invalid' ? `https://bsky.app/profile/${p.handle}` : (p.did ? `https://bsky.app/profile/${p.did}` : null),
        avatar: p.avatar || null,
        createdAt: p.createdAt || null,
        ...extra,
    };
}

const postWebUrl = (uri, handle) => {
    const m = String(uri || '').match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
    return m ? `https://bsky.app/profile/${handle && handle !== 'handle.invalid' ? handle : m[1]}/post/${m[2]}` : null;
};

function postRow(post, extra = {}) {
    const rec = post.record || {};
    const embed = rec.embed || {};
    const embedType = (embed.$type || '').replace('app.bsky.embed.', '').replace(/\.\w+$/, '') || null;
    const facetLinks = [];
    const hashtags = [];
    for (const f of rec.facets || []) {
        for (const feat of f.features || []) {
            if (feat.$type === 'app.bsky.richtext.facet#link' && feat.uri) facetLinks.push(feat.uri);
            if (feat.$type === 'app.bsky.richtext.facet#tag' && feat.tag) hashtags.push(feat.tag);
        }
    }
    const media = embed.$type === 'app.bsky.embed.recordWithMedia' ? embed.media || {} : embed;
    return {
        type: 'post',
        url: postWebUrl(post.uri, post.author?.handle),
        uri: post.uri,
        authorHandle: post.author?.handle || null,
        authorDisplayName: post.author?.displayName || null,
        authorDid: post.author?.did || null,
        text: rec.text ?? null,
        createdAt: rec.createdAt || null,
        likeCount: post.likeCount ?? null,
        repostCount: post.repostCount ?? null,
        replyCount: post.replyCount ?? null,
        quoteCount: post.quoteCount ?? null,
        isReply: Boolean(rec.reply),
        replyToUri: rec.reply?.parent?.uri || null,
        embedType,
        imageCount: Array.isArray(media.images) ? media.images.length : 0,
        externalLink: media.external?.uri || null,
        quotedPostUri: embed.record?.uri || embed.record?.record?.uri || null,
        links: [...new Set(facetLinks)],
        hashtags: [...new Set(hashtags)],
        langs: rec.langs || [],
        ...extra,
    };
}

// --- profile fetch + enrichment ---------------------------------------------

const profileCache = new Map(); // actor id -> ProfileViewDetailed | null
async function getProfileCached(actor) {
    const key = actor.toLowerCase();
    if (profileCache.has(key)) return profileCache.get(key);
    const json = await apiGet('app.bsky.actor.getProfile', { actor });
    const p = json?.error ? null : json;
    if (json?.error && !/not found|must be a valid|unable to resolve|deactivated|suspended/i.test(json.error) && !rateLimited) {
        log.warning(`getProfile ${actor}: ${json.error}`);
    }
    profileCache.set(key, p);
    if (p?.did) profileCache.set(p.did.toLowerCase(), p);
    return p;
}

// Slim ProfileViews (followers, follows, search, likers) lack counts;
// re-fetch as ProfileViewDetailed in batches of 25. Falls back to the slim
// view if the batch call fails.
async function enrichProfiles(views) {
    const byDid = new Map(views.map((v) => [v.did, v]));
    const dids = [...byDid.keys()];
    const out = [];
    for (let i = 0; i < dids.length; i += BATCH) {
        const chunk = dids.slice(i, i + BATCH);
        const json = rateLimited ? { error: 'rate limited' } : await apiGet('app.bsky.actor.getProfiles', { actors: chunk });
        const detailed = new Map((json?.profiles || []).map((p) => [p.did, p]));
        for (const did of chunk) out.push(detailed.get(did) || byDid.get(did));
    }
    return out;
}

async function paginate(path, params, listKey, cap) {
    const items = [];
    let cursor;
    while (items.length < cap && !shouldStop()) {
        const json = await apiGet(path, { ...params, limit: Math.min(PAGE_LIMIT, cap - items.length), cursor });
        if (json?.error) {
            if (items.length === 0) return { error: json.error, items };
            break;
        }
        const page = json?.[listKey] || [];
        items.push(...page);
        cursor = json?.cursor;
        if (!cursor || page.length === 0) break;
    }
    return { items: items.slice(0, cap) };
}

// --- mode 1: accounts --------------------------------------------------------

const seenPostUris = new Set();

for (const actor of handleList) {
    if (shouldStop()) break;
    const p = await getProfileCached(actor);
    if (!p) {
        await flushRow({ type: 'note', input: actor, found: false, note: rateLimited ? 'skipped: API rate limit; not charged, try again later' : 'profile not found; not charged' }, false);
        continue;
    }
    if (includeProfile) await flushRow(profileRow(p, 'profile'), true);

    if (includePosts && !shouldStop()) {
        const filter = includeReplies ? 'posts_with_replies' : 'posts_no_replies';
        let pushed = 0;
        let cursor;
        while (pushed < postsCap && !shouldStop()) {
            const json = await apiGet('app.bsky.feed.getAuthorFeed', { actor: p.did, limit: PAGE_LIMIT, filter, cursor });
            if (json?.error) { log.warning(`getAuthorFeed ${p.handle}: ${json.error}`); break; }
            for (const item of json?.feed || []) {
                if (pushed >= postsCap || shouldStop()) break;
                const isRepost = item.reason?.$type?.includes('reasonRepost');
                if (isRepost && !includeReposts) continue;
                if (!item.post?.uri || seenPostUris.has(item.post.uri)) continue;
                seenPostUris.add(item.post.uri);
                await flushRow(postRow(item.post, { feedOf: p.handle, repostedByHandle: isRepost ? item.reason?.by?.handle || p.handle : null }), true);
                pushed += 1;
            }
            cursor = json?.cursor;
            if (!cursor || (json?.feed || []).length === 0) break;
        }
    }

    for (const [flag, path, listKey, type] of [
        [includeFollowers, 'app.bsky.graph.getFollowers', 'followers', 'follower'],
        [includeFollows, 'app.bsky.graph.getFollows', 'follows', 'following'],
    ]) {
        if (!flag || shouldStop()) continue;
        const { items, error } = await paginate(path, { actor: p.did }, listKey, followersCap);
        if (error) { log.warning(`${listKey} of ${p.handle}: ${error}`); continue; }
        for (const detailed of await enrichProfiles(items)) {
            if (shouldStop()) break;
            await flushRow(profileRow(detailed, type, { ofHandle: p.handle }), true);
        }
    }
}

// --- mode 2: people search ---------------------------------------------------

for (const q of queryList) {
    if (shouldStop()) break;
    const { items, error } = await paginate('app.bsky.actor.searchActors', { q }, 'actors', accountsCap);
    if (error) {
        await flushRow({ type: 'note', input: q, found: false, note: `could not search (${error}); not charged, try again later` }, false);
        continue;
    }
    if (items.length === 0) {
        await flushRow({ type: 'note', input: q, found: false, note: 'no accounts matched this search; not charged' }, false);
        continue;
    }
    for (const detailed of await enrichProfiles(items)) {
        if (shouldStop()) break;
        await flushRow(profileRow(detailed, 'account', { query: q }), true);
    }
}

// --- mode 3: post URLs -------------------------------------------------------

const postJobs = [];
for (const raw of postUrlList) {
    if (shouldStop()) break;
    const parsed = parsePostUrl(raw);
    if (!parsed) {
        await flushRow({ type: 'note', input: raw, found: false, note: 'not a recognizable Bluesky post URL; not charged' }, false);
        continue;
    }
    let did = parsed.actor;
    if (!did.startsWith('did:')) {
        const p = await getProfileCached(parsed.actor);
        if (!p?.did) {
            await flushRow({ type: 'note', input: raw, found: false, note: 'post author not found; not charged' }, false);
            continue;
        }
        did = p.did;
    }
    postJobs.push({ raw, uri: `at://${did}/app.bsky.feed.post/${parsed.rkey}` });
}

for (let i = 0; i < postJobs.length && !shouldStop(); i += BATCH) {
    const chunk = postJobs.slice(i, i + BATCH);
    const json = await apiGet('app.bsky.feed.getPosts', { uris: chunk.map((j) => j.uri) });
    const found = new Map((json?.posts || []).map((p) => [p.uri, p]));
    for (const job of chunk) {
        if (shouldStop()) break;
        const post = found.get(job.uri);
        if (!post) {
            await flushRow({ type: 'note', input: job.raw, found: false, note: json?.error ? `lookup failed (${json.error}); not charged` : 'post not found (deleted or wrong URL); not charged' }, false);
            continue;
        }
        if (!seenPostUris.has(post.uri)) {
            seenPostUris.add(post.uri);
            await flushRow(postRow(post, { feedOf: null, repostedByHandle: null }), true);
        }
        if (includeLikers && !shouldStop()) {
            const { items, error } = await paginate('app.bsky.feed.getLikes', { uri: post.uri }, 'likes', likersCap);
            if (error) { log.warning(`getLikes ${job.raw}: ${error}`); continue; }
            const likedAtByDid = new Map(items.map((l) => [l.actor?.did, l.createdAt]));
            for (const detailed of await enrichProfiles(items.map((l) => l.actor).filter(Boolean))) {
                if (shouldStop()) break;
                await flushRow(profileRow(detailed, 'liker', { likedPostUrl: postWebUrl(post.uri, post.author?.handle), likedAt: likedAtByDid.get(detailed.did) || null }), true);
            }
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; `
    + `notes free)${rateLimited ? ' — stopped early on API rate limit' : ''}${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
