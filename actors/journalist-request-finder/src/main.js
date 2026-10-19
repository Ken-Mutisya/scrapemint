// Journalist Request Finder: fresh requests from journalists looking for
// expert sources, case studies and comment, in one feed. A HARO alternative.
//
// Sources
// -------
//   1. SourceBottle call-outs. industry-list-results.asp?iid={industry}&scid=
//      {country}&p={page} lists open call-outs, 12 a page, newest first:
//      title, date posted, summary, outlet, requester role, deadline and a
//      query.asp?qid= link. Six countries, 11 call-out industries plus one
//      for product/giveaway requests (iid=54).
//   2. Bluesky. api.bsky.app app.bsky.feed.searchPosts for #journorequest,
//      #prrequest and #mediarequest, newest first, cursor paging. The
//      public.api.bsky.app host answers 403 to searchPosts; api.bsky.app
//      does not (2026-10-19).
//   3. Mastodon. Tag timelines on mastodon.social (federated, so posts from
//      other servers show up too) and journa.host, the journalists' server.
//
// Bluesky has bots that repost the same request several times, so rows are
// de-duplicated on their opening text.
//
// No key, no proxy. Tested from Apify on 2026-10-19.
//
// Pay per event
// -------------
//   request_row ($0.002) one journalist request
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (compatible; JournalistRequestFinder/1.0; +https://apify.com/scrapemint/journalist-request-finder)';
const SB = 'https://www.sourcebottle.com';
const SB_COUNTRIES = { AU: 1, NZ: 2, UK: 3, CA: 4, US: 5, SG: 6 };
const SB_COUNTRY_NAMES = { AU: 'Australia', NZ: 'New Zealand', UK: 'UK & Ireland', CA: 'Canada', US: 'United States', SG: 'Singapore' };
const SB_INDUSTRIES = {
    61: 'Business & Finance', 62: 'Environment', 63: 'General', 64: 'Health & Wellbeing',
    65: 'Lifestyle, Food & Fashion', 66: 'Parenting & Education', 69: 'PR, Media & Marketing',
    67: 'Professional Services', 68: 'Property', 70: 'Technology', 71: 'Travel & Leisure',
};
const SB_PRODUCTS = { 54: 'Samples, prizes & giveaways' };
const BSKY_TAGS = ['#journorequest', '#prrequest', '#mediarequest'];
const MASTODON = [['mastodon.social', 'journorequest'], ['mastodon.social', 'prrequest'], ['journa.host', 'journorequest']];
const CONCURRENCY = 4;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    excludeKeywords = [],
    sources = ['sourcebottle', 'bluesky', 'mastodon'],
    countries = [],
    maxAgeDays = 7,
    openOnly = true,
    includeProductRequests = false,
    maxResults = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = list(keywords).map((k) => k.toLowerCase());
const block = list(excludeKeywords).map((k) => k.toLowerCase());
const srcs = new Set(list(sources).map((s) => s.toLowerCase()));
const ctry = list(countries).map((c) => c.toUpperCase()).filter((c) => SB_COUNTRIES[c]);
const sbCountries = ctry.length ? ctry : Object.keys(SB_COUNTRIES);
const days = Math.min(60, Math.max(1, Number(maxAgeDays) || 7));
const cutoff = Date.now() - days * 86400_000;
const cap = Math.max(1, Number(maxResults) || 200);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

async function get(url, type = 'text') {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, {
                headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : 'text/html,*/*', 'Accept-Language': 'en' },
                signal: AbortSignal.timeout(45_000),
            });
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(2000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return type === 'json' ? await r.json() : await r.text();
        } catch (err) {
            last = err;
            if (/HTTP 4\d\d/.test(err.message)) break;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

async function pool(items, fn, n = CONCURRENCY) {
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (i < items.length && !pastDeadline()) await fn(items[i++]);
    }));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
