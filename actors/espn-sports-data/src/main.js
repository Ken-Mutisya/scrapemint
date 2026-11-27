// ESPN Sports Data: scores, standings, injuries, rosters, news and teams
//
// Strategy
// --------
// ESPN's public site JSON (site.api.espn.com), no key, reachable from Apify
// datacenter IPs (verified 2026-11-27):
//   scores    /apis/site/v2/sports/{path}/scoreboard?dates=YYYYMMDD  (one call per day;
//             ESPN rejects ?dates=A-B ranges on some leagues with a 400)
//   standings /apis/v2/sports/{path}/standings
//   injuries  /apis/site/v2/sports/{path}/injuries
//   teams     /apis/site/v2/sports/{path}/teams
//   rosters   /apis/site/v2/sports/{path}/teams/{id}/roster  (one call per team)
//   news      /apis/site/v2/sports/{path}/news?limit=N
// Friendly league names map to ESPN sport/league paths; anything else is
// passed through as "sport/league" (e.g. soccer/bra.1).
//
// Pay per event
// -------------
//   row ($0.0015) one game, standings, injury, roster, news or team row.
//   The first row of every run is free. Notes (unknown league, empty day,
//   off-season) are free.

import { Actor, log } from 'apify';

const BASE = 'https://site.api.espn.com/apis';
// A custom bot User-Agent gets a hard 403 from site.api.espn.com.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 1;
const MAX_DAYS = 31;

const LEAGUES = {
    nfl: 'football/nfl', ncaaf: 'football/college-football', 'college football': 'football/college-football', cfb: 'football/college-football',
    nba: 'basketball/nba', wnba: 'basketball/wnba', ncaab: 'basketball/mens-college-basketball', 'college basketball': 'basketball/mens-college-basketball',
    ncaaw: 'basketball/womens-college-basketball', mlb: 'baseball/mlb', nhl: 'hockey/nhl',
    epl: 'soccer/eng.1', 'premier league': 'soccer/eng.1', championship: 'soccer/eng.2', laliga: 'soccer/esp.1', 'la liga': 'soccer/esp.1',
    'serie a': 'soccer/ita.1', bundesliga: 'soccer/ger.1', 'ligue 1': 'soccer/fra.1', eredivisie: 'soccer/ned.1', mls: 'soccer/usa.1',
    'liga mx': 'soccer/mex.1', ucl: 'soccer/uefa.champions', 'champions league': 'soccer/uefa.champions', uel: 'soccer/uefa.europa',
    'europa league': 'soccer/uefa.europa', ufc: 'mma/ufc', pga: 'golf/pga', f1: 'racing/f1', nascar: 'racing/nascar-premier',
    atp: 'tennis/atp', wta: 'tennis/wta',
};
const TYPES = ['scores', 'standings', 'injuries', 'rosters', 'news', 'teams'];

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    leagues = ['nfl'],
    dataTypes = ['scores'],
    startDate = '',
    endDate = '',
    teams = [],
    newsLimit = 25,
    maxRows = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Math.min(50000, Number(maxRows) || 1000));
const teamFilter = list(teams).map(norm);
const wanted = list(dataTypes).map((t) => norm(t)).filter((t) => TYPES.includes(t));
if (!wanted.length) wanted.push('scores');

const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const outOfTime = () => timeoutAt && Date.now() > timeoutAt - 30_000;

let pushed = 0;
let charged = 0;
let billable = 0;
let stop = false;
const counts = {};

