// Sports Player Stats & Rosters Scraper
//
// Strategy
// --------
// ESPN public JSON feeds, keyless (same source family as
// sports-scores-scraper, proven DC-safe):
//   rosters -> site.api.espn.com/apis/site/v2/sports/{path}/teams (team
//              resolution, cached per league) then /teams/{id}/roster.
//              NBA-style responses list athletes flat; NFL-style group
//              them by position with items[] — both normalized.
//   stats   -> site.web.api.espn.com/apis/search/v2?query= finds the
//              player (uid "s:40~l:46~a:1966" carries the athlete id, the
//              web link carries the league slug), then
//              /apis/common/v3/sports/{path}/athletes/{id}/stats returns
//              per-season rows whose stats[] align positionally with the
//              category's names[] array — zipped into a named object.
// Career stats cover the US leagues (NBA/WNBA/NFL/MLB/NHL/college);
// soccer players get a free note pointing at roster mode.
//
// Pay per event
// -------------
//   player_row per roster or season row. Unknown leagues/teams/players
//   are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 200;

const ALIASES = {
    epl: 'soccer/eng.1', premierleague: 'soccer/eng.1', championship: 'soccer/eng.2',
    laliga: 'soccer/esp.1', seriea: 'soccer/ita.1', bundesliga: 'soccer/ger.1',
    ligue1: 'soccer/fra.1', eredivisie: 'soccer/ned.1',
    ucl: 'soccer/uefa.champions', championsleague: 'soccer/uefa.champions',
    uel: 'soccer/uefa.europa', europaleague: 'soccer/uefa.europa', mls: 'soccer/usa.1',
    nba: 'basketball/nba', wnba: 'basketball/wnba',
    ncaab: 'basketball/mens-college-basketball', ncaaw: 'basketball/womens-college-basketball',
    nfl: 'football/nfl', cfb: 'football/college-football', ncaaf: 'football/college-football',
    mlb: 'baseball/mlb', nhl: 'hockey/nhl',
};
// espn.com/{slug}/player/... -> stats API path (US leagues only)
const SLUG_TO_PATH = {
    nba: 'basketball/nba', wnba: 'basketball/wnba', nfl: 'football/nfl',
    mlb: 'baseball/mlb', nhl: 'hockey/nhl',
    'mens-college-basketball': 'basketball/mens-college-basketball',
    'womens-college-basketball': 'basketball/womens-college-basketball',
    'college-football': 'football/college-football',
};

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    teams = [], leagues = [], players = [],
    statType = 'averages', maxSeasonsPerPlayer = 30, maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const teamList = [...new Set(asTokens(teams))];
const leagueList = [...new Set(asTokens(leagues))];
const playerList = [...new Set(asTokens(players))];
const seasonsCap = clampNum(maxSeasonsPerPlayer, 30, 1, 50);
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);
const wantStat = ['averages', 'totals', 'both'].includes(statType) ? statType : 'averages';

if (teamList.length === 0 && leagueList.length === 0 && playerList.length === 0) {
    log.warning('No teams, leagues or players given. Add a team like "nba lakers" or a player like "LeBron James".');
    await Actor.exit();
}

const parseLeague = (raw) => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9./-]/g, '');
    return ALIASES[clean] || (clean.includes('/') ? clean : null);
};

