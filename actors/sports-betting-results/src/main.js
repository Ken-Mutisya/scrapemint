// Sports Betting Results: Closing Odds vs Final Scores
//
// What it does
// ------------
// Every other odds feed stops at kickoff. This one starts there: it takes the
// CLOSING line a game was played at, joins it to the final score, and grades
// the three markets people actually bet.
//
//   moneyline  did the favourite win, or was it an upset
//   spread     which side covered the closing number, or was it a push
//   total      did the game go over or under the closing total
//
// Distinct from our sports-odds-scraper (pregame lines on fixtures that have
// not been played) and sports-odds-movement-tracker (how a line moved). Both
// look forward; this one settles what already happened.
//
//   games    one row per finished game, graded, with the closing prices
//   teams    one row per team: straight up record, record against the spread,
//            over/under record, and profit on a flat 100 stake every game
//   summary  one row per league: how often favourites won, how often they
//            covered, how often the total went over, and what betting every
//            underdog would have returned
//
// Data source
// -----------
// ESPN, keyless, no proxy. The scoreboard gives the slate and the final
// scores; the core odds endpoint keeps each game's open, close and current
// prices after the game is over. The scoreboard's own odds block is stripped
// once a game finishes, which is why the closing numbers come from the core
// endpoint instead.
//
// Pay per event
// -------------
//   result_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Unplayed games, games with no published line, and note rows are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const CONCURRENCY = 6;
const REQUEST_SPACING_MS = 80;
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'games',
    leagues = ['mlb'],
    daysBack = 3,
    dateFrom = '',
    dateTo = '',
    teamFilter = [],
    onlyUpsets = false,
    minClosingSpread = 0,
    maxGames = 200,
    maxRows = 500,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Friendly names -> ESPN sport/league paths. A raw "sport/league" passes
// through, so any ESPN league works even if it is not listed here.
const LEAGUE_PATHS = {
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    nba: 'basketball/nba',
    wnba: 'basketball/wnba',
    ncaab: 'basketball/mens-college-basketball',
    mlb: 'baseball/mlb',
    nhl: 'hockey/nhl',
    epl: 'soccer/eng.1',
    laliga: 'soccer/esp.1',
    seriea: 'soccer/ita.1',
    bundesliga: 'soccer/ger.1',
    ligue1: 'soccer/fra.1',
    mls: 'soccer/usa.1',
    ucl: 'soccer/uefa.champions',
    uel: 'soccer/uefa.europa',
};
// College basketball's scoreboard returns a short featured slate unless the
// D1 group is asked for by number: 17 games became 132 on the same date.
const LEAGUE_GROUPS = { 'basketball/mens-college-basketball': '50' };

