// Bitcoin Network Data: Fees, Hashrate, Mining Pools and Blocks
//
// What it does
// ------------
// The operational state of the Bitcoin network, as clean rows. What a
// transaction needs to pay to confirm, how backed up the mempool is, how much
// hashing power is pointed at the chain, when difficulty next adjusts, who is
// actually mining the blocks, and what each recent block earned.
//
//   network   one row per metric group: fees, mempool backlog, difficulty
//             and its next adjustment, hashrate, and recent block rewards
//   pools     one row per mining pool over a window: blocks found, share of
//             the network, empty blocks
//   blocks    one row per recent block: miner, fees collected, size, reward
//   hashrate  a daily hashrate series with the difficulty in force on each
//             day resolved against it
//
// Source: mempool.space, keyless. Core numbers fall back to blockchain.info
// if that service is unavailable, since it is a community run project rather
// than a commercial feed.
//
// Pay per event
// -------------
//   network_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 250;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const API = 'https://mempool.space/api';
const FALLBACK = 'https://blockchain.info/q';

// Hashrate is published in hashes per second, which is a number around 8.6e20.
// Every hashrate figure in the output is exahashes per second.
const H_PER_EH = 1e18;
const SATS_PER_BTC = 1e8;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'network',
    timespan = '1w',
    blockCount = 15,
    maxRows = 200,
} = input;

const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
// Block timestamps and retarget history are in SECONDS, while the difficulty
// adjustment estimate, its remaining time and the average block time are in
// MILLISECONDS. Reading one as the other puts the next retarget in 1970.
const isoFromSeconds = (s) => (numOrNull(s) == null ? null : new Date(numOrNull(s) * 1000).toISOString());
const isoFromMillis = (ms) => (numOrNull(ms) == null ? null : new Date(numOrNull(ms)).toISOString());

