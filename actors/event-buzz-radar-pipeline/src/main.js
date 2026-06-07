// Event Buzz Radar Pipeline
//
// For each ticker, finds the material 8-K events and checks whether the crowd
// is talking about that company on Reddit and Hacker News right now. A material
// corporate event is a catalyst; the same event with retail attention building
// around it is a tradable catalyst. This pipeline scores that overlap.
//
// Stage 1: scrapemint/sec-8k-event-tracker -> material 8-K events.
// Stage 2: scrapemint/reddit-lead-monitor  -> Reddit posts per cashtag/name.
// Stage 3: scrapemint/hn-lead-monitor      -> Hacker News posts per query.
// Stage 4: Per material 8-K, attach the ticker's buzz, score 0-100, tier,
//          push, charge.
//
// Every child is plain HTTP or a public JSON API (EDGAR, Reddit RSS, HN Algolia)
// with no browser and no residential proxy, so compute per run is tiny and the
// per-event price stays well above it.
//
// Nested billing: each child also bills the buyer for its own per-event usage
// (8-K filing, Reddit post, HN item). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_HOT = 1;

// For "hot", post-filing chatter must run at least this many times the ticker's
// pre-filing baseline rate. Steady mega-cap chatter sits near 1.0 and never
// clears it; a genuine reaction spikes well above.
const SPIKE_GATE = 1.5;

// 8-K item codes by how much they move a stock.
const HIGH_MATERIAL = new Set(['1.01', '1.03', '2.01', '2.04', '2.06', '4.02', '5.01']);
const MED_MATERIAL = new Set(['1.02', '2.02', '2.03', '2.05', '3.01', '5.02', '8.01']);
// Everything else (9.01 exhibits, 5.03, 5.05, 5.07 votes, 7.01 reg FD) is routine.

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    ciks = [],
    companyNames = {},
    maxAgeHours = 168,
    buzzMaxAgeHours = 336,
    reactionWindowDays = 7,
    minMentions = 2,
    materialOnly = true,
    includeBuzz = true,
    maxEventsTotal = 100,
    minScore = 0,
    proxyConfiguration: proxyInput,
} = input;

