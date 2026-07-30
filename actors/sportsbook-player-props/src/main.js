// Player Prop Bets: Odds by Player, Stat and Line
//
// What it does
// ------------
// The per player betting markets a sportsbook prices on a game: strikeouts,
// hits, goals, assists, points. Keyless. One row per player per market, with
// the line, both prices and what they imply.
//
//   props     one row per player per prop market. Filter by player name,
//             by stat, or by how far out the game is
//   players   one row per player on a game, listing every stat priced on
//             them, which is how you see who the book has markets for
//   markets   the non player depth on the same games: game props, alternate
//             lines, correct score, corners, innings
//
// This is the layer sportsbook-odds-tracker deliberately leaves out. That
// actor returns the three headline lines per event; this one opens the event
// and reads everything else the book prices.
//
// Keyless, no account, no browser, no proxy.
//
// Pay per event
// -------------
//   prop_row ($0.005) charged per row pushed. First 2 rows per run are free.
//   Note rows are never charged.

import { Actor, log } from 'apify';
import { num, metric } from './numeric-helpers.js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 350;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const HOST = 'https://www.bovada.lv/services/sports/event';

// Market groups the book files player markets under. Anything else is treated
// as a game market, and the shape checks below decide either way, so this list
// only steers the default mode split.
const PLAYER_GROUP_HINTS = ['player', 'batter', 'pitcher', 'goalscorer', 'assist', 'passing', 'rushing', 'receiving', 'touchdown', 'shots', 'cards'];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs !== null && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'props',
    leaguePaths = ['baseball/mlb'],
    players = [],
    statContains = [],
    maxEvents = 5,
    includeSuspended = false,
    maxRows = 50,
} = input;

