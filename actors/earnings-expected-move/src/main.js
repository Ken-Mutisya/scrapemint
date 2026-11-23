// Earnings Expected Move (Options-Implied)
//
// Strategy
// --------
// 1. Earnings dates come from Nasdaq's keyless earnings calendar JSON
//    (/api/calendar/earnings?date=YYYY-MM-DD): symbol, company, report time
//    (pre-market / after-hours), market cap, EPS forecast.
// 2. For each company, one GET to Cboe's free delayed option chain. We take
//    the first expiry that captures the earnings reaction (on or after the
//    report day for pre-market reports, strictly after it otherwise) and price
//    the at-the-money straddle: call + put at the strike nearest the stock.
//    Straddle / price = the market's expected move, the number options traders
//    quote before earnings.
// 3. The ATM implied volatility of that expiry vs. the next one gives an IV
//    crush estimate (how much vol is priced to drop after the report).
// Quotes are ~15 minutes delayed. No API key, no browser. Cboe calls go through Apify datacenter proxy (cboe-fetch.js).
//
// Pay per event
// -------------
//   expected_move ($0.006) per company with a priced straddle. Companies
//   without listed options, unknown symbols and notes are free. There is no per-run
//   free allowance (scheduled runs are the main use).

import { Actor, log } from 'apify';
import { cboeFetch } from './cboe-fetch.js';

const FREE_TIER_ROWS = 0;
const NASDAQ = 'https://api.nasdaq.com/api/calendar/earnings';
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const FETCH_TIMEOUT_MS = 45000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' };
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    daysAhead = 7,
    minMarketCapUsd = 10000000000,
    maxCompanies = 40,
    sortBy = 'expectedMovePct',
} = input;

const ahead = Math.max(0, Math.min(60, Number.isFinite(Number(daysAhead)) ? Number(daysAhead) : 7));
const minCap = Math.max(0, Number(minMarketCapUsd) || 0);
const maxCo = Math.max(1, Math.min(500, Number(maxCompanies) || 40));
const wanted = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(/[\s,]+/))
    .map((s) => String(s || '').trim().toUpperCase()).filter((s) => /^[A-Z0-9.]{1,10}$/.test(s)))];

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const money = (s) => { const n = Number(String(s ?? '').replace(/[$,()]/g, '')); return Number.isFinite(n) && String(s ?? '').trim() !== '' && s !== 'N/A' ? (String(s).includes('(') ? -n : n) : null; };
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = url.includes('cboe.com')
            ? await cboeFetch(url, { signal: ctrl.signal, headers: HEADERS })
            : await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: HEADERS });
        if (!res.ok) return { status: res.status };
        return { status: 200, json: await res.json() };
    } catch (err) { return { status: err?.name === 'AbortError' ? 'timeout' : 'error' }; } finally { clearTimeout(t); }
}

// 1. Collect earnings events over the window (US trading days only).
const now = new Date();
const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const lookahead = wanted.length ? Math.max(ahead, 45) : ahead;
const events = [];
const found = new Set();
for (let i = 0; i <= lookahead; i++) {
    if (pastDeadline()) break;
    const ms = todayUtc + i * 86400000;
    const dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const date = iso(ms);
    const r = await getJson(`${NASDAQ}?date=${date}`);
    const rows = r.json?.data?.rows || [];
    for (const row of rows) {
        const sym = String(row.symbol || '').toUpperCase();
        if (!sym || found.has(sym)) continue;
        if (wanted.length && !wanted.includes(sym)) continue;
        const cap = money(row.marketCap);
        if (!wanted.length && (cap == null || cap < minCap)) continue;
        found.add(sym);
        const time = String(row.time || '');
        events.push({
            symbol: sym,
            company: row.name || null,
            earningsDate: date,
            earningsMs: ms,
            reportTime: time.includes('pre') ? 'pre-market' : time.includes('after') ? 'after-hours' : 'not supplied',
            marketCapUsd: cap,
            fiscalQuarterEnding: row.fiscalQuarterEnding || null,
            epsForecast: money(row.epsForecast),
            numberOfEstimates: Number(row.noOfEsts) || null,
            lastYearReportDate: row.lastYearRptDt || null,
            lastYearEps: money(row.lastYearEPS),
        });
    }
    if (wanted.length && found.size === wanted.length) break;
    await new Promise((res) => setTimeout(res, 150));
}
for (const s of wanted) if (!found.has(s)) await Actor.pushData({ symbol: s, note: `No earnings date found in the next ${lookahead} days. Not charged.` });
// Over the cap, keep the largest companies (the ones most traders watch).
const queue = [...events].sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0)).slice(0, maxCo);
log.info(`${events.length} earnings events found; pricing ${queue.length}.`);
if (!queue.length) {
    if (!wanted.length) await Actor.pushData({ note: `No companies with market cap >= $${minCap.toLocaleString('en-US')} report in the next ${ahead} days. Lower minMarketCapUsd or raise daysAhead.` });
    await Actor.exit();
}

