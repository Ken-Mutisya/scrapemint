// Sports Scores, Fixtures & Standings Scraper
//
// Strategy
// --------
// ESPN's public site JSON feeds (site.api.espn.com), keyless, verified
// reachable from Apify DC IPs. Two shapes:
//   scores    -> /apis/site/v2/sports/{sport}/{league}/scoreboard[?dates=YYYYMMDD]
//                one row per game; no date = the league's current slate.
//   standings -> /apis/v2/sports/{sport}/{league}/standings
//                one row per team, grouped (conferences/divisions kept).
// Friendly league aliases (epl, nba, mlb...) map to ESPN sport/league paths;
// anything else is passed through as "sport/league".
//
// Pay per event
// -------------
//   game_row per game or standings row. Unknown leagues and days with no
//   games produce free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://site.api.espn.com/apis';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const MAX_RANGE_DAYS = 31;
const POOL_SIZE = 4;
const FETCH_TIMEOUT_MS = 30000;

const ALIASES = {
    epl: 'soccer/eng.1',
    premierleague: 'soccer/eng.1',
    championship: 'soccer/eng.2',
    laliga: 'soccer/esp.1',
    seriea: 'soccer/ita.1',
    bundesliga: 'soccer/ger.1',
    ligue1: 'soccer/fra.1',
    eredivisie: 'soccer/ned.1',
    ucl: 'soccer/uefa.champions',
    championsleague: 'soccer/uefa.champions',
    uel: 'soccer/uefa.europa',
    europaleague: 'soccer/uefa.europa',
    mls: 'soccer/usa.1',
    nba: 'basketball/nba',
    wnba: 'basketball/wnba',
    ncaab: 'basketball/mens-college-basketball',
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    mlb: 'baseball/mlb',
    nhl: 'hockey/nhl',
};

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { leagues = [], dataType = 'scores', startDate = '', endDate = '', maxRows = 500 } = input;

function parseLeague(raw) {
    const clean = String(raw || '').trim().toLowerCase().replace(/[\s_-]/g, '');
    if (ALIASES[clean]) return { raw, path: ALIASES[clean] };
    const m = String(raw || '').trim().toLowerCase().match(/^([a-z-]+)\/([a-z0-9.-]+)$/);
    if (m) return { raw, path: `${m[1]}/${m[2]}` };
    return { raw, error: 'unknown league: use a common name (epl, nba, mlb...) or an ESPN sport/league path like soccer/bra.1' };
}

