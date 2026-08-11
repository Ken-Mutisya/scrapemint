// Research to Patent Commercialization Radar
//
// For each technology topic, correlates academic research momentum (OpenAlex)
// with patent filing activity (Google Patents). A field where papers are
// accelerating AND patents are being filed is commercializing now; one where
// research is spiking but patents are thin is an early lead before the IP race
// starts.
//
// Stage 1: OpenAlex, keyless HTTP             -> recent papers per topic.
// Stage 2: scrapemint/google-patents-scraper  -> patent filings per topic.
// Stage 3: Per topic, aggregate both sides, score convergence 0-100, tier
//          commercializing / emerging / watch, push, charge.
//
// Stage 1 used to call a google-scholar-scraper child. That child was retired
// 2026-08-11 (intermittent CAPTCHA on datacenter AND residential), and a parent
// cannot fix a CAPTCHA it inherits. Reading OpenAlex directly removes the
// dependency entirely, so nothing here breaks when that actor is deleted.
//
// The one remaining child is plain HTTP + residential proxy (no browser since
// the patents rewrite), called once per topic so every row is attributable.
//
// Nested billing: the patents child also bills the buyer for its own per-event
// usage (one patent row). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_COMMERCIALIZING = 1;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const nowYear = new Date().getUTCFullYear();
const {
    topics = [],
    yearFrom = nowYear - 3,
    maxTopics = 8,
    papersPerTopic = 15,
    patentsPerTopic = 20,
    minScore = 0,
    proxyConfiguration: proxyInput,
} = input;

const cleanTopics = [...new Set((topics || []).map((t) => String(t).trim()).filter(Boolean))]
    .slice(0, Math.max(1, Math.min(40, Number(maxTopics) || 8)));

if (cleanTopics.length === 0) {
    throw new Error('Provide at least one technology topic in topics[].');
}

// "Recent" = filed/published in the last two calendar years.
const recentThreshold = nowYear - 1;
const lowerYear = Number(yearFrom) > 0 ? Number(yearFrom) : nowYear - 3;

log.info(`Scanning ${cleanTopics.length} topics from ${lowerYear} onward.`);

let commercializingCharged = 0; let commercializingFree = 0; let emerging = 0; let watch = 0; let skipped = 0;

for (const topic of cleanTopics) {
    log.info(`Topic "${topic}": stage 1 papers, stage 2 patents.`);

    const papers = await runPapers(topic);
    const patents = await runPatents(topic);

    const research = summarizeResearch(papers);
    const patentInfo = summarizePatents(patents);

    if (research.paperCount === 0 && patentInfo.patentCount === 0) {
        log.warning(`Topic "${topic}": no data on either side, skipping.`);
        skipped += 1;
        continue;
    }

    const researchScore = scoreResearch(research);
    const patentScore = scorePatents(patentInfo);
    const momentumScore = scoreMomentum(research, patentInfo);
    const score = Math.min(100, Math.round(researchScore + patentScore + momentumScore));

    if (score < Number(minScore || 0)) { skipped += 1; continue; }

    let tier;
    if (researchScore >= 18 && patentScore >= 12 && score >= 55) tier = 'commercializing';
    else if (researchScore >= 18 && patentScore < 12) tier = 'emerging';
    else tier = 'watch';

    const row = {
        topic,
        tier,
        score,
        components: { researchScore, patentScore, momentumScore },
        signal: buildSignal(tier, research, patentInfo),
        research: {
            paperCount: research.paperCount,
            recentPaperCount: research.recentPaperCount,
            totalCitations: research.totalCitations,
            topVenues: research.topVenues,
            topPapers: research.topPapers,
        },
        patents: {
            patentCount: patentInfo.patentCount,
            recentPatentCount: patentInfo.recentPatentCount,
            distinctAssignees: patentInfo.distinctAssignees,
            topAssignees: patentInfo.topAssignees,
            recentFilings: patentInfo.recentFilings,
        },
        window: { yearFrom: lowerYear, recentSince: recentThreshold },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'commercializing') {
        if (commercializingFree + commercializingCharged < FREE_TIER_COMMERCIALIZING) commercializingFree += 1;
        else { await charge('radar_commercializing'); commercializingCharged += 1; }
    } else if (tier === 'emerging') {
        await charge('radar_emerging'); emerging += 1;
    } else {
        await charge('radar_watch'); watch += 1;
    }
}

log.info(`Done. commercializing charged=${commercializingCharged} free=${commercializingFree}, emerging=${emerging}, watch=${watch}, skipped=${skipped}.`);
await Actor.exit();

// ---------- Stage 1: Papers (OpenAlex) ----------

// Stage 1 reads OpenAlex directly rather than calling a Google Scholar child.
// Scholar was retired 2026-08-11: it CAPTCHAs intermittently on datacenter and
// residential alike, and a parent cannot fix a CAPTCHA it inherits. It was also
// 60% of this pipeline's cost per run ($0.022 of $0.037) for a signal OpenAlex
// serves keyless over plain HTTP. Sorting by citations, not date, is kept from
// the old call: date-sorted recent papers are all uncited, which zeroes out the
// citation signal this pipeline scores on.
const OPENALEX = 'https://api.openalex.org/works';

