// DeFi TVL, Yields & Stablecoin Tracker
//
// Four keyless read-only endpoints from DefiLlama, one row shape per mode:
//   protocols   -> api.llama.fi/protocols       (TVL leaderboard by protocol)
//   yields      -> yields.llama.fi/pools        (liquidity pools by APY)
//   chains      -> api.llama.fi/v2/chains        (TVL by blockchain)
//   stablecoins -> stablecoins.llama.fi/stablecoins?includePrices=true
//
// All plain HTTP/JSON, no browser, no proxy, no key. Numbers come back as real
// JSON numbers (not strings), so sorting and filtering are done client-side and
// are genuinely numeric. `change_*` / `apyPct*` fields are already percentages.

import { Actor, log } from 'apify';

const FREE_ROWS = 2;
const CHARGE_EVENT = 'defi_row';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'protocols',
    chain = '',
    category = '',
    project = '',
    stablecoinPoolsOnly = false,
    minPoolTvlUsd = 1_000_000,
    includeCex = false,
    includeOutlierPools = false,
    maxResults = 50,
} = input;

const limit = Math.max(1, Math.min(1000, Number(maxResults) || 50));
const chainWanted = String(chain || '').trim().toLowerCase();
const categoryWanted = String(category || '').trim().toLowerCase();
const projectWanted = String(project || '').trim().toLowerCase();
const minPoolTvl = Math.max(0, Number(minPoolTvlUsd) || 0);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 2) => (num(v) == null ? null : Math.round(v * 10 ** d) / 10 ** d);

async function getJson(url) {
    for (let i = 0; i < 4; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'scrapemint-defi-tvl-tracker', Accept: 'application/json' },
            });
            if (res.status === 429 || res.status >= 500) {
                log.warning(`HTTP ${res.status} from ${url}; retry ${i + 1}`);
                await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (i === 3) throw err;
            await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
    }
    throw new Error(`failed to fetch ${url}`);
}

// ---- mode builders: each returns an array of plain row objects, pre-sorted ----

async function buildProtocols() {
    const data = await getJson('https://api.llama.fi/protocols');
    if (!Array.isArray(data)) throw new Error('protocols: unexpected shape');
    const rows = [];
    for (const p of data) {
        const tvl = num(p.tvl);
        // ~2,200 listings carry null / zero / negative TVL (delisted, pre-launch,
        // or accounting artifacts). They are not a live protocol to rank.
        if (tvl == null || tvl <= 0) continue;
        // DefiLlama's protocol list includes 78 centralized-exchange reserve
        // entries (Binance CEX at $139B, etc). They dwarf real DeFi and this is a
        // DeFi tracker, so drop them unless the buyer asks, or asks for CEX by name.
        if (!includeCex && String(p.category || '').toLowerCase() === 'cex'
            && categoryWanted !== 'cex') continue;
        const chains = Array.isArray(p.chains) ? p.chains : [];
        if (chainWanted) {
            const onChain = chains.some((c) => String(c).toLowerCase() === chainWanted)
                || String(p.chain || '').toLowerCase() === chainWanted;
            if (!onChain) continue;
        }
        if (categoryWanted && String(p.category || '').toLowerCase() !== categoryWanted) continue;
        rows.push({
            mode: 'protocols',
            name: p.name || null,
            category: p.category || null,
            chain: p.chain || null,
            chains,
            tvlUsd: round(tvl),
            change1hPct: round(p.change_1h),
            change1dPct: round(p.change_1d),
            change7dPct: round(p.change_7d),
            mcapUsd: num(p.mcap) != null ? round(p.mcap) : null,
            url: p.url || null,
            twitter: p.twitter ? `https://twitter.com/${p.twitter}` : null,
            slug: p.slug || null,
        });
    }
    rows.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
    return rows;
}

