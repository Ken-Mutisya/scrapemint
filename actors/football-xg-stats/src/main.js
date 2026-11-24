// Football xG Stats: xG tables, player xG/xA and match xG for 40+ leagues
//
// Strategy
// --------
// FotMob's web API answers without a key:
//   www.fotmob.com/api/data/leagues?id={id}&season={YYYY/YYYY}
//       league details, the league table including an "xg" table (xG, xGA,
//       expected points, expected position), every fixture of the season and the
//       URLs of ~40 player and ~30 team season stat lists.
//   data.fotmob.com/stats/{id}/season/{tournamentId}/{stat}.json
//       one ranked stat list (e.g. expected_goals, expected_assists, rating).
//   www.fotmob.com/api/data/matchDetails?matchId={id}
//       one match: top stats incl. xG, xGOT, possession, shots, big chances and
//       the shot map with xG per shot.
// Modes:
//   teams    one row per team: table + xG table + selected team stat lists
//   players  one row per player: selected player stat lists merged by player
//   matches  one row per finished match: score, xG and match stats (+ shots)
//
// Pay per event
// -------------
//   row ($0.002) one team, player or match row. The first FREE_TIER_ROWS rows
//   of every run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LEAGUES = {
    'premier league': 47, epl: 47, championship: 48, 'league one': 108, laliga: 87, 'la liga': 87, laliga2: 140,
    'serie a': 55, bundesliga: 54, 'ligue 1': 53, eredivisie: 57, 'liga portugal': 61, 'primeira liga': 61,
    'scottish premiership': 64, 'belgian pro league': 40, 'super lig': 71, 'süper lig': 71, mls: 130,
    'champions league': 42, ucl: 42, 'europa league': 73, 'conference league': 10216, 'brasileirao': 268,
    'brazil serie a': 268, 'saudi pro league': 536, 'liga mx': 230, 'j league': 223, 'j1 league': 223,
    'a-league': 113, 'world cup': 77, 'danish superliga': 46, 'austrian bundesliga': 38, 'swiss super league': 69,
    'league of ireland': 126,
};
const PLAYER_STATS = {
    goals: 'goals', assists: 'goal_assist', xg: 'expected_goals', xgPer90: 'expected_goals_per_90',
    xgot: 'expected_goalsontarget', xa: 'expected_assists', xaPer90: 'expected_assists_per_90',
    xgPlusXaPer90: '_expected_goals_and_expected_assists_per_90', goalsPer90: 'goals_per_90', rating: 'rating',
    minutes: 'mins_played', shotsPer90: 'total_scoring_att', shotsOnTargetPer90: 'ontarget_scoring_att',
    bigChancesCreated: 'big_chance_created', bigChancesMissed: 'big_chance_missed', chancesCreated: 'total_att_assist',
    successfulDribblesPer90: 'won_contest', tacklesPer90: 'total_tackle', interceptionsPer90: 'interception',
    cleanSheets: 'clean_sheet', savesPer90: 'saves', savePct: '_save_percentage', goalsPrevented: '_goals_prevented',
};
const TEAM_STATS = {
    goalsPerMatch: 'goals_team_match', goalsConcededPerMatch: 'goals_conceded_team_match', possessionPct: 'possession_percentage_team',
    shotsOnTargetPerMatch: 'ontarget_scoring_att_team', bigChances: 'big_chance_team', bigChancesMissed: 'big_chance_missed_team',
    cleanSheets: 'clean_sheet_team', rating: 'rating_team', touchesInOppBox: 'touches_in_opp_box_team',
    corners: 'corner_taken_team', setPieceGoals: '_set_piece_goals_team', yellowCards: 'total_yel_card_team', redCards: 'total_red_card_team',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    mode = 'teams',
    leagues = ['Premier League'],
    season = '',
    lastMatches = 0,
    includeShots = false,
    minMinutes = 0,
    maxRows = 1000,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 1000));
