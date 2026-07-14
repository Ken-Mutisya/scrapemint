// YouTube Video & Channel Scraper
//
// Strategy
// --------
// YouTube server-renders a ytInitialData / ytInitialPlayerResponse JSON blob
// into every page (same SSR-blob recipe as our Chrome Web Store actor). We
// fetch the HTML keyless and parse the blob, no browser. Verified reachable
// from Apify DC IPs with a SOCS=CAI cookie (pre-declines the EU consent wall).
//
// Three modes:
//   search   -> /results?search_query=...   videoRenderer items.
//   channel  -> /@handle/videos             richItemRenderer > videoRenderer.
//   video    -> /watch?v=...                ytInitialPlayerResponse.videoDetails.
//                The watch page is more rate limited than search/channel, so it
//                retries on 429 and, if it still fails, emits a FREE note row.
//
// NOT included: transcripts (po-token gated) and comments. Scope is metadata.
//
// Pay per event
// -------------
//   video_row per video row. Bad input, not-found and could-not-fetch rows are
//   free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI' };
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const POOL_SIZE = 3;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { searchQueries = [], channels = [], videoUrls = [], maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

// Extract the JSON object literal that starts at the first "{" at/after idx,
// by brace-depth matching (string-aware). Returns null if unbalanced.
function objectAt(html, idx) {
    const start = html.indexOf('{', idx);
    if (start === -1) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i += 1) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return html.slice(start, i + 1); }
    }
    return null;
}

