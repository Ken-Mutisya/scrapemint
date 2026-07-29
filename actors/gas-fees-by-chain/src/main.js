// Ethereum & Layer 2 Gas Fees: Transaction Cost by Chain
//
// What it does
// ------------
// What a transaction actually costs right now, on Ethereum and the layer 2
// networks people use to avoid paying Ethereum prices. Not just a gas price
// in gwei, but the cost in dollars of the things users actually do: send the
// native coin, send a token, swap, mint.
//
//   gas       one row per chain: gas price, base fee, the priority fee at
//             the 10th, 50th and 90th percentile, how full recent blocks
//             are, and the dollar cost of four standard actions
//   actions   one row per chain per action, ranked so the cheapest chain
//             for that action is obvious
//   history   one row per recent block: base fee and how full it was
//
// Reads public JSON-RPC nodes directly. No API key, no account, no browser.
//
// Pay per event
// -------------
//   gas_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 20000;
const SPACING_MS = 150;
// Public RPC nodes answer 403 to a request with no User-Agent. This is not a
// block, it is a missing header, and it costs an hour to work out.
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const WEI_PER_GWEI = 1e9;
const WEI_PER_ETH = 1e18;
const FEE_HISTORY_BLOCKS = 10;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'gas',
    chains = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'],
    actions = ['transfer', 'token_transfer', 'swap', 'nft_mint'],
    blockCount = 10,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToNum = (h) => {
    if (typeof h !== 'string' || !h.startsWith('0x')) return null;
    const n = Number(BigInt(h));
    return Number.isFinite(n) ? n : null;
};

const theMode = ['gas', 'actions', 'history'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'gas';
const wantBlocks = Math.max(1, Math.min(100, Number(blockCount) || 10));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// The OP Stack gas price oracle, deployed at the same address on every OP
// chain. It prices the L1 data component of an L2 transaction.
const OP_ORACLE = '0x420000000000000000000000000000000000000F';
const GET_L1_FEE_SELECTOR = '49948e0e';

const CHAINS = {
    ethereum: {
        name: 'Ethereum', nativeToken: 'ETH', priceInstrument: 'ETH-USDT', isLayer2: false,
        endpoints: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
    },
    base: {
        name: 'Base', nativeToken: 'ETH', priceInstrument: 'ETH-USDT', isLayer2: true,
        settlementLayer: 'Ethereum', l1FeeModel: 'op_oracle',
        endpoints: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    },
    optimism: {
        name: 'Optimism', nativeToken: 'ETH', priceInstrument: 'ETH-USDT', isLayer2: true,
        settlementLayer: 'Ethereum', l1FeeModel: 'op_oracle',
        endpoints: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    },
    arbitrum: {
        name: 'Arbitrum One', nativeToken: 'ETH', priceInstrument: 'ETH-USDT', isLayer2: true,
        settlementLayer: 'Ethereum', l1FeeModel: 'embedded_in_gas_units',
        endpoints: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    },
    polygon: {
        // The token was renamed from MATIC to POL; the old ticker no longer
        // exists on the price venue, so asking for it prices the chain at null.
        name: 'Polygon', nativeToken: 'POL', priceInstrument: 'POL-USDT', isLayer2: false,
        endpoints: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    },
    bsc: {
        name: 'BNB Chain', nativeToken: 'BNB', priceInstrument: 'BNB-USDT', isLayer2: false,
        endpoints: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.bnbchain.org'],
    },
};

// Typical gas units and calldata sizes for each action. These are
// representative figures, not a quote for a specific transaction.
const ACTIONS = {
    transfer: { label: 'Send the native coin', gasUnits: 21000, calldataBytes: 110 },
    token_transfer: { label: 'Send an ERC20 token', gasUnits: 65000, calldataBytes: 180 },
    swap: { label: 'Swap tokens on a DEX', gasUnits: 150000, calldataBytes: 400 },
    nft_mint: { label: 'Mint an NFT', gasUnits: 85000, calldataBytes: 250 },
};

const chainAliases = { eth: 'ethereum', mainnet: 'ethereum', op: 'optimism', matic: 'polygon', pol: 'polygon', bnb: 'bsc', binance: 'bsc', arb: 'arbitrum' };
const resolveChain = (raw) => {
    const k = String(raw || '').toLowerCase().replace(/\s+/g, '');
    return CHAINS[k] ? k : (chainAliases[k] || null);
};

const requestedChains = asList(chains);
const chainKeys = [];
const unknownChains = [];
for (const c of requestedChains) {
    const k = resolveChain(c);
    if (k) { if (!chainKeys.includes(k)) chainKeys.push(k); } else unknownChains.push(c);
}
const useChains = chainKeys.length ? chainKeys : Object.keys(CHAINS);

const requestedActions = asList(actions).map((a) => a.toLowerCase());
const unknownActions = requestedActions.filter((a) => !ACTIONS[a]);
const useActions = requestedActions.filter((a) => ACTIONS[a]);
const actionKeys = useActions.length ? useActions : Object.keys(ACTIONS);

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'gas_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

// Every RPC call rotates through the chain's endpoints, so one node
// throttling does not fail the run.
async function rpc(chainKey, method, params) {
    const endpoints = CHAINS[chainKey].endpoints;
    let lastError = null;
    for (const url of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json', 'User-Agent': UA, accept: 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
            const body = await res.json();
            // A JSON-RPC error arrives inside a 200 response, so the status
            // code alone never means success.
            if (body.error) { lastError = body.error.message || 'rpc error'; continue; }
            if (body.result === undefined) { lastError = 'no result in response'; continue; }
            return { result: body.result, endpoint: url };
        } catch (err) {
            lastError = err?.message || 'fetch failed';
        } finally { clearTimeout(timer); }
        await sleep(SPACING_MS);
    }
    return { error: lastError || 'all endpoints failed' };
}

