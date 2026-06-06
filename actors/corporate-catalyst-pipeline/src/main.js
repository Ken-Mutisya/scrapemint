// Corporate Catalyst Pipeline
//
// For each ticker, correlates a material 8-K event with insider open-market
// buying in a window around it. Insiders putting their own money in right when
// the company files a material event is a far stronger signal than either alone.
//
// Stage 1: scrapemint/sec-8k-event-tracker      -> material 8-K events.
// Stage 2: scrapemint/sec-form4-insider-tracker -> insider transactions, pulled
//          as open-market buys and sells only (transactionCodes P and S).
// Stage 3: Per material 8-K, attach insider buys/sells within the window,
//          score conviction 0-100, tier, push, charge.
//
// Both children are plain EDGAR HTTP/JSON (no browser, no residential proxy), so
// compute per run is tiny and the per-event price stays well above it.
//
// Nested billing: each child also bills the buyer for its own per-event usage
// (8-K filing, Form 4 transaction). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_HIGH = 1;

// 8-K item codes by how much they move a stock.
const HIGH_MATERIAL = new Set(['1.01', '1.03', '2.01', '2.04', '2.06', '4.02', '5.01']);
const MED_MATERIAL = new Set(['1.02', '2.02', '2.03', '2.05', '3.01', '5.02', '8.01']);
// Everything else (9.01 exhibits, 5.03, 5.05, 5.07 votes, 7.01 reg FD) is routine.

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    ciks = [],
    maxAgeHours = 720,
    insiderWindowDays = 14,
    materialOnly = true,
    minScore = 0,
    maxEventsTotal = 100,
    includeInsider = true,
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
const cleanCiks = [...new Set((ciks || []).map((c) => String(c).trim()).filter(Boolean))];
const windowMs = Math.max(1, Number(insiderWindowDays) || 14) * 864e5;

if (cleanTickers.length === 0 && cleanCiks.length === 0) {
    throw new Error('Provide at least one ticker in tickers or one CIK in ciks.');
}

// ---------- Stage 1: material 8-K events ----------
log.info('Stage 1: SEC 8-K event tracker.');
let events = [];
try {
    const run = await Actor.call(
        'scrapemint/sec-8k-event-tracker',
        {
            tickers: cleanTickers,
            ciks: cleanCiks,
            includeAmendments: true,
            maxAgeHours,
            maxItemsPerSource: 100,
            maxItemsTotal: 400,
            dedupe: true,
            proxyConfiguration: proxyInput,
        },
        { memory: 512, build: 'latest' },
    );
    events = (await readDataset(run, '8-K')).map(normEvent).filter((e) => e.ticker || e.cik);
} catch (err) {
    log.warning(`8-K stage failed: ${err?.message}`);
}

if (materialOnly) events = events.filter((e) => e.materialWeight > 8);

if (events.length === 0) {
    log.warning('No 8-K events in range. Nothing to score.');
    await Actor.exit();
}

events.sort((a, b) => (b.eventMs || 0) - (a.eventMs || 0));
events = events.slice(0, Math.max(1, Math.min(400, Number(maxEventsTotal) || 100)));

