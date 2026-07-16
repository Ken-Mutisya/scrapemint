// Company Financials Scraper: Revenue & Earnings from SEC
//
// Strategy
// --------
// Pull structured XBRL fundamentals for US-listed companies from the SEC's
// keyless companyfacts API (one GET per company), resolve tickers through
// the public ticker map, and normalize into one row per fiscal period with
// the headline metrics (revenue, net income, EPS, margins inputs, balance
// sheet, operating cash flow). Periods are keyed by their actual end date,
// NOT the XBRL `fy` field: a single 10-K restates prior years and tags them
// all with the filing's fiscal year, so `fy` cannot identify a period. The
// latest-filed value wins for every (concept, period) pair, which makes
// amended filings supersede originals for free.
//
// Pay per event
// -------------
//   financials_row ($0.01) charged per period row pushed. Unresolved or
//   empty companies produce free note rows. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 45000;
const REQUEST_GAP_MS = 200; // SEC fair-access guidance is <=10 req/s; stay far under it.
const UA = 'Scrapemint Company Financials actor (admin@scrapemint.com)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [],
    period = 'annual',
    yearsBack = 5,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const wanted = asList(companies);
const quarterly = String(period).toLowerCase() === 'quarterly';
const years = Math.max(1, Math.min(25, Number(yearsBack) || 5));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const sinceIso = `${new Date().getUTCFullYear() - years}-01-01`;

if (!wanted.length) {
    log.warning('No companies given. Provide tickers (AAPL) or CIK numbers.');
    await Actor.exit();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 404) return { notFound: true };
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Ticker -> CIK map (one call). Bare digit inputs are treated as CIKs directly.
log.info(`Resolving ${wanted.length} company(ies) via SEC ticker map...`);
const tickerMap = await getJson('https://www.sec.gov/files/company_tickers.json');
if (!tickerMap || tickerMap.notFound) {
    // EDGAR throttling can return empty/failed responses with no error status.
    throw new Error('Could not load the SEC ticker map (EDGAR may be throttling). Try again in a minute.');
}
const byTicker = new Map();
for (const e of Object.values(tickerMap)) byTicker.set(String(e.ticker).toUpperCase(), e);

function resolve(inputName) {
    if (/^\d{1,10}$/.test(inputName)) return { cik: inputName.padStart(10, '0'), ticker: null, title: null };
    const hit = byTicker.get(inputName.toUpperCase());
    if (!hit) return null;
    return { cik: String(hit.cik_str).padStart(10, '0'), ticker: String(hit.ticker).toUpperCase(), title: hit.title };
}

// Concept lists in priority order; us-gaap first, IFRS fallbacks for foreign
// private issuers last. `duration` metrics span a period, `instant` metrics
// are balance-sheet points at the period end date.
const DURATION_METRICS = {
    revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'Revenue', 'RevenuesNetOfInterestExpense'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
    grossProfit: ['GrossProfit'],
    operatingIncome: ['OperatingIncomeLoss', 'ProfitLossFromOperatingActivities'],
    operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivities'],
    epsBasic: ['EarningsPerShareBasic', 'BasicEarningsLossPerShare'],
    epsDiluted: ['EarningsPerShareDiluted', 'DilutedEarningsLossPerShare'],
};
const INSTANT_METRICS = {
    assets: ['Assets'],
    liabilities: ['Liabilities'],
    equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'Equity'],
    cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashAndCashEquivalents'],
    sharesOutstanding: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding', 'NumberOfSharesOutstanding'],
};

const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
// Annual durations run ~52-53 weeks; quarters ~13. The bands exclude the
// 6- and 9-month YTD entries that 10-Qs also carry in the same unit arrays.
const durationOk = (e) => {
    if (!e.start || !e.end) return false;
    const d = daysBetween(e.start, e.end);
    return quarterly ? d >= 75 && d <= 105 : d >= 330 && d <= 400;
};

function conceptEntries(facts, name) {
    for (const tax of ['us-gaap', 'ifrs-full', 'dei']) {
        const c = facts?.[tax]?.[name];
        if (!c?.units) continue;
        // Foreign filers carry token USD units next to their real
        // home-currency data (SAP: Revenue has 1 USD entry vs hundreds in
        // EUR), so the unit with the most entries wins; USD breaks ties.
        const unitKeys = Object.keys(c.units).filter((u) => (c.units[u] || []).length);
        if (!unitKeys.length) continue;
        unitKeys.sort((a, b) => c.units[b].length - c.units[a].length
            || (a === 'USD' || a === 'USD/shares' ? -1 : b === 'USD' || b === 'USD/shares' ? 1 : 0));
        const unit = unitKeys[0];
        return { entries: c.units[unit], unit };
    }
    return null;
}

