// Stock Market Fundamentals Scraper
// Financial-statement line items (revenue, net income, EPS, assets, cash flow,
// etc.) per ticker, straight from SEC XBRL company facts. Keyless, no browser.
//
// Endpoints (keyless JSON, SEC requires a descriptive User-Agent with an email):
//   https://www.sec.gov/files/company_tickers.json            -> ticker -> CIK map
//   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json -> all facts
//   https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/{unit}/{period}.json -> screener
//
// Two modes:
//   tickers  (default) one row per company/metric/period, from companyfacts
//   screener one row per COMPANY with every requested metric side by side, from
//            frames. companyfacts is one company and every metric; frames is the
//            inverse (one metric, every filer), so joining a few frames calls on
//            CIK turns the lookup into a cross-sectional screener.
//
// Free tier: first 15 rows per run are free, then each fundamentals row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 15;
const HEADERS = {
    'User-Agent': 'Scrapemint Fundamentals Scraper contact@scrapemint.com',
    Accept: 'application/json',
};
const SEC_SLEEP_MS = 160; // SEC allows ~10 req/sec; stay polite
const MIN_COVERAGE = 1000; // screener: filers a period needs before it is auto-selected

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

// Screener metrics. `tags` are tried in order and coalesced per company: filers
// split between Revenues and the newer contract-revenue tag, and taking only the
// first roughly halves coverage (1931 companies vs 3911 for the union).
// `instant` marks balance-sheet (point-in-time) concepts, whose frames period
// needs an "I" suffix -- Assets/USD/CY2025Q1 is a 404, Assets/USD/CY2025Q1I is not.
const SCREENER_METRICS = {
    revenue: { tags: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'], unit: 'USD', instant: false },
    netIncome: { tags: ['NetIncomeLoss'], unit: 'USD', instant: false },
    grossProfit: { tags: ['GrossProfit'], unit: 'USD', instant: false },
    operatingIncome: { tags: ['OperatingIncomeLoss'], unit: 'USD', instant: false },
    rndExpense: { tags: ['ResearchAndDevelopmentExpense'], unit: 'USD', instant: false },
    operatingCashFlow: { tags: ['NetCashProvidedByUsedInOperatingActivities'], unit: 'USD', instant: false },
    epsDiluted: { tags: ['EarningsPerShareDiluted'], unit: 'USD-per-shares', instant: false },
    assets: { tags: ['Assets'], unit: 'USD', instant: true },
    liabilities: { tags: ['Liabilities'], unit: 'USD', instant: true },
    equity: { tags: ['StockholdersEquity'], unit: 'USD', instant: true },
    cash: { tags: ['CashAndCashEquivalentsAtCarryingValue'], unit: 'USD', instant: true },
};

// Stripped before comparing entity names. Only used as a fallback when the CIK
// join fails, and only on an exact match after normalising.
const NAME_SUFFIXES = /\b(corp|corporation|inc|incorporated|holdings|holding|company|co|plc|ltd|limited|lp|llc|group|the|sa|nv|ag)\b/g;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'tickers',
    tickers = [],
    metrics = [],
    includeAllConcepts = false,
    forms = ['10-K', '10-Q'],
    minYear,
    latestOnly = false,
    maxRowsPerTicker = 5000,
    maxRowsTotal = 50000,
    // screener mode
    screenerMetrics = ['revenue', 'netIncome', 'assets', 'equity'],
    period = '',
    sortBy = '',
    sortOrder = 'desc',
    maxCompanies = 100,
    tickersOnly = false,
} = input;

const symbols = (Array.isArray(tickers) ? tickers : [])
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);

const isScreener = String(mode) === 'screener';

