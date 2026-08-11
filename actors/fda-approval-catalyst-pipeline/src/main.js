// FDA Approval Catalyst Pipeline
//
// For each ticker, finds recent FDA regulatory wins for that company on openFDA
// (drug approvals, device PMA approvals, device 510(k) clearances) and correlates
// them with insider open-market buying in a window around the decision date. An
// FDA approval landing while company insiders are also buying their own stock is a
// far stronger setup than either signal alone: the approval is a hard, dated,
// binary catalyst, and the insider buying says management is putting cash in
// around it.
//
// Stage 1 (inline openFDA, keyless): resolve ticker -> company name via the SEC
//   company_tickers map, then query openFDA per company:
//     drug/drugsfda.json     -> approved submissions (status AP) in the window
//     device/pma.json        -> premarket approvals (decision APPR) in the window
//     device/510k.json       -> 510(k) clearances (decision SESE) in the window
//   Records are attributed to the company by a core-name match on the openFDA
//   sponsor/applicant, not just by the search term, so a stray name hit is dropped.
// Stage 2: scrapemint/sec-form4-insider-tracker -> insider open-market buys/sells
//   (transaction codes P and S) for the same tickers.
// Stage 3: per FDA event, attach insider buys/sells in the window around the
//   decision date, score 0-100, tier approval_confirmed / accumulation / watch,
//   push, charge.
//
// Both data sources are plain HTTP / public government JSON (openFDA + SEC EDGAR),
// no browser and no residential proxy, so compute per run is tiny and the
// per-event price stays well above it.
//
// Nested billing: the Form 4 child also bills the buyer for its own per-event
// usage (insider transaction). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_CONFIRMED = 1;
const HTTP_RATE_SLEEP_MS = 130;
const OPENFDA_BASE = 'https://api.fda.gov';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    maxAgeDays = 120,
    insiderWindowDays = 30,
    eventTypes = ['drug_approval', 'device_pma', 'device_510k'],
    includeInsider = true,
    minScore = 0,
    maxEventsPerCompany = 25,
    maxEventsTotal = 40,
    userAgent: userAgentInput = '',
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
if (cleanTickers.length === 0) {
    throw new Error('Provide at least one ticker in tickers, e.g. ["PFE", "MDT", "ABT"].');
}

const wantTypes = new Set((Array.isArray(eventTypes) ? eventTypes : [eventTypes])
    .map((t) => String(t).trim().toLowerCase()).filter(Boolean));
if (wantTypes.size === 0) { ['drug_approval', 'device_pma', 'device_510k'].forEach((t) => wantTypes.add(t)); }

const windowMs = Math.max(1, Number(insiderWindowDays) || 30) * 864e5;
const maxAgeMs = Math.max(1, Number(maxAgeDays) || 120) * 864e5;
const perCompanyCap = Math.max(1, Number(maxEventsPerCompany) || 25);
const totalCap = Math.max(1, Math.min(1000, Number(maxEventsTotal) || 200));