async function emit(row) {
    if (pushed >= cap) { stop = true; return; }
    await Actor.pushData({ ...row, source: 'ESPN', scrapedAt: new Date().toISOString() });
    pushed += 1;
    billable += 1;
    counts[row.dataType] = (counts[row.dataType] || 0) + 1;
    if (billable > FREE_TIER_ROWS) {
        try {
            const r = await Actor.charge({ eventName: 'row' });
            charged += 1;
            if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
async function note(league, dataType, text) {
    await Actor.pushData({ dataType: 'note', league, requested: dataType, note: `${text} Not charged.` });
    log.info(`${league} ${dataType}: ${text}`);
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            if (res.status === 404 || res.status === 400) return { status: res.status, json: null };
            if (res.ok) return { status: 200, json: await res.json() };
            log.warning(`HTTP ${res.status} ${url.slice(0, 110)} (attempt ${attempt})`);
        } catch (err) { log.warning(`${err.message} ${url.slice(0, 110)} (attempt ${attempt})`); }
        await sleep(1500 * attempt);
    }
    return { status: 0, json: null };
}

function resolveLeague(raw) {
    const k = norm(raw);
    if (LEAGUES[k]) return LEAGUES[k];
    if (LEAGUES[k.replace(/ /g, '')]) return LEAGUES[k.replace(/ /g, '')];
    if (/^[a-z-]+\/[a-z0-9.-]+$/.test(k)) return k;
    return null;
}
const teamMatch = (...names) => !teamFilter.length || names.some((n) => n && teamFilter.some((t) => norm(n) === t || norm(n).includes(t)));

function days() {
    const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s).trim()) ? String(s).trim() : null);
    const s = iso(startDate);
    if (!s) return [null];
    const e = iso(endDate) || s;
    const out = [];
    const d = new Date(`${s}T00:00:00Z`);
    const end = new Date(`${e}T00:00:00Z`);
    while (d <= end && out.length < MAX_DAYS) { out.push(d.toISOString().slice(0, 10).replace(/-/g, '')); d.setUTCDate(d.getUTCDate() + 1); }
    if (d <= end) log.warning(`Date range capped at ${MAX_DAYS} days.`);
    return out.length ? out : [null];
}

// ---------- scores ----------
async function scores(league, path) {
    const seen = new Set();
    for (const day of days()) {
        if (stop || outOfTime()) return;
        const { json } = await getJson(`${BASE}/site/v2/sports/${path}/scoreboard${day ? `?dates=${day}` : ''}`);
        const events = json?.events ?? [];
        if (!events.length) { await note(league, 'scores', `no games ${day ? `on ${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}` : 'on the current slate'}.`); continue; }
        for (const ev of events) {
            if (stop) return;
            if (seen.has(ev.id)) continue;
            seen.add(ev.id);
            const comp = ev.competitions?.[0] ?? {};
            const cs = comp.competitors ?? [];
            const home = cs.find((c) => c.homeAway === 'home') ?? cs[0];
            const away = cs.find((c) => c.homeAway === 'away') ?? cs[1];
            const name = (c) => c?.team?.displayName ?? c?.athlete?.displayName ?? null;
            if (!teamMatch(name(home), name(away), home?.team?.abbreviation, away?.team?.abbreviation)) continue;
            const odds = comp.odds?.[0];
            await emit({
                dataType: 'game',
                league,
                gameId: ev.id,
                name: ev.name ?? ev.shortName ?? null,
                startTime: ev.date ?? null,
                status: ev.status?.type?.description ?? null,
                state: ev.status?.type?.state ?? null,
                completed: Boolean(ev.status?.type?.completed),
                clock: ev.status?.type?.state === 'in' ? (ev.status?.displayClock ?? null) : null,
                period: ev.status?.period ?? null,
                homeTeam: name(home), homeAbbrev: home?.team?.abbreviation ?? null, homeScore: num(home?.score),
                homeRecord: home?.records?.[0]?.summary ?? null,
                awayTeam: name(away), awayAbbrev: away?.team?.abbreviation ?? null, awayScore: num(away?.score),
                awayRecord: away?.records?.[0]?.summary ?? null,
                winner: home?.winner ? name(home) : (away?.winner ? name(away) : null),
                bettingLine: odds ? {
                    provider: odds.provider?.name ?? null,
                    spread: odds.details ?? null,
                    overUnder: num(odds.overUnder),
                    homeMoneyline: num(odds.homeTeamOdds?.moneyLine ?? odds.moneyline?.home?.close?.odds),
                    awayMoneyline: num(odds.awayTeamOdds?.moneyLine ?? odds.moneyline?.away?.close?.odds),
                } : null,
                venue: comp.venue?.fullName ?? null,
                city: comp.venue?.address?.city ?? null,
                broadcast: (comp.broadcasts ?? []).flatMap((b) => b.names ?? []).join(', ') || null,
                url: ev.links?.find((l) => (l.rel ?? []).includes('summary'))?.href ?? null,
            });
        }
        await sleep(150);
    }
}

