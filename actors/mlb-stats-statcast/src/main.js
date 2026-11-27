// MLB Stats & Statcast: season stats, exit velocity, barrels, xBA, xwOBA
//
// Strategy
// --------
// Two official MLB sources, no key, reachable from Apify datacenter IPs
// (verified 2026-11-27):
//   statsapi.mlb.com/api/v1/stats?stats=season&group=hitting|pitching   season stats
//   statsapi.mlb.com/api/v1/people/search, /people/{id}?hydrate=stats  player lookup
//   statsapi.mlb.com/api/v1/schedule?hydrate=probablePitcher,linescore games
//   baseballsavant.mlb.com/leaderboard/statcast?csv=true               exit velocity, barrels
//   baseballsavant.mlb.com/leaderboard/expected_statistics?csv=true    xBA, xSLG, xwOBA, xERA
// Statcast rows are joined onto season stats by MLBAM player id.
//
// Pay per event
// -------------
//   row ($0.002) one player (season stats + Statcast) or one game.
//   The first row of every run is free. Notes are free.

import { Actor, log } from 'apify';

const API = 'https://statsapi.mlb.com/api/v1';
const SAVANT = 'https://baseballsavant.mlb.com/leaderboard';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 1;
const now = new Date();
const DEFAULT_SEASON = now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    mode = 'season-stats',
    group = 'hitting',
    season = DEFAULT_SEASON,
    qualifiedOnly = true,
    includeStatcast = true,
    teams = [],
    players = [],
    startDate = '',
    endDate = '',
    maxRows = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v === null || v === undefined || v === '' || v === '.---' || v === '-.--') return null; const x = Number(String(v).replace(/^\./, '0.')); return Number.isFinite(x) ? x : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 1000));
const yr = Number(season) || DEFAULT_SEASON;
const groups = String(group).toLowerCase() === 'both' ? ['hitting', 'pitching'] : [String(group).toLowerCase() === 'pitching' ? 'pitching' : 'hitting'];

async function get(url, as = 'json') {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/csv' }, signal: AbortSignal.timeout(60_000) });
            if (res.status === 404) return null;
            if (res.ok) return as === 'json' ? await res.json() : await res.text();
            log.warning(`HTTP ${res.status} ${url.slice(0, 120)} (attempt ${attempt})`);
        } catch (err) { log.warning(`${err.message} (attempt ${attempt})`); }
        await sleep(1500 * attempt);
    }
    return null;
}

function parseCsv(text) {
    const rows = [];
    let row = []; let field = ''; let q = false;
    const s = String(text ?? '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
        if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.length > 1);
    return (body ?? []).map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i]])));
}

