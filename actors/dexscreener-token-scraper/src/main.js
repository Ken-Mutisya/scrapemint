// DexScreener Token Scraper
//
// Strategy
// --------
// DexScreener's public API (api.dexscreener.com, no key) exposes several token
// feeds plus pair data for 80+ chains:
//   top_boosted       /token-boosts/top/v1         most boosted tokens right now
//   latest_boosted    /token-boosts/latest/v1      tokens that just bought boosts
//   latest_profiles   /token-profiles/latest/v1    tokens that just got a profile (new launches)
//   takeovers         /community-takeovers/latest/v1  community takeovers (CTO)
//   search            /latest/dex/search?q=        pairs matching a name, symbol or address
//   tokens            /tokens/v1/{chain}/{a,b,..}  your token addresses
// Feed entries only carry the token address, so we batch them per chain into
// /tokens/v1 (30 addresses per call) and keep each token's deepest pair: price,
// liquidity, FDV, market cap, volume and transactions by window, price change,
// pair age, DEX and socials. One row per token. Filters: chain, liquidity,
// volume, market cap and pair age. No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   token ($0.002) per token row. The first FREE_TIER_ROWS rows of every run
//   are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const API = 'https://api.dexscreener.com';
const FETCH_TIMEOUT_MS = 30000;
const FEEDS = {
    top_boosted: '/token-boosts/top/v1',
    latest_boosted: '/token-boosts/latest/v1',
    latest_profiles: '/token-profiles/latest/v1',
    takeovers: '/community-takeovers/latest/v1',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    sources = ['top_boosted', 'latest_profiles'],
    searchQueries = [],
    tokenAddresses = [],
    chains = [],
    minLiquidityUsd = 0,
    minVolume24hUsd = 0,
    minMarketCapUsd = 0,
    maxMarketCapUsd = 0,
    maxPairAgeHours = 0,
    maxRows = 200,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(5000, Number(maxRows) || 200));
const chainSet = new Set(arr(chains).map((c) => c.toLowerCase()));
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

let lastCall = 0;
async function getJson(path) {
    // Feed endpoints allow 60 requests/min; stay well under it.
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(API + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status === 429 || res.status >= 500) { log.warning(`${path}: HTTP ${res.status}, retrying`); await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }
            log.warning(`${path}: HTTP ${res.status}`);
            return null;
        } catch (err) {
            log.warning(`${path}: ${err.message}`);
            if (attempt === 3) return null;
        } finally { clearTimeout(t); }
    }
    return null;
}

// token key -> { chainId, tokenAddress, sources:Set, feed info }
const tokens = new Map();
const key = (c, a) => `${String(c).toLowerCase()}:${String(a).toLowerCase()}`;
const addToken = (chainId, tokenAddress, source, extra = {}) => {
    if (!chainId || !tokenAddress) return;
    if (chainSet.size && !chainSet.has(chainId.toLowerCase())) return;
    const k = key(chainId, tokenAddress);
    const t = tokens.get(k) || { chainId, tokenAddress, sources: new Set() };
    t.sources.add(source);
    if (extra.description && !t.description) t.description = extra.description;
    if (extra.links && !t.links) t.links = extra.links;
    if (extra.boostAmount != null) t.boostAmount = Math.max(t.boostAmount || 0, extra.boostAmount);
    if (extra.claimDate) t.takeoverClaimDate = extra.claimDate;
    tokens.set(k, t);
};
const pairsByToken = new Map(); // filled directly by search

for (const s of arr(sources)) {
    const path = FEEDS[s];
    if (!path) { log.warning(`Unknown source "${s}". Known: ${Object.keys(FEEDS).join(', ')}`); continue; }
    const list = await getJson(path);
    for (const e of Array.isArray(list) ? list : []) {
        addToken(e.chainId, e.tokenAddress, s, { description: e.description, links: e.links, boostAmount: n(e.totalAmount ?? e.amount), claimDate: e.claimDate });
    }
    log.info(`${s}: ${Array.isArray(list) ? list.length : 0} entries`);
}
for (const qy of arr(searchQueries).slice(0, 20)) {
    const res = await getJson(`/latest/dex/search?q=${encodeURIComponent(qy)}`);
    for (const p of res?.pairs || []) {
        addToken(p.chainId, p.baseToken?.address, `search:${qy}`);
        const k = key(p.chainId, p.baseToken?.address || '');
        if (tokens.has(k)) (pairsByToken.get(k) || pairsByToken.set(k, []).get(k)).push(p);
    }
}
for (const raw of arr(tokenAddresses).slice(0, 500)) {
    const m = raw.match(/^([a-z0-9-]+)[:/](.+)$/i);
    if (!m) { log.warning(`Token "${raw}" ignored: use chain:address, e.g. solana:So111...`); continue; }
    addToken(m[1].toLowerCase(), m[2], 'tokens');
}
if (!tokens.size) {
    await Actor.pushData({ note: 'No tokens found. Pick at least one source, search query or chain:address token. Not charged.' });
    await Actor.exit();
}