const seen = new Set();
const leagueJobs = [];
const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map((s) => String(s || '').trim()).filter(Boolean);
for (const raw of asTokens(leagues)) {
    const parsed = parseLeague(raw);
    const key = parsed.path || `raw:${parsed.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leagueJobs.push(parsed);
}
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

if (leagueJobs.length === 0) {
    log.warning('No leagues given. Try epl, nba or mlb.');
    await Actor.exit();
}

const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
function dateList() {
    const start = isoDate(String(startDate).trim());
    if (!start) return [null]; // current slate
    const end = isoDate(String(endDate).trim()) || start;
    const out = [];
    const d = new Date(`${start}T00:00:00Z`);
    const stop = new Date(`${end}T00:00:00Z`);
    while (d <= stop && out.length < MAX_RANGE_DAYS) {
        out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    if (out.length === 0) log.warning(`From date ${start} is after to date ${end}; nothing to fetch.`);
    return out;
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429) throw new Error('rate limited');
            const json = await res.json().catch(() => null);
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 2000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
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
            await Actor.charge({ eventName: 'game_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);

function gameRows(job, json) {
    const leagueName = json?.leagues?.[0]?.name || null;
    const rows = [];
    for (const ev of json?.events || []) {
        const comp = ev.competitions?.[0] || {};
        const home = (comp.competitors || []).find((c) => c.homeAway === 'home');
        const away = (comp.competitors || []).find((c) => c.homeAway === 'away');
        rows.push({
            league: job.raw,
            leagueName,
            gameId: ev.id,
            name: ev.name || ev.shortName || null,
            date: ev.date || null,
            status: ev.status?.type?.description || null,
            completed: Boolean(ev.status?.type?.completed),
            clock: ev.status?.type?.state === 'in' ? (ev.status?.displayClock || null) : null,
            homeTeam: home?.team?.displayName || null,
            homeAbbrev: home?.team?.abbreviation || null,
            homeScore: num(home?.score),
            awayTeam: away?.team?.displayName || null,
            awayAbbrev: away?.team?.abbreviation || null,
            awayScore: num(away?.score),
            winner: home?.winner ? home?.team?.displayName : (away?.winner ? away?.team?.displayName : null),
            venue: comp.venue?.fullName || null,
            city: comp.venue?.address?.city || null,
        });
    }
    return rows;
}

function standingsRows(job, json) {
    const rows = [];
    for (const group of json?.children || []) {
        for (const entry of group?.standings?.entries || []) {
            const stats = {};
            let rank = null;
            for (const s of entry.stats || []) {
                const key = s.name || s.abbreviation;
                if (!key) continue;
                stats[key] = s.value ?? s.displayValue ?? null;
                if (s.name === 'rank') rank = s.value ?? null;
            }
            rows.push({
                league: job.raw,
                leagueName: json?.name || null,
                group: group.name || null,
                rank,
                team: entry.team?.displayName || null,
                abbreviation: entry.team?.abbreviation || null,
                gamesPlayed: stats.gamesPlayed ?? null,
                wins: stats.wins ?? null,
                losses: stats.losses ?? null,
                ties: stats.ties ?? null,
                points: stats.points ?? null,
                stats,
            });
        }
    }
    return rows;
}

// One task per league (standings) or per league-day (scores).
const tasks = [];
const dates = dataType === 'standings' ? [null] : dateList();
for (const job of leagueJobs) {
    if (job.error) {
        tasks.push({ job, noteOnly: true });
        continue;
    }
    for (const d of dates) tasks.push({ job, date: d });
}

const seenGames = new Set();
let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const { job, date, noteOnly } = tasks[i];

        if (noteOnly) {
            await flushRow({ league: job.raw, note: job.error }, false);
            continue;
        }

        const url = dataType === 'standings'
            ? `${BASE}/v2/sports/${job.path}/standings`
            : `${BASE}/site/v2/sports/${job.path}/scoreboard${date ? `?dates=${date}` : ''}`;
        const { status, json, error } = await fetchJson(url);
        const label = `${job.raw}${date ? ` ${date}` : ''}`;

        if (status !== 200 || !json) {
            await flushRow({ league: job.raw, note: `could not fetch (${error || `HTTP ${status}`}); check the league id` }, false);
            log.warning(`${label}: HTTP ${status} ${error || ''}`);
            continue;
        }

        const rows = dataType === 'standings' ? standingsRows(job, json) : gameRows(job, json);
        let pushed = 0;
        for (const row of rows) {
            if (rowsPushed >= cap) { stopped = true; break; }
            if (row.gameId) {
                const key = `${job.path}:${row.gameId}`;
                if (seenGames.has(key)) continue;
                seenGames.add(key);
            }
            await flushRow(row, true);
            pushed += 1;
        }
        if (rows.length === 0 && dataType === 'scores') {
            await flushRow({ league: job.raw, date: date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : null, note: 'no games on this day' }, false);
        }
        log.info(`${label}: ${pushed} row(s).`);
        await sleep(100);
    }
}

log.info(`Mode: ${dataType}; ${leagueJobs.length} league(s), ${dates[0] === null ? 'current slate' : `${dates.length} day(s)`}, max ${cap} rows.`);
await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tasks.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; unknown leagues and empty days are free).`);
await Actor.exit();