// ---------- standings ----------
async function standings(league, path) {
    const { json } = await getJson(`${BASE}/v2/sports/${path}/standings`);
    const groups = [];
    const walk = (node, label) => {
        if (node?.standings?.entries) groups.push({ name: node.name ?? label ?? null, entries: node.standings.entries });
        for (const c of node?.children ?? []) walk(c, c.name);
    };
    walk(json, json?.name);
    if (!groups.length) { await note(league, 'standings', 'ESPN publishes no standings for this league right now.'); return; }
    for (const g of groups) {
        for (const e of g.entries) {
            if (stop) return;
            const st = {};
            for (const s of e.stats ?? []) { const k = s.name ?? s.abbreviation; if (k) st[k] = s.value ?? s.displayValue ?? null; }
            if (!teamMatch(e.team?.displayName, e.team?.abbreviation)) continue;
            await emit({
                dataType: 'standing',
                league,
                group: g.name,
                team: e.team?.displayName ?? null,
                abbreviation: e.team?.abbreviation ?? null,
                rank: num(st.rank ?? st.playoffSeed),
                gamesPlayed: num(st.gamesPlayed),
                wins: num(st.wins),
                losses: num(st.losses),
                ties: num(st.ties),
                winPercent: num(st.winPercent),
                gamesBehind: num(st.gamesBehind),
                points: num(st.points),
                pointsFor: num(st.pointsFor),
                pointsAgainst: num(st.pointsAgainst),
                pointDifferential: num(st.pointDifferential ?? st.differential),
                streak: st.streak ?? null,
                stats: st,
            });
        }
    }
}

// ---------- injuries ----------
async function injuries(league, path) {
    const { json } = await getJson(`${BASE}/site/v2/sports/${path}/injuries`);
    const blocks = json?.injuries ?? [];
    if (!blocks.reduce((a, b) => a + (b.injuries?.length ?? 0), 0)) { await note(league, 'injuries', 'ESPN publishes no injury report right now (off-season or not posted).'); return; }
    for (const b of blocks) {
        for (const e of b.injuries ?? []) {
            if (stop) return;
            const a = e.athlete ?? {};
            const team = b.displayName ?? a.team?.displayName ?? null;
            if (!teamMatch(team, a.team?.abbreviation)) continue;
            const link = (a.links ?? []).map((l) => l.href).find((h) => /\/id\/\d+/.test(String(h ?? ''))) ?? null;
            await emit({
                dataType: 'injury',
                league,
                team,
                teamAbbrev: a.team?.abbreviation ?? null,
                player: a.displayName ?? null,
                playerId: link?.match(/\/id\/(\d+)/)?.[1] ?? null,
                position: a.position?.abbreviation ?? null,
                status: e.status ?? null,
                injuryType: e.details?.type ?? e.type?.description ?? null,
                bodyPart: e.details?.location ?? null,
                side: e.details?.side ?? null,
                expectedReturn: e.details?.returnDate ?? null,
                reportedDate: e.date ?? null,
                comment: e.shortComment ?? null,
                playerUrl: link,
            });
        }
    }
}