const num = (v) => { if (v === undefined || v === null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
            if (res.ok) return await res.json();
            if (res.status === 404) return null;
            log.warning(`${url.slice(0, 100)}: HTTP ${res.status} (attempt ${attempt})`);
        } catch (err) {
            log.warning(`${url.slice(0, 100)}: ${err.message} (attempt ${attempt})`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return null;
}

let pushed = 0;
async function push(row) {
    if (pushed >= cap) return false;
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'row' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
    return true;
}

function npxg(xg, shots, mine) {
    if (xg === null || !shots.length) return null;
    const pen = shots.filter((s) => mine(s) && /penalty/i.test(s.situation || '') && !s.isOwnGoal).reduce((t, s) => t + (s.expectedGoals || 0), 0);
    return r2(Math.max(0, xg - pen));
}

async function statList(url) {
    const j = await getJson(url);
    return j?.TopLists?.[0]?.StatList || [];
}

// ---------- per league ----------
const leagueIds = [];
for (const l of arr(leagues)) {
    const id = /^\d+$/.test(l) ? Number(l) : (l.match(/leagues\/(\d+)/) || [])[1] ? Number(l.match(/leagues\/(\d+)/)[1]) : LEAGUES[l.toLowerCase()];
    if (!id) { log.warning(`Unknown league "${l}". Use a name like Premier League, LaLiga, Serie A, MLS, or a FotMob league ID/URL.`); continue; }
    leagueIds.push(id);
}
if (!leagueIds.length) {
    await Actor.pushData({ note: 'No known league. Use names such as Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, Championship, MLS, Champions League, or a FotMob league ID or URL. Not charged.' });
    await Actor.exit();
}

for (const id of leagueIds) {
    if (pushed >= cap) break;
    const lg = await getJson(`https://www.fotmob.com/api/data/leagues?id=${id}${season ? `&season=${encodeURIComponent(season)}` : ''}`);
    if (!lg?.details) { log.warning(`League ${id}: no data`); continue; }
    const league = { leagueId: id, league: lg.details.name, country: lg.details.country, season: lg.details.selectedSeason };
    log.info(`${league.league} ${league.season}: mode ${mode}`);

    if (mode === 'teams') {
        const tables = (lg.table || []).flatMap((t) => (t.data?.tables ? t.data.tables : t.data ? [t.data] : []));
        const byTeam = new Map();
        for (const t of tables) {
            const groupName = t.leagueName && t.leagueName !== league.league ? t.leagueName : null;
            for (const row of t.table?.all || []) byTeam.set(row.id, { group: groupName, all: row });
            for (const row of t.table?.xg || []) { const e = byTeam.get(row.teamId ?? row.id); if (e) e.xg = row; }
        }
        const statsByTeam = new Map();
        const teamLinks = new Map((lg.stats?.teams || []).map((s) => [s.name, s.fetchAllUrl]));
        for (const [field, stat] of Object.entries(TEAM_STATS)) {
            const url = teamLinks.get(stat);
            if (!url) continue;
            for (const s of await statList(url)) {
                const e = statsByTeam.get(s.TeamId) || {};
                e[field] = num(s.StatValue);
                statsByTeam.set(s.TeamId, e);
            }
        }
        const rows = [...byTeam.entries()].map(([teamId, e]) => {
            const a = e.all; const x = e.xg || {};
            const [gf, ga] = String(a.scoresStr || '').split('-').map((v) => num(v));
            const st = statsByTeam.get(teamId) || {};
            return {
                ...league,
                group: e.group,
                position: a.idx ?? null,
                team: a.name,
                teamId,
                played: a.played ?? null, wins: a.wins ?? null, draws: a.draws ?? null, losses: a.losses ?? null,
                goalsFor: gf ?? null, goalsAgainst: ga ?? null, goalDiff: a.goalConDiff ?? null, points: a.pts ?? null,
                xg: r2(num(x.xg)), xga: r2(num(x.xgConceded)), xgDiff: x.xg != null && x.xgConceded != null ? r2(x.xg - x.xgConceded) : null,
                xPoints: r2(num(x.xPoints)), xPosition: x.xPosition ?? null,
                goalsMinusXg: gf != null && x.xg != null ? r2(gf - x.xg) : null,
                goalsAgainstMinusXga: ga != null && x.xgConceded != null ? r2(ga - x.xgConceded) : null,
                pointsMinusXPoints: a.pts != null && x.xPoints != null ? r2(a.pts - x.xPoints) : null,
                ...st,
                url: a.pageUrl ? `https://www.fotmob.com${a.pageUrl}` : null,
            };
        });
        rows.sort((p, q) => String(p.group || '').localeCompare(String(q.group || '')) || (p.position ?? 99) - (q.position ?? 99));
        for (const row of rows) if (!(await push(row))) break;
    } else if (mode === 'players') {
        const links = new Map((lg.stats?.players || []).map((s) => [s.name, s.fetchAllUrl]));
        const players = new Map();
        for (const [field, stat] of Object.entries(PLAYER_STATS)) {
            const url = links.get(stat);
            if (!url) continue;
            for (const s of await statList(url)) {
                const pid = s.ParticiantId ?? s.ParticipantId;
                if (!pid) continue;
                const p = players.get(pid) || { player: s.ParticipantName, playerId: pid, team: s.TeamName, teamId: s.TeamId, nationality: s.ParticipantCountryCode || null, matchesPlayed: s.MatchesPlayed ?? null };
                p[field] = num(s.StatValue);
                if (field === 'minutes' || p.minutes == null) p.minutes = p.minutes ?? (num(s.MinutesPlayed) || null);
                if (field === 'xg' && s.SubStatValue != null) p.goals = p.goals ?? num(s.SubStatValue);
                players.set(pid, p);
            }
        }
        const rows = [...players.values()]
            .filter((p) => !(minMinutes > 0) || (p.minutes ?? 0) >= minMinutes)
            .map((p) => ({
                ...league, ...p,
                goalsMinusXg: p.goals != null && p.xg != null ? r2(p.goals - p.xg) : null,
                assistsMinusXa: p.assists != null && p.xa != null ? r2(p.assists - p.xa) : null,
                url: `https://www.fotmob.com/players/${p.playerId}`,
            }))
            .sort((p, q) => (q.xg ?? -1) - (p.xg ?? -1) || (q.minutes ?? 0) - (p.minutes ?? 0) || p.playerId - q.playerId);
        log.info(`${rows.length} players`);
        for (const row of rows) if (!(await push(row))) break;
    } else {
        let fixtures = (lg.fixtures?.allMatches || []).filter((m) => m.status?.finished && !m.status?.cancelled);
        fixtures.sort((p, q) => String(q.status.utcTime).localeCompare(String(p.status.utcTime))); // newest first
        if (lastMatches > 0) fixtures = fixtures.slice(0, lastMatches);
        fixtures = fixtures.slice(0, Math.max(0, cap - pushed));
        log.info(`${fixtures.length} finished matches to fetch`);
        const CONC = 4;
        for (let i = 0; i < fixtures.length; i += CONC) {
            const batch = await Promise.all(fixtures.slice(i, i + CONC).map(async (m) => ({ m, d: await getJson(`https://www.fotmob.com/api/data/matchDetails?matchId=${m.id}`) })));
            for (const { m, d } of batch) {
                const stats = {};
                for (const g of d?.content?.stats?.Periods?.All?.stats || []) {
                    for (const s of g.stats || []) if (s.title && Array.isArray(s.stats) && s.stats[0] != null && !(s.title in stats)) stats[s.title] = s.stats;
                }
                const sv = (name, i2) => { const v = stats[name]?.[i2]; if (v == null) return null; const mm = String(v).match(/-?\d+(\.\d+)?/); return mm ? Number(mm[0]) : null; };
                const [hs, as] = String(m.status.scoreStr || '').split('-').map((v) => num(v.trim()));
                const shots = d?.content?.shotmap?.shots || [];
                const homeId = Number(m.home.id);
                const row = {
                    ...league,
                    matchId: m.id,
                    round: m.round ?? null,
                    date: m.status.utcTime,
                    homeTeam: m.home.name, awayTeam: m.away.name,
                    homeGoals: hs ?? null, awayGoals: as ?? null,
                    homeXg: sv('Expected goals (xG)', 0), awayXg: sv('Expected goals (xG)', 1),
                    homeXgot: sv('xG on target (xGOT)', 0), awayXgot: sv('xG on target (xGOT)', 1),
                    // Non-penalty xG = FotMob's match xG minus the xG of that side's penalties.
                    homeNonPenaltyXg: npxg(sv('Expected goals (xG)', 0), shots, (s) => s.teamId === homeId),
                    awayNonPenaltyXg: npxg(sv('Expected goals (xG)', 1), shots, (s) => s.teamId !== homeId),
                    homePossessionPct: sv('Ball possession', 0), awayPossessionPct: sv('Ball possession', 1),
                    homeShots: sv('Total shots', 0), awayShots: sv('Total shots', 1),
                    homeShotsOnTarget: sv('Shots on target', 0), awayShotsOnTarget: sv('Shots on target', 1),
                    homeBigChances: sv('Big chances', 0), awayBigChances: sv('Big chances', 1),
                    homeCorners: sv('Corners', 0), awayCorners: sv('Corners', 1),
                    stats: d ? stats : null,
                    url: `https://www.fotmob.com${m.pageUrl}`,
                };
                if (includeShots) {
                    row.shots = shots.map((s) => ({ minute: s.min, team: s.teamId === homeId ? 'home' : 'away', player: s.playerName, result: s.eventType, xg: r2(s.expectedGoals), xgot: r2(s.expectedGoalsOnTarget), situation: s.situation, shotType: s.shotType, x: s.x, y: r2(s.y), isOwnGoal: s.isOwnGoal }));
                }
                if (!(await push(row))) break;
            }
            if (pushed >= cap) break;
        }
    }
}

if (!pushed) await Actor.pushData({ note: 'No rows found. Check the league names and season (e.g. 2025/2026, or 2026 for MLS and Brazil). Not charged.' });
await Actor.setValue('SUMMARY', { mode, leagues: leagueIds, season: season || 'current', returned: pushed });
log.info(`Done. ${pushed} rows.`);
await Actor.exit();