// SEC requires an email in the User-Agent; openFDA just wants a descriptive one.
const userAgent = String(userAgentInput).trim()
    || 'scrapemint-fda-approval-catalyst research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses on the EDGAR ticker map.');
}
const headers = { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' };

const startMs = Date.now() - maxAgeMs;
const startCompact = compactDate(startMs);
const endCompact = compactDate(Date.now() + 864e5);

// ---------- Stage 1: resolve tickers, pull FDA events ----------
log.info(`Stage 1: openFDA events (${[...wantTypes].join(', ')}) since ${isoDate(startMs)} for ${cleanTickers.join(', ')}.`);

const tickerMap = await loadTickerMap();
const subjects = [];
for (const t of cleanTickers) {
    const entry = tickerMap.get(t);
    if (!entry) { log.warning(`Ticker ${t} not found in SEC company map. Skipping.`); continue; }
    subjects.push({ ticker: t, cik: String(entry.cik), company: entry.title, core: coreName(entry.title) });
}
if (subjects.length === 0) {
    log.warning('No tickers resolved to a company name. Nothing to scan.');
    await Actor.exit();
}

let events = [];
for (const s of subjects) {
    if (events.length >= totalCap) break;
    const rows = await fetchFdaEvents(s);
    log.info(`${s.ticker} (${s.company}): ${rows.length} FDA events in range.`);
    events.push(...rows);
}
events.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
events = events.slice(0, totalCap);

if (events.length === 0) {
    log.warning('No FDA events found in range. Nothing to score.');
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
                // Reach back past the oldest event plus the window on both sides.
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
log.info(`Scoring ${events.length} FDA events.`);
let confirmedCharged = 0; let confirmedFree = 0; let accumulation = 0; let watch = 0; let skipped = 0;

for (const e of events) {
    const all = txByTicker.get(e.ticker) || [];
    const inWindow = e.dateMs
        ? all.filter((t) => t.dateMs && Math.abs(t.dateMs - e.dateMs) <= windowMs)
        : [];
    const buys = inWindow.filter((t) => t.code === 'P');
    const sells = inWindow.filter((t) => t.code === 'S');
    const buyValue = buys.reduce((s, t) => s + t.value, 0);
    const sellValue = sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;
    const netBuying = buys.length > 0 && netValue > 0;

    const eventScore = scoreEvent(e);
    const recScore = recency(e.dateMs);
    const insiderScore = scoreInsider(buys, buyValue, netValue);
    const edgeScore = Math.min(100, Math.round(eventScore + recScore + insiderScore));
    if (edgeScore < minScore) { skipped += 1; continue; }

    const recentDays = e.dateMs ? (Date.now() - e.dateMs) / 864e5 : Infinity;
    let tier;
    if (e.isMajor && (recentDays <= 45 || netBuying)) tier = 'approval_confirmed';
    else if (e.isMajor || netBuying) tier = 'accumulation';
    else tier = 'watch';

    const row = {
        ticker: e.ticker,
        company: e.company,
        cik: e.cik,
        eventType: e.eventType,
        eventLabel: e.eventLabel,
        isMajor: e.isMajor,
        product: e.product,
        applicant: e.applicant,
        idNumber: e.idNumber,
        reviewPriority: e.reviewPriority || null,
        decisionDate: e.date,
        daysAgo: e.dateMs ? Math.round(recentDays) : null,
        fdaUrl: e.url,
        edgeScore,
        tier,
        insider: {
            windowDays: Math.max(1, Number(insiderWindowDays) || 30),
            buyCount: buys.length,
            sellCount: sells.length,
            buyValueUsd: Math.round(buyValue),
            sellValueUsd: Math.round(sellValue),
            netValueUsd: Math.round(netValue),
            netBuying,
            topBuys: buys.slice().sort((a, b) => b.value - a.value).slice(0, 3)
                .map((t) => ({ insider: t.insider, role: t.role, shares: t.shares, price: t.price, valueUsd: Math.round(t.value), date: t.date })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'approval_confirmed') {
        if (confirmedFree + confirmedCharged < FREE_TIER_CONFIRMED) confirmedFree += 1;
        else { await charge('approval_confirmed'); confirmedCharged += 1; }
    } else if (tier === 'accumulation') {
        await charge('accumulation'); accumulation += 1;
    } else {
        await charge('watch'); watch += 1;
    }
}

log.info(`Done. approval_confirmed charged=${confirmedCharged} free=${confirmedFree}, accumulation=${accumulation}, watch=${watch}, below-gate=${skipped}.`);
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

// Pull every enabled FDA event type for one company and attribute by core name.
async function fetchFdaEvents(subject) {
    const out = [];
    const seen = new Set();
    if (!subject.core) {
        log.warning(`Could not derive a search name for ${subject.ticker}; skipping FDA lookup.`);
        return out;
    }

    const push = (ev) => {
        if (out.length >= perCompanyCap) return;
        // Attribution guard: the openFDA applicant/sponsor must actually carry the
        // company's core name (openFDA phrase search can over-match short terms).
        if (!nameMatches(subject.core, ev.applicant)) return;
        const key = `${ev.eventType}:${ev.idNumber}:${ev.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ ...ev, ticker: subject.ticker, company: subject.company, cik: subject.cik });
    };

    if (wantTypes.has('drug_approval')) {
        for (const ev of await fetchDrugApprovals(subject.core)) { push(ev); if (out.length >= perCompanyCap) return out; }
    }
    if (wantTypes.has('device_pma')) {
        for (const ev of await fetchPmaApprovals(subject.core)) { push(ev); if (out.length >= perCompanyCap) return out; }
    }
    if (wantTypes.has('device_510k')) {
        for (const ev of await fetchClearances(subject.core)) { push(ev); if (out.length >= perCompanyCap) return out; }
    }
    return out;
}

async function fetchDrugApprovals(core) {
    const out = [];
    // openFDA stores drug sponsor_name uppercase and matches it case-sensitively
    // (unlike the analyzed device `applicant` field), so the search term must be
    // uppercased or every drug query silently 404s.
    const search = `sponsor_name:"${core.toUpperCase()}" AND submissions.submission_status_date:[${startCompact} TO ${endCompact}]`;
    const data = await fetchFdaJson('drug/drugsfda.json', search, 'submissions.submission_status_date:desc');
    for (const rec of data?.results || []) {
        const applicant = rec.sponsor_name || null;
        const appNum = rec.application_number || '';
        const product = (rec.products || []).map((p) => p.brand_name).filter(Boolean)[0] || null;
        for (const sub of rec.submissions || []) {
            if (String(sub.submission_status || '').toUpperCase() !== 'AP') continue;
            const dateMs = parseCompact(sub.submission_status_date);
            if (!dateMs || dateMs < startMs) continue;
            const isOriginal = String(sub.submission_type || '').toUpperCase() === 'ORIG';
            const isPriority = /PRIORITY/i.test(sub.review_priority || '');
            out.push({
                eventType: 'drug_approval',
                eventLabel: isOriginal ? 'Drug approval (original NDA/BLA)' : 'Drug approval (supplement)',
                isMajor: isOriginal,
                isOriginal,
                reviewPriority: sub.review_priority || null,
                applicant,
                product,
                idNumber: `${appNum}${sub.submission_number ? `-S${sub.submission_number}` : ''}`,
                date: isoDate(dateMs),
                dateMs,
                priorityBoost: isPriority,
                url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${digits(appNum)}`,
            });
        }
    }
    return out;
}

async function fetchPmaApprovals(core) {
    const out = [];
    const search = `applicant:"${core}" AND decision_date:[${startCompact} TO ${endCompact}]`;
    const data = await fetchFdaJson('device/pma.json', search, 'decision_date:desc');
    for (const rec of data?.results || []) {
        if (String(rec.decision_code || '').toUpperCase() !== 'APPR') continue;
        const dateMs = Date.parse(rec.decision_date || '');
        if (!dateMs || dateMs < startMs) continue;
        const supp = String(rec.supplement_number || '').trim();
        const isOriginal = !supp || /^S0*0?$/i.test(supp);
        out.push({
            eventType: 'device_pma',
            eventLabel: isOriginal ? 'Device PMA approval (original)' : 'Device PMA supplement approval',
            isMajor: isOriginal,
            isOriginal,
            applicant: rec.applicant || null,
            product: rec.trade_name || null,
            idNumber: `${rec.pma_number || ''}${supp ? `/${supp}` : ''}`,
            date: rec.decision_date,
            dateMs,
            url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?id=${encodeURIComponent(rec.pma_number || '')}`,
        });
    }
    return out;
}

async function fetchClearances(core) {
    const out = [];
    const search = `applicant:"${core}" AND decision_date:[${startCompact} TO ${endCompact}]`;
    const data = await fetchFdaJson('device/510k.json', search, 'decision_date:desc');
    for (const rec of data?.results || []) {
        if (String(rec.decision_code || '').toUpperCase() !== 'SESE') continue; // substantially equivalent = cleared
        const dateMs = Date.parse(rec.decision_date || '');
        if (!dateMs || dateMs < startMs) continue;
        out.push({
            eventType: 'device_510k',
            eventLabel: '510(k) clearance',
            isMajor: false,
            isOriginal: true,
            applicant: rec.applicant || null,
            product: rec.device_name || null,
            idNumber: rec.k_number || '',
            date: rec.decision_date,
            dateMs,
            url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${encodeURIComponent(rec.k_number || '')}`,
        });
    }
    return out;
}

// openFDA returns HTTP 404 with {error:{code:NOT_FOUND}} when a search has zero
// matches. That is a normal empty result, not a failure, so map it to no rows.
async function fetchFdaJson(path, search, sort) {
    const url = `${OPENFDA_BASE}/${path}?search=${encodeURIComponent(search)}&limit=100${sort ? `&sort=${sort}` : ''}`;
    for (let i = 0; i < 4; i++) {
        await sleep(HTTP_RATE_SLEEP_MS + i * 400);
        try {
            const res = await fetch(url, { headers });
            if (res.status === 404) return { results: [] };
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue; // transient, retry
            log.warning(`openFDA HTTP ${res.status} for ${path}`);
            return { results: [] };
        } catch (err) {
            if (i === 3) log.warning(`openFDA fetch failed for ${path}: ${err?.message}`);
        }
    }
    return { results: [] };
}

// EDGAR static endpoints return intermittent 500/503 under load; retry transient.
async function fetchJsonWithRetry(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        await sleep(HTTP_RATE_SLEEP_MS + i * 400);
        try {
            const res = await fetch(url, { headers });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            log.warning(`EDGAR HTTP ${res.status} for ${url}`);
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`EDGAR fetch failed for ${url}: ${err?.message}`);
        }
    }
    return null;
}

