// Federal Contract Momentum Pipeline
//
// For each company (ticker), joins two independent signals:
//   1. Accelerating federal contract awards (USAspending.gov public API).
//   2. Insiders buying their own stock on the open market (SEC Form 4, code P).
//
// Either alone is partial. A surge in federal awards says demand is real and
// funded; insiders buying says the people closest to the books are putting cash
// in. The edge is the OVERLAP: a contractor winning accelerating government
// dollars right as insiders accumulate. This pipeline scores that convergence.
//
// Stage 1: USAspending spending_by_award -> new federal awards per recipient,
//          bucketed into a recent window and an equal prior window so we measure
//          momentum (new dollars won, count, and growth), not raw backlog.
// Stage 2: scrapemint/sec-form4-insider-tracker -> open-market buys/sells (P/S).
// Stage 3: Per ticker, join, score 0 to 100, tier, push, charge.
//
// USAspending is queried with plain fetch (a public JSON API, no key, no proxy,
// no browser) and the only child is the HTTP-only Form 4 tracker, so compute per
// run is tiny and the per-event price stays well above it even on a quiet run.
//
// Nested billing: the Form 4 child also bills the buyer for its own per-event
// usage (one charge per insider transaction). The README documents combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_CONVERGING = 1;
const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
// Contract award type codes (definitive + IDV delivery orders). Excludes grants,
// loans, and direct payments, which are a different kind of signal.
const CONTRACT_AWARD_TYPES = ['A', 'B', 'C', 'D'];
const DAY_MS = 864e5;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    recipientNames = {},
    companyNames = {},
    recentWindowDays = 90,
    insiderLookbackDays = 90,
    minNewAwardValueUsd = 1_000_000,
    includeContracts = true,
    includeInsider = true,
    minScore = 0,
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
if (cleanTickers.length === 0) {
    throw new Error('Provide at least one ticker in tickers.');
}

const names = {};
for (const [k, v] of Object.entries(companyNames || {})) {
    const key = String(k).trim().toUpperCase();
    const val = String(v).trim();
    if (key && val) names[key] = val;
}

// Map each ticker to the USAspending recipient name strings to search. Default to
// the company name (or the ticker itself) when no explicit mapping is given.
const recipientsFor = (t) => {
    const raw = recipientNames?.[t] ?? recipientNames?.[t.toLowerCase()];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const cleaned = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
    if (cleaned.length > 0) return cleaned;
    return [names[t] || t];
};

const windowDays = Math.max(7, Math.min(365, Number(recentWindowDays) || 90));
const newAwardGate = Math.max(0, Number(minNewAwardValueUsd) || 0);

const now = Date.now();
const recentStart = now - windowDays * DAY_MS;
const priorStart = now - 2 * windowDays * DAY_MS;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Per-ticker accumulator. Seeded so even tickers with zero signal can score 0.
const acc = new Map();
for (const t of cleanTickers) {
    acc.set(t, {
        ticker: t,
        company: names[t] || null,
        recipients: recipientsFor(t),
        recentNew: [], // awards signed in the recent window
        priorNew: [], // awards signed in the equal prior window before it
        seen: new Set(), // award ids already counted (dedupe across recipient names)
        buys: [],
        sells: [],
    });
}

// ---------- Stage 1: federal contract momentum (USAspending) ----------
if (includeContracts) {
    log.info(`Stage 1: USAspending federal awards for ${cleanTickers.length} companies (recent ${windowDays}d vs prior ${windowDays}d).`);
    // One task per (ticker, recipient name). We query the recent window and the
    // equal prior window separately, filtering server-side by award signing date
    // (date_signed) so each call returns only awards NEW in that window. This
    // avoids long multi-year awards crowding out genuinely new ones when results
    // are capped, which a value-sorted action_date query would do.
    const recentDayBefore = iso(recentStart - DAY_MS);
    const tasks = [];
    for (const b of acc.values()) for (const r of b.recipients) tasks.push({ b, r });

    await mapPool(tasks, 6, async ({ b, r }) => {
        const [recent, prior] = await Promise.all([
            fetchAwards(r, iso(recentStart), iso(now)),
            fetchAwards(r, iso(priorStart), recentDayBefore),
        ]);
        collectAwards(b, b.recentNew, recent);
        collectAwards(b, b.priorNew, prior);
    });
}

