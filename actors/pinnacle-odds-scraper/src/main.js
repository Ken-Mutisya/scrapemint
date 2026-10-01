// Pinnacle Odds Scraper: the sharp book's lines for every sport and league,
// with vig-free fair probabilities and the stake Pinnacle will accept.
//
// Strategy
// --------
// Pinnacle's own site reads guest.api.arcadia.pinnacle.com, keyless, and it
// answers Apify datacenter IPs (confirmed 2026-08-10 for sports-odds-scraper,
// again 2026-10-02). Per league, two requests:
//   /0.1/leagues/{id}/matchups         fixtures
//   /0.1/leagues/{id}/markets/straight  every price, joined on matchupId
// /0.1/sports and /0.1/sports/{id}/leagues list what is open right now.
//
// Feed traps (see sports-odds-scraper/src/pinnacle-book.js for the long form):
//  - type "special" matchups are props whose participants are Over/Under;
//    only type "matchup" is a game.
//  - isAlternate marks alternate lines; one NFL game carried 400 markets, 5 main.
//  - prices are American integers; limits[].maxRiskStake is the max a client
//    may risk, a confidence signal no soft book publishes.
//
// Why Pinnacle: low margin and high limits make its vig-free price the
// closest thing to a market consensus. Each outcome carries that fair
// probability (the price with the margin removed proportionally), and each
// market its margin.
//
// Pay per event
// -------------
//   game_odds ($0.004) one game with every main market asked for
// No start fee, no per-run allowance (it is polled). With onlyChanged, a game
// whose prices did not move since the last run is not returned or charged.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';

const HOST = 'https://guest.api.arcadia.pinnacle.com/0.1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const LEAGUE_CONCURRENCY = 4;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    sports = ['Soccer', 'Basketball', 'Football', 'Baseball', 'Hockey'],
    leagues = [],
    hoursAhead = 0,
    liveOnly = false,
    includeLive = true,
    markets = ['moneyline', 'spread', 'total'],
    includeTeamTotals = false,
    includePeriods = false,
    includeAlternateLines = false,
    onlyChanged = false,
    maxGames = 300,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const wantMarkets = new Set(listOf(markets).map((m) => m.toLowerCase()));
