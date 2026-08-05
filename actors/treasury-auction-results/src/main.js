// Treasury Auction Results Scraper
// Official US Treasury auction results from the keyless FiscalData API: bid to
// cover, bidder allotments and the high rate for every Bill, Note, Bond, TIPS
// and FRN auction. No browser, no proxy.
//
// Endpoint (keyless):
//   /v1/accounting/od/auctions_query
//
// Two upstream shapes that a naive read gets wrong:
//   * FiscalData returns the literal STRING "null" for a missing value, so a
//     plain numeric cast yields NaN and a `|| 0` fallback publishes a
//     confident zero for an auction that has no result yet.
//   * An announced auction that has not been held yet is already in the
//     dataset with every result field as "null". It is a scheduled event, not
//     an auction that drew zero demand, so it is labelled rather than mixed in.
//
// Free tier: first 2 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service'
    + '/v1/accounting/od/auctions_query';
const PAGE_SIZE = 500;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 300;
const ALL_TYPES = ['Bill', 'Note', 'Bond', 'TIPS', 'FRN'];
// Cross-run memory for monitor mode. MUST be named: an unnamed key value store
// is recreated per run, so cross-run dedupe would silently never fire.
const SEEN_STORE = 'treasury-auction-seen';
const SEEN_KEY = 'seen-keys';
const SEEN_CAP = 20000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom,
    dateTo,
    securityTypes = [],
    status = 'all',
    minBidToCover,
    newOnly = false,
    maxRows = 500,
} = input;

const from = isDate(dateFrom) ? dateFrom : isoDaysAgo(365);
const to = isDate(dateTo) ? dateTo : null;
const types = (Array.isArray(securityTypes) ? securityTypes : [])
    .map((t) => String(t).trim())
    .filter((t) => ALL_TYPES.includes(t));
const wantStatus = ['all', 'announced', 'settled'].includes(status) ? status : 'all';
const minBtc = asNum(minBidToCover);

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const store = newOnly ? await Actor.openKeyValueStore(SEEN_STORE) : null;
const seenAcrossRuns = new Set(newOnly ? ((await store.getValue(SEEN_KEY)) ?? []) : []);
const seenThisRun = new Set();

let pushed = 0;
let stop = false;

log.info(
    `Treasury auctions from ${from}${to ? ` to ${to}` : ''} | status=${wantStatus}`
    + `${types.length ? ` | types=${types.join(',')}` : ''}`
    + `${minBtc !== null ? ` | minBidToCover=${minBtc}` : ''}`
    + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
);

for (let page = 1; !done(); page += 1) {
    const filters = [`auction_date:gte:${from}`];
    if (to) filters.push(`auction_date:lte:${to}`);
    if (types.length === 1) filters.push(`security_type:eq:${types[0]}`);
    else if (types.length > 1) filters.push(`security_type:in:(${types.join(',')})`);

    const url = `${BASE}?sort=-auction_date`
        + `&page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}`
        + `&filter=${encodeURIComponent(filters.join(','))
            .replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%28/g, '(').replace(/%29/g, ')')}`;

    const json = await getJson(url);
    if (!json) break;
    const rows = json?.data || [];
    for (const d of rows) {
        if (done()) break;
        await pushRow(toRow(d));
    }
    const totalPages = json?.meta?.['total-pages'] ?? page;
    if (page >= totalPages || rows.length === 0) break;
    await sleep(SPACING_MS);
}

