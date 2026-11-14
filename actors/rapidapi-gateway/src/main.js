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
