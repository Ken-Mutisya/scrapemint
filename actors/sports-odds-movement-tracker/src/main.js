// Sports Odds Movement Tracker
// Pulls live sports betting lines across 40+ sportsbooks via The Odds API.
// Aggregates h2h, spreads, and totals per event, computes best price per
// outcome and detects arbitrage opportunities.
//
// Endpoints:
//   https://api.the-odds-api.com/v4/sports
//   https://api.the-odds-api.com/v4/sports/{sport}/odds
//
// Requires an API key from the-odds-api.com (free tier: 500 req / month).
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 50;
const RATE_SLEEP_MS = 250;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    apiKey = '',
    sports = [],
    regions = ['us'],
    markets = ['h2h'],
    bookmakers = [],
    oddsFormat = 'american',
    minArbPct = 0,
    minBestEdgePct = 0,
    arbOnly = false,
    maxItemsPerSport = 100,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

if (!String(apiKey).trim()) {
    throw new Error('apiKey is required. Get a free key at the-odds-api.com.');
}

const sportList = toArray(sports).map((s) => String(s).trim()).filter(Boolean);
if (sportList.length === 0) {
    throw new Error('Provide at least one sport key (e.g., "americanfootball_nfl", "basketball_nba").');
}

const regionList = toArray(regions).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
const marketList = toArray(markets).map((m) => String(m).trim().toLowerCase()).filter(Boolean);
const bookFilter = new Set(toArray(bookmakers).map((b) => String(b).trim().toLowerCase()).filter(Boolean));

await Actor.createProxyConfiguration(proxyInput);

const store = await Actor.openKeyValueStore('sports-odds-tracker-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let apiRequests = 0;

log.info(`Fetching ${sportList.length} sport(s). regions=${regionList.join(',')} markets=${marketList.join(',')}`);

for (const sport of sportList) {
    if (totalPushed >= maxItemsTotal) break;
    await processSport(sport);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} apiRequests=${apiRequests}`);
await Actor.exit();

async function processSport(sport) {
    const url = buildUrl(`/v4/sports/${encodeURIComponent(sport)}/odds`, {
        apiKey,
        regions: regionList.join(','),
        markets: marketList.join(','),
        oddsFormat,
        dateFormat: 'iso',
        bookmakers: bookFilter.size > 0 ? [...bookFilter].join(',') : undefined,
    });

    await sleep(RATE_SLEEP_MS);
    apiRequests += 1;
    let events;
    try {
        const res = await fetch(url);
        const remaining = res.headers.get('x-requests-remaining');
        const used = res.headers.get('x-requests-used');
        if (remaining != null) log.info(`Odds API quota: used=${used} remaining=${remaining}`);

        if (res.status === 401) throw new Error('Odds API rejected your key (401). Check apiKey.');
        if (res.status === 422) { log.warning(`422 for sport "${sport}". Unknown sport key or market combination.`); return; }
        if (!res.ok) { log.warning(`HTTP ${res.status} on ${url.replace(apiKey, 'REDACTED')}`); return; }
        events = await res.json();
    } catch (err) {
        log.warning(`fetch failed for ${sport}: ${err?.message}`);
        return;
    }

    if (!Array.isArray(events)) return;
    log.info(`${sport}: ${events.length} events returned.`);

    let pulled = 0;
    for (const ev of events) {
        if (pulled >= maxItemsPerSport) break;
        if (totalPushed >= maxItemsTotal) break;

        for (const marketKey of marketList) {
            if (pulled >= maxItemsPerSport) break;
            if (totalPushed >= maxItemsTotal) break;

            const row = shapeRow(ev, marketKey);
            if (!row) continue;
            totalSeen += 1;

            const arbOk = !arbOnly || row.arbitrage?.exists === true;
            const arbPctOk = minArbPct <= 0 || (row.arbitrage?.profitPct ?? 0) >= minArbPct;
            const edgeOk = minBestEdgePct <= 0 || (row.bestEdgePct ?? 0) >= minBestEdgePct;
            if (!(arbOk && arbPctOk && edgeOk)) { filteredOut += 1; continue; }

            if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; continue; }

            await Actor.pushData(row);
            totalPushed += 1;
            pulled += 1;
            newSeen.add(row.dedupeKey);
            maybeCharge();
        }
    }
}

function shapeRow(ev, marketKey) {
    if (!ev?.id || !Array.isArray(ev.bookmakers)) return null;

    const bookLines = [];
    for (const bk of ev.bookmakers) {
        if (bookFilter.size > 0 && !bookFilter.has(String(bk.key).toLowerCase())) continue;
        const market = (bk.markets || []).find((m) => m.key === marketKey);
        if (!market) continue;

        bookLines.push({
            bookmaker: bk.key,
            title: bk.title,
            lastUpdate: bk.last_update || null,
            outcomes: (market.outcomes || []).map((o) => ({
                name: o.name,
                price: toNumber(o.price),
                point: o.point !== undefined ? toNumber(o.point) : null,
                description: o.description || null,
            })),
        });
    }

    if (bookLines.length === 0) return null;

    const outcomeNames = collectOutcomeNames(bookLines);
    const bestByOutcome = {};
    for (const name of outcomeNames) {
        let best = null;
        for (const bl of bookLines) {
            const o = bl.outcomes.find((x) => x.name === name);
            if (!o || o.price == null) continue;
            const decimal = toDecimal(o.price, oddsFormat);
            if (!decimal) continue;
            if (!best || decimal > best.decimal) {
                best = { bookmaker: bl.bookmaker, title: bl.title, price: o.price, decimal, point: o.point };
            }
        }
        if (best) bestByOutcome[name] = best;
    }

    const arbitrage = computeArb(bestByOutcome);
    const bestEdgePct = computeBestEdge(bookLines, outcomeNames, oddsFormat);

    const dedupeKey = `${ev.id}#${marketKey}`;
    const url = `https://sportsbook.draftkings.com/event/${ev.id}`;

    return {
        eventId: ev.id,
        sportKey: ev.sport_key,
        sportTitle: ev.sport_title,
        commenceTime: ev.commence_time,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        marketKey,
        marketLabel: marketLabel(marketKey),
        bookCount: bookLines.length,
        bookmakers: bookLines,
        bestPrices: bestByOutcome,
        bestEdgePct,
        arbitrage,
        url,
        dedupeKey,
        scrapedAt: new Date().toISOString(),
    };
}

