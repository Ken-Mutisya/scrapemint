// Pinterest Scraper: pins from searches, boards and profiles, with saves,
// repins and shares, the outbound link, and full-size images.
//
// Strategy
// --------
// pinterest.com's own web app reads JSON "resources", no login:
//   BaseSearchResource   search results (scope=pins), paged by bookmark
//   BoardResource        board metadata from username + slug
//   BoardFeedResource    a board's pins, paged by bookmark
//   UserResource         profile: followers, pin and board counts, reach
//   UserPinsResource     pins a profile created
//   PinResource          one pin in full: saves, repins, shares, comments
// Keyless and no proxy: from Apify's own IPs 30/30 search pages answered 200
// (652 pins in 41 s) on 2026-10-02. The X-Pinterest-PWS-Handler header is
// required; without it board and profile resources answer 403.
//
// Listing results carry no save counts (only a reaction count), so with
// includeEngagement on each pin gets one PinResource call.
//
// Pay per event
// -------------
//   pin_row        ($0.003)  a pin with engagement (saves, repins, shares, comments)
//   pin_row_basic  ($0.0015) a pin without engagement (includeEngagement off)
//   profile_row    ($0.003)  a profile's summary, for each profile URL
// No start fee. With onlyNew, pins earlier runs returned are skipped and free.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BASE = 'https://www.pinterest.com';
const DETAIL_CONCURRENCY = 4;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    startUrls = [],
    maxPinsPerSource = 100,
    maxPins = 1000,
    includeEngagement = true,
    onlyNew = false,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((s) => (typeof s === 'string' ? s : s?.url || '')).map((s) => String(s).trim()).filter(Boolean);
const perSource = Math.max(1, Number(maxPinsPerSource) || 100);
const totalCap = Math.max(1, Number(maxPins) || 1000);

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = 0;
const waiting = [];
async function slot(fn) {
    if (active >= 6) await new Promise((r) => waiting.push(r));
    active += 1;
    try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
}

async function resource(name, options, sourceUrl) {
    const url = `${BASE}/resource/${name}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(JSON.stringify({ options, context: {} }))}`;
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await slot(() => fetch(url, {
                headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US', 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-PWS-Handler': 'www/[username]/[slug].js' },
                signal: AbortSignal.timeout(30_000),
            }));
            if (r.ok) return (await r.json()).resource_response;
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 404) throw Object.assign(last, { fatal: true });
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1500 * 2 ** attempt + Math.random() * 700);
    }
    throw last;
}

// ---------- Sources ----------

const RESERVED = new Set(['pin', 'search', 'ideas', 'today', 'business', 'settings', 'resource', '_created', '_saved', 'explore']);
function parseUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (!/(^|\.)pinterest\.[a-z.]+$/.test(u.hostname)) return null;
    const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (segs[0] === 'pin' && /^\d+$/.test(segs[1] || '')) return { kind: 'pin', id: segs[1] };
    if (segs[0] === 'search') return { kind: 'search', query: u.searchParams.get('q') || '' };
    if (segs.length >= 2 && !RESERVED.has(segs[0]) && !RESERVED.has(segs[1])) return { kind: 'board', username: segs[0], slug: segs[1] };
    if (segs.length >= 1 && !RESERVED.has(segs[0])) return { kind: 'profile', username: segs[0] };
    return null;
}

const sources = [];
for (const q of listOf(searchQueries)) sources.push({ kind: 'search', query: q, label: `search: ${q}` });
const badUrls = [];
for (const raw of listOf(startUrls)) {
    const s = parseUrl(raw);
    if (s && (s.kind !== 'search' || s.query)) sources.push({ ...s, label: raw }); else badUrls.push(raw);
}
for (const b of badUrls) log.warning(`Skipped ${b}: not a Pinterest pin, board, profile or search URL.`);
if (!sources.length) {
    await Actor.pushData({ rowType: 'note', note: 'Add a search query, or a Pinterest pin, board or profile URL. Not charged.' });
    await Actor.exit();
}