// ---------- Stage 2: insider open-market buys/sells ----------
const txByTicker = new Map(); // ticker/cik key -> [tx]
if (includeInsider) {
    log.info('Stage 2: SEC Form 4 insider transactions (open-market buys and sells).');
    try {
        const run = await Actor.call(
            'scrapemint/sec-form4-insider-tracker',
            {
                tickers: cleanTickers,
                ciks: cleanCiks,
                // P = open-market purchase, S = open-market sale. The conviction
                // signal lives here; grants/tax/exercise codes are noise.
                transactionCodes: ['P', 'S'],
                includeDerivative: false,
                includeNonDerivative: true,
                // Reach back far enough to catch buys before older 8-Ks too.
                maxAgeHours: Number(maxAgeHours) + Math.max(1, Number(insiderWindowDays) || 14) * 24,
                maxItemsPerSource: 200,
                maxItemsTotal: 600,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        for (const t of (await readDataset(run, 'Form 4')).map(normTx).filter(Boolean)) {
            const key = t.key;
            if (!txByTicker.has(key)) txByTicker.set(key, []);
            txByTicker.get(key).push(t);
        }
    } catch (err) {
        log.warning(`Form 4 stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 3: join, score, tier, push, charge ----------
log.info(`Scoring ${events.length} events.`);
let highCharged = 0; let highFree = 0; let elevated = 0; let watch = 0; let skipped = 0;

for (const e of events) {
    const key = e.ticker || e.cik;
    const all = txByTicker.get(key) || [];
    const inWindow = e.eventMs
        ? all.filter((t) => t.dateMs && Math.abs(t.dateMs - e.eventMs) <= windowMs)
        : [];

    const buys = inWindow.filter((t) => t.code === 'P');
    const sells = inWindow.filter((t) => t.code === 'S');
    const buyValue = buys.reduce((s, t) => s + t.value, 0);
    const sellValue = sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;

    const insiderScore = scoreInsider(buys, sells, buyValue, netValue);
    const proximityScore = proximity(e.eventMs);
    const edgeScore = Math.min(100, Math.round(e.materialWeight + insiderScore + proximityScore));

    if (edgeScore < minScore) { skipped += 1; continue; }

    const material = e.materialWeight >= 28;
    const netBuying = buys.length > 0 && netValue > 0;
    let tier;
    if (material && netBuying && edgeScore >= 60) tier = 'high_conviction';
    else if (material || buys.length > 0) tier = 'elevated';
    else tier = 'watch';

    const row = {
        ticker: e.ticker,
        company: e.company,
        cik: e.cik,
        eventType: '8-K',
        items: e.items,
        topItem: e.topItem,
        materiality: e.materialWeight >= 45 ? 'high' : e.materialWeight >= 28 ? 'medium' : 'routine',
        reportDate: e.reportDate,
        filingDate: e.filingDate,
        filingUrl: e.filingUrl,
        daysAgo: e.eventMs ? Math.round((Date.now() - e.eventMs) / 864e5) : null,
        edgeScore,
        tier,
        insider: {
            windowDays: Math.max(1, Number(insiderWindowDays) || 14),
            buyCount: buys.length,
            sellCount: sells.length,
            buyValueUsd: Math.round(buyValue),
            sellValueUsd: Math.round(sellValue),
            netValueUsd: Math.round(netValue),
            topBuys: buys
                .slice()
                .sort((a, b) => b.value - a.value)
                .slice(0, 3)
                .map((t) => ({ insider: t.insider, role: t.role, shares: t.shares, price: t.price, valueUsd: Math.round(t.value), date: t.date })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'high_conviction') {
        if (highFree + highCharged < FREE_TIER_HIGH) highFree += 1;
        else { await charge('catalyst_high_conviction'); highCharged += 1; }
    } else if (tier === 'elevated') {
        await charge('catalyst_elevated'); elevated += 1;
    } else {
        await charge('catalyst_watch'); watch += 1;
    }
}

log.info(`Done. high_conviction charged=${highCharged} free=${highFree}, elevated=${elevated}, watch=${watch}, below-gate=${skipped}.`);
await Actor.exit();

// ---------- normalizers ----------

function normEvent(e) {
    const issuer = e.issuer || {};
    const codes = Array.isArray(e.itemCodes) ? e.itemCodes : (Array.isArray(e.items) ? e.items.map((i) => i.code) : []);
    const itemsDetail = Array.isArray(e.items) ? e.items.map((i) => ({ code: i.code, description: i.description })) : [];
    const materialWeight = codes.reduce((m, c) => Math.max(m, HIGH_MATERIAL.has(c) ? 45 : MED_MATERIAL.has(c) ? 28 : 8), 0);
    const topItem = itemsDetail
        .slice()
        .sort((a, b) => (HIGH_MATERIAL.has(b.code) ? 2 : MED_MATERIAL.has(b.code) ? 1 : 0) - (HIGH_MATERIAL.has(a.code) ? 2 : MED_MATERIAL.has(a.code) ? 1 : 0))[0] || null;
    const eventMs = Date.parse(e.reportDate || e.filingDate || '') || null;
    return {
        ticker: (issuer.ticker || '').toUpperCase() || null,
        company: issuer.name || null,
        cik: issuer.cik || null,
        items: itemsDetail,
        topItem,
        materialWeight,
        reportDate: e.reportDate || null,
        filingDate: e.filingDate || null,
        filingUrl: e.filingUrl || e.indexUrl || null,
        eventMs,
    };
}

function normTx(t) {
    const issuer = t.issuer || {};
    const insider = t.insider || {};
    const tx = t.transaction || {};
    const code = String(tx.code || '').toUpperCase();
    if (code !== 'P' && code !== 'S') return null;
    const key = (issuer.ticker || '').toUpperCase() || issuer.cik || null;
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

function scoreInsider(buys, sells, buyValue, netValue) {
    if (buys.length === 0) return 0;
    let s = buyValue >= 1_000_000 ? 20 : buyValue >= 250_000 ? 14 : buyValue >= 50_000 ? 8 : buyValue > 0 ? 4 : 0;
    s += buys.length >= 3 ? 8 : buys.length === 2 ? 5 : 2;
    if (buys.length > sells.length && netValue > 0) s += 5;
    return Math.min(35, s);
}

function proximity(eventMs) {
    if (!eventMs) return 3;
    const d = (Date.now() - eventMs) / 864e5;
    if (d <= 7) return 20;
    if (d <= 14) return 14;
    if (d <= 30) return 8;
    return 3;
}

// ---------- helpers ----------

async function readDataset(run, label) {
    if (!run?.defaultDatasetId) {
        log.warning(`${label} stage returned no dataset. Continuing.`);
        return [];
    }
    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const items = (await ds.getData()).items ?? [];
    log.info(`${label} stage: ${items.length} rows from ${run.defaultDatasetId}.`);
    return items;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
