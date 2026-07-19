// RSS Feed Scraper
//
// Strategy
// --------
// Plain HTTP fetches of user-supplied RSS 2.0 / RSS 1.0 (RDF) / Atom
// feeds, parsed with regexes (real-world feeds are too often malformed
// for a strict XML parser - CDATA, stray entities, truncated tails).
// Plain site URLs are accepted too: the actor looks for the feed
// <link rel="alternate"> tag in the HTML head, then falls back to
// common feed paths (/feed, /rss.xml, /atom.xml, /index.xml).
//
// Pay per event
// -------------
//   item_row per feed item. Dead URLs, pages with no discoverable feed
//   and empty feeds are free note rows. First 2 chargeable rows per run
//   are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 300;
const MAX_BODY = 8000000;
const SUMMARY_CAP = 2000;
const CONTENT_CAP = 20000;
const FALLBACK_PATHS = ['/feed', '/rss.xml', '/atom.xml', '/index.xml'];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { feedUrls = [], maxPerFeed = 50, sinceDays = 0, includeFullContent = false, newOnly = false, maxRows = 500 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const urls = [...new Set(asTokens(feedUrls))];
const perFeed = clampNum(maxPerFeed, 50, 1, 5000);
const rowCap = clampNum(maxRows, 500, 1, 25000);
const days = clampNum(sinceDays, 0, 0, 3650);
const dateFloorMs = days > 0 ? Date.now() - days * 86400000 : null;

if (urls.length === 0) {
    log.warning('No feed URLs given. Add at least one RSS/Atom feed URL or site URL.');
    await Actor.exit();
}

async function getText(url) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                redirect: 'follow',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; ScrapemintRSS/1.0; +https://apify.com/scrapemint/rss-feed-scraper)',
                    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
                },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            let text = await res.text();
            if (text.length > MAX_BODY) {
                // Truncate oversized feeds at the last complete item so the tail
                // does not produce a half-parsed row.
                const cut = Math.max(text.lastIndexOf('</item>'), text.lastIndexOf('</entry>'));
                text = cut > 0 ? text.slice(0, cut + 8) : text.slice(0, MAX_BODY);
            }
            await sleep(SPACING_MS);
            return { text, finalUrl: res.url || url };
        } catch (err) {
            if (attempt === 2) return { error: err?.message };
            await sleep(3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// --- text helpers --------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };
function decodeEntities(s) {
    return s
        .replace(/&(#x?[0-9a-fA-F]+);/g, (m, code) => {
            try {
                const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
                return Number.isFinite(n) && n > 0 && n < 1114112 ? String.fromCodePoint(n) : m;
            } catch { return m; }
        })
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, name) => ENTITIES[name] ?? m);
}
const stripCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = (s) => decodeEntities(stripCdata(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// First matching tag's inner text from an XML fragment.
function tag(frag, names) {
    for (const name of names) {
        const m = frag.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
        if (m && m[1].trim()) return m[1].trim();
    }
    return null;
}
function attr(frag, tagName, attrName, filter) {
    for (const m of frag.matchAll(new RegExp(`<${tagName}\\s[^>]*?>`, 'gi'))) {
        const t = m[0];
        if (filter && !filter.test(t)) continue;
        const a = t.match(new RegExp(`${attrName}=["']([^"']+)["']`, 'i'));
        if (a) return a[1];
    }
    return null;
}

const toIso = (s) => {
    if (!s) return null;
    const t = Date.parse(stripTags(s));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// --- feed parsing ---------------------------------------------------------------

function feedKind(text) {
    const head = text.slice(0, 2000).toLowerCase();
    if (head.includes('<rss')) return 'rss';
    if (head.includes('<feed')) return 'atom';
    if (head.includes('<rdf:rdf')) return 'rdf';
    return null;
}

function parseFeed(text, kind) {
    const isAtom = kind === 'atom';
    const headEnd = text.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
    const header = headEnd > 0 ? text.slice(0, headEnd) : text.slice(0, 4000);
    const feedTitle = tag(header, ['title']) ? stripTags(tag(header, ['title'])) : null;
    const itemRe = isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
    const items = [];
    for (const [, frag] of text.matchAll(itemRe)) {
        const title = tag(frag, ['title']);
        let link;
        if (isAtom) {
            link = attr(frag, 'link', 'href', /rel=["']alternate["']/i) || attr(frag, 'link', 'href');
        } else {
            const raw = tag(frag, ['link']);
            link = raw ? stripTags(raw) : attr(frag, 'link', 'href');
        }
        const guid = tag(frag, isAtom ? ['id'] : ['guid']) || link;
        const published = toIso(tag(frag, isAtom ? ['published', 'updated'] : ['pubDate', 'dc:date']));
        const authorFrag = isAtom ? tag(frag, ['author']) : null;
        const author = stripTags((isAtom ? (authorFrag ? tag(authorFrag, ['name']) || authorFrag : null) : tag(frag, ['dc:creator', 'author'])) || '') || null;
        const summarySrc = tag(frag, isAtom ? ['summary', 'content'] : ['description', 'content:encoded']);
        const contentSrc = tag(frag, isAtom ? ['content'] : ['content:encoded']);
        const categories = [...new Set(
            isAtom
                ? [...frag.matchAll(/<category\s[^>]*?term=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]))
                : [...frag.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((m) => stripTags(m[1])),
        )].filter(Boolean).slice(0, 10);
        const imageUrl = attr(frag, 'enclosure', 'url', /type=["']image/i)
            || attr(frag, 'media:content', 'url') || attr(frag, 'media:thumbnail', 'url')
            || attr(frag, 'enclosure', 'url');
        items.push({
            title: title ? stripTags(title) : null,
            link: link ? decodeEntities(link.trim()) : null,
            guid: guid ? stripTags(guid) : null,
            publishedAt: published,
            author,
            summary: summarySrc ? stripTags(summarySrc).slice(0, SUMMARY_CAP) : null,
            ...(includeFullContent ? { contentHtml: contentSrc ? stripCdata(contentSrc).trim().slice(0, CONTENT_CAP) : null } : {}),
            categories,
            imageUrl: imageUrl || null,
        });
    }
    return { feedTitle, items };
}

// A site URL instead of a feed: look for the alternate link tag, then
// common feed paths.
async function discoverFeed(html, baseUrl) {
    const head = html.slice(0, 50000);
    const href = attr(head, 'link', 'href', /rel=["']alternate["'][^>]*type=["']application\/(rss|atom)\+xml["']/i)
        || attr(head, 'link', 'href', /type=["']application\/(rss|atom)\+xml["']/i);
    const candidates = [];
    if (href) {
        try { candidates.push(new URL(decodeEntities(href), baseUrl).href); } catch { /* bad href */ }
    }
    for (const p of FALLBACK_PATHS) {
        try { candidates.push(new URL(p, baseUrl).href); } catch { /* bad base */ }
    }
    for (const c of candidates) {
        if (pastDeadline()) return null;
        const { text } = await getText(c);
        if (!text) continue;
        const kind = feedKind(text);
        if (kind) return { text, kind, url: c };
    }
    return null;
}

// --- charging + monitor ----------------------------------------------------------

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'item_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

const store = newOnly ? await Actor.openKeyValueStore('rss-feed-seen') : null;
const SEEN_KEY = 'seen-item-keys';
const SEEN_MAX = 400000;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- run ---------------------------------------------------------------------------

log.info(`Fetching ${urls.length} feed(s)${days > 0 ? `, items from the last ${days} day(s)` : ''}${newOnly ? ', NEW items only' : ''}...`);

for (const inputUrl of urls) {
    if (shouldStop()) break;
    const { text, error, finalUrl } = await getText(inputUrl);
    if (error) {
        await flushRow({ type: 'note', input: inputUrl, found: false, note: `fetch failed (${error}); not charged` }, false);
        continue;
    }
    let kind = feedKind(text);
    let feedText = text;
    let feedUrl = finalUrl || inputUrl;
    if (!kind) {
        const found = await discoverFeed(text, feedUrl);
        if (!found) {
            await flushRow({ type: 'note', input: inputUrl, found: false, note: 'not a feed and no RSS/Atom feed discovered on the page; not charged' }, false);
            continue;
        }
        ({ text: feedText, kind, url: feedUrl } = found);
        log.info(`${inputUrl} -> discovered feed ${feedUrl}`);
    }
    const { feedTitle, items } = parseFeed(feedText, kind);
    let emitted = 0;
    for (const item of items) {
        if (emitted >= perFeed || shouldStop()) break;
        if (dateFloorMs && item.publishedAt && Date.parse(item.publishedAt) < dateFloorMs) continue;
        const key = `${feedUrl}|${item.guid || item.link || item.title}`;
        if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
        if (newOnly) seen.add(key);
        await flushRow({ feedUrl, feedTitle, ...item, sourceInput: inputUrl }, true);
        emitted += 1;
    }
    if (emitted === 0 && !shouldStop()) {
        await flushRow({ type: 'note', input: inputUrl, found: false, note: `feed parsed (${items.length} item(s)) but nothing ${newOnly ? 'new ' : ''}${dateFloorMs ? 'in the date window ' : ''}to emit; not charged` }, false);
    }
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} item key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
