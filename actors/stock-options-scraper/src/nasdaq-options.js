// Option chains from Nasdaq's public quote API (api.nasdaq.com/api/quote/{SYM}/option-chain).
//
// Replaces Cboe's delayed-quotes CDN, which since 2026-11 answers Apify's datacenter
// IPs with a Cloudflare 403. Nasdaq returns the same OPRA bid/ask/last/volume/open
// interest (checked contract by contract against Cboe on 2026-11-20) but no implied
// volatility or greeks, so those are computed here with Black-Scholes from the bid/ask
// mid (no dividend yield). The result is shaped like Cboe's `data` object so the
// actors' downstream code is unchanged.
//
// Limits: stocks and ETFs only. Nasdaq publishes no index option chains (SPX, NDX,
// RUT, VIX ...), so those return { status: 'index' }.
//
// This file is shared by options-max-pain-gamma-exposure, earnings-expected-move and
// stock-options-scraper. Keep the three copies identical.

const API = 'https://api.nasdaq.com/api/quote';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' };
export const INDEX_ROOTS = new Set(['SPX', 'SPXW', 'NDX', 'NDXP', 'RUT', 'VIX', 'XSP', 'DJX', 'OEX', 'XEO', 'MRUT', 'NANOS']);
const YEAR_MS = 365 * 86400000;

const num = (s) => {
    if (s == null) return null;
    const v = Number(String(s).replace(/[$,%+\s]/g, ''));
    return Number.isFinite(v) ? v : null; // '--' and '' become null
};

async function getJson(url, timeoutMs) {
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
            last = res.status;
            if (res.ok) return { json: await res.json(), status: 200 };
            if (res.status < 500 && res.status !== 429) return { json: null, status: res.status };
        } catch (err) {
            last = err?.name === 'AbortError' ? 'timeout' : 'error';
        } finally { clearTimeout(t); }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    return { json: null, status: last };
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), accurate to ~1e-7.
function ncdf(x) {
    const s = x < 0 ? -1 : 1; const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
}
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function bsPrice(call, S, K, T, r, v) {
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / sq; const d2 = d1 - sq;
    return call ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}

// Implied volatility by bisection; null when the price sits at or below intrinsic
// value (no solution) or above the no-arbitrage bound.
export function impliedVol(call, S, K, T, r, price) {
    if (!(S > 0 && K > 0 && T > 0 && price > 0)) return null;
    const intrinsic = call ? Math.max(0, S - K * Math.exp(-r * T)) : Math.max(0, K * Math.exp(-r * T) - S);
    if (price <= intrinsic + 1e-6) return null;
    if (price >= (call ? S : K)) return null;
    let lo = 0.005; let hi = 8;
    if (bsPrice(call, S, K, T, r, hi) < price) return null;
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (bsPrice(call, S, K, T, r, mid) > price) hi = mid; else lo = mid;
        if (hi - lo < 1e-5) break;
    }
    return (lo + hi) / 2;
}

// Greeks in Cboe's units: theta per calendar day, vega and rho per 1 point.
export function greeks(call, S, K, T, r, v) {
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / sq; const d2 = d1 - sq;
    const disc = Math.exp(-r * T);
    const gamma = npdf(d1) / (S * sq);
    const vega = S * npdf(d1) * Math.sqrt(T) / 100;
    const thetaYr = call
        ? -S * npdf(d1) * v / (2 * Math.sqrt(T)) - r * K * disc * ncdf(d2)
        : -S * npdf(d1) * v / (2 * Math.sqrt(T)) + r * K * disc * ncdf(-d2);
    const rho = (call ? K * T * disc * ncdf(d2) : -K * T * disc * ncdf(-d2)) / 100;
    return { delta: call ? ncdf(d1) : ncdf(d1) - 1, gamma, theta: thetaYr / 365, vega, rho };
}

const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const pctChange = (last, chg) => (last != null && chg != null && last - chg > 0 ? r4((chg / (last - chg)) * 100) : null);

// 30-day ATM implied volatility, interpolated in total variance between the
// expiries either side of 30 days (Cboe's iv30 is similar in spirit, not identical).
function atmIv30(options, spot, nowMs) {
    const byExp = new Map();
    for (const o of options) {
        if (o.iv == null) continue;
        const k = o._exp; if (!byExp.has(k)) byExp.set(k, []);
        byExp.get(k).push(o);
    }
    const pts = [];
    for (const [expMs, list] of byExp) {
        const T = (expMs - nowMs) / YEAR_MS; if (T <= 2 / 365) continue;
        let best = null;
        for (const o of list) if (!best || Math.abs(o._strike - spot) < Math.abs(best._strike - spot)) best = o;
        const atm = list.filter((o) => o._strike === best._strike).map((o) => o.iv);
        pts.push({ T, iv: atm.reduce((a, b) => a + b, 0) / atm.length });
    }
    if (!pts.length) return null;
    pts.sort((a, b) => a.T - b.T);
    const T30 = 30 / 365;
    const lo = [...pts].reverse().find((p) => p.T <= T30); const hi = pts.find((p) => p.T >= T30);
    if (!lo) return hi.iv; if (!hi) return lo.iv; if (lo === hi) return lo.iv;
    const w = (T30 - lo.T) / (hi.T - lo.T);
    return Math.sqrt(((1 - w) * lo.iv * lo.iv * lo.T + w * hi.iv * hi.iv * hi.T) / T30);
}