const theMode = ['games', 'teams', 'summary'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'games';
const leagueKeys = asList(leagues);
if (!leagueKeys.length) leagueKeys.push('mlb');
const teamFilters = asList(teamFilter).map((s) => s.toLowerCase());
const spreadFloor = Math.max(0, Number(minClosingSpread) || 0);
const gameCap = Math.max(1, Math.min(HARD_CAP, Number(maxGames) || 200));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

const yyyymmdd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const normDate = (s) => {
    const t = String(s || '').trim().replace(/-/g, '');
    return /^\d{8}$/.test(t) ? t : null;
};
let rangeStart = normDate(dateFrom);
let rangeEnd = normDate(dateTo);
if (!rangeStart) {
    const back = Math.max(0, Math.min(365, Number(daysBack) || 3));
    const end = new Date();
    const start = new Date(end.getTime() - back * 86400000);
    rangeStart = yyyymmdd(start);
    rangeEnd = rangeEnd || yyyymmdd(end);
}
if (!rangeEnd) rangeEnd = rangeStart;
if (rangeEnd < rangeStart) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
const dateParam = rangeStart === rangeEnd ? rangeStart : `${rangeStart}-${rangeEnd}`;

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        if (attempt < 2) {
            await sleep(400 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url.slice(0, 120)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'result_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// "-3.5" / "+150" / "EVEN" / "PK" -> number. Returns null for anything else,
// never 0, because a missing price and a pick'em are not the same thing.
function num(value) {
    const s = String(value ?? '').trim().toUpperCase();
    if (!s) return null;
    if (s === 'EVEN' || s === 'PK' || s === 'PICK') return 0;
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)$/);
    return m ? Number(m[1]) : null;
}

// Profit on a 100 stake at an American price. Push returns the stake, a loss
// returns -100, so these add up into a running profit figure directly.
function profit100(american, outcome) {
    const a = num(american);
    if (a == null || outcome == null) return null;
    if (outcome === 'push') return 0;
    if (outcome === 'loss') return -100;
    if (a === 0) return 100;
    return a > 0 ? a : round(10000 / Math.abs(a), 2);
}

// Soccer carries two providers and the second one is frequently an empty
// shell: prices undefined, only a draw price present. Score every item on the
// numbers actually needed and keep the most complete, falling back to the
// provider ESPN ranks first only when nothing has prices.
function pickOddsItem(items) {
    let best = null;
    let bestScore = -1;
    for (const it of items || []) {
        const home = it.homeTeamOdds || {};
        const away = it.awayTeamOdds || {};
        const line = home.close || home.current || {};
        const awayLine = away.close || away.current || {};
        let score = 0;
        if (num(line.pointSpread?.american) != null) score += 2;
        if (num(line.moneyLine?.american) != null) score += 2;
        if (num(awayLine.moneyLine?.american) != null) score += 1;
        if (Number.isFinite(it.overUnder) && it.overUnder !== 0) score += 2;
        if (home.close || away.close) score += 1;
        const priority = Number(it.provider?.priority) || 99;
        if (score > bestScore || (score === bestScore && best && priority < (Number(best.provider?.priority) || 99))) {
            best = it;
            bestScore = score;
        }
    }
    return bestScore > 0 ? best : null;
}

function gradeGame(league, event, oddsItem) {
    const comp = event.competitions?.[0];
    const competitors = comp?.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) return null;

    const homeScore = num(home.score);
    const awayScore = num(away.score);
    if (homeScore == null || awayScore == null) return null;

    const homeOdds = oddsItem.homeTeamOdds || {};
    const awayOdds = oddsItem.awayTeamOdds || {};
    // `close` is the line the game was actually played at. `current` is the
    // same thing once a game is over, so it is the fallback rather than the
    // top level fields, which ESPN sometimes leaves at a stale value.
    const homeClose = homeOdds.close || homeOdds.current || {};
    const awayClose = awayOdds.close || awayOdds.current || {};
    const lineSource = homeOdds.close ? 'close' : (homeOdds.current ? 'current' : 'top_level');

    let homeSpread = num(homeClose.pointSpread?.american);
    if (homeSpread == null && Number.isFinite(oddsItem.spread)) homeSpread = oddsItem.spread;
    const homeMl = num(homeClose.moneyLine?.american) ?? num(homeOdds.moneyLine);
    const awayMl = num(awayClose.moneyLine?.american) ?? num(awayOdds.moneyLine);
    const drawMl = num(oddsItem.drawOdds?.moneyLine);
    const total = Number.isFinite(oddsItem.overUnder) && oddsItem.overUnder !== 0 ? oddsItem.overUnder : null;

    // initialSpread and initialOverUnder arrive as 0.0 on games that never had
    // an opening number published, so a real pick'em opener and a missing one
    // would look identical. The open block is used instead and left null when
    // it is absent.
    const openSpread = num(homeOdds.open?.pointSpread?.american);

    const margin = homeScore - awayScore;
    const winner = margin > 0 ? 'home' : (margin < 0 ? 'away' : 'draw');

    // Two different favourites, and they are not always the same team. ESPN's
    // own `favorite` flag follows the SPREAD, but baseball and hockey run the
    // spread at a fixed 1.5, so the moneyline favourite disagrees with that
    // flag in roughly a fifth of MLB games. Grading a moneyline against the
    // spread favourite invents upsets, so each market is graded against its
    // own favourite and both are reported.
    let moneylineFavorite = null;
    if (homeMl != null && awayMl != null && homeMl !== awayMl) moneylineFavorite = homeMl < awayMl ? 'home' : 'away';
    let spreadFavorite = null;
    if (homeSpread != null && homeSpread !== 0) spreadFavorite = homeSpread < 0 ? 'home' : 'away';
    else if (homeSpread == null) {
        if (homeOdds.favorite === true) spreadFavorite = 'home';
        else if (awayOdds.favorite === true) spreadFavorite = 'away';
    }

    let moneylineResult = null;
    if (moneylineFavorite) {
        if (winner === 'draw') moneylineResult = 'draw';
        else moneylineResult = winner === moneylineFavorite ? 'favorite_won' : 'upset';
    }

    let spreadResult = 'unavailable';
    if (homeSpread != null) {
        const adjusted = homeScore + homeSpread;
        spreadResult = adjusted > awayScore ? 'home_covered' : (adjusted < awayScore ? 'away_covered' : 'push');
    }
    let favoriteCovered = null;
    if (spreadFavorite && spreadResult !== 'unavailable' && spreadResult !== 'push') {
        favoriteCovered = spreadResult === `${spreadFavorite}_covered`;
    }

    const totalPoints = homeScore + awayScore;
    let totalResult = 'unavailable';
    if (total != null) totalResult = totalPoints > total ? 'over' : (totalPoints < total ? 'under' : 'push');

    const favMl = moneylineFavorite === 'home' ? homeMl : (moneylineFavorite === 'away' ? awayMl : null);
    const dogMl = moneylineFavorite === 'home' ? awayMl : (moneylineFavorite === 'away' ? homeMl : null);
    const favOutcome = moneylineResult === 'favorite_won' ? 'win' : (moneylineResult ? 'loss' : null);
    const dogOutcome = moneylineResult === 'upset' ? 'win' : (moneylineResult ? 'loss' : null);

    const homeSpreadPrice = num(homeClose.spread?.american);
    const awaySpreadPrice = num(awayClose.spread?.american);
    const favSpreadPrice = spreadFavorite === 'home' ? homeSpreadPrice : (spreadFavorite === 'away' ? awaySpreadPrice : null);
    const favSpreadOutcome = spreadResult === 'push'
        ? 'push'
        : (favoriteCovered == null ? null : (favoriteCovered ? 'win' : 'loss'));

    return {
        league,
        gameId: String(event.id),
        gameDate: event.date,
        name: clean(event.name),
        provider: clean(oddsItem.provider?.name),
        homeTeam: clean(home.team?.abbreviation || home.team?.shortDisplayName),
        homeTeamName: clean(home.team?.displayName),
        awayTeam: clean(away.team?.abbreviation || away.team?.shortDisplayName),
        awayTeamName: clean(away.team?.displayName),
        homeScore,
        awayScore,
        winner,
        margin,
        moneylineFavorite,
        moneylineFavoriteTeam: moneylineFavorite === 'home' ? clean(home.team?.abbreviation) : (moneylineFavorite === 'away' ? clean(away.team?.abbreviation) : null),
        spreadFavorite,
        spreadFavoriteTeam: spreadFavorite === 'home' ? clean(home.team?.abbreviation) : (spreadFavorite === 'away' ? clean(away.team?.abbreviation) : null),
        closingSpreadHome: homeSpread,
        closingSpreadAway: homeSpread == null ? null : round(-homeSpread, 2),
        closingSpreadPriceHome: homeSpreadPrice,
        closingSpreadPriceAway: awaySpreadPrice,
        closingTotal: total,
        closingMoneylineHome: homeMl,
        closingMoneylineAway: awayMl,
        closingMoneylineDraw: drawMl,
        openingSpreadHome: openSpread,
        // Positive means the closing number moved towards the home side.
        spreadMove: openSpread != null && homeSpread != null ? round(openSpread - homeSpread, 2) : null,
        moneylineResult,
        spreadResult,
        favoriteCovered,
        totalPoints,
        totalResult,
        // Profit on a flat 100 stake at the closing price. A draw loses both
        // sides of a moneyline in leagues that price the draw separately.
        favoriteProfit100: profit100(favMl, favOutcome),
        underdogProfit100: profit100(dogMl, dogOutcome),
        favoriteSpreadProfit100: profit100(favSpreadPrice ?? -110, favSpreadOutcome),
        lineSource,
        scrapedAt: new Date().toISOString(),
    };
}