// Fetch pairs for tokens that do not have them yet, 30 per call per chain.
const byChain = new Map();
for (const [k, t] of tokens) if (!pairsByToken.has(k)) (byChain.get(t.chainId) || byChain.set(t.chainId, []).get(t.chainId)).push(t.tokenAddress);
for (const [chain, addrs] of byChain) {
    for (let i = 0; i < addrs.length; i += 30) {
        const batch = addrs.slice(i, i + 30);
        const pairs = await getJson(`/tokens/v1/${encodeURIComponent(chain)}/${batch.map(encodeURIComponent).join(',')}`);
        for (const p of Array.isArray(pairs) ? pairs : []) {
            for (const addr of [p.baseToken?.address, p.quoteToken?.address]) {
                const k = key(chain, addr || '');
                if (tokens.has(k)) (pairsByToken.get(k) || pairsByToken.set(k, []).get(k)).push(p);
            }
        }
    }
}

const now = Date.now();
const rows = [];
for (const [k, t] of tokens) {
    const pairs = pairsByToken.get(k) || [];
    const best = pairs.slice().sort((a, b) => (n(b.liquidity?.usd) || 0) - (n(a.liquidity?.usd) || 0))[0];
    if (!best) continue;
    const isBase = (best.baseToken?.address || '').toLowerCase() === t.tokenAddress.toLowerCase();
    const tok = isBase ? best.baseToken : best.quoteToken;
    const created = n(best.pairCreatedAt);
    const row = {
        chainId: t.chainId,
        tokenAddress: t.tokenAddress,
        name: tok?.name || null,
        symbol: tok?.symbol || null,
        priceUsd: isBase ? n(best.priceUsd) : null,
        priceNative: isBase ? n(best.priceNative) : null,
        liquidityUsd: n(best.liquidity?.usd),
        fdvUsd: n(best.fdv),
        marketCapUsd: n(best.marketCap),
        volume5mUsd: n(best.volume?.m5), volume1hUsd: n(best.volume?.h1), volume6hUsd: n(best.volume?.h6), volume24hUsd: n(best.volume?.h24),
        buys1h: n(best.txns?.h1?.buys), sells1h: n(best.txns?.h1?.sells), buys24h: n(best.txns?.h24?.buys), sells24h: n(best.txns?.h24?.sells),
        priceChange5mPct: n(best.priceChange?.m5), priceChange1hPct: n(best.priceChange?.h1), priceChange6hPct: n(best.priceChange?.h6), priceChange24hPct: n(best.priceChange?.h24),
        pairAddress: best.pairAddress || null,
        dexId: best.dexId || null,
        quoteSymbol: (isBase ? best.quoteToken : best.baseToken)?.symbol || null,
        pairCreatedAt: created ? new Date(created).toISOString() : null,
        pairAgeHours: created ? Math.round(((now - created) / 3600000) * 10) / 10 : null,
        pairCount: pairs.length,
        activeBoosts: n(best.boosts?.active) || 0,
        boostAmount: t.boostAmount ?? null,
        takeoverClaimDate: t.takeoverClaimDate || null,
        description: t.description || null,
        websites: (best.info?.websites || []).map((w) => w.url).filter(Boolean),
        socials: (best.info?.socials || []).map((s) => ({ type: s.type, url: s.url })),
        imageUrl: best.info?.imageUrl || null,
        sources: [...t.sources],
        dexscreenerUrl: best.url || `https://dexscreener.com/${t.chainId}/${t.tokenAddress}`,
        scrapedAt: new Date().toISOString(),
    };
    if (minLiquidityUsd > 0 && !(row.liquidityUsd >= minLiquidityUsd)) continue;
    if (minVolume24hUsd > 0 && !(row.volume24hUsd >= minVolume24hUsd)) continue;
    if (minMarketCapUsd > 0 && !((row.marketCapUsd ?? row.fdvUsd) >= minMarketCapUsd)) continue;
    if (maxMarketCapUsd > 0 && !((row.marketCapUsd ?? row.fdvUsd) <= maxMarketCapUsd)) continue;
    if (maxPairAgeHours > 0 && !(row.pairAgeHours != null && row.pairAgeHours <= maxPairAgeHours)) continue;
    rows.push(row);
}
rows.sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0));

let pushed = 0;
for (const r of rows.slice(0, cap)) {
    await Actor.pushData(r);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'token' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
if (!pushed) await Actor.pushData({ note: `${tokens.size} tokens found but none passed the filters. Lower minLiquidityUsd / minVolume24hUsd or raise maxPairAgeHours. Not charged.` });
await Actor.setValue('SUMMARY', { tokensFound: tokens.size, returned: pushed });
log.info(`Done. ${pushed} tokens of ${tokens.size} found.`);
await Actor.exit();
