// Snapchat Profile Scraper: public profiles with subscribers, bio, category,
// stories, highlights, lenses, related accounts and Spotlight videos.
//
// Strategy
// --------
// snapchat.com/@<username> is server-rendered by Next.js; everything the page
// shows sits in its __NEXT_DATA__ JSON (pageProps):
//   userProfile.publicProfileInfo   public profiles: title, subscriberCount,
//                                   bio, websiteUrl, category ids, badge,
//                                   creation/update timestamps, related accounts
//   userProfile.userInfo            personal accounts: username, display name
//   story.snapList                  the current story
//   curatedHighlights[]             saved highlights
//   spotlightStoryMetadata[]        recent Spotlight videos (up to 25) with
//                                   engagementStats (views, shares, comments,
//                                   boosts) and captions
//   lenses[]                        the creator's lenses
// A username that does not exist answers 404. No key, no proxy: profile pages
// answered Apify's IPs 5/5 in the 2026-10-09 probe.
//
// Pay per event
// -------------
//   profile   ($0.002)  one profile
//   spotlight ($0.0005) one Spotlight video row (Spotlight videos as rows on)
// No start fee. Usernames that do not exist are free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { usernames = [], includeSpotlight = false, includeMedia = true } = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url || x.username : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kyliejenner, @kyliejenner, snapchat.com/@kyliejenner, snapchat.com/add/kyliejenner
function toUsername(s) {
    const m = String(s).match(/snapchat\.com\/(?:add\/|@)([A-Za-z0-9._-]+)/i);
    const u = (m ? m[1] : String(s).replace(/^@/, '')).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{1,30}$/.test(u) ? u : null;
}

async function fetchProfile(username) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(`https://www.snapchat.com/@${encodeURIComponent(username)}`, {
                headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
                redirect: 'follow',
                signal: AbortSignal.timeout(30_000),
            });
            if (r.status === 404) return { notFound: true };
            if (r.ok) {
                const t = await r.text();
                const m = t.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
                if (m) return JSON.parse(m[1])?.props?.pageProps || {};
                last = new Error('No page data');
            } else last = new Error(`HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const val = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : o) || null;
const ts = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : null);
const tsMs = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
// "public-profile-subcategory-v3-artist" -> "artist"
const cat = (id) => (id ? String(id).replace(/^public-profile-(sub)?category-v\d+-/, '').replace(/-/g, ' ') : null);

function snap(s) {
    return {
        snapId: val(s.snapId) || null,
        mediaType: s.snapMediaType === 1 ? 'video' : s.snapMediaType === 0 ? 'image' : s.snapMediaType ?? null,
        mediaUrl: s.snapUrls?.mediaUrl || null,
        previewUrl: val(s.snapUrls?.mediaPreviewUrl),
        postedAt: ts(val(s.timestampInSec)),
    };
}

function spotlightRow(m, username) {
    const v = m.videoMetadata || {};
    const e = m.engagementStats || {};
    const id = String(m.oneLinkParams?.deepLinkUrl || '').match(/spotlight\/([^/?#]+)/)?.[1] || null;
    return {
        rowType: 'spotlight',
        username,
        spotlightId: id,
        url: id ? `https://www.snapchat.com/spotlight/${id}` : null,
        caption: (m.description || '').trim() || null,
        title: m.llmTitle || null,
        hashtags: m.hashtags || [],
        keywords: [...new Set([...(m.llmKeywords || []), ...(m.textMetadataKeywords || [])])],
        views: num(e.viewCount ?? v.viewCount),
        shares: num(e.shareCount),
        comments: num(e.commentCount),
        boosts: num(e.boostCount),
        recommends: num(e.recommendCount),
        durationSec: v.durationMs ? Math.round(Number(v.durationMs) / 100) / 10 : null,
        width: v.width ?? null,
        height: v.height ?? null,
        uploadedAt: tsMs(v.uploadDateMs),
        sound: (m.contextCards || []).find((c) => /sound/i.test(c.title || ''))?.subtitle || null,
        videoUrl: v.contentUrl || null,
        thumbnailUrl: v.thumbnailUrl || null,
    };
}

