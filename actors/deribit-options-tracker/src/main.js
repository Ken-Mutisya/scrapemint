// Deribit Crypto Options & Derivatives Tracker
//
// Strategy
// --------
// One keyless source: the Deribit public API v2 (deribit.com/api/v2/public),
// the dominant crypto options venue. Three modes over BTC/ETH (and any other
// listed) options:
//   - summary   per-expiry analytics: put/call open-interest and volume ratios,
//               total OI, at-the-money implied vol, strike count (the dashboard
//               options traders read first)
//   - options   the raw option chain: one row per instrument with mark price,
//               implied vol, open interest, volume, strike, expiry, moneyness
//   - dvol      the Deribit volatility index (crypto "VIX") time series
//
// This is a live snapshot feed. Prices are quoted in the base coin; USD values
// are derived from the underlying price on the same response.
//
// Pay per event
// -------------
//   derivatives_row ($0.003) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 30000;
const BASE = 'https://www.deribit.com/api/v2/public';
const UA = 'Scrapemint Deribit Options Tracker (admin@scrapemint.com)';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'summary',
    currencies = ['BTC', 'ETH'],
    optionType = 'both',
    minOpenInterest = 0,
    expiries = [],
    dvolHours = 168,
    dvolResolution = 3600,
    maxRows = 500,
    sortBy = 'open_interest',
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const curList = asList(currencies).map((c) => c.toUpperCase());
if (!curList.length) curList.push('BTC');
const wantType = String(optionType).toLowerCase();
const minOI = Math.max(0, Number(minOpenInterest) || 0);
const expiryFilter = asList(expiries).map((e) => e.toUpperCase());
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));
const theMode = ['summary', 'options', 'dvol'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'summary';

const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseInstrument(name) {
    const parts = String(name).split('-');
    if (parts.length < 4) return null; // not an option (e.g. PERPETUAL/future)
    const [currency, expStr, strike, t] = parts;
    const m = String(expStr).match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    let expiryIso = null; let expiryMs = null;
    if (m && MON[m[2]] != null) {
        const d = new Date(Date.UTC(2000 + Number(m[3]), MON[m[2]], Number(m[1]), 8, 0, 0));
        if (!Number.isNaN(d.getTime())) { expiryIso = d.toISOString(); expiryMs = d.getTime(); }
    }
    return {
        currency,
        expiryStr: expStr,
        expiryIso,
        expiryMs,
        strike: Number(strike),
        type: t === 'C' ? 'call' : t === 'P' ? 'put' : t,
    };
}

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': UA } });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 120)}`); return null; }
        const j = await res.json();
        if (j.error) { log.warning(`API error: ${JSON.stringify(j.error).slice(0, 160)}`); return null; }
        return j.result;
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'derivatives_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const now = Date.now();
const daysTo = (ms) => (ms ? Math.round(((ms - now) / 86400000) * 10) / 10 : null);
const expiryOk = (o) => !expiryFilter.length || (o.expiryStr && expiryFilter.includes(o.expiryStr));

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Deribit ${theMode} | ${curList.join(', ')}${expiryFilter.length ? ` | expiries ${expiryFilter.join(', ')}` : ''}. Cap ${cap} rows.`);

for (const cur of curList) {
    if (stopEarly()) break;

    if (theMode === 'dvol') {
        const end = now;
        const start = now - Math.max(1, Math.min(8760, Number(dvolHours) || 168)) * 3600000;
        const res = Math.max(60, Number(dvolResolution) || 3600);
        const d = await getJson(`${BASE}/get_volatility_index_data?currency=${cur}&start_timestamp=${start}&end_timestamp=${end}&resolution=${res}`);
        const data = d?.data || [];
        for (const point of data) {
            if (stopEarly()) break;
            const [ts, open, high, low, close] = point;
            await flushRow({
                mode: 'dvol', currency: cur, timestamp: new Date(ts).toISOString(),
                dvolOpen: num(open), dvolHigh: num(high), dvolLow: num(low), dvolClose: num(close),
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
        continue;
    }

    // options + summary both start from the book summary of all option instruments.
    const book = await getJson(`${BASE}/get_book_summary_by_currency?currency=${cur}&kind=option`);
    if (!book) continue;
    const opts = [];
    for (const b of book) {
        const p = parseInstrument(b.instrument_name);
        if (!p || (p.type !== 'call' && p.type !== 'put')) continue;
        if (!expiryOk(p)) continue;
        const oi = num(b.open_interest) ?? 0;
        if (minOI && oi < minOI) continue;
        opts.push({ ...b, ...p, oi });
    }

    if (theMode === 'options') {
        if (wantType === 'call' || wantType === 'put') {
            for (let i = opts.length - 1; i >= 0; i--) if (opts[i].type !== wantType) opts.splice(i, 1);
        }
        const key = sortBy === 'volume' ? 'volume_usd' : sortBy === 'mark_iv' ? 'mark_iv' : 'open_interest';
        opts.sort((a, b) => (num(b[key]) ?? 0) - (num(a[key]) ?? 0));
        for (const o of opts) {
            if (stopEarly()) break;
            const underlying = num(o.underlying_price);
            await flushRow({
                mode: 'options',
                currency: cur,
                instrument: clean(o.instrument_name),
                optionType: o.type,
                strike: o.strike,
                expiry: o.expiryIso,
                daysToExpiry: daysTo(o.expiryMs),
                markPrice: num(o.mark_price),
                markPriceUsd: underlying != null && o.mark_price != null ? Math.round(o.mark_price * underlying * 100) / 100 : null,
                markIv: num(o.mark_iv),
                openInterest: o.oi,
                openInterestUsd: underlying != null ? Math.round(o.oi * underlying) : null,
                volume: num(o.volume),
                volumeUsd: num(o.volume_usd),
                bidPrice: num(o.bid_price),
                askPrice: num(o.ask_price),
                midPrice: num(o.mid_price),
                underlyingPrice: underlying,
                moneyness: underlying ? Math.round((o.strike / underlying) * 1000) / 1000 : null,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
        continue;
    }

    // summary: aggregate per expiry.
    const byExpiry = new Map();
    for (const o of opts) {
        const k = o.expiryStr;
        if (!byExpiry.has(k)) byExpiry.set(k, { expiryStr: k, expiryIso: o.expiryIso, expiryMs: o.expiryMs, underlying: num(o.underlying_price), callOI: 0, putOI: 0, callVolUsd: 0, putVolUsd: 0, strikes: new Set(), atmDiff: Infinity, atmIv: null });
        const g = byExpiry.get(k);
        g.strikes.add(o.strike);
        if (g.underlying == null) g.underlying = num(o.underlying_price);
        if (o.type === 'call') { g.callOI += o.oi; g.callVolUsd += num(o.volume_usd) ?? 0; }
        else { g.putOI += o.oi; g.putVolUsd += num(o.volume_usd) ?? 0; }
        const diff = g.underlying != null ? Math.abs(o.strike - g.underlying) : Infinity;
        if (o.mark_iv != null && diff < g.atmDiff) { g.atmDiff = diff; g.atmIv = num(o.mark_iv); }
    }
    const groups = [...byExpiry.values()].sort((a, b) => (a.expiryMs ?? 0) - (b.expiryMs ?? 0));
    for (const g of groups) {
        if (stopEarly()) break;
        const totalOI = Math.round((g.callOI + g.putOI) * 100) / 100;
        await flushRow({
            mode: 'summary',
            currency: cur,
            expiry: g.expiryIso,
            expiryLabel: g.expiryStr,
            daysToExpiry: daysTo(g.expiryMs),
            underlyingPrice: g.underlying,
            atmIv: g.atmIv,
            callOpenInterest: Math.round(g.callOI * 100) / 100,
            putOpenInterest: Math.round(g.putOI * 100) / 100,
            totalOpenInterest: totalOI,
            putCallOiRatio: g.callOI > 0 ? Math.round((g.putOI / g.callOI) * 1000) / 1000 : null,
            callVolumeUsd: Math.round(g.callVolUsd),
            putVolumeUsd: Math.round(g.putVolUsd),
            putCallVolumeRatio: g.callVolUsd > 0 ? Math.round((g.putVolUsd / g.callVolUsd) * 1000) / 1000 : null,
            strikeCount: g.strikes.size,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
