// Clinical Catalyst Radar Pipeline
//
// For each biotech company, joins two independent signals that rarely line up:
//   1. A clinical asset advancing through the pipeline (ClinicalTrials.gov phase,
//      status, recent updates) plus research momentum behind it (PubMed papers,
//      citations).
//   2. Company insiders buying their own stock on the open market (SEC Form 4,
//      code P) right as that asset moves.
//
// Either alone is incomplete: a trial advancing is public knowledge that takes
// quarters to reprice, and insider buying is informed but says nothing about why.
// The edge is the OVERLAP: a Phase 2/3 asset progressing AND management putting
// their own cash in at the same time. This pipeline scores that convergence.
//
// Stage 1 (per company): scrapemint/pubmed-clinical-trials-intelligence
//   -> ClinicalTrials.gov studies (phase, status, sponsor, enrollment, results)
//   -> PubMed papers + citations (research momentum behind the program).
//   Called ONCE PER COMPANY so attribution is clean: rows are matched to the
//   company by sponsor/collaborator name, not by guessing from a batched query.
// Stage 2 (batched): scrapemint/sec-form4-insider-tracker
//   -> open-market insider buys/sells (P/S), attributed by issuer ticker.
// Stage 3: per company, join, score 0-100, tier, push, charge.
//
// Both children are plain HTTP / public government JSON APIs (NCBI E-utilities,
// ClinicalTrials.gov v2, SEC EDGAR) with no browser and no residential proxy, so
// compute per run is tiny and the per-event price stays well above it. The
// children are our own actors, so their per-row charges to the buyer are added
// revenue, not cost. Nested billing is documented in the README.

import { Actor, log } from 'apify';

const FREE_TIER_CATALYST = 1;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [],
    insiderLookbackDays = 90,
    clinicalSinceDays = 540,
    trialsPerCompany = 25,
    papersPerCompany = 20,
    includeInsider = true,
    minScore = 0,
    proxyConfiguration: proxyInput,
} = input;

// ---------- parse "Company Name | TICKER" entries ----------
// One entry per company. Name drives the clinical + research queries (CT.gov
// sponsor and PubMed), ticker drives the Form 4 insider lookup.
const parsed = [];
const seenTickers = new Set();
for (const raw of companies || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const [namePart, tickerPart] = s.split('|').map((x) => (x || '').trim());
    const name = namePart || '';
    const ticker = (tickerPart || '').toUpperCase();
    if (!name || !ticker) {
        log.warning(`Skipping malformed company entry "${raw}" (expected "Company Name | TICKER").`);
        continue;
    }
    if (seenTickers.has(ticker)) continue;
    seenTickers.add(ticker);
    parsed.push({ name, ticker });
}
if (parsed.length === 0) {
    throw new Error('Provide at least one company as "Company Name | TICKER" (e.g. "Moderna | MRNA").');
}

const insiderHours = Math.max(24, Number(insiderLookbackDays) || 90) * 24;
const clinicalSince = isoDaysAgo(Math.max(30, Number(clinicalSinceDays) || 540));
const trialCap = Math.max(5, Math.min(60, Number(trialsPerCompany) || 25));
const paperCap = Math.max(5, Math.min(50, Number(papersPerCompany) || 20));

// Per-ticker accumulator, seeded so even companies with no signal score 0.
const acc = new Map();
for (const c of parsed) {
    acc.set(c.ticker, { ...c, trials: [], papers: [], buys: [], sells: [] });
}

