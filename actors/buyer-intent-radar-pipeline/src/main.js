// Buyer-Intent Radar Pipeline
//
// Finds people who are actively expressing a need, a problem, or buying intent
// for your topic RIGHT NOW, across three independent, antibot-free public
// forums, and ranks them as outreach-ready leads.
//
// Stage 1: scrapemint/reddit-lead-monitor       -> Reddit posts (RSS feeds)
//          pre-filtered to intent-bearing language. Purchase/recommendation
//          intent lives here ("looking for", "recommend", "alternative to").
// Stage 2: scrapemint/stackoverflow-lead-monitor -> Stack Overflow questions.
//          A question IS an unmet need; unanswered ones are the hottest.
// Stage 3: scrapemint/hn-lead-monitor           -> Hacker News Ask/Show/stories.
//          "Ask HN: best tool for X" is explicit evaluation intent.
// Stage 4: Normalize every signal to a common shape, drop already-seen signals
//          (cross-run dedupe via the KV store), group by person per platform.
// Stage 5: Score intent 0-100 (intent language + recency + engagement + how
//          many times the person asked), tier as hot_lead / warm_lead /
//          mention, push, and charge the matching event.
//
// Nested billing: each child actor also bills the buyer for its own per-event
// usage (reddit post_extracted, stackoverflow question, hn item). The README
// documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_HOT = 3;

// Intent lexicon. HIGH = active evaluation / purchase / switching language.
// MEDIUM = problem / help language (a softer but real signal).
const HIGH_INTENT = [
    'looking for', 'recommend', 'recommendation', 'any recommendations',
    'alternative to', 'alternatives', 'best tool', 'best software', 'best app', 'best platform',
    'best service', 'which tool', 'what tool', 'anyone use', 'anyone using',
    'switching from', 'switch from', 'migrate from', 'moving from', 'pricing', 'how much does',
    'budget for', 'need a tool', 'need a service', 'shortlist', 'evaluating',
    'should i use', 'should i buy',
];
const MEDIUM_INTENT = [
    'how do i', 'how to', 'help with', 'need help', 'any advice', 'struggling', 'frustrated',
    'issue with', 'problem with', 'problems with', "can't get", 'cannot get', 'not working',
    "doesn't work", 'stuck', 'trouble with', 'difficulty', 'confused about', 'instead of',
    ' vs ', 'vs.', 'compare', 'comparison', 'worth it', 'need a', 'suggestions', 'suggest',
    'any tool', 'hire a',
];
// Markers that the author is SELLING or announcing their own thing, not buying.
// These are dropped outright: a builder showing off ("Show HN", "I made a tool,
// suggestions welcome") is not a buyer even when it carries intent-like words.
const ANNOUNCEMENT = [
    'i built', 'i made', 'i created', 'i developed', 'i designed', 'we built', 'we made',
    'we created', 'we launched', 'i launched', 'just shipped', 'just launched', 'introducing',
    'check out my', 'check out our', 'sharing my', 'built a', 'made a', 'made an', 'my new',
    'our new', 'show hn', 'beta testers', 'testers wanted', 'help test', 'test my',
    'feedback on my', 'feedback welcome', 'feedback would be',
];
// Recruiting / job board posts: hiring people, not buying software.
const JOB_POST = [
    '[hiring]', '[for hire]', 'for hire', 'now hiring', 'we are hiring', "we're hiring",
    'commission only', '[job]',
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    subreddits = [],
    stackTags = [],
    hnFeeds = ['ask'],
    includeReddit = true,
    includeStackOverflow = true,
    includeHackerNews = true,
    extraIntentKeywords = [],
    maxAgeHours = 168,
    maxItemsPerSource = 25,
    minIntentScore = 20,
    proxyConfiguration: proxyInput,
} = input;

