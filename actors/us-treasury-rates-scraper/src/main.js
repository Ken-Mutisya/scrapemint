// US Treasury Yields & Interest Rates Scraper
//
// Strategy
// --------
// Two official keyless sources:
//   * treasury.gov interest-rate XML feeds (Atom, one file per calendar
//     year) for the daily yield curve, TIPS real yields, T-bill rates and
//     long-term composite rates. Years are fetched newest-first and each
//     year's entries reversed, so rows stream newest-first and capped runs
//     keep the recent end.
//   * api.fiscaldata.treasury.gov JSON for auction results, average
//     interest rates on US debt and debt-to-the-penny, sorted
//     -record_date with record_date:gte filters.
//
// Source quirks handled:
//   * FiscalData uses the literal string "null" for missing values.
//   * XML null fields are self-closing (<d:X m:null="true"/>) and simply
//     do not match the value regex.
//   * The yield-curve XML carries a BC_30YEARDISPLAY meta column and
//     short meta fields (Id, D, I) that are skipped.
//
// Pay per event
// -------------
//   rate_row per data row. Empty pulls are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const XML_BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
const FISCAL_BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 400;
const FISCAL_PAGE = 1000;
const EMPTY_YEARS_STOP = 2;
const OLDEST_YEAR = 1990;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { dataset = 'yield_curve', sinceDays = 90, newOnly = false, maxRows = 250 } = input;

const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const DATASETS = ['yield_curve', 'real_yield_curve', 'bill_rates', 'long_term_rates', 'avg_interest_rates', 'auctions', 'debt_to_penny'];
const ds = DATASETS.includes(dataset) ? dataset : 'yield_curve';
const rowCap = clampNum(maxRows, 250, 1, HARD_CAP);
const days = clampNum(sinceDays, 90, 0, 20000);
const floorDate = days > 0 ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;

