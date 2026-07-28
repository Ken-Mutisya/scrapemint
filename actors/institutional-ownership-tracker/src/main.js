// Institutional Ownership Tracker: Who Owns a Stock, Who Is Buying
//
// Strategy
// --------
// One keyless source: the official NASDAQ institutional holdings endpoint,
// /api/company/{SYMBOL}/institutional-holdings, the same host our stock movers
// and analyst ratings actors already run on. Three modes:
//   summary   one row per ticker: institutional ownership percent, how many
//             holders increased vs decreased, new vs sold-out positions, and
//             the accumulation ratio those imply (the flagship number)
//   holders   one row per institution holding the stock, with shares held,
//             share change, percent change and position value
//   movers    only the institutions that actually moved, biggest buyers and
//             biggest sellers, instead of thousands of unchanged rows
//
// This points the opposite way to our SEC 13F whale tracker. That one starts
// from a filer and lists what they own; this starts from a stock and lists who
// owns it.
//
// Source quirks handled
// ---------------------
//   - The endpoint 403s without a browser-like User-Agent.
//   - An unknown ticker returns HTTP 200 with status.rCode 400 and a null data
//     block ("Symbol not exists."), so HTTP status alone never reveals it.
//   - Responses intermittently carry a UTF-8 BOM (seen on offset=0 variants),
//     which makes JSON.parse throw, so the body is read as text and stripped.
//   - Every value is a formatted string: "78.47%", "2,266,683,275",
//     "$468,840,769". Position value is quoted IN THOUSANDS and is converted to
//     whole dollars here.
//   - Holders report on their own 13F schedule, so reportDate differs from row
//     to row within one stock. That is the filing calendar, not a data gap.
//
// Pay per event
// -------------
//   ownership_row ($0.005) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 50;
const FETCH_TIMEOUT_MS = 30000;
const BASE = 'https://api.nasdaq.com/api/company';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'summary',
    symbols = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL'],
    holdersPerSymbol = 25,
    moversPerSide = 10,
    sortBy = 'marketValue',
    minSharesChange = 0,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
// NASDAQ hands back "$468,840,769", "1.941%", "2,266,683,275", "N/A".
const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[$,%\s]/g, '');
    if (s === '' || /^(N\/A|--|UNCH)$/i.test(String(v).trim())) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
// "12/31/2025" -> "2025-12-31"
const isoDate = (v) => {
    const m = String(v ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return clean(v);
    return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};

const theMode = ['summary', 'holders', 'movers'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'summary';
const tickers = [...new Set(asList(symbols).map((s) => s.toUpperCase()))].slice(0, 100);
const perSymbol = Math.max(1, Math.min(500, Number(holdersPerSymbol) || 25));
const perSide = Math.max(1, Math.min(250, Number(moversPerSide) || 10));
const sortCol = ['marketValue', 'sharesChange', 'sharesHeld'].includes(String(sortBy))
    ? String(sortBy) : 'marketValue';
const changeFloor = Math.max(0, Number(minSharesChange) || 0);
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
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 110)}`); return null; }
        // Some responses ship a UTF-8 BOM, which JSON.parse refuses.
        const text = (await res.text()).replace(/^﻿/, '');
        // Under rapid paging NASDAQ occasionally answers 200 with an HTML block
        // page instead of JSON. That is transient, so back off and retry.
        if (text.trimStart().startsWith('<')) {
            if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
                return await getJson(url, attempt + 1);
            }
            log.warning('HTML body instead of JSON after retries (rate limited)');
            return null;
        }
        return JSON.parse(text);
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

// Returns { data } on success, or { error } describing why there is nothing.
async function fetchOwnership(symbol, { limit, offset = 0, sortColumn, sortOrder = 'DESC' }) {
    const params = new URLSearchParams({ type: 'TOTAL', limit: String(limit) });
    if (offset) params.set('offset', String(offset));
    if (sortColumn) { params.set('sortColumn', sortColumn); params.set('sortOrder', sortOrder); }
    const j = await getJson(`${BASE}/${encodeURIComponent(symbol)}/institutional-holdings?${params}`);
    if (!j) return { error: 'request failed' };
    const rCode = j?.status?.rCode;
    if (rCode && rCode !== 200) {
        const msg = (j?.status?.bCodeMessage || [])[0]?.errorMessage;
        return { error: msg || `API code ${rCode}` };
    }
    if (!j?.data) return { error: 'no ownership data published for this symbol' };
    return { data: j.data };
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'ownership_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// activePositions / newSoldOutPositions are label-keyed tables, e.g.
// { positions: "Increased Positions", holders: "3,241", shares: "2,857,363,844" }
function positionStat(block, label) {
    const row = (block?.rows || []).find((r) => String(r.positions || '').toLowerCase().includes(label));
    return { holders: num(row?.holders), shares: num(row?.shares) };
}

function holderRow(symbol, r) {
    const sharesChange = num(r.sharesChange);
    const valueThousands = num(r.marketValue);
    return {
        symbol,
        ownerName: clean(r.ownerName),
        reportDate: isoDate(r.date),
        sharesHeld: num(r.sharesHeld),
        sharesChange,
        sharesChangePercent: num(r.sharesChangePCT),
        // Header reads "Value (In 1,000s)", so scale to whole dollars.
        positionValueUsd: valueThousands == null ? null : valueThousands * 1000,
        direction: sharesChange == null || sharesChange === 0 ? 'unchanged' : sharesChange > 0 ? 'buyer' : 'seller',
        scrapedAt: new Date().toISOString(),
    };
}

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Institutional ownership ${theMode} | ${tickers.join(', ')} | cap ${cap} rows`);

