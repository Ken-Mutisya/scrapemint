// Medium Scraper: articles from Medium tags, keyword search, authors and
// publications, with claps, responses, reading time, word count, tags,
// author follower count, publication, dates and optionally the full text.
//
// Strategy
// --------
// medium.com's own GraphQL endpoint (POST https://medium.com/_/graphql)
// answers logged-out requests from Apify's IPs (a home IP gets Cloudflare's
// block page). Feeds used:
//   tagFeed(tagSlug, mode, paging: {limit, from, source})
//       mode: HOT (default), NEW, TOP_WEEK, TOP_MONTH, TOP_YEAR, TOP_ALL_TIME
//       paging continues with pagingInfo.next {from, source}
//   search(query) { ... on Search { posts(pagingOptions: {limit, page}) } }
//   userResult(username) { ... on User { homepagePostsConnection(paging) } }
//   collectionByDomainOrSlug(domainOrSlug) { homepagePostsConnection(paging) }
//   postResult(id) { ... on Post { content { bodyModel { paragraphs } } } }
// Article bodies are fetched for up to 10 posts per request with aliases.
// Members-only (locked) posts return only their opening paragraphs to a
// logged-out reader; those rows say contentIsPreview: true.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   article      ($0.002) one article's metadata
//   article_text ($0.004) the same article with its text; charged instead
// No start fee. A source with no articles is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GQL = 'https://medium.com/_/graphql';
const PAGE = 25;
const MODES = { hot: null, new: 'NEW', top_week: 'TOP_WEEK', top_month: 'TOP_MONTH', top_year: 'TOP_YEAR', top_all_time: 'TOP_ALL_TIME' };
const POST = `id title mediumUrl uniqueSlug firstPublishedAt latestPublishedAt clapCount readingTime wordCount isLocked visibility
 postResponses { count } extendedPreviewContent { subtitle } previewImage { id } tags { id displayTitle }
 creator { id name username bio socialStats { followerCount followingCount } }
 collection { id name slug domain subscriberCount }`;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tags = [],
    tagSort = 'hot',
    searchQueries = [],
    authors = [],
    publications = [],
    articleUrls = [],
    includeContent = false,
    maxItemsPerSource = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSource = Math.max(1, Number(maxItemsPerSource) || 100);

async function gql(query) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(GQL, {
                method: 'POST',
                headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://medium.com', Referer: 'https://medium.com/' },
                body: JSON.stringify([{ operationName: null, variables: {}, query }]),
                signal: AbortSignal.timeout(45_000),
            });
            const text = await r.text();
            let d = null;
            try { d = JSON.parse(text)?.[0]; } catch { d = null; }
            if (d?.data) return d.data;
            const msg = d?.errors?.[0]?.message || `HTTP ${r.status}${/cloudflare/i.test(text) ? ' (Cloudflare block)' : ''}`;
            if (d?.errors && r.status < 500) throw Object.assign(new Error(msg), { fatal: true });
            last = new Error(msg);
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

// ---------- Sources ----------

const slug = (s) => String(s).trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseAuthor(v) {
    const s = String(v).trim();
    let m = s.match(/medium\.com\/@([\w.-]+)/i);
    if (m) return m[1];
    m = s.match(/^https?:\/\/([\w-]+)\.medium\.com/i);
    if (m && m[1] !== 'www') return m[1];
    if (/^@?[\w.-]+$/.test(s)) return s.replace(/^@/, '');
    return null;
}