async function fetchLeagueGames(key) {
    const path = LEAGUE_PATHS[key.toLowerCase()] || (key.includes('/') ? key : null);
    if (!path) {
        await flushRow({ type: 'note', league: key, found: false, note: 'unknown league; use nfl, nba, mlb, nhl, ncaaf, ncaab, wnba, epl, laliga, seriea, bundesliga, ligue1, mls, ucl or a raw ESPN sport/league path; not charged' }, false);
        return [];
    }
    const [sport, leagueId] = path.split('/');
    const groups = LEAGUE_GROUPS[path] ? `&groups=${LEAGUE_GROUPS[path]}` : '';
    const board = await getJson(`${SITE}/${path}/scoreboard?dates=${dateParam}&limit=1000${groups}`);
    const events = board?.events || [];
    if (!events.length) {
        await flushRow({ type: 'note', league: key, found: false, dateRange: dateParam, note: 'no games on the scoreboard for this league and date range; check the dates or the league was out of season; not charged' }, false);
        return [];
    }
    const finished = events.filter((e) => e.competitions?.[0]?.status?.type?.completed === true);
    log.info(`${key}: ${events.length} game(s) on the board, ${finished.length} finished`);
    if (!finished.length) {
        await flushRow({ type: 'note', league: key, found: false, dateRange: dateParam, games: events.length, note: 'games found but none are finished yet, so there is nothing to grade; not charged' }, false);
        return [];
    }
    return finished.map((e) => ({ key, sport, leagueId, event: e }));
}

