// TV Schedule & Shows Scraper
//
// Strategy
// --------
// TVMaze public API (api.tvmaze.com), keyless, verified reachable from Apify
// DC IPs. Three modes:
//   schedule  -> /schedule?country=XX&date=YYYY-MM-DD   one row per episode
//                airing on broadcast networks that day in that country.
//   streaming -> /schedule/web?date=...[&country=XX]     one row per episode
//                released on web/streaming channels (no country = worldwide).
//   shows     -> /search/shows?q=...                     one row per matched
//                show with status, rating, genres, premiere date.
// Documented rate limit ~20 req/10s; small pool with spacing stays under it.
// Data licence: CC BY-SA (TVMaze), credited in the README.
//
// Pay per event
// -------------
//   tv_row per episode or show row. Days with nothing airing, bad country
//   codes and shows not found are free note rows. First 2 chargeable rows per
//   run are free.

import { Actor, log } from 'apify';

const BASE = 'https://api.tvmaze.com';
const UA = 'scrapemint-tv-schedule-scraper/0.1 (+https://apify.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const MAX_RANGE_DAYS = 31;
const POOL_SIZE = 3;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dataType = 'schedule', country = 'US', startDate = '', endDate = '',
    queries = [], maxResultsPerQuery = 1, maxRows = 1000,
} = input;

const cc = /^[A-Za-z]{2}$/.test(String(country).trim()) ? String(country).trim().toUpperCase() : '';
if (country && !cc) log.warning(`Ignoring country "${country}" (expected a 2 letter code like US or GB).`);

const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s).trim()) ? String(s).trim() : null;
function dateList() {
    const start = isoDate(startDate) || new Date().toISOString().slice(0, 10);
    const end = isoDate(endDate) || start;
    const out = [];
    const d = new Date(`${start}T00:00:00Z`);
    const stop = new Date(`${end}T00:00:00Z`);
    while (d <= stop && out.length < MAX_RANGE_DAYS) {
        out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    if (out.length === 0) log.warning(`From date ${start} is after to date ${end}; nothing to fetch.`);
    return out;
}

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const perQuery = Math.max(1, Math.min(10, Number(maxResultsPerQuery) || 1));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

const tasks = [];
if (dataType === 'shows') {
    for (const q of [...new Set(asTokens(queries).map((s) => s.toLowerCase()))]) tasks.push({ query: q });
    if (tasks.length === 0) {
        log.warning('Show lookup mode needs at least one search, e.g. "severance".');
        await Actor.exit();
    }
} else {
    for (const date of dateList()) tasks.push({ date });
    if (dataType === 'schedule' && !cc) {
        log.warning('Broadcast schedule needs a country code; using US.');
    }
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429) {
                await sleep(5000 * attempt);
                throw new Error('rate limited');
            }
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            if (!String(err?.message).includes('rate limited')) await sleep(attempt * 2000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
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
            await Actor.charge({ eventName: 'tv_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const stripHtml = (s) => s ? String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) : null;
const channelOf = (show) => show?.network?.name || show?.webChannel?.name || null;

function episodeRow(ep, date) {
    const show = ep.show || ep._embedded?.show || {};
    return {
        date,
        airtime: ep.airtime || null,
        airstamp: ep.airstamp || null,
        show: show.name || null,
        episodeName: ep.name || null,
        season: ep.season ?? null,
        episode: ep.number ?? null,
        channel: channelOf(show),
        channelCountry: show?.network?.country?.code || show?.webChannel?.country?.code || null,
        showType: show.type || null,
        genres: show.genres || [],
        showRating: show.rating?.average ?? null,
        runtimeMinutes: ep.runtime ?? null,
        showStatus: show.status || null,
        tvmazeShowUrl: show.url || null,
    };
}

function showRow(query, hit) {
    const s = hit.show || {};
    return {
        query,
        show: s.name || null,
        status: s.status || null,
        premiered: s.premiered || null,
        ended: s.ended || null,
        channel: channelOf(s),
        genres: s.genres || [],
        rating: s.rating?.average ?? null,
        runtimeMinutes: s.runtime ?? s.averageRuntime ?? null,
        language: s.language || null,
        summary: stripHtml(s.summary),
        officialSite: s.officialSite || null,
        imdbId: s.externals?.imdb || null,
        tvmazeUrl: s.url || null,
    };
}

log.info(`Mode: ${dataType}; ${tasks.length} ${dataType === 'shows' ? 'search(es)' : 'day(s)'}${cc ? ` (country ${cc})` : ' (worldwide)'}, max ${cap} rows.`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const task = tasks[i];

        let url;
        if (dataType === 'shows') url = `${BASE}/search/shows?q=${encodeURIComponent(task.query)}`;
        else if (dataType === 'streaming') url = `${BASE}/schedule/web?date=${task.date}${cc ? `&country=${cc}` : ''}`;
        else url = `${BASE}/schedule?country=${cc || 'US'}&date=${task.date}`;

        const { status, json, error } = await fetchJson(url);
        const label = task.query || task.date;

        if (status !== 200 || !Array.isArray(json)) {
            await flushRow({ input: label, note: `could not fetch (${error || `HTTP ${status}`}); not charged, try again later` }, false);
            log.warning(`${label}: HTTP ${status} ${error || ''}`);
            continue;
        }

        const hits = dataType === 'shows' ? json.slice(0, perQuery) : json;
        if (hits.length === 0) {
            const note = dataType === 'shows' ? 'no show found' : `no episodes on ${task.date} (check the country code)`;
            await flushRow({ input: label, note }, false);
            continue;
        }
        let pushed = 0;
        for (const hit of hits) {
            if (rowsPushed >= cap) { stopped = true; break; }
            await flushRow(dataType === 'shows' ? showRow(task.query, hit) : episodeRow(hit, task.date), true);
            pushed += 1;
        }
        log.info(`${label}: ${pushed} row(s).`);
        await sleep(600);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tasks.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; empty days and not-found are free).`);
await Actor.exit();