const theMode = ['network', 'pools', 'blocks', 'hashrate'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'network';
// An unrecognised timespan is NOT rejected by the source: it silently returns
// all time figures instead, so "last week" quietly becomes "since 2009".
// Anything not on this list is refused here rather than answered wrongly.
const POOL_SPANS = ['24h', '3d', '1w', '1m', '3m', '6m', '1y', '2y', '3y'];
const HASH_SPANS = ['3d', '1w', '1m', '3m', '6m', '1y', '2y', '3y'];
const requestedSpan = String(timespan || '').trim().toLowerCase();
const validSpans = theMode === 'hashrate' ? HASH_SPANS : POOL_SPANS;
const spanIsValid = validSpans.includes(requestedSpan);
const span = spanIsValid ? requestedSpan : (theMode === 'hashrate' ? '3m' : '1w');
const wantBlocks = Math.max(1, Math.min(100, Number(blockCount) || 15));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'network_row' }); }
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

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const body = await res.text();
        try { return { data: JSON.parse(body) }; }
        catch { return { error: 'response was not JSON' }; }
    } catch (err) {
        if (attempt < 2) {
            await sleep(800 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

async function getText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
        if (!res.ok) return null;
        return (await res.text()).trim();
    } catch { return null; } finally { clearTimeout(timer); }
}

const SOURCE = { sourceName: 'mempool.space', sourceUrl: 'https://mempool.space' };
const stamp = () => ({ ...SOURCE, scrapedAt: new Date().toISOString() });

log.info(`Bitcoin network ${theMode}${theMode === 'pools' || theMode === 'hashrate' ? ` | ${span}` : ''}`);
if (!spanIsValid && String(timespan || '').trim()) {
    await note({
        requestedTimespan: timespan,
        usedTimespan: span,
        note: `"${timespan}" is not a valid window; the source answers an unknown window with ALL TIME figures rather than an error, so ${span} was used instead; valid windows are ${validSpans.join(', ')}; not charged`,
    });
}

if (theMode === 'network') {
    const [feesRes, mempoolRes, diffRes, hashRes, rewardRes] = await Promise.all([
        getJson(`${API}/v1/fees/recommended`),
        getJson(`${API}/mempool`),
        getJson(`${API}/v1/difficulty-adjustment`),
        getJson(`${API}/v1/mining/hashrate/3d`),
        getJson(`${API}/v1/mining/reward-stats/144`),
    ]);

    // Fees
    if (feesRes.data) {
        const f = feesRes.data;
        await push({
            mode: 'network',
            metricGroup: 'fees',
            unit: 'satoshis per virtual byte',
            fastestFeeSatPerVbyte: numOrNull(f.fastestFee),
            halfHourFeeSatPerVbyte: numOrNull(f.halfHourFee),
            hourFeeSatPerVbyte: numOrNull(f.hourFee),
            economyFeeSatPerVbyte: numOrNull(f.economyFee),
            minimumFeeSatPerVbyte: numOrNull(f.minimumFee),
            // A typical spend is roughly 140 vbytes, which is what most
            // wallets are actually deciding about.
            typicalTransactionCostSats: numOrNull(f.halfHourFee) != null ? Math.round(f.halfHourFee * 140) : null,
            feesAreAtFloor: numOrNull(f.fastestFee) != null && numOrNull(f.minimumFee) != null
                ? f.fastestFee <= f.minimumFee : null,
            ...stamp(),
        });
    } else {
        await note({ metricGroup: 'fees', note: `fee estimates unavailable: ${feesRes.error}; not charged` });
    }

    // Mempool backlog
    if (mempoolRes.data) {
        const m = mempoolRes.data;
        const vsize = numOrNull(m.vsize);
        await push({
            mode: 'network',
            metricGroup: 'mempool',
            transactionCount: numOrNull(m.count),
            virtualSizeBytes: vsize,
            // A block holds about a million virtual bytes, so this is how many
            // blocks it would take to clear the queue at current demand.
            blocksToClearBacklog: vsize != null ? round(vsize / 1e6, 2) : null,
            totalFeesWaitingBtc: numOrNull(m.total_fee) != null ? round(m.total_fee / SATS_PER_BTC, 8) : null,
            ...stamp(),
        });
    } else {
        await note({ metricGroup: 'mempool', note: `mempool state unavailable: ${mempoolRes.error}; not charged` });
    }

    // Difficulty and its next adjustment
    if (diffRes.data) {
        const d = diffRes.data;
        await push({
            mode: 'network',
            metricGroup: 'difficulty',
            progressThroughEpochPercent: round(numOrNull(d.progressPercent), 3),
            remainingBlocks: numOrNull(d.remainingBlocks),
            nextRetargetHeight: numOrNull(d.nextRetargetHeight),
            // Milliseconds, unlike every block timestamp in this API.
            estimatedRetargetDate: isoFromMillis(d.estimatedRetargetDate),
            estimatedDaysToRetarget: numOrNull(d.remainingTime) != null
                ? round(d.remainingTime / 86400000, 2) : null,
            estimatedDifficultyChangePercent: round(numOrNull(d.difficultyChange), 3),
            previousRetargetChangePercent: round(numOrNull(d.previousRetarget), 3),
            previousRetargetAt: isoFromSeconds(d.previousTime),
            averageBlockTimeMinutes: numOrNull(d.timeAvg) != null ? round(d.timeAvg / 60000, 2) : null,
            miningFasterThanTarget: numOrNull(d.timeAvg) != null ? d.timeAvg < 600000 : null,
            ...stamp(),
        });
    } else {
        await note({ metricGroup: 'difficulty', note: `difficulty data unavailable: ${diffRes.error}; not charged` });
    }

    // Hashrate, with a fallback because this is a community run service.
    if (hashRes.data) {
        const h = hashRes.data;
        await push({
            mode: 'network',
            metricGroup: 'hashrate',
            currentHashrateEhs: numOrNull(h.currentHashrate) != null
                ? round(h.currentHashrate / H_PER_EH, 2) : null,
            currentDifficulty: numOrNull(h.currentDifficulty),
            observationsInSeries: Array.isArray(h.hashrates) ? h.hashrates.length : null,
            fallbackUsed: false,
            ...stamp(),
        });
    } else {
        // blockchain.info reports hashrate in GIGAhashes per second, a factor
        // of a billion away from the primary source's hashes per second.
        // Passing it through unconverted would understate the network by 1e9.
        const [rawHash, rawDiff] = await Promise.all([
            getText(`${FALLBACK}/hashrate`),
            getText(`${FALLBACK}/getdifficulty`),
        ]);
        const ghs = numOrNull(rawHash);
        if (ghs != null) {
            await push({
                mode: 'network',
                metricGroup: 'hashrate',
                currentHashrateEhs: round((ghs * 1e9) / H_PER_EH, 2),
                currentDifficulty: numOrNull(rawDiff),
                observationsInSeries: null,
                fallbackUsed: true,
                sourceName: 'blockchain.info (fallback)',
                sourceUrl: 'https://blockchain.info',
                scrapedAt: new Date().toISOString(),
            });
            log.info('primary hashrate source failed, used blockchain.info fallback');
        } else {
            await note({ metricGroup: 'hashrate', note: `hashrate unavailable from both sources: ${hashRes.error}; not charged` });
        }
    }

    // What recent blocks actually earned.
    if (rewardRes.data) {
        const r = rewardRes.data;
        // Every figure here arrives as a STRING of satoshis.
        const totalReward = numOrNull(r.totalReward);
        const totalFee = numOrNull(r.totalFee);
        const blocks = numOrNull(r.endBlock) != null && numOrNull(r.startBlock) != null
            ? r.endBlock - r.startBlock + 1 : null;
        await push({
            mode: 'network',
            metricGroup: 'block_rewards',
            blocksCovered: blocks,
            startBlock: numOrNull(r.startBlock),
            endBlock: numOrNull(r.endBlock),
            totalRewardBtc: totalReward != null ? round(totalReward / SATS_PER_BTC, 8) : null,
            totalFeesBtc: totalFee != null ? round(totalFee / SATS_PER_BTC, 8) : null,
            averageRewardPerBlockBtc: totalReward != null && blocks
                ? round(totalReward / blocks / SATS_PER_BTC, 8) : null,
            // The share of miner income coming from fees rather than the
            // subsidy, which is the number that matters as the subsidy halves.
            feeShareOfRewardPercent: totalReward && totalFee != null
                ? round((totalFee / totalReward) * 100, 3) : null,
            transactionsIncluded: numOrNull(r.totalTx),
            ...stamp(),
        });
    } else {
        await note({ metricGroup: 'block_rewards', note: `reward statistics unavailable: ${rewardRes.error}; not charged` });
    }
} else if (theMode === 'pools') {
    const res = await getJson(`${API}/v1/mining/pools/${span}`);
    const pools = res.data?.pools || [];
    const totalBlocks = numOrNull(res.data?.blockCount);
    const networkHashrate = numOrNull(res.data?.lastEstimatedHashrate);
    if (!pools.length) {
        await note({ note: `no mining pool data returned for ${span}: ${res.error || 'empty response'}; not charged` });
    }
    const sorted = [...pools].sort((a, b) => (b.blockCount || 0) - (a.blockCount || 0));
    for (const p of sorted) {
        if (emitted >= rowCap || pastDeadline()) break;
        const blocks = numOrNull(p.blockCount) || 0;
        const share = totalBlocks ? (blocks / totalBlocks) * 100 : null;
        await push({
            mode: 'pools',
            timespan: span,
            poolName: p.name || null,
            poolSlug: p.slug || null,
            blocksMined: blocks,
            networkBlocksInWindow: totalBlocks,
            shareOfBlocksPercent: share != null ? round(share, 3) : null,
            // Share of blocks times network hashrate is the usual way a pool's
            // hashrate is estimated; nobody publishes it directly.
            estimatedHashrateEhs: share != null && networkHashrate != null
                ? round((share / 100) * (networkHashrate / H_PER_EH), 2) : null,
            emptyBlocks: numOrNull(p.emptyBlocks),
            emptyBlockPercent: blocks ? round(((numOrNull(p.emptyBlocks) || 0) / blocks) * 100, 3) : null,
            // "Unknown" is not a mining pool, it is every block whose coinbase
            // could not be attributed to one.
            isUnattributed: String(p.slug || '').toLowerCase() === 'unknown',
            website: p.link || null,
            ...stamp(),
        });
    }
} else if (theMode === 'blocks') {
    const collected = [];
    let cursor = null;
    while (collected.length < wantBlocks && !pastDeadline()) {
        const url = cursor == null ? `${API}/v1/blocks` : `${API}/v1/blocks/${cursor}`;
        const res = await getJson(url);
        const batch = res.data;
        if (!Array.isArray(batch) || !batch.length) {
            if (!collected.length) {
                await note({ note: `no blocks returned: ${res.error || 'empty response'}; not charged` });
            }
            break;
        }
        collected.push(...batch);
        // The feed serves 15 blocks per call; deeper history is requested by
        // the height to start from.
        cursor = (numOrNull(batch[batch.length - 1].height) || 0) - 1;
        if (cursor <= 0) break;
        await sleep(SPACING_MS);
    }
    for (const b of collected.slice(0, wantBlocks)) {
        if (emitted >= rowCap) break;
        const x = b.extras || {};
        const fees = numOrNull(x.totalFees);
        const reward = numOrNull(x.reward);
        await push({
            mode: 'blocks',
            height: numOrNull(b.height),
            blockHash: b.id || null,
            // Block timestamps are SECONDS here.
            minedAt: isoFromSeconds(b.timestamp),
            minerPool: x.pool?.name || null,
            transactionCount: numOrNull(b.tx_count),
            sizeBytes: numOrNull(b.size),
            weightUnits: numOrNull(b.weight),
            totalFeesBtc: fees != null ? round(fees / SATS_PER_BTC, 8) : null,
            blockRewardBtc: reward != null ? round(reward / SATS_PER_BTC, 8) : null,
            subsidyBtc: reward != null && fees != null ? round((reward - fees) / SATS_PER_BTC, 8) : null,
            feeShareOfRewardPercent: reward && fees != null ? round((fees / reward) * 100, 3) : null,
            medianFeeSatPerVbyte: round(numOrNull(x.medianFee), 3),
            averageFeeSats: numOrNull(x.avgFee),
            difficulty: numOrNull(b.difficulty),
            isEmpty: numOrNull(b.tx_count) === 1,
            ...stamp(),
        });
    }
} else {
    const res = await getJson(`${API}/v1/mining/hashrate/${span}`);
    const hashrates = res.data?.hashrates || [];
    const difficulty = res.data?.difficulty || [];
    if (!hashrates.length) {
        await note({ note: `no hashrate series returned for ${span}: ${res.error || 'empty response'}; not charged` });
    }
    // The two series are NOT parallel arrays: hashrate is daily while
    // difficulty only changes every 2016 blocks, and they use different key
    // names for their timestamps. Zipping them by index would attach an
    // unrelated difficulty to each day, so each day resolves the last
    // adjustment at or before it.
    const adjustments = difficulty
        .map((d) => ({ time: numOrNull(d.time), difficulty: numOrNull(d.difficulty), adjustment: numOrNull(d.adjustment), height: numOrNull(d.height) }))
        .filter((d) => d.time != null)
        .sort((a, b) => a.time - b.time);
    const difficultyAt = (ts) => {
        let found = null;
        for (const a of adjustments) { if (a.time <= ts) found = a; else break; }
        return found;
    };

    const ordered = [...hashrates].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const h of ordered) {
        if (emitted >= rowCap || pastDeadline()) break;
        const ts = numOrNull(h.timestamp);
        const inForce = ts != null ? difficultyAt(ts) : null;
        await push({
            mode: 'hashrate',
            timespan: span,
            date: ts != null ? isoFromSeconds(ts).slice(0, 10) : null,
            timestamp: isoFromSeconds(ts),
            averageHashrateEhs: numOrNull(h.avgHashrate) != null ? round(h.avgHashrate / H_PER_EH, 2) : null,
            difficultyInForce: inForce ? inForce.difficulty : null,
            difficultySetAtHeight: inForce ? inForce.height : null,
            difficultySetOn: inForce ? isoFromSeconds(inForce.time) : null,
            lastAdjustmentPercent: inForce && inForce.adjustment != null
                ? round((inForce.adjustment - 1) * 100, 3) : null,
            ...stamp(),
        });
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; try a different mode or window; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