const theMode = ['props', 'players', 'markets'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'props';

const rowCap = Math.min(Math.max(Number(maxRows) || 50, 1), HARD_CAP);
const eventCap = Math.min(Math.max(Number(maxEvents) || 5, 1), 40);
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wantedPlayers = asList(players).map((s) => s.toLowerCase());
const wantedStats = asList(statContains).map((s) => s.toLowerCase());

let pushed = 0;
let charged = 0;
let noteCount = 0;

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
            await Actor.charge({ eventName: 'prop_row' });
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
// Parsing
// ---------------------------------------------------------------------------

// An even money price is the string "EVEN", and Number('EVEN') is NaN, so
// prices are read from the decimal odds, which are always present.
function parsePrice(price) {
    if (!price) return { american: null, decimal: null, handicap: null };
    const decimal = num(price.decimal);
    const raw = String(price.american ?? '').trim();
    let american = null;
    if (/^even$/i.test(raw)) american = 100;
    else if (raw !== '') american = num(raw.replace('+', ''));
    if (american === null && decimal !== null && decimal > 1) {
        american = decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
    }
    return {
        american,
        decimal,
        handicap: num(price.handicap),
        handicapSecondary: num(price.handicap2),
    };
}

// A player is written as "Name (TEAM)". The same pattern appears in two
// different places depending on how the book built the market, which is the
// structural fact this actor exists to normalise:
//
//   shape A, one market per player:  "Total Hits Allowed - Shane McClanahan (TB)"
//                                    outcomes are Over/Under, or a ladder of
//                                    thresholds such as "6+ Strikeouts"
//   shape B, one market per stat:    "Anytime Goal Scorer" with 38 outcomes,
//                                    each of them a player
//
// A parser written for one returns nothing at all on the other.
const PLAYER_IN_TEXT = /^(.*?)\s*\(([A-Z][A-Z0-9]{1,4})\)\s*$/;

function splitPlayerFromMarketName(description) {
    const text = String(description || '');
    const dash = text.lastIndexOf(' - ');
    if (dash === -1) return null;
    const stat = text.slice(0, dash).trim();
    const m = PLAYER_IN_TEXT.exec(text.slice(dash + 3).trim());
    if (!m) return null;
    return { stat, player: m[1].trim(), team: m[2] };
}

function playerFromOutcome(description) {
    const m = PLAYER_IN_TEXT.exec(String(description || '').trim());
    if (!m) return null;
    const player = m[1].trim();
    // "No Goalscorer", "Over", "Yes" and similar sit in the same outcome list
    // as the players and must never be published as one.
    if (!player || /^(no |over$|under$|yes$|none)/i.test(player)) return null;
    return { player, team: m[2] };
}

// A ladder outcome is a threshold ("6+ Strikeouts"), not a two sided line.
function parseThreshold(label) {
    const m = /^(\d+(?:\.\d+)?)\s*\+/.exec(String(label || '').trim());
    return m ? Number(m[1]) : null;
}

const impliedPct = (decimal) => (decimal !== null && decimal > 1 ? metric((1 / decimal) * 100, 2) : null);

/**
 * Does the book's team tag name one of the two teams playing?
 *
 * The tag is an abbreviation ("KC") and the event carries full names
 * ("Kansas City Royals"), so a substring test only ever succeeds when the
 * abbreviation happens to start the name: "MIN" matches Minnesota and "KC"
 * never matches Kansas City. Candidate abbreviations are built from the name
 * instead. This matters because the tag genuinely can name a team that is not
 * playing, and that is only worth reporting if the check itself is right.
 */
function teamTagMatches(tag, teamNames) {
    const t = String(tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!t || !teamNames.length) return null;
    for (const name of teamNames) {
        const words = String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
        if (!words.length) continue;
        const initials = words.map((w) => w[0]).join('');
        const candidates = new Set([
            initials,
            initials.slice(0, 2),
            initials.slice(0, 3),
            words[0].slice(0, 3),
            words[words.length - 1].slice(0, 3),
            words.length > 1 ? words[0][0] + words[1][0] : '',
            words.join(''),
        ].filter(Boolean));
        if (candidates.has(t)) return true;
        // "TB" against ["TAMPA","BAY","RAYS"] is the initials of the first two
        // words, and "NYM" is three initials; both are covered above. This last
        // check catches a tag that is a prefix of any single word, such as
        // "SEA" for Seattle.
        if (words.some((w) => w.length >= 3 && w.startsWith(t) && t.length >= 3)) return true;
    }
    return false;
}

function isPlayerGroup(groupName) {
    const g = String(groupName || '').toLowerCase();
    return PLAYER_GROUP_HINTS.some((h) => g.includes(h));
}

// ---------------------------------------------------------------------------
// Event reading
// ---------------------------------------------------------------------------

// marketFilterId=def returns only the three headline lines, which is what
// sportsbook-odds-tracker reads. Dropping the filter returns the full depth.
const listUrl = (path) => `${HOST}/coupon/events/A/description/${path}?marketFilterId=def&lang=en`;
const eventUrl = (link) => `${HOST}/coupon/events/A/description${link}?lang=en`;

async function listEvents(paths) {
    const events = [];
    const seen = new Set();
    for (const path of paths) {
        if (pastDeadline()) break;
        const res = await fetchJson(listUrl(path));
        if (res.error || res.notFound) {
            await pushNote(`Could not list events for "${path}"${res.error ? `: ${res.error}` : '. Check the league path.'}`, { leaguePath: path });
            continue;
        }
        for (const group of Array.isArray(res.data) ? res.data : []) {
            const gp = Array.isArray(group.path) ? group.path : [];
            const byType = {};
            for (const p of gp) if (p?.type && byType[p.type] === undefined) byType[p.type] = p.description;
            for (const e of group.events || []) {
                if (!e.link || seen.has(e.link)) continue;
                seen.add(e.link);
                events.push({
                    link: e.link,
                    id: String(e.id ?? ''),
                    name: e.description || null,
                    sport: byType.SPORT || null,
                    country: byType.COUNTRY || null,
                    league: byType.LEAGUE || byType.TOURNAMENT || byType.COMPETITION || gp[0]?.description || null,
                    startTime: e.startTime || null,
                    isLive: e.live === true,
                    competitors: (e.competitors || []).map((c) => c.name).filter(Boolean),
                    marketsPricedByBook: num(e.numMarkets),
                });
            }
        }
        await sleep(SPACING_MS);
    }
    // Props are loaded as a game approaches, so the soonest games carry the
    // most. Sorting soonest first puts the depth in the rows the caller pays
    // for instead of on a fixture months away.
    events.sort((a, b) => {
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
        return (a.startTime ?? 0) - (b.startTime ?? 0);
    });
    return events;
}

function readMarkets(meta, payload) {
    const ev = (Array.isArray(payload) ? payload : []).flatMap((g) => g.events || [])[0];
    if (!ev) return null;
    const out = { playerRows: [], gameRows: [], returned: 0 };

    for (const dg of ev.displayGroups || []) {
        for (const market of dg.markets || []) {
            out.returned += 1;
            const isOpen = String(market.status || '').toUpperCase() === 'O';
            if (!includeSuspended && !isOpen) continue;
            const period = market.period || {};
            const base = {
                event: meta.name,
                eventId: meta.id,
                sport: meta.sport,
                country: meta.country,
                league: meta.league,
                startTime: meta.startTime ? new Date(meta.startTime).toISOString() : null,
                isLive: meta.isLive,
                marketGroup: dg.description || null,
                marketName: market.description || null,
                period: period.description || null,
                isMainPeriod: period.main === true,
                marketStatus: isOpen ? 'open' : 'suspended',
                eventUrl: `https://www.bovada.lv${meta.link}`,
                source: 'bovada.lv',
                retrievedAt: new Date().toISOString(),
            };

            const outcomes = (market.outcomes || []).map((o) => {
                const p = parsePrice(o.price);
                return {
                    label: o.description || null,
                    isOpen: String(o.status || '').toUpperCase() === 'O',
                    priceAmerican: p.american,
                    priceDecimal: p.decimal,
                    line: p.handicap,
                    lineSecondary: p.handicapSecondary,
                    threshold: parseThreshold(o.description),
                    impliedProbabilityPercent: impliedPct(p.decimal),
                    raw: o,
                };
            });

            // An overround is only a margin when the outcomes are mutually
            // exclusive, so that exactly one of them can win. Two cases here
            // are NOT exclusive and summing them produces a confident wrong
            // number rather than a margin:
            //
            //   "Player to hit a Home Run" bundles 18 independent Yes bets;
            //   several players can homer in the same game. Summed, it read
            //   -81.83%, as though the book were paying punters to bet.
            //   "Anytime Goal Scorer" read 507.89% for the same reason.
            //   A threshold ladder (3+, 4+, 6+ strikeouts) is nested rather
            //   than exclusive: 6+ already contains 4+.
            //
            // Nothing in the response distinguishes the two kinds, so the sum
            // is published only for the shape where exclusivity is certain,
            // and the reason travels with the row everywhere else.
            const usable = outcomes.filter((o) => o.priceDecimal !== null && o.priceDecimal > 1 && o.isOpen);
            const sum = usable.reduce((a, o) => a + 1 / o.priceDecimal, 0);
            const complete = usable.length === outcomes.length && usable.length >= 2;
            const hasLadder = outcomes.some((o) => o.threshold !== null);
            const overroundFor = (exclusive) => (exclusive && complete ? metric((sum - 1) * 100, 2) : null);
            const notExclusiveReason = (kind) => (kind === 'ladder'
                ? 'The outcomes are nested thresholds rather than alternatives, so their implied probabilities do not sum to one market.'
                : 'The outcomes are independent bets on different players rather than alternatives, so their implied probabilities do not sum to one market.');

            const fromName = splitPlayerFromMarketName(market.description);
            if (fromName) {
                // Shape A: the whole market belongs to one player.
                const ladder = outcomes.some((o) => o.threshold !== null);
                out.playerRows.push({
                    ...base,
                    recordType: 'player_prop',
                    player: fromName.player,
                    playerTeam: fromName.team,
                    // The book's own team tag sometimes names a team that is
                    // not playing in this game. It is reported, never silently
                    // corrected, with a flag so a caller can drop those rows.
                    teamMatchesEvent: teamTagMatches(fromName.team, meta.competitors || []),
                    stat: fromName.stat,
                    propShape: ladder ? 'threshold_ladder' : 'over_under',
                    line: outcomes.find((o) => o.line !== null)?.line ?? null,
                    selections: outcomes.map(({ raw, ...rest }) => rest),
                    outcomesMutuallyExclusive: !ladder,
                    marketOverroundPercent: overroundFor(!ladder),
                    overroundNotPublishedReason: ladder ? notExclusiveReason('ladder') : null,
                    overroundSpansOutcomes: outcomes.length,
                    playersInMarket: 1,
                });
                continue;
            }

            // Shape B: one market, one row per player inside it.
            const playerOutcomes = outcomes
                .map((o) => ({ o, p: playerFromOutcome(o.label) }))
                .filter((x) => x.p);
            if (playerOutcomes.length >= 2) {
                for (const { o, p } of playerOutcomes) {
                    out.playerRows.push({
                        ...base,
                        recordType: 'player_prop',
                        player: p.player,
                        playerTeam: p.team,
                        teamMatchesEvent: teamTagMatches(p.team, meta.competitors || []),
                        stat: market.description || null,
                        propShape: 'player_to_do',
                        line: o.line,
                        selections: [{ label: o.label, isOpen: o.isOpen, priceAmerican: o.priceAmerican, priceDecimal: o.priceDecimal, line: o.line, lineSecondary: o.lineSecondary, threshold: o.threshold, impliedProbabilityPercent: o.impliedProbabilityPercent }],
                        outcomesMutuallyExclusive: false,
                        marketOverroundPercent: null,
                        overroundNotPublishedReason: notExclusiveReason('players'),
                        overroundSpansOutcomes: outcomes.length,
                        playersInMarket: playerOutcomes.length,
                    });
                }
                continue;
            }

            out.gameRows.push({
                ...base,
                recordType: 'game_market',
                isPlayerMarket: false,
                marketGroupLooksPlayer: isPlayerGroup(dg.description),
                selections: outcomes.map(({ raw, ...rest }) => rest),
                outcomesMutuallyExclusive: !hasLadder,
                marketOverroundPercent: overroundFor(!hasLadder),
                overroundNotPublishedReason: hasLadder ? notExclusiveReason('ladder') : null,
                overroundSpansOutcomes: outcomes.length,
            });
        }
    }
    return out;
}

function matchesFilters(row) {
    if (wantedPlayers.length && !wantedPlayers.some((p) => String(row.player || '').toLowerCase().includes(p))) return false;
    if (wantedStats.length && !wantedStats.some((s) => String(row.stat || '').toLowerCase().includes(s))) return false;
    return true;
}

// ---------------------------------------------------------------------------

async function run() {
    const paths = asList(leaguePaths);
    if (!paths.length) {
        await pushNote('No league paths given. Try baseball/mlb, football/nfl, basketball/nba or a soccer league path.');
        return;
    }
    const events = await listEvents(paths);
    if (!events.length) {
        await pushNote(`Nothing scheduled on ${paths.join(', ')} right now. A league out of season returns an empty feed rather than an error.`);
        return;
    }

    const playerRows = [];
    const gameRows = [];
    let opened = 0;
    let emptyOfProps = 0;

    for (const meta of events.slice(0, eventCap)) {
        if (pastDeadline()) {
            await pushNote(`Stopped at the run deadline after opening ${opened} of ${Math.min(events.length, eventCap)} games.`);
            break;
        }
        const res = await fetchJson(eventUrl(meta.link));
        if (res.error || res.notFound) {
            await pushNote(`Could not open "${meta.name}"${res.error ? `: ${res.error}` : ''}.`, { event: meta.name });
            continue;
        }
        opened += 1;
        const read = readMarkets(meta, res.data);
        if (!read) continue;
        if (!read.playerRows.length) emptyOfProps += 1;
        playerRows.push(...read.playerRows);
        gameRows.push(...read.gameRows);
        await sleep(SPACING_MS);
    }

    if (theMode === 'markets') {
        if (!gameRows.length) {
            await pushNote(`No non player markets came back from the ${opened} game(s) opened.`);
            return;
        }
        for (const r of gameRows) if (!(await pushRow(r))) break;
        return;
    }

    const filtered = playerRows.filter(matchesFilters);
    if (!filtered.length) {
        if (!playerRows.length) {
            // A book loads player markets as a game approaches, so a fixture
            // weeks out legitimately has none. That is a stated fact, not an
            // empty result to bill for.
            await pushNote(`No player markets are priced yet on the ${opened} game(s) opened. Books load player props close to game time, so try a league playing today or a game starting sooner.`);
        } else {
            await pushNote(`${playerRows.length} player markets were found but none matched the player or stat filters.`);
        }
        return;
    }

    if (theMode === 'players') {
        const byPlayer = new Map();
        for (const r of filtered) {
            const key = `${r.eventId}|${r.player}`;
            const entry = byPlayer.get(key) || {
                recordType: 'player',
                player: r.player,
                playerTeam: r.playerTeam,
                teamMatchesEvent: r.teamMatchesEvent,
                event: r.event,
                eventId: r.eventId,
                league: r.league,
                sport: r.sport,
                startTime: r.startTime,
                isLive: r.isLive,
                eventUrl: r.eventUrl,
                stats: [],
                marketCount: 0,
                source: 'bovada.lv',
                retrievedAt: r.retrievedAt,
            };
            entry.marketCount += 1;
            if (!entry.stats.includes(r.stat)) entry.stats.push(r.stat);
            byPlayer.set(key, entry);
        }
        const rows = [...byPlayer.values()].sort((a, b) => b.marketCount - a.marketCount);
        for (const r of rows) if (!(await pushRow(r))) break;
        return;
    }

    filtered.sort((a, b) => String(a.player || '').localeCompare(String(b.player || '')) || String(a.stat || '').localeCompare(String(b.stat || '')));
    let returned = 0;
    for (const r of filtered) {
        if (!(await pushRow(r))) break;
        returned += 1;
    }
    if (filtered.length > returned) {
        await pushNote(`${filtered.length} player markets matched and ${returned} were returned. Raise the maximum rows for the rest.`);
    }
    if (emptyOfProps) {
        await pushNote(`${emptyOfProps} of the ${opened} game(s) opened had no player markets priced yet, which is normal for fixtures that are not close to starting.`);
    }
}

process.on('unhandledRejection', (err) => log.exception(err instanceof Error ? err : new Error(String(err)), 'Unhandled rejection'));
process.on('uncaughtException', (err) => log.exception(err, 'Uncaught exception'));

try {
    log.info(`Mode: ${theMode}, up to ${eventCap} game(s), row cap ${rowCap}`);
    await run();
} catch (err) {
    log.exception(err, 'Run failed');
    await pushNote(`The run stopped early: ${String(err?.message || err)}`);
}

log.info(`Pushed ${pushed} rows (${charged} charged, ${noteCount} free notes).`);
await Actor.exit();