const strip = (html) => decode(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "24 October 2026 @ 5pm" -> 2026-10-24 (the day; SourceBottle's times are local to the country)
function parseDay(s) {
    const m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
    return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]))).toISOString().slice(0, 10);
}
// Deadlines written inside free text: "Deadline 24 Oct", "deadline: 15 Oct, 18:00"
function deadlineInText(text, postedIso) {
    const m = String(text).match(/deadline[:\s-]*(?:is\s+)?(?:[A-Za-z]+day,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*/i)
        || String(text).match(/deadline[:\s-]*(?:is\s+)?(?:[A-Za-z]+day,?\s+)?([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?/i);
    if (!m) return null;
    let day; let mon;
    if (/^\d/.test(m[1])) { day = Number(m[1]); mon = MONTHS[m[2].toLowerCase()]; } else { mon = MONTHS[m[1].toLowerCase()]; day = Number(m[2]); }
    if (mon == null || !day || day > 31) return null;
    const posted = postedIso ? new Date(postedIso) : new Date();
    let year = posted.getUTCFullYear();
    if (mon < posted.getUTCMonth() - 6) year++;
    return new Date(Date.UTC(year, mon, day)).toISOString().slice(0, 10);
}
const today = new Date().toISOString().slice(0, 10);

function matches(text) {
    const t = text.toLowerCase();
    if (block.some((k) => t.includes(k))) return null;
    if (!want.length) return [];
    const hit = want.filter((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t));
    return hit.length ? hit : null;
}
const emailsIn = (t) => [...new Set(String(t).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];

const rows = [];
const seen = new Set();
const byUrl = new Map();
function add(row) {
    // SourceBottle cross-lists a call-out under several industries and countries
    const dup = byUrl.get(row.url);
    if (dup) {
        if (!dup.industries.includes(row.industry)) dup.industries.push(row.industry);
        if (!dup.countries.includes(row.country)) dup.countries.push(row.country);
        return;
    }
    if (row.postedAt && Date.parse(row.postedAt) < cutoff) return;
    if (openOnly && row.deadline && row.deadline < today) return;
    const key = (row.summary || row.title || '').toLowerCase().replace(/#\w+|https?:\S+|[^a-z0-9]+/g, ' ').trim().slice(0, 90);
    if (seen.has(row.url) || (key.length > 30 && seen.has(key))) return;
    seen.add(row.url); seen.add(key);
    row.contactEmails = emailsIn(row.summary);
    if (row.source === 'sourcebottle') {
        row.countries = [row.country]; row.industries = [row.industry];
        delete row.country; delete row.industry;
        byUrl.set(row.url, row);
    }
    rows.push(row);
}

// Topic match runs after the merge. A SourceBottle industry counts only when
// the call-out sits in 3 industries or fewer; some are filed under all 12.
function topicHits(row) {
    const inds = row.industries?.length && row.industries.length <= 3 ? row.industries.join(' ') : '';
    return matches(`${row.title || ''} ${row.summary || ''} ${row.outlet || ''} ${inds}`);
}

// ---- 1. SourceBottle ----
function parseSourceBottle(html, iid, cc) {
    const out = [];
    for (const block of html.split('<div class="result">').slice(1)) {
        const link = block.match(/<a href="([^"]*query\.asp\?[^"]*qid=(\d+)[^"]*)">([\s\S]*?)<\/a>/);
        if (!link) continue;
        const posted = parseDay(block.match(/Date Posted:\s*([^<]+)/)?.[1]);
        const deadlineRaw = strip(block.match(/Deadline:\s*([^<]+)/)?.[1] || '') || null;
        const pub = block.match(/<p class="publication">([\s\S]*?)<\/p>/)?.[1] || '';
        out.push({
            source: 'sourcebottle',
            title: strip(link[3]),
            summary: strip(block.match(/<div class="summary">([\s\S]*?)<\/div>/)?.[1] || ''),
            outlet: strip(pub.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] || '') || null,
            requesterRole: strip(pub.match(/\(([^)]+)\)/)?.[1] || '') || null,
            author: null,
            country: SB_COUNTRY_NAMES[cc],
            industry: SB_INDUSTRIES[iid] || SB_PRODUCTS[iid],
            postedAt: posted,
            deadline: parseDay(deadlineRaw),
            deadlineText: deadlineRaw,
            url: `${SB}/query.asp?qid=${link[2]}`,
            howToRespond: 'Free SourceBottle account; respond on the call-out page.',
        });
    }
    return out;
}

if (srcs.has('sourcebottle')) {
    const iids = Object.keys({ ...SB_INDUSTRIES, ...(includeProductRequests ? SB_PRODUCTS : {}) }).map(Number);
    const jobs = sbCountries.flatMap((cc) => iids.map((iid) => ({ cc, iid })));
    log.info(`SourceBottle: ${jobs.length} industry lists across ${sbCountries.join(', ')}...`);
    let failed = 0;
    await pool(jobs, async ({ cc, iid }) => {
        for (let p = 1; p <= 20; p++) {
            let html;
            try {
                html = await get(`${SB}/industry-list-results.asp?iid=${iid}&scid=${SB_COUNTRIES[cc]}${p > 1 ? `&p=${p}` : ''}`);
            } catch (err) {
                if (++failed <= 3) log.warning(`SourceBottle ${cc}/${iid} p${p}: ${err.message}`);
                return;
            }
            const items = parseSourceBottle(html, iid, cc);
            items.forEach(add);
            const oldest = items.at(-1)?.postedAt;
            if (items.length < 12 || !html.includes(`p=${p + 1}"`) || (oldest && Date.parse(oldest) < cutoff)) return;
        }
    });
}

// ---- 2. Bluesky ----
function bskyLinks(post) {
    const links = [];
    for (const f of post.record?.facets || []) for (const feat of f.features || []) if (feat.uri) links.push(feat.uri);
    if (post.embed?.external?.uri) links.push(post.embed.external.uri);
    return [...new Set(links)];
}
if (srcs.has('bluesky')) {
    for (const tag of BSKY_TAGS) {
        let cursor; let n = 0;
        for (let page = 0; page < 10 && !pastDeadline(); page++) {
            let j;
            try {
                j = await get(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(tag)}&sort=latest&limit=100${cursor ? `&cursor=${cursor}` : ''}`, 'json');
            } catch (err) { log.warning(`Bluesky ${tag}: ${err.message}`); break; }
            const posts = j.posts || [];
            for (const p of posts) {
                const text = p.record?.text || '';
                if (p.record?.reply) continue; // replies are responses, not requests
                const rkey = p.uri.split('/').pop();
                add({
                    source: 'bluesky',
                    title: text.split('\n')[0].slice(0, 140),
                    summary: text,
                    outlet: null,
                    requesterRole: null,
                    author: p.author?.displayName || p.author?.handle || null,
                    authorHandle: p.author?.handle || null,
                    authorProfileUrl: p.author?.handle ? `https://bsky.app/profile/${p.author.handle}` : null,
                    countries: [],
                    industries: [],
                    postedAt: p.record?.createdAt || p.indexedAt,
                    deadline: deadlineInText(text, p.record?.createdAt),
                    deadlineText: null,
                    url: `https://bsky.app/profile/${p.author?.handle || p.author?.did}/post/${rkey}`,
                    links: bskyLinks(p),
                    likes: p.likeCount ?? null,
                    replies: p.replyCount ?? null,
                    howToRespond: 'Reply to or message the author on Bluesky, or follow the link in the post.',
                });
                n++;
            }
            cursor = j.cursor;
            const oldest = posts.at(-1)?.record?.createdAt;
            if (!cursor || !posts.length || (oldest && Date.parse(oldest) < cutoff)) break;
        }
        log.info(`Bluesky ${tag}: ${n} posts read.`);
    }
}