if (includeTeamTotals) wantMarkets.add('team_total');
const leagueQ = listOf(leagues).map((l) => l.toLowerCase());
const cap = Math.max(1, Number(maxGames) || 300);
const horizon = Number(hoursAhead) > 0 ? Date.now() + Number(hoursAhead) * 3600_000 : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(`${HOST}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
            if (r.ok) return await r.json();
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 404 || r.status === 401) throw Object.assign(last, { fatal: true });
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
    throw last;
}

// ---------- Odds maths ----------

const toDecimal = (a) => {
    const n = Number(a);
    if (!Number.isFinite(n) || n === 0) return null;
    return +(n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1).toFixed(4);
};

// Implied probability per outcome, the margin (overround - 1), and the fair
// probability with the margin removed proportionally.
function price(outcomes) {
    const implied = outcomes.map((o) => (o.decimal ? 1 / o.decimal : null));
    const total = implied.every((p) => p != null) ? implied.reduce((a, b) => a + b, 0) : null;
    return {
        marginPct: total ? +((total - 1) * 100).toFixed(2) : null,
        outcomes: outcomes.map((o, i) => ({
            ...o,
            impliedProbability: implied[i] != null ? +implied[i].toFixed(4) : null,
            fairProbability: total && implied[i] != null ? +(implied[i] / total).toFixed(4) : null,
            fairDecimal: total && implied[i] ? +(total / implied[i]).toFixed(3) : null,
        })),
    };
}

const PERIOD_NAME = { 0: 'game', 1: '1st half', 2: '2nd half', 3: '1st quarter' };

// ---------- Which leagues ----------

const allSports = await get('/sports');
const sportQ = listOf(sports).map((s) => s.toLowerCase());
const pickSports = allSports.filter((s) => s.matchupCount > 0 && (!sportQ.length || sportQ.includes(String(s.id)) || sportQ.includes(s.name.toLowerCase())));
const unknownSports = sportQ.filter((q) => !allSports.some((s) => String(s.id) === q || s.name.toLowerCase() === q));
for (const u of unknownSports) log.warning(`Sport "${u}" is not on Pinnacle; options: ${allSports.filter((s) => s.matchupCount > 0).map((s) => s.name).join(', ')}.`);

// Some sports' league lists need a logged-in account: Chess, Politics, Snooker
// and Formula 1 answer 401 to the guest API (checked 2026-10-02). One refused
// sport must not end the run for every other sport.
const leagueList = [];
const skippedSports = [];
for (const s of pickSports) {
    let ls;
    try { ls = await get(`/sports/${s.id}/leagues?all=false`); } catch (err) {
        skippedSports.push({ sport: s.name, error: String(err?.message || err) });
        log.warning(`${s.name}: Pinnacle's guest feed does not list its leagues (${err?.message}); skipped.`);
        continue;
    }
    for (const l of ls) {
        if (!l.matchupCount) continue;
        if (leagueQ.length && !leagueQ.some((q) => String(l.id) === q || l.name.toLowerCase().includes(q))) continue;
        leagueList.push({ id: l.id, name: l.name, sport: s.name });
    }
}
if (!leagueList.length) {
    await Actor.pushData({ rowType: 'note', note: `No open Pinnacle leagues matched sports ${JSON.stringify(sports)}${leagueQ.length ? ` and leagues ${JSON.stringify(leagues)}` : ''}. Not charged.` });
    await Actor.exit();
}
log.info(`Reading ${leagueList.length} league(s) across ${pickSports.map((s) => s.name).join(', ')}.`);

// ---------- Only-changed state ----------

const store = onlyChanged ? await Actor.openKeyValueStore('pinnacle-odds-scraper-state') : null;
const stateKey = `LINES_${createHash('sha1').update(JSON.stringify({ sports: sportQ, leagueQ, m: [...wantMarkets].sort(), includePeriods, includeAlternateLines })).digest('hex').slice(0, 12)}`;
const prevLines = store ? ((await store.getValue(stateKey)) || {}) : {};
const nextLines = {};

// ---------- Read ----------

let pushed = 0;
let unchanged = 0;
let stop = false;
const failed = [];