const cleanKeywords = [...new Set((keywords || []).map((k) => String(k).trim()).filter(Boolean))];
const cleanSubs = [...new Set((subreddits || []).map((s) => String(s).trim().replace(/^r\//i, '')).filter(Boolean))];
const cleanTags = [...new Set((stackTags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
const perSource = Math.max(20, Math.min(300, Number(maxItemsPerSource) || 100));
const ageHours = Math.max(24, Number(maxAgeHours) || 168);

// Buyer can extend the HIGH list with product/competitor names or niche phrases.
const highIntent = [...HIGH_INTENT, ...(extraIntentKeywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean)];
const intentPrefilter = [...new Set([...highIntent, ...MEDIUM_INTENT])];

if (cleanKeywords.length === 0 && cleanSubs.length === 0 && cleanTags.length === 0) {
    throw new Error('Provide at least one of: keywords, subreddits, or stackTags.');
}

// ---------- Stage 1: Reddit (purchase / recommendation intent) ----------
let redditRows = [];
if (includeReddit && (cleanKeywords.length || cleanSubs.length)) {
    log.info('Stage 1: Reddit lead monitor (intent-prefiltered).');
    try {
        const run = await Actor.call(
            'scrapemint/reddit-lead-monitor',
            {
                searchQueries: cleanKeywords,
                subreddits: cleanSubs,
                keywords: intentPrefilter,
                sortBy: 'new',
                maxAgeHours: ageHours,
                maxPostsPerSource: perSource,
                maxPostsTotal: perSource * 2,
                dedupe: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        redditRows = await readDataset(run, 'Reddit');
    } catch (err) {
        log.warning(`Reddit stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 2: Stack Overflow (unmet technical need) ----------
let soRows = [];
if (includeStackOverflow && (cleanTags.length || cleanKeywords.length)) {
    log.info('Stage 2: Stack Overflow lead monitor.');
    try {
        const run = await Actor.call(
            'scrapemint/stackoverflow-lead-monitor',
            {
                tags: cleanTags,
                searchQueries: cleanKeywords,
                sortBy: 'creation',
                maxAgeHours: ageHours,
                includeBody: true,
                maxQuestionsPerSource: perSource,
                maxQuestionsTotal: perSource * 2,
                dedupe: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        soRows = await readDataset(run, 'Stack Overflow');
    } catch (err) {
        log.warning(`Stack Overflow stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 3: Hacker News (evaluation / launch intent) ----------
let hnRows = [];
if (includeHackerNews && cleanKeywords.length) {
    log.info('Stage 3: Hacker News lead monitor.');
    try {
        const run = await Actor.call(
            'scrapemint/hn-lead-monitor',
            {
                searchQueries: cleanKeywords,
                feeds: Array.isArray(hnFeeds) ? hnFeeds : ['ask'],
                searchType: 'stories',
                sortBy: 'newest',
                maxAgeHours: ageHours,
                maxItemsPerSource: perSource,
                maxItemsTotal: perSource * 2,
                dedupe: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
        );
        hnRows = await readDataset(run, 'Hacker News');
    } catch (err) {
        log.warning(`Hacker News stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 4: normalize, cross-run dedupe, group by person ----------
const signals = [
    ...redditRows.map(normReddit),
    ...soRows.map(normStack),
    ...hnRows.map(normHn),
].filter((s) => s && s.url);

// Cross-run dedupe so a lead with no new activity is not re-charged next run.
const store = await Actor.openKeyValueStore('buyer-intent-radar-state');
const seenState = (await store.getValue('SEEN_URLS')) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);
const freshSignals = [];
let dedupedSignals = 0;
for (const s of signals) {
    if (seen.has(s.url)) { dedupedSignals += 1; continue; }
    newSeen.add(s.url);
    freshSignals.push(s);
}

// Group by person per platform. Anonymous/[deleted] authors cannot be grouped,
// so each of their signals stands alone (keyed by URL).
const leads = new Map();
for (const s of freshSignals) {
    const a = (s.author || '').trim();
    const groupable = a && !/^\[deleted\]$/i.test(a) && !/^automoderator$/i.test(a);
    const key = groupable ? `${s.platform}:${a.toLowerCase()}` : `${s.platform}:url:${s.url}`;
    let lead = leads.get(key);
    if (!lead) {
        lead = { platform: s.platform, author: groupable ? a : null, signals: [] };
        leads.set(key, lead);
    }
    lead.signals.push(s);
}

// ---------- Stage 5: score, tier, push, charge ----------
log.info(`Scoring ${leads.size} leads from ${freshSignals.length} fresh signals (${dedupedSignals} seen before).`);

let hotCharged = 0; let hotFree = 0; let warmCharged = 0; let mentionCharged = 0; let skipped = 0;

for (const lead of leads.values()) {
    const scored = scoreLead(lead);
    if (scored.leadScore < minIntentScore) { skipped += 1; continue; }

    const ordered = lead.signals
        .slice()
        .sort((x, y) => (y.intent - x.intent) || ((y.createdMs || 0) - (x.createdMs || 0)));
    const best = ordered[0];

    const row = {
        platform: lead.platform,
        author: lead.author,
        authorUrl: authorUrl(lead.platform, lead.author),
        leadScore: scored.leadScore,
        tier: scored.tier,
        hasHighIntent: scored.hasHigh,
        intentPhrases: scored.phrases,
        topics: [...new Set(lead.signals.map((s) => s.topic).filter(Boolean))],
        signalCount: lead.signals.length,
        bestSignal: {
            title: best.title,
            url: best.url,
            snippet: snippet(best.body),
            createdAt: best.createdMs ? new Date(best.createdMs).toISOString() : null,
            intentPhrases: best.phrases,
        },
        signals: ordered.slice(0, 3).map((s) => ({
            title: s.title,
            url: s.url,
            createdAt: s.createdMs ? new Date(s.createdMs).toISOString() : null,
        })),
        engagement: scored.engagement,
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (scored.tier === 'hot_lead') {
        if (hotFree + hotCharged < FREE_TIER_HOT) hotFree += 1;
        else { await charge('lead_hot'); hotCharged += 1; }
    } else if (scored.tier === 'warm_lead') {
        await charge('lead_warm'); warmCharged += 1;
    } else {
        await charge('lead_mention'); mentionCharged += 1;
    }
}

// Persist seen URLs (capped) so future runs skip already-delivered signals.
await store.setValue('SEEN_URLS', [...newSeen].slice(-50_000));

log.info(`Done. hot charged=${hotCharged} free=${hotFree}, warm=${warmCharged}, mention=${mentionCharged}, below-gate=${skipped}.`);
await Actor.exit();

// ---------- normalizers ----------

function normReddit(r) {
    if (!r) return null;
    return {
        platform: 'reddit',
        author: r.author || null,
        title: r.title || null,
        body: r.selftext || '',
        url: r.permalink || r.url || null,
        createdMs: r.createdAt ? Date.parse(r.createdAt) : null,
        topic: r.sourceValue || null,
        // Reddit RSS exposes no vote/comment counts.
        engagement: null,
        ...intentOf(`${r.title || ''}\n${r.selftext || ''}`),
    };
}

function normStack(r) {
    if (!r || (r.itemType && r.itemType !== 'question')) return null;
    const author = r.author && typeof r.author === 'object' ? (r.author.displayName || null) : (r.author || null);
    const answers = num(r.answerCount);
    return {
        platform: 'stackoverflow',
        author,
        title: r.title || null,
        body: r.body || '',
        url: r.link || null,
        createdMs: r.creationDate ? Date.parse(r.creationDate) : null,
        topic: r.sourceValue || (Array.isArray(r.tags) ? r.tags[0] : null),
        engagement: {
            score: num(r.score),
            answers,
            views: num(r.viewCount),
            isAnswered: r.isAnswered === true || r.isAnswered === 'true',
            hasAcceptedAnswer: r.hasAcceptedAnswer === true || r.hasAcceptedAnswer === 'true',
        },
        ...intentOf(`${r.title || ''}\n${r.body || ''}`),
    };
}

function normHn(r) {
    if (!r || (r.itemType && r.itemType !== 'story')) return null;
    return {
        platform: 'hackernews',
        author: r.author || null,
        title: r.title || null,
        body: r.text || '',
        url: r.permalink || r.url || null,
        createdMs: r.createdAt ? Date.parse(r.createdAt) : null,
        topic: r.sourceValue || null,
        engagement: { points: num(r.points), comments: num(r.numComments) },
        ...intentOf(`${r.title || ''}\n${r.text || ''}`),
    };
}

// ---------- scoring ----------

function intentOf(text) {
    const hay = String(text).toLowerCase();
    // Sellers and recruiters are not buyers: drop announcements and job posts
    // outright, before any intent language can pull them into a lead.
    if (ANNOUNCEMENT.some((p) => hay.includes(p)) || JOB_POST.some((p) => hay.includes(p))) {
        return { intent: 0, hasHigh: false, phrases: [] };
    }
    const highHits = highIntent.filter((p) => hay.includes(p));
    const medHits = MEDIUM_INTENT.filter((p) => hay.includes(p));
    const distinct = highHits.length + medHits.length;
    let base = 0;
    if (highHits.length) base = 38;
    else if (medHits.length) base = 18;
    const extra = distinct > 0 ? Math.min(12, (distinct - 1) * 6) : 0;
    const intent = base > 0 ? Math.min(50, base + extra) : 0;
    return {
        intent,
        hasHigh: highHits.length > 0,
        phrases: [...new Set([...highHits, ...medHits])].slice(0, 6).map((p) => p.trim()),
    };
}

function recencyScore(createdMs) {
    if (!createdMs) return 0;
    const days = (Date.now() - createdMs) / 864e5;
    if (days < 1) return 20;
    if (days < 3) return 14;
    if (days < 7) return 9;
    if (days < 30) return 4;
    return 0;
}

function engagementScore(platform, eng) {
    if (!eng) return 0;
    if (platform === 'stackoverflow') {
        let s = 0;
        const sc = eng.score || 0;
        if (sc >= 10) s += 10; else if (sc >= 3) s += 6; else if (sc >= 1) s += 3;
        // An unmet question is a stronger lead than an already-solved one.
        if (!eng.isAnswered || eng.answers === 0) s += 5;
        else if (!eng.hasAcceptedAnswer) s += 3;
        return Math.min(15, s);
    }
    if (platform === 'hackernews') {
        let s = 0;
        const p = eng.points || 0;
        if (p >= 100) s += 10; else if (p >= 50) s += 7; else if (p >= 20) s += 4; else if (p > 0) s += 2;
        const c = eng.comments || 0;
        if (c >= 50) s += 5; else if (c >= 10) s += 3; else if (c > 0) s += 1;
        return Math.min(15, s);
    }
    return 0;
}

function scoreLead(lead) {
    const intent = Math.max(0, ...lead.signals.map((s) => s.intent));
    const hasHigh = lead.signals.some((s) => s.hasHigh);
    const recency = Math.max(0, ...lead.signals.map((s) => recencyScore(s.createdMs)));
    const engScore = Math.max(0, ...lead.signals.map((s) => engagementScore(lead.platform, s.engagement)));
    const count = lead.signals.length;
    const multi = count >= 3 ? 10 : count === 2 ? 5 : 0;
    const leadScore = Math.min(100, Math.round(intent + recency + engScore + multi));
    const phrases = [...new Set(lead.signals.flatMap((s) => s.phrases))].slice(0, 8);

    // Best per-signal engagement object for the row (most informative one).
    const engagement = lead.signals
        .map((s) => s.engagement)
        .filter(Boolean)
        .sort((a, b) => engagementScore(lead.platform, b) - engagementScore(lead.platform, a))[0] || null;

    let tier;
    if (leadScore >= 60 && hasHigh) tier = 'hot_lead';
    else if (leadScore >= 40 || hasHigh) tier = 'warm_lead';
    else tier = 'mention';

    return { leadScore, tier, hasHigh, phrases, engagement };
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

function snippet(body) {
    const t = String(body || '').replace(/\s+/g, ' ').trim();
    return t.length > 240 ? `${t.slice(0, 237)}...` : t;
}

function authorUrl(platform, author) {
    if (!author) return null;
    if (platform === 'reddit') return `https://www.reddit.com/user/${encodeURIComponent(author)}`;
    if (platform === 'hackernews') return `https://news.ycombinator.com/user?id=${encodeURIComponent(author)}`;
    return null; // Stack Overflow display name is not a stable profile slug.
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