/**
 * Load a full option chain for a stock or ETF.
 * @returns {Promise<{status: number|string, data: object|null, ts: string|null}>}
 *   status 200 with data, 'index' for index roots, 404 for unknown or non-optionable.
 */
export async function fetchNasdaqChain(symbol, { rate = 0.04, maxDays = 1200, timeoutMs = 45000 } = {}) {
    const sym = String(symbol || '').toUpperCase().replace(/^[\^$_]/, '');
    if (INDEX_ROOTS.has(sym)) return { status: 'index', data: null, ts: null };
    const now = Date.now();
    const from = new Date(now).toISOString().slice(0, 10);
    const to = new Date(now + maxDays * 86400000).toISOString().slice(0, 10);

    let rows = null; let cls = null; let lastStatus = 404; let chainJson = null;
    for (const a of ['stocks', 'etf']) {
        const base = `${API}/${encodeURIComponent(sym)}/option-chain?assetclass=${a}&money=all&type=all&fromdate=${from}&todate=${to}`;
        const first = await getJson(`${base}&limit=10000&offset=0`, timeoutMs);
        if (first.status !== 200) { lastStatus = first.status; continue; }
        const got = (first.json?.data?.table?.rows || []).filter((r) => r.strike);
        if (!got.length) continue;
        const total = Number(first.json.data.totalRecord) || got.length;
        // Page only in the rare case a chain exceeds one 10,000-record page.
        for (let off = 10000; off < total && off < 60000; off += 10000) {
            const more = await getJson(`${base}&limit=10000&offset=${off}`, timeoutMs);
            const extra = (more.json?.data?.table?.rows || []).filter((r) => r.strike);
            if (!extra.length) break;
            got.push(...extra);
        }
        rows = got; cls = a; chainJson = first.json; break;
    }
    if (!rows) return { status: lastStatus, data: null, ts: null };

    const info = await getJson(`${API}/${encodeURIComponent(sym)}/info?assetclass=${cls}`, timeoutMs);
    // Outside regular hours primaryData is the extended-hours quote; secondaryData then
    // holds the 16:00 close, which is what option marks are struck against.
    const idata = info.json?.data || {};
    const pd = /closed/i.test(idata.secondaryData?.lastTradeTimestamp || '') && num(idata.secondaryData?.lastSalePrice) != null
        ? idata.secondaryData : (idata.primaryData || {});
    let spot = num(pd.lastSalePrice);
    if (spot == null) spot = num(/\$([\d,.]+)/.exec(chainJson?.data?.lastTrade || '')?.[1]);
    const chg = num(pd.netChange);

    const options = [];
    for (const row of rows) {
        const slug = String(row.drillDownURL || '').split('/').pop();
        const m = /^([a-z0-9.]+?)-+(\d{6})[cp](\d{8})$/i.exec(slug);
        if (!m) continue;
        const root = m[1].toUpperCase().replace(/\./g, ''); const d = m[2]; const k = m[3];
        const expMs = Date.UTC(2000 + Number(d.slice(0, 2)), Number(d.slice(2, 4)) - 1, Number(d.slice(4, 6)));
        const strike = Number(k) / 1000;
        // Options stop trading at the 16:00 ET close (~21:00 UTC); floor at one hour.
        const T = Math.max((expMs + 21 * 3600000 - now) / YEAR_MS, 1 / (365 * 24));
        for (const side of ['c', 'p']) {
            const call = side === 'c';
            const bid = num(row[`${side}_Bid`]); const ask = num(row[`${side}_Ask`]); const last = num(row[`${side}_Last`]);
            const mid = bid != null && ask != null && ask > 0 && bid > 0 ? (bid + ask) / 2 : (ask > 0 ? ask / 2 : last);
            const iv = spot != null && mid != null ? impliedVol(call, spot, strike, T, rate, mid) : null;
            const g = iv != null ? greeks(call, spot, strike, T, rate, iv) : {};
            const lastChg = num(row[`${side}_Change`]);
            options.push({
                option: `${root}${d}${call ? 'C' : 'P'}${k}`,
                bid, ask, last_trade_price: last, change: lastChg, percent_change: pctChange(last, lastChg),
                volume: num(row[`${side}_Volume`]) ?? 0, open_interest: num(row[`${side}_Openinterest`]) ?? 0,
                iv: r4(iv), theo: iv != null ? r4(mid) : null, delta: r4(g.delta), gamma: r4(g.gamma), theta: r4(g.theta), vega: r4(g.vega), rho: r4(g.rho),
                last_trade_time: null,
                _exp: expMs, _strike: strike,
            });
        }
    }
    const iv30 = spot != null ? atmIv30(options, spot, now) : null;
    for (const o of options) { delete o._exp; delete o._strike; }
    const ts = new Date(now).toISOString();
    return {
        status: 200,
        ts,
        data: {
            symbol: sym,
            source: 'nasdaq',
            current_price: spot,
            close: spot,
            prev_day_close: spot != null && chg != null ? r4(spot - chg) : null,
            price_change: chg,
            price_change_percent: num(pd.percentageChange),
            last_trade_time: (pd.lastTradeTimestamp || '').replace(/^Closed at /i, '') || null,
            iv30: iv30 != null ? r4(iv30 * 100) : null,
            iv30_change_percent: null,
            options,
        },
    };
}
