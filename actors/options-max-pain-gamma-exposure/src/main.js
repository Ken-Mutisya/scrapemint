// Options Max Pain & Gamma Exposure (GEX)
//
// Strategy
// --------
// One GET per symbol to Cboe's free delayed-quotes JSON (the same feed the
// cboe.com option chain page uses, ~15 min delayed). From the full chain we
// compute, per expiry and across all selected expiries:
//   - Max pain: the strike where option holders' total intrinsic value at
//     expiry is lowest (sum of call OI x max(0, K - k) + put OI x max(0, k - K)).
//   - Gamma exposure (GEX) in USD per 1% move, dealer convention: calls add
//     gamma x OI x 100 x spot^2 x 1%, puts subtract it.
//   - Gamma flip: the spot level where net GEX crosses zero, found by
//     re-pricing Black-Scholes gamma for every contract at spot levels from
//     -20% to +20%.
//   - Call wall / put wall: strikes with the largest call and put GEX.
//   - Put/call ratios on open interest and volume.
// No API key, no browser. Cboe calls go through Apify datacenter proxy (cboe-fetch.js).
//
// Source quirks: index chains live under an underscore prefix (_SPX, _NDX,
// _RUT, _VIX). Unknown symbols return 403, which here means "no chain".
//
// Pay per event
// -------------
//   symbol_analyzed ($0.006) per symbol with a chain. Unknown symbols and
//   invalid inputs are free. Scheduled runs are the main use, so there is no per-run free allowance.

import { Actor, log } from 'apify';
import { cboeFetch } from './cboe-fetch.js';

const FREE_TIER_SYMBOLS = 0;
const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';
const FETCH_TIMEOUT_MS = 45000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const INDEXES = new Set(['SPX', 'SPXW', 'NDX', 'RUT', 'VIX', 'XSP', 'DJX', 'OEX', 'XEO', 'MRUT', 'NANOS']);
const RATE = 0.04;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    symbols = ['SPY', 'QQQ', 'SPX', 'TSLA', 'NVDA'],
    maxDaysToExpiry = 60,
    maxExpiries = 6,
    includeExpiryRows = true,
    strikeRangePercent = 25,
    topStrikes = 10,
} = input;

const symList = [...new Set((Array.isArray(symbols) ? symbols : String(symbols || '').split(/[\s,]+/))
    .map((s) => String(s || '').trim().toUpperCase().replace(/^[\^$_]/, '')).filter((s) => /^[A-Z0-9.]{1,10}$/.test(s)))].slice(0, 500);
if (!symList.length) {
    await Actor.pushData({ note: 'No valid symbols in input. Example: SPY, SPX, TSLA' });
    await Actor.exit();
}
const dteCap = Number.isFinite(Number(maxDaysToExpiry)) ? Math.max(0, Math.min(1000, Number(maxDaysToExpiry))) : 60;
const expCap = Math.max(1, Math.min(60, Number(maxExpiries) || 6));
const band = Math.max(1, Math.min(100, Number(strikeRangePercent) || 25)) / 100;
const topN = Math.max(1, Math.min(50, Number(topStrikes) || 10));

const now = new Date();
const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function parseOcc(code) {
    const m = /^([A-Z0-9.]+?)(\d{6})([CP])(\d{8})$/.exec(code);
    if (!m) return null;
    const [, root, d, t, k] = m;
    const y = 2000 + Number(d.slice(0, 2)); const mo = Number(d.slice(2, 4)); const da = Number(d.slice(4, 6));
    const ms = Date.UTC(y, mo - 1, da);
    return { root, expiry: `${y}-${d.slice(2, 4)}-${d.slice(4, 6)}`, expiryMs: ms, dte: Math.round((ms - todayUtc) / 86400000), call: t === 'C', strike: Number(k) / 1000 };
}

