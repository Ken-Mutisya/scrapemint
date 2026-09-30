// Polymarket Whale Tracker: big bets, and whether the bettor is any good
//
// Strategy
// --------
// Polymarket's public data API serves every trade across all markets, and can
// filter to trades above a cash size. We read the trades since the last run,
// merge the fills of one bet (same wallet, outcome and side within a few
// minutes: a $40K order often fills as several pieces), and keep bets above
// the buyer's threshold.
//
// Each bettor is then looked up on Polymarket's own profit leaderboard, all
// time and last 30 days. A bet from a wallet ranked inside the buyer's cut-off
// with positive profit is flagged smart money: the row alert buyers watch for.
// A wallet with heavy losses is reported too, since fading it is a strategy.
//
// All of it is public and keyless: no browser, no proxy. Kalshi is not
// included: its public trade feed has no size filter and returns seconds of
// trades per request, and it does not identify traders anyway.
//
// Built for schedules: each run returns only bets placed since the previous
// run (state in a named store in the buyer's account).
//
// Pay per event
// -------------
//   whale_bet        ($0.005) a bet above your threshold
//   smart_money_bet  ($0.02)  the same, from a wallet ranked in the profit
//                             leaderboard's top N (all time or 30 days)
// No per-run free allowance (a poller); a run with no new bets is free.

import { Actor, log } from 'apify';

const API = 'https://data-api.polymarket.com';
const PAGE = 1000;
const MAX_PAGES = 15;
const MERGE_WINDOW_S = 300;
const FETCH_TIMEOUT_MS = 20000;
const TRADER_CACHE_MS = 6 * 3600 * 1000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    minBetUsd = 5000,
    lookbackMinutes = 60,
    onlyNew = true,
    smartMoneyTopRank = 250,
    onlySmartMoney = false,
    sides = [],
    marketKeywords = [],
    wallets = [],
    skipNearCertain = true,
    maxBets = 200,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const minUsd = Math.max(1, Number(minBetUsd) || 5000);
const topRank = Math.max(1, Number(smartMoneyTopRank) || 250);
const sideQ = new Set(listOf(sides).map((s) => s.toUpperCase()));
const kwQ = listOf(marketKeywords).map((k) => k.toLowerCase());
const walletQ = listOf(wallets).map((w) => w.toLowerCase());
const cap = Math.max(1, Number(maxBets) || 200);

async function get(path) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
            return await res.json();
        } catch (err) {
            if (err.final || attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
    }
    return null;
}

// ---------- Window ----------

const store = await Actor.openKeyValueStore('polymarket-whale-tracker-state');
const state = (onlyNew && (await store.getValue('STATE'))) || {};
const nowS = Math.floor(Date.now() / 1000);
const lookbackS = Math.max(1, Math.min(7 * 24 * 60, Number(lookbackMinutes) || 60)) * 60;
// A scheduled run starts where the last one ended, less the merge window, so
// a bet whose fills straddle two runs is still seen whole; its fills already
// returned are dropped by transaction hash below.
const sinceS = onlyNew && state.lastTs ? Math.max(state.lastTs - MERGE_WINDOW_S, nowS - 7 * 86400) : nowS - lookbackS;
const seenFills = new Set(state.fills || []);

// ---------- Trades ----------

// Fetch below the bet threshold: a large bet can arrive as several smaller
// fills, and only the merged total is compared with minBetUsd.
const fillFloor = Math.max(50, Math.floor(minUsd / 10));
const fills = [];
async function pull(extra) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = await get(`/trades?limit=${PAGE}&offset=${page * PAGE}&filterType=CASH&filterAmount=${fillFloor}${extra}`);
        if (!Array.isArray(rows) || !rows.length) return;
        for (const t of rows) if (t.timestamp >= sinceS) fills.push(t);
        if (rows[rows.length - 1].timestamp < sinceS || rows.length < PAGE) return;
    }
    log.warning(`Hit the ${MAX_PAGES * PAGE}-fill page limit before the start of the window; the oldest part may be incomplete. Schedule more often or raise minBetUsd.`);
}
if (walletQ.length) for (const w of walletQ) await pull(`&user=${w}`);
else await pull('');
log.info(`${fills.length} fill(s) of $${fillFloor}+ since ${new Date(sinceS * 1000).toISOString()}.`);

