// Sports Odds Scraper
//
// Strategy (rebuilt 2026-07-16)
// ----------------------------
// The original DraftKings and Pinnacle endpoints went dark for automated
// access (DK 403s every client, Pinnacle blocks cloud IPs), so odds come from
// two keyless feeds that are reachable from datacenter IPs with no proxy:
// ESPN's public scoreboard, which carries one bookmaker's block per game
// (typically DraftKings), and Bovada's own coupon feed. One GET per sport per
// feed covers today plus the look-ahead window.
//
// Bovada events are joined onto ESPN events on an EXACT key (both team names
// plus the start time to the minute), never a fuzzy match, because a wrong
// pairing would invent an arbitrage edge someone then stakes money on.
//
// Input stays byte-compatible with the original schema so existing
// scheduled runs keep working: `books` is accepted and ignored (both feeds
// are always read), `eventUrls` returns a free explanatory row, everything
// else behaves as before. Output rows keep the same shape (markets[] with
// per-book prices), so downstream buyer pipelines keep parsing.
//
// Pay per event
// -------------
//   odds_row per event row with at least one market. First 2 rows per run
//   free. Events without odds are skipped, never charged.

import { Actor, log } from 'apify';

// Old input keys -> ESPN sport/league paths, plus friendly aliases. Raw
// "sport/league" ESPN paths pass through, so any ESPN-covered league works.
const SPORT_PATHS = {
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    nba: 'basketball/nba',
    wnba: 'basketball/wnba',
    ncaab: 'basketball/mens-college-basketball',
    mlb: 'baseball/mlb',
    nhl: 'hockey/nhl',
    ufc: 'mma/ufc',
    soccer_epl: 'soccer/eng.1',
    soccer_laliga: 'soccer/esp.1',
    soccer_bundesliga: 'soccer/ger.1',
    soccer_seriea: 'soccer/ita.1',
    soccer_ligue1: 'soccer/fra.1',
    soccer_mls: 'soccer/usa.1',
    soccer_uefa_cl: 'soccer/uefa.champions',
    soccer_uefa_el: 'soccer/uefa.europa',
    epl: 'soccer/eng.1',
    laliga: 'soccer/esp.1',
    bundesliga: 'soccer/ger.1',
    seriea: 'soccer/ita.1',
    ligue1: 'soccer/fra.1',
    mls: 'soccer/usa.1',
    ucl: 'soccer/uefa.champions',
    uel: 'soccer/uefa.europa',
};
const UNSUPPORTED_NOTE = {
    boxing: 'boxing odds are not available from the current source',
    golf_pga: 'golf odds are not available from the current source (matchup odds are not in the scoreboard feed)',
    f1: 'F1 odds are not available from the current source',
    tennis_atp: 'tennis odds are not available from the current source',
    tennis_wta: 'tennis odds are not available from the current source',
    esports_csgo: 'esports odds are not available from the current source',
    esports_lol: 'esports odds are not available from the current source',
    esports_dota2: 'esports odds are not available from the current source',
};

const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_LOOKAHEAD_H = 72;
const MAX_LOOKAHEAD_H = 14 * 24;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    sports = [],
    eventUrls = [],
    books = [],
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
} = input;

const sportList = (Array.isArray(sports) ? sports : String(sports || '').split(/[\n,;]+/))
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
const marketSet = new Set((Array.isArray(markets) && markets.length > 0 ? markets : ['h2h', 'spreads', 'totals']).map((m) => String(m).toLowerCase()));
const cap = Number(totalMaxEvents) > 0 ? Number(totalMaxEvents) : Infinity;
const perSportCap = Number(maxEventsPerSport) > 0 ? Number(maxEventsPerSport) : Infinity;
const lookAheadMs = Math.min(Math.max(Number(lookAheadHours) || 0, 0), MAX_LOOKAHEAD_H) * 3600 * 1000;
const fetchWindowMs = Math.max(lookAheadMs, DEFAULT_LOOKAHEAD_H * 3600 * 1000);

if (Array.isArray(books) && books.length > 0 && !(books.length === 2 && books.includes('draftkings') && books.includes('pinnacle'))) {
    log.info('The "books" input is no longer used: every run reads both available feeds (a bookmaker via ESPN, typically DraftKings, plus Bovada). All events are returned regardless of this setting.');
}

const seenStore = dedupe ? await Actor.openKeyValueStore('sports-odds-scraper-seen') : null;
const seenEventKeys = new Set(seenStore ? (await seenStore.getValue('seen-event-keys')) || [] : []);
let pushedRows = 0;

