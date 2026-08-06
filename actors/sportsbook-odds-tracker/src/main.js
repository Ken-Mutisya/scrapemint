// Sportsbook Odds Tracker: Moneyline, Spread and Totals
//
// What it does
// ------------
// Live prices from a sportsbook's own feed, keyless, for every league it
// prices: American football, soccer, tennis, basketball, baseball, hockey,
// esports and more. Every row carries the book's price, the line it is
// attached to, the implied probability, and the book's margin on that market.
//
//   odds       one row per market per event: moneyline, spread, total, with
//              every outcome priced in American and decimal odds
//   movement   one row per market whose price or line MOVED since the last
//              run, with direction and size. The first run records a baseline
//   leagues    the league directory with live event counts, which is how you
//              find the paths the other two modes take
//
// The derived layer is the point. A book publishes a price; it does not
// publish what that price implies or what it is charging for it. Every market
// row ships implied probability per outcome, the overround (the book's hold),
// and the vig-free fair probability, which is the number worth comparing
// against your own estimate.
//
// Keyless, no account, no browser, no proxy.
//
// Pay per event
// -------------
//   odds_row ($0.004) charged per row pushed. First 2 rows per run are free.
//   Note rows are never charged.

import { Actor, log } from 'apify';
import { num, metric } from './numeric-helpers.js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 300;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HOST = 'https://www.bovada.lv/services/sports/event';
const SNAPSHOT_STORE = 'sportsbook-odds-snapshots';

const KNOWN_SPORTS = ['football', 'soccer', 'basketball', 'tennis', 'baseball', 'hockey', 'esports', 'boxing', 'mma', 'golf', 'cricket', 'rugby-union', 'rugby-league', 'volleyball', 'table-tennis', 'darts', 'snooker', 'cycling', 'handball', 'aussie-rules'];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs !== null && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'odds',
    leaguePaths = ['football/nfl'],
    sports = ['soccer'],
    marketTypes = [],
    includeSuspended = false,
    includeNonMainPeriods = false,
    liveOnly = false,
    minMovePoints = 0,
    maxRows = 50,
} = input;

const theMode = ['odds', 'movement', 'leagues'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'odds';

const rowCap = Math.min(Math.max(Number(maxRows) || 50, 1), HARD_CAP);
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wantedTypes = asList(marketTypes).map((s) => s.toLowerCase());

let pushed = 0;
let charged = 0;
let noteCount = 0;

/** A note row is diagnostic and is never billed. */
async function pushNote(message, extra = {}) {
    noteCount += 1;
    log.info(`NOTE: ${message}`);
    await Actor.pushData({ recordType: 'note', note: message, ...extra });
}

async function pushRow(row) {
    if (pushed >= rowCap) return false;
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'odds_row' });
            charged += 1;
        } catch (err) {
            log.warning(`charge failed: ${err?.message || err}`);
        }
    }
    return true;
}

async function fetchJson(url, attempts = 3) {
    for (let a = 1; a <= attempts; a++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, accept: 'application/json' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.status === 404) return { notFound: true };
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (!text.trim()) return { data: [] };
            return { data: JSON.parse(text) };
        } catch (err) {
            if (a === attempts) return { error: String(err?.message || err) };
            await sleep(900 * a);
        }
    }
    return { error: 'unreachable' };
}

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

// The book publishes an even-money price as the STRING "EVEN", not "+100".
// Number('EVEN') is NaN, so a bare cast drops or zeroes 157 of the 3090 prices
// in a single soccer pull. Decimal odds are always present, so they are the
// source of truth and the American figure is derived when the label is a word.
function parsePrice(price) {
    if (!price) return null;
    const decimal = num(price.decimal);
    const rawAmerican = String(price.american ?? '').trim();
    let american = null;
    if (/^even$/i.test(rawAmerican)) american = 100;
    else if (rawAmerican !== '') american = num(rawAmerican.replace('+', ''));
    if (american === null && decimal !== null && decimal > 1) {
        american = decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
    }
    const handicap = num(price.handicap);
    const handicapSecondary = num(price.handicap2);
    return {
        american,
        decimal,
        fractional: price.fractional || null,
        handicap,
        // A split line ("-0.5, -1.0") is one stake settled against two
        // handicaps. Publishing only the first understates the line the money
        // is actually on, and 1106 of 3090 soccer prices carry one.
        handicapSecondary,
        isSplitLine: handicapSecondary !== null && handicapSecondary !== handicap,
    };
}