if (!isScreener && symbols.length === 0) {
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
const cikToTicker = new Map();
const nameToTicker = new Map();
// declared here, not beside fetchFrame, because the screener runs at top level
// before a const further down the file would be initialised
const frameCache = new Map();

// ticker -> CIK
const cikMap = await loadCikMap();
if (!cikMap) {
    log.warning('Could not load SEC ticker -> CIK map; aborting.');
    await Actor.exit();
}

if (isScreener) {
    await runScreener();
    log.info(`Done. Pushed ${pushed} screener rows.`);
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

// ---------- screener mode ----------

async function runScreener() {
    const wanted = (Array.isArray(screenerMetrics) ? screenerMetrics : [])
        .map((m) => String(m).trim())
        .filter((m) => SCREENER_METRICS[m]);
    if (!wanted.length) {
        log.warning(`No valid screener metrics. Choose from: ${Object.keys(SCREENER_METRICS).join(', ')}.`);
        return;
    }
    const sortKey = SCREENER_METRICS[sortBy] ? sortBy : wanted[0];
    if (!wanted.includes(sortKey)) wanted.push(sortKey);

    const resolved = await resolvePeriod(sortKey);
    if (!resolved) {
        log.warning('Could not find a period with data for the sort metric; try setting "period" explicitly (e.g. CY2025Q1).');
        return;
    }
    log.info(`Screener period ${resolved}, metrics: ${wanted.join(', ')}.`);

    // cik -> { entityName, loc, <metric>: value, ... }
    const companies = new Map();
    for (const metric of wanted) {
        if (done()) break;
        const rows = await fetchFrame(metric, resolved);
        if (!rows) {
            log.warning(`No data for metric "${metric}" in ${resolved}; leaving it null.`);
            continue;
        }
        for (const r of rows) {
            if (r?.cik == null || r.val == null) continue;
            let e = companies.get(r.cik);
            if (!e) {
                e = { cik: r.cik, entityName: r.entityName ?? null, loc: r.loc ?? null };
                companies.set(r.cik, e);
            }
            // first tag wins: SCREENER_METRICS.tags are ordered by preference
            if (e[metric] == null) {
                e[metric] = r.val;
                e[`${metric}Accession`] = r.accn ?? null;
                e[`${metric}PeriodEnd`] = r.end ?? null;
            }
        }
        await sleep(SEC_SLEEP_MS);
    }

    let out = [...companies.values()].filter((e) => e[sortKey] != null);
    for (const e of out) Object.assign(e, resolveTicker(e.cik, e.entityName));
    if (tickersOnly) out = out.filter((e) => e.ticker);

    const dir = String(sortOrder) === 'asc' ? 1 : -1;
    // cik is the tiebreak so equal sort values cannot collide into an unstable order
    out.sort((a, b) => (a[sortKey] - b[sortKey]) * dir || a.cik - b.cik);

    const limit = Math.max(1, Number(maxCompanies) || 100);
    out = out.slice(0, limit);
    log.info(`${companies.size} filers reported in ${resolved}; emitting ${out.length}.`);

    for (const e of out) {
        if (done()) break;
        await pushRow({
            ticker: e.ticker,
            tickerSource: e.tickerSource,
            entityName: e.entityName,
            cik: e.cik,
            loc: e.loc,
            period: resolved,
            ...Object.fromEntries(wanted.flatMap((m) => [
                [m, e[m] ?? null],
                [`${m}Accession`, e[`${m}Accession`] ?? null],
            ])),
            ...derivedRatios(e),
            sortedBy: sortKey,
        });
    }
}

// Ratios are only emitted when BOTH inputs are present and the denominator is
// non-zero. Returning null (not 0) matters: a missing metric coerced to 0 would
// publish as a real ratio and read as a genuine measurement.
function derivedRatios(e) {
    return {
        netMarginPct: pct(e.netIncome, e.revenue),
        grossMarginPct: pct(e.grossProfit, e.revenue),
        operatingMarginPct: pct(e.operatingIncome, e.revenue),
        roaPct: pct(e.netIncome, e.assets),
        roePct: pct(e.netIncome, e.equity),
    };
}

function pct(num, den) {
    if (num == null || den == null) return null;
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return Math.round((n / d) * 10000) / 100;
}

// Tries each tag for the metric and returns the first that has data. Balance-sheet
// concepts need the "I" period suffix; the other suffix is tried as a fallback so
// a concept mis-classified here degrades to one extra request, not a 404.
// Results are cached (frameCache, declared up top) because period resolution
// fetches the same frames the main join then needs.
async function fetchFrame(metric, per) {
    const cacheKey = `${metric}|${per}`;
    if (frameCache.has(cacheKey)) return frameCache.get(cacheKey);
    const spec = SCREENER_METRICS[metric];
    const suffixes = spec.instant ? ['I', ''] : ['', 'I'];
    let out = null;
    for (const tag of spec.tags) {
        if (out) break;
        for (const suffix of suffixes) {
            const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${spec.unit}/${per}${suffix}.json`;
            const data = await fetchJson(url, { quiet: true });
            if (data?.data?.length) { out = data.data; break; }
        }
    }
    frameCache.set(cacheKey, out);
    return out;
}

// A cross-sectional screener is only meaningful on a period most filers actually
// reported, and two kinds of period look "live" but are nearly empty:
//   - the current quarter, which fills up over filing season
//   - EVERY Q4, because companies report Q4 inside the annual 10-K rather than a
//     10-Q, so discrete Q4 facts barely exist (CY2025Q4 has 477 filers against
//     2350 in Q3)
// So auto-resolution walks back to the newest period clearing MIN_COVERAGE (set
// up top), and only falls back to the best it saw if nothing clears it.
async function resolvePeriod(sortKey) {
    if (period) return String(period).trim().replace(/I$/, '');
    const now = new Date();
    let y = now.getUTCFullYear();
    let q = Math.floor(now.getUTCMonth() / 3) + 1;
    let best = null;
    let bestCount = 0;
    for (let i = 0; i < 8; i += 1) {
        const candidate = `CY${y}Q${q}`;
        const rows = await fetchFrame(sortKey, candidate);
        const count = rows?.length ?? 0;
        if (count >= MIN_COVERAGE) return candidate;
        if (count > bestCount) { best = candidate; bestCount = count; }
        q -= 1;
        if (q === 0) { q = 4; y -= 1; }
    }
    if (best) log.warning(`No period reached ${MIN_COVERAGE} filers; using ${best} with ${bestCount}.`);
    return best;
}

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
    const byName = new Map();
    for (const k of Object.keys(data)) {
        const e = data[k];
        if (e?.ticker && e?.cik_str != null) {
            const ticker = String(e.ticker).toUpperCase();
            map.set(ticker, String(e.cik_str).padStart(10, '0'));
            // reverse maps, used by screener mode
            if (!cikToTicker.has(Number(e.cik_str))) cikToTicker.set(Number(e.cik_str), ticker);
            const n = normName(e.title);
            if (n) {
                if (!byName.has(n)) byName.set(n, new Set());
                byName.get(n).add(ticker);
            }
        }
    }
    // Ambiguous names (multiple share classes such as Alphabet's GOOG/GOOGL) are
    // dropped rather than guessed: a wrong ticker is worse than a null one.
    for (const [n, set] of byName) if (set.size === 1) nameToTicker.set(n, [...set][0]);
    log.info(`Loaded ${map.size} ticker -> CIK mappings.`);
    return map;
}

function normName(s) {
    return String(s || '').toLowerCase().replace(NAME_SUFFIXES, '').replace(/[^a-z0-9]/g, '');
}

// A company that reorganises under a new holdco files XBRL under its OLD CIK
// while SEC's ticker file already points at the NEW one, so the CIK join alone
// silently drops it (Exxon: data under CIK 34088, XOM mapped to CIK 2115436).
// Fall back to an exact normalised-name match, and record which path was used.
function resolveTicker(cik, entityName) {
    const direct = cikToTicker.get(Number(cik));
    if (direct) return { ticker: direct, tickerSource: 'cik' };
    const byName = nameToTicker.get(normName(entityName));
    if (byName) return { ticker: byName, tickerSource: 'name' };
    return { ticker: null, tickerSource: null };
}

async function fetchJson(url, { quiet = false } = {}) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            // screener probes expect 404s while resolving period/tag variants
            if (!quiet || res.status !== 404) log.warning(`HTTP ${res.status} for ${url}`);
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