// ---------- Stage 1: clinical + research, one call per company ----------
for (const c of parsed) {
    log.info(`Stage 1 [${c.ticker}] clinical + research for "${c.name}".`);
    const bucket = acc.get(c.ticker);
    try {
        const run = await Actor.call(
            'scrapemint/pubmed-clinical-trials-intelligence',
            {
                clinicalTrialsQueries: [c.name],
                pubmedQueries: [c.name],
                // Only studies/papers updated in the recent window carry momentum.
                dateFrom: clinicalSince,
                fetchAbstracts: false,
                fetchReferences: false,
                fetchMeshTerms: false,
                fetchTrialResults: false,
                maxRecords: trialCap + paperCap,
                maxPerQuery: Math.max(trialCap, paperCap),
                dedupe: false,
            },
            // Gov APIs are fast; cap the child so one slow company cannot ride to
            // the parent's own timeout and hang the whole run.
            { memory: 512, build: 'latest', timeout: 420 },
        );
        for (const r of await readDataset(run, `clinical/research ${c.ticker}`)) {
            if (r.type === 'clinical_trial' && sponsorMatches(c.name, r)) {
                bucket.trials.push(normTrial(r));
            } else if (r.type === 'pubmed') {
                bucket.papers.push(normPaper(r));
            }
        }
        log.info(`  [${c.ticker}] matched ${bucket.trials.length} trials, ${bucket.papers.length} papers.`);
    } catch (err) {
        log.warning(`Stage 1 failed for ${c.ticker} (continuing): ${err?.message}`);
    }
}

