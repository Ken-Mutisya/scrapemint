// Stock Trading Halts: Why a Stock Is Halted and When It Resumes
//
// What it does
// ------------
// When a ticker freezes mid session, every trader watching it needs three
// facts fast: why it stopped, whether it is still stopped, and what time it
// comes back. The exchange publishes all three and almost nobody reads the
// raw feed, because it arrives as bare codes with no explanation attached.
//
//   halts    one row per halt: the symbol, the reason spelled out, the halt
//            time, the resumption times and how long it has been frozen
//   summary  one row per reason code: how many names it is holding right now
//
// The computed layer
// ------------------
// The source gives a code such as LUDP or T12 and nothing else. Every row
// here carries the official reason title and description, a plain category,
// a status (still halted, resumption scheduled, or resumed), the halt
// duration in minutes, and optionally the last price and percent move, which
// is what tells you whether the stock froze on the way up or the way down.
//
// Coverage note
// -------------
// The feed is a live list, not an archive. It carries the current session's
// halts plus every older halt that has never resumed, some of them months
// old. It cannot be queried by date, so a history is built by scheduling
// this actor with newOnly and letting it collect.
//
// Pay per event
// -------------
//   halt_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const SEEN_MAX = 5000;
const FETCH_TIMEOUT_MS = 30000;
const QUOTE_CONCURRENCY = 3;
const QUOTE_SPACING_MS = 250;
const FEED_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const QUOTE_URL = 'https://api.nasdaq.com/api/quote';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'halts',
    symbols = [],
    reasonCodes = [],
    markets = [],
    todayOnly = true,
    onlyStillHalted = false,
    includeQuote = true,
    newOnly = false,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['halts', 'summary'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'halts';
const wantSymbols = new Set(asList(symbols).map((s) => s.toUpperCase()));
const wantCodes = new Set(asList(reasonCodes).map((s) => s.toUpperCase()));
const wantMarkets = asList(markets).map((s) => s.toLowerCase());
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// The official schedule of halt codes, as published by the exchange. Codes
// that are not on that schedule (the LULD pause codes, IPO and market wide
// circuit breaker codes) are listed separately below. An unrecognised code is
// passed through with a null description rather than a guessed one.
const REASONS = {
    T1: ['Halt - News Pending', 'Trading is halted pending the release of material news.', 'news'],
    T2: ['Halt - News Released', 'The news has begun the dissemination process through a Regulation FD compliant method.', 'news'],
    T3: ['News and Resumption Times', 'The news has been fully disseminated, or the condition that caused the halt is resolved. Two times are published: when quotations may be entered, and when the security is released for trading.', 'news'],
    T5: ['Single Stock Trading Pause in Effect', 'Trading has been paused due to a 10% or more price move in the security in a five minute period.', 'volatility'],
    T6: ['Halt - Extraordinary Market Activity', 'Trading is halted because extraordinary market activity is occurring that is likely to have a material effect on the market for the security, typically caused by the misuse or malfunction of a quotation, reporting or execution system.', 'market_activity'],
    T7: ['Single Stock Trading Pause, Quotation Only Period', 'Quotations have resumed for the security, but trading remains paused.', 'volatility'],
    T8: ['Halt - Exchange Traded Fund', 'Trading is halted in an ETF, taking account of trading in the underlying securities and other unusual conditions.', 'etf'],
    T12: ['Halt - Additional Information Requested', 'Trading is halted pending receipt of additional information requested by the exchange.', 'regulatory'],
    H4: ['Halt - Non-compliance', 'Trading is halted due to the company\'s non-compliance with listing requirements.', 'regulatory'],
    H9: ['Halt - Not Current', 'Trading is halted because the company is not current in its required filings.', 'regulatory'],
    H10: ['Halt - SEC Trading Suspension', 'The Securities and Exchange Commission has suspended trading in this stock.', 'regulatory'],
    H11: ['Halt - Regulatory Concern', 'Trading is halted in conjunction with another exchange or market for regulatory reasons.', 'regulatory'],
    M: ['Volatility Trading Pause', 'Trading has been paused in an exchange listed issue after a price move outside the permitted band.', 'volatility'],
    LUDP: ['Volatility Trading Pause', 'Trading has been paused because the price moved outside the limit up limit down band and did not return within 15 seconds.', 'volatility'],
    LUDS: ['Volatility Trading Pause, Straddle Condition', 'Trading has been paused because the limit up limit down band straddled the market and the condition did not clear.', 'volatility'],
    MWC1: ['Market Wide Circuit Breaker, Level 1', 'Trading is halted market wide after a 7% decline in the S&P 500.', 'market_wide'],
    MWC2: ['Market Wide Circuit Breaker, Level 2', 'Trading is halted market wide after a 13% decline in the S&P 500.', 'market_wide'],
    MWC3: ['Market Wide Circuit Breaker, Level 3', 'Trading is halted market wide for the rest of the session after a 20% decline in the S&P 500.', 'market_wide'],
    MWCQ: ['Market Wide Circuit Breaker, Quotation Resumption', 'Quotations may resume after a market wide circuit breaker halt.', 'market_wide'],
    MWCR: ['Market Wide Circuit Breaker, Trading Resumption', 'Trading may resume after a market wide circuit breaker halt.', 'market_wide'],
    IPO1: ['IPO Issue Not Yet Trading', 'The security has not yet opened for its first day of trading.', 'ipo'],
    IPOQ: ['IPO Security Released for Quotation', 'Quotations may be entered ahead of the first trade.', 'ipo'],
    IPOE: ['IPO Security Positioning Window Extension', 'The window before the first trade has been extended.', 'ipo'],
    D: ['Security Deletion', 'The security has been deleted from the exchange.', 'delisting'],
};

async function getText(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                accept: 'application/json, text/xml, */*',
            },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.text();
    } catch (err) {
        if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            return getText(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 100)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'halt_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Halt and resumption times are published in Eastern time with no offset
// attached, and the offset changes with daylight saving, so it is derived for
// the halt's own date rather than assumed.
function easternOffsetMinutes(y, m, d, hh, mm) {
    const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
    const asEastern = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour) % 24, Number(parts.minute));
    return (utcGuess - asEastern) / 60000;
}