// ---------- Stage 2: insider open-market buys/sells (SEC Form 4) ----------
if (includeInsider) {
    log.info('Stage 2: SEC Form 4 insider transactions (open-market buys and sells).');
    try {
        const run = await Actor.call(
            'scrapemint/sec-form4-insider-tracker',
            {
                tickers: cleanTickers,
                // P = open-market purchase, S = open-market sale. The conviction
                // signal lives here; grants/tax/exercise codes are noise.
                transactionCodes: ['P', 'S'],
                includeDerivative: false,
                includeNonDerivative: true,
                maxAgeHours: Math.max(24, Number(insiderLookbackDays) || 90) * 24,
                maxItemsPerSource: 200,
                maxItemsTotal: 600,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            // Backstop: bound the child so a slow EDGAR fetch can never ride the
            // pipeline toward its own run timeout. A timed-out child still returns
            // its dataset, so we degrade to partial insider data instead of failing.
            { memory: 512, build: 'latest', timeout: 600 },
        );
        for (const t of (await readDataset(run, 'Form 4')).map(normTx).filter(Boolean)) {
            const bucket = acc.get(t.ticker);
            if (!bucket) continue;
            if (t.code === 'P') bucket.buys.push(t);
            else bucket.sells.push(t);
        }
    } catch (err) {
        log.warning(`Form 4 stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 3: join, score, tier, push, charge ----------
log.info(`Scoring ${acc.size} companies.`);
let converging = 0; let convergingFree = 0; let contractOnly = 0; let insiderOnly = 0; let watch = 0; let skipped = 0;

for (const b of acc.values()) {
    const recentValue = b.recentNew.reduce((s, a) => s + a.amountUsd, 0);
    const priorValue = b.priorNew.reduce((s, a) => s + a.amountUsd, 0);
    const recentCount = b.recentNew.length;
    const priorCount = b.priorNew.length;
    // Growth: ratio of new dollars won this window vs the prior window. A prior of
    // zero with a positive recent is treated as a strong new-entrant surge.
    const growthRatio = priorValue > 0 ? recentValue / priorValue : (recentValue > 0 ? Infinity : 0);

    const buyValue = b.buys.reduce((s, t) => s + t.value, 0);
    const sellValue = b.sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;
    const netBuying = b.buys.length > 0 && netValue > 0;
    const hasInsiderBuys = b.buys.length > 0;

    const hasContractMomentum = recentValue >= newAwardGate && recentCount >= 1;

    const contractScore = scoreContracts(recentValue, growthRatio, recentCount);
    const insiderScore = scoreInsider(b.buys, b.sells, buyValue, netValue);
    const velocityScore = scoreVelocity(b);
    const score = Math.min(100, Math.round(contractScore + insiderScore + velocityScore));

    if (!hasContractMomentum && !hasInsiderBuys && score < 1) { skipped += 1; continue; }
    if (score < minScore) { skipped += 1; continue; }

    let tier;
    if (hasContractMomentum && netBuying) tier = 'converging';
    else if (hasContractMomentum && hasInsiderBuys && score >= 50) tier = 'converging';
    else if (hasContractMomentum) tier = 'contract_only';
    else if (hasInsiderBuys) tier = 'insider_only';
    else tier = 'watch';

    const lastNewAward = b.recentNew.reduce((m, a) => Math.max(m, Date.parse(a.startDate || '') || 0), 0);
    const lastBuy = b.buys.reduce((m, t) => Math.max(m, t.dateMs || 0), 0);

    const row = {
        ticker: b.ticker,
        company: b.company,
        tier,
        convergenceScore: score,
        scoreBreakdown: { contracts: contractScore, insider: insiderScore, velocity: velocityScore },
        contracts: {
            recipientsSearched: b.recipients,
            windowDays,
            recentNewAwardCount: recentCount,
            recentNewAwardValueUsd: Math.round(recentValue),
            priorNewAwardCount: priorCount,
            priorNewAwardValueUsd: Math.round(priorValue),
            growthRatio: growthRatio === Infinity ? null : Math.round(growthRatio * 100) / 100,
            newEntrantSurge: priorValue === 0 && recentValue > 0,
            lastNewAwardDate: lastNewAward ? iso(lastNewAward) : null,
            topNewAwards: b.recentNew
                .slice()
                .sort((a, c) => c.amountUsd - a.amountUsd)
                .slice(0, 3)
                .map((a) => ({ awardId: a.awardId, recipient: a.recipient, agency: a.agency, amountUsd: Math.round(a.amountUsd), startDate: a.startDate })),
        },
        insider: {
            lookbackDays: Math.max(1, Number(insiderLookbackDays) || 90),
            buyCount: b.buys.length,
            sellCount: b.sells.length,
            buyValueUsd: Math.round(buyValue),
            sellValueUsd: Math.round(sellValue),
            netValueUsd: Math.round(netValue),
            netBuying,
            lastBuyDate: lastBuy ? iso(lastBuy) : null,
            topBuys: b.buys
                .slice()
                .sort((a, c) => c.value - a.value)
                .slice(0, 3)
                .map((t) => ({ insider: t.insider, role: t.role, shares: t.shares, price: t.price, valueUsd: Math.round(t.value), date: t.date })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'converging') {
        if (convergingFree + converging < FREE_TIER_CONVERGING) convergingFree += 1;
        else { await charge('fcm_converging'); converging += 1; }
    } else if (tier === 'contract_only') {
        await charge('fcm_signal'); contractOnly += 1;
    } else if (tier === 'insider_only') {
        await charge('fcm_signal'); insiderOnly += 1;
    } else {
        await charge('fcm_watch'); watch += 1;
    }
}

log.info(`Done. converging charged=${converging} free=${convergingFree}, contract_only=${contractOnly}, insider_only=${insiderOnly}, watch=${watch}, skipped=${skipped}.`);
await Actor.exit();

// ---------- USAspending ----------

// Add awards to a window bucket, deduped by award id across recipient names.
function collectAwards(bucket, target, awards) {
    for (const a of awards) {
        const id = a['Award ID'] || a.internal_id || null;
        if (id && bucket.seen.has(id)) continue;
        if (id) bucket.seen.add(id);
        target.push({
            awardId: a['Award ID'] || null,
            recipient: a['Recipient Name'] || null,
            agency: a['Awarding Agency'] || null,
            amountUsd: num(a['Award Amount']),
            startDate: a['Start Date'] || null,
        });
    }
}

async function fetchAwards(recipientText, startDate, endDate) {
    const body = {
        filters: {
            award_type_codes: CONTRACT_AWARD_TYPES,
            recipient_search_text: [recipientText],
            // date_signed = filter by the award's signing date, so we get only
            // awards that are NEW in this window rather than every award with any
            // action in it.
            time_period: [{ start_date: startDate, end_date: endDate, date_type: 'date_signed' }],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date'],
        limit: 100,
        sort: 'Award Amount',
        order: 'desc',
    };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        const res = await fetch(USASPENDING_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'scrapemint-federal-contract-momentum/1.0' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
            log.warning(`USAspending HTTP ${res.status} for "${recipientText}".`);
            return [];
        }
        const json = await res.json();
        return Array.isArray(json?.results) ? json.results : [];
    } catch (err) {
        log.warning(`USAspending fetch failed for "${recipientText}" (continuing): ${err?.message}`);
        return [];
    }
}

// ---------- normalizers ----------

function normTx(t) {
    const issuer = t.issuer || {};
    const insider = t.insider || {};
    const tx = t.transaction || {};
    const code = String(tx.code || '').toUpperCase();
    if (code !== 'P' && code !== 'S') return null;
    const ticker = (issuer.ticker || '').toUpperCase();
    if (!ticker) return null;
    return {
        ticker,
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

function scoreContracts(recentValue, growthRatio, recentCount) {
    if (recentCount === 0 || recentValue <= 0) return 0;
    let s = recentValue >= 50_000_000 ? 30 : recentValue >= 10_000_000 ? 22 : recentValue >= 1_000_000 ? 14 : 7;
    // Growth of new awards vs the prior window of equal length.
    if (growthRatio === Infinity || growthRatio >= 2) s += 15;
    else if (growthRatio >= 1.2) s += 10;
    else if (growthRatio >= 0.8) s += 5;
    else s += 2;
    if (recentCount >= 5) s += 10;
    else if (recentCount >= 2) s += 6;
    else s += 3;
    return Math.min(55, s);
}

function scoreInsider(buys, sells, buyValue, netValue) {
    if (buys.length === 0) return 0;
    let s = buyValue >= 1_000_000 ? 18 : buyValue >= 250_000 ? 13 : buyValue >= 50_000 ? 7 : buyValue > 0 ? 3 : 0;
    s += buys.length >= 3 ? 7 : buys.length === 2 ? 4 : 2;
    if (buys.length > sells.length && netValue > 0) s += 5;
    return Math.min(30, s);
}

// Recency of the freshest leg (a new award start or an insider buy). Convergence
// is most actionable when both legs are recent.
function scoreVelocity(b) {
    const lastNewAward = b.recentNew.reduce((m, a) => Math.max(m, Date.parse(a.startDate || '') || 0), 0);
    const lastBuy = b.buys.reduce((m, t) => Math.max(m, t.dateMs || 0), 0);
    const newest = Math.max(lastNewAward, lastBuy);
    if (!newest) return 0;
    const d = (Date.now() - newest) / DAY_MS;
    if (d <= 7) return 15;
    if (d <= 30) return 10;
    if (d <= 90) return 6;
    return 3;
}

// ---------- helpers ----------

// Bounded-concurrency map: never let the fan-out grow with the number of
// recipient queries, so a big input can not crawl the run toward its timeout.
async function mapPool(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

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