async function getChain(sym) {
    const attempts = INDEXES.has(sym) ? [`_${sym}`] : [sym, `_${sym}`];
    let last = null;
    for (const c of attempts) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await cboeFetch(`${BASE}/${encodeURIComponent(c)}.json`, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': UA } });
            last = res.status;
            if (res.ok) { const j = await res.json(); if (j?.data?.options?.length) return { data: j.data, ts: j.timestamp }; last = 'empty'; }
        } catch (err) { last = err?.name === 'AbortError' ? 'timeout' : 'error'; } finally { clearTimeout(t); }
    }
    return { data: null, status: last };
}

const SQRT2PI = Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, iv) {
    if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
    const st = iv * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (RATE + 0.5 * iv * iv) * T) / st;
    return Math.exp(-0.5 * d1 * d1) / SQRT2PI / (S * st);
}

function analyse(contracts, spot) {
    let callOi = 0; let putOi = 0; let callVol = 0; let putVol = 0; let callGex = 0; let putGex = 0;
    const perStrike = new Map();
    for (const c of contracts) {
        const oi = c.oi; const g = c.gamma > 0 ? c.gamma : bsGamma(spot, c.strike, c.T, c.iv);
        const gex = g * oi * 100 * spot * spot * 0.01;
        const s = perStrike.get(c.strike) || { strike: c.strike, callOi: 0, putOi: 0, callGex: 0, putGex: 0 };
        if (c.call) { callOi += oi; callVol += c.vol; callGex += gex; s.callOi += oi; s.callGex += gex; } else { putOi += oi; putVol += c.vol; putGex -= gex; s.putOi += oi; s.putGex -= gex; }
        perStrike.set(c.strike, s);
    }
    const strikes = [...perStrike.values()].sort((a, b) => a.strike - b.strike);
    // Max pain over strikes within the band (outside it the answer never lands).
    let maxPain = null; let best = Infinity;
    for (const k of strikes) {
        let pay = 0;
        for (const s of strikes) {
            if (s.strike < k.strike) pay += s.callOi * (k.strike - s.strike);
            else if (s.strike > k.strike) pay += s.putOi * (s.strike - k.strike);
        }
        if (pay < best) { best = pay; maxPain = k.strike; }
    }
    const inBand = strikes.filter((s) => Math.abs(s.strike / spot - 1) <= band);
    const callWall = inBand.reduce((a, s) => (!a || s.callGex > a.callGex ? s : a), null);
    const putWall = inBand.reduce((a, s) => (!a || s.putGex < a.putGex ? s : a), null);
    // Gamma flip: net GEX at hypothetical spot levels, BS gamma re-priced.
    let flip = null;
    const steps = [];
    for (let p = -0.2; p <= 0.2001; p += 0.0025) steps.push(spot * (1 + p));
    let prev = null;
    for (const S of steps) {
        let net = 0;
        for (const c of contracts) {
            if (!(c.oi > 0)) continue;
            const g = bsGamma(S, c.strike, c.T, c.iv);
            net += (c.call ? 1 : -1) * g * c.oi * 100 * S * S * 0.01;
        }
        if (prev && Math.sign(prev.net) !== Math.sign(net) && net !== 0) {
            const x = prev.S + (S - prev.S) * (0 - prev.net) / (net - prev.net);
            if (flip == null || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
        }
        prev = { S, net };
    }
    const net = callGex + putGex;
    return {
        maxPain,
        maxPainDistancePct: maxPain != null ? round((maxPain / spot - 1) * 100) : null,
        callOpenInterest: callOi,
        putOpenInterest: putOi,
        putCallOiRatio: callOi > 0 ? round(putOi / callOi, 3) : null,
        callVolume: callVol,
        putVolume: putVol,
        putCallVolumeRatio: callVol > 0 ? round(putVol / callVol, 3) : null,
        netGex: Math.round(net),
        callGex: Math.round(callGex),
        putGex: Math.round(putGex),
        gexRegime: net >= 0 ? 'positive' : 'negative',
        gammaFlip: round(flip),
        gammaFlipDistancePct: flip != null ? round((flip / spot - 1) * 100) : null,
        spotVsFlip: flip == null ? null : spot >= flip ? 'above' : 'below',
        callWall: callWall?.callGex > 0 ? callWall.strike : null,
        putWall: putWall?.putGex < 0 ? putWall.strike : null,
        topGexStrikes: inBand.map((s) => ({ strike: s.strike, netGex: Math.round(s.callGex + s.putGex), callGex: Math.round(s.callGex), putGex: Math.round(s.putGex), callOi: s.callOi, putOi: s.putOi }))
            .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex)).slice(0, topN),
    };
}

