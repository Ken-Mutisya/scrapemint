// Sports Odds Movement Tracker
//
// Rebuilt 2026-08-06. Two things were wrong with the previous build.
//
// 1. It required the buyer to sign up at the-odds-api.com and paste an API key.
//    With no key it logged an error, fell through, and exited SUCCEEDED with
//    zero rows, so a run that did nothing looked like a healthy one. That is
//    also why its 30 day success rate read 100% across ~105 runs.
// 2. It did not track movement. It emitted a cross book snapshot with best
//    price and arbitrage, while the pay per event entry, which is IMMUTABLE
//    once created, charges $0.008 for "one material line move ... with prior
//    line, new line, delta, and timestamp". Buyers were billed for a product
//    the actor never produced.
//
// So this now does what it is named and what it bills for: it reads Bovada's
// own keyless feed (no key, no account, datacenter safe), remembers every
// price in a NAMED key value store, and on each run emits one row per line
// that actually MOVED since the previous run.
//
// Movement is measured in IMPLIED PROBABILITY POINTS, never in American cents.
// -110 to -120 and +200 to +190 are both "ten cents" and are nothing like the
// same change in belief. The American figures are still reported, because that
// is what a bettor reads, but the threshold and the delta are probability.
//
// The store must be NAMED. An unnamed default store is created fresh for each
// run, so every price would look new every time and the actor would report
// movement that never happened.
//
// Pay per event
// -------------
//   odds_movement per moved line. First 1 per run is free.

import { Actor, log } from 'apify';
import { fetchPinnacleLeague } from './pinnacle-book.js';

const FREE_TIER_ITEMS = 1;
const HOST = 'https://www.bovada.lv/services/sports/event';
const REQUEST_GAP_MS = 1500; // Bovada 429s on bursts; a throttled league is skipped, not fatal.
const FETCH_TIMEOUT_MS = 30000;
const SNAPSHOT_TTL_MS = 14 * 24 * 3600 * 1000;

// Verified 200 from a datacenter IP. Bovada 404s on guessed league paths, so
// only paths confirmed to answer are listed; anything else is rejected with a
// free explanatory row rather than silently returning nothing.
const LEAGUE_PATHS = {
    mlb: 'baseball/mlb',
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    nba: 'basketball/nba',
    ncaab: 'basketball/college-basketball',
    wnba: 'basketball/wnba',
    nhl: 'hockey/nhl',
};

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    leagues = [],
    sports = [],
    markets = ['h2h', 'spreads', 'totals'],
    minMoveProbPoints = 1,
    includeNewLines = false,
    includeSuspended = false,
    liveOnly = false,
    oddsFormat = 'american',
    maxItemsPerLeague = 200,
    maxItemsTotal = 400,
    books = ['bovada', 'pinnacle'],
    proxyConfiguration: proxyInput,
    apiKey,
} = input;