// The same bet is named differently per sport: "Moneyline Game" in American
// football against "3-Way Moneyline" in soccer, "Point Spread Game" against
// "Goal Spread". A caller filtering on the raw label silently gets one sport,
// so every market also carries a stable type.
function classifyMarket(description, outcomeCount) {
    const d = String(description || '').toLowerCase();
    if (d.includes('spread') || d.includes('handicap') || d.includes('run line') || d.includes('puck line')) return 'spread';
    if (d.includes('total') || d.includes('over/under')) return 'total';
    if (d.includes('moneyline') || d.includes('winner') || d.includes('to win') || d.includes('match result')) {
        // Soccer prices the draw, so its moneyline has three outcomes.
        // Treating it as two-way loses a real result and breaks the hold.
        return outcomeCount >= 3 ? 'moneyline_3way' : 'moneyline';
    }
    return 'other';
}

/**
 * Implied probability, the book's hold, and the vig-free fair probability.
 *
 * Implied probabilities sum to more than one; the excess is the book's margin.
 * The sum runs over the outcomes actually priced, so a three-way soccer market
 * goes through the same code as a two-way moneyline. A market with a leg
 * missing or suspended reports no hold at all rather than a figure well below
 * what the book is really charging.
 */
function priceMarket(outcomes) {
    const priced = outcomes.filter((o) => o.priceDecimal !== null && o.priceDecimal > 1 && o.isOpen);
    const impliedSum = priced.reduce((acc, o) => acc + 1 / o.priceDecimal, 0);
    const complete = priced.length === outcomes.length && priced.length >= 2 && impliedSum > 0;
    for (const o of outcomes) {
        const usable = o.priceDecimal !== null && o.priceDecimal > 1;
        o.impliedProbabilityPercent = usable ? metric((1 / o.priceDecimal) * 100, 2) : null;
        o.fairProbabilityPercent = complete && usable ? metric(((1 / o.priceDecimal) / impliedSum) * 100, 2) : null;
        // Fair odds are the decimal price with the margin taken back out.
        o.fairDecimalOdds = complete && usable ? metric(o.priceDecimal * impliedSum, 3) : null;
    }
    return {
        holdPercent: complete ? metric((impliedSum - 1) * 100, 2) : null,
        holdMeasured: complete,
        outcomesPriced: priced.length,
        outcomesTotal: outcomes.length,
    };
}

// ---------------------------------------------------------------------------
// Coupon reading
// ---------------------------------------------------------------------------

const couponUrl = (path) => `${HOST}/coupon/events/A/description/${path}?marketFilterId=def&lang=en`;

/**
 * Flatten one coupon response into market records.
 *
 * The response is an array of GROUPS, one per league, and the league path
 * lives on the group, not on the event. That path is ordered leaf first:
 * [LEAGUE, COUNTRY, REGION, SPORT]. Reading path[0] as the sport files every
 * row under the wrong competition.
 */
