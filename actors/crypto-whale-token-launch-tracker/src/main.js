// Crypto Whale + Token Launch Tracker
// Two modes:
//   1) tokens  -> DexScreener public API (no auth). Scans new and trending pairs
//      across Uniswap, PancakeSwap, Raydium, Aerodrome, and 40+ DEXs on 10+ chains.
//      Endpoints used:
//        https://api.dexscreener.com/token-profiles/latest/v1
//        https://api.dexscreener.com/latest/dex/search?q={query}
//        https://api.dexscreener.com/latest/dex/tokens/{address}
//   2) wallets -> Etherscan V2 multichain API. Pulls ERC20 transfers for a set
//      of wallet addresses across every supported EVM chain with a single key.
//        https://api.etherscan.io/v2/api?chainid={id}&module=account&action=tokentx&address={w}
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 50;
const DEX_SLEEP_MS = 250;
const ETHERSCAN_SLEEP_MS = 220;

const ETHERSCAN_CHAIN_IDS = {
    ethereum: 1,
    bsc: 56,
    polygon: 137,
    arbitrum: 42161,
    optimism: 10,
    base: 8453,
    avalanche: 43114,
    linea: 59144,
    blast: 81457,
};

await Actor.init();

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let apiRequests = 0;

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'tokens',
    chains = ['ethereum', 'base', 'solana'],
    searchQueries = [],
    tokenAddresses = [],
    minLiquidityUsd = 10_000,
    minVolume24hUsd = 50_000,
    maxTokenAgeHours = 168,
    sortBy = 'volume24h',
    walletAddresses = [],
    etherscanApiKey = '',
    minTxValueUsd = 10_000,
    maxTxAgeHours = 24,
    maxItemsPerSource = 100,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const chainList = toArray(chains).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
const searchList = toArray(searchQueries).map((s) => String(s).trim()).filter(Boolean);
const addressList = toArray(tokenAddresses).map((a) => String(a).trim()).filter(Boolean);
const walletList = toArray(walletAddresses).map((w) => String(w).trim()).filter(Boolean);

const store = await Actor.openKeyValueStore('crypto-whale-tracker-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

try {
    await Actor.createProxyConfiguration(proxyInput);
    log.info(`mode=${mode} chains=${chainList.join(',') || 'all'}`);

    if (mode === 'wallets') {
        if (!String(etherscanApiKey).trim()) {
            log.error('etherscanApiKey is required for wallets mode. Get a free key at etherscan.io/apis and paste it into the etherscanApiKey field.');
        } else if (walletList.length === 0) {
            log.error('Provide at least one wallet address in walletAddresses.');
        } else {
            await runWalletsMode();
        }
    } else {
        await runTokensMode();
    }

    if (dedupe) {
        const trimmed = [...newSeen].slice(-50_000);
        await store.setValue('SEEN_IDS', trimmed);
    }
} catch (err) {
    log.exception(err, 'Unhandled error during run');
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} apiRequests=${apiRequests}`);
await Actor.exit();

async function runTokensMode() {
    const cutoffMs = maxTokenAgeHours > 0 ? Date.now() - (maxTokenAgeHours * 3_600_000) : 0;

    if (addressList.length > 0) {
        for (const addr of addressList) {
            if (totalPushed >= maxItemsTotal) break;
            await fetchAndPushTokenPairs(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`, `address:${addr}`, cutoffMs, maxItemsPerSource);
        }
    }

    if (searchList.length > 0) {
        for (const q of searchList) {
            if (totalPushed >= maxItemsTotal) break;
            await fetchAndPushTokenPairs(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, `search:${q}`, cutoffMs, maxItemsPerSource);
        }
    }

    if (addressList.length === 0 && searchList.length === 0) {
        await fetchAndPushProfiles(cutoffMs, maxItemsPerSource);
    }
}

