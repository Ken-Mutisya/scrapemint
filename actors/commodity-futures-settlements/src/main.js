// Commodity Futures Prices: Gold, Oil, Grains and Rates
//
// What it does
// ------------
// The settlement price is the number the whole futures market is marked to:
// margin, options, indices and every hedge accounting entry reference it, and
// it is published once a day per contract. This reads the exchange's own
// settlement report, so the prices are the official ones rather than a
// delayed quote scraped off a chart.
//
//   curve     one row per contract month: open, high, low, last, settle,
//             the change, volume and open interest
//   summary   one row per product: the front month, the whole day's volume
//             and open interest, and whether the curve is in contango or
//             backwardation
//   products  the exchange's product list ranked by open interest, for
//             finding the code of anything not in the built-in map
//
// Distinct from our cftc-cot-tracker, which reports who holds futures
// positions but no prices, and from crypto-futures-basis-tracker, which
// reads a crypto exchange. Same trader, different half of the picture.
//
// Pay per event
// -------------
//   settlement_row ($0.004) charged per row pushed. First 2 rows per run
//   free. Note rows and unknown products are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 250;
const CME = 'https://www.cmegroup.com/CmeWS/mvc';
const MAX_DATE_WALKBACK = 7;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'curve',
    products = ['GC', 'CL', 'NG'],
    tradeDate = '',
    monthsPerProduct = 12,
    minOpenInterest = 0,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The exchange's own product ids for the contracts people actually ask for,
// so a buyer types GC rather than 437. Anything not listed here is resolved
// against the live product list, and a raw numeric id also works.
const PRODUCTS = {
    // metals
    GC: [437, 'Gold', 'COMEX'], SI: [458, 'Silver', 'COMEX'], HG: [438, 'Copper', 'COMEX'],
    PL: [446, 'Platinum', 'NYMEX'], PA: [445, 'Palladium', 'NYMEX'],
    // energy
    CL: [425, 'Crude Oil', 'NYMEX'], BZ: [424, 'Brent Crude', 'NYMEX'], NG: [444, 'Natural Gas', 'NYMEX'],
    RB: [429, 'RBOB Gasoline', 'NYMEX'], HO: [426, 'NY Harbor ULSD', 'NYMEX'],
    // grains and livestock
    ZC: [300, 'Corn', 'CBOT'], ZW: [323, 'Chicago SRW Wheat', 'CBOT'], KE: [348, 'KC HRW Wheat', 'CBOT'],
    ZS: [320, 'Soybeans', 'CBOT'], ZM: [310, 'Soybean Meal', 'CBOT'], ZL: [312, 'Soybean Oil', 'CBOT'],
    LE: [22, 'Live Cattle', 'CME'], HE: [19, 'Lean Hogs', 'CME'],
    // equity index
    ES: [133, 'E-mini S&P 500', 'CME'], NQ: [146, 'E-mini Nasdaq-100', 'CME'],
    YM: [318, 'E-mini Dow', 'CBOT'], RTY: [8314, 'E-mini Russell 2000', 'CME'],
    // rates
    ZT: [303, '2-Year T-Note', 'CBOT'], ZF: [329, '5-Year T-Note', 'CBOT'],
    ZN: [316, '10-Year T-Note', 'CBOT'], ZB: [307, 'U.S. Treasury Bond', 'CBOT'],
    SR3: [8462, 'Three-Month SOFR', 'CME'],
    // fx
    '6E': [58, 'Euro FX', 'CME'], '6J': [69, 'Japanese Yen', 'CME'], '6B': [42, 'British Pound', 'CME'],
    '6A': [37, 'Australian Dollar', 'CME'], '6C': [48, 'Canadian Dollar', 'CME'],
    '6S': [86, 'Swiss Franc', 'CME'], '6M': [75, 'Mexican Peso', 'CME'],
};
// Words people type instead of a ticker.
const ALIASES = {
    gold: 'GC', silver: 'SI', copper: 'HG', platinum: 'PL', palladium: 'PA',
    oil: 'CL', crude: 'CL', 'crude oil': 'CL', wti: 'CL', brent: 'BZ',
    gas: 'NG', 'natural gas': 'NG', gasoline: 'RB', diesel: 'HO', heatingoil: 'HO',
    corn: 'ZC', wheat: 'ZW', soybeans: 'ZS', soybean: 'ZS', soymeal: 'ZM', soyoil: 'ZL',
    cattle: 'LE', hogs: 'HE', sp500: 'ES', 's&p': 'ES', nasdaq: 'NQ', dow: 'YM', russell: 'RTY',
    treasury: 'ZN', '10y': 'ZN', '30y': 'ZB', sofr: 'SR3', euro: '6E', yen: '6J', pound: '6B',
};