if (sportList.length === 0 && (!Array.isArray(eventUrls) || eventUrls.length === 0)) {
    log.warning('No input. Provide at least one sport in sports[], e.g. ["mlb", "nba", "soccer_epl"].');
    await Promise.allSettled(__chargeJobs);
    await Actor.exit();
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            return await res.json();
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 2000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// ---------- ESPN odds parsing ----------

const americanFromStr = (v) => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d+-]/g, ''), 10);
    return Number.isFinite(n) && n !== 0 ? n : null;
};

function americanToDecimal(american) {
    if (!Number.isFinite(american) || american === 0) return null;
    if (american > 0) return Number((american / 100 + 1).toFixed(4));
    return Number((100 / Math.abs(american) + 1).toFixed(4));
}

const closeOdds = (side) => side?.close ?? side?.current ?? side?.open ?? null;

function outcome(name, american, point, participant) {
    const decimal = americanToDecimal(american);
    return {
        name,
        price: convertOdds(decimal, oddsFormat),
        priceDecimal: decimal,
        point: point != null && Number.isFinite(Number(point)) ? Number(point) : null,
        participant: participant ?? null,
    };
}

function parseEspnOdds(odds, home, away) {
    const bookMarkets = [];

    if (marketSet.has('h2h')) {
        const ml = odds.moneyline || {};
        const outcomes = [
            outcome(home, americanFromStr(closeOdds(ml.home)?.odds) ?? americanFromStr(odds.homeTeamOdds?.moneyLine), null, 'home'),
            outcome(away, americanFromStr(closeOdds(ml.away)?.odds) ?? americanFromStr(odds.awayTeamOdds?.moneyLine), null, 'away'),
        ];
        const draw = americanFromStr(closeOdds(ml.draw)?.odds) ?? americanFromStr(odds.drawOdds?.moneyLine);
        if (draw != null) outcomes.push(outcome('Draw', draw, null, 'draw'));
        const priced = outcomes.filter((o) => o.priceDecimal != null);
        if (priced.length > 0) bookMarkets.push({ key: 'h2h', label: ml.displayName || 'Moneyline', outcomes: priced });
    }

    if (marketSet.has('spreads')) {
        const ps = odds.pointSpread || {};
        const homeClose = closeOdds(ps.home);
        const awayClose = closeOdds(ps.away);
        const outcomes = [
            outcome(home, americanFromStr(homeClose?.odds), homeClose?.line ?? (odds.spread != null ? odds.spread : null), 'home'),
            outcome(away, americanFromStr(awayClose?.odds), awayClose?.line ?? (odds.spread != null ? -odds.spread : null), 'away'),
        ].filter((o) => o.priceDecimal != null);
        if (outcomes.length > 0) bookMarkets.push({ key: 'spreads', label: ps.displayName || 'Spread', outcomes });
    }

    if (marketSet.has('totals')) {
        const t = odds.total || {};
        const overClose = closeOdds(t.over);
        const underClose = closeOdds(t.under);
        const outcomes = [
            outcome('Over', americanFromStr(overClose?.odds), overClose?.line ?? odds.overUnder, 'over'),
            outcome('Under', americanFromStr(underClose?.odds), underClose?.line ?? odds.overUnder, 'under'),
        ].filter((o) => o.priceDecimal != null);
        if (outcomes.length > 0) bookMarkets.push({ key: 'totals', label: t.displayName || 'Total', outcomes });
    }

    return bookMarkets;
}

// ---------- Bovada: the second bookmaker ----------
//
// ESPN carries ONE provider's prices, which left bestPrice and arbitrage inert
// for months. Bovada publishes its own book keylessly and is reachable from
// datacenter IPs, so it restores a real cross-book comparison.
//
// Events are matched on the SAME eventKey the ESPN path builds, which is
// sport + normalized home + normalized away + the start time to the minute.
// Both feeds publish identical team display names and identical start times,
// so this is an exact join, never a fuzzy one. That matters: a mismatched pair
// would invent an arbitrage edge that does not exist and someone would stake
// money on it. If either side differs the event simply stays single book.

// Only paths verified to return HTTP 200 from a datacenter IP. Bovada 404s on a
// guessed league path, and its soccer paths are not derivable from the ESPN
// league codes (they need a nav lookup), so soccer, UFC and anything else stays
// single book rather than risking a wrong or empty join.
const BOVADA_PATHS = {
    mlb: 'baseball/mlb',
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    nba: 'basketball/nba',
    ncaab: 'basketball/college-basketball',
    wnba: 'basketball/wnba',
    nhl: 'hockey/nhl',
};

