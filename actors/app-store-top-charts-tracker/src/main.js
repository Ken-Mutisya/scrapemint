// App Store Top Charts Tracker: Ranks by Country & Category
//
// Strategy
// --------
// Pull Apple's official chart feeds (keyless JSON): the legacy iTunes RSS
// (supports country + genre + free/paid/grossing, up to 200 entries). One
// request per chart, one row per ranked app. With compareWithPrevious, the
// previous run's ranks live in a named key-value store, so scheduled runs
// report previousRank / rankChange / isNew per app. No browser, no proxy,
// no API key.
//
// Pay per event
// -------------
//   rank_row ($0.003) charged per ranked row pushed. Tracked apps that are
//   NOT found in a chart produce a free rank:null row. Charts that fail to
//   fetch cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const MAX_CHARTS_PER_RUN = 50;
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const FEED_NAMES = {
    'top-free': 'topfreeapplications',
    'top-paid': 'toppaidapplications',
    'top-grossing': 'topgrossingapplications',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = ['us'],
    chartTypes = ['top-free'],
    categoryIds = [],
    topN = 50,
    trackAppIds = [],
    compareWithPrevious = true,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const ccs = asList(countries).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c));
const types = asList(chartTypes).map((t) => t.toLowerCase()).filter((t) => FEED_NAMES[t]);
const genres = asList(categoryIds).filter((g) => /^\d+$/.test(g));
const depth = Math.max(1, Math.min(200, Number(topN) || 50));
const tracked = new Set(asList(trackAppIds).map((s) => s.replace(/^id/, '')).filter((s) => /^\d+$/.test(s)));

if (!ccs.length || !types.length) {
    log.warning('Provide at least one valid country code and one chart type (top-free, top-paid, top-grossing).');
    await Actor.exit();
}

const charts = [];
for (const cc of ccs) {
    for (const t of types) {
        if (genres.length) for (const g of genres) charts.push({ cc, type: t, genre: g });
        else charts.push({ cc, type: t, genre: null });
    }
}
if (charts.length > MAX_CHARTS_PER_RUN) {
    log.warning(`${charts.length} chart combinations requested; capping at ${MAX_CHARTS_PER_RUN}.`);
    charts.length = MAX_CHARTS_PER_RUN;
}

const state = compareWithPrevious ? await Actor.openKeyValueStore('app-charts-state') : null;
const chartKey = (c) => `chart-${c.cc}-${c.type}-${c.genre || 'all'}`;

async function fetchChart(c) {
    const genreSeg = c.genre ? `/genre=${c.genre}` : '';
    const url = `https://itunes.apple.com/${c.cc}/rss/${FEED_NAMES[c.type]}/limit=${depth}${genreSeg}/json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'AppStoreTopChartsTracker/1.0 (+https://apify.com/scrapemint/app-store-top-charts-tracker)' },
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
    const price = e?.['im:price']?.attributes || {};
    const cat = e?.category?.attributes || {};
    const art = e?.['im:image'];
    return {
        rank,
        appId: attrs['im:id'] || null,
        bundleId: attrs['bundle-id'] || null,
        name: e?.['im:name']?.label || null,
        artist: e?.['im:artist']?.label || null,
        appUrl: e?.id?.label || null,
        price: price.amount != null ? parseFloat(price.amount) : null,
        currency: price.currency || null,
        categoryId: cat['im:id'] || null,
        categoryName: cat.label || null,
        releaseDate: e?.['im:releaseDate']?.label || null,
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
            await Actor.charge({ eventName: 'rank_row' });
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
    const base = { country: c.cc, chartType: c.type, chartCategoryId: c.genre, checkedAt: now };

    let rank = 0;
    for (const e of entries) {
        rank += 1;
        const app = parseEntry(e, rank);
        if (app.appId) currentRanks[app.appId] = rank;
        if (tracked.size && !tracked.has(String(app.appId))) continue;
        const prevRank = prev[app.appId] ?? null;
        await flushRow({
            ...base,
            ...app,
            previousRank: prevRank,
            rankChange: prevRank != null ? prevRank - rank : null,
            isNew: state ? prevRank == null && Object.keys(prev).length > 0 : null,
        }, true);
    }

    // Tracked apps that fell off / never appeared in this chart: free rows.
    if (tracked.size) {
        for (const id of tracked) {
            if (currentRanks[id]) continue;
            const prevRank = prev[id] ?? null;
            await flushRow({
                ...base,
                rank: null,
                appId: id,
                previousRank: prevRank,
                rankChange: null,
                droppedOff: prevRank != null,
            }, false);
        }
    }

    if (state) await state.setValue(key, currentRanks);
    log.info(`${key}: ${rank} rank(s)${tracked.size ? `, tracking ${tracked.size} app(s)` : ''}.`);
}

log.info(`Pulling ${charts.length} chart(s), depth ${depth}${tracked.size ? `, filtered to ${tracked.size} tracked app(s)` : ''}.`);

for (let i = 0; i < charts.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    await Promise.all(charts.slice(i, i + CONCURRENCY).map((c) => processChart(c)));
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
