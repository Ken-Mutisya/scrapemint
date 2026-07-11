// Podcast Charts Tracker: Apple Podcasts Ranks by Country & Genre
//
// Strategy
// --------
// Pull Apple's official podcast chart feeds (keyless JSON): the legacy
// iTunes RSS supports country + genre and up to 200 entries. One request
// per chart, one row per ranked podcast. With compareWithPrevious, the
// previous run's ranks live in a named key-value store, so scheduled runs
// report previousRank / rankChange / isNew per show. No browser, no
// proxy, no API key.
//
// Pay per event
// -------------
//   chart_row ($0.003) charged per ranked row pushed. Tracked podcasts
//   that are NOT found in a chart produce a free rank:null row. Charts
//   that fail to fetch cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const MAX_CHARTS_PER_RUN = 50;
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

// Apple Podcasts genre ids (all verified live 2026-07-11).
const GENRE_IDS = {
    all: null,
    arts: 1301,
    business: 1321,
    comedy: 1303,
    education: 1304,
    fiction: 1483,
    government: 1511,
    'health-fitness': 1512,
    history: 1487,
    'kids-family': 1305,
    leisure: 1502,
    music: 1310,
    news: 1489,
    'religion-spirituality': 1314,
    science: 1533,
    'society-culture': 1324,
    sports: 1545,
    technology: 1318,
    'true-crime': 1488,
    'tv-film': 1309,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = ['us'],
    genres = ['all'],
    topN = 50,
    trackPodcastIds = [],
    compareWithPrevious = true,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const ccs = asList(countries).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c));
const genreNames = [...new Set(asList(genres).map((g) => g.toLowerCase()))]
    .filter((g) => g in GENRE_IDS);
const depth = Math.max(1, Math.min(200, Number(topN) || 50));
const tracked = new Set(asList(trackPodcastIds).map((s) => s.replace(/^id/, '')).filter((s) => /^\d+$/.test(s)));

if (!ccs.length || !genreNames.length) {
    log.warning(`Provide at least one valid country code and one genre. Genres: ${Object.keys(GENRE_IDS).join(', ')}.`);
    await Actor.exit();
}

const charts = [];
for (const cc of ccs) for (const g of genreNames) charts.push({ cc, genre: g });
if (charts.length > MAX_CHARTS_PER_RUN) {
    log.warning(`${charts.length} chart combinations requested; capping at ${MAX_CHARTS_PER_RUN}.`);
    charts.length = MAX_CHARTS_PER_RUN;
}

const state = compareWithPrevious ? await Actor.openKeyValueStore('podcast-charts-state') : null;
const chartKey = (c) => `chart-${c.cc}-${c.genre}`;

async function fetchChart(c) {
    const genreId = GENRE_IDS[c.genre];
    const genreSeg = genreId ? `/genre=${genreId}` : '';
    const url = `https://itunes.apple.com/${c.cc}/rss/toppodcasts/limit=${depth}${genreSeg}/json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'PodcastChartsTracker/1.0 (+https://apify.com/scrapemint/podcast-charts-tracker)' },
        });
        if (!res.ok) { log.warning(`Chart ${chartKey(c)}: HTTP ${res.status}`); return null; }
        const d = await res.json();
        let entries = d?.feed?.entry ?? [];
        if (entries && !Array.isArray(entries)) entries = [entries];
        return entries;
    } catch (err) {
        log.warning(`Chart ${chartKey(c)} fetch failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function parseEntry(e, rank) {
    const attrs = e?.id?.attributes || {};
    const cat = e?.category?.attributes || {};
    const art = e?.['im:image'];
    return {
        rank,
        podcastId: attrs['im:id'] || null,
        name: e?.['im:name']?.label || null,
        publisher: e?.['im:artist']?.label || null,
        podcastUrl: e?.id?.label || null,
        categoryId: cat['im:id'] || null,
        categoryName: cat.label || null,
        releaseDate: e?.['im:releaseDate']?.label || null,
        summary: e?.summary?.label ? String(e.summary.label).slice(0, 300) : null,
        artworkUrl: Array.isArray(art) && art.length ? art[art.length - 1]?.label : null,
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
    const prev = state ? (await state.getValue(key)) || {} : {};
    const now = new Date().toISOString();
    const currentRanks = {};
    const base = { country: c.cc, genre: c.genre, checkedAt: now };

    let rank = 0;
    for (const e of entries) {
        rank += 1;
        const show = parseEntry(e, rank);
        if (show.podcastId) currentRanks[show.podcastId] = rank;
        if (tracked.size && !tracked.has(String(show.podcastId))) continue;
        const prevRank = prev[show.podcastId] ?? null;
        await flushRow({
            ...base,
            ...show,
            previousRank: prevRank,
            rankChange: prevRank != null ? prevRank - rank : null,
            isNew: state ? prevRank == null && Object.keys(prev).length > 0 : null,
        }, true);
    }

    // Tracked podcasts that fell off / never appeared in this chart: free rows.
    if (tracked.size) {
        for (const id of tracked) {
            if (currentRanks[id]) continue;
            const prevRank = prev[id] ?? null;
            await flushRow({
                ...base,
                rank: null,
                podcastId: id,
                previousRank: prevRank,
                rankChange: null,
                droppedOff: prevRank != null,
            }, false);
        }
    }

    if (state) await state.setValue(key, currentRanks);
    log.info(`${key}: ${rank} rank(s)${tracked.size ? `, tracking ${tracked.size} podcast(s)` : ''}.`);
}

log.info(`Pulling ${charts.length} chart(s), depth ${depth}${tracked.size ? `, filtered to ${tracked.size} tracked podcast(s)` : ''}.`);

for (let i = 0; i < charts.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    await Promise.all(charts.slice(i, i + CONCURRENCY).map((c) => processChart(c)));
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