async function apiGet(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'player_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- rosters -----------------------------------------------------------------

const teamsCache = new Map(); // league path -> [{team}]
async function leagueTeams(path) {
    if (teamsCache.has(path)) return teamsCache.get(path);
    const json = await apiGet(`${SITE}/${path}/teams`);
    const list = json?.error ? null : (json?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean);
    teamsCache.set(path, list);
    return list;
}

function normalizeRoster(json) {
    const items = [];
    for (const g of json?.athletes || []) {
        if (Array.isArray(g?.items)) items.push(...g.items.map((a) => ({ ...a, positionGroup: g.position || null })));
        else if (g && g.id) items.push(g);
    }
    return items;
}

function rosterRow(a, leagueInput, team) {
    return {
        type: 'roster_player',
        league: leagueInput,
        team: team.displayName || team.name || null,
        teamAbbreviation: team.abbreviation || null,
        name: a.fullName || a.displayName || null,
        playerId: a.id || null,
        position: a.position?.displayName || a.position?.name || a.positionGroup || null,
        jersey: a.jersey || null,
        age: a.age ?? null,
        dateOfBirth: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null,
        height: a.displayHeight || null,
        weight: a.displayWeight || null,
        experienceYears: a.experience?.years ?? null,
        college: a.college?.name || null,
        birthPlace: [a.birthPlace?.city, a.birthPlace?.state, a.birthPlace?.country].filter(Boolean).join(', ') || null,
        status: a.status?.name || null,
        headshot: a.headshot?.href || null,
    };
}

async function emitTeamRoster(path, leagueInput, team) {
    const json = await apiGet(`${SITE}/${path}/teams/${team.id}/roster`);
    if (json?.error) {
        await flushRow({ type: 'note', input: `${leagueInput} ${team.displayName}`, found: false, note: `could not fetch roster (${json.error}); not charged` }, false);
        return;
    }
    const athletes = normalizeRoster(json);
    if (athletes.length === 0) {
        await flushRow({ type: 'note', input: `${leagueInput} ${team.displayName}`, found: false, note: 'roster is empty (offseason for some leagues); not charged' }, false);
        return;
    }
    for (const a of athletes) {
        if (shouldStop()) break;
        await flushRow(rosterRow(a, leagueInput, team), true);
    }
}

const rosteredTeams = new Set();

for (const raw of teamList) {
    if (shouldStop()) break;
    const [leaguePart, ...rest] = raw.split(/\s+/);
    const query = rest.join(' ').toLowerCase();
    const path = parseLeague(leaguePart);
    if (!path || !query) {
        await flushRow({ type: 'note', input: raw, found: false, note: 'use "league team", e.g. "nba lakers" or "epl arsenal"; not charged' }, false);
        continue;
    }
    const list = await leagueTeams(path);
    if (!list) {
        await flushRow({ type: 'note', input: raw, found: false, note: `unknown league "${leaguePart}"; not charged` }, false);
        continue;
    }
    const team = list.find((t) => (t.abbreviation || '').toLowerCase() === query)
        || list.find((t) => (t.slug || '').toLowerCase() === query.replace(/\s+/g, '-'))
        || list.find((t) => [t.displayName, t.shortDisplayName, t.location, t.name].some((n) => (n || '').toLowerCase().includes(query)));
    if (!team) {
        await flushRow({ type: 'note', input: raw, found: false, note: `no team matching "${query}" in ${leaguePart}; not charged` }, false);
        continue;
    }
    if (rosteredTeams.has(`${path}:${team.id}`)) continue;
    rosteredTeams.add(`${path}:${team.id}`);
    await emitTeamRoster(path, leaguePart, team);
}

for (const raw of leagueList) {
    if (shouldStop()) break;
    const path = parseLeague(raw);
    const list = path ? await leagueTeams(path) : null;
    if (!list || list.length === 0) {
        await flushRow({ type: 'note', input: raw, found: false, note: `unknown league "${raw}" (try nba, nfl, mlb, nhl, epl or an ESPN path like soccer/ken.1); not charged` }, false);
        continue;
    }
    log.info(`Sweeping ${list.length} team rosters in ${raw}...`);
    for (const team of list) {
        if (shouldStop()) break;
        if (rosteredTeams.has(`${path}:${team.id}`)) continue;
        rosteredTeams.add(`${path}:${team.id}`);
        await emitTeamRoster(path, raw, team);
    }
}

// --- player career stats -----------------------------------------------------

async function findPlayer(name) {
    const json = await apiGet(`${WEB}/search/v2?${new URLSearchParams({ query: name, limit: '10' })}`);
    if (json?.error) return { error: json.error };
    const group = (json.results || []).find((r) => r.type === 'player');
    const hit = group?.contents?.[0];
    if (!hit) return { notFound: true };
    const athleteId = (hit.uid || '').match(/~a:(\d+)/)?.[1];
    const slug = (hit.link?.web || '').match(/espn\.com\/([a-z-]+)\/player/)?.[1];
    return { athleteId, slug, displayName: hit.displayName || name };
}

for (const name of playerList) {
    if (shouldStop()) break;
    const found = await findPlayer(name);
    if (found.error || found.notFound || !found.athleteId) {
        await flushRow({ type: 'note', input: name, found: false, note: found.error ? `search failed (${found.error}); not charged, try again later` : 'no player matched this name; not charged' }, false);
        continue;
    }
    const path = SLUG_TO_PATH[found.slug];
    if (!path) {
        await flushRow({ type: 'note', input: name, found: false, note: `found ${found.displayName} (${found.slug}) but career stats are supported for NBA/WNBA/NFL/MLB/NHL/college only — use roster mode for soccer; not charged` }, false);
        continue;
    }
    const json = await apiGet(`${WEB}/common/v3/sports/${path}/athletes/${found.athleteId}/stats`);
    const cats = json?.categories || [];
    let chosen = wantStat === 'both' ? cats : cats.filter((c) => c.name === wantStat);
    if (chosen.length === 0 && cats.length > 0) chosen = [cats[0]];
    if (json?.error || chosen.length === 0) {
        await flushRow({ type: 'note', input: name, found: false, note: json?.error ? `stats fetch failed (${json.error}); not charged` : `no stats published for ${found.displayName}; not charged` }, false);
        continue;
    }
    for (const cat of chosen) {
        const names = cat.names || [];
        const seasons = (cat.statistics || []).slice().reverse().slice(0, seasonsCap); // newest first
        for (const s of seasons) {
            if (shouldStop()) break;
            const stats = {};
            names.forEach((n, i) => { stats[n] = s.stats?.[i] ?? null; });
            await flushRow({
                type: 'season_stats',
                player: found.displayName,
                playerId: found.athleteId,
                league: found.slug,
                statType: cat.name || null,
                season: s.season?.displayName || null,
                team: s.teamSlug || null,
                stats,
            }, true);
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