let pushed = 0;
let billable = 0;
let stop = false;
async function emit(row) {
    if (pushed >= cap) { stop = true; return; }
    await Actor.pushData({ ...row, source: 'MLB Stats API + Baseball Savant', scrapedAt: new Date().toISOString() });
    pushed += 1;
    billable += 1;
    if (billable > FREE_TIER_ROWS) {
        try {
            const r = await Actor.charge({ eventName: 'row' });
            if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
async function note(text) { await Actor.pushData({ note: `${text} Not charged.` }); log.info(text); }

// ---------- teams ----------
const teamById = new Map();
const tdata = await get(`${API}/teams?sportId=1&season=${yr}`);
for (const t of tdata?.teams ?? []) teamById.set(t.id, { name: t.name, abbr: t.abbreviation, league: t.league?.name ?? null, division: t.division?.name ?? null });
const teamFilter = list(teams).map(norm);
const teamOk = (id, name) => {
    if (!teamFilter.length) return true;
    const t = teamById.get(id) ?? {};
    return teamFilter.some((f) => [t.name, t.abbr, name].some((v) => v && (norm(v) === f || norm(v).includes(f))));
};

// ---------- Statcast ----------
const statcast = { hitting: new Map(), pitching: new Map() };
async function loadStatcast(g) {
    const type = g === 'pitching' ? 'pitcher' : 'batter';
    // Player lookups need Statcast for anyone named, qualified or not.
    const min = qualifiedOnly && String(mode).toLowerCase() !== 'players' ? 'q' : '1';
    const [ev, xs] = await Promise.all([
        get(`${SAVANT}/statcast?type=${type}&year=${yr}&position=&team=&min=${min}&csv=true`, 'text'),
        get(`${SAVANT}/expected_statistics?type=${type}&year=${yr}&position=&team=&min=${min}&csv=true`, 'text'),
    ]);
    const m = statcast[g];
    for (const r of parseCsv(ev)) {
        m.set(String(r.player_id), {
            ...(m.get(String(r.player_id)) ?? {}),
            battedBallEvents: num(r.attempts), avgExitVelocity: num(r.avg_hit_speed), maxExitVelocity: num(r.max_hit_speed),
            avgLaunchAngle: num(r.avg_hit_angle), sweetSpotPct: num(r.anglesweetspotpercent), hardHitPct: num(r.ev95percent),
            barrels: num(r.barrels), barrelPct: num(r.brl_percent), barrelsPerPa: num(r.brl_pa),
            maxDistance: num(r.max_distance), avgHrDistance: num(r.avg_hr_distance),
        });
    }
    for (const r of parseCsv(xs)) {
        m.set(String(r.player_id), {
            ...(m.get(String(r.player_id)) ?? {}),
            ba: num(r.ba), xba: num(r.est_ba), slg: num(r.slg), xslg: num(r.est_slg), woba: num(r.woba), xwoba: num(r.est_woba),
            // Savant's est_woba_minus_woba_diff is actually wOBA - xwOBA (positive = luckier than contact quality).
            wobaMinusXwoba: num(r.est_woba_minus_woba_diff) !== null ? Math.round(num(r.est_woba_minus_woba_diff) * 1000) / 1000 : null,
            ...(g === 'pitching' ? { era: num(r.era), xera: num(r.xera) } : {}),
        });
    }
    log.info(`Statcast ${type}s ${yr}: ${m.size} player(s).`);
}

function statRow(g, split) {
    const s = split.stat ?? {};
    const teamId = split.team?.id;
    const t = teamById.get(teamId) ?? {};
    const base = {
        dataType: g === 'pitching' ? 'pitcher' : 'hitter',
        season: yr, playerId: split.player?.id ?? null, player: split.player?.fullName ?? null,
        team: split.team?.name ?? t.name ?? null, teamAbbrev: t.abbr ?? null, league: t.league ?? null,
        position: split.position?.abbreviation ?? null, age: num(s.age), rank: num(split.rank),
    };
    const stats = g === 'pitching' ? {
        games: num(s.gamesPlayed), gamesStarted: num(s.gamesStarted), wins: num(s.wins), losses: num(s.losses), saves: num(s.saves),
        holds: num(s.holds), inningsPitched: num(s.inningsPitched), era: num(s.era), whip: num(s.whip), strikeOuts: num(s.strikeOuts),
        walks: num(s.baseOnBalls), hitsAllowed: num(s.hits), homeRunsAllowed: num(s.homeRuns), strikeoutsPer9: num(s.strikeoutsPer9Inn),
        walksPer9: num(s.walksPer9Inn), opponentAvg: num(s.avg), strikePct: num(s.strikePercentage),
    } : {
        games: num(s.gamesPlayed), plateAppearances: num(s.plateAppearances), atBats: num(s.atBats), hits: num(s.hits),
        doubles: num(s.doubles), triples: num(s.triples), homeRuns: num(s.homeRuns), runs: num(s.runs), rbi: num(s.rbi),
        walks: num(s.baseOnBalls), strikeOuts: num(s.strikeOuts), stolenBases: num(s.stolenBases), avg: num(s.avg),
        obp: num(s.obp), slg: num(s.slg), ops: num(s.ops), babip: num(s.babip), totalBases: num(s.totalBases),
    };
    const sc = includeStatcast ? (statcast[g].get(String(base.playerId)) ?? null) : undefined;
    return { ...base, ...stats, ...(includeStatcast ? { statcast: sc } : {}) };
}

async function seasonStats() {
    for (const g of groups) {
        if (stop) return;
        if (includeStatcast) await loadStatcast(g);
        const pool = qualifiedOnly ? 'qualified' : 'all';
        const sort = g === 'pitching' ? 'strikeOuts' : 'homeRuns';
        const d = await get(`${API}/stats?stats=season&group=${g}&season=${yr}&sportId=1&playerPool=${pool}&limit=3000&sortStat=${sort}&order=desc`);
        const splits = d?.stats?.[0]?.splits ?? [];
        if (!splits.length) { await note(`no ${g} stats for ${yr} yet.`); continue; }
        let n = 0;
        for (const sp of splits) {
            if (stop) return;
            if (!teamOk(sp.team?.id, sp.team?.name)) continue;
            await emit(statRow(g, sp));
            n += 1;
        }
        log.info(`${g} ${yr}: ${n} player(s) (${pool}).`);
    }
}

async function playerLookup() {
    const names = list(players);
    if (!names.length) { await note('player mode needs at least one player name or MLBAM id.'); return; }
    if (includeStatcast) { await loadStatcast('hitting'); await loadStatcast('pitching'); }
    for (const p of names) {
        if (stop) return;
        let id = /^\d+$/.test(p) ? p : null;
        if (!id) {
            const s = await get(`${API}/people/search?names=${encodeURIComponent(p)}&sportIds=1`);
            id = s?.people?.find((x) => x.active)?.id ?? s?.people?.[0]?.id ?? null;
        }
        if (!id) { await note(`no MLB player found for "${p}".`); continue; }
        const d = await get(`${API}/people/${id}?hydrate=currentTeam,stats(group=[hitting,pitching],type=[season,career],season=${yr})`);
        const person = d?.people?.[0];
        if (!person) { await note(`could not read player ${id}.`); continue; }
        const stats = {};
        for (const blk of person.stats ?? []) {
            const g = blk.group?.displayName; const t = blk.type?.displayName;
            const sp = blk.splits?.[blk.splits.length - 1];
            if (g && t && sp) stats[`${t}_${g}`] = sp.stat;
        }
        const isPitcher = person.primaryPosition?.abbreviation === 'P';
        const g = isPitcher ? 'pitching' : 'hitting';
        const seasonSplit = { stat: stats[`season_${g}`] ?? {}, player: { id: person.id, fullName: person.fullName }, team: person.currentTeam ?? {}, position: person.primaryPosition };
        await emit({
            ...statRow(g, seasonSplit),
            dataType: 'player',
            bats: person.batSide?.code ?? null, throws: person.pitchHand?.code ?? null, height: person.height ?? null, weight: num(person.weight),
            birthDate: person.birthDate ?? null, birthCountry: person.birthCountry ?? null, mlbDebutDate: person.mlbDebutDate ?? null,
            career: stats[`career_${g}`] ?? null,
            ...(stats['season_hitting'] && isPitcher ? { seasonHitting: stats['season_hitting'] } : {}),
        });
        await sleep(150);
    }
}

async function games() {
    const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim()) ? String(s).trim() : null);
    const s = iso(startDate) ?? new Date().toISOString().slice(0, 10);
    const e = iso(endDate) ?? s;
    const d = await get(`${API}/schedule?sportId=1&startDate=${s}&endDate=${e}&hydrate=probablePitcher,linescore,team,venue`);
    const all = (d?.dates ?? []).flatMap((x) => x.games ?? []);
    if (!all.length) { await note(`no MLB games between ${s} and ${e} (off-season runs late October to late March).`); return; }
    for (const g of all) {
        if (stop) return;
        const h = g.teams?.home ?? {}; const a = g.teams?.away ?? {};
        if (!teamOk(h.team?.id, h.team?.name) && !teamOk(a.team?.id, a.team?.name)) continue;
        await emit({
            dataType: 'game', gamePk: g.gamePk, date: g.officialDate ?? null, startTime: g.gameDate ?? null, gameType: g.gameType ?? null,
            series: g.seriesDescription ?? null, status: g.status?.detailedState ?? null,
            homeTeam: h.team?.name ?? null, awayTeam: a.team?.name ?? null, homeScore: num(h.score), awayScore: num(a.score),
            winner: h.isWinner ? h.team?.name : (a.isWinner ? a.team?.name : null),
            homeRecord: h.leagueRecord ? `${h.leagueRecord.wins}-${h.leagueRecord.losses}` : null,
            awayRecord: a.leagueRecord ? `${a.leagueRecord.wins}-${a.leagueRecord.losses}` : null,
            homeProbablePitcher: h.probablePitcher?.fullName ?? null, awayProbablePitcher: a.probablePitcher?.fullName ?? null,
            innings: num(g.linescore?.currentInning), venue: g.venue?.name ?? null, dayNight: g.dayNight ?? null,
        });
    }
}

const m = String(mode).toLowerCase();
log.info(`Mode ${m} | season ${yr} | ${groups.join('+')}${teamFilter.length ? ` | teams ${teamFilter.join(', ')}` : ''}`);
if (m === 'players') await playerLookup();
else if (m === 'games') await games();
else await seasonStats();
await Actor.setValue('SUMMARY', { mode: m, season: yr, rows: pushed });
log.info(`Done. ${pushed} row(s); first ${FREE_TIER_ROWS} free, notes free.`);
await Actor.exit();