// ---------- Merge fills into bets ----------

const fillKey = (t) => `${t.transactionHash}:${t.asset}:${t.proxyWallet}:${t.size}`;
const groups = new Map();
for (const t of fills.sort((a, b) => a.timestamp - b.timestamp)) {
    const k = `${t.proxyWallet}|${t.asset}|${t.side}`;
    const list = groups.get(k) || [];
    const last = list[list.length - 1];
    if (last && t.timestamp - last.lastTs <= MERGE_WINDOW_S) {
        last.fills.push(t);
        last.lastTs = t.timestamp;
    } else {
        list.push({ fills: [t], firstTs: t.timestamp, lastTs: t.timestamp });
    }
    groups.set(k, list);
}

let bets = [];
for (const list of groups.values()) {
    for (const g of list) {
        // Drop a bet whose fills were all returned by an earlier run; keep
        // only the new fills of one still being built.
        const fresh = g.fills.filter((t) => !seenFills.has(fillKey(t)));
        if (!fresh.length) continue;
        const t0 = fresh[0];
        const shares = fresh.reduce((s, t) => s + Number(t.size), 0);
        const usd = fresh.reduce((s, t) => s + Number(t.size) * Number(t.price), 0);
        const avgPrice = shares ? usd / shares : null;
        bets.push({ t0, fresh, shares, usd, avgPrice, firstTs: fresh[0].timestamp, lastTs: fresh[fresh.length - 1].timestamp });
    }
}

bets = bets.filter((b) => {
    if (b.usd < minUsd) return false;
    if (sideQ.size && !sideQ.has(String(b.t0.side).toUpperCase())) return false;
    if (kwQ.length) {
        const hay = `${b.t0.title} ${b.t0.slug} ${b.t0.eventSlug} ${b.t0.outcome}`.toLowerCase();
        if (!kwQ.some((k) => hay.includes(k))) return false;
    }
    // A $10K trade at 99.9 or 0.1 cents is parking or cashing out on an outcome
    // already decided, not a view on the market. Either side, either end.
    if (skipNearCertain && (b.avgPrice >= 0.97 || b.avgPrice <= 0.03)) return false;
    return true;
}).sort((a, b) => b.usd - a.usd);

// ---------- Who is betting ----------

const cache = (await store.getValue('TRADER_CACHE')) || {};
const traders = new Map();
const wanted = [...new Set(bets.map((b) => b.t0.proxyWallet))];
let lookupFails = 0;
async function lookup(wallet) {
    const c = cache[wallet];
    if (c && Date.now() - c.at < TRADER_CACHE_MS) { traders.set(wallet, c); return; }
    try {
        const [all, month] = await Promise.all([
            get(`/v1/leaderboard?timePeriod=ALL&orderBy=PNL&user=${wallet}`),
            get(`/v1/leaderboard?timePeriod=MONTH&orderBy=PNL&user=${wallet}`),
        ]);
        const a = Array.isArray(all) ? all[0] : null;
        const m = Array.isArray(month) ? month[0] : null;
        const rec = {
            at: Date.now(),
            userName: a?.userName || m?.userName || null,
            xUsername: a?.xUsername || null,
            allTimeRank: a ? Number(a.rank) : null,
            allTimePnl: a ? round(a.pnl) : null,
            allTimeVolume: a ? round(a.vol) : null,
            monthRank: m ? Number(m.rank) : null,
            monthPnl: m ? round(m.pnl) : null,
            monthVolume: m ? round(m.vol) : null,
        };
        cache[wallet] = rec;
        traders.set(wallet, rec);
    } catch (err) {
        lookupFails += 1;
        log.debug(`leaderboard ${wallet}: ${err?.message}`);
    }
}
let wi = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (wi < wanted.length) await lookup(wanted[wi++]); }));
for (const [w, c] of Object.entries(cache)) if (Date.now() - c.at > TRADER_CACHE_MS) delete cache[w];