function collectOutcomeNames(bookLines) {
    const counts = new Map();
    for (const bl of bookLines) {
        for (const o of bl.outcomes) {
            counts.set(o.name, (counts.get(o.name) || 0) + 1);
        }
    }
    return [...counts.keys()];
}

function computeArb(bestByOutcome) {
    const entries = Object.values(bestByOutcome);
    if (entries.length < 2) return { exists: false };
    const sumImplied = entries.reduce((s, e) => s + (1 / e.decimal), 0);
    const profit = (1 - sumImplied);
    return {
        exists: profit > 0,
        profitPct: +(profit * 100).toFixed(3),
        sumImpliedProb: +sumImplied.toFixed(4),
    };
}

function computeBestEdge(bookLines, outcomeNames, format) {
    let maxEdge = 0;
    for (const name of outcomeNames) {
        const decimals = [];
        for (const bl of bookLines) {
            const o = bl.outcomes.find((x) => x.name === name);
            if (!o || o.price == null) continue;
            const d = toDecimal(o.price, format);
            if (d) decimals.push(d);
        }
        if (decimals.length < 2) continue;
        const sorted = [...decimals].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const best = Math.max(...decimals);
        const edge = ((best - median) / median) * 100;
        if (edge > maxEdge) maxEdge = edge;
    }
    return +maxEdge.toFixed(3);
}

function toDecimal(price, format) {
    if (price == null) return null;
    const p = Number(price);
    if (!Number.isFinite(p)) return null;
    if (String(format).toLowerCase() === 'decimal') return p;
    if (p >= 100) return 1 + p / 100;
    if (p <= -100) return 1 + 100 / Math.abs(p);
    return null;
}

function marketLabel(key) {
    switch (key) {
        case 'h2h': return 'Moneyline';
        case 'spreads': return 'Point spread';
        case 'totals': return 'Over / under';
        case 'outrights': return 'Futures';
        default: return key;
    }
}

function buildUrl(path, params) {
    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `https://api.the-odds-api.com${path}${qs ? '?' + qs : ''}`;
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'item_extracted' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
