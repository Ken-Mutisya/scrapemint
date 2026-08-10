// Crypto Market Data Scraper (No Login)
//
// Strategy
// --------
// CoinGecko serves a keyless market-data endpoint:
//   GET https://api.coingecko.com/api/v3/coins/markets
//       ?vs_currency=usd&order=market_cap_desc&per_page=250&page=N
//       &price_change_percentage=1h,24h,7d,30d
// It returns one object per coin with price, market cap and rank, volume,
// fully diluted valuation, supply, all-time high/low, and multi-window price
// change. No login, no API key, no browser. We page in chunks of 250 up to a
// cap, map each coin to a tidy row, and charge per row.
//
// Pay per event
// -------------
//   coin_row ($0.004) charged when a coin row is pushed.
//   First 5 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 5;
const PAGE_SIZE = 250;
const HARD_CAP = 5000;
const BASE = 'https://api.coingecko.com/api/v3';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    vsCurrency = 'usd',
    order = 'market_cap_desc',
    coinIds = [],
    category,
    priceChangeWindows = '1h,24h,7d,30d',
    maxCoins = 100,
    proxyConfiguration: proxyInput,
} = input;

const vs = String(vsCurrency || 'usd').trim().toLowerCase() || 'usd';
const cleanOrder = String(order || 'market_cap_desc').trim();
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxCoins) || 100));
const ids = (Array.isArray(coinIds) ? coinIds : [coinIds])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
const windows = String(priceChangeWindows || '1h,24h,7d,30d').replace(/\s+/g, '');

// Optional proxy (the API is keyless and tolerant; off by default).
let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

async function fetchPage(page, perPage) {
    const params = new URLSearchParams({
        vs_currency: vs,
        order: cleanOrder,
        per_page: String(perPage),
        page: String(page),
        sparkline: 'false',
        price_change_percentage: windows,
    });
    if (ids.length) params.set('ids', ids.join(','));
    if (category) params.set('category', String(category).trim());
    const url = `${BASE}/coins/markets?${params.toString()}`;
    const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; ScrapemintCryptoMarket/1.0)' },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (res.status === 429) throw new Error('RATE_LIMIT');
    if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
    return res.json();
}

const num = (v) => (v === undefined || v === null ? null : v);
function mapCoin(c) {
    return {
        id: c.id ?? null,
        symbol: c.symbol ? String(c.symbol).toUpperCase() : null,
        name: c.name ?? null,
        vsCurrency: vs,
        currentPrice: num(c.current_price),
        marketCap: num(c.market_cap),
        marketCapRank: num(c.market_cap_rank),
        fullyDilutedValuation: num(c.fully_diluted_valuation),
        totalVolume: num(c.total_volume),
        high24h: num(c.high_24h),
        low24h: num(c.low_24h),
        priceChange24h: num(c.price_change_24h),
        priceChangePct1h: num(c.price_change_percentage_1h_in_currency),
        priceChangePct24h: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
        priceChangePct7d: num(c.price_change_percentage_7d_in_currency),
        priceChangePct30d: num(c.price_change_percentage_30d_in_currency),
        circulatingSupply: num(c.circulating_supply),
        totalSupply: num(c.total_supply),
        maxSupply: num(c.max_supply),
        ath: num(c.ath),
        athChangePct: num(c.ath_change_percentage),
        athDate: c.ath_date ?? null,
        atl: num(c.atl),
        atlChangePct: num(c.atl_change_percentage),
        atlDate: c.atl_date ?? null,
        lastUpdated: c.last_updated ?? null,
        url: c.id ? `https://www.coingecko.com/en/coins/${c.id}` : null,
        scrapedAt: new Date().toISOString(),
    };
}

let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'coin_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Fetching up to ${cap} coin(s) in ${vs.toUpperCase()}, order=${cleanOrder}${ids.length ? `, ids=${ids.length}` : ''}${category ? `, category=${category}` : ''}.`);

let page = 1;
while (totalRowsPushed < cap) {
    const perPage = Math.min(PAGE_SIZE, cap - totalRowsPushed);
    let data;
    try {
        data = await fetchPage(page, perPage);
    } catch (err) {
        if (err.message === 'RATE_LIMIT') {
            log.warning('CoinGecko rate limit hit; waiting 15s before retry.');
            await new Promise((r) => setTimeout(r, 15000));
            continue;
        }
        log.warning(`Page ${page} failed: ${err?.message}`);
        break;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) {
        await flushRow(mapCoin(c));
        if (totalRowsPushed >= cap) break;
    }
    if (data.length < perPage) break;
    if (ids.length) break; // ids query returns the full set in one page
    page += 1;
}

log.info(`Done. Pushed ${totalRowsPushed} coin row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();

// Buyer-selected RESIDENTIAL or SERP proxy groups bill the developer under
// pay-per-event pricing, and this data source works from datacenter IPs, so
// those groups are stripped (buyer-supplied proxyUrls pass through untouched).
function sanitizeProxyInput(p) {
    if (!p || typeof p !== 'object') return p;
    const out = { ...p };
    if (Array.isArray(out.apifyProxyGroups)) {
        const kept = out.apifyProxyGroups.filter((g) => !/RESIDENTIAL|SERP/i.test(String(g)));
        if (kept.length !== out.apifyProxyGroups.length) {
            log.warning('Ignoring RESIDENTIAL/SERP proxy groups: this source works from datacenter IPs and premium groups only raise run costs.');
        }
        if (kept.length) out.apifyProxyGroups = kept;
        else delete out.apifyProxyGroups;
    }
    return out;
}