// One odds request per finished game, run through a small pool. The pool is
// what keeps a month of a busy league inside the run budget.
async function gradeAll(jobs) {
    const graded = [];
    let cursor = 0;
    let noLine = 0;
    const stop = () => (deadlineMs && Date.now() > deadlineMs);
    const worker = async () => {
        while (cursor < jobs.length && !stop()) {
            const job = jobs[cursor];
            cursor += 1;
            const comp = job.event.competitions[0];
            const data = await getJson(`${CORE}/${job.sport}/leagues/${job.leagueId}/events/${job.event.id}/competitions/${comp.id}/odds`);
            await sleep(REQUEST_SPACING_MS);
            const item = pickOddsItem(data?.items);
            if (!item) { noLine += 1; continue; }
            const row = gradeGame(job.key, job.event, item);
            if (row) graded.push(row);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    if (noLine) log.info(`${noLine} finished game(s) had no published line and were skipped (not charged)`);
    if (stop()) log.warning('run deadline reached; returning what was graded so far');
    return graded;
}

function passesFilters(row) {
    if (onlyUpsets && row.moneylineResult !== 'upset') return false;
    if (spreadFloor && (row.closingSpreadHome == null || Math.abs(row.closingSpreadHome) < spreadFloor)) return false;
    if (teamFilters.length) {
        const hay = [row.homeTeam, row.awayTeam, row.homeTeamName, row.awayTeamName]
            .filter(Boolean).join(' ').toLowerCase();
        if (!teamFilters.some((t) => hay.includes(t))) return false;
    }
    return true;
}

function buildTeamRows(rows) {
    const byTeam = new Map();
    const bump = (team, teamName, league, side, row) => {
        const id = `${league}|${team}`;
        if (!byTeam.has(id)) {
            byTeam.set(id, {
                mode: 'teams', league, team, teamName, games: 0, wins: 0, losses: 0, draws: 0,
                atsWins: 0, atsLosses: 0, atsPushes: 0, overs: 0, unders: 0, totalPushes: 0,
                gamesAsFavorite: 0, winsAsFavorite: 0, gamesAsUnderdog: 0, winsAsUnderdog: 0,
                spreadSum: 0, spreadCount: 0, moneylineProfit100: 0, pointsFor: 0, pointsAgainst: 0,
            });
        }
        const t = byTeam.get(id);
        const isHome = side === 'home';
        const scoreFor = isHome ? row.homeScore : row.awayScore;
        const scoreAgainst = isHome ? row.awayScore : row.homeScore;
        t.games += 1;
        t.pointsFor += scoreFor;
        t.pointsAgainst += scoreAgainst;
        if (row.winner === 'draw') t.draws += 1;
        else if (row.winner === side) t.wins += 1;
        else t.losses += 1;
        if (row.spreadResult === 'push') t.atsPushes += 1;
        else if (row.spreadResult === `${side}_covered`) t.atsWins += 1;
        else if (row.spreadResult !== 'unavailable') t.atsLosses += 1;
        if (row.totalResult === 'over') t.overs += 1;
        else if (row.totalResult === 'under') t.unders += 1;
        else if (row.totalResult === 'push') t.totalPushes += 1;
        const spread = isHome ? row.closingSpreadHome : row.closingSpreadAway;
        if (spread != null) { t.spreadSum += spread; t.spreadCount += 1; }
        // Favourite and underdog here mean the moneyline, the market these
        // straight up records settle against.
        if (row.moneylineFavorite === side) {
            t.gamesAsFavorite += 1;
            if (row.winner === side) t.winsAsFavorite += 1;
        } else if (row.moneylineFavorite) {
            t.gamesAsUnderdog += 1;
            if (row.winner === side) t.winsAsUnderdog += 1;
        }
        const ml = isHome ? row.closingMoneylineHome : row.closingMoneylineAway;
        const outcome = row.winner === side ? 'win' : 'loss';
        const p = profit100(ml, outcome);
        if (p != null) t.moneylineProfit100 += p;
    };
    for (const row of rows) {
        bump(row.homeTeam, row.homeTeamName, row.league, 'home', row);
        bump(row.awayTeam, row.awayTeamName, row.league, 'away', row);
    }
    const out = [...byTeam.values()].map((t) => {
        const atsDecided = t.atsWins + t.atsLosses;
        const totalDecided = t.overs + t.unders;
        return {
            ...t,
            record: `${t.wins}-${t.losses}${t.draws ? `-${t.draws}` : ''}`,
            atsRecord: `${t.atsWins}-${t.atsLosses}${t.atsPushes ? `-${t.atsPushes}` : ''}`,
            atsWinPercent: atsDecided ? round((t.atsWins / atsDecided) * 100, 1) : null,
            overPercent: totalDecided ? round((t.overs / totalDecided) * 100, 1) : null,
            avgClosingSpread: t.spreadCount ? round(t.spreadSum / t.spreadCount, 2) : null,
            // What a flat 100 on this team every game would have returned.
            moneylineProfit100: round(t.moneylineProfit100, 2),
            spreadSum: undefined,
            spreadCount: undefined,
            dateRange: dateParam,
            scrapedAt: new Date().toISOString(),
        };
    });
    out.sort((a, b) => (b.atsWinPercent ?? -1) - (a.atsWinPercent ?? -1) || b.games - a.games);
    return out;
}

function buildSummaryRows(rows) {
    const byLeague = new Map();
    for (const row of rows) {
        if (!byLeague.has(row.league)) byLeague.set(row.league, []);
        byLeague.get(row.league).push(row);
    }
    const out = [];
    for (const [league, list] of byLeague) {
        const mlDecided = list.filter((r) => r.moneylineResult === 'favorite_won' || r.moneylineResult === 'upset');
        const favWins = mlDecided.filter((r) => r.moneylineResult === 'favorite_won').length;
        const atsDecided = list.filter((r) => r.favoriteCovered != null);
        const favCovers = atsDecided.filter((r) => r.favoriteCovered).length;
        const homeCovers = list.filter((r) => r.spreadResult === 'home_covered').length;
        const spreadDecided = list.filter((r) => r.spreadResult === 'home_covered' || r.spreadResult === 'away_covered').length;
        const overs = list.filter((r) => r.totalResult === 'over').length;
        const unders = list.filter((r) => r.totalResult === 'under').length;
        const withTotal = list.filter((r) => r.closingTotal != null);
        const dogProfit = list.reduce((t, r) => t + (r.underdogProfit100 ?? 0), 0);
        const favProfit = list.reduce((t, r) => t + (r.favoriteProfit100 ?? 0), 0);
        out.push({
            mode: 'summary',
            league,
            dateRange: dateParam,
            gamesGraded: list.length,
            draws: list.filter((r) => r.winner === 'draw').length,
            favoriteWinPercent: mlDecided.length ? round((favWins / mlDecided.length) * 100, 1) : null,
            upsets: mlDecided.length - favWins,
            favoriteCoverPercent: atsDecided.length ? round((favCovers / atsDecided.length) * 100, 1) : null,
            homeCoverPercent: spreadDecided ? round((homeCovers / spreadDecided) * 100, 1) : null,
            pushes: list.filter((r) => r.spreadResult === 'push').length,
            overPercent: overs + unders ? round((overs / (overs + unders)) * 100, 1) : null,
            overs,
            unders,
            avgClosingTotal: withTotal.length ? round(withTotal.reduce((t, r) => t + r.closingTotal, 0) / withTotal.length, 2) : null,
            avgActualTotal: withTotal.length ? round(withTotal.reduce((t, r) => t + r.totalPoints, 0) / withTotal.length, 2) : null,
            avgWinningMargin: list.length ? round(list.reduce((t, r) => t + Math.abs(r.margin), 0) / list.length, 2) : null,
            // Profit from a flat 100 stake on every underdog, and on every
            // favourite, at the closing moneyline.
            underdogFlatProfit100: round(dogProfit, 2),
            favoriteFlatProfit100: round(favProfit, 2),
            scrapedAt: new Date().toISOString(),
        });
    }
    out.sort((a, b) => b.gamesGraded - a.gamesGraded);
    return out;
}

log.info(`Sports betting results ${theMode} | ${leagueKeys.join(', ')} | dates ${dateParam} | cap ${gameCap} games, ${rowCap} rows`);

const jobs = [];
for (const key of leagueKeys) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const found = await fetchLeagueGames(key);
    jobs.push(...found);
}
// Newest first, so a capped run keeps the most recent slate.
jobs.sort((a, b) => String(b.event.date).localeCompare(String(a.event.date)));
const capped = jobs.slice(0, gameCap);
if (jobs.length > capped.length) log.info(`${jobs.length} finished games found, grading the ${capped.length} most recent (maxGames)`);

const gradedAll = await gradeAll(capped);
const graded = gradedAll.filter(passesFilters);
graded.sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)));

let rows;
if (theMode === 'teams') rows = buildTeamRows(graded);
else if (theMode === 'summary') rows = buildSummaryRows(graded);
else rows = graded.map((r) => ({ mode: 'games', ...r }));

let emitted = 0;
for (const row of rows.slice(0, rowCap)) {
    await flushRow(row);
    emitted += 1;
}

if (!emitted) {
    await flushRow({
        type: 'note', found: false, dateRange: dateParam, leagues: leagueKeys,
        gamesGraded: gradedAll.length,
        note: gradedAll.length === 0
            ? 'no finished games with a published closing line in this range; widen the dates or pick a league that was in season; not charged'
            : `${gradedAll.length} game(s) were graded but every one was removed by the filters; relax onlyUpsets, minClosingSpread or teamFilter; not charged`,
    }, false);
}

log.info(`Done. ${graded.length} game(s) graded, ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