for (const symbol of tickers) {
    if (stopEarly()) break;

    if (theMode === 'summary') {
        const { data, error } = await fetchOwnership(symbol, { limit: 10 });
        if (error) {
            log.warning(`${symbol}: ${error}`);
            await flushRow({ type: 'note', symbol, found: false, note: `${error}; not charged` }, false);
            continue;
        }
        const os = data.ownershipSummary || {};
        const inc = positionStat(data.activePositions, 'increased');
        const dec = positionStat(data.activePositions, 'decreased');
        const held = positionStat(data.activePositions, 'held');
        const neu = positionStat(data.newSoldOutPositions, 'new');
        const sold = positionStat(data.newSoldOutPositions, 'sold out');
        const ht = data.holdingsTransactions || {};
        const netShares = inc.shares != null && dec.shares != null ? inc.shares - dec.shares : null;
        await flushRow({
            mode: 'summary',
            symbol,
            institutionalOwnershipPercent: num(os.SharesOutstandingPCT?.value),
            sharesOutstandingMillions: num(os.ShareoutstandingTotal?.value),
            // Summary block quotes holdings value in millions.
            totalHoldingsValueUsd: num(os.TotalHoldingsValue?.value) != null
                ? num(os.TotalHoldingsValue.value) * 1e6 : null,
            totalInstitutionalHolders: num(ht.totalRecords),
            totalSharesHeld: num(String(ht.sharesHeld || '').replace(/[^\d]/g, '')) || null,
            increasedHolders: inc.holders,
            increasedShares: inc.shares,
            decreasedHolders: dec.holders,
            decreasedShares: dec.shares,
            unchangedHolders: held.holders,
            newPositionHolders: neu.holders,
            newPositionShares: neu.shares,
            soldOutHolders: sold.holders,
            soldOutShares: sold.shares,
            netSharesChange: netShares,
            // The number the whole row exists for: shares bought per share sold.
            accumulationRatio: inc.shares != null && dec.shares ? round(inc.shares / dec.shares, 3) : null,
            holderAccumulationRatio: inc.holders != null && dec.holders ? round(inc.holders / dec.holders, 3) : null,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
        continue;
    }

    if (theMode === 'movers') {
        // Two cheap sorted pages beat paging the whole holder list to find them.
        const sides = [
            { order: 'DESC', label: 'buyer' },
            { order: 'ASC', label: 'seller' },
        ];
        let any = 0;
        let explained = false;
        for (const side of sides) {
            if (stopEarly()) break;
            const { data, error } = await fetchOwnership(symbol, {
                limit: perSide, sortColumn: 'sharesChange', sortOrder: side.order,
            });
            if (error) {
                log.warning(`${symbol}: ${error}`);
                await flushRow({ type: 'note', symbol, found: false, note: `${error}; not charged` }, false);
                explained = true;
                break;
            }
            for (const r of data.holdingsTransactions?.table?.rows || []) {
                if (stopEarly()) break;
                const row = holderRow(symbol, r);
                if (row.direction !== side.label) continue;
                if (changeFloor && Math.abs(row.sharesChange ?? 0) < changeFloor) continue;
                await flushRow({ mode: 'movers', ...row });
                emitted += 1; any += 1;
            }
        }
        if (!any && !explained) {
            await flushRow({
                type: 'note', symbol, found: false,
                note: 'no institutions moved enough to clear the filters; not charged',
            }, false);
        }
        continue;
    }

    // holders: walk the sorted list in pages until the per-symbol quota is met.
    let collected = 0;
    let offset = 0;
    let noted = false;
    while (collected < perSymbol && !stopEarly()) {
        const limit = Math.min(PAGE_SIZE, perSymbol - collected);
        const { data, error } = await fetchOwnership(symbol, {
            limit, offset, sortColumn: sortCol, sortOrder: 'DESC',
        });
        if (error) {
            log.warning(`${symbol}: ${error}`);
            // Only explain the failure if it left the buyer with nothing; a
            // page that drops after 50 good rows is not worth a note row.
            if (!collected) {
                await flushRow({ type: 'note', symbol, found: false, note: `${error}; not charged` }, false);
                noted = true;
            }
            break;
        }
        const rows = data.holdingsTransactions?.table?.rows || [];
        if (!rows.length) break;
        for (const r of rows) {
            if (stopEarly()) break;
            const row = holderRow(symbol, r);
            if (changeFloor && Math.abs(row.sharesChange ?? 0) < changeFloor) continue;
            await flushRow({ mode: 'holders', ...row });
            emitted += 1; collected += 1;
        }
        if (rows.length < limit) break;
        offset += rows.length;
        // Space out paging; back-to-back page requests are what triggers the
        // HTML block page above.
        await new Promise((r) => setTimeout(r, 400));
    }
    if (!collected && !noted) {
        await flushRow({
            type: 'note', symbol, found: false,
            note: 'no institutional holders matched the filters; not charged',
        }, false);
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