const cleanTickers = [...new Set((tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
const cleanCiks = [...new Set((ciks || []).map((c) => String(c).trim()).filter(Boolean))];
if (cleanTickers.length === 0 && cleanCiks.length === 0) {
    throw new Error('Provide at least one ticker in tickers or one CIK in ciks.');
}

const names = {};
for (const [k, v] of Object.entries(companyNames || {})) {
    const key = String(k).trim().toUpperCase();
    const val = String(v).trim();
    if (key && val) names[key] = val;
}

const buzzWindowMs = Math.max(1, Number(buzzMaxAgeHours) || 168) * 36e5;
const reactionDays = Math.max(1, Number(reactionWindowDays) || 7);
const reactionMs = reactionDays * 864e5;
const mentionGate = Math.max(1, Number(minMentions) || 2);

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

// The ticker set comes from the input plus whatever the 8-K issuers resolved to,
// so a CIK-only input still gets buzz once we know its ticker.
const tickerSet = new Set(cleanTickers);
for (const e of events) if (e.ticker) tickerSet.add(e.ticker);

// Per-ticker buzz accumulator + a query->ticker map for attribution.
const buzz = new Map();
const queryToTicker = new Map();
const socialQueries = [];
for (const t of tickerSet) {
    buzz.set(t, { reddit: [], hn: [] });
    const cashtag = `$${t}`;
    queryToTicker.set(cashtag.toLowerCase(), t);
    socialQueries.push(cashtag);
    if (names[t]) {
        queryToTicker.set(names[t].toLowerCase(), t);
        socialQueries.push(names[t]);
    }
}
const socialKeywords = [...queryToTicker.keys()];
const perSource = Math.max(10, Math.min(500, Number(input.maxPostsPerSource) || 80));

// ---------- Stage 2 + 3: social chatter ----------
if (includeBuzz && socialQueries.length > 0) {
    log.info('Stage 2: Reddit chatter.');
    try {
        const run = await Actor.call(
            'scrapemint/reddit-lead-monitor',
            {
                searchQueries: socialQueries,
                keywords: socialKeywords,
                sortBy: 'new',
                maxAgeHours: Math.min(8760, Math.ceil(buzzWindowMs / 36e5)),
                maxPostsPerSource: perSource,
                maxPostsTotal: Math.min(5000, perSource * socialQueries.length),
                dedupe: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        for (const r of (await readDataset(run, 'Reddit')).map(normReddit).filter(Boolean)) {
            const bucket = buzz.get(r.ticker);
            if (bucket && (!r.createdMs || Date.now() - r.createdMs <= buzzWindowMs)) bucket.reddit.push(r);
        }
    } catch (err) {
        log.warning(`Reddit stage failed (continuing): ${err?.message}`);
    }

    log.info('Stage 3: Hacker News chatter.');
    try {
        const run = await Actor.call(
            'scrapemint/hn-lead-monitor',
            {
                searchQueries: socialQueries,
                keywords: socialKeywords,
                searchType: 'both',
                sortBy: 'newest',
                maxAgeHours: Math.min(17520, Math.ceil(buzzWindowMs / 36e5)),
                maxItemsPerSource: perSource,
                maxItemsTotal: Math.min(5000, perSource * socialQueries.length),
                dedupe: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        for (const h of (await readDataset(run, 'Hacker News')).map(normHn).filter(Boolean)) {
            const bucket = buzz.get(h.ticker);
            if (bucket && (!h.createdMs || Date.now() - h.createdMs <= buzzWindowMs)) bucket.hn.push(h);
        }
    } catch (err) {
        log.warning(`Hacker News stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 4: join, score, tier, push, charge ----------
log.info(`Scoring ${events.length} events.`);
let hot = 0; let hotFree = 0; let elevated = 0; let watch = 0; let skipped = 0;

for (const e of events) {
    const b = (e.ticker && buzz.get(e.ticker)) || { reddit: [], hn: [] };
    const allPosts = [...b.reddit, ...b.hn];

    // Split the ticker's fetched chatter into a post-filing reaction window and
    // the pre-filing baseline, then compare rates. This is what makes the buzz
    // mean "reaction to THIS event" instead of "this company is always loud".
    const r = reactionStats(allPosts, e.eventMs);
    const postPosts = r.postPosts;
    const reactionMentions = postPosts.length;
    const hnPostPoints = postPosts.reduce((s, p) => s + (p.source === 'hn' ? p.points : 0), 0);
    const hnPostComments = postPosts.reduce((s, p) => s + (p.source === 'hn' ? p.comments : 0), 0);
    const hasReaction = reactionMentions >= mentionGate && r.spike >= SPIKE_GATE;

    const buzzScore = scoreBuzz(reactionMentions, hnPostPoints, hnPostComments, r.spike);
    const recencyScore = recency(e.eventMs, postPosts);
    const score = Math.min(100, Math.round(e.materialWeight + buzzScore + recencyScore));

    if (score < minScore) { skipped += 1; continue; }

    const material = e.materialWeight >= 28;
    let tier;
    if (material && hasReaction) tier = 'hot';
    else if (hasReaction || (material && reactionMentions >= mentionGate) || e.materialWeight >= 45) tier = 'elevated';
    else tier = 'watch';

    const lastBuzz = postPosts.reduce((m, p) => Math.max(m, p.createdMs || 0), 0);

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
        radarScore: score,
        tier,
        scoreBreakdown: { materiality: e.materialWeight, buzz: buzzScore, recency: recencyScore },
        buzz: {
            reactionWindowDays: reactionDays,
            reactionMentions,
            baselineMentions: r.prePosts.length,
            spikeRatio: Math.round(r.spike * 10) / 10,
            redditCount: postPosts.reduce((s, p) => s + (p.source === 'reddit' ? 1 : 0), 0),
            hnCount: postPosts.reduce((s, p) => s + (p.source === 'hn' ? 1 : 0), 0),
            hnPoints: hnPostPoints,
            hnComments: hnPostComments,
            lastBuzzDate: lastBuzz ? new Date(lastBuzz).toISOString().slice(0, 10) : null,
            topPosts: postPosts
                .slice()
                .sort((a, c) => (c.createdMs || 0) - (a.createdMs || 0))
                .slice(0, 5)
                .map((p) => ({ source: p.source, title: p.title, url: p.url, points: p.points ?? null, date: p.createdMs ? new Date(p.createdMs).toISOString().slice(0, 10) : null })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'hot') {
        if (hotFree + hot < FREE_TIER_HOT) hotFree += 1;
        else { await charge('ebr_hot'); hot += 1; }
    } else if (tier === 'elevated') {
        await charge('ebr_elevated'); elevated += 1;
    } else {
        await charge('ebr_watch'); watch += 1;
    }
}

log.info(`Done. hot charged=${hot} free=${hotFree}, elevated=${elevated}, watch=${watch}, below-gate=${skipped}.`);
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

function normReddit(r) {
    const ticker = tickerFor(r.sourceValue, `${r.title || ''}\n${r.selftext || ''}`);
    if (!ticker) return null;
    return {
        ticker,
        source: 'reddit',
        title: r.title || null,
        url: r.permalink || r.url || null,
        points: null,
        comments: 0,
        createdMs: r.createdAt ? Date.parse(r.createdAt) || null : null,
    };
}

function normHn(h) {
    const ticker = tickerFor(h.sourceValue, `${h.title || ''}\n${h.text || ''}`);
    if (!ticker) return null;
    return {
        ticker,
        source: 'hn',
        title: h.title || (h.text ? String(h.text).slice(0, 120) : null),
        url: h.permalink || h.url || null,
        points: num(h.points),
        comments: num(h.numComments),
        createdMs: h.createdAt ? Date.parse(h.createdAt) || null : null,
    };
}

// Attribute a social row to a ticker: prefer the echoed source query, fall back
// to scanning the text for a known cashtag or company name.
function tickerFor(sourceValue, text) {
    if (sourceValue) {
        const hit = queryToTicker.get(String(sourceValue).toLowerCase());
        if (hit) return hit;
    }
    const hay = (text || '').toLowerCase();
    for (const [q, t] of queryToTicker) {
        if (hay.includes(q)) return t;
    }
    return null;
}

// ---------- scoring ----------

function scoreBuzz(mentions, hnPoints, hnComments, spike) {
    if (mentions === 0) return 0;
    let s = mentions >= 20 ? 18 : mentions >= 10 ? 14 : mentions >= 5 ? 10 : mentions >= 2 ? 6 : 3;
    s += hnPoints >= 100 ? 10 : hnPoints >= 50 ? 7 : hnPoints >= 20 ? 4 : hnPoints > 0 ? 2 : 0;
    s += hnComments >= 50 ? 6 : hnComments >= 20 ? 4 : hnComments > 0 ? 2 : 0;
    // Reward a sharp spike over baseline, not just raw volume.
    s += spike >= 3 ? 6 : spike >= 2 ? 4 : spike >= SPIKE_GATE ? 2 : 0;
    return Math.min(40, s);
}

// Split a ticker's fetched posts into a post-filing reaction window and the
// pre-filing baseline, and return the rate ratio (spike). A ratio near 1 means
// steady background chatter; well above 1 means the crowd reacted to the event.
function reactionStats(posts, eventMs) {
    if (!eventMs) return { postPosts: [], prePosts: [], spike: 0 };
    const now = Date.now();
    const postPosts = posts.filter((p) => p.createdMs && p.createdMs >= eventMs && p.createdMs <= eventMs + reactionMs);
    const prePosts = posts.filter((p) => p.createdMs && p.createdMs < eventMs);
    // Reaction rate over the days actually elapsed since the filing, floored at
    // 1 to avoid div-by-zero and over-amplifying a filing only hours old.
    const postDays = Math.max(1, Math.min(reactionDays, (Math.min(now, eventMs + reactionMs) - eventMs) / 864e5));
    const postRate = postPosts.length / postDays;
    // Baseline rate over the span the pre-filing posts ACTUALLY cover, not the
    // nominal fetch window. The buzz child sorts by "new" and caps results, so a
    // loud ticker's fetched history is short; dividing by the nominal window
    // would understate its baseline and fake a spike. Using the real span keeps
    // a perpetually-loud company near 1.0x.
    let preRate = 0;
    if (prePosts.length > 0) {
        const earliest = Math.min(...prePosts.map((p) => p.createdMs));
        const preSpanDays = Math.max(1, Math.min(buzzWindowMs / 864e5, (eventMs - earliest) / 864e5));
        preRate = prePosts.length / preSpanDays;
    }
    // No prior chatter but a real post-filing cluster reads as a strong spike.
    const spike = preRate > 0 ? postRate / preRate : (postPosts.length > 0 ? 3 : 0);
    return { postPosts, prePosts, spike: Math.min(spike, 10) };
}

// Recency of the freshest signal (the event or a post-filing reaction post).
function recency(eventMs, postPosts) {
    const lastBuzz = postPosts.reduce((m, p) => Math.max(m, p.createdMs || 0), 0);
    const newest = Math.max(eventMs || 0, lastBuzz);
    if (!newest) return 3;
    const d = (Date.now() - newest) / 864e5;
    if (d <= 2) return 15;
    if (d <= 7) return 10;
    if (d <= 14) return 6;
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