async function getText(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Scrapemint Treasury Rates actor (admin@scrapemint.com)' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const text = await res.text();
            await sleep(SPACING_MS);
            return { text };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

const asNum = (v) => {
    if (v === null || v === undefined || v === '' || v === 'null') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const nn = (v) => (v === 'null' || v === '' || v === undefined ? null : v);
const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

// --- charging ------------------------------------------------------------------

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'rate_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- monitor state --------------------------------------------------------------

const store = newOnly ? await Actor.openKeyValueStore('treasury-rates-seen') : null;
const SEEN_KEY = 'seen-row-keys';
const SEEN_MAX = 300000;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- XML datasets ----------------------------------------------------------------

const XML_DATA_PARAM = {
    yield_curve: 'daily_treasury_yield_curve',
    real_yield_curve: 'daily_treasury_real_yield_curve',
    bill_rates: 'daily_treasury_bill_rates',
    long_term_rates: 'daily_treasury_long_term_rate',
};

const YIELD_KEYS = {
    BC_1MONTH: 'yield1Month', BC_1_5MONTH: 'yield6Week', BC_2MONTH: 'yield2Month',
    BC_3MONTH: 'yield3Month', BC_4MONTH: 'yield4Month', BC_6MONTH: 'yield6Month',
    BC_1YEAR: 'yield1Year', BC_2YEAR: 'yield2Year', BC_3YEAR: 'yield3Year',
    BC_5YEAR: 'yield5Year', BC_7YEAR: 'yield7Year', BC_10YEAR: 'yield10Year',
    BC_20YEAR: 'yield20Year', BC_30YEAR: 'yield30Year',
};
const REAL_KEYS = {
    TC_5YEAR: 'realYield5Year', TC_7YEAR: 'realYield7Year', TC_10YEAR: 'realYield10Year',
    TC_20YEAR: 'realYield20Year', TC_30YEAR: 'realYield30Year',
};

function parseEntries(xml) {
    const out = [];
    for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const fields = {};
        for (const [, key, val] of body.matchAll(/<d:([A-Za-z_0-9]+)(?:\s[^>]*)?>([^<]*)</g)) {
            if (key.length > 2) fields[key] = val.trim();
        }
        if (Object.keys(fields).length > 0) out.push(fields);
    }
    return out;
}

function xmlRow(fields) {
    const dateKey = Object.keys(fields).find((k) => k.endsWith('DATE'));
    const date = dateKey && fields[dateKey] ? fields[dateKey].slice(0, 10) : null;
    if (ds === 'yield_curve') {
        const row = { date };
        for (const [src, dst] of Object.entries(YIELD_KEYS)) row[dst] = asNum(fields[src]);
        row.spread2y10y = row.yield10Year !== null && row.yield2Year !== null ? round2(row.yield10Year - row.yield2Year) : null;
        row.curveInverted = row.spread2y10y !== null ? row.spread2y10y < 0 : null;
        return { row, key: `yc|${date}` };
    }
    if (ds === 'real_yield_curve') {
        const row = { date };
        for (const [src, dst] of Object.entries(REAL_KEYS)) row[dst] = asNum(fields[src]);
        return { row, key: `ryc|${date}` };
    }
    if (ds === 'long_term_rates') {
        const row = { date, rateType: fields.RATE_TYPE || null, rate: asNum(fields.RATE), extrapolationFactor: asNum(fields.EXTRAPOLATION_FACTOR) };
        return { row, key: `lt|${date}|${row.rateType}` };
    }
    // bill_rates: many tenor columns; pass through lowercased with numbers parsed.
    const row = { date };
    for (const [k, v] of Object.entries(fields)) {
        if (k.endsWith('DATE') || k === 'Id' || k.toUpperCase().endsWith('DATAID')) continue;
        row[k.toLowerCase()] = /^-?\d*\.?\d+$/.test(v) ? asNum(v) : nn(v);
    }
    return { row, key: `bill|${date}` };
}

async function runXml() {
    const nowYear = new Date().getFullYear();
    const floorYear = floorDate ? Number(floorDate.slice(0, 4)) : OLDEST_YEAR;
    let emptyYears = 0;
    let anyRow = false;
    for (let year = nowYear; year >= floorYear && !shouldStop(); year -= 1) {
        const { text, error } = await getText(`${XML_BASE}?data=${XML_DATA_PARAM[ds]}&field_tdr_date_value=${year}`);
        if (error) {
            if (!anyRow) await flushRow({ type: 'note', dataset: ds, found: false, note: `fetch failed for ${year} (${error}); not charged, try again later` }, false);
            return;
        }
        const entries = parseEntries(text);
        if (entries.length === 0) {
            emptyYears += 1;
            if (emptyYears >= EMPTY_YEARS_STOP) break;
            continue;
        }
        emptyYears = 0;
        for (const fields of entries.reverse()) {
            if (shouldStop()) break;
            const { row, key } = xmlRow(fields);
            if (!row.date || (floorDate && row.date < floorDate)) continue;
            if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(key);
            await flushRow({ dataset: ds, ...row }, true);
            anyRow = true;
        }
    }
    if (!anyRow && !shouldStop()) {
        await flushRow({ type: 'note', dataset: ds, found: false, note: `no ${newOnly ? 'new ' : ''}rows in the window; not charged` }, false);
    }
}

// --- FiscalData datasets ---------------------------------------------------------

const FISCAL_CONF = {
    avg_interest_rates: {
        path: '/v2/accounting/od/avg_interest_rates',
        toRow: (d) => ({
            date: d.record_date,
            securityTypeDesc: nn(d.security_type_desc),
            securityDesc: nn(d.security_desc),
            avgInterestRatePct: asNum(d.avg_interest_rate_amt),
        }),
        key: (d) => `air|${d.record_date}|${d.security_desc}`,
    },
    auctions: {
        path: '/v1/accounting/od/auctions_query',
        toRow: (d) => ({
            recordDate: d.record_date,
            cusip: nn(d.cusip),
            securityType: nn(d.security_type),
            securityTerm: nn(d.security_term),
            auctionDate: nn(d.auction_date),
            issueDate: nn(d.issue_date),
            maturityDate: nn(d.maturity_date),
            auctionFormat: nn(d.auction_format),
            reopening: nn(d.reopening),
            floatingRate: nn(d.floating_rate),
            offeringUsd: asNum(d.offering_amt),
            totalTenderedUsd: asNum(d.total_tendered),
            totalAcceptedUsd: asNum(d.total_accepted),
            bidToCoverRatio: asNum(d.bid_to_cover_ratio),
            highYieldPct: asNum(d.high_yield),
            highDiscountRatePct: asNum(d.high_discnt_rate),
            highInvestmentRatePct: asNum(d.high_investment_rate),
            highPrice: asNum(d.high_price),
            couponRatePct: asNum(d.int_rate),
            competitiveAcceptedUsd: asNum(d.comp_accepted),
            noncompetitiveAcceptedUsd: asNum(d.noncomp_accepted),
            primaryDealerAcceptedUsd: asNum(d.primary_dealer_accepted),
            directBidderAcceptedUsd: asNum(d.direct_bidder_accepted),
            indirectBidderAcceptedUsd: asNum(d.indirect_bidder_accepted),
        }),
        key: (d) => `auc|${d.cusip}|${d.auction_date}`,
    },
    debt_to_penny: {
        path: '/v2/accounting/od/debt_to_penny',
        toRow: (d) => ({
            date: d.record_date,
            debtHeldPublicUsd: asNum(d.debt_held_public_amt),
            intragovHoldingsUsd: asNum(d.intragov_hold_amt),
            totalPublicDebtUsd: asNum(d.tot_pub_debt_out_amt),
        }),
        key: (d) => `debt|${d.record_date}`,
    },
};

async function runFiscal() {
    const conf = FISCAL_CONF[ds];
    let anyRow = false;
    for (let page = 1; !shouldStop(); page += 1) {
        const filter = floorDate ? `&filter=record_date:gte:${floorDate}` : '';
        const url = `${FISCAL_BASE}${conf.path}?sort=-record_date&page%5Bsize%5D=${FISCAL_PAGE}&page%5Bnumber%5D=${page}${filter}`;
        const { text, error } = await getText(url);
        if (error) {
            if (!anyRow) await flushRow({ type: 'note', dataset: ds, found: false, note: `fetch failed (${error}); not charged, try again later` }, false);
            return;
        }
        let json;
        try { json = JSON.parse(text); } catch {
            if (!anyRow) await flushRow({ type: 'note', dataset: ds, found: false, note: 'unparseable response; not charged, try again later' }, false);
            return;
        }
        const data = json?.data || [];
        for (const d of data) {
            if (shouldStop()) break;
            const key = conf.key(d);
            if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(key);
            await flushRow({ dataset: ds, ...conf.toRow(d) }, true);
            anyRow = true;
        }
        const totalPages = json?.meta?.['total-pages'] ?? page;
        if (page >= totalPages || data.length === 0) break;
    }
    if (!anyRow && !shouldStop()) {
        await flushRow({ type: 'note', dataset: ds, found: false, note: `no ${newOnly ? 'new ' : ''}rows in the window; not charged` }, false);
    }
}

// --- run ---------------------------------------------------------------------------

log.info(`Dataset ${ds}${floorDate ? `, since ${floorDate}` : ', full history'}${newOnly ? ', NEW rows only' : ''}, cap ${rowCap}...`);

if (FISCAL_CONF[ds]) await runFiscal();
else await runXml();

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} row key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
