// Macro Event Edge Pipeline
//
// Anchors on upcoming high-impact economic events and shows, for each one, how
// traders are positioned on the affected assets and what prediction markets
// imply, so a trader sees the catalyst plus the crowd's lean in one row.
//
// Stage 1: scrapemint/forexfactory-economic-calendar -> the scheduled catalysts
//          (currency, event, time, forecast vs previous, impact).
// Stage 2: scrapemint/tradingview-ideas-scraper       -> trader ideas for the
//          symbols tied to each event's currency (the positioning signal).
//          Called ONCE for the whole symbol universe, joined locally.
// Stage 3: scrapemint/polymarket-market-monitor       -> prediction-market odds
//          for the macro topics in the calendar (Fed, inflation, jobs, GDP).
//          Called ONCE with topic queries, joined locally.
// Stage 4: Per event, attach trader ideas by symbol and prediction markets by
//          macro topic, compute a bull/bear lean and a market-move read.
// Stage 5: Score edge 0-100 (impact + proximity + trader signal + market
//          signal), tier high_conviction / elevated / watch, push, and charge.
//
// Nested billing: each child actor also bills the buyer for its own per-event
// usage (calendar event, tradingview idea, polymarket item). The README
// documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_HIGH = 3;

// Which trading symbols each calendar currency moves. Kept compact and major.
const CURRENCY_SYMBOLS = {
    USD: ['DXY', 'SPX', 'EURUSD', 'USDJPY', 'XAUUSD', 'US10Y'],
    EUR: ['EURUSD', 'DAX', 'EURGBP'],
    GBP: ['GBPUSD', 'EURGBP', 'UK100'],
    JPY: ['USDJPY', 'NKY', 'EURJPY'],
    CAD: ['USDCAD', 'USOIL'],
    AUD: ['AUDUSD'],
    NZD: ['NZDUSD'],
    CHF: ['USDCHF'],
    CNY: ['USDCNH', 'HSI'],
};

// Macro topics: canonical name -> phrases that identify it in event titles and
// in prediction-market questions. Used to link a calendar event to the right
// Polymarket markets, and to build the Polymarket search queries.
const MACRO_TOPICS = {
    fed_rate: ['fed', 'fomc', 'interest rate', 'rate decision', 'rate cut', 'rate hike', 'powell', 'federal funds'],
    inflation: ['inflation', 'cpi', 'ppi', 'pce', 'price index'],
    jobs: ['payroll', 'non-farm', 'nonfarm', 'unemployment', 'jobless', 'employment change', 'jobs report'],
    growth: ['gdp', 'recession', 'growth'],
    ecb: ['ecb', 'lagarde', 'euro area rate'],
    boe: ['boe', 'bank of england'],
    boj: ['boj', 'bank of japan'],
};
const TOPIC_QUERIES = {
    fed_rate: 'fed rate',
    inflation: 'inflation',
    jobs: 'jobs report',
    growth: 'recession',
    ecb: 'ecb rate',
    boe: 'bank of england',
    boj: 'bank of japan',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    range = 'this_week',
    startDate = '',
    endDate = '',
    impactLevels = ['high', 'medium'],
    currencies = [],
    maxEventsTotal = 60,
    includeTradingView = true,
    includePolymarket = true,
    maxIdeasPerSymbol = 30,
    minScore = 0,
    proxyConfiguration: proxyInput,
} = input;

const wantImpact = new Set((Array.isArray(impactLevels) ? impactLevels : ['high', 'medium']).map((s) => String(s).toLowerCase()));

// ---------- Stage 1: economic calendar (the catalysts) ----------
log.info('Stage 1: ForexFactory economic calendar.');
let events = [];
try {
    const run = await Actor.call(
        'scrapemint/forexfactory-economic-calendar',
        {
            range,
            startDate,
            endDate,
            currencies: Array.isArray(currencies) ? currencies : [],
            impactLevels: [...wantImpact],
            includeDetail: false,
            maxEvents: 500,
            proxyConfiguration: proxyInput,
        },
        { memory: 2048, build: 'latest' },
    );
    events = (await readDataset(run, 'calendar'))
        .filter((e) => wantImpact.has(String(e.impact || '').toLowerCase()))
        .map(normEvent)
        .filter((e) => e.title && e.currency);
} catch (err) {
    log.warning(`Calendar stage failed: ${err?.message}`);
}

