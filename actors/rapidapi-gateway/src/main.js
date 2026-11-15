// Scrapemint RapidAPI gateway (private, Apify Standby).
//
// RapidAPI forwards subscriber calls here. Every request must carry the
// X-RapidAPI-Proxy-Secret header RapidAPI adds (secrets in env RAPIDAPI_SECRETS,
// comma separated, one per RapidAPI listing). Query params are mapped onto a
// fixed, capped actor input: proxy settings, concurrency and row limits are
// never taken from the caller, so a subscriber cannot run up our Apify bill.

import http from 'node:http';
import { Actor, log } from 'apify';

await Actor.init();

const SECRETS = (process.env.RAPIDAPI_SECRETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.ACTOR_WEB_SERVER_PORT || process.env.ACTOR_STANDBY_PORT || 4321);
const RUN_TIMEOUT_SECS = 150;

const list = (v, max) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, max);
const int = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const num = (v, def, min, max) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes)$/i.test(String(v)));
const pick = (v, allowed, def) => (allowed.includes(String(v)) ? String(v) : def);
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

class BadRequest extends Error {}

const ROUTES = {
    '/tech-stack': {
        actor: 'scrapemint/website-tech-stack-detector',
        memory: 1024,
        input: (q) => {
            const websites = list(q.websites || q.website || q.domain, 10);
            if (!websites.length) throw new BadRequest('Pass websites=example.com,shop.com (up to 10).');
            return { websites };
        },
    },
    '/odds': {
        actor: 'scrapemint/sports-odds-scraper',
        memory: 1024,
        input: (q) => ({
            sports: list(q.sports || q.sport, 5).length ? list(q.sports || q.sport, 5) : ['nfl', 'nba', 'nhl', 'ncaaf', 'soccer_epl'],
            books: list(q.books, 3),
            markets: list(q.markets, 3).length ? list(q.markets, 3) : ['h2h', 'spreads', 'totals'],
            oddsFormat: pick(q.oddsFormat, ['american', 'decimal', 'fractional', 'implied_probability'], 'american'),
            computeBestPrice: true,
            computeArbitrage: bool(q.arbitrage, false),
            minArbPct: num(q.minArbPct, 0, 0, 50),
            totalMaxEvents: int(q.maxEvents, 50, 1, 150),
            maxEventsPerSport: 100,
            includeStartedEvents: bool(q.includeStarted, false),
            lookAheadHours: int(q.lookAheadHours, 0, 0, 720),
            dedupe: false,
            concurrency: 4,
            proxyConfiguration: { useApifyProxy: false },
        }),
    },
    '/economic-calendar': {
        actor: 'scrapemint/forexfactory-economic-calendar',
        memory: 1024,
        // The actor stops 150s before its deadline; the browser path (actuals) needs ~70s more.
        timeout: 300,
        input: (q) => {
            const startDate = date(q.startDate);
            const endDate = date(q.endDate);
            return {
                range: startDate && endDate ? 'custom'
                    : pick(q.range, ['today', 'tomorrow', 'yesterday', 'this_week', 'next_week', 'last_week', 'this_month', 'next_month'], 'this_week'),
                startDate,
                endDate,
                currencies: list(q.currencies || q.currency, 10).map((c) => c.toUpperCase()),
                impactLevels: (() => { const l = list(q.impact, 4).map((x) => x.toLowerCase()).filter((x) => ['high', 'medium', 'low', 'holiday'].includes(x)); return l.length ? l : ['high', 'medium']; })(),
                includeDetail: false,
                includeActuals: bool(q.actuals, true),
                maxEvents: int(q.maxEvents, 300, 1, 500),
                concurrency: 2,
            };
        },
    },
    '/kalshi': {
        actor: 'scrapemint/kalshi-prediction-market-scraper',
        memory: 1024,
        input: (q) => ({
            categories: list(q.categories || q.category, 5),
            keywords: list(q.keywords || q.keyword, 5),
            eventTickers: list(q.eventTickers, 10),
            seriesTickers: list(q.seriesTickers, 10),
            status: pick(q.status, ['open', 'closed', 'settled'], 'open'),
            onlyPriced: bool(q.onlyPriced, true),
            minVolume: int(q.minVolume, 0, 0, 1e9),
            maxRows: int(q.maxRows, 100, 1, 300),
        }),
    },
    '/options': {
        actor: 'scrapemint/stock-options-scraper',
        memory: 1024,
        input: (q) => {
            const symbols = list(q.symbols || q.symbol, 5).map((s) => s.toUpperCase());
            if (!symbols.length) throw new BadRequest('Pass symbols=NVDA,TSLA (up to 5).');
            return {
                mode: pick(q.mode, ['unusual', 'chain', 'summary'], 'unusual'),
                symbols,
                optionType: pick(q.optionType, ['both', 'call', 'put'], 'both'),
                minVolume: int(q.minVolume, 500, 0, 1e9),
                minVolumeOiRatio: num(q.minVolumeOiRatio, 5, 0, 1e6),
                minOpenInterest: int(q.minOpenInterest, 0, 0, 1e9),
                expiries: list(q.expiries, 6).filter((d) => date(d)),
                maxDaysToExpiry: int(q.maxDaysToExpiry, 0, 0, 1000),
                moneynessPercent: int(q.moneynessPercent, 0, 0, 100),
                sortBy: pick(q.sortBy, ['volume', 'openInterest', 'volumeOiRatio', 'impliedVolatility'], 'volume'),
                maxRows: int(q.maxRows, 200, 1, 500),
            };
        },
    },
    '/polymarket': {
        actor: 'scrapemint/polymarket-market-monitor',
        memory: 1024,
        input: (q) => {
            const max = int(q.maxItems, 100, 1, 200);
            return {
                searchQueries: list(q.query || q.search, 3),
                categories: list(q.categories || q.category, 5),
                tagIds: list(q.tagIds, 5),
                itemType: pick(q.itemType, ['markets', 'events'], 'markets'),
                status: pick(q.status, ['active', 'closed', 'all'], 'active'),
                minVolume24h: int(q.minVolume24h, 0, 0, 1e8),
                minLiquidity: int(q.minLiquidity, 0, 0, 1e8),
                minTotalVolume: int(q.minTotalVolume, 0, 0, 1e9),
                minPriceChangePct: int(q.minPriceChangePct, 0, 0, 100),
                minutesUntilEnd: int(q.minutesUntilEnd, 0, 0, 525600),
                sortBy: pick(q.sortBy, ['volume24hr', 'liquidity', 'endDate', 'startDate', 'volumeNum'], 'volume24hr'),
                // Search is a substring filter applied after fetching, so scan widely and cap the output.
                maxItemsPerSource: 1000,
                maxItemsTotal: max,
                dedupe: false,
            };
        },
    },
    '/twitch-streamers': {
        actor: 'scrapemint/twitch-streamer-leads',
        memory: 1024,
        input: (q) => {
            const categories = list(q.categories || q.category || q.game, 3);
            const searchQueries = list(q.query || q.search, 3);
            const logins = list(q.logins || q.login, 20);
            if (!categories.length && !searchQueries.length && !logins.length) throw new BadRequest('Pass categories=Fortnite, query=... or logins=name1,name2.');
            const out = {
                categories, searchQueries, logins,
                requireEmail: bool(q.requireEmail, false),
                maxStreamers: int(q.maxStreamers, 50, 1, 100),
                dedupe: false,
            };
            if (q.minFollowers) out.minFollowers = int(q.minFollowers, 0, 0, 1e9);
            if (q.maxFollowers) out.maxFollowers = int(q.maxFollowers, 0, 0, 1e9);
            return out;
        },
    },
    '/website-history': {
        actor: 'scrapemint/website-history-checker',
        memory: 1024,
        input: (q) => {
            const websites = list(q.websites || q.website || q.domain, 5);
            if (!websites.length) throw new BadRequest('Pass websites=example.com (up to 5).');
            return {
                websites,
                includeSnapshots: bool(q.includeSnapshots, true),
                granularity: pick(q.granularity, ['yearly', 'monthly'], 'yearly'),
                fromYear: int(q.fromYear, 0, 0, 2100),
                toYear: int(q.toYear, 0, 0, 2100),
                maxSnapshotsPerSite: int(q.maxSnapshotsPerSite, 50, 1, 100),
                maxRows: int(q.maxRows, 300, 1, 500),
            };
        },
    },
    '/tradingview-ideas': {
        actor: 'scrapemint/tradingview-ideas-scraper',
        memory: 1024,
        input: (q) => ({
            symbols: list(q.symbols || q.symbol, 5).map((x) => x.toUpperCase()),
            categories: list(q.categories || q.category, 3),
            tags: list(q.tags || q.tag, 3),
            direction: pick(q.direction, ['all', 'long', 'short', 'education'], 'all'),
            maxIdeasPerSource: int(q.maxIdeas, 30, 1, 100),
            includeAuthorIntel: bool(q.includeAuthor, true),
            concurrency: 3,
        }),
    },
    '/keyword-suggestions': {
        actor: 'scrapemint/google-keyword-suggestions-scraper',
        memory: 1024,
        input: (q) => {
            const keywords = list(q.keywords || q.keyword || q.q, 3);
            if (!keywords.length) throw new BadRequest('Pass keywords=seed phrase (up to 3, comma separated).');
            return {
                keywords,
                source: pick(q.source, ['google', 'youtube'], 'google'),
                language: /^[a-z]{2}(-[A-Za-z]{2})?$/.test(String(q.language || '')) ? String(q.language) : 'en',
                country: /^[a-z]{2}$/i.test(String(q.country || '')) ? String(q.country).toLowerCase() : 'us',
                expandLetters: bool(q.expandLetters, true),
                expandDigits: bool(q.expandDigits, false),
                expandQuestions: bool(q.expandQuestions, true),
                expandPrepositions: bool(q.expandPrepositions, true),
                maxRowsPerKeyword: int(q.maxRowsPerKeyword, 300, 1, 400),
                maxRows: int(q.maxRows, 600, 1, 1000),
            };
        },
    },
    '/shopify-store': {
        actor: 'scrapemint/shopify-theme-app-detector',
        memory: 512,
        input: (q) => {
            const urls = list(q.urls || q.url || q.domain || q.domains, 10);
            if (!urls.length) throw new BadRequest('Pass urls=allbirds.com,gymshark.com (up to 10).');
            return { urls, includeStoreDetails: bool(q.storeDetails, true), concurrency: 5, maxRows: 10 };
        },
    },
    '/wordpress-site': {
        actor: 'scrapemint/wordpress-theme-plugin-detector',
        memory: 512,
        input: (q) => {
            const urls = list(q.urls || q.url || q.domain || q.domains, 10);
            if (!urls.length) throw new BadRequest('Pass urls=techcrunch.com,yoast.com (up to 10).');
            return { urls, enrichFromWordPressOrg: bool(q.latestVersions, true), checkRestApi: bool(q.restApi, true), concurrency: 5, maxRows: 10 };
        },
    },
    '/ads-txt': {
        actor: 'scrapemint/ads-txt-checker',
        // Seller verification can load Google's ~100 MB sellers.json.
        memory: 2048,
        timeout: 170,
        input: (q) => {
            const domains = list(q.domains || q.domain, 10);
            if (!domains.length) throw new BadRequest('Pass domains=cnn.com,nytimes.com (up to 10).');
            return {
                domains,
                fileType: pick(q.fileType, ['ads.txt', 'app-ads.txt', 'both'], 'ads.txt'),
                verifySellers: bool(q.verifySellers, false),
                maxSellersFiles: int(q.maxSellersFiles, 10, 1, 15),
                includeEntries: bool(q.includeEntries, true),
                concurrency: 5,
                maxRows: 20,
            };
        },
    },
    '/gamma-exposure': {
        actor: 'scrapemint/options-max-pain-gamma-exposure',
        memory: 1024,
        input: (q) => {
            const symbols = list(q.symbols || q.symbol || q.ticker, 5).map((s) => s.toUpperCase());
            if (!symbols.length) throw new BadRequest('Pass symbols=SPY,SPX,TSLA (up to 5).');
            return {
                symbols,
                maxDaysToExpiry: int(q.maxDaysToExpiry, 60, 0, 365),
                maxExpiries: int(q.maxExpiries, 6, 1, 12),
                includeExpiryRows: bool(q.expiryRows, true),
                strikeRangePercent: int(q.strikeRangePercent, 25, 1, 100),
                topStrikes: int(q.topStrikes, 10, 1, 25),
            };
        },
    },
    '/earnings-expected-move': {
        actor: 'scrapemint/earnings-expected-move',
        memory: 512,
        input: (q) => ({
            symbols: list(q.symbols || q.symbol || q.ticker, 10).map((s) => s.toUpperCase()),
            daysAhead: int(q.daysAhead, 7, 0, 21),
            minMarketCapUsd: num(q.minMarketCap, 10000000000, 0, 5e12),
            maxCompanies: int(q.maxCompanies, 25, 1, 40),
            sortBy: pick(q.sortBy, ['expectedMovePct', 'earningsDate', 'marketCapUsd'], 'expectedMovePct'),
        }),
    },
};

