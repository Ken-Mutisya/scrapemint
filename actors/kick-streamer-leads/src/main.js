// Kick Streamer Leads: Emails, Socials & Followers by Category
//
// Strategy
// --------
// Kick's public web JSON (the same endpoints kick.com's own pages call,
// no login) three ways: live streams per category
// (/stream/livestreams/en?subcategory=slug), channel search
// (/api/search), and direct channel names. Filter by language and
// follower band, then enrich each channel from /api/v2/channels/{slug}
// (followers, verified, bio, socials) and /videos (last stream, recent
// VOD views), and extract the business email from the bio. One row per
// streamer.
//
// Cost control
// ------------
// Kick answered Apify's own IPs directly (tested 2026-10-29). Cloudflare
// rejects a browser user agent on a non-browser TLS fingerprint, so
// requests go through got-scraping. Datacenter, then US residential, are
// fallbacks after three blocks in a row; residential is capped at 25% of
// charged revenue (proxy-guard). Responses are a few KB.
//
// Pay per event
// -------------
//   streamer_contact_row ($0.015) per streamer pushed WITH a business
//   email found in the bio. streamer_row ($0.005) for all other rows.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';

const PRICES = { streamer_contact_row: 0.015, streamer_row: 0.005 };
const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const PAGE_SIZE = 24;
const MAX_PAGES_PER_CATEGORY = 40;
const ENRICH_CONCURRENCY = 5;
const RECENT_STREAMS = 10;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories = [],
    searchQueries = [],
    channels = [],
    languages = [],
    minFollowers,
    maxFollowers,
    requireEmail = false,
    maxStreamers = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const cats = asList(categories);
const queries = asList(searchQueries);
const directSlugs = asList(channels)
    .map((c) => c.replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0].toLowerCase())
    .filter(Boolean);
const langs = asList(languages).map((l) => l.toLowerCase());
const minF = Number.isFinite(Number(minFollowers)) && minFollowers != null ? Number(minFollowers) : null;
const maxF = Number.isFinite(Number(maxFollowers)) && maxFollowers != null ? Number(maxFollowers) : null;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxStreamers) || 50));

if (!cats.length && !queries.length && !directSlugs.length) {
    await Actor.pushData({ note: 'Provide at least one of "categories", "searchQueries", or "channels". Not charged.' });
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('kick-seen') : null;
const seen = new Set();
if (seenStore) for (const s of (await seenStore.getValue('seen-slugs')) || []) seen.add(String(s));

const guard = new ProxyGuard({ tiers: ['direct', 'datacenter', 'residential'], country: 'US', share: 0.25, floorUsd: 0.01 });
const headers = { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://kick.com/' };
const stats = { candidates: 0, rows: 0, withEmail: 0, notFound: 0 };
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { ...stats, ...guard.report() }));

async function getJson(path) {
    const res = await guard.get(`https://kick.com${path}`, { headers, timeoutMs: 30_000 });
    if (!res || res.statusCode !== 200) return null;
    try { return JSON.parse(res.body); } catch { return null; }
}

// Emails only — @handles without a TLD don't match.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
// Kick returns follower counts as numbers or numeric strings; missing stays null.
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const slugify = (s) => s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function followerBandOk(n) {
    if (n == null) return minF == null && maxF == null;
    if (minF != null && n < minF) return false;
    if (maxF != null && n > maxF) return false;
    return true;
}

