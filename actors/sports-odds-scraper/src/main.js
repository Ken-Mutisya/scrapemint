// Sports Odds Scraper
//
// Live odds from the public JSON endpoints major sportsbooks use to render
// their own web clients. No third party API key required.
//
// Strategy
// --------
// 1. Sports + leagues input maps to per book endpoint IDs (DraftKings event
//    group IDs, Pinnacle league IDs).
// 2. For each (book, league) combination we fetch the public JSON, parse
//    events + markets + outcomes, and merge by (home, away, commence_time).
// 3. Direct event URL input is parsed by the matching book handler, with a
//    JSON-LD SportsEvent fallback for unsupported books.
// 4. Optional best price + arbitrage compute runs once per merged event.
// 5. One row per event with a markets[] array containing every outcome we
//    saw across every book.

import { Actor, log } from 'apify';

const DK_BASE = 'https://sportsbook.draftkings.com/sites/US-SB/api/v5';
const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const PINNACLE_HEADERS = {
    'X-API-Key': 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R',
    'Referer': 'https://www.pinnacle.com/',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// DraftKings publishes a stable event group ID per league. These are the
// stable production IDs for the US site; if a league rotates we degrade
// silently and log a warning.
const DK_EVENT_GROUPS = {
    nfl: 88808,
    ncaaf: 87637,
    nba: 42648,
    wnba: 94682,
    ncaab: 92483,
    mlb: 84240,
    nhl: 42133,
    ufc: 9034,
    boxing: 9033,
    soccer_epl: 40253,
    soccer_laliga: 40031,
    soccer_bundesliga: 40029,
    soccer_seriea: 40030,
    soccer_ligue1: 40032,
    soccer_mls: 40828,
    soccer_uefa_cl: 40685,
    soccer_uefa_el: 40688,
    tennis_atp: 39992,
    tennis_wta: 39993,
    golf_pga: 53353,
    f1: 89197,
    esports_csgo: 13396,
    esports_lol: 14250,
    esports_dota2: 13660,
};

// Pinnacle league IDs. Only the leagues with live coverage; rest fall through
// to the DraftKings only path silently.
const PINNACLE_LEAGUES = {
    nfl: 889,
    ncaaf: 880,
    nba: 487,
    ncaab: 493,
    mlb: 246,
    nhl: 1456,
    ufc: 8676,
    boxing: 1424,
    soccer_epl: 1980,
    soccer_laliga: 2196,
    soccer_bundesliga: 1842,
    soccer_seriea: 2436,
    soccer_ligue1: 2036,
    soccer_mls: 2143,
    soccer_uefa_cl: 2627,
    soccer_uefa_el: 2630,
    tennis_atp: 2417,
    tennis_wta: 2421,
    esports_csgo: 12047,
    esports_lol: 12010,
    esports_dota2: 12011,
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    sports = [],
    eventUrls = [],
    books = ['draftkings', 'pinnacle'],
    markets = ['h2h', 'spreads', 'totals'],
    oddsFormat = 'american',
    computeBestPrice = true,
    computeArbitrage = false,
    minArbPct = 0,
    minBestEdgePct = 0,
    totalMaxEvents = 50,
    maxEventsPerSport = 100,
    includeStartedEvents = false,
    lookAheadHours = 0,
    dedupe = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const sportList = Array.isArray(sports) ? sports.filter(Boolean) : [];
const bookSet = new Set((Array.isArray(books) && books.length > 0 ? books : ['draftkings', 'pinnacle']).map((b) => String(b).toLowerCase()));
const marketSet = new Set((Array.isArray(markets) && markets.length > 0 ? markets : ['h2h', 'spreads', 'totals']).map((m) => String(m).toLowerCase()));
const cap = Number(totalMaxEvents) > 0 ? Number(totalMaxEvents) : Infinity;
const perSportCap = Number(maxEventsPerSport) > 0 ? Number(maxEventsPerSport) : Infinity;
const lookAheadMs = Number(lookAheadHours) > 0 ? Number(lookAheadHours) * 3600 * 1000 : 0;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('sports-odds-scraper-seen') : null;
const seenEventKeys = new Set(seenStore ? (await seenStore.getValue('seen-event-keys')) || [] : []);
let pushedRows = 0;

if (sportList.length === 0 && (!Array.isArray(eventUrls) || eventUrls.length === 0)) {
    log.warning('No input. Provide at least one sport (in sports[]) or one direct event URL (in eventUrls[]).');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

const fetcher = await buildProxiedFetch(proxyConfiguration);

// Aggregate events keyed by `${sport}|${homeNorm}|${awayNorm}|${commenceISO}` so
// the same matchup at different books merges into one row.
const eventBucket = new Map();

for (const sport of sportList) {
    if (pushedRows >= cap) break;
    let perSportCount = 0;

    if (bookSet.has('draftkings') && DK_EVENT_GROUPS[sport]) {
        const events = await fetchDraftKings(sport, DK_EVENT_GROUPS[sport]).catch((err) => {
            log.warning(`DraftKings ${sport} failed: ${err?.message}`);
            return [];
        });
        for (const ev of events) {
            if (perSportCount >= perSportCap) break;
            mergeEvent(ev);
            perSportCount += 1;
        }
        log.info(`DraftKings ${sport}: ${events.length} events.`);
    }

    if (bookSet.has('pinnacle') && PINNACLE_LEAGUES[sport]) {
        const events = await fetchPinnacle(sport, PINNACLE_LEAGUES[sport]).catch((err) => {
            log.warning(`Pinnacle ${sport} failed: ${err?.message}`);
            return [];
        });
        for (const ev of events) {
            if (perSportCount >= perSportCap) break;
            mergeEvent(ev);
            perSportCount += 1;
        }
        log.info(`Pinnacle ${sport}: ${events.length} events.`);
    }
}

if (Array.isArray(eventUrls) && eventUrls.length > 0) {
    const cleaned = eventUrls.map((u) => (typeof u === 'string' ? u : u?.url || '')).filter(Boolean);
    for (const url of cleaned) {
        if (pushedRows >= cap) break;
        const ev = await fetchEventByUrl(url).catch((err) => {
            log.warning(`Event URL ${url} failed: ${err?.message}`);
            return null;
        });
        if (ev) mergeEvent(ev);
    }
}

const now = Date.now();
const merged = [...eventBucket.values()];
const filtered = merged.filter((ev) => {
    if (!ev.commenceTime) return true;
    const ts = Date.parse(ev.commenceTime);
    if (Number.isNaN(ts)) return true;
    if (!includeStartedEvents && ts < now) return false;
    if (lookAheadMs > 0 && ts > now + lookAheadMs) return false;
    return true;
});

filtered.sort((a, b) => Date.parse(a.commenceTime || 0) - Date.parse(b.commenceTime || 0));

for (const ev of filtered) {
    if (pushedRows >= cap) break;
    const key = ev.eventKey;
    if (dedupe && key && seenEventKeys.has(key)) continue;

    const row = finalizeEvent(ev);

    if (row.markets.length === 0) continue;

    if (computeBestPrice || computeArbitrage) attachEdges(row);
    if (computeArbitrage && minArbPct > 0) {
        row.markets = row.markets.map((m) => filterArb(m, minArbPct));
    }

    await Actor.pushData(row);
    if (key) seenEventKeys.add(key);
    pushedRows += 1;
    if (pushedRows > 2) __chargeJobs.push(Actor.charge({ eventName: 'odds_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    log.info(`Pushed ${row.sport} ${row.away} @ ${row.home} (${row.commenceTime || '?'}) | books=${row.books.length} markets=${row.markets.length} (${pushedRows})`);
}

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-event-keys', [...seenEventKeys]);
log.info(`Run complete. Events pushed: ${pushedRows}.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Network ----------

async function buildProxiedFetch(proxy) {
    if (!proxy) return (url, opts) => fetch(url, opts);
    let undiciFetch;
    let ProxyAgent;
    try {
        ({ fetch: undiciFetch, ProxyAgent } = await import('undici'));
    } catch (err) {
        log.warning(`undici unavailable (${err?.message}); falling back to unproxied fetch`);
        return (url, opts) => fetch(url, opts);
    }
    return async (url, opts = {}) => {
        const proxyUrl = await proxy.newUrl();
        return undiciFetch(url, { ...opts, dispatcher: new ProxyAgent(proxyUrl) });
    };
}

async function getJson(url, headers = {}) {
    const res = await fetcher(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ...headers,
        },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
}

// ---------- DraftKings ----------

async function fetchDraftKings(sport, eventGroupId) {
    const url = `${DK_BASE}/eventgroups/${eventGroupId}?format=json`;
    const data = await getJson(url);

    const events = data?.eventGroup?.events || [];
    const offerCategories = data?.eventGroup?.offerCategories || [];
    const offerSubByEvent = new Map();

    for (const cat of offerCategories) {
        const catName = String(cat.name || '').toLowerCase();
        const wantedMarket = catName.includes('game lines') || catName.includes('main')
            ? 'h2h_spreads_totals'
            : catName.includes('player props') || catName.includes('player')
            ? 'player_props'
            : catName.includes('team') ? 'team_totals'
            : catName.includes('first half') ? 'first_half'
            : null;
        if (!wantedMarket) continue;

        const descriptors = cat.offerSubcategoryDescriptors || [];
        for (const desc of descriptors) {
            const subOffers = desc.offerSubcategory?.offers || [];
            for (const offerList of subOffers) {
                for (const offer of offerList) {
                    const eventId = offer.eventId;
                    if (!eventId) continue;
                    if (!offerSubByEvent.has(eventId)) offerSubByEvent.set(eventId, []);
                    offerSubByEvent.get(eventId).push({ ...offer, _market: wantedMarket });
                }
            }
        }
    }

    const out = [];
    for (const ev of events) {
        const home = ev.teamName1 || ev.team1 || null;
        const away = ev.teamName2 || ev.team2 || null;
        const commenceTime = ev.startDate || ev.eventStatusId || null;
        if (!home || !away || !commenceTime) continue;

        const eventKey = makeEventKey(sport, home, away, commenceTime);
        const offers = offerSubByEvent.get(ev.eventId) || [];

        const bookMarkets = [];
        for (const offer of offers) {
            const marketKey = mapDkMarketLabel(offer.label, offer._market);
            if (!marketKey || !marketSet.has(marketKey)) continue;

            const outcomes = (offer.outcomes || []).map((o) => ({
                name: o.label || o.participant || null,
                price: convertOdds(parseFloat(o.oddsDecimal), oddsFormat),
                priceDecimal: Number.isFinite(parseFloat(o.oddsDecimal)) ? parseFloat(o.oddsDecimal) : null,
                point: o.line != null ? Number(o.line) : null,
                participant: o.participant || null,
            })).filter((o) => o.name);
            if (outcomes.length === 0) continue;

            bookMarkets.push({
                key: marketKey,
                label: offer.label,
                outcomes,
            });
        }
        if (bookMarkets.length === 0) continue;

        out.push({
            sport,
            home,
            away,
            commenceTime,
            eventKey,
            sourceUrl: ev.eventGroupName ? `https://sportsbook.draftkings.com/event/${ev.eventId}` : null,
            book: 'draftkings',
            bookMarkets,
        });
    }
    return out;
}

function mapDkMarketLabel(label, fallback) {
    const l = String(label || '').toLowerCase();
    if (/moneyline|money line|match winner|winner|to win/.test(l)) return 'h2h';
    if (/spread|run line|puck line|handicap/.test(l)) return 'spreads';
    if (/total|over\/under|game total/.test(l)) return 'totals';
    if (/team total/.test(l)) return 'team_totals';
    if (/first half|1st half|h1/.test(l)) return 'first_half';
    if (fallback === 'player_props') return 'player_props';
    if (fallback === 'team_totals') return 'team_totals';
    if (fallback === 'first_half') return 'first_half';
    return null;
}

// ---------- Pinnacle ----------

async function fetchPinnacle(sport, leagueId) {
    const matchupsUrl = `${PINNACLE_BASE}/leagues/${leagueId}/matchups?brandId=0`;
    const marketsUrl = `${PINNACLE_BASE}/leagues/${leagueId}/markets/straight?primaryOnly=false`;

    const [matchups, mkts] = await Promise.all([
        getJson(matchupsUrl, PINNACLE_HEADERS),
        getJson(marketsUrl, PINNACLE_HEADERS),
    ]);

    const marketsByMatchup = new Map();
    for (const m of mkts) {
        if (!marketsByMatchup.has(m.matchupId)) marketsByMatchup.set(m.matchupId, []);
        marketsByMatchup.get(m.matchupId).push(m);
    }

    const out = [];
    for (const ma of matchups) {
        if (ma.parent || ma.type === 'special') continue;
        const home = ma.participants?.find((p) => p.alignment === 'home')?.name;
        const away = ma.participants?.find((p) => p.alignment === 'away')?.name;
        const commenceTime = ma.startTime;
        if (!home || !away || !commenceTime) continue;

        const eventKey = makeEventKey(sport, home, away, commenceTime);
        const matchupMarkets = marketsByMatchup.get(ma.id) || [];

        const designationToName = { home, away };

        const bookMarkets = [];
        for (const m of matchupMarkets) {
            const marketKey = mapPinnacleMarket(m.type, m.period);
            if (!marketKey || !marketSet.has(marketKey)) continue;

            const outcomes = (m.prices || []).map((p) => {
                const american = p.price != null ? Number(p.price) : null;
                const decimal = americanToDecimal(american);
                const designation = p.designation || null;
                const name = (m.type === 'moneyline' || m.type === 'spread')
                    ? (designationToName[designation] || designation)
                    : designation;
                return {
                    name,
                    price: convertOdds(decimal, oddsFormat),
                    priceDecimal: decimal,
                    point: p.points != null ? Number(p.points) : null,
                    participant: designation,
                };
            }).filter((o) => o.name && o.priceDecimal != null);
            if (outcomes.length === 0) continue;

            bookMarkets.push({
                key: marketKey,
                label: `${m.type} (period ${m.period})`,
                outcomes,
            });
        }
        if (bookMarkets.length === 0) continue;

        out.push({
            sport,
            home,
            away,
            commenceTime,
            eventKey,
            sourceUrl: `https://www.pinnacle.com/en/${sport}/matchup/${ma.id}`,
            book: 'pinnacle',
            bookMarkets,
        });
    }
    return out;
}

function mapPinnacleMarket(type, period) {
    // period semantics differ by sport. Period 0 is full match for most sports
    // (NFL, MLB, NHL, soccer 90 min, tennis match). Period 3 is full game for
    // NBA / WNBA. Period 1 is first half (or set 1 in tennis). Anything else
    // is in play / quarter / set splits which we treat as first_half for
    // simplicity, unless the input asked for player_props.
    if (![0, 1, 3].includes(period)) return null;
    const t = String(type || '').toLowerCase();
    if (t === 'moneyline') return period === 1 ? 'first_half' : 'h2h';
    if (t === 'spread') return period === 1 ? 'first_half' : 'spreads';
    if (t === 'total') return period === 1 ? 'first_half' : 'totals';
    if (t === 'team_total') return 'team_totals';
    return null;
}

function americanToDecimal(american) {
    if (!Number.isFinite(american) || american === 0) return null;
    if (american > 0) return Number((american / 100 + 1).toFixed(4));
    return Number((100 / Math.abs(american) + 1).toFixed(4));
}

// ---------- URL handler ----------

async function fetchEventByUrl(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }

    if (host.includes('sportsbook.draftkings.com')) {
        const m = url.match(/\/event\/[^/]*?\/(\d+)/) || url.match(/\/event\/(\d+)/);
        if (!m) return null;
        const data = await getJson(`${DK_BASE}/event/${m[1]}?format=json`).catch(() => null);
        if (!data?.event) return null;
        return parseDkEvent(data);
    }
    if (host.includes('pinnacle.com')) {
        const m = url.match(/matchup\/([^/?#]+)/);
        if (!m) return null;
        return null;
    }
    return await fetchEventByJsonLd(url);
}

function parseDkEvent(payload) {
    const ev = payload.event;
    const sport = inferSportFromName(payload?.eventGroupName || ev?.eventGroupName || '');
    const home = ev.teamName1;
    const away = ev.teamName2;
    const commenceTime = ev.startDate;
    if (!home || !away || !commenceTime) return null;
    const eventKey = makeEventKey(sport, home, away, commenceTime);

    const bookMarkets = [];
    for (const cat of payload.eventCategories || []) {
        for (const desc of cat.componentizedOffers || []) {
            for (const offer of desc.offers || []) {
                const marketKey = mapDkMarketLabel(offer.label, null);
                if (!marketKey || !marketSet.has(marketKey)) continue;
                const outcomes = (offer.outcomes || []).map((o) => ({
                    name: o.label || null,
                    price: convertOdds(parseFloat(o.oddsDecimal), oddsFormat),
                    priceDecimal: Number.isFinite(parseFloat(o.oddsDecimal)) ? parseFloat(o.oddsDecimal) : null,
                    point: o.line != null ? Number(o.line) : null,
                    participant: o.participant || null,
                })).filter((o) => o.name);
                if (outcomes.length > 0) bookMarkets.push({ key: marketKey, label: offer.label, outcomes });
            }
        }
    }

    return {
        sport,
        home,
        away,
        commenceTime,
        eventKey,
        sourceUrl: `https://sportsbook.draftkings.com/event/${ev.eventId}`,
        book: 'draftkings',
        bookMarkets,
    };
}

async function fetchEventByJsonLd(url) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
        args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
        const ctx = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US',
        });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const data = await page.evaluate(() => {
            const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
            const out = [];
            for (const b of blocks) {
                try { out.push(JSON.parse(b.textContent || '')); } catch {}
            }
            return out;
        });
        await browser.close();

        const flatten = (b) => Array.isArray(b) ? b : (b?.['@graph'] ? b['@graph'] : [b]);
        for (const block of data) {
            for (const item of flatten(block)) {
                if (!item) continue;
                const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
                if (!types.some((t) => /SportsEvent|Event/i.test(String(t)))) continue;
                const home = item.homeTeam?.name || item.homeTeam || null;
                const away = item.awayTeam?.name || item.awayTeam || null;
                const commenceTime = item.startDate || item.startTime || null;
                if (!home || !away) continue;
                const sport = inferSportFromName(item.sport || item.name || '');
                return {
                    sport,
                    home,
                    away,
                    commenceTime,
                    eventKey: makeEventKey(sport, home, away, commenceTime || ''),
                    sourceUrl: url,
                    book: 'jsonld',
                    bookMarkets: [],
                };
            }
        }
        return null;
    } catch (err) {
        try { await browser.close(); } catch {}
        throw err;
    }
}

function inferSportFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/nfl|football/.test(n)) return 'nfl';
    if (/nba|basketball/.test(n)) return 'nba';
    if (/mlb|baseball/.test(n)) return 'mlb';
    if (/nhl|hockey/.test(n)) return 'nhl';
    if (/ufc|mma/.test(n)) return 'ufc';
    if (/soccer|football|epl|premier|laliga|bundesliga|serie a|ligue 1|mls|uefa/.test(n)) return 'soccer';
    if (/tennis/.test(n)) return 'tennis';
    if (/golf/.test(n)) return 'golf';
    return 'other';
}