const wantedBooks = new Set(toArray(books).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
if (!wantedBooks.size) { wantedBooks.add('bovada'); wantedBooks.add('pinnacle'); }

if (apiKey) {
    log.info('The "apiKey" input is no longer used. This actor reads a public sportsbook feed directly, with no key and no third party account.');
}
if (proxyInput && proxyInput.useApifyProxy) {
    log.info('No proxy is needed for this source and none is used; it answers datacenter IPs directly.');
}

// `sports` is the old input name. Accept it so saved runs keep working.
const requested = [...new Set([...toArray(leagues), ...toArray(sports)]
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
const leagueList = requested.length > 0 ? requested : ['mlb'];
const marketSet = new Set(toArray(markets).map((m) => String(m).toLowerCase()).filter(Boolean));
if (marketSet.size === 0) ['h2h', 'spreads', 'totals'].forEach((m) => marketSet.add(m));

const minPoints = Math.max(0, Number(minMoveProbPoints) || 0);
const perLeagueCap = Number(maxItemsPerLeague) > 0 ? Number(maxItemsPerLeague) : Infinity;
const totalCap = Number(maxItemsTotal) > 0 ? Number(maxItemsTotal) : Infinity;

// NAMED store: cross run history is the entire product. See header.
const store = await Actor.openKeyValueStore('sports-odds-movement-history');
const history = (await store.getValue('LINE_HISTORY')) || {};

let totalPushed = 0;
let linesSeen = 0;
let movedCount = 0;
let newLineCount = 0;
const nowIso = new Date().toISOString();
const nowMs = Date.now();

for (const league of leagueList) {
    if (totalPushed >= totalCap || pastDeadline()) break;
    const path = LEAGUE_PATHS[league];
    if (!path) {
        await Actor.pushData({
            league,
            found: false,
            note: `unsupported league "${league}"; use one of ${Object.keys(LEAGUE_PATHS).join(', ')}. Not charged.`,
        });
        continue;
    }

    const bovadaEvents = wantedBooks.has('bovada') ? await fetchLeague(league, path) : [];
    const pinnacleEvents = wantedBooks.has('pinnacle') ? await fetchPinnacleLines(league, path) : [];
    // Sorted by kickoff rather than concatenated by book. Straight
    // concatenation meant a row cap was spent entirely on Bovada before
    // Pinnacle was reached, so a buyer with a modest cap never saw the second
    // book at all. Sorting also puts the same fixture from both books next to
    // each other, which is the comparison worth reading.
    const events = [...bovadaEvents, ...pinnacleEvents]
        .sort((a, b) => String(a.kickoff || '').localeCompare(String(b.kickoff || '')));
    log.info(`${league}: ${events.length} event(s) returned (${bovadaEvents.length} Bovada, ${pinnacleEvents.length} Pinnacle).`);

    // An empty feed means either the league is out of season or the book is
    // declining this IP, and those must not look the same. Observed
    // 2026-08-06: the coupon feed handed empty 200s to the Apify datacenter
    // while the identical request from a desktop returned 16 NFL events. The
    // directory endpoint keeps answering when the coupon one does not, so it
    // settles which case this is. Without this, a blocked run is reported as
    // "no line moved", which is a quiet false statement.
    // A Bovada decline no longer empties the league, because Pinnacle answers
    // separately. It is still worth saying out loud that one book is missing,
    // so a thinner than usual result is not read as a quiet market.
    if (wantedBooks.has('bovada') && bovadaEvents.length === 0 && pinnacleEvents.length > 0) {
        log.warning(`${league}: Bovada returned nothing; continuing on Pinnacle alone.`);
    }

    if (events.length === 0) {
        const expected = wantedBooks.has('bovada') ? await expectedEventCount(path) : 0;
        if (expected > 0) {
            log.warning(`${league}: the directory says ${expected} event(s) are priced, but the feed returned none. It is declining this request rather than being out of season.`);
            await Actor.pushData({
                league,
                found: false,
                likelyBlocked: true,
                expectedEventCount: expected,
                note: `neither book returned events. Bovada's directory reports ${expected} priced, so it is declining this request rather than being out of season, and Pinnacle returned nothing either. Retry later. Nothing charged.`,
            });
        }
        continue;
    }
    let perLeague = 0;

    for (const ev of events) {
        if (perLeague >= perLeagueCap || totalPushed >= totalCap || pastDeadline()) break;
        for (const line of ev.lines) {
            if (perLeague >= perLeagueCap || totalPushed >= totalCap) break;
            linesSeen += 1;

            const key = line.lineKey;
            const prior = history[key];
            history[key] = { d: line.decimal, a: line.american, p: line.point, t: nowMs };

            if (!prior) {
                newLineCount += 1;
                if (!includeNewLines) continue;
            }

            const priorImplied = prior ? 1 / prior.d : null;
            const nowImplied = 1 / line.decimal;
            const deltaPoints = prior ? Number(((nowImplied - priorImplied) * 100).toFixed(3)) : null;

            if (prior) {
                // A line that did not move is never a row, whatever the
                // threshold is set to. `< minPoints` alone lets a delta of
                // exactly 0 through when minPoints is 0, which would bill the
                // buyer for unchanged prices: the pay per event entry charges
                // for "one material line move".
                const handicapMoved = prior.p !== line.point;
                const priceMoved = Math.abs(deltaPoints) >= Math.max(minPoints, 1e-9);
                // A spread going -2.5 to -1.5 at identical juice is a real move
                // even though the price delta is zero, so it qualifies on its own.
                if (!priceMoved && !handicapMoved) continue;
                movedCount += 1;
            }

            const row = {
                sport: ev.sport,
                league,
                home: ev.home,
                away: ev.away,
                kickoff: ev.kickoff,
                live: ev.live,
                market: line.market,
                marketLabel: line.marketLabel,
                outcome: line.outcome,
                book: line.book,
                // Pinnacle publishes the most a client may risk; Bovada does
                // not, so this stays null there rather than reading as zero.
                maxRiskStake: line.maxRiskStake ?? null,
                isNewLine: !prior,
                priorLine: prior ? formatLine(prior.a, prior.d, prior.p) : null,
                newLine: formatLine(line.american, line.decimal, line.point),
                delta: prior ? {
                    impliedProbabilityPoints: deltaPoints,
                    direction: deltaPoints > 0 ? 'shortening' : (deltaPoints < 0 ? 'drifting' : 'handicap only'),
                    priorImpliedProbability: Number(priorImplied.toFixed(4)),
                    newImpliedProbability: Number(nowImplied.toFixed(4)),
                    handicapMoved: prior.p !== line.point,
                    priorObservedAt: new Date(prior.t).toISOString(),
                    minutesSincePrior: Number(((nowMs - prior.t) / 60000).toFixed(1)),
                } : null,
                eventUrl: ev.url,
                timestamp: nowIso,
            };

            await Actor.pushData(row);
            totalPushed += 1;
            perLeague += 1;
            if (totalPushed > FREE_TIER_ITEMS) {
                __chargeJobs.push(Actor.charge({ eventName: 'odds_movement' })
                    .catch((err) => log.warning(`charge failed (continuing): ${err?.message}`)));
            }
        }
    }
}

// Drop prices for games that finished, so the store does not grow without end.
let pruned = 0;
for (const [k, v] of Object.entries(history)) {
    if (!v?.t || nowMs - v.t > SNAPSHOT_TTL_MS) { delete history[k]; pruned += 1; }
}
await store.setValue('LINE_HISTORY', history);

if (totalPushed === 0 && linesSeen > 0) {
    log.info(`No line moved by at least ${minPoints} implied probability point(s) since the last run. `
        + `${linesSeen} line(s) checked, ${newLineCount} seen for the first time. `
        + 'This is a normal result on a quiet market or a first run; nothing was charged.');
}
log.info(`Run complete. Pushed ${totalPushed}. linesSeen=${linesSeen} moved=${movedCount} new=${newLineCount} pruned=${pruned} tracked=${Object.keys(history).length}`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Bovada ----------

// How many events the book says it prices for a path, read from the directory
// rather than the coupon feed. Returns -1 when the directory cannot be read,
// so an unknown is never reported as a zero.
async function expectedEventCount(path) {
    const sport = String(path).split('/')[0];
    if (!sport) return -1;
    const res = await getJson(`${HOST}/v2/nav/A/description/${sport}?lang=en`);
    if (res?.error || !res) return -1;
    const want = String(path).toLowerCase();
    let found = -1;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        const link = String(node.link || '').toLowerCase().replace(/^\//, '');
        if (link && (link === want || link.endsWith(`/${want}`))) {
            const n = Number(node.numEvents);
            if (Number.isFinite(n)) found = Math.max(found, n);
        }
        for (const child of node.children || []) walk(child);
    };
    walk(res.current);
    for (const c of res.children || []) walk(c);
    return found;
}

/**
 * The same event and line shape as fetchLeague, read from Pinnacle.
 *
 * TWO COLLISIONS TO AVOID, both of which would invent movement that never
 * happened and bill for it:
 *
 * 1. The line key MUST carry the book. Bovada and Pinnacle price the same
 *    game, market and outcome, so a shared key would make the store flip
 *    between two books' prices every run and report each flip as a move. The
 *    Pinnacle key is prefixed rather than the Bovada one changed, so every
 *    Bovada line already in the store keeps its history instead of coming back
 *    as a burst of new lines.
 * 2. Team totals are dropped. Bovada's market matcher anchors on "^total" and
 *    therefore already excludes them, and a team total Over would otherwise
 *    share a key with the game total Over on the same event.
 */
async function fetchPinnacleLines(league, path) {
    const res = await fetchPinnacleLeague(path, {
        fetchJson: async (u) => {
            const d = await getJson(u);
            return d?.error ? null : d;
        },
        liveOnly,
    });
    if (res.unmapped) {
        log.info(`${league}: Pinnacle does not carry this league; Bovada only.`);
        return [];
    }
    if (res.error) {
        log.warning(`${league}: Pinnacle unavailable (${res.error}); Bovada prices are unaffected.`);
        return [];
    }

    const out = [];
    for (const g of res.games) {
        const home = g.competitors.find((c) => c.isHome)?.name;
        const away = g.competitors.find((c) => !c.isHome)?.name;
        if (!home || !away || !g.startTime) continue;
        const lines = [];
        for (const m of g.markets) {
            if (!m.isMainPeriod) continue;
            if (!includeSuspended && !m.isOpen) continue;
            if (String(m.marketName).startsWith('Team Total')) continue; // see note 2 above
            const market = m.marketType === 'spread' ? 'spreads'
                : m.marketType === 'total' ? 'totals'
                    : (m.marketType === 'moneyline' || m.marketType === 'moneyline_3way') ? 'h2h' : null;
            if (!market || !marketSet.has(market)) continue;
            for (const o of m.outcomes) {
                const decimal = Number(o.priceDecimal);
                if (!Number.isFinite(decimal) || decimal <= 1) continue;
                const point = market === 'h2h' ? null : numOrNull(o.handicap);
                lines.push({
                    market,
                    marketLabel: m.marketName || market,
                    outcome: o.outcome,
                    decimal: Number(decimal.toFixed(4)),
                    american: o.priceAmerican,
                    point,
                    book: 'pinnacle',
                    maxRiskStake: m.maxRiskStake,
                    lineKey: `pinnacle|${league}|${home}|${away}|${g.startTime}|${market}|${o.outcome}`
                        .toLowerCase().replace(/[^a-z0-9|.@:+-]/g, ''),
                });
            }
        }
        if (!lines.length) continue;
        out.push({
            sport: String(path).split('/')[0],
            home,
            away,
            kickoff: g.startTime,
            live: g.isLive,
            url: 'https://www.pinnacle.com',
            lines,
        });
    }
    return out;
}

async function fetchLeague(league, path) {
    await sleep(REQUEST_GAP_MS);
    const url = `${HOST}/coupon/events/A/description/${path}`
        + `?marketFilterId=def&lang=en&preMatchOnly=${liveOnly ? 'false' : 'true'}${liveOnly ? '&liveOnly=true' : ''}`;
    const data = await getJson(url);
    if (data?.error) {
        log.warning(`${league}: ${data.error}; skipped this run.`);
        return [];
    }

    const out = [];
    for (const group of Array.isArray(data) ? data : []) {
        for (const ev of group.events || []) {
            // "Away @ Home". Futures and prop entries do not carry that shape.
            const parts = String(ev.description || '').split(' @ ');
            if (parts.length !== 2) continue;
            const away = parts[0].trim();
            const home = parts[1].trim();
            if (!ev.startTime) continue;
            const kickoff = new Date(Number(ev.startTime)).toISOString();

            const lines = [];
            for (const dg of ev.displayGroups || []) {
                for (const m of dg.markets || []) {
                    // period.main separates the game line from first half and
                    // alternate period lines sitting in the same array.
                    if (m.period?.main !== true) continue;
                    if (!includeSuspended && m.status && m.status !== 'O') continue;
                    const market = marketKeyOf(m.description);
                    if (!market || !marketSet.has(market)) continue;

                    for (const o of m.outcomes || []) {
                        if (!includeSuspended && o.status && o.status !== 'O') continue;
                        // A split handicap settles against two lines at once, so
                        // tracking only the first misreports the bet that moved.
                        if (o.price?.handicap2 != null
                            && String(o.price.handicap2) !== String(o.price.handicap)) continue;
                        // The decimal price is always present. The American one
                        // is a STRING and is the word "EVEN" at even money, so
                        // Number() on it yields NaN.
                        const decimal = Number(o.price?.decimal);
                        if (!Number.isFinite(decimal) || decimal <= 1) continue;
                        const point = market === 'h2h' ? null : numOrNull(o.price?.handicap);
                        lines.push({
                            market,
                            marketLabel: m.description || market,
                            outcome: o.description,
                            decimal: Number(decimal.toFixed(4)),
                            american: americanFrom(decimal),
                            point,
                            book: 'bovada',
                            maxRiskStake: null, // Bovada does not publish one; null, not 0.
                            // Deliberately NOT prefixed with the book: every
                            // Bovada line already in the store keeps its
                            // history. Pinnacle keys carry a prefix instead.
                            lineKey: `${league}|${home}|${away}|${kickoff}|${market}|${o.description}`
                                .toLowerCase().replace(/[^a-z0-9|.@:+-]/g, ''),
                        });
                    }
                }
            }
            if (lines.length === 0) continue;
            out.push({
                sport: String(path).split('/')[0],
                home,
                away,
                kickoff,
                live: ev.live === true,
                url: ev.link ? `https://www.bovada.lv${ev.link}` : null,
                lines,
            });
        }
    }
    return out;
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return { error: `HTTP ${res.status}` };
            return await res.json();
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 2500);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

// Bovada names the same bet differently per sport, so match on shape not label.
function marketKeyOf(desc) {
    const d = String(desc || '').toLowerCase();
    if (/moneyline|match winner|to win/.test(d)) return 'h2h';
    if (/runline|run line|point spread|spread|puck line|goal line/.test(d)) return 'spreads';
    if (/^total|total (runs|points|goals)/.test(d)) return 'totals';
    return null;
}

function americanFrom(decimal) {
    if (!Number.isFinite(decimal) || decimal <= 1) return null;
    return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

function formatLine(american, decimal, point) {
    const priced = String(oddsFormat).toLowerCase() === 'decimal' ? decimal : american;
    return { price: priced, american, decimal, point: point ?? null };
}

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === '') return [];
    return String(v).split(/[\n,;]+/);
}