// ---------- teams / rosters ----------
async function teamList(path) {
    const { json } = await getJson(`${BASE}/site/v2/sports/${path}/teams`);
    return (json?.sports?.[0]?.leagues?.[0]?.teams ?? []).map((t) => t.team).filter(Boolean);
}
async function teamsRows(league, path) {
    const ts = await teamList(path);
    if (!ts.length) { await note(league, 'teams', 'no team list for this league.'); return; }
    for (const t of ts) {
        if (stop) return;
        if (!teamMatch(t.displayName, t.abbreviation, t.name, t.location)) continue;
        await emit({
            dataType: 'team', league, teamId: t.id, team: t.displayName, abbreviation: t.abbreviation, location: t.location ?? null,
            nickname: t.name ?? null, color: t.color ? `#${t.color}` : null, logo: t.logos?.[0]?.href ?? null,
            url: t.links?.find((l) => (l.rel ?? []).includes('clubhouse'))?.href ?? null,
        });
    }
}
async function rosters(league, path) {
    const ts = (await teamList(path)).filter((t) => teamMatch(t.displayName, t.abbreviation, t.name, t.location));
    if (!ts.length) { await note(league, 'rosters', 'no teams matched.'); return; }
    for (const t of ts) {
        if (stop || outOfTime()) return;
        const { json } = await getJson(`${BASE}/site/v2/sports/${path}/teams/${t.id}/roster`);
        const raw = json?.athletes ?? [];
        // NFL/NHL group players by unit ({position, items}); NBA/MLB return a flat list.
        const players = raw.flatMap((x) => (Array.isArray(x.items) ? x.items.map((p) => ({ ...p, unit: x.position ?? null })) : [x]));
        for (const p of players) {
            if (stop) return;
            await emit({
                dataType: 'player', league, team: t.displayName, teamAbbrev: t.abbreviation, playerId: p.id ?? null,
                player: p.displayName ?? p.fullName ?? null, jersey: p.jersey ?? null,
                position: p.position?.abbreviation ?? null, unit: p.unit, age: num(p.age),
                height: p.displayHeight ?? null, weight: p.displayWeight ?? null, dateOfBirth: p.dateOfBirth ?? null,
                birthPlace: [p.birthPlace?.city, p.birthPlace?.state, p.birthPlace?.country].filter(Boolean).join(', ') || null,
                college: p.college?.name ?? null, experienceYears: num(p.experience?.years),
                status: p.status?.name ?? null, injured: Boolean(p.injuries?.length),
                headshot: p.headshot?.href ?? null,
            });
        }
        await sleep(150);
    }
}

// ---------- news ----------
async function news(league, path) {
    const limit = Math.max(1, Math.min(100, Number(newsLimit) || 25));
    const { json } = await getJson(`${BASE}/site/v2/sports/${path}/news?limit=${limit}`);
    const arts = json?.articles ?? [];
    if (!arts.length) { await note(league, 'news', 'no news articles returned.'); return; }
    for (const a of arts) {
        if (stop) return;
        const cats = a.categories ?? [];
        const teamsIn = cats.filter((c) => c.type === 'team').map((c) => c.description).filter(Boolean);
        const athletesIn = cats.filter((c) => c.type === 'athlete').map((c) => c.description).filter(Boolean);
        if (teamFilter.length && !teamMatch(...teamsIn)) continue;
        await emit({
            dataType: 'news', league, articleId: a.id ?? null, headline: a.headline ?? null, description: a.description ?? null,
            published: a.published ?? null, byline: a.byline ?? null, type: a.type ?? null, premium: Boolean(a.premium),
            teams: teamsIn, athletes: athletesIn, image: a.images?.[0]?.url ?? null, url: a.links?.web?.href ?? null,
        });
    }
}

const RUN = { scores, standings, injuries, rosters, news, teams: teamsRows };
const jobs = list(leagues);
if (!jobs.length) jobs.push('nfl');
log.info(`Leagues: ${jobs.join(', ')} | data: ${wanted.join(', ')} | max ${cap} rows`);
for (const raw of jobs) {
    const path = resolveLeague(raw);
    if (!path) { await note(raw, 'any', 'unknown league. Use a name like nfl, nba, mlb, nhl, epl, ncaaf, or an ESPN path like soccer/bra.1.'); continue; }
    for (const t of wanted) {
        if (stop || outOfTime()) break;
        await RUN[t](raw, path);
    }
}
if (outOfTime()) log.warning('Stopped early to stay inside the run timeout; rows returned were charged.');
await Actor.setValue('SUMMARY', { leagues: jobs, dataTypes: wanted, rows: pushed, byType: counts, charged });
log.info(`Done. ${pushed} row(s) ${JSON.stringify(counts)}; ${charged} charged (first ${FREE_TIER_ROWS} free, notes free).`);
await Actor.exit();
