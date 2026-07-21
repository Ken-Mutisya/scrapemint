// Brand Mention Monitor: News, Reddit, Hacker News & Telegram
//
// Strategy
// --------
// One run sweeps keyless public sources for brand/keyword mentions:
//   google-news : news.google.com RSS search (any language/country)
//   reddit      : reddit.com/search.rss Atom feed (newest first)
//   hackernews  : hn.algolia.com search_by_date JSON (stories + comments)
//   telegram    : t.me/s/<channel> public previews, filtered by keyword
//                 (buyer supplies channels to watch; Telegram has no
//                 keyless global search)
// With dedupe on (default), seen mention ids live in a named key-value
// store, so a scheduled run emits ONLY NEW mentions: an alert feed.
// Quiet days push nothing and cost nothing.
//
// Pay per event
// -------------
//   mention_row ($0.005) per pushed mention. First 2 rows per run free.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const SOURCES = ['google-news', 'reddit', 'hackernews', 'telegram'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    sources = ['google-news', 'reddit', 'hackernews'],
    telegramChannels = [],
    newsLanguage = 'en-US',
    newsCountry = 'US',
    maxPerKeywordPerSource = 25,
    maxRows = 200,
    dedupe = true,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(keywords);
const srcs = [...new Set(asList(sources).map((s) => s.toLowerCase()))].filter((s) => SOURCES.includes(s));
const channels = asList(telegramChannels).map((c) => c.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').replace(/\/.*$/, ''));
const perCap = Math.max(1, Math.min(100, Number(maxPerKeywordPerSource) || 25));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

if (!kws.length || !srcs.length) {
    log.error('Provide at least one keyword and one source.');
    await Actor.exit();
}
if (srcs.includes('telegram') && !channels.length) {
    log.warning('telegram source selected but no telegramChannels given; skipping Telegram (it has no keyless global search).');
}

const seenStore = dedupe ? await Actor.openKeyValueStore('brand-mention-monitor-state') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-ids')) || []) seen.add(String(k));

async function fetchText(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, ...headers } });
        if (!res.ok) { log.warning(`HTTP ${res.status}: ${url.split('?')[0]}`); return null; }
        return (await res.text()).slice(0, 3000000);
    } catch (err) {
        log.warning(`Fetch failed (${url.split('?')[0]}): ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'mention_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const foundAt = new Date().toISOString();
const snippet = (s, n = 400) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, n) : null;
};

async function emit(keyword, source, id, row) {
    if (rowsPushed >= cap) return false;
    const key = `${source}:${id}`;
    if (seen.has(key)) return true;
    seen.add(key);
    await flushRow({ keyword, source, ...row, foundAt });
    return true;
}

// ---------- sources ----------

async function sweepGoogleNews(kw) {
    const hl = String(newsLanguage || 'en-US').trim() || 'en-US';
    const gl = String(newsCountry || 'US').trim().toUpperCase() || 'US';
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${kw}"`)}&hl=${encodeURIComponent(hl)}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
    const xml = await fetchText(url, { Accept: 'application/rss+xml, application/xml, text/xml' });
    if (!xml) return;
    const $ = cheerio.load(xml, { xmlMode: true });
    let n = 0;
    for (const el of $('item').toArray()) {
        if (n >= perCap) break;
        const item = $(el);
        const link = item.find('link').first().text().trim();
        const ok = await emit(kw, 'google-news', item.find('guid').first().text().trim() || link, {
            title: snippet(item.find('title').first().text(), 300),
            snippet: null,
            url: link || null,
            author: null,
            community: item.find('source').first().text().trim() || null,
            publishedAt: item.find('pubDate').first().text().trim() || null,
        });
        if (!ok) return;
        n += 1;
    }
    log.info(`google-news "${kw}": ${n} item(s) scanned.`);
}

