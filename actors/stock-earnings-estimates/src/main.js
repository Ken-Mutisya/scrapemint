// Stock Earnings Estimates & Results: EPS Forecast vs Actual
//
// What it answers
// ---------------
// Before every quarterly report, analysts publish an expected earnings per
// share. After it, you can see what the company actually earned. This puts both
// sides next to each other for any ticker, and adds whether analysts are
// currently raising or cutting their number.
//
//   summary    one row per ticker: next quarter's consensus, what the last
//              quarter actually delivered against expectations, how often the
//              company has beaten over its last four reports, and the four
//              week revision count (raised vs cut)
//   surprises  one row per reported quarter: actual EPS, the consensus it was
//              measured against, and the percentage difference
//   forecasts  one row per forecast period, quarterly and annual, with the
//              high, low and number of contributing estimates
//
// Two keyless NASDAQ calls per ticker:
//   /api/company/{S}/earnings-surprise    reported quarters
//   /api/analyst/{S}/earnings-forecast    forward estimates + revisions
//
// Source quirks handled (this host lies in specific ways)
// -------------------------------------------------------
//   - 403s without a browser-like User-Agent.
//   - Errors arrive as HTTP 200 with status.rCode 400 and a null data block
//     ("Symbol not exists."), so res.ok never reveals a bad ticker.
//   - Responses intermittently carry a UTF-8 BOM that makes JSON.parse throw.
//   - Under rapid requests it answers 200 with an HTML block page.
//   - Values mix types within one row: eps arrives as a number (1.87) while
//     consensusForecast and percentageSurprise arrive as strings ("1.7", "10",
//     "-23.53"), so everything is coerced rather than trusted.
//
// Pay per event
// -------------
//   earnings_row ($0.005) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_SPACING_MS = 250;
const BASE = 'https://api.nasdaq.com/api';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'summary',
    symbols = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD'],
    minBeatRate = 0,
    onlyRaisedEstimates = false,
    includeAnnual = true,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[$,%\s]/g, '');
    if (s === '' || /^(N\/A|--|UNCH)$/i.test(String(v).trim())) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
// "5/20/2026" -> "2026-05-20"
const isoDate = (v) => {
    const m = String(v ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : clean(v);
};

const theMode = ['summary', 'surprises', 'forecasts'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'summary';
const tickers = [...new Set(asList(symbols).map((s) => s.toUpperCase()))].slice(0, 200);
const beatFloor = Math.max(0, Math.min(100, Number(minBeatRate) || 0));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

if (!tickers.length) {
    log.warning('Provide at least one ticker, e.g. NVDA, TSLA, AAPL.');
    await Actor.exit();
}

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (res.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
            return await getJson(url, attempt + 1);
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 110)}`); return { error: `HTTP ${res.status}` }; }
        const text = (await res.text()).replace(/^﻿/, '');
        if (text.trimStart().startsWith('<')) {
            if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
                return await getJson(url, attempt + 1);
            }
            return { error: 'rate limited (HTML body)' };
        }
        const j = JSON.parse(text);
        const rCode = j?.status?.rCode;
        if (rCode && rCode !== 200) {
            const msg = (j?.status?.bCodeMessage || [])[0]?.errorMessage;
            return { error: msg || `API code ${rCode}` };
        }
        if (!j?.data) return { error: 'no data published' };
        return { data: j.data };
    } catch (err) {
        return { error: err?.message || 'request failed' };
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'earnings_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

function parseSurprises(data) {
    const rows = data?.earningsSurpriseTable?.rows || [];
    return rows.map((r) => {
        const eps = num(r.eps);
        const consensus = num(r.consensusForecast);
        const pct = num(r.percentageSurprise);
        // Prefer the arithmetic over the published percentage where both
        // exist, then fall back, so a missing field never voids the verdict.
        const beat = eps != null && consensus != null ? eps > consensus : pct != null ? pct > 0 : null;
        const missed = eps != null && consensus != null ? eps < consensus : pct != null ? pct < 0 : null;
        return {
            fiscalQuarterEnd: clean(r.fiscalQtrEnd),
            dateReported: isoDate(r.dateReported),
            actualEps: eps,
            consensusEps: consensus,
            surprisePercent: pct,
            surpriseAmount: eps != null && consensus != null ? round(eps - consensus, 4) : null,
            result: beat ? 'beat' : missed ? 'miss' : eps != null && consensus != null ? 'inline' : null,
        };
    });
}

function parseForecasts(data, kind) {
    const rows = data?.[kind]?.rows || [];
    return rows.map((r) => ({
        period: kind === 'yearlyForecast' ? 'annual' : 'quarter',
        fiscalPeriodEnd: clean(r.fiscalEnd),
        consensusEps: num(r.consensusEPSForecast),
        highEps: num(r.highEPSForecast),
        lowEps: num(r.lowEPSForecast),
        estimateCount: num(r.noOfEstimates),
        revisionsUp: num(r.up),
        revisionsDown: num(r.down),
    }));
}

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Earnings estimates ${theMode} | ${tickers.join(', ')} | cap ${cap} rows`);

