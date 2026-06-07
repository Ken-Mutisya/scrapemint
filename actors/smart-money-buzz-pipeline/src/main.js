// Smart Money Buzz Pipeline
//
// For each ticker, joins two independent signals:
//   1. Insiders buying their own stock on the open market (SEC Form 4, code P).
//   2. The crowd starting to talk about it on Reddit and Hacker News.
//
// Either alone is weak. Insiders buying is informed but quiet; social buzz is
// loud but often uninformed. The edge is the OVERLAP: smart money accumulating
// right as retail attention turns. This pipeline scores that convergence.
//
// Stage 1: scrapemint/sec-form4-insider-tracker -> open-market buys/sells (P/S).
// Stage 2: scrapemint/reddit-lead-monitor       -> Reddit posts per cashtag/name.
// Stage 3: scrapemint/hn-lead-monitor           -> Hacker News posts per query.
// Stage 4: Per ticker, join, score 0-100, tier, push, charge.
//
// Every child is plain HTTP or a public JSON API (EDGAR, Reddit RSS, HN Algolia)
// with no browser and no residential proxy, so compute per run is tiny and the
// per-event price stays well above it even on a quiet run.
//
// Nested billing: each child also bills the buyer for its own per-event usage
// (Form 4 transaction, Reddit post, HN item). The README documents combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_CONVERGING = 1;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    companyNames = {},
    insiderLookbackDays = 30,
    buzzMaxAgeHours = 168,
    minMentions = 2,
    includeInsider = true,
    includeBuzz = true,
    maxPostsPerSource = 80,
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

const buzzWindowMs = Math.max(1, Number(buzzMaxAgeHours) || 168) * 36e5;
const mentionGate = Math.max(1, Number(minMentions) || 2);
const perSource = Math.max(10, Math.min(500, Number(maxPostsPerSource) || 80));

// Per-ticker accumulator. Seeded so even tickers with zero signal can score 0.
const acc = new Map();
for (const t of cleanTickers) {
    acc.set(t, {
        ticker: t,
        company: names[t] || null,
        buys: [], sells: [],
        reddit: [], hn: [],
    });
}

// Map every social query string back to the ticker that produced it, so we can
// attribute returned rows by their echoed sourceValue.
const queryToTicker = new Map();
const socialQueries = [];
for (const t of cleanTickers) {
    const cashtag = `$${t}`;
    queryToTicker.set(cashtag.toLowerCase(), t);
    socialQueries.push(cashtag);
    if (names[t]) {
        queryToTicker.set(names[t].toLowerCase(), t);
        socialQueries.push(names[t]);
    }
}
// Keyword filter the children apply per row: a row is kept only if it contains
// the cashtag or the company name, which keeps generic-word tickers precise.
const socialKeywords = [...queryToTicker.keys()];