// ---------- Bucketing ----------

function makeEventKey(sport, home, away, commenceTime) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
    return `${sport}|${norm(home)}|${norm(away)}|${String(commenceTime).slice(0, 16)}`;
}

function mergeEvent(ev) {
    const key = ev.eventKey;
    if (!key) return;
    if (!eventBucket.has(key)) {
        eventBucket.set(key, {
            sport: ev.sport,
            home: ev.home,
            away: ev.away,
            commenceTime: ev.commenceTime,
            eventKey: key,
            books: [],
            markets: [], // populated in finalizeEvent
            sources: [],
            byBook: {}, // book -> markets[]
        });
    }
    const bucket = eventBucket.get(key);
    if (!bucket.books.includes(ev.book)) bucket.books.push(ev.book);
    if (ev.sourceUrl && !bucket.sources.includes(ev.sourceUrl)) bucket.sources.push(ev.sourceUrl);
    bucket.byBook[ev.book] = (bucket.byBook[ev.book] || []).concat(ev.bookMarkets || []);
}

function finalizeEvent(bucket) {
    // Group markets across books by (key, point|null) so we end up with one
    // entry per market line with prices indexed by book.
    const byMarketKey = new Map();
    for (const [book, marketsArr] of Object.entries(bucket.byBook)) {
        for (const m of marketsArr) {
            const existing = byMarketKey.get(m.key) || { key: m.key, label: m.label, outcomes: new Map() };
            for (const o of m.outcomes) {
                const outcomeKey = `${(o.name || '').toLowerCase()}|${o.point ?? ''}`;
                const cur = existing.outcomes.get(outcomeKey) || { name: o.name, point: o.point, prices: {} };
                cur.prices[book] = { price: o.price, decimal: o.priceDecimal };
                existing.outcomes.set(outcomeKey, cur);
            }
            byMarketKey.set(m.key, existing);
        }
    }

    const markets = [];
    for (const m of byMarketKey.values()) {
        markets.push({
            key: m.key,
            label: m.label,
            outcomes: [...m.outcomes.values()],
        });
    }

    return {
        sport: bucket.sport,
        home: bucket.home,
        away: bucket.away,
        commenceTime: bucket.commenceTime,
        eventKey: bucket.eventKey,
        books: bucket.books,
        sources: bucket.sources,
        markets,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- Best price + arbitrage ----------

function attachEdges(row) {
    for (const m of row.markets) {
        for (const o of m.outcomes) {
            const decimals = Object.entries(o.prices)
                .map(([book, p]) => ({ book, decimal: p.decimal }))
                .filter((p) => Number.isFinite(p.decimal));
            if (decimals.length === 0) continue;

            if (decimals.length < 2) continue;
            const bestEntry = decimals.reduce((a, b) => (b.decimal > a.decimal ? b : a));
            const avg = decimals.reduce((s, p) => s + p.decimal, 0) / decimals.length;
            const edgePct = avg > 0 ? ((bestEntry.decimal - avg) / avg) * 100 : 0;

            if (computeBestPrice && (minBestEdgePct === 0 || edgePct >= minBestEdgePct)) {
                o.bestPrice = {
                    book: bestEntry.book,
                    price: convertOdds(bestEntry.decimal, oddsFormat),
                    decimal: bestEntry.decimal,
                    averageDecimal: Number(avg.toFixed(4)),
                    edgePctVsAverage: Number(edgePct.toFixed(2)),
                };
            }
        }

        if (computeArbitrage && (m.key === 'h2h' || m.key === 'totals' || m.key === 'spreads')) {
            const arb = detectArb(m);
            if (arb && arb.edgePct >= minArbPct) m.arbitrage = arb;
        }
    }
}

function detectArb(market) {
    const groups = new Map();
    for (const o of market.outcomes) {
        const k = String(o.point ?? '');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
    }
    let best = null;
    for (const [point, outcomes] of groups) {
        if (outcomes.length < 2) continue;
        const sides = {};
        for (const o of outcomes) {
            for (const [book, p] of Object.entries(o.prices)) {
                if (!Number.isFinite(p.decimal) || p.decimal <= 1) continue;
                const cur = sides[o.name];
                if (!cur || p.decimal > cur.decimal) sides[o.name] = { book, decimal: p.decimal, name: o.name };
            }
        }
        const sideKeys = Object.keys(sides);
        if (sideKeys.length < 2) continue;
        const inv = sideKeys.reduce((s, k) => s + 1 / sides[k].decimal, 0);
        if (inv >= 1) continue;
        const edgePct = Number(((1 - inv) * 100).toFixed(2));
        if (!best || edgePct > best.edgePct) {
            best = {
                point: point || null,
                edgePct,
                sides: sideKeys.map((k) => ({ name: k, book: sides[k].book, decimal: sides[k].decimal })),
            };
        }
    }
    return best;
}

function filterArb(market, minPct) {
    if (market.arbitrage && market.arbitrage.edgePct < minPct) {
        const { arbitrage, ...rest } = market;
        return rest;
    }
    return market;
}

// ---------- Odds conversion ----------

function convertOdds(decimal, format) {
    if (!Number.isFinite(decimal) || decimal <= 1) return null;
    if (format === 'decimal') return Number(decimal.toFixed(3));
    if (format === 'american') {
        if (decimal >= 2) return Math.round((decimal - 1) * 100);
        return Math.round(-100 / (decimal - 1));
    }
    if (format === 'fractional') {
        const num = decimal - 1;
        const denom = 1;
        const gcdInt = (a, b) => (b ? gcdInt(b, a % b) : a);
        const scale = 1000;
        const a = Math.round(num * scale);
        const b = Math.round(denom * scale);
        const g = gcdInt(a, b) || 1;
        return `${a / g}/${b / g}`;
    }
    if (format === 'implied_probability') return Number((1 / decimal).toFixed(4));
    return Number(decimal.toFixed(3));
}