for (const symbol of tickers) {
    if (stopEarly()) break;

    const needSurprise = theMode !== 'forecasts';
    const needForecast = theMode !== 'surprises';

    const sRes = needSurprise ? await getJson(`${BASE}/company/${encodeURIComponent(symbol)}/earnings-surprise`) : { data: null };
    if (needSurprise && needForecast) await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    const fRes = needForecast ? await getJson(`${BASE}/analyst/${encodeURIComponent(symbol)}/earnings-forecast`) : { data: null };

    // A bad ticker fails both calls with the same message; report it once.
    const hardError = (needSurprise && sRes.error && (!needForecast || fRes.error))
        || (!needSurprise && fRes.error);
    if (hardError) {
        const why = sRes.error || fRes.error;
        log.warning(`${symbol}: ${why}`);
        await flushRow({ type: 'note', symbol, found: false, note: `${why}; not charged` }, false);
        continue;
    }

    const surprises = needSurprise && sRes.data ? parseSurprises(sRes.data) : [];
    const quarterly = needForecast && fRes.data ? parseForecasts(fRes.data, 'quarterlyForecast') : [];
    const annual = needForecast && fRes.data ? parseForecasts(fRes.data, 'yearlyForecast') : [];

    if (theMode === 'surprises') {
        if (!surprises.length) {
            await flushRow({ type: 'note', symbol, found: false, note: 'no reported earnings history published for this symbol; not charged' }, false);
            continue;
        }
        for (const s of surprises) {
            if (stopEarly()) break;
            await flushRow({ mode: 'surprises', symbol, ...s, scrapedAt: new Date().toISOString() });
            emitted += 1;
        }
        continue;
    }

    if (theMode === 'forecasts') {
        const all = includeAnnual ? [...quarterly, ...annual] : quarterly;
        if (!all.length) {
            await flushRow({ type: 'note', symbol, found: false, note: 'no analyst forecasts published for this symbol; not charged' }, false);
            continue;
        }
        for (const f of all) {
            if (stopEarly()) break;
            await flushRow({
                mode: 'forecasts', symbol, ...f,
                estimateRange: f.highEps != null && f.lowEps != null ? round(f.highEps - f.lowEps, 4) : null,
                netRevisions: f.revisionsUp != null && f.revisionsDown != null ? f.revisionsUp - f.revisionsDown : null,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
        continue;
    }

    // summary
    if (!surprises.length && !quarterly.length) {
        await flushRow({ type: 'note', symbol, found: false, note: 'no earnings estimates or history published for this symbol; not charged' }, false);
        continue;
    }
    const reported = surprises.filter((s) => s.result);
    const beats = reported.filter((s) => s.result === 'beat').length;
    const misses = reported.filter((s) => s.result === 'miss').length;
    const pcts = surprises.map((s) => s.surprisePercent).filter((v) => v != null);
    const last = surprises[0] || {};
    const next = quarterly[0] || {};
    const nextYear = annual[0] || {};
    const up = next.revisionsUp; const down = next.revisionsDown;

    const beatRate = reported.length ? round((beats / reported.length) * 100, 1) : null;
    if (beatFloor && (beatRate ?? 0) < beatFloor) continue;
    if (onlyRaisedEstimates && !(up != null && down != null && up > down)) continue;

    await flushRow({
        mode: 'summary',
        symbol,
        // What is expected next.
        nextFiscalPeriodEnd: next.fiscalPeriodEnd ?? null,
        nextQuarterConsensusEps: next.consensusEps ?? null,
        nextQuarterHighEps: next.highEps ?? null,
        nextQuarterLowEps: next.lowEps ?? null,
        analystEstimateCount: next.estimateCount ?? null,
        // Whether analysts are getting more or less optimistic, last 4 weeks.
        revisionsUp: up ?? null,
        revisionsDown: down ?? null,
        netRevisions: up != null && down != null ? up - down : null,
        estimatesRising: up != null && down != null ? up > down : null,
        // What actually happened last time.
        lastFiscalQuarterEnd: last.fiscalQuarterEnd ?? null,
        lastDateReported: last.dateReported ?? null,
        lastActualEps: last.actualEps ?? null,
        lastConsensusEps: last.consensusEps ?? null,
        lastSurprisePercent: last.surprisePercent ?? null,
        lastResult: last.result ?? null,
        // The track record.
        quartersReported: reported.length,
        beatCount: beats,
        missCount: misses,
        beatRatePercent: beatRate,
        averageSurprisePercent: pcts.length ? round(pcts.reduce((a, b) => a + b, 0) / pcts.length, 2) : null,
        currentYearConsensusEps: nextYear.consensusEps ?? null,
        currentYearFiscalEnd: nextYear.fiscalPeriodEnd ?? null,
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