function extractBlob(html, marker) {
    const at = html.indexOf(marker);
    if (at === -1) return null;
    const raw = objectAt(html, at + marker.length);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

// Recursively collect every object carrying `key` (e.g. all videoRenderer).
function collect(node, key, out = []) {
    if (Array.isArray(node)) { for (const n of node) collect(n, key, out); return out; }
    if (node && typeof node === 'object') {
        if (node[key]) out.push(node[key]);
        for (const k of Object.keys(node)) collect(node[k], key, out);
    }
    return out;
}

const runsText = (o) => o?.simpleText ?? (o?.runs ? o.runs.map((r) => r.text).join('') : null);
const digits = (s) => { const m = String(s || '').replace(/,/g, '').match(/[\d.]+/); return m ? Number(m[0]) : null; };

// "1.2M views" / "1,234,567 views" -> integer where possible.
function parseViews(s) {
    if (!s) return null;
    const t = String(s).toLowerCase().replace(/,/g, '');
    const m = t.match(/([\d.]+)\s*([kmb]?)/);
    if (!m) return null;
    const n = Number(m[1]);
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
    return Math.round(n * mult);
}

// "PT12M3S" or "12:03" -> seconds.
function durationToSeconds(s) {
    if (!s) return null;
    if (/^\d+(:\d{2})+$/.test(s)) {
        return s.split(':').reduce((acc, v) => acc * 60 + Number(v), 0);
    }
    const m = String(s).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return null;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

const bestThumb = (t) => {
    const arr = t?.thumbnails;
    return Array.isArray(arr) && arr.length ? arr[arr.length - 1].url : null;
};

function videoRendererRow(vr, source, sourceInput) {
    const lengthText = runsText(vr.lengthText);
    return {
        source,
        sourceInput,
        videoId: vr.videoId || null,
        title: runsText(vr.title),
        url: vr.videoId ? `https://www.youtube.com/watch?v=${vr.videoId}` : null,
        channel: runsText(vr.ownerText || vr.longBylineText || vr.shortBylineText),
        channelId: vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
            || vr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
        views: parseViews(runsText(vr.viewCountText)),
        viewsText: runsText(vr.viewCountText),
        published: runsText(vr.publishedTimeText),
        durationSeconds: durationToSeconds(lengthText),
        durationText: lengthText,
        thumbnail: bestThumb(vr.thumbnail),
        badges: (vr.badges || []).map((b) => b?.metadataBadgeRenderer?.label).filter(Boolean),
    };
}

// Channel "videos" tabs now use lockupViewModel instead of videoRenderer.
function lockupRow(lv, source, sourceInput) {
    const md = lv.metadata?.lockupMetadataViewModel;
    const rows = md?.metadata?.contentMetadataViewModel?.metadataRows || [];
    const parts = rows.flatMap((r) => (r.metadataParts || []).map((p) => p?.text?.content).filter(Boolean));
    const viewsPart = parts.find((p) => /view/i.test(p));
    const agePart = parts.find((p) => /ago|hour|day|week|month|year|minute|second|premier|stream/i.test(p) && !/view/i.test(p));
    let durationText = null;
    const badge = collect(lv, 'thumbnailBadgeViewModel').find((b) => /^\d+(:\d{2})+$/.test(b?.text || ''));
    if (badge) durationText = badge.text;
    const thumbs = collect(lv, 'thumbnailViewModel')[0]?.image?.sources;
    return {
        source,
        sourceInput,
        videoId: lv.contentId || null,
        title: md?.title?.content || null,
        url: lv.contentId ? `https://www.youtube.com/watch?v=${lv.contentId}` : null,
        views: parseViews(viewsPart),
        viewsText: viewsPart || null,
        published: agePart || null,
        durationSeconds: durationToSeconds(durationText),
        durationText,
        thumbnail: Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : null,
    };
}

function videoDetailsRow(pr, ytData, sourceInput) {
    const vd = pr?.videoDetails || {};
    const micro = pr?.microformat?.playerMicroformatRenderer || {};
    return {
        source: 'video',
        sourceInput,
        videoId: vd.videoId || null,
        title: vd.title || null,
        url: vd.videoId ? `https://www.youtube.com/watch?v=${vd.videoId}` : null,
        channel: vd.author || null,
        channelId: vd.channelId || null,
        views: vd.viewCount ? Number(vd.viewCount) : null,
        durationSeconds: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
        published: micro.publishDate || null,
        uploaded: micro.uploadDate || null,
        category: micro.category || null,
        isLive: Boolean(vd.isLiveContent),
        keywords: (vd.keywords || []).slice(0, 20),
        description: (vd.shortDescription || '').slice(0, 1000) || null,
        thumbnail: bestThumb(vd.thumbnail),
        likes: (() => {
            const s = collect(ytData || {}, 'toggleButtonRenderer').find((t) => t?.defaultText?.accessibility);
            return s ? digits(s.defaultText.accessibility.accessibilityData.label) : null;
        })(),
    };
}

async function fetchHtml(url, { retry429 = 0 } = {}) {
    for (let attempt = 0; attempt <= retry429 + 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
            if (res.status === 429 && attempt < retry429) { await sleep(2000 * (attempt + 1)); continue; }
            const body = await res.text();
            return { status: res.status, body, finalUrl: res.url };
        } catch (err) {
            if (attempt >= retry429 + 1) return { status: 0, body: '', error: err?.message };
            await sleep(1500 * (attempt + 1));
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, body: '' };
}

function normalizeChannel(raw) {
    let s = raw.trim();
    if (/^https?:\/\//i.test(s)) {
        const path = s.replace(/^https?:\/\/(www\.)?youtube\.com/i, '').replace(/\/videos\/?$/, '');
        return `https://www.youtube.com${path}/videos`;
    }
    if (s.startsWith('@')) return `https://www.youtube.com/${s}/videos`;
    return `https://www.youtube.com/@${s}/videos`;
}

function normalizeVideo(raw) {
    const s = raw.trim();
    let id = null;
    const m = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    if (m) id = m[1];
    else if (/^[A-Za-z0-9_-]{11}$/.test(s)) id = s;
    return id;
}

const tasks = [];
for (const q of asTokens(searchQueries)) tasks.push({ mode: 'search', input: q });
for (const c of asTokens(channels)) tasks.push({ mode: 'channel', input: c });
for (const v of asTokens(videoUrls)) tasks.push({ mode: 'video', input: v });

if (tasks.length === 0) {
    log.warning('Nothing to do. Add a search keyword, a channel or a video URL.');
    await Actor.exit();
}

let rowsPushed = 0;
let chargeableRows = 0;
const seenVideos = new Set();
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'video_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function handleListing(task, url) {
    const { status, body, error } = await fetchHtml(url);
    if (status !== 200) {
        await flushRow({ source: task.mode, sourceInput: task.input, note: `could not fetch (HTTP ${status || error || 'error'}); not charged` }, false);
        log.warning(`${task.input}: HTTP ${status} ${error || ''}`);
        return;
    }
    const data = extractBlob(body, 'var ytInitialData =') || extractBlob(body, 'window["ytInitialData"] =');
    if (!data) {
        await flushRow({ source: task.mode, sourceInput: task.input, note: 'could not read the page data (layout changed); not charged' }, false);
        return;
    }
    // Old layout: videoRenderer/gridVideoRenderer. New layout (channel tabs):
    // lockupViewModel with a contentId. Handle both, keep source order.
    const rows = [];
    for (const vr of collect(data, 'videoRenderer').concat(collect(data, 'gridVideoRenderer'))) {
        if (vr.videoId) rows.push(videoRendererRow(vr, task.mode, task.input));
    }
    for (const lv of collect(data, 'lockupViewModel')) {
        if (lv.contentId) rows.push(lockupRow(lv, task.mode, task.input));
    }
    if (rows.length === 0) {
        await flushRow({ source: task.mode, sourceInput: task.input, note: 'no videos found (page had no results or its layout changed)' }, false);
        return;
    }
    let pushed = 0;
    for (const row of rows) {
        if (rowsPushed >= cap) return;
        if (!row.videoId || seenVideos.has(row.videoId)) continue;
        seenVideos.add(row.videoId);
        await flushRow(row, true);
        pushed += 1;
    }
    log.info(`${task.mode} "${task.input}": ${pushed} video(s).`);
}

async function handleVideo(task) {
    const id = normalizeVideo(task.input);
    if (!id) {
        await flushRow({ source: 'video', sourceInput: task.input, note: 'could not read a video id from this input' }, false);
        return;
    }
    const { status, body, error } = await fetchHtml(`https://www.youtube.com/watch?v=${id}`, { retry429: 3 });
    if (status !== 200) {
        await flushRow({ source: 'video', sourceInput: task.input, videoId: id, note: `could not fetch (HTTP ${status || error || 'error'}); not charged, try again later` }, false);
        log.warning(`video ${id}: HTTP ${status} ${error || ''}`);
        return;
    }
    const pr = extractBlob(body, 'var ytInitialPlayerResponse =') || extractBlob(body, 'ytInitialPlayerResponse =');
    if (!pr?.videoDetails) {
        await flushRow({ source: 'video', sourceInput: task.input, videoId: id, note: 'no video details found (private, removed or layout changed)' }, false);
        return;
    }
    const ytData = extractBlob(body, 'var ytInitialData =');
    await flushRow(videoDetailsRow(pr, ytData, task.input), true);
    log.info(`video ${id}: details.`);
}

log.info(`YouTube: ${tasks.length} task(s) (${asTokens(searchQueries).length} search, ${asTokens(channels).length} channel, ${asTokens(videoUrls).length} video).`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const task = tasks[i];
        if (task.mode === 'search') await handleListing(task, `https://www.youtube.com/results?search_query=${encodeURIComponent(task.input)}`);
        else if (task.mode === 'channel') await handleListing(task, normalizeChannel(task.input));
        else await handleVideo(task);
        await sleep(400);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tasks.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; bad input and fetch failures are free).`);
await Actor.exit();