// Bovada throttles bursts: seven rapid requests earned a 429 that outlasted a
// four second wait. Space the calls, and let getJson's own retry handle the
// rest. A throttled sport just stays single book.
const BOVADA_GAP_MS = 1500;

// Bovada names the same bet differently per sport, so match on shape not label.
const BOVADA_MARKET_KEY = (desc) => {
    const d = String(desc || '').toLowerCase();
    if (/moneyline|match winner|to win/.test(d)) return 'h2h';
    if (/runline|run line|point spread|spread|puck line|goal line/.test(d)) return 'spreads';
    if (/^total|total (runs|points|goals)/.test(d)) return 'totals';
    return null;
};

function bovadaOutcome(name, price, point) {
    // The decimal price is always present; the American figure is a STRING and
    // is the word "EVEN" at even money, which Number() turns into NaN. Read the
    // decimal and derive the rest from it.
    const decimal = Number(price?.decimal);
    if (!Number.isFinite(decimal) || decimal <= 1) return null;
    return {
        name,
        price: convertOdds(decimal, oddsFormat),
        priceDecimal: Number(decimal.toFixed(4)),
        point: point != null && Number.isFinite(Number(point)) ? Number(point) : null,
        participant: null,
    };
}

async function fetchBovadaSport(sport, path) {
    const url = `https://www.bovada.lv/services/sports/event/coupon/events/A/description/${path}?marketFilterId=def&lang=en`;
    const data = await getJson(url);
    if (data?.error) {
        log.info(`${sport}: no Bovada prices (${data.error}); event stays single book.`);
        return [];
    }

    const out = [];
    for (const group of Array.isArray(data) ? data : []) {
        for (const ev of group.events || []) {
            // "Away @ Home". Anything else is a futures or prop entry, not a game.
            const parts = String(ev.description || '').split(' @ ');
            if (parts.length !== 2) continue;
            const away = parts[0].trim();
            const home = parts[1].trim();
            if (!ev.startTime) continue;
            const commenceTime = new Date(Number(ev.startTime)).toISOString();

            const bookMarkets = [];
            for (const dg of ev.displayGroups || []) {
                for (const m of dg.markets || []) {
                    // period.main separates the game line from first half and
                    // alternate period lines, which sit in the same array.
                    if (m.period?.main !== true) continue;
                    // "S" is suspended and keeps its last price, so including it
                    // publishes a frozen quote as if it were live.
                    if (m.status && m.status !== 'O') continue;
                    const key = BOVADA_MARKET_KEY(m.description);
                    if (!key || !marketSet.has(key)) continue;

                    const outcomes = [];
                    let split = false;
                    for (const o of m.outcomes || []) {
                        if (o.status && o.status !== 'O') continue;
                        // A split handicap settles against two lines at once, so
                        // publishing only the first understates the real bet.
                        if (o.price?.handicap2 != null && String(o.price.handicap2) !== String(o.price.handicap)) {
                            split = true;
                            break;
                        }
                        const built = bovadaOutcome(o.description, o.price, key === 'h2h' ? null : o.price?.handicap);
                        if (built) outcomes.push(built);
                    }
                    if (split || outcomes.length === 0) continue;
                    bookMarkets.push({ key, label: m.description || key, outcomes });
                }
            }
            if (bookMarkets.length === 0) continue;

            out.push({
                sport,
                home,
                away,
                commenceTime,
                eventKey: makeEventKey(sport, home, away, commenceTime),
                sourceUrl: ev.link ? `https://www.bovada.lv${ev.link}` : null,
                book: 'bovada',
                bookMarkets,
            });
        }
    }
    return out;
}

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function fetchEspnSport(sport, path) {
    const from = new Date();
    const to = new Date(Date.now() + fetchWindowMs);
    const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=300`;
    const data = await getJson(url);
    if (data?.error) {
        log.warning(`${sport}: ${data.error}`);
        return [];
    }

    const out = [];
    for (const ev of data?.events || []) {
        const comp = (ev.competitions || [])[0] || {};
        const competitors = comp.competitors || [];
        const home = competitors.find((c) => c.homeAway === 'home')?.team?.displayName;
        const away = competitors.find((c) => c.homeAway === 'away')?.team?.displayName;
        const commenceTime = ev.date || comp.date || null;
        if (!home || !away || !commenceTime) continue;

        const odds = (comp.odds || [])[0];
        if (!odds) continue;
        const bookMarkets = parseEspnOdds(odds, home, away);
        if (bookMarkets.length === 0) continue;

        const book = String(odds.provider?.name || 'bookmaker').toLowerCase().replace(/[^a-z0-9]+/g, '');
        out.push({
            sport,
            home,
            away,
            commenceTime,
            eventKey: makeEventKey(sport, home, away, commenceTime),
            sourceUrl: (ev.links || [])[0]?.href || null,
            book,
            bookMarkets,
        });
    }
    return out;
}

// ---------- Sweep ----------

const eventBucket = new Map();

for (const sport of sportList) {
    if (pushedRows >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

    let path = SPORT_PATHS[sport];
    if (!path) {
        const m = sport.match(/^([a-z-]+)\/([a-z0-9.-]+)$/);
        if (m) path = sport;
    }
    if (!path) {
        const note = UNSUPPORTED_NOTE[sport] || `unknown sport "${sport}": use one of ${Object.keys(SPORT_PATHS).slice(0, 10).join(', ')}... or an ESPN sport/league path like soccer/bra.1`;
        await Actor.pushData({ sport, found: false, note: `${note}; not charged` });
        continue;
    }

    let perSportCount = 0;
    const events = await fetchEspnSport(sport, path).catch((err) => {
        log.warning(`${sport} failed: ${err?.message}`);
        return [];
    });
    for (const ev of events) {
        if (perSportCount >= perSportCap) break;
        mergeEvent(ev);
        perSportCount += 1;
    }

    // Second book. Only merges into events ESPN already returned, so a Bovada
    // outage or an unmatched name costs nothing beyond staying single book.
    let bovadaMatched = 0;
    const bovadaPath = BOVADA_PATHS[sport];
    if (bovadaPath && events.length > 0) {
        await sleep(BOVADA_GAP_MS);
        const bovadaEvents = await fetchBovadaSport(sport, bovadaPath).catch((err) => {
            log.info(`${sport}: Bovada unavailable (${err?.message}); events stay single book.`);
            return [];
        });
        for (const ev of bovadaEvents) {
            if (!eventBucket.has(ev.eventKey)) continue;
            mergeEvent(ev);
            bovadaMatched += 1;
        }
        log.info(`${sport}: Bovada returned ${bovadaEvents.length} event(s), ${bovadaMatched} matched an ESPN event.`);
    }

    log.info(`${sport}: ${events.length} event(s) with odds.`);
    await sleep(250);
}

if (Array.isArray(eventUrls) && eventUrls.length > 0) {
    const cleaned = eventUrls.map((u) => (typeof u === 'string' ? u : u?.url || '')).filter(Boolean);
    for (const url of cleaned) {
        await Actor.pushData({ url, found: false, note: 'direct event URLs are no longer supported (the sportsbook endpoints they pointed at block automated access); use sports[] instead; not charged' });
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
    log.info(`Pushed ${row.sport} ${row.away} @ ${row.home} (${row.commenceTime || '?'}) | markets=${row.markets.length} (${pushedRows})`);
}

if (seenStore && pushedRows > 0) {
    try {
        await seenStore.setValue('seen-event-keys', [...seenEventKeys].slice(-100000));
    } catch (err) {
        log.warning(`could not persist dedupe state: ${err?.message}`);
    }
}
log.info(`Run complete. Events pushed: ${pushedRows}.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Bucketing (unchanged row shape) ----------

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
            markets: [],
            sources: [],
            byBook: {},
        });
    }
    const bucket = eventBucket.get(key);
    if (!bucket.books.includes(ev.book)) bucket.books.push(ev.book);
    if (ev.sourceUrl && !bucket.sources.includes(ev.sourceUrl)) bucket.sources.push(ev.sourceUrl);
    bucket.byBook[ev.book] = (bucket.byBook[ev.book] || []).concat(ev.bookMarkets || []);
}

function finalizeEvent(bucket) {
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
        markets.push({ key: m.key, label: m.label, outcomes: [...m.outcomes.values()] });
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

// ---------- Best price + arbitrage. Live whenever two books priced the same
// outcome; events carried by only one feed fall through untouched. ----------

function attachEdges(row) {
    for (const m of row.markets) {
        for (const o of m.outcomes) {
            const decimals = Object.entries(o.prices)
                .map(([book, p]) => ({ book, decimal: p.decimal }))
                .filter((p) => Number.isFinite(p.decimal));
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

// ---------- Odds conversion (unchanged) ----------

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
