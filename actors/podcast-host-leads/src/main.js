// Podcast Host Lead Scraper
//
// Turns the podcast directory into B2B leads. For each keyword it searches the
// keyless iTunes Search API, then reads each show's RSS feed for the host's
// public owner email. Returns show name, host/author, email, website, category,
// episode count, and last-episode date. One lead per podcast.
//
// Buyers: podcast ad networks and sponsors, hosting platforms, guest-booking and
// podcast-PR agencies, and podcast tool SaaS.
//
// iTunes Search API gives the feed URL, episode count, genres, and last release
// date. The RSS feed (channel itunes:owner) gives the public host email. Both are
// keyless; the RSS is fetched with a Range header since the owner email sits at
// the top of the feed (no need to download multi-MB episode lists).
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_QUALIFIED = 1;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/i;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const RSS_RANGE = 262144; // 256KB is plenty for channel-level metadata

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    country = 'US',
    maxLeads = 25,
    maxPerKeyword = 100,
    minEpisodes = 0,
    activeSinceDays = 0,
    requireEmail = false,
    concurrency = 8,
} = input;

const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
if (cleanKeywords.length === 0) throw new Error('Provide at least one keyword, e.g. ["marketing","true crime","startup"].');

const gl = String(country || 'US').trim().toUpperCase();
const leadCap = Math.max(1, Math.min(5000, Number(maxLeads) || 200));
const perKwCap = Math.max(1, Math.min(200, Number(maxPerKeyword) || 100));
const minEp = Math.max(0, Number(minEpisodes) || 0);
const activeSinceMs = Number(activeSinceDays) > 0 ? Date.now() - Number(activeSinceDays) * 864e5 : 0;
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: search the directory ----------
const shows = [];
const seen = new Set();
for (const kw of cleanKeywords) {
    if (shows.length >= leadCap * 2) break;
    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(kw)}&media=podcast&entity=podcast&limit=${perKwCap}&country=${gl}`);
    const results = data?.results || [];
    let added = 0;
    for (const r of results) {
        const id = r.collectionId || r.feedUrl;
        if (!id || seen.has(id)) continue;
        const lastMs = r.releaseDate ? Date.parse(r.releaseDate) : null;
        const episodes = numOrNull(r.trackCount);
        if (minEp > 0 && (episodes || 0) < minEp) continue;
        if (activeSinceMs && (!lastMs || lastMs < activeSinceMs)) continue;
        seen.add(id);
        shows.push({
            collectionId: r.collectionId || null,
            name: clean(r.collectionName),
            author: clean(r.artistName),
            feedUrl: r.feedUrl || null,
            episodes,
            primaryGenre: r.primaryGenreName || null,
            genres: Array.isArray(r.genres) ? r.genres.filter((g) => g !== 'Podcasts') : [],
            lastEpisodeDate: r.releaseDate || null,
            lastEpisodeMs: lastMs,
            country: r.country || gl,
            applePodcastUrl: r.collectionViewUrl || null,
            artworkUrl: r.artworkUrl600 || r.artworkUrl100 || null,
        });
        added += 1;
    }
    log.info(`search "${kw}": +${added} shows (total ${shows.length}).`);
}

if (shows.length === 0) { log.warning('No podcasts matched.'); await Actor.exit(); }
const finalShows = shows.slice(0, leadCap);

// ---------- Stage 2: read each RSS for the host email ----------
log.info(`Reading ${finalShows.length} feeds for host contact info.`);
await mapWithConcurrency(finalShows, pool, async (s) => {
    if (!s.feedUrl) return s;
    const xml = await fetchFeedHead(s.feedUrl);
    if (!xml) return s;
    s.ownerEmail = pickEmail(tagText(xml, 'itunes:email'));
    s.ownerName = clean(stripTags(tagText(xml, 'itunes:name')));
    if (!s.author) s.author = clean(stripTags(tagText(xml, 'itunes:author')));
    s.website = firstChannelLink(xml);
    s.language = clean(tagText(xml, 'language'));
    return s;
});

// ---------- Stage 3: score, tier, push, charge ----------
log.info(`Scoring ${finalShows.length} leads.`);
for (const s of finalShows) {
    if (requireEmail && !s.ownerEmail) continue;

    const active = s.lastEpisodeMs ? (Date.now() - s.lastEpisodeMs) <= 90 * 864e5 : false;
    const epScore = scoreEpisodes(s.episodes);
    const recScore = active ? 18 : (s.lastEpisodeMs && (Date.now() - s.lastEpisodeMs) <= 365 * 864e5 ? 8 : 2);
    const contactScore = (s.ownerEmail ? 28 : 0) + (s.website ? 6 : 0);
    const leadScore = Math.min(100, Math.round(epScore + recScore + contactScore));

    const tier = (s.ownerEmail && active && (s.episodes || 0) >= 10) ? 'qualified_lead'
        : ((s.ownerEmail || s.website) ? 'lead' : 'listing');

    const row = {
        name: s.name,
        author: s.author || null,
        ownerName: s.ownerName || null,
        ownerEmail: s.ownerEmail || null,
        website: s.website || null,
        primaryGenre: s.primaryGenre,
        genres: s.genres,
        episodes: s.episodes,
        lastEpisodeDate: s.lastEpisodeDate,
        active,
        language: s.language || null,
        country: s.country,
        feedUrl: s.feedUrl,
        applePodcastUrl: s.applePodcastUrl,
        artworkUrl: s.artworkUrl,
        collectionId: s.collectionId,
        tier,
        leadScore,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(row);

    if (tier === 'qualified_lead') {
        if (qualifiedFree + qualifiedCharged < FREE_TIER_QUALIFIED) qualifiedFree += 1;
        else { await charge('qualified_lead'); qualifiedCharged += 1; }
    } else if (tier === 'lead') {
        await charge('lead'); leadCount += 1;
    } else {
        await charge('listing'); listingCount += 1;
    }
}

log.info(`Done. qualified_lead charged=${qualifiedCharged} free=${qualifiedFree}, lead=${leadCount}, listing=${listingCount}.`);
await Actor.exit();

// ---------- helpers ----------

function scoreEpisodes(n) {
    const v = n || 0;
    if (v >= 200) return 45;
    if (v >= 50) return 36;
    if (v >= 20) return 26;
    if (v >= 10) return 18;
    if (v >= 3) return 10;
    return v > 0 ? 4 : 0;
}

function tagText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}

// The channel <link> is the show website; the first <link> in the document is the
// channel link (item links come later, after the Range cutoff anyway).
function firstChannelLink(xml) {
    const m = xml.match(/<link[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/link>/i);
    let u = m ? m[1].trim() : null;
    if (!u) return null;
    if (/podcasts\.apple\.com|anchor\.fm|spotify\.com/i.test(u)) return u; // still a usable link
    return u;
}

function pickEmail(s) {
    if (!s) return null;
    const m = String(s).match(EMAIL_RE);
    if (!m) return null;
    const e = m[0].toLowerCase();
    if (!EMAIL_SHAPE.test(e)) return null;
    if (/noreply|no-reply|\.invalid$|@example\./i.test(e)) return null;
    return e;
}

async function fetchFeedHead(url) {
    for (let i = 0; i < 3; i++) {
        if (i) await sleep(300 * i);
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 12000);
            const res = await fetch(url, {
                redirect: 'follow',
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PodcastLeads/1.0)', Range: `bytes=0-${RSS_RANGE}` },
            });
            clearTimeout(timer);
            if (res.status >= 500 || res.status === 429) continue;
            if (res.status >= 400 && res.status !== 416) return null; // 416 = range not satisfiable (tiny feed) -> retry w/o range below
            const text = await res.text();
            return text.slice(0, RSS_RANGE + 4096);
        } catch { /* retry */ }
    }
    return null;
}

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(300 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-podcast-leads/1.0', Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`fetch failed ${url}: ${err?.message}`);
        }
    }
    return null;
}

function stripTags(s) { return s ? String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : s; }
function clean(s) { return s ? String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null; }

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
