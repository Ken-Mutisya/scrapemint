// Stock Market Fundamentals Scraper
// Financial-statement line items (revenue, net income, EPS, assets, cash flow,
// etc.) per ticker, straight from SEC XBRL company facts. Keyless, no browser.
//
// Endpoints (keyless JSON, SEC requires a descriptive User-Agent with an email):
//   https://www.sec.gov/files/company_tickers.json            -> ticker -> CIK map
//   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json -> all facts
//
// Free tier: first 15 rows per run are free, then each fundamentals row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 15;
const HEADERS = {
    'User-Agent': 'Scrapemint Fundamentals Scraper contact@scrapemint.com',
    Accept: 'application/json',
};
const SEC_SLEEP_MS = 160; // SEC allows ~10 req/sec; stay polite

// Curated common line items -> human label. Revenue/COGS/dividends have a few
// tag variants across filers, so several map to the same label.
const KEY_METRICS = {
    'us-gaap': {
        Revenues: 'Revenue',
        RevenueFromContractWithCustomerExcludingAssessedTax: 'Revenue',
        CostOfRevenue: 'Cost of revenue',
        CostOfGoodsAndServicesSold: 'Cost of revenue',
        GrossProfit: 'Gross profit',
        OperatingIncomeLoss: 'Operating income',
        ResearchAndDevelopmentExpense: 'R&D expense',
        SellingGeneralAndAdministrativeExpense: 'SG&A expense',
        NetIncomeLoss: 'Net income',
        EarningsPerShareBasic: 'EPS (basic)',
        EarningsPerShareDiluted: 'EPS (diluted)',
        Assets: 'Total assets',
        AssetsCurrent: 'Current assets',
        Liabilities: 'Total liabilities',
        LiabilitiesCurrent: 'Current liabilities',
        StockholdersEquity: 'Shareholders equity',
        CashAndCashEquivalentsAtCarryingValue: 'Cash and equivalents',
        InventoryNet: 'Inventory',
        LongTermDebtNoncurrent: 'Long-term debt',
        NetCashProvidedByUsedInOperatingActivities: 'Operating cash flow',
        PaymentsToAcquirePropertyPlantAndEquipment: 'Capital expenditures',
        PaymentsOfDividendsCommonStock: 'Dividends paid',
        PaymentsOfDividends: 'Dividends paid',
    },
    dei: {
        EntityCommonStockSharesOutstanding: 'Shares outstanding',
    },
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    metrics = [],
    includeAllConcepts = false,
    forms = ['10-K', '10-Q'],
    minYear,
    latestOnly = false,
    maxRowsPerTicker = 5000,
    maxRowsTotal = 50000,
} = input;

const symbols = (Array.isArray(tickers) ? tickers : [])
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);

if (symbols.length === 0) {
    log.warning('No tickers provided. Set "tickers", e.g. ["AAPL","MSFT"].');
    await Actor.exit();
}

const metricFilter = new Set((Array.isArray(metrics) ? metrics : []).map((m) => String(m).trim()).filter(Boolean));
const formSet = new Set((Array.isArray(forms) ? forms : []).map((f) => String(f).trim()).filter(Boolean));
const minYearNum = Number.isFinite(Number(minYear)) ? Number(minYear) : null;

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

let pushed = 0;

// ticker -> CIK
const cikMap = await loadCikMap();
if (!cikMap) {
    log.warning('Could not load SEC ticker -> CIK map; aborting.');
    await Actor.exit();
}

for (const symbol of symbols) {
    if (done()) break;
    const cik = cikMap.get(symbol);
    if (!cik) {
        log.warning(`Unknown ticker ${symbol} (not found in SEC company list).`);
        continue;
    }
    const facts = (await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`))?.facts;
    if (!facts) {
        log.warning(`No SEC facts for ${symbol} (CIK ${cik}).`);
        await sleep(SEC_SLEEP_MS);
        continue;
    }

    let perTicker = 0;
    for (const taxonomy of ['us-gaap', 'dei']) {
        const concepts = facts[taxonomy];
        if (!concepts) continue;
        for (const concept of Object.keys(concepts)) {
            if (done() || perTicker >= maxRowsPerTicker) break;
            const label = resolveLabel(taxonomy, concept);
            if (!label) continue; // not in the selected set

            const points = collectPoints(concepts[concept]);
            const filtered = points.filter(keepPoint);
            const finalPoints = latestOnly ? latestPerConcept(filtered) : filtered;

            for (const p of finalPoints) {
                if (done() || perTicker >= maxRowsPerTicker) break;
                await pushRow({
                    symbol,
                    cik: Number(cik),
                    taxonomy,
                    concept,
                    label,
                    unit: p.unit,
                    value: p.val,
                    fiscalYear: p.fy ?? null,
                    fiscalPeriod: p.fp ?? null,
                    periodStart: p.start ?? null,
                    periodEnd: p.end ?? null,
                    form: p.form ?? null,
                    filed: p.filed ?? null,
                    frame: p.frame ?? null,
                    accession: p.accn ?? null,
                });
                perTicker += 1;
            }
        }
    }
    log.info(`${symbol}: pushed ${perTicker} fundamentals rows.`);
    await sleep(SEC_SLEEP_MS);
}

log.info(`Done. Pushed ${pushed} fundamentals rows.`);
await Actor.exit();

// ---------- core ----------

function resolveLabel(taxonomy, concept) {
    if (includeAllConcepts) return taxonomy === 'us-gaap' ? prettify(concept) : prettify(concept);
    if (metricFilter.size) return metricFilter.has(concept) ? prettify(concept) : null;
    return KEY_METRICS[taxonomy]?.[concept] || null;
}

// flatten {units: {USD: [...], "USD/shares": [...]}} into [{unit, ...point}], deduped
function collectPoints(conceptObj) {
    const out = [];
    const seen = new Set();
    const units = conceptObj?.units || {};
    for (const unit of Object.keys(units)) {
        for (const p of units[unit]) {
            const key = `${p.start || ''}|${p.end || ''}|${p.val}|${p.form || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ unit, ...p });
        }
    }
    return out;
}

function keepPoint(p) {
    if (formSet.size && p.form && !formSet.has(p.form)) return false;
    if (minYearNum) {
        const y = Number(String(p.end || '').slice(0, 4));
        if (Number.isFinite(y) && y < minYearNum) return false;
    }
    return true;
}

function latestPerConcept(points) {
    let best = null;
    for (const p of points) {
        if (!best || String(p.end || '') > String(best.end || '')) best = p;
    }
    return best ? [best] : [];
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'fundamentals_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 100 === 0) log.info(`Pushed ${pushed} rows...`);
}

function done() {
    if (pushed >= maxRowsTotal) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

async function loadCikMap() {
    const data = await fetchJson('https://www.sec.gov/files/company_tickers.json');
    if (!data) return null;
    const map = new Map();
    for (const k of Object.keys(data)) {
        const e = data[k];
        if (e?.ticker && e?.cik_str != null) {
            map.set(String(e.ticker).toUpperCase(), String(e.cik_str).padStart(10, '0'));
        }
    }
    log.info(`Loaded ${map.size} ticker -> CIK mappings.`);
    return map;
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            log.warning(`HTTP ${res.status} for ${url}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`fetch failed ${url}: ${err?.message}`);
        return null;
    }
}

function prettify(concept) {
    return String(concept).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