// ---------- Stage 2: insider open-market buys/sells, batched ----------
if (includeInsider) {
    log.info('Stage 2: SEC Form 4 insider transactions (open-market buys and sells).');
    try {
        const tickers = parsed.map((c) => c.ticker);
        const run = await Actor.call(
            'scrapemint/sec-form4-insider-tracker',
            {
                tickers,
                transactionCodes: ['P', 'S'],
                includeDerivative: false,
                includeNonDerivative: true,
                maxAgeHours: insiderHours,
                maxItemsPerSource: 200,
                maxItemsTotal: Math.min(2000, 200 * tickers.length),
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
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
let catalyst = 0; let catalystFree = 0; let clinicalLead = 0; let insiderLead = 0; let watch = 0; let skipped = 0;

for (const b of acc.values()) {
    const cl = scoreClinical(b.trials);
    const rs = scoreResearch(b.papers);
    const buyValue = b.buys.reduce((s, t) => s + t.value, 0);
    const sellValue = b.sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;
    const ins = scoreInsider(b.buys, b.sells, buyValue, netValue);
    const score = Math.min(100, Math.round(cl.score + rs.score + ins));

    const phaseAdvancing = cl.topPhase >= 2 && cl.activeCount > 0;
    const hasInsiderBuys = b.buys.length > 0;
    const netBuying = hasInsiderBuys && netValue > 0;

    if (b.trials.length === 0 && b.papers.length === 0 && !hasInsiderBuys) { skipped += 1; continue; }
    if (score < minScore) { skipped += 1; continue; }

    let tier;
    if (phaseAdvancing && netBuying && score >= 55) tier = 'catalyst';
    else if (cl.score >= 22 || (cl.score >= 14 && rs.score >= 12)) tier = 'clinical_lead';
    else if (hasInsiderBuys) tier = 'insider_lead';
    else tier = 'watch';

    const lastBuy = b.buys.reduce((m, t) => Math.max(m, t.dateMs || 0), 0);

    const row = {
        ticker: b.ticker,
        company: b.name,
        tier,
        convergenceScore: score,
        scoreBreakdown: { clinical: cl.score, research: rs.score, insider: ins },
        clinical: {
            windowSince: clinicalSince,
            trialCount: b.trials.length,
            topPhase: cl.topPhaseLabel,
            advancingCount: cl.activeCount,
            recentlyUpdatedCount: cl.recentCount,
            withResultsCount: cl.withResults,
            topTrials: b.trials
                .slice()
                .sort((a, c) => phaseRank(c.phases) - phaseRank(a.phases) || (Date.parse(c.lastUpdate || '') || 0) - (Date.parse(a.lastUpdate || '') || 0))
                .slice(0, 4)
                .map((t) => ({ nctId: t.nctId, phase: t.phaseLabel, status: t.status, sponsor: t.sponsor, enrollment: t.enrollment, lastUpdate: t.lastUpdate, url: t.url })),
        },
        research: {
            paperCount: b.papers.length,
            recentPaperCount: rs.recentCount,
            totalCitations: rs.totalCitations,
            highImpactCount: rs.highImpact,
            topPapers: b.papers
                .slice()
                .sort((a, c) => (c.citations || 0) - (a.citations || 0) || (c.year || 0) - (a.year || 0))
                .slice(0, 4)
                .map((p) => ({ pmid: p.pmid, year: p.year, citations: p.citations, title: p.title, url: p.url })),
        },
        insider: {
            lookbackDays: Math.max(1, Number(insiderLookbackDays) || 90),
            buyCount: b.buys.length,
            sellCount: b.sells.length,
            buyValueUsd: Math.round(buyValue),
            sellValueUsd: Math.round(sellValue),
            netValueUsd: Math.round(netValue),
            netBuying,
            lastBuyDate: lastBuy ? new Date(lastBuy).toISOString().slice(0, 10) : null,
            topBuys: b.buys
                .slice()
                .sort((a, c) => c.value - a.value)
                .slice(0, 3)
                .map((t) => ({ insider: t.insider, role: t.role, shares: t.shares, price: t.price, valueUsd: Math.round(t.value), date: t.date })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'catalyst') {
        if (catalystFree + catalyst < FREE_TIER_CATALYST) catalystFree += 1;
        else { await charge('cat_catalyst'); catalyst += 1; }
    } else if (tier === 'clinical_lead') {
        await charge('cat_signal'); clinicalLead += 1;
    } else if (tier === 'insider_lead') {
        await charge('cat_signal'); insiderLead += 1;
    } else {
        await charge('cat_watch'); watch += 1;
    }
}

log.info(`Done. catalyst charged=${catalyst} free=${catalystFree}, clinical_lead=${clinicalLead}, insider_lead=${insiderLead}, watch=${watch}, skipped=${skipped}.`);
await Actor.exit();

// ---------- attribution ----------

// A clinical trial belongs to the company if its lead sponsor or a collaborator
// carries the company's core name. We strip corporate suffixes and common pharma
// words so "Moderna" matches "ModernaTX, Inc." and "Pfizer" matches "Pfizer Inc.".
function sponsorMatches(companyName, trial) {
    const core = coreName(companyName);
    if (!core) return false;
    const candidates = [trial.leadSponsor, ...(trial.collaborators || [])].filter(Boolean).map(coreName);
    return candidates.some((s) => s && (s.includes(core) || core.includes(s)));
}

function coreName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\b(inc|incorporated|corp|corporation|co|ltd|limited|llc|plc|lp|sa|ag|nv|gmbh|holdings|pharmaceuticals|pharmaceutical|pharma|therapeutics|biosciences|biotherapeutics|biotech|sciences|technologies|labs|laboratories|group|company)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------- normalizers ----------

function normTrial(r) {
    return {
        nctId: r.nctId || null,
        status: r.status || null,
        phases: Array.isArray(r.phases) ? r.phases : [],
        phaseLabel: phaseLabel(r.phases),
        sponsor: r.leadSponsor || null,
        enrollment: r.enrollment ?? null,
        lastUpdate: r.lastUpdatePostedDate || r.firstPostedDate || null,
        hasResults: r.hasResults ?? null,
        url: r.url || (r.nctId ? `https://clinicaltrials.gov/study/${r.nctId}` : null),
    };
}

function normPaper(r) {
    return {
        pmid: r.pmid || null,
        year: r.publicationYear ?? null,
        citations: num(r.citationCount),
        rcr: num(r.relativeCitationRatio),
        title: r.title || null,
        url: r.url || (r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : null),
    };
}

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

// Clinical (0-45): how far the lead asset has advanced and whether it is moving.
function scoreClinical(trials) {
    if (trials.length === 0) return { score: 0, topPhase: 0, topPhaseLabel: null, activeCount: 0, recentCount: 0, withResults: 0 };
    const topPhase = Math.max(...trials.map((t) => phaseRank(t.phases)));
    const activeCount = trials.filter((t) => isAdvancing(t.status)).length;
    const recentCount = trials.filter((t) => recentlyUpdated(t.lastUpdate)).length;
    const withResults = trials.filter((t) => t.hasResults === true).length;

    // Phase weight: Phase 3/4 is near-market, Phase 2 is the inflection, Phase 1 early.
    let s = topPhase >= 4 ? 22 : topPhase === 3 ? 20 : topPhase === 2 ? 13 : topPhase === 1 ? 6 : 2;
    s += activeCount > 0 ? (activeCount >= 3 ? 12 : activeCount === 2 ? 9 : 6) : 0;
    s += recentCount >= 2 ? 7 : recentCount === 1 ? 4 : 0;
    s += withResults > 0 ? 4 : 0;
    return {
        score: Math.min(45, s),
        topPhase,
        topPhaseLabel: phaseLabel(trials.find((t) => phaseRank(t.phases) === topPhase)?.phases),
        activeCount,
        recentCount,
        withResults,
    };
}

// Research (0-30): recent publication volume and citation weight behind the work.
function scoreResearch(papers) {
    if (papers.length === 0) return { score: 0, recentCount: 0, totalCitations: 0, highImpact: 0 };
    const thisYear = new Date().getFullYear();
    const recentCount = papers.filter((p) => p.year && p.year >= thisYear - 2).length;
    const totalCitations = papers.reduce((s, p) => s + (p.citations || 0), 0);
    const highImpact = papers.filter((p) => (p.rcr || 0) >= 1).length;

    let s = recentCount >= 12 ? 16 : recentCount >= 6 ? 11 : recentCount >= 3 ? 7 : recentCount >= 1 ? 4 : 0;
    s += totalCitations >= 500 ? 9 : totalCitations >= 100 ? 6 : totalCitations >= 20 ? 3 : 0;
    s += highImpact >= 3 ? 5 : highImpact >= 1 ? 2 : 0;
    return { score: Math.min(30, s), recentCount, totalCitations, highImpact };
}

// Insider (0-25): open-market buying conviction (mirrors the Form 4 logic used
// across the SEC pipelines, scaled to this pipeline's 25-point budget).
function scoreInsider(buys, sells, buyValue, netValue) {
    if (buys.length === 0) return 0;
    let s = buyValue >= 1_000_000 ? 14 : buyValue >= 250_000 ? 10 : buyValue >= 50_000 ? 6 : buyValue > 0 ? 3 : 0;
    s += buys.length >= 3 ? 6 : buys.length === 2 ? 4 : 2;
    if (buys.length > sells.length && netValue > 0) s += 5;
    return Math.min(25, s);
}

// ---------- clinical helpers ----------

function phaseRank(phases) {
    const list = (Array.isArray(phases) ? phases : []).map((p) => String(p).toUpperCase());
    let max = 0;
    for (const p of list) {
        if (p.includes('4')) max = Math.max(max, 4);
        else if (p.includes('3')) max = Math.max(max, 3);
        else if (p.includes('2')) max = Math.max(max, 2);
        else if (p.includes('1')) max = Math.max(max, 1);
    }
    return max;
}

function phaseLabel(phases) {
    const r = phaseRank(phases);
    return r > 0 ? `Phase ${r}` : (Array.isArray(phases) && phases.length ? phases.join('/') : null);
}

function isAdvancing(status) {
    const s = String(status || '').toUpperCase();
    return s === 'RECRUITING' || s === 'ENROLLING_BY_INVITATION' || s === 'ACTIVE_NOT_RECRUITING' || s === 'NOT_YET_RECRUITING';
}

function recentlyUpdated(date) {
    const ms = Date.parse(date || '');
    if (!ms) return false;
    return (Date.now() - ms) <= 180 * 864e5;
}

// ---------- generic helpers ----------

async function readDataset(run, label) {
    if (!run?.defaultDatasetId) {
        log.warning(`${label} stage returned no dataset. Continuing.`);
        return [];
    }
    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const items = (await ds.getData()).items ?? [];
    log.info(`${label}: ${items.length} rows from ${run.defaultDatasetId}.`);
    return items;
}

function isoDaysAgo(days) {
    return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