// Native token prices, from a venue already proven reachable from a
// datacentre. Fetched once per run and shared across chains.
async function fetchPrices(instruments) {
    const prices = new Map();
    for (const inst of [...new Set(instruments)]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`, {
                signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': UA },
            });
            const body = await res.json();
            const last = body?.data?.[0]?.last;
            if (last != null && Number.isFinite(Number(last))) prices.set(inst, Number(last));
        } catch { /* priced as null below */ } finally { clearTimeout(timer); }
        await sleep(SPACING_MS);
    }
    return prices;
}

// The L1 data fee an OP Stack chain charges on top of its own execution cost.
// Quoting only the L2 gas price understates what the user really pays.
async function opL1Fee(chainKey, calldataBytes) {
    const size = Math.max(1, calldataBytes);
    const payload = 'ab'.repeat(size);
    const offset = (32).toString(16).padStart(64, '0');
    const length = size.toString(16).padStart(64, '0');
    const padded = payload + '0'.repeat(((32 - (size % 32)) % 32) * 2);
    const data = `0x${GET_L1_FEE_SELECTOR}${offset}${length}${padded}`;
    const res = await rpc(chainKey, 'eth_call', [{ to: OP_ORACLE, data }, 'latest']);
    if (res.error || typeof res.result !== 'string') return null;
    return hexToNum(res.result);
}

log.info(`Gas fees ${theMode} | ${useChains.join(', ')}`);
if (unknownChains.length) {
    await note({
        unknownChains,
        note: `not a covered chain: ${unknownChains.join(', ')}; covered chains are ${Object.keys(CHAINS).join(', ')}; not charged`,
    });
}
if (unknownActions.length) {
    await note({
        unknownActions,
        note: `not a covered action: ${unknownActions.join(', ')}; covered actions are ${Object.keys(ACTIONS).join(', ')}; not charged`,
    });
}

const prices = await fetchPrices(useChains.map((k) => CHAINS[k].priceInstrument));
for (const inst of new Set(useChains.map((k) => CHAINS[k].priceInstrument))) {
    if (!prices.has(inst)) {
        await note({ priceInstrument: inst, note: `no live price for ${inst}, so dollar costs on chains using it are null while native costs are still reported; not charged` });
    }
}

// Read each chain once and derive every mode from the same snapshot.
const snapshots = new Map();
for (const key of useChains) {
    if (pastDeadline()) break;
    const chain = CHAINS[key];
    const [gasRes, feeRes] = await Promise.all([
        rpc(key, 'eth_gasPrice', []),
        rpc(key, 'eth_feeHistory', [`0x${FEE_HISTORY_BLOCKS.toString(16)}`, 'latest', [10, 50, 90]]),
    ]);
    if (gasRes.error && feeRes.error) {
        await note({ chain: chain.name, note: `${chain.name} did not respond on any endpoint: ${gasRes.error}; not charged` });
        continue;
    }
    const fee = feeRes.result || {};
    const baseFees = (fee.baseFeePerGas || []).map(hexToNum).filter((v) => v != null);
    const ratios = (fee.gasUsedRatio || []).filter((v) => Number.isFinite(v));
    const rewards = (fee.reward || []).filter(Array.isArray);
    const pct = (i) => {
        const vals = rewards.map((r) => hexToNum(r[i])).filter((v) => v != null);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    const oldestBlock = hexToNum(fee.oldestBlock);

    snapshots.set(key, {
        chain,
        endpoint: gasRes.endpoint || feeRes.endpoint || null,
        gasPriceWei: hexToNum(gasRes.result),
        // The last entry of baseFeePerGas is the NEXT block's base fee, not a
        // block that has been mined; the current one is the entry before it.
        baseFeeWei: baseFees.length > 1 ? baseFees[baseFees.length - 2] : (baseFees[0] ?? null),
        nextBaseFeeWei: baseFees.length ? baseFees[baseFees.length - 1] : null,
        priorityP10Wei: pct(0),
        priorityP50Wei: pct(1),
        priorityP90Wei: pct(2),
        congestion: ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100 : null,
        blocksSampled: ratios.length,
        baseFeeSeries: baseFees,
        ratioSeries: ratios,
        oldestBlock,
        priceUsd: prices.get(chain.priceInstrument) ?? null,
    });
    log.info(`${chain.name}: gas ${round((hexToNum(gasRes.result) || 0) / WEI_PER_GWEI, 4)} gwei via ${(gasRes.endpoint || '').replace('https://', '')}`);
    await sleep(SPACING_MS);
}

// Cost of one action on one chain, including the L1 data fee where the chain
// charges one separately.
async function costOf(key, actionKey) {
    const s = snapshots.get(key);
    const a = ACTIONS[actionKey];
    if (!s || s.gasPriceWei == null) return null;
    const executionWei = s.gasPriceWei * a.gasUnits;
    let l1Wei = 0;
    let l1Model = 'not applicable, this chain settles its own transactions';
    if (s.chain.l1FeeModel === 'op_oracle') {
        const fee = await opL1Fee(key, a.calldataBytes);
        l1Wei = fee ?? 0;
        l1Model = fee == null
            ? 'the L1 fee oracle did not answer, so this figure is execution only and understates the true cost'
            : 'L1 data fee priced by the chain own gas oracle and added';
    } else if (s.chain.l1FeeModel === 'embedded_in_gas_units') {
        // Arbitrum charges its L1 cost as extra gas UNITS rather than a
        // separate fee, so a standard gas figure understates it. Saying so is
        // better than quietly publishing a number that looks complete.
        l1Model = 'this chain bills its L1 cost as extra gas units, which a standard gas figure does not capture, so the real cost is somewhat higher';
    }
    const totalWei = executionWei + l1Wei;
    return {
        gasUnits: a.gasUnits,
        executionWei,
        l1DataFeeWei: l1Wei || null,
        totalWei,
        totalNative: totalWei / WEI_PER_ETH,
        totalUsd: s.priceUsd != null ? (totalWei / WEI_PER_ETH) * s.priceUsd : null,
        l1FeeNote: l1Model,
    };
}

const chainBase = (key) => {
    const s = snapshots.get(key);
    return {
        chain: s.chain.name,
        chainKey: key,
        isLayer2: !!s.chain.isLayer2,
        settlementLayer: s.chain.settlementLayer || null,
        nativeToken: s.chain.nativeToken,
        nativeTokenPriceUsd: s.priceUsd,
        rpcEndpoint: s.endpoint,
        scrapedAt: new Date().toISOString(),
    };
};

if (theMode === 'gas') {
    for (const key of snapshots.keys()) {
        if (emitted >= rowCap || pastDeadline()) break;
        const s = snapshots.get(key);
        const row = {
            mode: 'gas',
            ...chainBase(key),
            gasPriceGwei: s.gasPriceWei != null ? round(s.gasPriceWei / WEI_PER_GWEI, 6) : null,
            baseFeeGwei: s.baseFeeWei != null ? round(s.baseFeeWei / WEI_PER_GWEI, 6) : null,
            nextBlockBaseFeeGwei: s.nextBaseFeeWei != null ? round(s.nextBaseFeeWei / WEI_PER_GWEI, 6) : null,
            priorityFeeP10Gwei: s.priorityP10Wei != null ? round(s.priorityP10Wei / WEI_PER_GWEI, 6) : null,
            priorityFeeP50Gwei: s.priorityP50Wei != null ? round(s.priorityP50Wei / WEI_PER_GWEI, 6) : null,
            priorityFeeP90Gwei: s.priorityP90Wei != null ? round(s.priorityP90Wei / WEI_PER_GWEI, 6) : null,
            blockFullnessPercent: round(s.congestion, 2),
            blocksSampled: s.blocksSampled,
        };
        for (const actionKey of actionKeys) {
            const c = await costOf(key, actionKey);
            row[`${actionKey}CostNative`] = c ? round(c.totalNative, 12) : null;
            row[`${actionKey}CostUsd`] = c && c.totalUsd != null ? round(c.totalUsd, 6) : null;
        }
        const sample = await costOf(key, actionKeys[0]);
        row.l1DataFeeHandling = sample ? sample.l1FeeNote : null;
        await push(row);
    }
} else if (theMode === 'actions') {
    for (const actionKey of actionKeys) {
        if (pastDeadline()) break;
        const rows = [];
        for (const key of snapshots.keys()) {
            const c = await costOf(key, actionKey);
            if (!c) continue;
            rows.push({ key, c });
        }
        // Rank on dollars where every chain is priced; a chain with no price
        // is listed but never given a rank it did not earn.
        const priced = rows.filter((r) => r.c.totalUsd != null).sort((a, b) => a.c.totalUsd - b.c.totalUsd);
        const cheapest = priced[0] || null;
        for (const { key, c } of rows) {
            if (emitted >= rowCap) break;
            const rank = c.totalUsd != null ? priced.findIndex((p) => p.key === key) + 1 : null;
            await push({
                mode: 'actions',
                action: actionKey,
                actionLabel: ACTIONS[actionKey].label,
                ...chainBase(key),
                gasUnitsAssumed: c.gasUnits,
                executionCostNative: round(c.executionWei / WEI_PER_ETH, 12),
                l1DataFeeNative: c.l1DataFeeWei != null ? round(c.l1DataFeeWei / WEI_PER_ETH, 12) : null,
                totalCostNative: round(c.totalNative, 12),
                totalCostUsd: c.totalUsd != null ? round(c.totalUsd, 6) : null,
                costRankAmongChains: rank || null,
                isCheapestChain: cheapest ? key === cheapest.key : null,
                timesCheapestChainCost: cheapest && c.totalUsd != null && cheapest.c.totalUsd > 0
                    ? round(c.totalUsd / cheapest.c.totalUsd, 2) : null,
                l1DataFeeHandling: c.l1FeeNote,
                gasUnitsCaveat: 'gas units are representative of this kind of transaction, not a quote for a specific one',
            });
        }
    }
} else {
    for (const key of snapshots.keys()) {
        if (emitted >= rowCap || pastDeadline()) break;
        const s = snapshots.get(key);
        const series = s.baseFeeSeries;
        if (!series.length) {
            await note({ chain: s.chain.name, note: `${s.chain.name} returned no fee history; not charged` });
            continue;
        }
        // baseFeePerGas has one MORE entry than gasUsedRatio: the extra one is
        // the next block, which has no usage yet. Pairing them by index
        // without allowing for that shifts every reading by one block.
        const count = Math.min(series.length - 1, s.ratioSeries.length, wantBlocks);
        for (let i = count - 1; i >= 0; i -= 1) {
            if (emitted >= rowCap) break;
            await push({
                mode: 'history',
                ...chainBase(key),
                blockNumber: s.oldestBlock != null ? s.oldestBlock + i : null,
                baseFeeGwei: round(series[i] / WEI_PER_GWEI, 6),
                blockFullnessPercent: round(s.ratioSeries[i] * 100, 2),
                blocksFromLatest: count - 1 - i,
            });
        }
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the chains and actions requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
