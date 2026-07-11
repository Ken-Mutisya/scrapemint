// Music Charts Tracker: Apple Music Ranks by Country
//
// Strategy
// --------
// Pull Apple's official music chart feeds (keyless JSON via the Apple
// marketing tools API): most-played songs and albums per storefront
// country, up to 100 ranks per chart. One request per chart, one row per
// ranked entry. With compareWithPrevious, the previous run's ranks live
// in a named key-value store, so scheduled runs report previousRank /
// rankChange / isNew per entry and droppedOff for tracked artists. No
// browser, no proxy, no API key.
//
// Pay per event
// -------------
//   chart_row ($0.003) charged per ranked row pushed. Tracked artists
//   with NO entry in a chart produce a free rank:null row. Charts that
//   fail to fetch cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const MAX_CHARTS_PER_RUN = 50;
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const CHART_FEEDS = {
    'top-songs': 'songs',
    'top-albums': 'albums',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = ['us'],
    chartTypes = ['top-songs'],
    topN = 50,
    trackArtistIds = [],
    compareWithPrevious = true,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const ccs = asList(countries).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c));
const types = asList(chartTypes).map((t) => t.toLowerCase()).filter((t) => CHART_FEEDS[t]);
// The marketing tools API serves at most 100 entries per chart.
const depth = Math.max(1, Math.min(100, Number(topN) || 50));
const trackedArtists = new Set(asList(trackArtistIds).map((s) => s.replace(/^id/, '')).filter((s) => /^\d+$/.test(s)));

if (!ccs.length || !types.length) {
    log.warning('Provide at least one valid country code and one chart type (top-songs, top-albums).');
    await Actor.exit();
}

const charts = [];
for (const cc of ccs) for (const t of types) charts.push({ cc, type: t });
if (charts.length > MAX_CHARTS_PER_RUN) {
    log.warning(`${charts.length} chart combinations requested; capping at ${MAX_CHARTS_PER_RUN}.`);
    charts.length = MAX_CHARTS_PER_RUN;
}

const state = compareWithPrevious ? await Actor.openKeyValueStore('music-charts-state') : null;
const chartKey = (c) => `chart-${c.cc}-${c.type}`;

async function fetchChart(c) {
    const url = `https://rss.applemarketingtools.com/api/v2/${c.cc}/music/most-played/${depth}/${CHART_FEEDS[c.type]}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'MusicChartsTracker/1.0 (+https://apify.com/scrapemint/music-charts-tracker)' },
        });
        if (!res.ok) { log.warning(`Chart ${chartKey(c)}: HTTP ${res.status}`); return null; }
        const d = await res.json();
        return d?.feed?.results || [];
    } catch (err) {
        log.warning(`Chart ${chartKey(c)} fetch failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function parseEntry(e, rank) {
    return {
        rank,
        itemId: e.id || null,
        name: e.name || null,
        artistName: e.artistName || null,
        artistId: e.artistId || null,
        artistUrl: e.artistUrl || null,
        genres: (e.genres || []).map((g) => g.name).filter((n) => n && n !== 'Music'),
        releaseDate: e.releaseDate || null,
        contentAdvisoryRating: e.contentAdvisoryRating || null,
        artworkUrl: e.artworkUrl100 || null,
        itemUrl: e.url || null,
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (chargeable && rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'chart_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function processChart(c) {
    const entries = await fetchChart(c);
    if (!entries) return;
    const key = chartKey(c);
    const prev = (state ? (await state.getValue(key)) : null) || { ranks: {}, artists: {} };
    const hadHistory = Object.keys(prev.ranks).length > 0;
    const now = new Date().toISOString();
    const currentRanks = {};
    const currentArtists = {};
    const base = { country: c.cc, chartType: c.type, checkedAt: now };

    let rank = 0;
    for (const e of entries) {
        rank += 1;
        const item = parseEntry(e, rank);
        if (item.itemId) currentRanks[item.itemId] = rank;
        if (item.artistId && currentArtists[item.artistId] == null) currentArtists[item.artistId] = rank;
        if (trackedArtists.size && !trackedArtists.has(String(item.artistId))) continue;
        const prevRank = prev.ranks[item.itemId] ?? null;
        await flushRow({
            ...base,
            ...item,
            previousRank: prevRank,
            rankChange: prevRank != null ? prevRank - rank : null,
            isNew: state ? prevRank == null && hadHistory : null,
        }, true);
    }

    // Tracked artists with no entry in this chart: free rows.
    if (trackedArtists.size) {
        for (const id of trackedArtists) {
            if (currentArtists[id] != null) continue;
            const prevBest = prev.artists[id] ?? null;
            await flushRow({
                ...base,
                rank: null,
                artistId: id,
                previousRank: prevBest,
                rankChange: null,
                droppedOff: prevBest != null,
            }, false);
        }
    }

    if (state) await state.setValue(key, { ranks: currentRanks, artists: currentArtists });
    log.info(`${key}: ${rank} rank(s)${trackedArtists.size ? `, tracking ${trackedArtists.size} artist(s)` : ''}.`);
}

log.info(`Pulling ${charts.length} chart(s), depth ${depth}${trackedArtists.size ? `, filtered to ${trackedArtists.size} tracked artist(s)` : ''}.`);

for (let i = 0; i < charts.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    await Promise.all(charts.slice(i, i + CONCURRENCY).map((c) => processChart(c)));
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