function round(n, d = 2) { const x = Number(n); return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null; }

function smartMoney(tr) {
    if (!tr) return { smart: false, reasons: [] };
    const reasons = [];
    if (tr.allTimeRank && tr.allTimeRank <= topRank && tr.allTimePnl > 0) reasons.push(`all-time profit rank #${tr.allTimeRank}`);
    if (tr.monthRank && tr.monthRank <= topRank && tr.monthPnl > 0) reasons.push(`30-day profit rank #${tr.monthRank}`);
    return { smart: reasons.length > 0, reasons };
}

// ---------- Emit ----------

let pushed = 0;
let charged = 0;
let smartCount = 0;
const newFills = [];
for (const b of bets) {
    if (pushed >= cap) break;
    const tr = traders.get(b.t0.proxyWallet);
    const sm = smartMoney(tr);
    if (onlySmartMoney && !sm.smart) continue;
    const t = b.t0;
    const buy = t.side === 'BUY';
    await Actor.pushData({
        platform: 'Polymarket',
        market: t.title,
        outcome: t.outcome,
        side: t.side,
        betUsd: round(b.usd),
        shares: round(b.shares),
        avgPrice: round(b.avgPrice, 4),
        impliedProbability: round(b.avgPrice, 4),
        payoutIfRightUsd: buy ? round(b.shares) : null,
        profitIfRightUsd: buy ? round(b.shares - b.usd) : null,
        fills: b.fresh.length,
        placedAt: new Date(b.firstTs * 1000).toISOString(),
        lastFillAt: new Date(b.lastTs * 1000).toISOString(),
        smartMoney: sm.smart,
        smartMoneyReasons: sm.reasons,
        wallet: t.proxyWallet,
        traderName: tr?.userName || t.name || t.pseudonym || null,
        traderX: tr?.xUsername || null,
        allTimeProfitRank: tr?.allTimeRank ?? null,
        allTimePnlUsd: tr?.allTimePnl ?? null,
        allTimeVolumeUsd: tr?.allTimeVolume ?? null,
        monthProfitRank: tr?.monthRank ?? null,
        monthPnlUsd: tr?.monthPnl ?? null,
        marketUrl: t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : null,
        traderUrl: `https://polymarket.com/profile/${t.proxyWallet}`,
        conditionId: t.conditionId,
        marketSlug: t.slug,
        transactionHashes: [...new Set(b.fresh.map((f) => f.transactionHash))],
        scrapedAt: new Date().toISOString(),
    });
    pushed += 1;
    if (sm.smart) smartCount += 1;
    for (const f of b.fresh) newFills.push(fillKey(f));
    try {
        const r = await Actor.charge({ eventName: sm.smart ? 'smart_money_bet' : 'whale_bet' });
        charged += 1;
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
}

if (onlyNew) {
    // Remember only the fills of bets returned, so they are never returned
    // twice. Fills of a bet still under the threshold are left out on purpose:
    // the next run re-reads the overlap window, and a bet that keeps filling
    // is then measured on its whole size.
    const maxTs = fills.reduce((m, t) => Math.max(m, t.timestamp), state.lastTs || sinceS);
    await store.setValue('STATE', { lastTs: maxTs, fills: [...new Set([...seenFills, ...newFills])].slice(-20000) });
}
await store.setValue('TRADER_CACHE', cache);

if (!pushed && (!onlyNew || !state.lastTs)) {
    await Actor.pushData({
        rowType: 'note',
        note: `No Polymarket bet of $${minUsd.toLocaleString('en-US')} or more${onlySmartMoney ? ' from a top-ranked trader' : ''} `
            + `in the window since ${new Date(sinceS * 1000).toISOString()}. Lower minBetUsd or widen lookbackMinutes. Not charged.`,
    });
}

await Actor.setValue('SUMMARY', { since: new Date(sinceS * 1000).toISOString(), fills: fills.length, bets: pushed, smartMoney: smartCount, charged, leaderboardLookupFailures: lookupFails });
log.info(`Done. ${pushed} bet(s) of $${minUsd}+ (${smartCount} smart money), ${charged} charged.`);
await Actor.exit();
