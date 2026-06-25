// Activist Stake Catalyst Pipeline
//
// For each ticker, finds recent activist / large-holder filings (Schedule 13D and
// 13G) on EDGAR and correlates them with insider open-market buying in a window
// around the filing. A 13D (intent to influence) landing while company insiders
// are also buying their own stock is a far stronger setup than either alone.
//
// Stage 1 (inline EDGAR, keyless): resolve ticker -> CIK via the SEC
//   company_tickers map, then EDGAR full-text search for SC 13D / SC 13G filings
//   whose `ciks` array contains the SUBJECT company CIK. Filtering on the subject
//   CIK (not a name match) avoids the full-text-search trap where a filing merely
//   MENTIONS the company. 13D = activist intent, 13G = passive >5% holder.
// Stage 2: scrapemint/sec-form4-insider-tracker -> insider open-market buys/sells
//   (transaction codes P and S) for the same tickers.
// Stage 3: per filing, attach insider buys/sells in the window, score 0-100, tier
//   activist_confirmed / accumulation / watch, push, charge.
//
// Both data sources are plain EDGAR HTTP/JSON (no browser, no residential proxy),
// so compute per run is tiny and the per-event price stays well above it.
//
// Nested billing: the Form 4 child also bills the buyer for its own per-event
// usage (insider transaction). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_CONFIRMED = 1;
const EDGAR_RATE_SLEEP_MS = 130;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    maxAgeDays = 90,
    insiderWindowDays = 21,
    formTypes = ['SC 13D', 'SC 13G'],
    includeInsider = true,
    minScore = 0,
    maxFilingsPerCompany = 25,
    maxFilingsTotal = 200,
    userAgent: userAgentInput = '',
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
if (cleanTickers.length === 0) {
    throw new Error('Provide at least one ticker in tickers, e.g. ["DIS", "BHC", "MSFT"].');
}

const wantForms = new Set((Array.isArray(formTypes) ? formTypes : ['SC 13D', 'SC 13G'])
    .map((f) => String(f).trim().toUpperCase()));
const want13D = [...wantForms].some((f) => f.includes('13D'));
const want13G = [...wantForms].some((f) => f.includes('13G'));

const windowMs = Math.max(1, Number(insiderWindowDays) || 21) * 864e5;
const maxAgeMs = Math.max(1, Number(maxAgeDays) || 90) * 864e5;
const perCompanyCap = Math.max(1, Number(maxFilingsPerCompany) || 25);
const totalCap = Math.max(1, Math.min(1000, Number(maxFilingsTotal) || 200));