function extractRows(facts, meta) {
    // periods[end] = { fp, form, filed, metrics: {...} }
    const periods = new Map();
    // Companies switch between synonym concepts over the years (e.g. NVDA
    // moved Revenues <-> RevenueFromContractWithCustomer...), so synonyms
    // must FILL missing periods, never overwrite a higher-priority concept's
    // value for the same period. Within one concept, latest filed wins so
    // amendments supersede originals.
    const put = (end, field, e, concept, label) => {
        if (!periods.has(end)) periods.set(end, { fp: null, form: null, filed: null, metrics: {}, filedBy: {}, setter: {} });
        const p = periods.get(end);
        if (p.metrics[field] === undefined) {
            p.metrics[field] = e.val;
            p.filedBy[field] = String(e.filed);
            p.setter[field] = concept;
        } else if (p.setter[field] === concept && String(e.filed) > p.filedBy[field]) {
            p.metrics[field] = e.val;
            p.filedBy[field] = String(e.filed);
        }
        // Period labels (fp/form/filed) come only from income-statement
        // durations: instants from later filings' comparative balance sheets
        // would otherwise relabel an annual row as 10-Q.
        if (label && e.fp && (!p.fp || String(e.filed) > String(p.filed || ''))) { p.fp = e.fp; p.form = e.form; p.filed = e.filed; }
    };

    let currency = 'USD';
    for (const [field, names] of Object.entries(DURATION_METRICS)) {
        for (const name of names) {
            const c = conceptEntries(facts, name);
            if (!c) continue;
            if (c.unit !== 'USD' && !c.unit.includes('/')) currency = c.unit;
            for (const e of c.entries) {
                if (!durationOk(e) || !e.end || e.end < sinceIso) continue;
                put(e.end, field, e, name, true);
            }
        }
    }
    // Only attach balance-sheet instants to period ends we already know.
    for (const [field, names] of Object.entries(INSTANT_METRICS)) {
        for (const name of names) {
            const c = conceptEntries(facts, name);
            if (!c) continue;
            for (const e of c.entries) {
                if (e.start || !e.end || !periods.has(e.end)) continue;
                put(e.end, field, e, name, false);
            }
        }
    }

    const rows = [];
    for (const [end, p] of periods) {
        // A row with no income-statement data is XBRL noise; skip it.
        if (p.metrics.revenue == null && p.metrics.netIncome == null) continue;
        rows.push({
            ticker: meta.ticker,
            cik: meta.cik,
            companyName: meta.name,
            fiscalPeriod: quarterly ? (p.fp || 'Q') : 'FY',
            periodEnd: end,
            currency,
            revenue: p.metrics.revenue ?? null,
            netIncome: p.metrics.netIncome ?? null,
            grossProfit: p.metrics.grossProfit ?? null,
            operatingIncome: p.metrics.operatingIncome ?? null,
            operatingCashFlow: p.metrics.operatingCashFlow ?? null,
            epsBasic: p.metrics.epsBasic ?? null,
            epsDiluted: p.metrics.epsDiluted ?? null,
            assets: p.metrics.assets ?? null,
            liabilities: p.metrics.liabilities ?? null,
            equity: p.metrics.equity ?? null,
            cash: p.metrics.cash ?? null,
            sharesOutstanding: p.metrics.sharesOutstanding ?? null,
            sourceForm: p.form || null,
            sourceFiledAt: p.filed || null,
            sourceUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${meta.cik}.json`,
        });
    }
    rows.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
    return rows;
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'financials_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Fetching ${quarterly ? 'quarterly' : 'annual'} financials for ${wanted.length} company(ies), last ${years} year(s). Cap ${cap} rows.`);

outer:
for (const name of wanted) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    if (rowsPushed >= cap) break;
    const meta0 = resolve(name);
    if (!meta0) {
        log.warning(`${name}: not found in the SEC ticker map.`);
        await flushRow({ ticker: name.toUpperCase(), note: 'Ticker not found in the SEC company list. US-listed companies only.' }, false);
        continue;
    }
    await sleep(REQUEST_GAP_MS);
    const facts = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${meta0.cik}.json`);
    if (!facts || facts.notFound) {
        log.warning(`${name}: no companyfacts data (CIK ${meta0.cik}).`);
        await flushRow({ ticker: meta0.ticker || name, cik: meta0.cik, note: 'No XBRL financial data filed for this company.' }, false);
        continue;
    }
    const meta = { cik: meta0.cik, ticker: meta0.ticker, name: facts.entityName || meta0.title || null };
    const rows = extractRows(facts.facts, meta);
    if (!rows.length) {
        await flushRow({ ticker: meta.ticker || name, cik: meta.cik, companyName: meta.name, note: `No ${quarterly ? 'quarterly' : 'annual'} income-statement periods found in the window.` }, false);
        continue;
    }
    let n = 0;
    for (const row of rows) {
        if (rowsPushed >= cap) { log.warning('Row cap reached.'); break outer; }
        await flushRow({ ...row, scrapedAt: new Date().toISOString() });
        n += 1;
    }
    log.info(`${meta.ticker || name}: ${n} period row(s).`);
}

log.info(`Done. ${rowsPushed} financial row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