// ---------- Pin shape ----------

const isoDate = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
function bestVideo(p) {
    const v = p.videos?.video_list || p.story_pin_data?.pages?.[0]?.blocks?.find((b) => b.video)?.video?.video_list;
    if (!v) return null;
    const mp4 = Object.values(v).filter((x) => /\.mp4/.test(x?.url || '')).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return (mp4 || v.V_HLSV4 || v.V_HLSV3_WEB || Object.values(v)[0])?.url || null;
}

function pinRow(p, source) {
    const img = p.images?.orig || p.images?.['736x'] || null;
    return {
        rowType: 'pin',
        pinId: String(p.id),
        url: `${BASE}/pin/${p.id}/`,
        title: p.title || p.grid_title || null,
        description: p.description?.trim() || null,
        altText: p.auto_alt_text || p.seo_alt_text || null,
        link: p.link || null,
        domain: p.domain || null,
        imageUrl: img?.url || null,
        imageWidth: img?.width ?? null,
        imageHeight: img?.height ?? null,
        thumbnails: { small: p.images?.['236x']?.url || null, medium: p.images?.['474x']?.url || null, large: p.images?.['736x']?.url || null },
        dominantColor: p.dominant_color || null,
        isVideo: !!(p.videos || p.is_video),
        videoUrl: bestVideo(p),
        createdAt: isoDate(p.created_at),
        pinner: p.pinner ? { username: p.pinner.username, fullName: p.pinner.full_name || null, followers: p.pinner.follower_count ?? null, profileUrl: `${BASE}/${p.pinner.username}/` } : null,
        board: p.board ? { name: p.board.name, url: p.board.url ? `${BASE}${p.board.url}` : null } : null,
        reactions: p.reaction_counts ? Object.values(p.reaction_counts).reduce((a, b) => a + b, 0) : null,
        isPromoted: p.is_promoted === true,
        source: source.label,
        sourceType: source.kind,
    };
}

async function addEngagement(row) {
    const r = await resource('PinResource', { id: row.pinId, field_set_key: 'detailed' }, `/pin/${row.pinId}/`);
    const d = r?.data || {};
    row.saves = d.aggregated_pin_data?.aggregated_stats?.saves ?? null;
    row.repins = d.repin_count ?? null;
    row.shares = d.share_count ?? null;
    row.comments = d.comment_count ?? null;
    if (!row.pinner && d.pinner) row.pinner = { username: d.pinner.username, fullName: d.pinner.full_name || null, followers: d.pinner.follower_count ?? null, profileUrl: `${BASE}/${d.pinner.username}/` };
    if (row.pinner && row.pinner.followers == null) row.pinner.followers = d.pinner?.follower_count ?? null;
}

// ---------- Listing per source ----------

async function* pinsOf(src) {
    let bookmarks = [];
    const page = async () => {
        if (src.kind === 'search') {
            const r = await resource('BaseSearchResource', { query: src.query, scope: 'pins', bookmarks }, `/search/pins/?q=${encodeURIComponent(src.query)}`);
            return { items: r?.data?.results || [], bookmark: r?.bookmark };
        }
        if (src.kind === 'board') {
            if (!src.boardId) {
                const b = await resource('BoardResource', { username: src.username, slug: src.slug, field_set_key: 'detailed' }, `/${src.username}/${src.slug}/`);
                src.boardId = b?.data?.id;
                if (!src.boardId) throw new Error('board not found');
            }
            const r = await resource('BoardFeedResource', { board_id: src.boardId, page_size: 25, bookmarks }, `/${src.username}/${src.slug}/`);
            return { items: r?.data || [], bookmark: r?.bookmark };
        }
        if (src.kind === 'profile') {
            const r = await resource('UserPinsResource', { username: src.username, bookmarks }, `/${src.username}/_created/`);
            return { items: r?.data || [], bookmark: r?.bookmark };
        }
        return { items: [] };
    };
    if (src.kind === 'pin') {
        const r = await resource('PinResource', { id: src.id, field_set_key: 'detailed' }, `/pin/${src.id}/`);
        if (r?.data) yield r.data;
        return;
    }
    for (let i = 0; i < 200; i++) {
        const { items, bookmark } = await page();
        for (const it of items) if (it?.type === 'pin' && it.id) yield it;
        if (!bookmark || bookmark === '-end-' || !items.length) return;
        bookmarks = [bookmark];
    }
}