if (events.length === 0) {
    log.warning('No calendar events in range/impact. Nothing to score.');
    await Actor.exit();
}

// Sort soonest first, cap.
events.sort((a, b) => (a.timeMs || Infinity) - (b.timeMs || Infinity));
events = events.slice(0, Math.max(1, Math.min(200, Number(maxEventsTotal) || 60)));

// ---------- Stage 2: TradingView ideas for the affected symbols ----------
const symbolUniverse = [...new Set(
    events.flatMap((e) => CURRENCY_SYMBOLS[e.currency] || []),
)].slice(0, 16);

let ideasBySymbol = new Map();
if (includeTradingView && symbolUniverse.length) {
    log.info(`Stage 2: TradingView ideas for ${symbolUniverse.length} symbols.`);
    try {
        const run = await Actor.call(
            'scrapemint/tradingview-ideas-scraper',
            {
                symbols: symbolUniverse,
                maxIdeasPerSource: Math.max(10, Math.min(60, Number(maxIdeasPerSymbol) || 30)),
                includeAuthorIntel: false,
                proxyConfiguration: proxyInput,
            },
            { memory: 1024, build: 'latest' },
        );
        const ideas = await readDataset(run, 'TradingView');
        for (const idea of ideas) {
            const sym = String(idea.symbol || '').toUpperCase();
            if (!sym) continue;
            if (!ideasBySymbol.has(sym)) ideasBySymbol.set(sym, []);
            ideasBySymbol.get(sym).push(normIdea(idea));
        }
    } catch (err) {
        log.warning(`TradingView stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 3: Polymarket odds for the macro topics present ----------
const topicsPresent = [...new Set(events.flatMap((e) => e.topics))];
let marketsByTopic = new Map();
if (includePolymarket && topicsPresent.length) {
    const queries = [...new Set(topicsPresent.map((t) => TOPIC_QUERIES[t]).filter(Boolean))];
    log.info(`Stage 3: Polymarket for topics [${topicsPresent.join(', ')}].`);
    try {
        const run = await Actor.call(
            'scrapemint/polymarket-market-monitor',
            {
                searchQueries: queries,
                itemType: 'markets',
                status: 'active',
                // NOTE: the polymarket child returns 0 rows when sortBy or
                // maxItemsPerSource is set alongside searchQueries, so we pass
                // neither and sort/cap locally instead.
                maxItemsTotal: 100,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            { memory: 1024, build: 'latest' },
        );
        const markets = (await readDataset(run, 'Polymarket')).map(normMarket).filter(Boolean);
        for (const m of markets) {
            for (const t of m.topics) {
                if (!marketsByTopic.has(t)) marketsByTopic.set(t, []);
                marketsByTopic.get(t).push(m);
            }
        }
        // Keep the most-traded few per topic.
        for (const [t, arr] of marketsByTopic) {
            arr.sort((a, b) => b.volume24h - a.volume24h);
            marketsByTopic.set(t, arr.slice(0, 5));
        }
    } catch (err) {
        log.warning(`Polymarket stage failed (continuing): ${err?.message}`);
    }
}

// ---------- Stage 4 + 5: join, score, tier, push, charge ----------
log.info(`Scoring ${events.length} events.`);
let highCharged = 0; let highFree = 0; let elevated = 0; let watch = 0; let skipped = 0;

for (const e of events) {
    const symbols = CURRENCY_SYMBOLS[e.currency] || [];
    const ideas = symbols.flatMap((s) => ideasBySymbol.get(s) || []);
    const lean = computeLean(ideas);

    const markets = [...new Set(e.topics.flatMap((t) => marketsByTopic.get(t) || []))];
    const marketRead = computeMarketRead(markets);

    const impactScore = e.impact === 'high' ? 35 : e.impact === 'medium' ? 18 : 6;
    const proximityScore = proximity(e.timeMs);
    const traderScore = scoreTrader(ideas, lean);
    const marketScore = scoreMarket(markets, marketRead);
    const edgeScore = Math.min(100, Math.round(impactScore + proximityScore + traderScore + marketScore));

    if (edgeScore < minScore) { skipped += 1; continue; }

    const strongTrader = lean.total >= 3 && Math.abs(lean.lean) >= 0.5;
    const strongMarket = marketRead.maxMove >= 0.08 || marketRead.maxVolume24h >= 50000;
    let tier;
    if (e.impact === 'high' && edgeScore >= 60 && (strongTrader || strongMarket)) tier = 'high_conviction';
    else if (e.impact === 'high' || edgeScore >= 42) tier = 'elevated';
    else tier = 'watch';

    const row = {
        event: e.title,
        currency: e.currency,
        impact: e.impact,
        eventTime: e.timeMs ? new Date(e.timeMs).toISOString() : null,
        hoursUntil: e.timeMs ? Math.round((e.timeMs - Date.now()) / 36e5) : null,
        forecast: e.forecast,
        previous: e.previous,
        actual: e.actual,
        edgeScore,
        tier,
        macroTopics: e.topics,
        traderSentiment: ideas.length
            ? {
                symbols: [...new Set(ideas.map((i) => i.symbol))],
                ideaCount: ideas.length,
                bullish: lean.bull,
                bearish: lean.bear,
                neutral: lean.neutral,
                lean: Number(lean.lean.toFixed(2)),
                leanLabel: lean.label,
                topIdeas: ideas
                    .slice()
                    .sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))
                    .slice(0, 3)
                    .map((i) => ({ title: i.title, symbol: i.symbol, direction: i.dir, url: i.url, likes: i.likes })),
            }
            : null,
        predictionMarkets: markets.length
            ? {
                count: markets.length,
                maxOneWeekMove: Number(marketRead.maxMove.toFixed(3)),
                topMarkets: markets
                    .slice()
                    .sort((a, b) => b.volume24h - a.volume24h)
                    .slice(0, 3)
                    .map((m) => ({
                        question: m.question,
                        yesPrice: m.yesPrice,
                        volume24h: Math.round(m.volume24h),
                        oneWeekChange: m.oneWeekChange,
                        url: m.url,
                    })),
            }
            : null,
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'high_conviction') {
        if (highFree + highCharged < FREE_TIER_HIGH) highFree += 1;
        else { await charge('macro_high_conviction'); highCharged += 1; }
    } else if (tier === 'elevated') {
        await charge('macro_elevated'); elevated += 1;
    } else {
        await charge('macro_watch'); watch += 1;
    }
}

log.info(`Done. high_conviction charged=${highCharged} free=${highFree}, elevated=${elevated}, watch=${watch}, below-gate=${skipped}.`);
await Actor.exit();

// ---------- normalizers ----------

function normEvent(e) {
    const title = String(e.title || e.event || '').trim();
    const timeMs = eventTimeMs(e);
    return {
        title,
        currency: String(e.currency || '').toUpperCase().trim(),
        impact: String(e.impact || '').toLowerCase(),
        timeMs,
        forecast: e.forecast ?? null,
        previous: e.previous ?? null,
        actual: e.actual ?? null,
        topics: topicsOf(title),
    };
}

function normIdea(i) {
    const dir = ideaDirection(i);
    return {
        symbol: String(i.symbol || '').toUpperCase(),
        title: i.title || null,
        url: i.url || null,
        dir,
        likes: num(i.likes),
        comments: num(i.comments),
        isHot: i.isHot === true || i.isHot === 'true',
    };
}

function normMarket(m) {
    if (!m || (m.kind && m.kind !== 'market')) return null;
    const q = String(m.question || '');
    const topics = topicsOf(`${q} ${m.description || ''}`);
    if (topics.length === 0) return null;
    return {
        question: q,
        url: m.url || null,
        yesPrice: yesPrice(m),
        volume24h: num(m.volume24hr),
        oneWeekChange: m.oneWeekPriceChange != null ? Number(num(m.oneWeekPriceChange).toFixed(3)) : null,
        topics,
    };
}

// ---------- scoring ----------

function topicsOf(text) {
    const hay = String(text).toLowerCase();
    const hits = [];
    for (const [topic, phrases] of Object.entries(MACRO_TOPICS)) {
        if (phrases.some((p) => hay.includes(p))) hits.push(topic);
    }
    return hits;
}

function ideaDirection(i) {
    const d = String(i.direction || '').toLowerCase();
    if (/long|buy|bull/.test(d)) return 'bullish';
    if (/short|sell|bear/.test(d)) return 'bearish';
    const t = `${i.title || ''} ${i.description || ''}`.toLowerCase();
    if (/\b(long|buy|bullish|breakout up|upside)\b/.test(t)) return 'bullish';
    if (/\b(short|sell|bearish|breakdown|downside)\b/.test(t)) return 'bearish';
    return 'neutral';
}

function computeLean(ideas) {
    const bull = ideas.filter((i) => i.dir === 'bullish').length;
    const bear = ideas.filter((i) => i.dir === 'bearish').length;
    const neutral = ideas.filter((i) => i.dir === 'neutral').length;
    const directional = bull + bear;
    const lean = directional ? (bull - bear) / directional : 0;
    const label = lean >= 0.3 ? 'bullish' : lean <= -0.3 ? 'bearish' : 'mixed';
    return { bull, bear, neutral, total: ideas.length, lean, label };
}

function computeMarketRead(markets) {
    let maxMove = 0; let maxVolume24h = 0;
    for (const m of markets) {
        if (m.oneWeekChange != null) maxMove = Math.max(maxMove, Math.abs(m.oneWeekChange));
        maxVolume24h = Math.max(maxVolume24h, m.volume24h || 0);
    }
    return { maxMove, maxVolume24h };
}

function scoreTrader(ideas, lean) {
    if (!ideas.length) return 0;
    const n = ideas.length;
    let s = n >= 15 ? 10 : n >= 5 ? 6 : n >= 1 ? 3 : 0;
    const strength = Math.abs(lean.lean);
    s += strength >= 0.6 ? 10 : strength >= 0.3 ? 5 : 0;
    if (ideas.some((i) => i.isHot)) s += 3;
    return Math.min(25, s);
}

function scoreMarket(markets, read) {
    if (!markets.length) return 0;
    let s = read.maxVolume24h >= 100000 ? 8 : read.maxVolume24h >= 20000 ? 5 : read.maxVolume24h > 0 ? 2 : 0;
    s += read.maxMove >= 0.1 ? 8 : read.maxMove >= 0.03 ? 4 : 0;
    return Math.min(20, s);
}

function proximity(timeMs) {
    if (!timeMs) return 4;
    const h = (timeMs - Date.now()) / 36e5;
    if (h < 0) return 2;          // already released (still useful as actual vs forecast)
    if (h <= 24) return 20;
    if (h <= 72) return 12;
    if (h <= 168) return 6;
    return 2;
}

// ---------- helpers ----------

function eventTimeMs(e) {
    if (e.timestamp != null) {
        const n = Number(e.timestamp);
        if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n; // seconds vs ms
        const p = Date.parse(e.timestamp);
        if (Number.isFinite(p)) return p;
    }
    if (e.date) {
        const t = e.time && /\d/.test(e.time) ? e.time : '12:00';
        const p = Date.parse(`${e.date} ${t}`);
        if (Number.isFinite(p)) return p;
        const pd = Date.parse(e.date);
        if (Number.isFinite(pd)) return pd;
    }
    return null;
}

function yesPrice(m) {
    if (Array.isArray(m.outcomes)) {
        const yes = m.outcomes.find((o) => String(o.name).toLowerCase() === 'yes');
        if (yes && yes.price != null) return Number(Number(yes.price).toFixed(3));
    }
    if (m.lastTradePrice != null) return Number(num(m.lastTradePrice).toFixed(3));
    return null;
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
