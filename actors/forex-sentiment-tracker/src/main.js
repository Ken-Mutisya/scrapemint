// Forex Sentiment Tracker: retail long/short ratios from 9+ brokers
//
// Strategy
// --------
// FXSSI aggregates retail positioning from Myfxbook, OANDA, Dukascopy, IG,
// FX Blue, XM, InstaForex, FIBO Group, AMarkets and its own users, and serves
// the latest snapshot as JSON without a key:
//   fxssi.com/api/current-ratios   per broker, per symbol: % of traders long
// (verified against the site's renderer: the bar it labels "buy" is the raw
// value; its signal is contrarian, sell when most traders are long).
// We return one row per symbol with the average and per-broker long %, the
// broker spread, a contrarian signal at a chosen threshold and, by keeping the
// previous snapshot in a named key-value store, the change since the last run.
//
// Pay per event
// -------------
//   symbol ($0.002) one symbol row (or one broker row in per-broker mode).
//   The first FREE_TIER_ROWS rows of every run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const URL = 'https://fxssi.com/api/current-ratios';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROKERS = {
    myfxbook: 'Myfxbook', ftroanda: 'OANDA', dukscopy: 'Dukascopy', fxcm: 'IG', fxblue: 'FX Blue', xm: 'XM',
    instfor: 'InstaForex', fiboforx: 'FIBO Group', amarkets: 'AMarkets', fxssi: 'FXSSI',
};
const STORE = 'scrapemint-forex-sentiment-history';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    brokers = [],
    signalThreshold = 60,
    output = 'symbols',
    trackChanges = true,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const num = (v) => { if (v === undefined || v === null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const symbolFilter = new Set(arr(symbols).map((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')));
const brokerName = (k) => BROKERS[k] || k;
const brokerFilter = new Set(arr(brokers).map((b) => b.toLowerCase().replace(/\s+/g, '')));
const brokerOk = (k) => !brokerFilter.size || brokerFilter.has(k) || brokerFilter.has(brokerName(k).toLowerCase().replace(/\s+/g, ''));
const th = Math.max(50, Math.min(95, Number(signalThreshold) || 60));

function assetClass(s) {
    if (/^(BTC|ETH|SOL|XRP|LTC)/.test(s)) return 'crypto';
    if (/^(XAU|XAG|XPT|XPD)/.test(s)) return 'metal';
    if (/^(XTI|XBR|WTI|BRENT)/.test(s)) return 'energy';
    if (/^(US30|NAS100|SP500|GER40|UK100|JPN225|USDX|DXY)/.test(s)) return 'index';
    return 'forex';
}

let data = null;
for (let attempt = 1; attempt <= 3 && !data; attempt++) {
    try {
        const res = await fetch(URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (res.ok) data = await res.json();
        else log.warning(`HTTP ${res.status} (attempt ${attempt})`);
    } catch (err) { log.warning(`${err.message} (attempt ${attempt})`); }
    if (!data) await new Promise((r) => setTimeout(r, 3000 * attempt));
}
if (!data?.pairs) {
    await Actor.pushData({ note: 'The sentiment source did not answer. Try again in a few minutes. Not charged.' });
    await Actor.exit();
}
const snapshotTime = data.formed ? new Date(Number(data.formed) * 1000).toISOString() : null;

// Previous snapshot for change tracking. Opening a named store can fail under
// limited permissions; tracking is then skipped, never the run.
let store = null; let prev = null;
if (trackChanges) {
    try { store = await Actor.openKeyValueStore(STORE); prev = await store.getValue('LAST'); } catch (err) { log.warning(`Change tracking off: ${err.message}`); store = null; }
}

const rows = [];
const current = {};
for (const [sym, byBroker] of Object.entries(data.pairs)) {
    if (symbolFilter.size && !symbolFilter.has(sym)) continue;
    const per = {};
    for (const [b, v] of Object.entries(byBroker)) {
        if (b === 'average' || !brokerOk(b)) continue;
        const x = num(v);
        if (x === null || x <= 0 || x >= 100) continue; // 0/100 = broker has no live data for this symbol
        per[brokerName(b)] = r2(x);
    }
    const vals = Object.values(per);
    if (!vals.length) continue;
    const avg = !brokerFilter.size && num(byBroker.average) !== null ? r2(num(byBroker.average)) : r2(vals.reduce((a, b) => a + b, 0) / vals.length);
    // Compare against the last DIFFERENT snapshot: a rerun inside the same source
    // update window compares to the snapshot before it, not to itself.
    const e = prev?.values?.[sym] ?? null;
    let prevLong = null; let prevTime = null;
    if (e && e.time === snapshotTime) { prevLong = e.prevLongPct ?? null; prevTime = e.prevTime ?? null; current[sym] = e; }
    else {
        if (e) { prevLong = e.longPct ?? null; prevTime = e.time ?? null; }
        current[sym] = { longPct: avg, time: snapshotTime, prevLongPct: prevLong, prevTime };
    }
    const prevEntry = { time: prevTime };
    const signal = avg >= th ? 'sell' : avg <= 100 - th ? 'buy' : 'neutral';
    rows.push({
        symbol: sym,
        assetClass: assetClass(sym),
        longPct: avg,
        shortPct: r2(100 - avg),
        crowd: avg > 50 ? 'long' : avg < 50 ? 'short' : 'flat',
        contrarianSignal: signal,
        signalThresholdPct: th,
        brokerCount: vals.length,
        brokersLong: vals.filter((v) => v > 50).length,
        brokersShort: vals.filter((v) => v < 50).length,
        minLongPct: r2(Math.min(...vals)),
        maxLongPct: r2(Math.max(...vals)),
        longPctByBroker: per,
        popularity: num(data.pair_weights?.[sym]),
        previousLongPct: prevLong,
        longPctChange: prevLong !== null ? r2(avg - prevLong) : null,
        previousSnapshotTime: prevLong !== null ? prevEntry.time : null,
        snapshotTime,
        source: 'FXSSI aggregate (Myfxbook, OANDA, Dukascopy, FX Blue, XM, InstaForex, FIBO Group, AMarkets, FXSSI)',
    });
}
rows.sort((a, b) => Math.abs(b.longPct - 50) - Math.abs(a.longPct - 50) || a.symbol.localeCompare(b.symbol));

let out = rows;
if (output === 'brokers') {
    out = rows.flatMap((r) => Object.entries(r.longPctByBroker).map(([broker, longPct]) => ({
        symbol: r.symbol, assetClass: r.assetClass, broker, longPct, shortPct: r2(100 - longPct),
        averageLongPct: r.longPct, differenceFromAveragePct: r2(longPct - r.longPct), snapshotTime,
    })));
}

let pushed = 0;
for (const row of out) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'symbol' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
if (!pushed) await Actor.pushData({ note: `No symbols matched. Available: ${Object.keys(data.pairs).join(', ')}. Not charged.` });
// Only broker-unfiltered averages are stored, merged with symbols this run did not ask for.
if (store && Object.keys(current).length && !brokerFilter.size) {
    try { await store.setValue('LAST', { snapshotTime, values: { ...(prev?.values || {}), ...current } }); } catch (err) { log.warning(`Could not save snapshot: ${err.message}`); }
}
await Actor.setValue('SUMMARY', { snapshotTime, symbols: rows.length, returned: pushed, signals: rows.filter((r) => r.contrarianSignal !== 'neutral').map((r) => `${r.symbol} ${r.contrarianSignal}`) });
log.info(`Done. ${pushed} rows, snapshot ${snapshotTime}.`);
await Actor.exit();