const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Apify readiness probe and bare root
    if (req.headers['x-apify-container-server-readiness-probe'] || url.pathname === '/') return send(res, 200, { ok: true });
    if (!SECRETS.length || !SECRETS.includes(String(req.headers['x-rapidapi-proxy-secret'] || ''))) {
        return send(res, 403, { error: 'Forbidden: call this API through RapidAPI.' });
    }
    const route = ROUTES[url.pathname.replace(/\/+$/, '')];
    if (!route || req.method !== 'GET') return send(res, 404, { error: `Unknown endpoint. Use GET ${Object.keys(ROUTES).join(', ')}` });
    let input;
    try {
        input = route.input(Object.fromEntries(url.searchParams));
    } catch (e) {
        return send(res, 400, { error: e.message });
    }
    const started = Date.now();
    try {
        const run = await Actor.call(route.actor, input, { memory: route.memory, timeout: route.timeout || RUN_TIMEOUT_SECS });
        const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({ clean: true, limit: 1000 });
        log.info('served', { path: url.pathname, user: req.headers['x-rapidapi-user'], status: run.status, rows: items.length, ms: Date.now() - started });
        if (run.status !== 'SUCCEEDED' && !items.length) return send(res, 502, { error: `Upstream run ${run.status}. Try again or narrow the query.` });
        return send(res, 200, { count: items.length, items });
    } catch (e) {
        log.exception(e, 'call failed', { path: url.pathname });
        return send(res, 502, { error: 'Upstream error. Try again shortly.' });
    }
});

server.requestTimeout = 0;
server.listen(PORT, () => log.info(`gateway listening on ${PORT}`));