let charged = 0;
const stats = { symbols: symList.length, analysed: 0, noChain: 0, rows: 0 };
for (const sym of symList) {
    if (pastDeadline()) { log.warning('Approaching run timeout; stopping early.'); break; }
    const { data, status, ts } = await getChain(sym);
    if (!data) {
        stats.noChain += 1;
        await Actor.pushData({ symbol: sym, rowType: 'note', note: status === 403 ? 'No option chain for this symbol (unknown or not optionable). Not charged.' : `Could not load the option chain (${status}). Not charged.` });
        continue;
    }
    const spot = Number(data.current_price) || Number(data.close) || null;
    if (!spot) { stats.noChain += 1; await Actor.pushData({ symbol: sym, rowType: 'note', note: 'No underlying price. Not charged.' }); continue; }
    const all = [];
    for (const o of data.options) {
        const p = parseOcc(o.option);
        if (!p || p.dte < 0 || p.dte > dteCap) continue;
        // Standard roots only (SPX + SPXW weeklies); adjusted roots like TSLA1 have odd deliverables.
        if (!(p.root === sym.replace('.', '') || p.root === `${sym}W` || p.root === `${sym}P`)) continue;
        all.push({ ...p, oi: Number(o.open_interest) || 0, vol: Number(o.volume) || 0, gamma: Number(o.gamma) || 0, iv: Number(o.iv) || 0, T: Math.max(p.dte, 0.5) / 365 });
    }
    const expiries = [...new Set(all.map((c) => c.expiry))].sort().slice(0, expCap);
    const chosen = all.filter((c) => expiries.includes(c.expiry));
    if (!chosen.length) {
        stats.noChain += 1;
        await Actor.pushData({ symbol: sym, rowType: 'note', note: `No expiries within ${dteCap} days. Not charged.` });
        continue;
    }
    const common = {
        symbol: sym,
        underlyingPrice: round(spot),
        underlyingChangePct: round(Number(data.price_change_percent)),
        iv30: round(Number(data.iv30)),
        quoteTime: data.last_trade_time || ts || null,
    };
    const agg = analyse(chosen, spot);
    const nearest = analyse(chosen.filter((c) => c.expiry === expiries[0]), spot);
    await Actor.pushData({
        ...common,
        rowType: 'all-expiries',
        expiry: null,
        expiries,
        expiryCount: expiries.length,
        nearestExpiry: expiries[0],
        nearestExpiryMaxPain: nearest.maxPain,
        ...agg,
        maxPain: undefined,
        maxPainDistancePct: undefined,
        allExpiriesMaxPain: agg.maxPain,
        computedAt: new Date().toISOString(),
    });
    stats.rows += 1;
    if (includeExpiryRows) {
        for (const e of expiries) {
            const cs = chosen.filter((c) => c.expiry === e);
            await Actor.pushData({ ...common, rowType: 'expiry', expiry: e, daysToExpiry: cs[0].dte, ...analyse(cs, spot), computedAt: new Date().toISOString() });
            stats.rows += 1;
        }
    }
    stats.analysed += 1;
    charged += 1;
    if (charged > FREE_TIER_SYMBOLS) {
        try { await Actor.charge({ eventName: 'symbol_analyzed' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
    log.info(`${sym}: spot ${spot}, ${expiries.length} expiries, net GEX ${agg.netGex}, flip ${agg.gammaFlip}, max pain (nearest) ${nearest.maxPain}`);
}
await Actor.setValue('SUMMARY', stats);
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