async function fetchAndPushProfiles(cutoffMs, perSourceCap) {
    const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
    await sleep(DEX_SLEEP_MS);
    apiRequests += 1;
    let profiles;
    try {
        const res = await fetch(url);
        if (!res.ok) { log.warning(`DexScreener profiles HTTP ${res.status}`); return; }
        profiles = await res.json();
    } catch (err) {
        log.warning(`DexScreener profiles failed: ${err?.message}`);
        return;
    }

    if (!Array.isArray(profiles)) return;
    log.info(`DexScreener profiles: ${profiles.length} entries.`);

    const profileAddrs = profiles
        .filter((p) => chainList.length === 0 || chainList.includes(String(p.chainId).toLowerCase()))
        .slice(0, perSourceCap)
        .map((p) => ({ chain: p.chainId, address: p.tokenAddress }));

    for (const { address } of profileAddrs) {
        if (totalPushed >= maxItemsTotal) break;
        await fetchAndPushTokenPairs(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`, `profile:${address}`, cutoffMs, perSourceCap);
    }
}

async function fetchAndPushTokenPairs(url, sourceTag, cutoffMs, perSourceCap) {
    await sleep(DEX_SLEEP_MS);
    apiRequests += 1;
    let body;
    try {
        const res = await fetch(url);
        if (!res.ok) { log.warning(`DexScreener HTTP ${res.status} on ${sourceTag}`); return; }
        body = await res.json();
    } catch (err) {
        log.warning(`DexScreener fetch failed (${sourceTag}): ${err?.message}`);
        return;
    }

    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    if (pairs.length === 0) return;

    const filtered = pairs.filter((p) => chainList.length === 0 || chainList.includes(String(p.chainId).toLowerCase()));
    const sorted = sortPairs(filtered, sortBy);

    let pushedThis = 0;
    for (const p of sorted) {
        if (pushedThis >= perSourceCap) break;
        if (totalPushed >= maxItemsTotal) break;

        const row = shapeTokenRow(p, sourceTag);
        totalSeen += 1;

        if (cutoffMs > 0 && row.pairCreatedAtMs && row.pairCreatedAtMs < cutoffMs) { filteredOut += 1; continue; }
        if (row.liquidityUsd != null && row.liquidityUsd < minLiquidityUsd) { filteredOut += 1; continue; }
        if (row.volume24hUsd != null && row.volume24hUsd < minVolume24hUsd) { filteredOut += 1; continue; }

        if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; continue; }

        await Actor.pushData(row);
        totalPushed += 1;
        pushedThis += 1;
        newSeen.add(row.dedupeKey);
        maybeCharge();
    }
}

function sortPairs(pairs, key) {
    const getter = {
        volume24h: (p) => Number(p.volume?.h24 || 0),
        liquidity: (p) => Number(p.liquidity?.usd || 0),
        priceChange24h: (p) => Number(p.priceChange?.h24 || 0),
        age: (p) => -(Number(p.pairCreatedAt || 0)),
    }[key] || ((p) => Number(p.volume?.h24 || 0));
    return [...pairs].sort((a, b) => getter(b) - getter(a));
}

function shapeTokenRow(p, sourceTag) {
    const createdMs = p.pairCreatedAt ? Number(p.pairCreatedAt) : null;
    const ageHours = createdMs ? +((Date.now() - createdMs) / 3_600_000).toFixed(2) : null;
    const liquidityUsd = toNumber(p.liquidity?.usd);
    const fdvUsd = toNumber(p.fdv);
    const mcapUsd = toNumber(p.marketCap);

    const flags = [];
    if (liquidityUsd != null && liquidityUsd < 5_000) flags.push('low_liquidity');
    if (createdMs && (Date.now() - createdMs) < 24 * 3_600_000) flags.push('new_launch');
    if (fdvUsd != null && liquidityUsd != null && liquidityUsd > 0 && fdvUsd / liquidityUsd > 100) flags.push('thin_float');
    const priceChange24h = toNumber(p.priceChange?.h24);
    if (priceChange24h != null && priceChange24h > 100) flags.push('pump');
    if (priceChange24h != null && priceChange24h < -50) flags.push('dump');

    return {
        source: 'dexscreener',
        sourceTag,
        chain: p.chainId,
        dex: p.dexId,
        pairAddress: p.pairAddress,
        baseToken: p.baseToken,
        quoteToken: p.quoteToken,
        priceUsd: toNumber(p.priceUsd),
        priceNative: toNumber(p.priceNative),
        priceChange: {
            m5: toNumber(p.priceChange?.m5),
            h1: toNumber(p.priceChange?.h1),
            h6: toNumber(p.priceChange?.h6),
            h24: priceChange24h,
        },
        volume: {
            m5: toNumber(p.volume?.m5),
            h1: toNumber(p.volume?.h1),
            h6: toNumber(p.volume?.h6),
            h24: toNumber(p.volume?.h24),
        },
        txns: p.txns || null,
        liquidityUsd,
        volume24hUsd: toNumber(p.volume?.h24),
        fdvUsd,
        marketCapUsd: mcapUsd,
        pairCreatedAtMs: createdMs,
        pairCreatedAt: createdMs ? new Date(createdMs).toISOString() : null,
        ageHours,
        flags,
        url: p.url || (p.chainId && p.pairAddress ? `https://dexscreener.com/${p.chainId}/${p.pairAddress}` : null),
        dedupeKey: `${p.chainId}:${p.pairAddress}`,
        scrapedAt: new Date().toISOString(),
    };
}

async function runWalletsMode() {
    const cutoffSec = maxTxAgeHours > 0 ? Math.floor(Date.now() / 1000) - (maxTxAgeHours * 3600) : 0;
    const evmChains = chainList.filter((c) => ETHERSCAN_CHAIN_IDS[c] != null);

    if (evmChains.length === 0) {
        log.warning('No supported EVM chains provided. Etherscan V2 supports: ' + Object.keys(ETHERSCAN_CHAIN_IDS).join(', '));
        return;
    }

    const priceCache = new Map();

    for (const wallet of walletList) {
        if (totalPushed >= maxItemsTotal) break;
        for (const chain of evmChains) {
            if (totalPushed >= maxItemsTotal) break;
            await processWalletChain(wallet, chain, cutoffSec, priceCache);
        }
    }
}

async function processWalletChain(wallet, chain, cutoffSec, priceCache) {
    const chainId = ETHERSCAN_CHAIN_IDS[chain];
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${encodeURIComponent(wallet)}&page=1&offset=${Math.min(maxItemsPerSource, 100)}&startblock=0&endblock=99999999&sort=desc&apikey=${encodeURIComponent(etherscanApiKey)}`;

    await sleep(ETHERSCAN_SLEEP_MS);
    apiRequests += 1;
    let body;
    try {
        const res = await fetch(url);
        if (!res.ok) { log.warning(`Etherscan ${chain} HTTP ${res.status} for ${wallet}`); return; }
        body = await res.json();
    } catch (err) {
        log.warning(`Etherscan ${chain} fetch failed for ${wallet}: ${err?.message}`);
        return;
    }

    if (body?.status !== '1' || !Array.isArray(body.result)) {
        if (body?.message && body.message !== 'No transactions found') {
            log.warning(`Etherscan ${chain} for ${wallet}: ${body.message}`);
        }
        return;
    }

    log.info(`${chain} ${wallet.slice(0, 10)}...: ${body.result.length} transfers returned.`);

    let pushedThis = 0;
    for (const tx of body.result) {
        if (pushedThis >= maxItemsPerSource) break;
        if (totalPushed >= maxItemsTotal) break;

        const ts = Number(tx.timeStamp);
        if (cutoffSec > 0 && ts < cutoffSec) break;

        const decimals = Number(tx.tokenDecimal);
        const rawValue = BigInt(tx.value || '0');
        const amount = Number(rawValue) / Math.pow(10, Number.isFinite(decimals) ? decimals : 18);

        const priceUsd = await getTokenPriceUsd(chain, tx.contractAddress, priceCache);
        const valueUsd = priceUsd != null ? +(amount * priceUsd).toFixed(2) : null;

        totalSeen += 1;

        if (minTxValueUsd > 0 && (valueUsd == null || valueUsd < minTxValueUsd)) { filteredOut += 1; continue; }

        const direction = tx.from?.toLowerCase() === wallet.toLowerCase() ? 'out' : 'in';
        const row = {
            source: 'etherscan_v2',
            chain,
            chainId,
            wallet,
            direction,
            hash: tx.hash,
            blockNumber: Number(tx.blockNumber),
            timestamp: new Date(ts * 1000).toISOString(),
            from: tx.from,
            to: tx.to,
            tokenAddress: tx.contractAddress,
            tokenName: tx.tokenName,
            tokenSymbol: tx.tokenSymbol,
            tokenDecimals: Number.isFinite(decimals) ? decimals : null,
            amount,
            priceUsd,
            valueUsd,
            gasUsed: Number(tx.gasUsed || 0),
            url: `${explorerBase(chain)}/tx/${tx.hash}`,
            dedupeKey: `${chain}:${tx.hash}:${tx.contractAddress}:${direction}`,
            scrapedAt: new Date().toISOString(),
        };

        if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; continue; }

        await Actor.pushData(row);
        totalPushed += 1;
        pushedThis += 1;
        newSeen.add(row.dedupeKey);
        maybeCharge();
    }
}

async function getTokenPriceUsd(chain, tokenAddress, cache) {
    if (!tokenAddress) return null;
    const key = `${chain}:${tokenAddress.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);

    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
    await sleep(DEX_SLEEP_MS);
    apiRequests += 1;
    try {
        const res = await fetch(url);
        if (!res.ok) { cache.set(key, null); return null; }
        const body = await res.json();
        const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
        const chainPair = pairs.find((p) => String(p.chainId).toLowerCase() === chain) || pairs[0];
        const price = toNumber(chainPair?.priceUsd);
        cache.set(key, price);
        return price;
    } catch {
        cache.set(key, null);
        return null;
    }
}

function explorerBase(chain) {
    switch (chain) {
        case 'ethereum': return 'https://etherscan.io';
        case 'bsc': return 'https://bscscan.com';
        case 'polygon': return 'https://polygonscan.com';
        case 'arbitrum': return 'https://arbiscan.io';
        case 'optimism': return 'https://optimistic.etherscan.io';
        case 'base': return 'https://basescan.org';
        case 'avalanche': return 'https://snowtrace.io';
        case 'linea': return 'https://lineascan.build';
        case 'blast': return 'https://blastscan.io';
        default: return 'https://etherscan.io';
    }
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'launch_signal' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