if (newOnly) {
    const merged = [...seenAcrossRuns, ...seenThisRun].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} keys for the next run.`);
}

log.info(`Done. Pushed ${pushed} auction rows.`);
await Actor.exit();

// ---------- shaping ----------

function toRow(d) {
    const bidToCover = asNum(d.bid_to_cover_ratio);
    // An auction with no bid to cover has not been held yet. Treasury publishes
    // the schedule ahead of time, so these rows are real and worth returning,
    // but calling them settled results would be wrong.
    const auctionStatus = bidToCover === null ? 'announced' : 'settled';

    const highYield = asNum(d.high_yield);
    const highDiscount = asNum(d.high_discnt_rate);
    /* Bills are quoted on a discount basis and carry high_discnt_rate with an
     * always-empty high_yield; Notes and Bonds are the other way round. Reading
     * high_yield alone therefore reports ~75% of auctions as having no rate.
     * highRatePct normalises the two so one field is comparable across types,
     * and rateType says which basis it came from. */
    const rateType = highYield !== null ? 'yield' : (highDiscount !== null ? 'discount' : null);
    const highRate = highYield !== null ? highYield : highDiscount;

    const totalAccepted = asNum(d.total_accepted);
    return {
        auctionStatus,
        cusip: nn(d.cusip),
        securityType: nn(d.security_type),
        securityTerm: nn(d.security_term),
        auctionDate: nn(d.auction_date),
        issueDate: nn(d.issue_date),
        maturityDate: nn(d.maturity_date),
        auctionFormat: nn(d.auction_format),
        reopening: nn(d.reopening),

        offeringUsd: asNum(d.offering_amt),
        totalTenderedUsd: asNum(d.total_tendered),
        totalAcceptedUsd: totalAccepted,
        bidToCoverRatio: bidToCover,

        highRatePct: highRate,
        rateType,
        highYieldPct: highYield,
        highDiscountRatePct: highDiscount,
        highInvestmentRatePct: asNum(d.high_investment_rate),
        couponRatePct: asNum(d.int_rate),
        highPrice: asNum(d.high_price),

        competitiveAcceptedUsd: asNum(d.comp_accepted),
        noncompetitiveAcceptedUsd: asNum(d.noncomp_accepted),
        primaryDealerAcceptedUsd: asNum(d.primary_dealer_accepted),
        directBidderAcceptedUsd: asNum(d.direct_bidder_accepted),
        indirectBidderAcceptedUsd: asNum(d.indirect_bidder_accepted),
        // Share of the auction each bidder class took. Indirect share is the
        // usual read on foreign demand.
        primaryDealerPct: share(d.primary_dealer_accepted, totalAccepted),
        directBidderPct: share(d.direct_bidder_accepted, totalAccepted),
        indirectBidderPct: share(d.indirect_bidder_accepted, totalAccepted),
    };
}

/* Absent parts stay null rather than becoming 0: an auction whose allotments
 * have not been published has an unknown share, not a zero share. */
function share(part, total) {
    const p = asNum(part);
    if (p === null || total === null || !(total > 0)) return null;
    return Math.round((p / total) * 10000) / 100;
}

// ---------- helpers ----------

function done() {
    if (stop) return true;
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        stop = true;
        return true;
    }
    return false;
}

async function pushRow(row) {
    if (!row.cusip && !row.auctionDate) return;
    if (wantStatus !== 'all' && row.auctionStatus !== wantStatus) return;
    // A minimum bid to cover can only be judged on an auction that has been
    // held, so announced rows are excluded when the filter is set.
    if (minBtc !== null && !(row.bidToCoverRatio !== null && row.bidToCoverRatio >= minBtc)) return;

    const key = `${row.cusip ?? 'na'}:${row.auctionDate ?? 'na'}:${row.auctionStatus}`;
    if (seenThisRun.has(key)) return;
    seenThisRun.add(key);
    if (newOnly && seenAcrossRuns.has(key)) return;

    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'auction_row' })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 50 === 0) log.info(`Pushed ${pushed} rows...`);
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Scrapemint Treasury Auction actor (admin@scrapemint.com)' },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return JSON.parse(await res.text());
        } catch (err) {
            if (attempt === 3) {
                log.warning(`fetch failed: ${err?.message}`);
                return null;
            }
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

/* FiscalData sends the literal string "null" for a missing value. Number("null")
 * is NaN and a `|| 0` fallback would publish a confident zero, so absence is
 * mapped to null explicitly. */
function asNum(v) {
    if (v === null || v === undefined || v === '' || v === 'null') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function nn(v) {
    return (v === 'null' || v === '' || v === undefined || v === null) ? null : v;
}
function isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isoDaysAgo(n) {
    return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