const userAgent = String(userAgentInput).trim()
    || 'scrapemint-activist-stake-catalyst research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses.');
}
const headers = { 'User-Agent': userAgent, 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' };

const startdt = new Date(Date.now() - maxAgeMs).toISOString().slice(0, 10);
const enddt = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

// ---------- Stage 1: resolve tickers, pull 13D/13G filings ----------
log.info(`Stage 1: EDGAR activist filings (${[...wantForms].join(', ')}) since ${startdt} for ${cleanTickers.join(', ')}.`);

const tickerMap = await loadTickerMap();
const subjects = [];
for (const t of cleanTickers) {
    const entry = tickerMap.get(t);
    if (!entry) { log.warning(`Ticker ${t} not found in SEC company map. Skipping.`); continue; }
    subjects.push({ ticker: t, cik: String(entry.cik), company: entry.title });
}
if (subjects.length === 0) {
    log.warning('No tickers resolved to a CIK. Nothing to scan.');
    await Actor.exit();
}

let filings = [];
for (const s of subjects) {
    if (filings.length >= totalCap) break;
    const rows = await fetchActivistFilings(s);
    log.info(`${s.ticker} (${s.company}): ${rows.length} activist filings in range.`);
    filings.push(...rows);
}
filings.sort((a, b) => (b.fileDateMs || 0) - (a.fileDateMs || 0));
filings = filings.slice(0, totalCap);

if (filings.length === 0) {
    log.warning('No 13D/13G filings found in range. Nothing to score.');
    await Actor.exit();
}

// ---------- Stage 2: insider open-market buys/sells ----------
const txByTicker = new Map();
if (includeInsider) {
    log.info('Stage 2: SEC Form 4 insider transactions (open-market buys and sells).');
    try {
        const run = await Actor.call(
            'scrapemint/sec-form4-insider-tracker',
            {
                tickers: subjects.map((s) => s.ticker),
                transactionCodes: ['P', 'S'],
                includeDerivative: false,
                includeNonDerivative: true,
                // Reach back past the oldest filing plus the window on both sides.
                // The Form 4 child caps maxAgeHours at 17520 (730 days), so clamp.
                maxAgeHours: Math.min(17520, Math.ceil(maxAgeMs / 36e5) + insiderWindowDays * 24),
                maxItemsPerSource: 200,
                maxItemsTotal: 600,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        for (const t of (await readDataset(run, 'Form 4')).map(normTx).filter(Boolean)) {
            if (!txByTicker.has(t.key)) txByTicker.set(t.key, []);
            txByTicker.get(t.key).push(t);
        }
    } catch (err) {
        log.warning(`Form 4 stage failed (continuing without insider data): ${err?.message}`);
    }
}

// ---------- Stage 3: join, score, tier, push, charge ----------
log.info(`Scoring ${filings.length} filings.`);
let confirmedCharged = 0; let confirmedFree = 0; let accumulation = 0; let watch = 0; let skipped = 0;

for (const f of filings) {
    const all = txByTicker.get(f.ticker) || [];
    const inWindow = f.fileDateMs
        ? all.filter((t) => t.dateMs && Math.abs(t.dateMs - f.fileDateMs) <= windowMs)
        : [];
    const buys = inWindow.filter((t) => t.code === 'P');
    const sells = inWindow.filter((t) => t.code === 'S');
    const buyValue = buys.reduce((s, t) => s + t.value, 0);
    const sellValue = sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;
    const netBuying = buys.length > 0 && netValue > 0;

    const formScore = f.is13D ? (f.isAmendment ? 35 : 45) : 20;
    const recScore = recency(f.fileDateMs);
    const insiderScore = scoreInsider(buys, buyValue, netValue);
    const edgeScore = Math.min(100, Math.round(formScore + recScore + insiderScore));
    if (edgeScore < minScore) { skipped += 1; continue; }

    const recentDays = f.fileDateMs ? (Date.now() - f.fileDateMs) / 864e5 : Infinity;
    let tier;
    if (f.is13D && (recentDays <= 30 || netBuying)) tier = 'activist_confirmed';
    else if (f.is13D || netBuying) tier = 'accumulation';
    else tier = 'watch';

    const row = {
        ticker: f.ticker,
        company: f.company,
        cik: f.cik,
        filingType: f.formLabel,
        isAmendment: f.isAmendment,
        filerName: f.filerName,
        filerCik: f.filerCik,
        intent: f.is13D ? 'activist (intent to influence)' : 'passive (>5% holder)',
        fileDate: f.fileDate,
        daysAgo: f.fileDateMs ? Math.round(recentDays) : null,
        filingUrl: f.filingUrl,
        accessionNumber: f.accession,
        edgeScore,
        tier,
        insider: {
            windowDays: Math.max(1, Number(insiderWindowDays) || 21),
            buyCount: buys.length,
            sellCount: sells.length,
            buyValueUsd: Math.round(buyValue),
            sellValueUsd: Math.round(sellValue),
            netValueUsd: Math.round(netValue),
            topBuys: buys.slice().sort((a, b) => b.value - a.value).slice(0, 3)
                .map((t) => ({ insider: t.insider, role: t.role, shares: t.shares, price: t.price, valueUsd: Math.round(t.value), date: t.date })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'activist_confirmed') {
        if (confirmedFree + confirmedCharged < FREE_TIER_CONFIRMED) confirmedFree += 1;
        else { await charge('activist_confirmed'); confirmedCharged += 1; }
    } else if (tier === 'accumulation') {
        await charge('accumulation'); accumulation += 1;
    } else {
        await charge('watch'); watch += 1;
    }
}

log.info(`Done. activist_confirmed charged=${confirmedCharged} free=${confirmedFree}, accumulation=${accumulation}, watch=${watch}, below-gate=${skipped}.`);
await Actor.exit();

// ---------- Stage 1 helpers ----------

async function loadTickerMap() {
    const map = new Map();
    const data = await fetchJsonWithRetry('https://www.sec.gov/files/company_tickers.json');
    if (!data) { log.warning('Could not load SEC company_tickers map.'); return map; }
    for (const v of Object.values(data)) {
        if (v?.ticker) map.set(String(v.ticker).toUpperCase(), { cik: v.cik_str, title: v.title });
    }
    return map;
}

// EDGAR's full-text search (efts) and static endpoints return intermittent 500/503
// responses under load. A transient 500 here would silently look like "no filings",
// so retry a few times with backoff before giving up.
async function fetchJsonWithRetry(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        await sleep(EDGAR_RATE_SLEEP_MS + i * 400);
        try {
            const res = await fetch(url, { headers });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue; // transient, retry
            log.warning(`EDGAR HTTP ${res.status} for ${url}`);
            return null; // 4xx other than 429 will not improve on retry
        } catch (err) {
            if (i === attempts - 1) log.warning(`EDGAR fetch failed for ${url}: ${err?.message}`);
        }
    }
    return null;
}

// EDGAR full-text search for activist filings, filtered to those whose ciks array
// contains the SUBJECT company CIK. Pages until the per-company cap is hit.
async function fetchActivistFilings(subject) {
    const out = [];
    const seenAcc = new Set();
    const subjCik = String(subject.cik).replace(/^0+/, '');
    const formsParam = encodeURIComponent([...wantForms].join(','));
    const q = encodeURIComponent(`"${cleanName(subject.company)}"`);

    for (let from = 0; from < 100 && out.length < perCompanyCap; from += 10) {
        const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=${formsParam}&startdt=${startdt}&enddt=${enddt}&from=${from}`;
        const data = await fetchJsonWithRetry(url);
        if (!data) { log.warning(`efts returned no data for ${subject.ticker} (from=${from}).`); break; }
        const hits = data?.hits?.hits || [];
        if (hits.length === 0) break;

        for (const h of hits) {
            const s = h._source || {};
            const ciks = (s.ciks || []).map((c) => String(c).replace(/^0+/, ''));
            if (!ciks.includes(subjCik)) continue; // subject must be on the filing, not just mentioned
            const accession = String(h._id || '').split(':')[0];
            if (!accession || seenAcc.has(accession)) continue;
            seenAcc.add(accession);

            const rootForm = String((s.root_forms && s.root_forms[0]) || s.file_type || '').toUpperCase();
            const fileType = String(s.file_type || '').toUpperCase();
            const is13D = rootForm.includes('13D');
            const is13G = rootForm.includes('13G');
            if (is13D && !want13D) continue;
            if (is13G && !want13G) continue;
            if (!is13D && !is13G) continue;
            const isAmendment = /\/A/.test(fileType) || /\/A/.test(rootForm);

            // Filer (activist) is the display_name whose CIK is not the subject.
            let filerName = null; let filerCik = null;
            const names = s.display_names || [];
            for (let i = 0; i < ciks.length; i++) {
                if (ciks[i] !== subjCik) { filerName = stripCik(names[i]); filerCik = ciks[i]; break; }
            }

            const accNd = accession.replace(/-/g, '');
            const formLabel = `${is13D ? 'SC 13D' : 'SC 13G'}${isAmendment ? '/A' : ''}`;
            out.push({
                ticker: subject.ticker,
                company: subject.company,
                cik: subjCik,
                accession,
                formLabel,
                is13D,
                isAmendment,
                filerName,
                filerCik,
                fileDate: s.file_date || null,
                fileDateMs: Date.parse(s.file_date || '') || null,
                filingUrl: `https://www.sec.gov/Archives/edgar/data/${subjCik}/${accNd}/${accession}-index.htm`,
            });
            if (out.length >= perCompanyCap) break;
        }
        if (hits.length < 10) break;
    }
    return out;
}

function cleanName(name) {
    return String(name || '')
        .replace(/[",]/g, ' ')
        .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|llc|plc|holdings|group|the)\b\.?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || String(name || '').trim();
}

function stripCik(displayName) {
    return String(displayName || '').replace(/\s*\(CIK\s*\d+\)\s*$/i, '').trim() || null;
}

// ---------- Stage 2 helpers ----------

function normTx(t) {
    const issuer = t.issuer || {};
    const insider = t.insider || {};
    const tx = t.transaction || {};
    const code = String(tx.code || '').toUpperCase();
    if (code !== 'P' && code !== 'S') return null;
    const key = (issuer.ticker || '').toUpperCase() || null;
    if (!key) return null;
    return {
        key,
        code,
        date: tx.date || null,
        dateMs: Date.parse(tx.date || '') || null,
        shares: num(tx.shares),
        price: num(tx.pricePerShare),
        value: num(tx.totalValue) || (num(tx.shares) * num(tx.pricePerShare)),
        insider: insider.name || null,
        role: insider.title || (insider.isDirector ? 'Director' : insider.isOfficer ? 'Officer' : insider.isTenPercentOwner ? '10% Owner' : null),
    };
}

// ---------- scoring ----------

function scoreInsider(buys, buyValue, netValue) {
    if (buys.length === 0) return 0;
    let s = buyValue >= 1_000_000 ? 20 : buyValue >= 250_000 ? 14 : buyValue >= 50_000 ? 8 : buyValue > 0 ? 4 : 0;
    s += buys.length >= 3 ? 8 : buys.length === 2 ? 5 : 2;
    if (netValue > 0) s += 5;
    return Math.min(35, s);
}

function recency(ms) {
    if (!ms) return 3;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 7) return 20;
    if (d <= 30) return 14;
    if (d <= 60) return 8;
    return 3;
}

// ---------- shared helpers ----------

async function readDataset(run, label) {
    if (!run?.defaultDatasetId) { log.warning(`${label} stage returned no dataset. Continuing.`); return []; }
    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const items = (await ds.getData()).items ?? [];
    log.info(`${label} stage: ${items.length} rows from ${run.defaultDatasetId}.`);
    return items;
}

function num(v) {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