async function buildYields() {
    const payload = await getJson('https://yields.llama.fi/pools');
    const data = payload?.data;
    if (!Array.isArray(data)) throw new Error('yields: unexpected shape');
    const rows = [];
    for (const p of data) {
        const tvl = num(p.tvlUsd);
        if (tvl == null || tvl < minPoolTvl) continue;
        if (chainWanted && String(p.chain || '').toLowerCase() !== chainWanted) continue;
        if (projectWanted && String(p.project || '').toLowerCase() !== projectWanted) continue;
        if (stablecoinPoolsOnly && !p.stablecoin) continue;
        // DefiLlama flags pools whose APY is a statistical outlier (short-lived
        // reward farming, e.g. 76,000% on a $3M pool). Ranking by APY puts these
        // on top and makes the whole feed look like junk. Drop them by default.
        if (!includeOutlierPools && p.outlier) continue;
        const apy = num(p.apy);
        if (apy == null) continue;
        rows.push({
            mode: 'yields',
            project: p.project || null,
            chain: p.chain || null,
            symbol: p.symbol || null,
            poolMeta: p.poolMeta || null,
            tvlUsd: round(tvl),
            apyPct: round(apy),
            apyBasePct: round(p.apyBase),
            apyRewardPct: round(p.apyReward),
            apyChange1dPct: round(p.apyPct1D),
            apyChange7dPct: round(p.apyPct7D),
            apyChange30dPct: round(p.apyPct30D),
            isStablecoin: !!p.stablecoin,
            ilRisk: p.ilRisk || null,
            exposure: p.exposure || null,
            outlierApy: !!p.outlier,
            poolId: p.pool || null,
        });
    }
    rows.sort((a, b) => (b.apyPct || 0) - (a.apyPct || 0));
    return rows;
}

async function buildChains() {
    const data = await getJson('https://api.llama.fi/v2/chains');
    if (!Array.isArray(data)) throw new Error('chains: unexpected shape');
    const rows = [];
    for (const c of data) {
        const tvl = num(c.tvl);
        if (tvl == null || tvl <= 0) continue;
        if (chainWanted && String(c.name || '').toLowerCase() !== chainWanted) continue;
        rows.push({
            mode: 'chains',
            name: c.name || null,
            tvlUsd: round(tvl),
            tokenSymbol: c.tokenSymbol || null,
            chainId: c.chainId ?? null,
            geckoId: c.gecko_id || null,
        });
    }
    rows.sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0));
    return rows;
}

async function buildStablecoins() {
    const payload = await getJson('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    const data = payload?.peggedAssets;
    if (!Array.isArray(data)) throw new Error('stablecoins: unexpected shape');
    // `circulating` is a dict keyed by peg type (peggedUSD, peggedEUR, ...).
    // Take the single value it carries rather than assuming USD.
    const firstVal = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        for (const v of Object.values(obj)) { const n = num(v); if (n != null) return n; }
        return null;
    };
    const growth = (now, prev) => {
        const a = num(now); const b = num(prev);
        if (a == null || b == null || b === 0) return null;
        return round(((a - b) / b) * 100);
    };
    const rows = [];
    for (const s of data) {
        const circ = firstVal(s.circulating);
        if (circ == null || circ <= 0) continue;
        rows.push({
            mode: 'stablecoins',
            name: s.name || null,
            symbol: s.symbol || null,
            pegType: s.pegType || null,
            pegMechanism: s.pegMechanism || null,
            priceUsd: num(s.price) != null ? round(s.price, 4) : null,
            circulating: round(circ),
            growth1dPct: growth(circ, firstVal(s.circulatingPrevDay)),
            growth7dPct: growth(circ, firstVal(s.circulatingPrevWeek)),
            growth30dPct: growth(circ, firstVal(s.circulatingPrevMonth)),
            chains: Array.isArray(s.chains) ? s.chains : [],
        });
    }
    rows.sort((a, b) => (b.circulating || 0) - (a.circulating || 0));
    return rows;
}

const builders = {
    protocols: buildProtocols,
    yields: buildYields,
    chains: buildChains,
    stablecoins: buildStablecoins,
};

const build = builders[mode];
if (!build) {
    log.warning(`Unknown mode "${mode}". Use one of: ${Object.keys(builders).join(', ')}.`);
    await Actor.exit();
}

log.info(`Mode=${mode} chain=${chain || '(all)'} category=${category || '(all)'} project=${project || '(all)'} limit=${limit}.`);

let allRows;
try {
    allRows = await build();
} catch (err) {
    log.error(`Fetch/parse failed: ${err?.message}`);
    await Actor.pushData({ mode, error: String(err?.message || err), note: 'DefiLlama fetch failed; not charged.' });
    await Actor.exit();
}

log.info(`${allRows.length} rows matched before the ${limit}-row cap.`);
if (allRows.length === 0) {
    await Actor.pushData({ mode, found: false, note: 'No rows matched your filters; not charged.' });
    log.info('Done. 0 rows.');
    await Actor.exit();
}

const rows = allRows.slice(0, limit);
let charged = 0;
let free = 0;
for (const row of rows) {
    await Actor.pushData(row);
    if (free < FREE_ROWS) {
        free++;
    } else {
        await Actor.charge({ eventName: CHARGE_EVENT });
        charged++;
    }
}

log.info(`Done. pushed=${rows.length} free=${free} charged=${charged}.`);
await Actor.exit();
