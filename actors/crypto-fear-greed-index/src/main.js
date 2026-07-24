// Crypto Fear & Greed Index, Market Cap & Trending Coins
//
// Strategy
// --------
// Two keyless sources, no account:
//   - alternative.me/fng      the Crypto Fear & Greed Index (0-100 + label),
//                             current and historical — the most-watched crypto
//                             sentiment gauge
//   - CoinGecko /global       total market cap, 24h volume, BTC/ETH dominance,
//                             market-cap 24h change
//   - CoinGecko /search/trending   the coins people are searching most right now
//
// Three modes:
//   - fear_greed (default) one row per day of Fear & Greed history
//   - overview             one snapshot row: market cap, dominance, volume,
//                          24h change, and the current Fear & Greed reading
//   - trending             one row per trending coin
//
// Pay per event
// -------------
//   crypto_row ($0.002) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 30000;
const UA = 'Scrapemint Crypto Sentiment Tracker (admin@scrapemint.com)';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'fear_greed',
    fearGreedDays = 30,
    maxRows = 500,
} = input;

const theMode = ['fear_greed', 'overview', 'trending'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'fear_greed';
const days = Math.max(1, Math.min(3650, Number(fearGreedDays) || 30));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const iso = (unixSec) => { const t = Number(unixSec); return Number.isFinite(t) ? new Date(t * 1000).toISOString() : null; };

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': UA } });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'crypto_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const stop = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Crypto sentiment | mode ${theMode}${theMode === 'fear_greed' ? ` | ${days} days` : ''}. Cap ${cap} rows.`);

if (theMode === 'fear_greed') {
    const d = await getJson(`https://api.alternative.me/fng/?limit=${days}&format=json`);
    for (const p of d?.data || []) {
        if (stop()) break;
        await flushRow({
            mode: 'fear_greed',
            date: iso(p.timestamp),
            value: num(p.value),
            classification: p.value_classification || null,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
} else if (theMode === 'trending') {
    const d = await getJson('https://api.coingecko.com/api/v3/search/trending');
    let rank = 0;
    for (const c of d?.coins || []) {
        if (stop()) break;
        rank += 1;
        const it = c.item || {};
        await flushRow({
            mode: 'trending',
            trendingRank: rank,
            coinId: it.id || null,
            name: it.name || null,
            symbol: (it.symbol || '').toUpperCase() || null,
            marketCapRank: num(it.market_cap_rank),
            priceBtc: it.price_btc ?? null,
            priceUsd: round(num(it.data?.price), 6),
            change24hPct: round(num(it.data?.price_change_percentage_24h?.usd), 2),
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
} else {
    // overview: one global snapshot row + current Fear & Greed.
    const [g, fng] = await Promise.all([
        getJson('https://api.coingecko.com/api/v3/global'),
        getJson('https://api.alternative.me/fng/?limit=1&format=json'),
    ]);
    const gd = g?.data || {};
    const f = (fng?.data || [])[0] || {};
    await flushRow({
        mode: 'overview',
        totalMarketCapUsd: round(num(gd.total_market_cap?.usd), 0),
        total24hVolumeUsd: round(num(gd.total_volume?.usd), 0),
        marketCapChange24hPct: round(num(gd.market_cap_change_percentage_24h_usd), 2),
        btcDominancePct: round(num(gd.market_cap_percentage?.btc), 2),
        ethDominancePct: round(num(gd.market_cap_percentage?.eth), 2),
        activeCryptocurrencies: num(gd.active_cryptocurrencies),
        markets: num(gd.markets),
        fearGreedValue: num(f.value),
        fearGreedClassification: f.value_classification || null,
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