// ---------- Run ----------

const store = onlyNew ? await Actor.openKeyValueStore('pinterest-scraper-state') : null;
const stateName = `SEEN_${createHash('sha1').update(JSON.stringify(sources.map((s) => s.label).sort())).digest('hex').slice(0, 12)}`;
const seen = new Set(store ? ((await store.getValue(stateName)) || []) : []);
const firstRun = onlyNew && seen.size === 0;
const returned = [];
let pushed = 0;
let stop = false;
const stats = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

for (const src of sources) {
    if (stop || pushed >= totalCap) break;
    const st = { source: src.label, pins: 0 };
    stats.push(st);
    try {
        if (src.kind === 'profile') {
            const u = await resource('UserResource', { username: src.username, field_set_key: 'profile' }, `/${src.username}/`);
            const d = u?.data;
            if (d?.username) {
                await Actor.pushData({
                    rowType: 'profile',
                    username: d.username,
                    fullName: d.full_name || null,
                    about: d.about || null,
                    website: d.website_url || d.domain_url || null,
                    followers: d.follower_count ?? null,
                    following: d.following_count ?? null,
                    pins: d.pin_count ?? null,
                    boards: d.board_count ?? null,
                    monthlyViews: d.profile_reach ?? null,
                    isVerifiedMerchant: d.is_verified_merchant === true,
                    profileImage: d.image_xlarge_url || d.image_large_url || null,
                    url: `${BASE}/${d.username}/`,
                    scrapedAt: new Date().toISOString(),
                });
                await charge('profile_row');
            }
        }
        // Collect this source's pins, then enrich in parallel.
        const batch = [];
        for await (const p of pinsOf(src)) {
            if (batch.length >= perSource || pushed + batch.length >= totalCap) break;
            if (seen.has(String(p.id))) continue;
            seen.add(String(p.id));
            batch.push(pinRow(p, src));
        }
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, batch.length) }, async () => {
            while (i < batch.length && !stop) {
                const row = batch[i++];
                let enriched = false;
                if (includeEngagement) {
                    try { await addEngagement(row); enriched = true; } catch (err) { log.debug(`engagement ${row.pinId}: ${err?.message}`); }
                }
                if (pushed >= totalCap) { stop = true; break; }
                pushed += 1;
                await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
                returned.push(row.pinId);
                st.pins += 1;
                await charge(enriched ? 'pin_row' : 'pin_row_basic');
            }
        }));
        log.info(`${src.label}: ${st.pins} pin(s).`);
    } catch (err) {
        st.error = String(err?.message || err);
        log.warning(`${src.label}: ${st.error}`);
    }
}

if (store) {
    const prior = (await store.getValue(stateName)) || [];
    await store.setValue(stateName, [...new Set([...prior, ...returned])].slice(-100000));
}
if (!pushed && (!onlyNew || firstRun)) {
    await Actor.pushData({ rowType: 'note', note: `No pins found${onlyNew ? ' that earlier runs had not already returned' : ''}. ${stats.filter((s) => s.error).map((s) => `${s.source}: ${s.error}`).join('; ')} Not charged.` });
}
await Actor.setValue('SUMMARY', { pins: pushed, sources: stats, skippedUrls: badUrls });
log.info(`Done. ${pushed} pin(s) from ${sources.length} source(s).`);
await Actor.exit();