// "07/28/2026" + "10:38:30.240" -> a real instant. A halt that has not been
// given a resumption time carries an EMPTY time against a populated date, so
// a missing time must return null: defaulting it to midnight would invent a
// resumption in the past, mark a still frozen stock as resumed, and report a
// negative halt duration.
function easternToDate(dateStr, timeStr) {
    const d = String(dateStr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!d) return null;
    const [, mo, day, yr] = d.map(Number);
    const t = String(timeStr || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    if (!t) return null;
    const hh = Number(t[1]);
    const mm = Number(t[2]);
    const ss = Number(t[3] || 0);
    const ms = Number(String(t[4] || '0').padEnd(3, '0').slice(0, 3));
    const offset = easternOffsetMinutes(yr, mo, day, hh, mm);
    return new Date(Date.UTC(yr, mo - 1, day, hh, mm, ss, ms) + offset * 60000);
}

function parseFeed(xml) {
    const tag = (chunk, name) => {
        const m = chunk.match(new RegExp(`<ndaq:${name}>([\\s\\S]*?)</ndaq:${name}>`));
        return m ? clean(m[1]) : null;
    };
    return xml.split('<item>').slice(1).map((chunk) => ({
        symbol: (tag(chunk, 'IssueSymbol') || '').toUpperCase() || null,
        companyName: tag(chunk, 'IssueName'),
        market: tag(chunk, 'Market'),
        reasonCode: (tag(chunk, 'ReasonCode') || '').toUpperCase() || null,
        haltDate: tag(chunk, 'HaltDate'),
        haltTime: tag(chunk, 'HaltTime'),
        pauseThresholdPrice: tag(chunk, 'PauseThresholdPrice'),
        resumptionDate: tag(chunk, 'ResumptionDate'),
        resumptionQuoteTime: tag(chunk, 'ResumptionQuoteTime'),
        resumptionTradeTime: tag(chunk, 'ResumptionTradeTime'),
    })).filter((r) => r.symbol);
}

// A name that is paused repeatedly appears once per pause, so each symbol is
// looked up once per run and the result reused across its halts.
const quoteCache = new Map();
async function getQuote(symbol) {
    if (quoteCache.has(symbol)) return quoteCache.get(symbol);
    const q = await fetchQuote(symbol);
    quoteCache.set(symbol, q);
    return q;
}

// The quote endpoint answers with an HTML block page (status 200, body starts
// with "<") when it is hit too quickly, so requests are spaced and a blocked
// response is retried once rather than being recorded as a missing quote.
async function fetchQuote(symbol, assetClass = 'stocks', attempt = 0) {
    const body = await getText(`${QUOTE_URL}/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`);
    if (!body) return null;
    if (body.trimStart().startsWith('<')) {
        if (attempt < 1) { await sleep(1200); return fetchQuote(symbol, assetClass, attempt + 1); }
        return null;
    }
    let json;
    try { json = JSON.parse(body); } catch { return null; }
    const d = json?.data;
    // Exchange traded products answer "Symbol not exists" under the stocks
    // asset class and only resolve under etf. Leveraged ETPs are among the
    // most frequently paused names, so the second try is worth making.
    if (!d) {
        if (assetClass === 'stocks') { await sleep(QUOTE_SPACING_MS); return fetchQuote(symbol, 'etf'); }
        return null;
    }
    const p = d.primaryData || {};
    // The quote endpoint regularly returns an EMPTY change field for a stock
    // that has just come out of a pause, and Number('') is 0, which would
    // report a name that ran 124% as unchanged. Empty stays null.
    const toNum = (v) => {
        const s = String(v ?? '').replace(/[$,%+\s]/g, '');
        if (!s || s === '-' || /^(N\/A|UNCH)$/i.test(s)) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };
    return {
        lastPrice: toNum(p.lastSalePrice),
        netChange: toNum(p.netChange),
        percentChange: toNum(p.percentageChange),
        volume: toNum(p.volume),
        exchange: clean(d.exchange),
        assetClass,
        quoteAsOf: clean(p.lastTradeTimestamp),
    };
}

const feedXml = await getText(FEED_URL);
if (!feedXml) {
    await flushRow({ type: 'note', found: false, note: 'the exchange halt feed could not be read; it is usually a transient outage, try again shortly; not charged' }, false);
    log.error('halt feed unavailable');
    await Actor.exit();
}

const all = parseFeed(feedXml);
log.info(`Halt feed carries ${all.length} entr(ies)`);

const now = Date.now();
// "Today" follows the exchange's own trading day, not the machine's timezone.
const easternToday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const built = all.map((raw) => {
    const [title, description, category] = REASONS[raw.reasonCode] || [];
    const haltedAt = easternToDate(raw.haltDate, raw.haltTime);
    const quoteAt = easternToDate(raw.resumptionDate, raw.resumptionQuoteTime);
    const tradeAt = easternToDate(raw.resumptionDate, raw.resumptionTradeTime);
    const status = tradeAt ? (tradeAt.getTime() <= now ? 'resumed' : 'resumption_scheduled') : 'halted';
    // A resumption earlier than the halt itself means the feed carried times
    // that cannot both be right; report no duration rather than a negative one.
    const durationMs = haltedAt && tradeAt ? tradeAt - haltedAt : null;
    if (durationMs != null && durationMs < 0) log.warning(`${raw.symbol}: resumption time precedes halt time, duration suppressed`);
    const thresholdPrice = raw.pauseThresholdPrice ? Number(String(raw.pauseThresholdPrice).replace(/[$,\s]/g, '')) : null;
    return {
        symbol: raw.symbol,
        companyName: raw.companyName,
        market: raw.market,
        reasonCode: raw.reasonCode,
        reason: title ?? null,
        reasonDescription: description ?? null,
        reasonCategory: category ?? 'other',
        status,
        isHalted: status !== 'resumed',
        haltDate: raw.haltDate,
        haltTime: raw.haltTime,
        haltedAt: haltedAt ? haltedAt.toISOString() : null,
        resumptionDate: raw.resumptionDate,
        resumptionQuoteTime: raw.resumptionQuoteTime,
        resumptionTradeTime: raw.resumptionTradeTime,
        resumesAt: tradeAt ? tradeAt.toISOString() : null,
        quotesResumeAt: quoteAt ? quoteAt.toISOString() : null,
        // How long the pause lasted, or how long it has run so far.
        haltDurationMinutes: durationMs != null && durationMs >= 0 ? round(durationMs / 60000, 2) : null,
        haltedForMinutes: haltedAt && status !== 'resumed' ? round((now - haltedAt) / 60000, 1) : null,
        minutesUntilResumption: tradeAt && tradeAt.getTime() > now ? round((tradeAt - now) / 60000, 1) : null,
        pauseThresholdPrice: Number.isFinite(thresholdPrice) ? thresholdPrice : null,
        isToday: raw.haltDate === easternToday,
        ...(includeQuote ? {
            lastPrice: null, netChange: null, percentChange: null, volume: null,
            exchange: null, assetClass: null, quoteAsOf: null, moveDirection: null,
        } : {}),
        scrapedAt: new Date().toISOString(),
    };
});

const filtered = built.filter((r) => {
    if (todayOnly && !r.isToday) return false;
    if (onlyStillHalted && !r.isHalted) return false;
    if (wantSymbols.size && !wantSymbols.has(r.symbol)) return false;
    if (wantCodes.size && !wantCodes.has(r.reasonCode)) return false;
    if (wantMarkets.length && !wantMarkets.some((m) => String(r.market || '').toLowerCase().includes(m))) return false;
    return true;
});
// Newest halt first, so a capped run keeps what just happened.
filtered.sort((a, b) => String(b.haltedAt).localeCompare(String(a.haltedAt)));

if (theMode === 'summary') {
    const byCode = new Map();
    for (const r of filtered) {
        if (!byCode.has(r.reasonCode)) {
            byCode.set(r.reasonCode, {
                mode: 'summary', reasonCode: r.reasonCode, reason: r.reason, reasonCategory: r.reasonCategory,
                halts: 0, stillHalted: 0, resumed: 0, resumptionScheduled: 0,
                // A single name can be paused several times in a session, so
                // the symbol list is deduped and counted separately from halts.
                symbolSet: new Set(), markets: new Set(), scrapedAt: new Date().toISOString(),
            });
        }
        const s = byCode.get(r.reasonCode);
        s.halts += 1;
        if (r.status === 'resumed') s.resumed += 1;
        else if (r.status === 'resumption_scheduled') s.resumptionScheduled += 1;
        else s.stillHalted += 1;
        s.symbolSet.add(r.symbol);
        if (r.market) s.markets.add(r.market);
    }
    const rows = [...byCode.values()]
        .map((s) => ({
            ...s,
            symbolsAffected: s.symbolSet.size,
            symbols: [...s.symbolSet].slice(0, 25),
            symbolSet: undefined,
            markets: [...s.markets],
            scope: todayOnly ? 'today' : 'full feed',
        }))
        .sort((a, b) => b.halts - a.halts);
    let n = 0;
    for (const row of rows.slice(0, cap)) { await flushRow(row); n += 1; }
    if (!n) {
        await flushRow({ type: 'note', found: false, note: 'no halts matched; the market may be quiet, or clear todayOnly to include older halts that never resumed; not charged' }, false);
    }
    log.info(`Done. ${n} summary row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
    await Actor.exit();
}

const store = newOnly ? await Actor.openKeyValueStore('trading-halts-seen') : null;
const SEEN_KEY = 'seen-halt-keys';
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;

const selected = [];
let skippedSeen = 0;
for (const r of filtered) {
    if (selected.length >= cap) break;
    const key = `${r.symbol}|${r.haltDate}|${r.haltTime}`;
    if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
    if (newOnly) seen.add(key);
    selected.push(r);
}

// Quotes are fetched only for the rows actually being returned, after every
// filter and the row cap, so an unfiltered feed never costs 80 lookups.
if (includeQuote && selected.length) {
    let cursor = 0;
    let got = 0;
    const worker = async () => {
        while (cursor < selected.length) {
            if (deadlineMs && Date.now() > deadlineMs) return;
            const row = selected[cursor];
            cursor += 1;
            const cached = quoteCache.has(row.symbol);
            const q = await getQuote(row.symbol);
            if (!cached) await sleep(QUOTE_SPACING_MS);
            if (q) {
                got += 1;
                Object.assign(row, q);
                if (q.percentChange != null) row.moveDirection = q.percentChange > 0 ? 'up' : (q.percentChange < 0 ? 'down' : 'flat');
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, selected.length) }, worker));
    log.info(`Price lookup: ${got} of ${selected.length} row(s) enriched from ${quoteCache.size} unique symbol lookup(s)`);
}

let emitted = 0;
for (const row of selected) {
    await flushRow({ mode: 'halts', ...row });
    emitted += 1;
}

if (!emitted) {
    // The reason nothing came back matters: an empty feed, a quiet session and
    // a filter that excluded everything are three different answers.
    const todayCount = built.filter((r) => r.isToday).length;
    let note = 'no halts matched the filters; widen the symbol, market or reason filters, or clear onlyStillHalted; not charged';
    if (newOnly && skippedSeen) note = 'no new halts since the last run; not charged';
    else if (!built.length) note = 'the halt feed returned no entries; not charged';
    else if (todayOnly && !todayCount) note = 'no halts on the current trading day; the market may be quiet or closed, clear todayOnly to see halts that are still open from earlier sessions; not charged';
    await flushRow({ type: 'note', found: false, feedEntries: built.length, haltsToday: todayCount, note }, false);
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${emitted} halt row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