// ---- 3. Mastodon ----
if (srcs.has('mastodon')) {
    for (const [host, tag] of MASTODON) {
        let maxId; let n = 0;
        for (let page = 0; page < 5 && !pastDeadline(); page++) {
            let posts;
            try {
                posts = await get(`https://${host}/api/v1/timelines/tag/${tag}?limit=40${maxId ? `&max_id=${maxId}` : ''}`, 'json');
            } catch (err) { log.warning(`Mastodon ${host} #${tag}: ${err.message}`); break; }
            for (const p of posts) {
                if (p.in_reply_to_id || p.reblog) continue;
                const text = strip(p.content);
                add({
                    source: 'mastodon',
                    title: text.split('\n')[0].slice(0, 140),
                    summary: text,
                    outlet: null,
                    requesterRole: null,
                    author: p.account?.display_name || p.account?.acct || null,
                    authorHandle: p.account?.acct || null,
                    authorProfileUrl: p.account?.url || null,
                    countries: [],
                    industries: [],
                    postedAt: p.created_at,
                    deadline: deadlineInText(text, p.created_at),
                    deadlineText: null,
                    url: p.url || p.uri,
                    links: [...new Set((String(p.content).match(/href="([^"]+)"/g) || []).map((h) => decode(h.slice(6, -1))).filter((h) => !/\/tags\/|\/@/.test(h)))],
                    likes: p.favourites_count ?? null,
                    replies: p.replies_count ?? null,
                    howToRespond: 'Reply to or message the author on Mastodon, or follow the link in the post.',
                });
                n++;
            }
            maxId = posts.at(-1)?.id;
            const oldest = posts.at(-1)?.created_at;
            if (!maxId || posts.length < 40 || (oldest && Date.parse(oldest) < cutoff)) break;
        }
        log.info(`Mastodon ${host} #${tag}: ${n} posts read.`);
    }
}

// ---- output ----
const counts = {};
const kept = [];
for (const row of rows) {
    const hit = topicHits(row);
    if (hit == null) continue;
    row.matchedTopics = hit;
    kept.push(row);
    counts[row.source] = (counts[row.source] || 0) + 1;
}
kept.sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));
let out = 0;
for (const row of kept.slice(0, cap)) {
    await Actor.pushData(row);
    out++;
    try {
        const res = await Actor.charge({ eventName: 'request_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}
if (!out) {
    await Actor.pushData({ note: `No journalist requests in the last ${days} day(s)${want.length ? ` matching ${want.join(', ')}` : ''}. Not charged.` });
}
await Actor.setValue('SUMMARY', { requests: out, matched: kept.length, read: rows.length, perSource: counts, days, topics: want });
log.info(`Done: ${out} request(s). Per source: ${JSON.stringify(counts)}`);
await Actor.exit();