// Kick stores socials as handles or partial paths; build full URLs.
function socialLinks(u) {
    if (!u) return null;
    const clean = (v) => String(v || '').trim().replace(/^@/, '').replace(/\/+$/, '');
    const full = (v, base) => (/^https?:\/\//i.test(v) ? v : `${base}${v}`);
    const out = {};
    const ig = clean(u.instagram); if (ig) out.instagram = full(ig, 'https://www.instagram.com/');
    const x = clean(u.twitter); if (x) out.x = full(x, 'https://x.com/');
    const yt = String(u.youtube || '').trim().replace(/\/+$/, '');
    if (yt) out.youtube = full(yt, /^(channel|c|user)\//.test(yt) || yt.startsWith('@') ? 'https://www.youtube.com/' : 'https://www.youtube.com/@');
    const tt = clean(u.tiktok); if (tt) out.tiktok = full(tt, 'https://www.tiktok.com/@');
    const fb = clean(u.facebook); if (fb) out.facebook = full(fb, 'https://www.facebook.com/');
    const dc = String(u.discord || '').trim(); if (dc) out.discord = dc;
    return Object.keys(out).length ? out : null;
}

// --- collect candidates ---
const candidates = new Map();
function addCandidate(c) {
    if (!c.slug || seen.has(c.slug) || candidates.has(c.slug)) return;
    if (c.followers != null && !followerBandOk(c.followers)) return;
    candidates.set(c.slug, c);
}
// Candidates beyond the cap are wasted enrichment calls; collect a small buffer only.
// About 1 in 10 bios has an email, so email-only runs need a deeper pool.
const collectTarget = Math.min(HARD_CAP * 3, cap * (requireEmail ? 12 : 3));

async function resolveCategorySlug(name) {
    const d = await getJson(`/api/search?searched_word=${encodeURIComponent(name)}`);
    const list = d?.categories || [];
    const want = name.toLowerCase();
    const hit = list.find((c) => c.name?.toLowerCase() === want || c.slug === slugify(name)) || list[0];
    return hit?.slug || null;
}

// Named channels go first so the row cap never drops them.
for (const s of directSlugs) {
    addCandidate({ slug: s, language: null, liveViewers: null, liveTitle: null, liveCategory: null, matchedCategory: null, matchedQuery: null });
}

for (const cat of cats) {
    let slug = slugify(cat);
    let triedLookup = false;
    for (let page = 1; page <= MAX_PAGES_PER_CATEGORY && candidates.size < collectTarget; page++) {
        if (deadline.pastSoft()) break;
        const d = await getJson(`/stream/livestreams/en?page=${page}&limit=${PAGE_SIZE}&sort=desc&subcategory=${encodeURIComponent(slug)}`);
        const streams = d?.data || [];
        if (!streams.length && page === 1 && !triedLookup) {
            triedLookup = true;
            const resolved = await resolveCategorySlug(cat);
            if (resolved && resolved !== slug) { slug = resolved; page = 0; continue; }
            log.warning(`Category "${cat}" has no live streams or was not found. Use the name shown on kick.com/category.`);
            break;
        }
        for (const s of streams) {
            const ch = s.channel;
            if (!ch?.slug) continue;
            if (langs.length && !langs.includes(String(s.language || '').toLowerCase())) continue;
            addCandidate({
                slug: ch.slug.toLowerCase(),
                language: s.language || null,
                liveViewers: s.viewer_count ?? s.viewers ?? null,
                liveTitle: s.session_title || null,
                liveCategory: s.categories?.[0]?.name || null,
                matchedCategory: cat,
                matchedQuery: null,
            });
        }
        if (!d?.next_page_url) break;
    }
    log.info(`Category "${cat}": ${candidates.size} candidate(s) so far.`);
}

for (const q of queries) {
    if (candidates.size >= collectTarget || deadline.pastSoft()) break;
    const d = await getJson(`/api/search?searched_word=${encodeURIComponent(q)}`);
    const list = d?.channels || [];
    for (const ch of list) {
        if (!ch?.slug) continue;
        addCandidate({
            slug: ch.slug.toLowerCase(),
            followers: num(ch.followers_count ?? ch.followersCount),
            language: null, liveViewers: null, liveTitle: null, liveCategory: null,
            matchedCategory: null, matchedQuery: q,
        });
    }
    log.info(`Search "${q}": ${list.length} channel(s), ${candidates.size} candidate(s) total.`);
}

stats.candidates = candidates.size;
log.info(`${candidates.size} candidate streamer(s), enriching up to ${cap}.`);

async function enrich(slug) {
    const ch = await getJson(`/api/v2/channels/${encodeURIComponent(slug)}`);
    if (!ch?.slug) return null;
    // Skip the VOD call for channels the follower band will drop anyway.
    if (!followerBandOk(num(ch.followers_count))) return { ch, vods: [] };
    const vods = await getJson(`/api/v2/channels/${encodeURIComponent(slug)}/videos`);
    return { ch, vods: Array.isArray(vods) ? vods : [] };
}

// Kick timestamps are UTC without a zone ("2026-10-28 21:47:13").
const iso = (t) => (t ? new Date(`${String(t).replace(' ', 'T')}${/[zZ+]/.test(String(t).slice(10)) ? '' : 'Z'}`).toISOString() : null);

let rowsPushed = 0;
let stop = false;
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    stats.rows += 1;
    if (rowsPushed > FREE_TIER_ROWS && !(await chargeRows(guard, eventName, PRICES[eventName], 1))) stop = true;
}

const list = [...candidates.values()];
for (let i = 0; i < list.length && rowsPushed < cap && !stop; i += ENRICH_CONCURRENCY) {
    if (deadline.pastSoft()) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = list.slice(i, i + ENRICH_CONCURRENCY);
    const details = await Promise.all(batch.map((c) => enrich(c.slug)));
    for (let j = 0; j < batch.length && rowsPushed < cap && !stop; j++) {
        const c = batch[j];
        const det = details[j];
        if (!det) { stats.notFound += 1; continue; }
        const { ch, vods } = det;
        const followers = num(ch.followers_count);
        if (!followerBandOk(followers)) continue;
        const u = ch.user || {};
        const bio = u.bio || null;
        const businessEmail = bio?.match(EMAIL_RE)?.[0] || null;
        if (requireEmail && !businessEmail) continue;
        const recent = vods.slice(0, RECENT_STREAMS);
        // VOD viewer_count is a snapshot, not a peak or average, so report VOD views instead.
        const vodViews = recent.map((v) => Number(v.views)).filter((n) => Number.isFinite(n) && n >= 0);
        const live = ch.livestream || null;
        seen.add(c.slug);
        if (businessEmail) stats.withEmail += 1;
        await flushRow({
            slug: ch.slug,
            url: `https://kick.com/${ch.slug}`,
            username: u.username || null,
            followers,
            verified: ch.verified ?? null,
            isAffiliate: ch.is_affiliate ?? null,
            subscriptionsEnabled: ch.subscription_enabled ?? null,
            bio,
            businessEmail,
            bioLinks: bio ? [...new Set(bio.match(URL_RE) || [])] : [],
            socialLinks: socialLinks(u),
            isLive: !!live?.is_live,
            liveViewers: live?.viewer_count ?? c.liveViewers ?? null,
            liveTitle: live?.session_title ?? c.liveTitle ?? null,
            language: live?.language ?? c.language ?? recent[0]?.language ?? null,
            lastStreamedAt: iso(recent[0]?.start_time || recent[0]?.created_at),
            lastStreamCategory: recent[0]?.categories?.[0]?.name || c.liveCategory || null,
            recentCategories: [...new Set((ch.recent_categories || []).map((r) => r.name).filter(Boolean))],
            recentStreamsCount: recent.length,
            recentAvgVodViews: vodViews.length ? Math.round(vodViews.reduce((a, b) => a + b, 0) / vodViews.length) : null,
            profilePicture: u.profile_pic || u.profilepic || null,
            matchedCategory: c.matchedCategory,
            matchedQuery: c.matchedQuery,
            scrapedAt: new Date().toISOString(),
        }, businessEmail ? 'streamer_contact_row' : 'streamer_row');
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-slugs', [...seen].slice(-300000));
}
if (!rowsPushed) await Actor.pushData({ note: 'No streamers matched these filters. Not charged.' });
await Actor.setValue('SUMMARY', { ...stats, ...guard.report() });
log.info(`Done. ${JSON.stringify(stats)} ${JSON.stringify(guard.report())}`);
await Actor.exit();