function parseOcc(code) {
    const m = /^([A-Z0-9.]+?)(\d{6})([CP])(\d{8})$/.exec(code);
    if (!m) return null;
    const d = m[2];
    const y = 2000 + Number(d.slice(0, 2));
    return { root: m[1], expiry: `${y}-${d.slice(2, 4)}-${d.slice(4, 6)}`, expiryMs: Date.UTC(y, Number(d.slice(2, 4)) - 1, Number(d.slice(4, 6))), call: m[3] === 'C', strike: Number(m[4]) / 1000 };
}
const price = (o) => {
    const bid = Number(o.bid) || 0; const ask = Number(o.ask) || 0;
    if (bid > 0 && ask > 0 && ask >= bid) return { p: (bid + ask) / 2, src: 'mid' };
    if (Number(o.theo) > 0) return { p: Number(o.theo), src: 'theoretical' };
    if (Number(o.last_trade_price) > 0) return { p: Number(o.last_trade_price), src: 'last' };
    return { p: null, src: null };
};

function atm(contracts, spot, expiry) {
    const cs = contracts.filter((c) => c.expiry === expiry);
    const strikes = [...new Set(cs.map((c) => c.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    for (const k of strikes.slice(0, 3)) {
        const call = cs.find((c) => c.call && c.strike === k);
        const put = cs.find((c) => !c.call && c.strike === k);
        if (!call || !put) continue;
        const cp = price(call.raw); const pp = price(put.raw);
        if (cp.p == null || pp.p == null) continue;
        const ivs = [Number(call.raw.iv), Number(put.raw.iv)].filter((v) => v > 0);
        return { strike: k, call: cp.p, put: pp.p, priceSource: cp.src === 'mid' && pp.src === 'mid' ? 'mid' : cp.src === pp.src ? cp.src : 'mixed', iv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null, volume: (Number(call.raw.volume) || 0) + (Number(put.raw.volume) || 0), openInterest: (Number(call.raw.open_interest) || 0) + (Number(put.raw.open_interest) || 0) };
    }
    return null;
}

let charged = 0;
const out = [];
for (const ev of queue) {
    if (pastDeadline()) { log.warning('Approaching run timeout; stopping early.'); break; }
    const r = await getJson(`${CBOE}/${encodeURIComponent(ev.symbol)}.json`);
    const data = r.json?.data;
    if (!data?.options?.length) { out.push({ ...ev, earningsMs: undefined, note: r.status === 403 ? 'No listed options for this symbol. Not charged.' : `Could not load options (${r.status}). Not charged.`, charge: false }); continue; }
    const spot = Number(data.current_price) || Number(data.close) || null;
    // Standard contracts only: adjusted ones (e.g. TSLA1) have non-100-share deliverables.
    const contracts = data.options.map((o) => { const p = parseOcc(o.option); return p && p.root === ev.symbol.replace('.', '') ? { ...p, raw: o } : null; }).filter(Boolean);
    // Reaction day: report day if pre-market, else the next weekday.
    let reactMs = ev.earningsMs;
    if (ev.reportTime !== 'pre-market') { reactMs += 86400000; while ([0, 6].includes(new Date(reactMs).getUTCDay())) reactMs += 86400000; }
    const expiries = [...new Set(contracts.filter((c) => c.expiryMs >= reactMs).map((c) => c.expiry))].sort();
    if (!spot || !expiries.length) { out.push({ ...ev, earningsMs: undefined, note: 'No option expiry after the report date. Not charged.', charge: false }); continue; }
    const front = atm(contracts, spot, expiries[0]);
    if (!front) { out.push({ ...ev, earningsMs: undefined, note: 'No priced at-the-money straddle. Not charged.', charge: false }); continue; }
    const back = expiries[1] ? atm(contracts, spot, expiries[1]) : null;
    const straddle = front.call + front.put;
    const dte = Math.round((Date.parse(expiries[0]) - todayUtc) / 86400000);
    out.push({
        ...ev,
        earningsMs: undefined,
        stockPrice: round(spot),
        stockChangePct: round(Number(data.price_change_percent)),
        expiry: expiries[0],
        daysToExpiry: dte,
        atmStrike: front.strike,
        callPrice: round(front.call),
        putPrice: round(front.put),
        straddlePrice: round(straddle),
        priceSource: front.priceSource,
        expectedMoveUsd: round(straddle),
        expectedMovePct: round((straddle / spot) * 100),
        expectedRangeLow: round(spot - straddle),
        expectedRangeHigh: round(spot + straddle),
        frontAtmIv: round(front.iv, 4),
        backExpiry: expiries[1] || null,
        backAtmIv: round(back?.iv, 4),
        ivCrushEstimatePct: front.iv && back?.iv ? round((1 - back.iv / front.iv) * 100, 1) : null,
        iv30: round(Number(data.iv30)),
        straddleVolume: front.volume,
        straddleOpenInterest: front.openInterest,
        quoteTime: data.last_trade_time || r.json.timestamp || null,
        computedAt: new Date().toISOString(),
        charge: true,
    });
}

const key = ['expectedMovePct', 'earningsDate', 'marketCapUsd'].includes(sortBy) ? sortBy : 'expectedMovePct';
out.sort((a, b) => {
    if (a.charge !== b.charge) return a.charge ? -1 : 1;
    if (key === 'earningsDate') return String(a.earningsDate).localeCompare(String(b.earningsDate));
    return (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
});
for (const row of out) {
    const { charge, ...clean } = row;
    await Actor.pushData(clean);
    if (charge) {
        charged += 1;
        if (charged > FREE_TIER_ROWS) {
            try { await Actor.charge({ eventName: 'expected_move' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
        }
    }
}
await Actor.setValue('SUMMARY', { events: events.length, priced: charged, notes: out.length - charged, window: { from: iso(todayUtc), days: lookahead } });
log.info(`Done. ${charged} priced, ${out.length - charged} notes.`);
await Actor.exit();