async function runPapers(topic) {
    const perPage = Math.max(5, Math.min(40, Number(papersPerTopic) || 15));
    const params = new URLSearchParams({
        filter: `default.search:${topic},from_publication_date:${lowerYear}-01-01`,
        sort: 'cited_by_count:desc',
        'per-page': String(perPage),
        // OpenAlex asks callers to identify themselves; it buys the polite pool
        // and a higher rate limit, and needs no key.
        mailto: 'actors@scrapemint.com',
    });
    try {
        const res = await fetch(`${OPENALEX}?${params}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        return (body.results || [])
            .map((w) => ({
                title: w.title || w.display_name || null,
                year: w.publication_year ?? null,
                citedByCount: Number(w.cited_by_count) || 0,
                venue: w.primary_location?.source?.display_name || null,
                url: w.doi || w.primary_location?.landing_page_url || w.id || null,
                authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
            }))
            .filter((r) => r.title);
    } catch (err) {
        log.warning(`Papers stage failed for "${topic}" (continuing): ${err?.message}`);
        return [];
    }
}

// ---------- Stage 2: Patents ----------

async function runPatents(topic) {
    try {
        const run = await Actor.call(
            'scrapemint/google-patents-scraper',
            {
                queries: [topic],
                yearFrom: lowerYear,
                maxPatents: Math.max(5, Math.min(50, Number(patentsPerTopic) || 20)),
                maxPagesPerQuery: 3,
                fetchPdf: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest', timeout: 300 },
        );
        return (await readDataset(run, `Patents "${topic}"`)).filter((r) => r && r.publicationNumber);
    } catch (err) {
        log.warning(`Patents stage failed for "${topic}" (continuing): ${err?.message}`);
        return [];
    }
}

// ---------- Aggregation ----------

function summarizeResearch(papers) {
    const paperCount = papers.length;
    const years = papers.map((p) => yearOf(p)).filter(Boolean);
    const recentPaperCount = years.filter((y) => y >= recentThreshold).length;
    const totalCitations = papers.reduce((s, p) => s + (Number(p.citedByCount) || 0), 0);

    const venueCounts = new Map();
    for (const p of papers) {
        const v = (p.venue || '').trim();
        if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1);
    }
    const topVenues = [...venueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    const topPapers = papers
        .slice()
        .sort((a, b) => (Number(b.citedByCount) || 0) - (Number(a.citedByCount) || 0))
        .slice(0, 5)
        .map((p) => ({ title: p.title, year: yearOf(p), citedByCount: Number(p.citedByCount) || 0, venue: p.venue || null, url: p.url || null }));

    return { paperCount, recentPaperCount, totalCitations, topVenues, topPapers };
}

function summarizePatents(patents) {
    const patentCount = patents.length;
    const years = patents.map((p) => filingYearOf(p)).filter(Boolean);
    const recentPatentCount = years.filter((y) => y >= recentThreshold).length;

    const assigneeCounts = new Map();
    for (const p of patents) {
        for (const a of (Array.isArray(p.assignees) ? p.assignees : [])) {
            const name = String(a).trim();
            if (name) assigneeCounts.set(name, (assigneeCounts.get(name) || 0) + 1);
        }
    }
    const topAssignees = [...assigneeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    const recentFilings = patents
        .slice()
        .sort((a, b) => (filingMs(b) || 0) - (filingMs(a) || 0))
        .slice(0, 5)
        .map((p) => ({
            publicationNumber: p.publicationNumber,
            title: p.title || null,
            assignee: (Array.isArray(p.assignees) && p.assignees[0]) || null,
            filingDate: p.filingDate || null,
            url: p.url || null,
        }));

    return { patentCount, recentPatentCount, distinctAssignees: assigneeCounts.size, topAssignees, recentFilings };
}

// ---------- Scoring ----------

function scoreResearch(r) {
    let s = 0;
    s += Math.min(20, r.paperCount * 2);
    s += Math.min(15, r.recentPaperCount * 3);
    s += r.totalCitations >= 500 ? 10 : r.totalCitations >= 100 ? 6 : r.totalCitations >= 20 ? 3 : 0;
    return Math.min(45, s);
}

function scorePatents(p) {
    let s = 0;
    s += Math.min(15, Math.round(p.patentCount * 1.5));
    s += Math.min(10, p.distinctAssignees * 2);
    s += Math.min(10, p.recentPatentCount * 2);
    return Math.min(35, s);
}

function scoreMomentum(r, p) {
    const total = r.paperCount + p.patentCount;
    if (total === 0) return 0;
    const recentShare = (r.recentPaperCount + p.recentPatentCount) / total;
    return Math.round(recentShare * 20);
}

function buildSignal(tier, r, p) {
    const topAssignee = p.topAssignees[0]?.name;
    if (tier === 'commercializing') {
        return `Active on both sides: ${r.recentPaperCount} recent papers and ${p.recentPatentCount} recent filings${topAssignee ? `, led by ${topAssignee}` : ''}. Commercialization underway.`;
    }
    if (tier === 'emerging') {
        return `Research is accelerating (${r.recentPaperCount} recent papers, ${r.totalCitations} citations) but patent activity is thin (${p.patentCount} filings). Early lead before the IP race.`;
    }
    return `Limited convergence: ${r.paperCount} papers, ${p.patentCount} patents on this topic.`;
}

// ---------- helpers ----------

function yearOf(p) {
    if (Number(p.year)) return Number(p.year);
    // Some sources leave year null but tuck it in the authors tail.
    const fromAuthors = Array.isArray(p.authors) ? p.authors.map((a) => String(a).match(/\b(19|20)\d{2}\b/)?.[0]).find(Boolean) : null;
    return fromAuthors ? Number(fromAuthors) : null;
}

function filingYearOf(p) {
    const m = String(p.filingDate || p.priorityDate || '').match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
}

function filingMs(p) {
    return Date.parse(p.filingDate || p.priorityDate || '') || null;
}

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

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