async function readLeague(lg) {
    const [matchups, straight] = await Promise.all([get(`/leagues/${lg.id}/matchups`), get(`/leagues/${lg.id}/markets/straight`)]);
    const games = new Map();
    for (const m of matchups || []) {
        if (m?.type !== 'matchup') continue;
        if (liveOnly && !m.isLive) continue;
        if (!includeLive && m.isLive) continue;
        const start = m.startTime ? Date.parse(m.startTime) : null;
        if (horizon && start && start > horizon) continue;
        const parts = m.participants || [];
        const home = parts.find((p) => p.alignment === 'home')?.name;
        const away = parts.find((p) => p.alignment === 'away')?.name;
        if (!home || !away) continue;
        games.set(m.id, { m, home, away, markets: [] });
    }
    for (const mk of straight || []) {
        const g = games.get(mk?.matchupId);
        if (!g || mk.status !== 'open') continue;
        if (!wantMarkets.has(mk.type)) continue;
        if (!includeAlternateLines && mk.isAlternate) continue;
        if (!includePeriods && Number(mk.period) !== 0) continue;
        const ps = mk.prices || [];
        if (!ps.length || ps.some((p) => !p.designation)) continue;
        const label = (d) => ({ home: g.home, away: g.away, draw: 'Draw', over: 'Over', under: 'Under' }[d] || d);
        const priced = price(ps.map((p) => ({
            outcome: label(p.designation),
            side: p.designation,
            line: p.points ?? null,
            american: p.price ?? null,
            decimal: toDecimal(p.price),
        })));
        g.markets.push({
            market: mk.type,
            period: PERIOD_NAME[mk.period] || `period ${mk.period}`,
            ...(mk.side ? { team: mk.side === 'home' ? g.home : g.away } : {}),
            isAlternate: !!mk.isAlternate,
            maxStake: mk.limits?.find((l) => l.type === 'maxRiskStake')?.amount ?? null,
            marginPct: priced.marginPct,
            outcomes: priced.outcomes,
        });
    }

    const rows = [];
    for (const [id, g] of games) {
        if (!g.markets.length) continue;
        g.markets.sort((a, b) => (a.period === b.period ? a.market.localeCompare(b.market) : a.period === 'game' ? -1 : 1));
        const sig = createHash('sha1').update(JSON.stringify(g.markets.map((x) => [x.market, x.period, x.team, x.outcomes.map((o) => [o.american, o.line])]))).digest('hex').slice(0, 16);
        nextLines[id] = sig;
        if (onlyChanged && prevLines[id] === sig) { unchanged += 1; continue; }
        const main = (t) => g.markets.find((x) => x.market === t && x.period === 'game' && !x.isAlternate && !x.team);
        const ml = main('moneyline');
        rows.push({
            sport: lg.sport,
            league: lg.name,
            leagueId: lg.id,
            gameId: String(id),
            event: `${g.away} @ ${g.home}`,
            homeTeam: g.home,
            awayTeam: g.away,
            startTime: g.m.startTime ? new Date(g.m.startTime).toISOString() : null,
            isLive: g.m.isLive === true,
            // The headline numbers, flat, for spreadsheets; full detail in markets.
            homeWinFair: ml?.outcomes.find((o) => o.side === 'home')?.fairProbability ?? null,
            awayWinFair: ml?.outcomes.find((o) => o.side === 'away')?.fairProbability ?? null,
            drawFair: ml?.outcomes.find((o) => o.side === 'draw')?.fairProbability ?? null,
            spreadHome: main('spread')?.outcomes.find((o) => o.side === 'home')?.line ?? null,
            totalPoints: main('total')?.outcomes[0]?.line ?? null,
            ...(onlyChanged ? { changeType: prevLines[id] ? 'moved' : 'new' } : {}),
            markets: g.markets,
        });
    }
    return rows;
}

let li = 0;
await Promise.all(Array.from({ length: Math.min(LEAGUE_CONCURRENCY, leagueList.length) }, async () => {
    while (li < leagueList.length && !stop) {
        const lg = leagueList[li++];
        let rows;
        try { rows = await readLeague(lg); } catch (err) {
            failed.push({ league: lg.name, error: String(err?.message || err) });
            log.warning(`${lg.name}: ${err?.message}`);
            continue;
        }
        for (const row of rows) {
            if (pushed >= cap) { stop = true; break; }
            pushed += 1;
            await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
            try {
                const r = await Actor.charge({ eventName: 'game_odds' });
                if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; break; }
            } catch (err) {
                log.warning(`charge failed (continuing): ${err?.message}`);
            }
        }
    }
}));

if (store) await store.setValue(stateKey, { ...prevLines, ...nextLines });
if (!pushed && !(onlyChanged && Object.keys(prevLines).length)) {
    await Actor.pushData({ rowType: 'note', note: `No open games matched across ${leagueList.length} league(s). Not charged.` });
}
await Actor.setValue('SUMMARY', { leagues: leagueList.length, games: pushed, unchangedSkipped: unchanged, failed, skippedSports });
log.info(`Done. ${pushed} game(s) from ${leagueList.length} league(s)${onlyChanged ? `, ${unchanged} unchanged skipped` : ''}${failed.length ? `, ${failed.length} league(s) failed` : ''}.`);
await Actor.exit();