// ---------- attribution / name helpers ----------

// Strip corporate suffixes and common pharma/medtech words so a company core name
// like "medtronic" matches openFDA's "Medtronic Sofamor Danek USA, Inc." and
// "abbott" matches "ABBOTT MEDICAL".
function coreName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[.,&]/g, ' ')
        .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|lp|sa|ag|nv|gmbh|holdings|holding|group|the|usa|us|international|intl|global|medical|medic|pharmaceuticals|pharmaceutical|pharma|therapeutics|biosciences|biotherapeutics|biopharma|biotech|sciences|technologies|technology|tech|labs|laboratories|diagnostics|devices|device|health|healthcare|systems)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nameMatches(companyCore, applicant) {
    const a = coreName(applicant);
    if (!companyCore || !a) return false;
    return a.includes(companyCore) || companyCore.includes(a);
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

// Event strength (0-45): a full drug/BLA approval is the highest-impact catalyst,
// a PMA (the strict device pathway) next, a 510(k) clearance lower, supplements
// in between. A priority-review drug approval gets a small extra bump.
function scoreEvent(e) {
    let s;
    if (e.eventType === 'drug_approval') s = e.isOriginal ? 42 : 24;
    else if (e.eventType === 'device_pma') s = e.isOriginal ? 38 : 20;
    else s = 22; // 510(k) clearance
    if (e.priorityBoost) s += 3;
    return Math.min(45, s);
}

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
    if (d <= 14) return 20;
    if (d <= 45) return 14;
    if (d <= 90) return 8;
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

function digits(s) { return String(s || '').replace(/\D/g, ''); }

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

function compactDate(ms) { return new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''); }

// openFDA drug submission dates are compact YYYYMMDD strings.
function parseCompact(s) {
    const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return Date.parse(s || '') || null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