const theMode = ['curve', 'summary', 'products'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'curve';
const wanted = asList(products);
const monthCap = Math.max(1, Math.min(100, Number(monthsPerProduct) || 12));
const oiFloor = Math.max(0, Number(minOpenInterest) || 0);
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                accept: 'application/json',
            },
        });
        // An unknown product id answers 500 with an HTML error page rather
        // than a JSON error, so a non-JSON body is treated as "no such
        // product" rather than retried into the ground.
        if (res.status === 500) return { __unknown: true };
        if (res.status === 429 || res.status > 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        const text = await res.text();
        if (text.trimStart().startsWith('<')) return { __unknown: true };
        return JSON.parse(text);
    } catch (err) {
        if (attempt < 2) {
            await sleep(500 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 110)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'settlement_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Prices arrive as strings with thousands separators, and a dash where there
// is no value. Number('-') is NaN but Number('') is 0, so both are handled
// explicitly: a contract that did not trade must not report a price of zero.
function num(v) {
    const s = String(v ?? '').replace(/,/g, '').trim();
    if (!s || s === '-' || s === '--') return null;
    if (/^UNCH$/i.test(s)) return 0;
    const m = s.match(/^([+-]?\d*\.?\d+)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}
// "4078.1A" -> the A is a bid or ask indicator, not part of the price.
function priceFlag(v) {
    const m = String(v ?? '').trim().match(/([A-Za-z])$/);
    return m ? m[1].toUpperCase() : null;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;

function resolveProduct(token) {
    const raw = String(token || '').trim();
    if (/^\d+$/.test(raw)) return { id: Number(raw), code: raw, name: null, exchange: null };
    const upper = raw.toUpperCase();
    if (PRODUCTS[upper]) {
        const [id, name, exchange] = PRODUCTS[upper];
        return { id, code: upper, name, exchange };
    }
    const alias = ALIASES[raw.toLowerCase()];
    if (alias && PRODUCTS[alias]) {
        const [id, name, exchange] = PRODUCTS[alias];
        return { id, code: alias, name, exchange };
    }
    return null;
}

async function fetchSettlements(productId, dateStr) {
    const url = `${CME}/Settlements/Futures/Settlements/${productId}/FUT?tradeDate=${encodeURIComponent(dateStr)}&strategy=DEFAULT`;
    const json = await getJson(url);
    if (!json || json.__unknown) return json?.__unknown ? { unknown: true } : null;
    const all = json.settlements || [];
    // The report ends with a "Total" row carrying the day's volume and open
    // interest across every month. It is NOT a contract: emitting it invents
    // a phantom expiry and double counts the volume.
    const totalRow = all.find((r) => String(r.month || '').trim().toLowerCase() === 'total');
    const months = all.filter((r) => String(r.month || '').trim().toLowerCase() !== 'total');
    return {
        productName: clean(json.dsHeader),
        // Preliminary settlements are revised; final ones are not.
        reportType: clean(json.reportType),
        updateTime: clean(json.updateTime),
        tradeDate: clean(json.tradeDate) || dateStr,
        months,
        totalVolume: totalRow ? num(totalRow.volume) : null,
        totalOpenInterest: totalRow ? num(totalRow.openInterest) : null,
    };
}

// Settlements for the current day are not published until after the close, and
// weekends and holidays have none at all, so the newest date carrying data is
// found by walking back. It is resolved once and reused for every product, so
// the walk costs a few requests rather than a few per product.
async function resolveTradeDate(probeProductId) {
    const explicit = String(tradeDate || '').trim();
    if (explicit) {
        const m = explicit.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[2]}/${m[3]}/${m[1]}` : explicit;
    }
    for (let back = 0; back <= MAX_DATE_WALKBACK; back += 1) {
        const d = new Date(Date.now() - back * 86400000);
        const candidate = fmtDate(d);
        const data = await fetchSettlements(probeProductId, candidate);
        await sleep(SPACING_MS);
        if (data && !data.unknown && data.months.length) {
            if (back) log.info(`No settlements for the last ${back} day(s); using ${candidate}`);
            return candidate;
        }
    }
    return null;
}

// The nearest listed month is often an expiring husk: gold's front month
// settled on 36 lots while the month behind it traded 135,087. Traders quote
// the LEAD month, the one carrying the open interest, so both are marked.
function leadIndex(months) {
    let best = -1;
    let bestOi = -1;
    months.forEach((m, i) => {
        const oi = num(m.openInterest) ?? 0;
        if (oi > bestOi) { bestOi = oi; best = i; }
    });
    return bestOi > 0 ? best : 0;
}

function buildCurveRows(product, data) {
    const rows = [];
    let frontSettle = null;
    const lead = leadIndex(data.months);
    data.months.forEach((m, i) => {
        const settle = num(m.settle);
        const change = num(m.change);
        if (i === 0) frontSettle = settle;
        const prior = settle != null && change != null ? settle - change : null;
        const oi = num(m.openInterest);
        if (oiFloor && (oi ?? 0) < oiFloor) return;
        rows.push({
            mode: 'curve',
            product: product.name ?? data.productName,
            productCode: product.code,
            productId: product.id,
            exchange: product.exchange,
            contractMonth: clean(m.month),
            monthIndex: i,
            isFrontMonth: i === 0,
            isLeadMonth: i === lead,
            open: num(m.open),
            high: num(m.high),
            low: num(m.low),
            last: num(m.last),
            lastPriceFlag: priceFlag(m.last),
            settle,
            change,
            changePercent: prior ? round((change / prior) * 100, 3) : null,
            priorSettle: prior != null ? round(prior, 6) : null,
            volume: num(m.volume),
            openInterest: oi,
            // How far this month trades from the front, the number a spread
            // or a roll is actually priced off.
            spreadToFrontMonth: settle != null && frontSettle != null ? round(settle - frontSettle, 6) : null,
            tradeDate: data.tradeDate,
            reportType: data.reportType,
            updateTime: data.updateTime,
            scrapedAt: new Date().toISOString(),
        });
    });
    return rows.slice(0, monthCap);
}

function buildSummaryRow(product, data) {
    const months = data.months;
    if (!months.length) return null;
    const front = months[0];
    const frontSettle = num(front.settle);
    const lead = months[leadIndex(months)];
    const leadSettle = num(lead.settle);
    const leadChange = num(lead.change);
    const leadPrior = leadSettle != null && leadChange != null ? leadSettle - leadChange : null;
    // The far end of the curve is the last month anyone actually holds, so
    // deferred months with no open interest do not decide the curve shape.
    const active = months.filter((m) => (num(m.openInterest) ?? 0) > 0);
    const back = active.length ? active[active.length - 1] : months[months.length - 1];
    const backSettle = num(back.settle);
    const change = num(front.change);
    const prior = frontSettle != null && change != null ? frontSettle - change : null;
    let curveShape = null;
    if (frontSettle != null && backSettle != null && back !== front) {
        curveShape = backSettle > frontSettle ? 'contango' : (backSettle < frontSettle ? 'backwardation' : 'flat');
    }
    return {
        mode: 'summary',
        product: product.name ?? data.productName,
        productCode: product.code,
        productId: product.id,
        exchange: product.exchange,
        frontMonth: clean(front.month),
        frontSettle,
        frontChange: change,
        frontChangePercent: prior ? round((change / prior) * 100, 3) : null,
        frontHigh: num(front.high),
        frontLow: num(front.low),
        frontVolume: num(front.volume),
        frontOpenInterest: num(front.openInterest),
        // The contract the market actually trades, which is what a quoted
        // price for this commodity normally refers to.
        leadMonth: clean(lead.month),
        leadSettle,
        leadChange,
        leadChangePercent: leadPrior ? round((leadChange / leadPrior) * 100, 3) : null,
        leadVolume: num(lead.volume),
        leadOpenInterest: num(lead.openInterest),
        contractsListed: months.length,
        contractsWithOpenInterest: active.length,
        backMonth: clean(back.month),
        backSettle,
        curveShape,
        frontToBackSpread: frontSettle != null && backSettle != null ? round(backSettle - frontSettle, 6) : null,
        frontToBackPercent: frontSettle && backSettle != null ? round(((backSettle - frontSettle) / frontSettle) * 100, 3) : null,
        // Taken from the report's own Total line, not summed from the months.
        totalVolume: data.totalVolume,
        totalOpenInterest: data.totalOpenInterest,
        tradeDate: data.tradeDate,
        reportType: data.reportType,
        updateTime: data.updateTime,
        scrapedAt: new Date().toISOString(),
    };
}

if (theMode === 'products') {
    const list = await getJson(`${CME}/ProductSlate/V2/List?pageNumber=1&pageSize=500&cleared=Futures&sortField=oi&sortAsc=false`);
    const items = list?.products || [];
    if (!items.length) {
        await flushRow({ type: 'note', found: false, note: 'the product list could not be read; try again shortly; not charged' }, false);
    } else {
        let n = 0;
        for (const p of items.slice(0, rowCap)) {
            await flushRow({
                mode: 'products',
                productId: p.id,
                productCode: clean(p.globex) || clean(p.clearing),
                clearingCode: clean(p.clearing),
                product: clean(p.name),
                exchange: clean(p.exch),
                group: clean(p.group),
                subGroup: clean(p.subGroup),
                builtIn: Object.values(PRODUCTS).some(([id]) => id === p.id),
                scrapedAt: new Date().toISOString(),
            });
            n += 1;
        }
        log.info(`Done. ${n} product row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
    }
    await Actor.exit();
}

const resolved = [];
for (const token of wanted) {
    const p = resolveProduct(token);
    if (!p) {
        await flushRow({
            type: 'note', found: false, requested: token,
            note: 'unknown product; use a code such as GC, CL, NG, ZC, ES, ZN or 6E, a word such as gold or wheat, or a numeric product id from products mode; not charged',
        }, false);
        continue;
    }
    resolved.push(p);
}
if (!resolved.length) {
    await flushRow({ type: 'note', found: false, note: 'no valid products requested; not charged' }, false);
    log.error('nothing to fetch');
    await Actor.exit();
}

const useDate = await resolveTradeDate(resolved[0].id);
if (!useDate) {
    await flushRow({
        type: 'note', found: false,
        note: `no settlements published in the last ${MAX_DATE_WALKBACK} days for the first product; the exchange publishes after the close on trading days, so a weekend or holiday run finds nothing; not charged`,
    }, false);
    log.error('no trade date with data');
    await Actor.exit();
}
log.info(`Settlements ${theMode} | ${resolved.map((p) => p.code).join(', ')} | trade date ${useDate}`);

const out = [];
for (const product of resolved) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
    const data = await fetchSettlements(product.id, useDate);
    await sleep(SPACING_MS);
    // Three different failures that must not be reported as one: the request
    // did not complete, the product id does not exist, and the product exists
    // but published nothing that day.
    if (!data) {
        await flushRow({
            type: 'note', found: false, requested: product.code, productId: product.id,
            note: 'the settlement report could not be read for this product; this is usually transient, so try the run again; not charged',
        }, false);
        continue;
    }
    if (data.unknown) {
        await flushRow({
            type: 'note', found: false, requested: product.code, productId: product.id,
            note: 'the exchange has no futures settlement report for this product id; look the code up in products mode; not charged',
        }, false);
        continue;
    }
    if (!data.months.length) {
        await flushRow({
            type: 'note', found: false, requested: product.code, tradeDate: useDate,
            note: 'no settlements published for this product on this trade date; weekends, holidays and dates before the close have none; not charged',
        }, false);
        continue;
    }
    if (theMode === 'summary') {
        const row = buildSummaryRow(product, data);
        if (row) out.push(row);
    } else {
        out.push(...buildCurveRows(product, data));
    }
}

let emitted = 0;
for (const row of out.slice(0, rowCap)) {
    await flushRow(row);
    emitted += 1;
}

if (!emitted) {
    await flushRow({
        type: 'note', found: false, tradeDate: useDate,
        note: 'nothing matched; lower minOpenInterest or pick a different product or trade date; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