// ---------- Stage 1: insider open-market buys/sells ----------
if (includeInsider) {
    log.info('Stage 1: SEC Form 4 insider transactions (open-market buys and sells).');
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
                maxAgeHours: Math.max(24, Number(insiderLookbackDays) || 30) * 24,
                maxItemsPerSource: 200,
                maxItemsTotal: 600,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            { memory: 512, build: 'latest' },
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
            const bucket = acc.get(r.ticker);
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
            const bucket = acc.get(h.ticker);
            if (bucket && (!h.createdMs || Date.now() - h.createdMs <= buzzWindowMs)) bucket.hn.push(h);
        }
    } catch (err) {
        log.warning(`Hacker News stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 4: join, score, tier, push, charge ----------
log.info(`Scoring ${acc.size} tickers.`);
let converging = 0; let convergingFree = 0; let insiderOnly = 0; let buzzOnly = 0; let watch = 0; let skipped = 0;

for (const b of acc.values()) {
    const buyValue = b.buys.reduce((s, t) => s + t.value, 0);
    const sellValue = b.sells.reduce((s, t) => s + t.value, 0);
    const netValue = buyValue - sellValue;
    const netBuying = b.buys.length > 0 && netValue > 0;

    const mentions = b.reddit.length + b.hn.length;
    const hnPoints = b.hn.reduce((s, h) => s + h.points, 0);
    const hnComments = b.hn.reduce((s, h) => s + h.comments, 0);
    const hasBuzz = mentions >= mentionGate;

    const insiderScore = scoreInsider(b.buys, b.sells, buyValue, netValue);
    const buzzScore = scoreBuzz(mentions, hnPoints, hnComments);
    const velocityScore = scoreVelocity(b);
    const score = Math.min(100, Math.round(insiderScore + buzzScore + velocityScore));

    const hasInsiderBuys = b.buys.length > 0;
    if (!hasInsiderBuys && !hasBuzz && score < 1) { skipped += 1; continue; }
    if (score < minScore) { skipped += 1; continue; }

    let tier;
    if (netBuying && hasBuzz && score >= 60) tier = 'converging';
    else if (hasInsiderBuys && hasBuzz) tier = 'converging';
    else if (hasInsiderBuys) tier = 'insider_only';
    else if (hasBuzz) tier = 'buzz_only';
    else tier = 'watch';

    const lastBuy = b.buys.reduce((m, t) => Math.max(m, t.dateMs || 0), 0);
    const lastBuzz = [...b.reddit, ...b.hn].reduce((m, p) => Math.max(m, p.createdMs || 0), 0);

    const row = {
        ticker: b.ticker,
        company: b.company,
        tier,
        convergenceScore: score,
        scoreBreakdown: { insider: insiderScore, buzz: buzzScore, velocity: velocityScore },
        insider: {
            lookbackDays: Math.max(1, Number(insiderLookbackDays) || 30),
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
        buzz: {
            windowHours: Math.round(buzzWindowMs / 36e5),
            mentions,
            redditCount: b.reddit.length,
            hnCount: b.hn.length,
            hnPoints,
            hnComments,
            lastBuzzDate: lastBuzz ? new Date(lastBuzz).toISOString().slice(0, 10) : null,
            topPosts: [...b.reddit, ...b.hn]
                .slice()
                .sort((a, c) => (c.createdMs || 0) - (a.createdMs || 0))
                .slice(0, 5)
                .map((p) => ({ source: p.source, title: p.title, url: p.url, points: p.points ?? null, date: p.createdMs ? new Date(p.createdMs).toISOString().slice(0, 10) : null })),
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'converging') {
        if (convergingFree + converging < FREE_TIER_CONVERGING) convergingFree += 1;
        else { await charge('smb_converging'); converging += 1; }
    } else if (tier === 'insider_only') {
        await charge('smb_signal'); insiderOnly += 1;
    } else if (tier === 'buzz_only') {
        await charge('smb_signal'); buzzOnly += 1;
    } else {
        await charge('smb_watch'); watch += 1;
    }
}

log.info(`Done. converging charged=${converging} free=${convergingFree}, insider_only=${insiderOnly}, buzz_only=${buzzOnly}, watch=${watch}, skipped=${skipped}.`);
await Actor.exit();

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

function normReddit(r) {
    const ticker = tickerFor(r.sourceValue, `${r.title || ''}\n${r.selftext || ''}`);
    if (!ticker) return null;
    return {
        ticker,
        source: 'reddit',
        title: r.title || null,
        url: r.permalink || r.url || null,
        points: null,
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

function scoreInsider(buys, sells, buyValue, netValue) {
    if (buys.length === 0) return 0;
    let s = buyValue >= 1_000_000 ? 25 : buyValue >= 250_000 ? 18 : buyValue >= 50_000 ? 10 : buyValue > 0 ? 5 : 0;
    s += buys.length >= 3 ? 10 : buys.length === 2 ? 6 : 3;
    if (buys.length > sells.length && netValue > 0) s += 10;
    return Math.min(45, s);
}

function scoreBuzz(mentions, hnPoints, hnComments) {
    if (mentions === 0) return 0;
    let s = mentions >= 20 ? 20 : mentions >= 10 ? 15 : mentions >= 5 ? 10 : mentions >= 2 ? 6 : 3;
    s += hnPoints >= 100 ? 12 : hnPoints >= 50 ? 8 : hnPoints >= 20 ? 5 : hnPoints > 0 ? 2 : 0;
    s += hnComments >= 50 ? 8 : hnComments >= 20 ? 5 : hnComments > 0 ? 2 : 0;
    return Math.min(40, s);
}

// Recency of the freshest signal (a buy or a post). Convergence is most tradable
// when both legs are recent, so reward the most recent event on either side.
function scoreVelocity(b) {
    const lastBuy = b.buys.reduce((m, t) => Math.max(m, t.dateMs || 0), 0);
    const lastBuzz = [...b.reddit, ...b.hn].reduce((m, p) => Math.max(m, p.createdMs || 0), 0);
    const newest = Math.max(lastBuy, lastBuzz);
    if (!newest) return 0;
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