function parsePublication(v) {
    const s = String(v).trim();
    if (!/^https?:\/\//i.test(s)) return s.replace(/^\/|\/$/g, '') || null;
    let url;
    try { url = new URL(s); } catch { return null; }
    if (/(^|\.)medium\.com$/i.test(url.hostname)) {
        if (url.hostname !== 'medium.com' && url.hostname !== 'www.medium.com') return url.hostname;
        const first = url.pathname.split('/').filter(Boolean)[0];
        return first && !first.startsWith('@') ? first : null;
    }
    return url.hostname.replace(/^www\./, '');
}

const postId = (u) => String(u).match(/(?:^|[-/])([0-9a-f]{10,12})(?:[/?#]|$)/i)?.[1] || null;

function buildSources() {
    const out = [];
    const mode = MODES[tagSort] ?? null;
    for (const t of list(tags)) {
        const m = t.match(/medium\.com\/tag\/([^/?#]+)/i);
        const s = slug(m ? m[1] : t);
        if (s) out.push({ kind: 'tag', value: s, mode, label: `tag ${s}${mode ? ` (${tagSort})` : ''}` });
    }
    for (const q of list(searchQueries)) out.push({ kind: 'search', value: q, label: `search "${q}"` });
    for (const a of list(authors)) {
        const u = parseAuthor(a);
        out.push(u ? { kind: 'author', value: u, label: `author @${u}` } : { error: `Not a Medium author (username, @username or profile URL): ${a}` });
    }
    for (const p of list(publications)) {
        const v = parsePublication(p);
        out.push(v ? { kind: 'publication', value: v, label: `publication ${v}` } : { error: `Not a Medium publication (slug, medium.com/slug or its domain): ${p}` });
    }
    const ids = [];
    for (const u of list(articleUrls)) {
        const id = postId(u);
        if (id) ids.push(id);
        else out.push({ error: `Not a Medium article URL (it should end in the article id, e.g. ...-a64152b37c35): ${u}` });
    }
    if (ids.length) out.push({ kind: 'articles', value: ids, label: `${ids.length} article URL(s)` });
    return out;
}

// GraphQL literal for a JS value; inlined so the query never depends on
// Medium's input type names.
const lit = (v) => (v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }` : JSON.stringify(v));

// Yields arrays of posts, one feed page at a time.
async function* feed(s) {
    if (s.kind === 'tag') {
        let paging = { limit: PAGE };
        for (;;) {
            const d = await gql(`query { tagFeed(tagSlug: ${lit(s.value)}, paging: ${lit(paging)}${s.mode ? `, mode: ${s.mode}` : ''}) { items { post { ${POST} } } pagingInfo { next { from limit source to } } } }`);
            const items = (d.tagFeed?.items || []).map((i) => i.post).filter(Boolean);
            yield items;
            const next = d.tagFeed?.pagingInfo?.next;
            if (!items.length || !next?.from) return;
            paging = { limit: PAGE, from: next.from, ...(next.source ? { source: next.source } : {}) };
        }
    }
    if (s.kind === 'search') {
        for (let page = 0; page < 1000; page++) {
            const d = await gql(`query { search(query: ${lit(s.value)}) { ... on Search { posts(pagingOptions: ${lit({ limit: PAGE, page })}, algoliaOptions: { clickAnalytics: false }) { ... on SearchPost { items { ${POST} } pagingInfo { next { page limit } } } } } } }`);
            const conn = d.search?.posts;
            const items = conn?.items || [];
            yield items;
            if (!items.length || !conn?.pagingInfo?.next) return;
        }
        return;
    }
    if (s.kind === 'author' || s.kind === 'publication') {
        let paging = { limit: PAGE };
        for (;;) {
            const d = s.kind === 'author'
                ? await gql(`query { userResult(username: ${lit(s.value)}) { __typename ... on User { homepagePostsConnection(paging: ${lit(paging)}) { posts { ${POST} } pagingInfo { next { from limit } } } } } }`)
                : await gql(`query { collectionByDomainOrSlug(domainOrSlug: ${lit(s.value)}) { id homepagePostsConnection(paging: ${lit(paging)}) { posts { ${POST} } pagingInfo { next { from limit } } } } }`);
            const holder = s.kind === 'author' ? d.userResult : d.collectionByDomainOrSlug;
            if (!holder || holder.__typename === 'NotFound') throw Object.assign(new Error(`${s.kind === 'author' ? 'No Medium user' : 'No Medium publication'} "${s.value}".`), { notFound: true });
            const conn = holder.homepagePostsConnection;
            const items = conn?.posts || [];
            yield items;
            const next = conn?.pagingInfo?.next;
            if (!items.length || !next?.from) return;
            paging = { limit: PAGE, from: next.from };
        }
    }
    if (s.kind === 'articles') {
        for (let i = 0; i < s.value.length; i += 10) {
            const ids = s.value.slice(i, i + 10);
            const d = await gql(`query { ${ids.map((id, k) => `p${k}: postResult(id: "${id}") { __typename ... on Post { ${POST} } }`).join(' ')} }`);
            yield ids.map((_, k) => d[`p${k}`]).filter((p) => p?.__typename === 'Post');
        }
    }
}

// ---------- Content ----------

function paragraphsToText(ps) {
    const lines = [];
    for (const p of ps || []) {
        const t = (p.text || '').trim();
        if (!t && p.type !== 'IMG') continue;
        switch (p.type) {
            case 'H2': case 'H3': lines.push(`## ${t}`); break;
            case 'H4': lines.push(`### ${t}`); break;
            case 'ULI': lines.push(`- ${t}`); break;
            case 'OLI': lines.push(`1. ${t}`); break;
            case 'PRE': lines.push('```', t, '```'); break;
            case 'BQ': case 'PQ': lines.push(`> ${t}`); break;
            case 'IMG': if (t) lines.push(`[Image: ${t}]`); break;
            default: lines.push(t);
        }
    }
    return lines.join('\n\n').replace(/\n\n(- |1\. )/g, '\n$1').trim();
}

async function contentFor(posts) {
    const out = new Map();
    for (let i = 0; i < posts.length; i += 10) {
        const ids = posts.slice(i, i + 10).map((p) => p.id);
        try {
            const d = await gql(`query { ${ids.map((id, k) => `p${k}: postResult(id: "${id}") { __typename ... on Post { id content { bodyModel { paragraphs { type text } } } } }`).join(' ')} }`);
            ids.forEach((id, k) => { const ps = d[`p${k}`]?.content?.bodyModel?.paragraphs; if (ps) out.set(id, paragraphsToText(ps)); });
        } catch (err) {
            log.warning(`Article text failed for ${ids.length} post(s): ${err?.message}`);
        }
    }
    return out;
}

// ---------- Rows ----------

const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

function row(p, source, text) {
    const c = p.creator || {};
    const col = p.collection || null;
    const r = {
        articleId: p.id,
        url: p.mediumUrl || null,
        title: p.title || null,
        subtitle: p.extendedPreviewContent?.subtitle || null,
        authorName: c.name || null,
        authorUsername: c.username || null,
        authorUrl: c.username ? `https://medium.com/@${c.username}` : null,
        authorFollowers: c.socialStats?.followerCount ?? null,
        authorBio: c.bio || null,
        publicationName: col?.name || null,
        publicationSlug: col?.slug || null,
        publicationUrl: col ? (col.domain ? `https://${col.domain}` : col.slug ? `https://medium.com/${col.slug}` : null) : null,
        publicationFollowers: col?.subscriberCount ?? null,
        publishedAt: iso(p.firstPublishedAt),
        updatedAt: iso(p.latestPublishedAt),
        claps: p.clapCount ?? null,
        responses: p.postResponses?.count ?? null,
        readingTimeMinutes: Number(p.readingTime) > 0 ? Math.round(p.readingTime * 10) / 10 : null,
        wordCount: Number(p.wordCount) > 0 ? p.wordCount : null,
        isMembersOnly: p.isLocked ?? null,
        tags: (p.tags || []).map((t) => t.id).filter(Boolean),
        imageUrl: p.previewImage?.id ? `https://miro.medium.com/v2/resize:fit:1200/${p.previewImage.id}` : null,
        source,
        scrapedAt: new Date().toISOString(),
    };
    if (includeContent) {
        r.text = text ?? null;
        r.contentIsPreview = text ? Boolean(p.isLocked) : null;
    }
    return r;
}

// ---------- Run ----------

let articles = 0;
let keepGoing = true;
const failures = [];
const perSourceCounts = [];
const seen = new Set();

async function charge(eventName) {
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const sources = buildSources();
if (!sources.length) sources.push({ kind: 'tag', value: 'artificial-intelligence', mode: null, label: 'tag artificial-intelligence' });

for (const s of sources) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    try {
        for await (const batch of feed(s)) {
            const posts = [];
            for (const p of batch) {
                if (!p?.id || seen.has(p.id) || count + posts.length >= perSource) continue;
                seen.add(p.id);
                posts.push(p);
            }
            const texts = includeContent && posts.length ? await contentFor(posts) : new Map();
            for (const p of posts) {
                const text = texts.get(p.id);
                await Actor.pushData(row(p, s.label, text));
                articles += 1;
                count += 1;
                if (!(await charge(includeContent && text ? 'article_text' : 'article'))) { keepGoing = false; break; }
            }
            if (!keepGoing || count >= perSource) break;
            await sleep(400);
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ source: s.label, error: String(err?.message || err) });
        if (err.notFound) await Actor.pushData({ rowType: 'error', error: `${err.message} Not charged.` });
    }
    log.info(`${s.label}: ${count} article(s).`);
    perSourceCounts.push({ source: s.label, articles: count });
}

if (!articles) await Actor.pushData({ rowType: 'note', note: 'No articles found. Not charged.' });
await Actor.setValue('SUMMARY', { articles, sources: perSourceCounts, failures });
log.info(`Done. ${articles} article(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
