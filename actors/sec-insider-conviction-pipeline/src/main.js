// SEC Insider Conviction Pipeline
//
// Stage 1: Call scrapemint/sec-form4-insider-tracker for the requested tickers
//          or CIKs over the lookback window. Each row is one insider
//          transaction (open-market buys carry transaction code P).
// Stage 2: Call scrapemint/sec-8k-event-tracker for the same companies and
//          window. Each row is one material 8-K filing with item codes.
// Stage 3: (optional, opt-in) Call scrapemint/linkedin-company-hiring-tracker
//          for hiring momentum as a growth confirmation. OFF by default: the
//          core signal is 100% SEC EDGAR and has zero antibot exposure. Only
//          runs when the caller supplies an explicit ticker -> LinkedIn URL map.
// Stage 4: Join all sources on issuer CIK. Score each company 0-100 on insider
//          buy intensity + material catalysts + (optional) hiring momentum.
// Stage 5: Tier as high-conviction / accumulation / watch, flag distressed
//          companies, and charge the matching event. First N high-conviction
//          rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_HIGH_CONVICTION = 3;

// 8-K item codes grouped into material catalysts (bullish/neutral, scored) and
// risk flags (bearish, which void a conviction thesis regardless of buying).
const CATALYST_GROUPS = [
    { cat: 'ma', codes: ['1.01', '2.01'], weight: 12, label: 'M&A / material definitive agreement' },
    { cat: 'earnings', codes: ['2.02'], weight: 8, label: 'Earnings / results of operations' },
    { cat: 'exec_change', codes: ['5.02'], weight: 8, label: 'Executive / board change' },
    { cat: 'capital', codes: ['2.03', '3.02'], weight: 5, label: 'Financing / capital event' },
    { cat: 'cyber', codes: ['1.05'], weight: 4, label: 'Material cybersecurity incident' },
];
const RISK_GROUPS = [
    { cat: 'bankruptcy', codes: ['1.03'] },
    { cat: 'non_reliance_restatement', codes: ['4.02'] },
    { cat: 'auditor_change', codes: ['4.01'] },
    { cat: 'delisting', codes: ['3.01'] },
    { cat: 'impairment', codes: ['2.06'] },
    { cat: 'obligation_acceleration', codes: ['2.04'] },
    { cat: 'restructuring_layoffs', codes: ['2.05'] },
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    ciks = [],
    lookbackDays = 90,
    minBuyValueUsd = 0,
    maxItemsTotal = 300,
    includeHiringEnrichment = false,
    linkedinCompanyMap = [],
    userAgent = 'Scrapemint Insider Conviction Pipeline research@scrapemint.com',
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
const cleanCiks = [...new Set((ciks || []).map((c) => String(c).trim()).filter(Boolean))];

if (cleanTickers.length === 0 && cleanCiks.length === 0) {
    log.warning('No tickers or CIKs provided. Pass at least one ticker (e.g. ["AAPL","NVDA"]) or CIK.');
    await Actor.exit();
}

const maxAgeHours = Math.max(24, Math.round(Number(lookbackDays) * 24));
const childInputCommon = {
    tickers: cleanTickers,
    ciks: cleanCiks,
    maxAgeHours,
    maxItemsTotal: Math.max(50, Number(maxItemsTotal) || 300),
    maxItemsPerSource: 100,
    dedupe: false,
    userAgent,
    proxyConfiguration: proxyInput,
};

log.info(`Conviction window: last ${lookbackDays} days for ${cleanTickers.length} tickers + ${cleanCiks.length} CIKs.`);

// ---------- Stage 1: insider transactions (Form 4) ----------
log.info('Stage 1/3: pulling Form 4 insider transactions from EDGAR.');
const form4Run = await Actor.call(
    'scrapemint/sec-form4-insider-tracker',
    { ...childInputCommon, minTransactionValue: Math.max(0, Number(minBuyValueUsd) || 0) },
    { memory: 1024, build: 'latest' },
);
const form4Rows = await readDataset(form4Run, 'Form 4');

// ---------- Stage 2: material events (8-K) ----------
log.info('Stage 2/3: pulling 8-K material events from EDGAR.');
const eightKRun = await Actor.call(
    'scrapemint/sec-8k-event-tracker',
    { ...childInputCommon },
    { memory: 1024, build: 'latest' },
);
const eightKRows = await readDataset(eightKRun, '8-K');

// ---------- Stage 3: optional hiring enrichment (LinkedIn, opt-in) ----------
const hiringByTicker = new Map();
const urlMap = normalizeLinkedinMap(linkedinCompanyMap);
if (includeHiringEnrichment && urlMap.size > 0) {
    log.info(`Stage 3/3: hiring enrichment ON for ${urlMap.size} mapped companies (LinkedIn).`);
    const hiringRun = await Actor.call(
        'scrapemint/linkedin-company-hiring-tracker',
        { companyUrls: [...urlMap.values()], maxRolesScanPerCompany: 200, trackDeltas: true, proxyConfiguration: proxyInput },
        { memory: 2048, build: 'latest' },
    );
    const hiringRows = await readDataset(hiringRun, 'hiring');
    // Re-key hiring rows back to ticker via the URL the caller supplied.
    const urlToTicker = new Map([...urlMap.entries()].map(([tk, url]) => [normalizeLinkedinUrl(url), tk]));
    for (const h of hiringRows) {
        const key = urlToTicker.get(normalizeLinkedinUrl(h.companyUrl)) || urlToTicker.get(normalizeLinkedinUrl(h.companySlug));
        if (key) hiringByTicker.set(key, h);
    }
} else if (includeHiringEnrichment) {
    log.warning('Hiring enrichment requested but no linkedinCompanyMap entries provided. Skipping; scoring on EDGAR only.');
}
const enrichmentActive = hiringByTicker.size > 0;

// ---------- Stage 4: join on CIK and score ----------
const companies = new Map(); // cikKey -> aggregate

for (const r of form4Rows) {
    const cikKey = normCik(r?.issuer?.cik);
    if (!cikKey) continue;
    const agg = getCompany(companies, cikKey, r.issuer);
    const code = r?.transaction?.code;
    const value = Number(r?.transaction?.totalValue) || 0;
    const insiderKey = (r?.insider?.cik || r?.insider?.name || '').toString().toLowerCase().trim();
    const rec = { insiderKey, insiderName: r?.insider?.name || null, title: r?.insider?.title || null, value, date: r?.transaction?.date || r.filingDate || null };
    if (code === 'P') agg.buys.push(rec);
    else if (code === 'S') agg.sells.push(rec);
}

for (const r of eightKRows) {
    const cikKey = normCik(r?.issuer?.cik);
    if (!cikKey) continue;
    const agg = getCompany(companies, cikKey, r.issuer);
    const codes = Array.isArray(r.itemCodes) ? r.itemCodes : (Array.isArray(r.items) ? r.items.map((it) => it.code) : []);
    for (const c of codes) if (c) agg.itemCodes.push(String(c).trim());
    agg.filings.push({ filingDate: r.filingDate || null, url: r.filingUrl || null, itemCodes: codes });
}

log.info(`Joined ${companies.size} unique companies across Form 4 + 8-K. Scoring.`);

let highCharged = 0; let highFree = 0; let accumCharged = 0; let watchCharged = 0;

for (const [cikKey, agg] of companies) {
    const ins = scoreInsider(agg.buys, agg.sells);
    const cat = classifyCatalysts(agg.itemCodes);

    const tickerKey = (agg.ticker || '').toUpperCase();
    const hiring = enrichmentActive ? hiringByTicker.get(tickerKey) : null;
    const hir = scoreHiring(hiring);

    const conviction = enrichmentActive
        ? Math.round((ins.insiderScore / 50) * 50 + (cat.catalystScore / 30) * 30 + (hir.hiringScore / 20) * 20)
        : Math.round((ins.insiderScore / 50) * 60 + (cat.catalystScore / 30) * 40);

    const distressed = cat.riskFlags.length > 0;
    let tier;
    if (distressed) tier = 'watch';
    else if (conviction >= 70 && ins.distinctBuyers >= 2 && cat.catalysts.length >= 1) tier = 'high-conviction';
    else if (ins.distinctBuyers >= 1 && conviction >= 40) tier = 'accumulation';
    else tier = 'watch';

    const row = {
        cik: cikKey,
        ticker: agg.ticker || null,
        company: agg.name || null,
        convictionScore: conviction,
        tier,
        distressed,
        riskFlags: cat.riskFlags,
        insider: {
            distinctBuyers: ins.distinctBuyers,
            buyValueUsd: Math.round(ins.buyValueUsd),
            distinctSellers: ins.distinctSellers,
            sellValueUsd: Math.round(ins.sellValueUsd),
            netBuyValueUsd: Math.round(ins.buyValueUsd - ins.sellValueUsd),
            clusterBuy: ins.distinctBuyers >= 2,
            topBuyers: agg.buys
                .slice()
                .sort((a, b) => (b.value || 0) - (a.value || 0))
                .slice(0, 5)
                .map((b) => ({ name: b.insiderName, title: b.title, valueUsd: Math.round(b.value || 0), date: b.date })),
        },
        catalysts: cat.catalysts,
        catalystDetail: cat.catalystLabels,
        eightKFilings: agg.filings.slice(0, 10),
        hiring: hiring ? { totalOpenRoles: hiring.totalOpenRoles ?? null, hiringTrend: hiring.hiringTrend ?? null, deltaPct: hiring.deltaPct ?? null } : null,
        lookbackDays,
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'high-conviction') {
        if (highFree + highCharged < FREE_TIER_HIGH_CONVICTION) { highFree += 1; }
        else { await charge('high_conviction_company'); highCharged += 1; }
    } else if (tier === 'accumulation') {
        await charge('accumulation_company'); accumCharged += 1;
    } else {
        await charge('watch_company'); watchCharged += 1;
    }
}

log.info(`Done. high_conviction charged=${highCharged} free=${highFree}, accumulation=${accumCharged}, watch=${watchCharged}, total=${companies.size}.`);
await Actor.exit();

// ---------- helpers ----------

async function readDataset(run, label) {
    if (!run?.defaultDatasetId) {
        log.warning(`${label} stage returned no dataset. Continuing with what we have.`);
        return [];
    }
    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const items = (await ds.getData()).items ?? [];
    log.info(`${label} stage: ${items.length} rows from ${run.defaultDatasetId}.`);
    return items;
}

function getCompany(map, cikKey, issuer) {
    let agg = map.get(cikKey);
    if (!agg) {
        agg = { cik: cikKey, name: issuer?.name || null, ticker: issuer?.ticker || null, buys: [], sells: [], itemCodes: [], filings: [] };
        map.set(cikKey, agg);
    }
    // Backfill name/ticker if a later source has them.
    if (!agg.name && issuer?.name) agg.name = issuer.name;
    if (!agg.ticker && issuer?.ticker) agg.ticker = issuer.ticker;
    return agg;
}

function scoreInsider(buys, sells) {
    const distinctBuyers = new Set(buys.map((b) => b.insiderKey).filter(Boolean)).size;
    const distinctSellers = new Set(sells.map((s) => s.insiderKey).filter(Boolean)).size;
    const buyValueUsd = buys.reduce((a, b) => a + (b.value || 0), 0);
    const sellValueUsd = sells.reduce((a, b) => a + (b.value || 0), 0);
    const base = distinctBuyers >= 4 ? 45 : ({ 0: 0, 1: 15, 2: 28, 3: 38 })[distinctBuyers];
    const valueBonus = buyValueUsd >= 1_000_000 ? 5 : buyValueUsd >= 250_000 ? 3 : buyValueUsd >= 50_000 ? 1 : 0;
    const insiderScore = distinctBuyers === 0 ? 0 : Math.min(50, base + valueBonus);
    return { insiderScore, distinctBuyers, distinctSellers, buyValueUsd, sellValueUsd };
}

function classifyCatalysts(itemCodes) {
    const set = new Set(itemCodes);
    const has = (c) => set.has(c);
    const catalysts = [];
    const catalystLabels = [];
    let catalystScore = 0;
    for (const g of CATALYST_GROUPS) {
        if (g.codes.some(has)) { catalysts.push(g.cat); catalystLabels.push(g.label); catalystScore += g.weight; }
    }
    const riskFlags = [];
    for (const g of RISK_GROUPS) if (g.codes.some(has)) riskFlags.push(g.cat);
    return { catalystScore: Math.min(30, catalystScore), catalysts, catalystLabels, riskFlags };
}

function scoreHiring(hiring) {
    if (!hiring) return { hiringScore: 0 };
    const roles = Number(hiring.totalOpenRoles) || 0;
    const roleScore = Math.min(10, roles / 5);
    const trend = hiring.hiringTrend;
    const deltaPct = Number(hiring.deltaPct) || 0;
    const trendScore = trend === 'ramping' ? Math.min(10, deltaPct / 10) : trend === 'baseline' ? 4 : 0;
    return { hiringScore: Math.min(20, roleScore + trendScore) };
}

function normCik(cik) {
    if (cik == null) return null;
    const s = String(cik).replace(/[^0-9]/g, '').replace(/^0+/, '');
    return s || null;
}

function normalizeLinkedinMap(map) {
    const out = new Map();
    if (!Array.isArray(map)) return out;
    for (const entry of map) {
        if (!entry) continue;
        const tk = String(entry.ticker || '').trim().toUpperCase();
        const url = String(entry.companyUrl || entry.url || '').trim();
        if (tk && url) out.set(tk, url);
    }
    return out;
}

function normalizeLinkedinUrl(u) {
    if (!u) return '';
    const m = String(u).match(/company\/([^/?#]+)/i);
    return (m ? m[1] : String(u)).toLowerCase().replace(/\/+$/, '').trim();
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