function profileRow(username, pp) {
    const up = pp.userProfile || {};
    const pub = up.publicProfileInfo;
    const usr = up.userInfo;
    const spots = (pp.spotlightStoryMetadata || []).map((m) => spotlightRow(m, username));
    const views = spots.map((s) => s.views).filter((x) => x != null);
    const storySnaps = (pp.story?.snapList || []).map(snap);
    const highlights = (pp.curatedHighlights || []).map((h) => ({
        title: val(h.storyTitle),
        highlightId: val(h.highlightId),
        thumbnailUrl: val(h.thumbnailUrl),
        snaps: (h.snapList || []).map(snap),
    }));
    const row = {
        rowType: 'profile',
        username: pub?.username || usr?.username || username,
        url: `https://www.snapchat.com/@${pub?.username || usr?.username || username}`,
        isPublicProfile: !!pub,
        displayName: pub?.title || usr?.displayName || null,
        subscriberCount: num(pub?.subscriberCount),
        bio: pub?.bio || null,
        websiteUrl: pub?.websiteUrl ? (/^https?:/.test(pub.websiteUrl) ? pub.websiteUrl : `https://${pub.websiteUrl}`) : null,
        category: cat(pub?.categoryStringId),
        subcategory: cat(pub?.subcategoryStringId),
        verified: pub ? pub.badge === 1 : null,
        address: pub?.address || null,
        profilePictureUrl: pub?.profilePictureUrl || null,
        heroImageUrl: pub?.squareHeroImageUrl || null,
        snapcodeUrl: pub?.snapcodeImageUrl || usr?.snapcodeImageUrl || null,
        createdAt: tsMs(val(pub?.creationTimestampMs)),
        lastUpdatedAt: tsMs(val(pub?.lastUpdateTimestampMs)),
        hasStory: storySnaps.length > 0,
        storySnapCount: storySnaps.length,
        highlightCount: highlights.length,
        spotlightCount: spots.length,
        spotlightViewsTotal: views.length ? views.reduce((a, b) => a + b, 0) : null,
        spotlightViewsAvg: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
        latestSpotlightAt: spots.map((s) => s.uploadedAt).filter(Boolean).sort().pop() || null,
        lensCount: (pp.lenses || []).length,
        lenses: (pp.lenses || []).map((l) => ({ name: l.lensName || null, previewImageUrl: l.lensPreviewImageUrl || null, unlockUrl: l.unlockUrl || null })),
        relatedAccounts: (pub?.relatedAccountsInfo || []).map((a) => a.publicProfileInfo).filter(Boolean).map((a) => ({ username: a.username, displayName: a.title || null, subscriberCount: num(a.subscriberCount) || null })),
        businessProfileId: pub?.businessProfileId || null,
    };
    if (includeMedia) Object.assign(row, { storySnaps, highlights });
    return { row, spots };
}

// ---------- Run ----------

let profiles = 0;
let videos = 0;
let keepGoing = true;
const notFound = [];
const failures = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const names = [];
for (const s of list(usernames)) {
    const u = toUsername(s);
    if (!u) {
        failures.push({ input: s, error: 'Not a Snapchat username or profile URL' });
        await Actor.pushData({ rowType: 'error', input: s, error: 'Not a Snapchat username or profile URL. Not charged.' });
        continue;
    }
    if (!names.includes(u)) names.push(u);
}
if (!names.length && !failures.length) names.push('kyliejenner');
log.info(`${names.length} profile(s) to read.`);

// A few pages at a time; rows keep input order.
const WIDTH = 4;
for (let i = 0; i < names.length && keepGoing; i += WIDTH) {
    const chunk = names.slice(i, i + WIDTH);
    const pages = await Promise.all(chunk.map(async (u) => {
        try { return await fetchProfile(u); } catch (err) { return { error: String(err?.message || err) }; }
    }));
    for (let k = 0; k < chunk.length && keepGoing; k++) {
        const u = chunk[k];
        const pp = pages[k];
        if (pp.notFound || (pp.userProfile == null && !pp.error)) {
            notFound.push(u);
            await Actor.pushData({ rowType: 'not_found', username: u, note: 'No Snapchat account with this username. Not charged.' });
            continue;
        }
        if (pp.error) {
            failures.push({ username: u, error: pp.error });
            await Actor.pushData({ rowType: 'error', username: u, error: `${pp.error}. Not charged.` });
            continue;
        }
        const { row, spots } = profileRow(u, pp);
        await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
        profiles += 1;
        if (!(await charge('profile'))) { keepGoing = false; break; }
        if (includeSpotlight) {
            for (const s of spots) {
                await Actor.pushData({ ...s, scrapedAt: new Date().toISOString() });
                videos += 1;
                if (!(await charge('spotlight'))) { keepGoing = false; break; }
            }
        }
    }
    await sleep(400);
}

await Actor.setValue('SUMMARY', { profiles, spotlightVideos: videos, notFound, failures });
log.info(`Done. ${profiles} profile(s)${includeSpotlight ? `, ${videos} Spotlight video(s)` : ''}${notFound.length ? `, ${notFound.length} not found` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
