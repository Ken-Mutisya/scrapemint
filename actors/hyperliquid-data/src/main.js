// Hyperliquid Data: Futures Prices, Funding Rates and Positions
//
// What it does
// ------------
// Market data from Hyperliquid, plus the thing a centralised exchange cannot
// offer: positions are public. Give it a wallet address and it returns what
// that account is actually holding, at what leverage, and where it gets
// liquidated.
//
//   markets    one row per live futures market: mark and oracle price, 24
//              hour change and volume, open interest in coins and dollars,
//              funding rate hourly and annualised, maximum leverage
//   funding    one row per funding payment per market over a window
//   positions  one row per open position for the wallet addresses you supply:
//              size, side, entry price, leverage, liquidation price, unrealised
//              profit and loss
//   traders    one row per recent trade with the counterparty wallet
//              addresses, which is how you find accounts worth looking up
//
// Keyless, no account, no browser.
//
// Pay per event
// -------------
//   market_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 250;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const API = 'https://api.hyperliquid.xyz/info';
// Funding on this venue settles EVERY HOUR. Most venues settle every eight
// hours, so the usual "rate times three times 365" annualisation understates
// a Hyperliquid rate by a factor of eight.
const FUNDING_PERIODS_PER_YEAR = 24 * 365;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'markets',
    coins = [],
    walletAddresses = [],
    hoursBack = 24,
    includeDelisted = false,
    minDayVolumeUsd = 0,
    minTradeUsd = 1000,
    maxRows = 50,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,\s]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every number in this API arrives as a string.
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const theMode = ['markets', 'funding', 'positions', 'traders'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'markets';
const wantCoins = new Set(asList(coins).map((c) => c.toUpperCase()));
const hours = Math.max(1, Math.min(720, Number(hoursBack) || 24));
const minVolume = Math.max(0, Number(minDayVolumeUsd) || 0);
const minTrade = Math.max(0, Number(minTradeUsd) || 0);
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 50));

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'market_row' }); }
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