function flattenCoupon(groups, requestedPath) {
    const rows = [];
    for (const group of Array.isArray(groups) ? groups : []) {
        const path = Array.isArray(group.path) ? group.path : [];
        const byType = {};
        for (const p of path) if (p?.type && byType[p.type] === undefined) byType[p.type] = p.description;
        const league = byType.LEAGUE || byType.TOURNAMENT || byType.COMPETITION || path[0]?.description || null;
        for (const event of group.events || []) {
            if (liveOnly && event.live !== true) continue;
            const competitors = (event.competitors || []).map((c) => ({
                name: c.name || null,
                shortName: c.shortName || null,
                isHome: c.home === true,
            }));
            const marketsInFeed = (event.displayGroups || []).reduce((a, g) => a + (g.markets || []).length, 0);
            for (const dg of event.displayGroups || []) {
                for (const market of dg.markets || []) {
                    const period = market.period || {};
                    // A first-half or alternate-period line is a different bet
                    // from the game line and must not sit unlabelled beside it.
                    if (!includeNonMainPeriods && period.main !== true) continue;
                    // Status "S" is suspended: the price is frozen and cannot
                    // be taken. Publishing it as a live quote is the easiest
                    // way for this feed to state a wrong fact.
                    const isOpen = String(market.status || '').toUpperCase() === 'O';
                    if (!includeSuspended && !isOpen) continue;

                    const outcomes = (market.outcomes || []).map((o) => {
                        const p = parsePrice(o.price);
                        return {
                            outcome: o.description || null,
                            outcomeType: o.type || null,
                            isOpen: String(o.status || '').toUpperCase() === 'O',
                            priceAmerican: p?.american ?? null,
                            priceDecimal: p?.decimal ?? null,
                            priceFractional: p?.fractional ?? null,
                            handicap: p?.handicap ?? null,
                            handicapSecondary: p?.handicapSecondary ?? null,
                            isSplitLine: p?.isSplitLine ?? false,
                        };
                    });
                    const marketType = classifyMarket(market.description, outcomes.length);
                    if (wantedTypes.length && !wantedTypes.includes(marketType)) continue;
                    const priced = priceMarket(outcomes);

                    rows.push({
                        recordType: 'market',
                        marketKey: `${event.id}:${market.id}`,
                        eventId: String(event.id ?? ''),
                        event: event.description || null,
                        sport: byType.SPORT || null,
                        region: byType.REGION || null,
                        country: byType.COUNTRY || null,
                        league,
                        leaguePath: String(path[0]?.link || `/${requestedPath}`).replace(/^\//, ''),
                        competitors,
                        startTime: event.startTime ? new Date(event.startTime).toISOString() : null,
                        isLive: event.live === true,
                        marketType,
                        marketName: market.description || null,
                        period: period.description || null,
                        isMainPeriod: period.main === true,
                        marketStatus: isOpen ? 'open' : 'suspended',
                        isOpen,
                        outcomes,
                        ...priced,
                        // The book prices far more than these lines. This feed
                        // returns the headline game lines, so the difference is
                        // stated rather than left looking like missing data.
                        marketsPricedByBook: num(event.numMarkets),
                        marketsInThisFeed: marketsInFeed,
                        includesPlayerProps: false,
                        pricesUpdatedAt: event.lastModified ? new Date(event.lastModified).toISOString() : null,
                        eventUrl: event.link ? `https://www.bovada.lv${event.link}` : null,
                        source: 'bovada.lv',
                        retrievedAt: new Date().toISOString(),
                    });
                }
            }
        }
    }
    return rows;
}

// How many events the book says it is pricing for a path, read from the
// directory rather than the coupon feed. Returns -1 when the directory itself
// cannot be read, so an unknown is never reported as a zero.
async function expectedEventCount(path) {
    const sport = String(path).split('/')[0];
    if (!sport) return -1;
    const res = await fetchJson(`${HOST}/v2/nav/A/description/${sport}?lang=en`, 2);
    if (res.error || res.notFound || !res.data) return -1;
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
    walk(res.data.current);
    for (const c of res.data.children || []) walk(c);
    return found;
}

async function collectMarkets(paths) {
    const all = [];
    const seen = new Set();
    for (const path of paths) {
        if (pastDeadline()) {
            await pushNote(`Stopped at the run deadline after reading ${all.length} markets. Ask for fewer league paths or raise the timeout.`);
            break;
        }
        const res = await fetchJson(couponUrl(path));
        if (res.error) {
            await pushNote(`Could not read "${path}": ${res.error}`, { leaguePath: path });
            continue;
        }
        if (res.notFound) {
            await pushNote(`No such league path: "${path}". Run the leagues mode to get valid paths.`, { leaguePath: path });
            continue;
        }
        const rows = flattenCoupon(res.data ?? [], path);
        if (!rows.length) {
            // An empty coupon answer has two very different causes and they
            // must not be reported with the same sentence. A league genuinely
            // out of season prices nothing; but the feed also hands an empty
            // 200 to an IP it is declining, which is what happened from the
            // Apify datacenter on 2026-08-06 while the same request from a
            // desktop returned 16 NFL events.
            //
            // The nav endpoint keeps answering when the coupon one is being
            // declined, so it settles which case this is. Saying "out of
            // season" about a league that is mid week would be a plain false
            // statement, so the check is worth the one extra request it costs
            // on an otherwise empty result.
            const expected = await expectedEventCount(path);
            if (expected > 0) {
                await pushNote(
                    `"${path}" returned no priced events, but the directory says it currently has ${expected}. `
                    + 'The feed is declining this request rather than being out of season, which it does to some '
                    + 'datacenter IPs. Retry later, or run from an IP the book serves. Nothing was charged.',
                    { leaguePath: path, expectedEventCount: expected, likelyBlocked: true },
                );
            } else {
                await pushNote(
                    `"${path}" has nothing priced right now, and the directory agrees it has no events. `
                    + 'A league out of season answers with an empty feed rather than an error.',
                    { leaguePath: path, expectedEventCount: expected, likelyBlocked: false },
                );
            }
        }
        for (const r of rows) {
            // One league is reachable by several paths, so a caller asking for
            // both a region and a league inside it would otherwise be billed
            // twice for the same market.
            if (seen.has(r.marketKey)) continue;
            seen.add(r.marketKey);
            all.push(r);
        }
        await sleep(SPACING_MS);
    }
    return all;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runOdds() {
    const paths = asList(leaguePaths);
    if (!paths.length) {
        await pushNote('No league paths given. Run the leagues mode first to find paths such as "football/nfl" or "soccer/europe".');
        return;
    }
    const markets = await collectMarkets(paths);
    markets.sort((a, b) => {
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
        return String(a.startTime || '').localeCompare(String(b.startTime || ''));
    });
    let returned = 0;
    for (const m of markets) {
        if (!(await pushRow(m))) break;
        returned += 1;
    }
    if (markets.length > returned) {
        await pushNote(`${markets.length} markets matched and ${returned} were returned. Raise the maximum rows for the rest.`);
    }
}

async function runMovement() {
    const paths = asList(leaguePaths);
    if (!paths.length) {
        await pushNote('No league paths given. Run the leagues mode first to find paths.');
        return;
    }
    const markets = await collectMarkets(paths);
    let store;
    try {
        store = await Actor.openKeyValueStore(SNAPSHOT_STORE);
    } catch (err) {
        log.warning(`Named store unavailable (${err?.message || err}); using this run's own store, so the next run starts from a fresh baseline.`);
        store = await Actor.openKeyValueStore();
    }
    const key = `snapshot-${paths.join('_').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)}`;
    const previous = (await store.getValue(key)) || null;

    const current = {};
    for (const m of markets) {
        current[m.marketKey] = {
            o: m.outcomes.map((o) => ({ d: o.outcome, a: o.priceAmerican, dec: o.priceDecimal, h: o.handicap })),
        };
    }
    await store.setValue(key, { savedAt: new Date().toISOString(), markets: current });

    if (!previous || !previous.markets) {
        await pushNote(`Baseline recorded for ${markets.length} markets across ${paths.length} league path(s). Run this again later and it returns only what moved. A baseline run charges nothing.`);
        return;
    }

    const threshold = Math.max(Number(minMovePoints) || 0, 0);
    const moves = [];
    for (const m of markets) {
        const before = previous.markets[m.marketKey];
        if (!before) continue;
        const changes = [];
        for (const o of m.outcomes) {
            const prior = (before.o || []).find((p) => p.d === o.outcome);
            if (!prior) continue;
            const priorDecimal = num(prior.dec);
            const priorHandicap = num(prior.h);
            const priceMoved = priorDecimal !== null && o.priceDecimal !== null && priorDecimal !== o.priceDecimal;
            const lineMoved = priorHandicap !== null && o.handicap !== null && priorHandicap !== o.handicap;
            if (!priceMoved && !lineMoved) continue;
            // Movement is measured in implied probability, not in American
            // odds. -110 to -120 and +200 to +190 are both ten cents and
            // nothing like the same change in what the book believes.
            const beforeProb = priorDecimal !== null && priorDecimal > 1 ? (1 / priorDecimal) * 100 : null;
            const afterProb = o.priceDecimal !== null && o.priceDecimal > 1 ? (1 / o.priceDecimal) * 100 : null;
            const probChange = beforeProb === null || afterProb === null ? null : afterProb - beforeProb;
            changes.push({
                outcome: o.outcome,
                priceAmericanBefore: num(prior.a),
                priceAmericanAfter: o.priceAmerican,
                priceDecimalBefore: priorDecimal,
                priceDecimalAfter: o.priceDecimal,
                handicapBefore: priorHandicap,
                handicapAfter: o.handicap,
                lineMoved,
                impliedProbabilityChangePoints: metric(probChange, 2),
                probabilityChangeMeasured: probChange !== null,
                direction: probChange === null ? null : probChange > 0 ? 'shortened' : 'drifted',
            });
        }
        if (!changes.length) continue;
        const measurable = changes.filter((c) => c.impliedProbabilityChangePoints !== null);
        const biggest = measurable.length
            ? measurable.reduce((a, b) => (Math.abs(b.impliedProbabilityChangePoints) > Math.abs(a.impliedProbabilityChangePoints) ? b : a))
            : null;
        // A line that moved with no measurable price change still counts as a
        // move, so it is only filtered out when a threshold was asked for.
        if (threshold > 0 && (biggest === null || Math.abs(biggest.impliedProbabilityChangePoints) < threshold)) continue;
        moves.push({
            ...m,
            recordType: 'movement',
            comparedAgainst: previous.savedAt,
            minutesSinceBaseline: metric((Date.parse(m.retrievedAt) - Date.parse(previous.savedAt)) / 60000, 1),
            movedOutcomes: changes,
            biggestMoveOutcome: biggest ? biggest.outcome : null,
            biggestMovePoints: biggest ? biggest.impliedProbabilityChangePoints : null,
            biggestMoveDirection: biggest ? biggest.direction : null,
        });
    }
    moves.sort((a, b) => Math.abs(b.biggestMovePoints ?? 0) - Math.abs(a.biggestMovePoints ?? 0));

    if (!moves.length) {
        await pushNote(`Nothing moved by ${threshold} point(s) or more since ${previous.savedAt}. ${markets.length} markets were checked.`);
        return;
    }
    for (const m of moves) {
        if (!(await pushRow(m))) break;
    }
}

async function runLeagues() {
    const wanted = asList(sports).length ? asList(sports) : ['soccer'];
    const rows = [];
    for (const s of wanted) {
        if (pastDeadline()) break;
        const slug = String(s).toLowerCase();
        if (!KNOWN_SPORTS.includes(slug)) {
            await pushNote(`"${s}" is not a sport this book lists. Try one of: ${KNOWN_SPORTS.slice(0, 10).join(', ')}.`);
            continue;
        }
        const res = await fetchJson(`${HOST}/v2/nav/A/description/${slug}?lang=en`);
        if (res.error || res.notFound || !res.data) {
            await pushNote(`Could not read the ${s} directory${res.error ? `: ${res.error}` : ''}.`);
            continue;
        }
        const cur = res.data.current || {};
        for (const child of res.data.children || []) {
            rows.push({
                recordType: 'league',
                sport: cur.description || s,
                sportEventCount: num(cur.numEvents),
                name: child.description || null,
                // The directory mixes regions, countries, leagues and one-off
                // tournaments in one list, and only a leaf prices events
                // directly under it.
                level: child.type || null,
                isLeaf: child.leaf === true,
                // This is the value the other two modes take.
                leaguePath: String(child.link || '').replace(/^\//, ''),
                eventCount: num(child.numEvents),
                source: 'bovada.lv',
                retrievedAt: new Date().toISOString(),
            });
        }
        await sleep(SPACING_MS);
    }
    rows.sort((a, b) => (b.eventCount ?? 0) - (a.eventCount ?? 0));
    for (const r of rows) {
        if (!(await pushRow(r))) break;
    }
    if (!rows.length) await pushNote('No leagues came back for the sports requested.');
}

// ---------------------------------------------------------------------------

process.on('unhandledRejection', (err) => log.exception(err instanceof Error ? err : new Error(String(err)), 'Unhandled rejection'));
process.on('uncaughtException', (err) => log.exception(err, 'Uncaught exception'));

try {
    log.info(`Mode: ${theMode}, row cap ${rowCap}`);
    if (theMode === 'odds') await runOdds();
    else if (theMode === 'movement') await runMovement();
    else await runLeagues();
} catch (err) {
    // An unexpected failure becomes a free diagnostic row and a clean exit,
    // instead of a non-zero exit that shows a buyer's schedule as failed.
    log.exception(err, 'Run failed');
    await pushNote(`The run stopped early: ${String(err?.message || err)}`);
}

log.info(`Pushed ${pushed} rows (${charged} charged, ${noteCount} free notes).`);
await Actor.exit();