async function sweepReddit(kw) {
    const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(`"${kw}"`)}&sort=new&limit=${perCap}`;
    const xml = await fetchText(url, { Accept: 'application/atom+xml, application/xml' });
    if (!xml) return;
    const $ = cheerio.load(xml, { xmlMode: true });
    const entries = $('entry').toArray();
    if (!entries.length) log.warning(`reddit "${kw}": 0 entries (Reddit sometimes blocks datacenter IPs).`);
    let n = 0;
    for (const el of entries) {
        if (n >= perCap) break;
        const e = $(el);
        const id = e.find('id').first().text().trim();
        const html = e.find('content').first().text();
        const ok = await emit(kw, 'reddit', id || e.find('link').attr('href'), {
            title: snippet(e.find('title').first().text(), 300),
            snippet: snippet(cheerio.load(html || '')('*').text()),
            url: e.find('link').attr('href') || null,
            author: e.find('author name').first().text().trim() || null,
            community: e.find('category').attr('label') || e.find('category').attr('term') || null,
            publishedAt: e.find('updated').first().text().trim() || null,
        });
        if (!ok) return;
        n += 1;
    }
    log.info(`reddit "${kw}": ${n} entr(ies) scanned.`);
}

async function sweepHackerNews(kw) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(`"${kw}"`)}&tags=(story,comment)&hitsPerPage=${perCap}`;
    const raw = await fetchText(url, { Accept: 'application/json' });
    if (!raw) return;
    let hits = [];
    try { hits = JSON.parse(raw).hits || []; } catch { log.warning('hackernews: bad JSON'); return; }
    let n = 0;
    for (const h of hits) {
        if (n >= perCap) break;
        const isComment = !h.title;
        const ok = await emit(kw, 'hackernews', h.objectID, {
            title: snippet(h.title || h.story_title, 300),
            snippet: isComment ? snippet(cheerio.load(h.comment_text || '')('*').text()) : null,
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            author: h.author || null,
            community: isComment ? 'comment' : 'story',
            publishedAt: h.created_at || null,
        });
        if (!ok) return;
        n += 1;
    }
    log.info(`hackernews "${kw}": ${n} hit(s) scanned.`);
}

async function sweepTelegramChannel(channel, kwList) {
    const html = await fetchText(`https://t.me/s/${channel}`);
    if (!html) return;
    const $ = cheerio.load(html);
    let n = 0;
    for (const el of $('.tgme_widget_message').toArray()) {
        const msg = $(el);
        const post = msg.attr('data-post') || '';
        const id = post.split('/')[1];
        if (!id) continue;
        const text = msg.find('.tgme_widget_message_text').first().text().trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const kw = kwList.find((k) => lower.includes(k.toLowerCase()));
        if (!kw) continue;
        if (n >= perCap) break;
        const ok = await emit(kw, 'telegram', post, {
            title: null,
            snippet: snippet(text),
            url: `https://t.me/${post}`,
            author: null,
            community: channel,
            publishedAt: msg.find('.tgme_widget_message_date time').attr('datetime') || null,
        });
        if (!ok) return;
        n += 1;
    }
    log.info(`telegram @${channel}: ${n} matching message(s).`);
}

// ---------- sweep ----------

// One source's unexpected throw must not fail the whole run: an alerting
// actor on a schedule degrades to the remaining sources, never crashes.
const safely = (label, p) => p.catch((err) => log.warning(`${label} failed: ${err?.message}`));

for (const kw of kws) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
    if (rowsPushed >= cap) break;
    if (srcs.includes('google-news')) await safely(`google-news "${kw}"`, sweepGoogleNews(kw));
    if (srcs.includes('reddit')) await safely(`reddit "${kw}"`, sweepReddit(kw));
    if (srcs.includes('hackernews')) await safely(`hackernews "${kw}"`, sweepHackerNews(kw));
}
if (srcs.includes('telegram')) {
    for (const ch of channels) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        if (rowsPushed >= cap) break;
        await safely(`telegram @${ch}`, sweepTelegramChannel(ch, kws));
    }
}

if (seenStore && rowsPushed > 0) {
    try {
        await seenStore.setValue('seen-ids', [...seen].slice(-300000));
    } catch (err) {
        log.warning(`could not persist dedupe state: ${err?.message}`);
    }
}

// A run that finds nothing must say why rather than hand back an empty
// dataset: an unreachable Telegram channel, a quiet keyword and dedupe
// having already returned everything all look identical otherwise. Pushed
// directly so it stays free rather than counting as a mention row.
if (rowsPushed === 0) {
    await Actor.pushData({
        type: 'note',
        input: kws.join(', '),
        found: false,
        note: `no ${dedupe ? 'new ' : ''}mentions found across ${srcs.join(', ')}`
            + `${channels.length ? ` (Telegram channels: ${channels.join(', ')})` : ''}. `
            + `${dedupe ? 'Dedupe is on, so anything earlier runs already returned is skipped. ' : ''}`
            + 'Try another keyword, add sources, or check the channel names. Not charged.',
    });
}

log.info(`Done. ${rowsPushed} new mention(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).${dedupe ? ' Dedupe on: repeat runs emit only new mentions.' : ''}`);
await Actor.exit();