async function post(body, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(API, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', 'User-Agent': UA, accept: 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { data: await res.json() };
    } catch (err) {
        if (attempt < 2) {
            await sleep(900 * (attempt + 1));
            return post(body, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

const stamp = () => ({
    exchange: 'Hyperliquid',
    sourceUrl: 'https://app.hyperliquid.xyz',
    scrapedAt: new Date().toISOString(),
});

log.info(`Hyperliquid ${theMode}${wantCoins.size ? ` | ${[...wantCoins].join(',')}` : ''}`);

if (theMode === 'positions') {
    const addresses = asList(walletAddresses);
    if (!addresses.length) {
        await note({ note: 'positions mode needs at least one wallet address in walletAddresses; not charged' });
    }
    for (const address of addresses) {
        if (emitted >= rowCap || pastDeadline()) break;
        const res = await post({ type: 'clearinghouseState', user: address });
        if (res.error || !res.data) {
            await note({ walletAddress: address, note: `no account state returned for ${address}: ${res.error || 'empty response'}; not charged` });
            await sleep(SPACING_MS);
            continue;
        }
        const state = res.data;
        const positions = Array.isArray(state.assetPositions) ? state.assetPositions : [];
        const accountValue = numOrNull(state.marginSummary?.accountValue);
        if (!positions.length) {
            // An address that never traded and one that is flat both come back
            // the same way, so the note says which cannot be distinguished.
            await note({
                walletAddress: address,
                accountValueUsd: accountValue,
                note: `${address} holds no open positions; an address that has never traded and one that has closed everything look identical here; not charged`,
            });
            await sleep(SPACING_MS);
            continue;
        }
        for (const entry of positions) {
            if (emitted >= rowCap) break;
            const p = entry?.position || {};
            // Size is SIGNED: a negative number is a short. Reporting the
            // absolute value alone loses the side entirely.
            const size = numOrNull(p.szi);
            const entryPx = numOrNull(p.entryPx);
            const value = numOrNull(p.positionValue);
            const upnl = numOrNull(p.unrealizedPnl);
            await push({
                mode: 'positions',
                ...stamp(),
                walletAddress: address,
                coin: p.coin || null,
                side: size == null ? null : (size > 0 ? 'long' : 'short'),
                sizeCoins: size != null ? Math.abs(size) : null,
                signedSize: size,
                entryPrice: entryPx,
                positionValueUsd: value,
                unrealisedPnlUsd: upnl,
                returnOnEquityPercent: numOrNull(p.returnOnEquity) != null
                    ? round(numOrNull(p.returnOnEquity) * 100, 3) : null,
                leverage: numOrNull(p.leverage?.value),
                leverageType: p.leverage?.type || null,
                liquidationPrice: numOrNull(p.liquidationPx),
                marginUsedUsd: numOrNull(p.marginUsed),
                maxLeverage: numOrNull(p.maxLeverage),
                accountValueUsd: accountValue,
                accountTotalPositionValueUsd: numOrNull(state.marginSummary?.totalNtlPos),
                withdrawableUsd: numOrNull(state.withdrawable),
            });
        }
        await sleep(SPACING_MS);
    }
} else {
    const res = await post({ type: 'metaAndAssetCtxs' });
    const meta = res.data?.[0];
    const ctxs = res.data?.[1];
    if (res.error || !Array.isArray(meta?.universe) || !Array.isArray(ctxs)) {
        await note({ note: `market data unavailable: ${res.error || 'unexpected response shape'}; not charged` });
    } else {
        // The two arrays are POSITIONAL: universe[i] describes the market that
        // ctxs[i] prices. They are not keyed by name and nothing in the
        // response pairs them, so the index is the only link.
        const universe = meta.universe;
        const rows = [];
        for (let i = 0; i < universe.length; i += 1) {
            const u = universe[i] || {};
            const c = ctxs[i] || {};
            const name = String(u.name || '').toUpperCase();
            if (!name) continue;
            // Delisted markets stay in the response carrying a stale price
            // with zero volume and zero open interest, so they read as live
            // markets unless they are filtered out.
            const delisted = !!u.isDelisted;
            if (delisted && !includeDelisted) continue;
            if (wantCoins.size && !wantCoins.has(name)) continue;
            const mark = numOrNull(c.markPx);
            const prev = numOrNull(c.prevDayPx);
            const oi = numOrNull(c.openInterest);
            const dayVol = numOrNull(c.dayNtlVlm);
            if (!delisted && dayVol != null && dayVol < minVolume) continue;
            const funding = numOrNull(c.funding);
            rows.push({
                name,
                delisted,
                dayVol: dayVol ?? 0,
                row: {
                    mode: 'markets',
                    ...stamp(),
                    coin: name,
                    market: `${name}-USD perpetual futures`,
                    markPrice: mark,
                    oraclePrice: numOrNull(c.oraclePx),
                    midPrice: numOrNull(c.midPx),
                    previousDayPrice: prev,
                    change24hPercent: mark != null && prev ? round(((mark - prev) / prev) * 100, 3) : null,
                    dayVolumeUsd: dayVol,
                    // Open interest is published in coins; the dollar figure is
                    // what people compare across markets.
                    openInterestCoins: oi,
                    openInterestUsd: oi != null && mark != null ? round(oi * mark, 2) : null,
                    fundingRateHourly: funding,
                    fundingRateHourlyPercent: funding != null ? round(funding * 100, 6) : null,
                    // Hourly settlement, not the eight hourly convention used
                    // by most venues.
                    fundingRateAnnualisedPercent: funding != null
                        ? round(funding * FUNDING_PERIODS_PER_YEAR * 100, 3) : null,
                    fundingSettlesEveryHours: 1,
                    fundingPaidBy: funding == null ? null : (funding > 0 ? 'longs pay shorts' : 'shorts pay longs'),
                    premiumOverOracle: numOrNull(c.premium),
                    maxLeverage: numOrNull(u.maxLeverage),
                    isolatedOnly: !!u.onlyIsolated,
                    isDelisted: delisted,
                    delistedCaveat: delisted
                        ? 'this market is delisted; its price is stale and it no longer trades' : null,
                },
            });
        }
        rows.sort((a, b) => b.dayVol - a.dayVol);

        if (theMode === 'traders') {
            // Trades on this exchange carry the counterparty wallet addresses,
            // which is how a caller finds accounts worth looking up in
            // positions mode without knowing any in advance.
            const targets = rows.filter((r) => !r.delisted).slice(0, wantCoins.size ? rows.length : 3);
            if (!targets.length) {
                await note({ note: 'no live market matched for recent trades; not charged' });
            }
            for (const t of targets) {
                if (emitted >= rowCap || pastDeadline()) break;
                const res2 = await post({ type: 'recentTrades', coin: t.name });
                const trades = Array.isArray(res2.data) ? res2.data : [];
                if (!trades.length) {
                    await note({ coin: t.name, note: `no recent trades returned for ${t.name}; not charged` });
                    await sleep(SPACING_MS);
                    continue;
                }
                // The exchange returns only the last handful of trades per
                // market, not a history, so this is a live sample. Scheduling
                // the run is what accumulates addresses over time.
                const shaped = trades.map((tr) => {
                    const px = numOrNull(tr.px);
                    const sz = numOrNull(tr.sz);
                    return { tr, px, sz, notional: px != null && sz != null ? px * sz : null };
                }).filter((x) => x.notional != null && x.notional >= minTrade)
                    .sort((a, b) => b.notional - a.notional);
                if (!shaped.length) {
                    await note({ coin: t.name, tradesSampled: trades.length, note: `none of the ${trades.length} most recent ${t.name} trades reached ${minTrade} USD; the exchange publishes only the latest handful per market, so lower the minimum or schedule the run to accumulate; not charged` });
                    await sleep(SPACING_MS);
                    continue;
                }
                for (const { tr, px, sz, notional } of shaped) {
                    if (emitted >= rowCap) break;
                    const users = Array.isArray(tr.users) ? tr.users : [];
                    await push({
                        mode: 'traders',
                        ...stamp(),
                        coin: t.name,
                        tradedAt: tr.time ? new Date(tr.time).toISOString() : null,
                        price: px,
                        sizeCoins: sz,
                        notionalUsd: round(notional, 2),
                        // B and A are the taker's side of the trade.
                        takerSide: tr.side === 'B' ? 'buy' : (tr.side === 'A' ? 'sell' : null),
                        // Both counterparties are published, but the response
                        // does not say which address took which side, so they
                        // are reported as a pair rather than guessed at.
                        counterpartyAddresses: users,
                        counterpartyCount: users.length,
                        sideAttributionNote: 'the exchange publishes both counterparty addresses without labelling which one bought; look each up in positions mode to see what they hold',
                        transactionHash: tr.hash || null,
                    });
                }
                await sleep(SPACING_MS);
            }
        } else if (theMode === 'markets') {
            if (!rows.length) {
                await note({
                    note: wantCoins.size
                        ? `no live market matched: ${[...wantCoins].join(', ')}; not charged`
                        : 'no markets matched the filters; lower the minimum volume; not charged',
                });
            }
            for (const r of rows) {
                if (emitted >= rowCap || pastDeadline()) break;
                await push(r.row);
            }
        } else {
            // funding history, newest first, for the selected markets
            const targets = rows.filter((r) => !r.delisted).slice(0, wantCoins.size ? rows.length : 5);
            if (!targets.length) {
                await note({ note: 'no live market matched for funding history; not charged' });
            }
            const startTime = Date.now() - hours * 3600000;
            for (const t of targets) {
                if (emitted >= rowCap || pastDeadline()) break;
                const hist = await post({ type: 'fundingHistory', coin: t.name, startTime });
                const entries = Array.isArray(hist.data) ? hist.data : [];
                if (!entries.length) {
                    await note({ coin: t.name, note: `no funding history returned for ${t.name} in the last ${hours} hours; not charged` });
                    await sleep(SPACING_MS);
                    continue;
                }
                const ordered = [...entries].sort((a, b) => (b.time || 0) - (a.time || 0));
                for (const e of ordered) {
                    if (emitted >= rowCap) break;
                    const rate = numOrNull(e.fundingRate);
                    await push({
                        mode: 'funding',
                        ...stamp(),
                        coin: t.name,
                        settledAt: e.time ? new Date(e.time).toISOString() : null,
                        fundingRate: rate,
                        fundingRatePercent: rate != null ? round(rate * 100, 6) : null,
                        annualisedPercent: rate != null
                            ? round(rate * FUNDING_PERIODS_PER_YEAR * 100, 3) : null,
                        premium: numOrNull(e.premium),
                        paidBy: rate == null ? null : (rate > 0 ? 'longs pay shorts' : 'shorts pay longs'),
                        settlesEveryHours: 1,
                    });
                }
                await sleep(SPACING_MS);
            }
        }
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the coins or wallet addresses requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
