// Public Betting Splits: % of bets vs % of money by game
//
// Strategy
// --------
// Action Network's public scoreboard JSON, no key, reachable from Apify
// datacenter IPs (verified 2026-11-27):
//   api.actionnetwork.com/web/v2/scoreboard/publicbetting/{league}?bookIds=15&periods=event[&date=YYYYMMDD]
// Each game carries, per market side, bet_info.tickets.percent (share of bets)
// and bet_info.money.percent (share of money), plus the line and price.
// Book 15 is Action Network's consensus line, which is where the splits live.
//
// A side whose money share beats its bet share by `sharpGapPct` points or more
// is flagged: fewer, larger tickets on that side, the usual "sharp money" read.
//
// Pay per event
// -------------
//   game ($0.004) one game with spread, moneyline and total splits.
//   The first game of every run is free. Notes are free.

import { Actor, log } from 'apify';

const API = 'https://api.actionnetwork.com/web/v2/scoreboard/publicbetting';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 1;
const BOOK = '15';
const LEAGUES = {
    nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', wnba: 'wnba',
    ncaaf: 'ncaaf', 'college football': 'ncaaf', cfb: 'ncaaf',
    ncaab: 'ncaab', 'college basketball': 'ncaab', cbb: 'ncaab',
    soccer: 'soccer', football: 'soccer',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    leagues = ['nfl'],
    date = '',
    days = 1,
    includeCompleted = false,
    onlySharpSignals = false,
    sharpGapPct = 10,
    maxRows = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const norm = (v) => String(v ?? '').toLowerCase().trim();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Math.min(10000, Number(maxRows) || 500));
const gap = Math.max(1, Number(sharpGapPct) || 10);

let pushed = 0;
let billable = 0;
let stop = false;

async function emit(row) {
    if (pushed >= cap) { stop = true; return; }
    await Actor.pushData(row);
    pushed += 1;
    billable += 1;
    if (billable > FREE_TIER_ROWS) {
        try {
            const r = await Actor.charge({ eventName: 'game' });
            if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
async function note(league, text) {
    await Actor.pushData({ league, note: `${text} Not charged.` });
    log.info(`${league}: ${text}`);
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45_000) });
            if (res.ok) return await res.json();
            if (res.status === 404) return null;
            log.warning(`HTTP ${res.status} ${url.slice(0, 120)} (attempt ${attempt})`);
        } catch (err) { log.warning(`${err.message} (attempt ${attempt})`); }
        await sleep(2000 * attempt);
    }
    return null;
}

function dayList() {
    const n = Math.max(1, Math.min(14, Number(days) || 1));
    const m = String(date || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return n === 1 ? [null] : Array.from({ length: n }, (_, i) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10).replace(/-/g, ''); });
    const d0 = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Array.from({ length: n }, (_, i) => { const d = new Date(d0); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10).replace(/-/g, ''); });
}

const pct = (o, k) => num(o?.bet_info?.[k]?.percent);
function sideSplit(o) {
    if (!o) return null;
    const bets = pct(o, 'tickets');
    const money = pct(o, 'money');
    return { line: num(o.value), odds: num(o.odds), betsPct: bets, moneyPct: money, moneyMinusBets: bets !== null && money !== null ? money - bets : null };
}
function sharp(sides) {
    // sides: [{label, split}] -> the side with money beating bets by >= gap
    let best = null;
    for (const s of sides) {
        const d = s.split?.moneyMinusBets;
        if (d !== null && d !== undefined && d >= gap && (!best || d > best.gap)) best = { side: s.label, gap: d };
    }
    return best;
}

const jobs = list(leagues);
if (!jobs.length) jobs.push('nfl');
for (const raw of jobs) {
    if (stop) break;
    const league = LEAGUES[norm(raw)];
    if (!league) { await note(raw, 'unknown league. Use nfl, nba, mlb, nhl, wnba, ncaaf, ncaab or soccer.'); continue; }
    const seen = new Set();
    for (const day of dayList()) {
        if (stop) break;
        const data = await getJson(`${API}/${league}?bookIds=${BOOK}&periods=event${day ? `&date=${day}` : ''}`);
        const games = data?.games ?? [];
        if (!games.length) { await note(raw, `no games ${day ? `on ${day}` : 'on the current slate'} (off-season or no slate yet).`); continue; }
        let withSplits = 0;
        for (const g of games) {
            if (stop) break;
            if (seen.has(g.id)) continue;
            seen.add(g.id);
            if (!includeCompleted && g.status === 'complete') continue;
            const teams = Object.fromEntries((g.teams ?? []).map((t) => [t.id, t]));
            const home = teams[g.home_team_id] ?? {};
            const away = teams[g.away_team_id] ?? {};
            const ev = g.markets?.[BOOK]?.event ?? {};
            const pick = (type, pred) => (ev[type] ?? []).find(pred);
            const spreadHome = sideSplit(pick('spread', (o) => o.side === 'home' || o.team_id === g.home_team_id));
            const spreadAway = sideSplit(pick('spread', (o) => o.side === 'away' || o.team_id === g.away_team_id));
            // A moneyline has no line value (the feed sends 0), only a price.
            const noLine = (s) => (s ? { ...s, line: null } : s);
            const mlHome = noLine(sideSplit(pick('moneyline', (o) => o.side === 'home' || o.team_id === g.home_team_id)));
            const mlAway = noLine(sideSplit(pick('moneyline', (o) => o.side === 'away' || o.team_id === g.away_team_id)));
            const mlDraw = noLine(sideSplit(pick('moneyline', (o) => o.side === 'draw')));
            const over = sideSplit(pick('total', (o) => o.side === 'over'));
            const under = sideSplit(pick('total', (o) => o.side === 'under'));
            const any = [spreadHome, mlHome, over].some((s) => s?.betsPct);
            if (!any) continue;
            withSplits += 1;
            const signals = {
                spread: sharp([{ label: home.full_name ?? 'home', split: spreadHome }, { label: away.full_name ?? 'away', split: spreadAway }]),
                moneyline: sharp([{ label: home.full_name ?? 'home', split: mlHome }, { label: away.full_name ?? 'away', split: mlAway }, { label: 'draw', split: mlDraw }]),
                total: sharp([{ label: 'over', split: over }, { label: 'under', split: under }]),
            };
            const hasSignal = Object.values(signals).some(Boolean);
            if (onlySharpSignals && !hasSignal) continue;
            await emit({
                league,
                gameId: g.id,
                startTime: g.start_time ?? null,
                status: g.status ?? null,
                homeTeam: home.full_name ?? null,
                homeAbbrev: home.abbr ?? null,
                awayTeam: away.full_name ?? null,
                awayAbbrev: away.abbr ?? null,
                totalBets: num(g.num_bets),
                spread: { home: spreadHome, away: spreadAway },
                moneyline: { home: mlHome, away: mlAway, ...(mlDraw ? { draw: mlDraw } : {}) },
                total: { over, under },
                sharpSignals: signals,
                hasSharpSignal: hasSignal,
                source: 'Action Network public betting (consensus)',
                scrapedAt: new Date().toISOString(),
            });
        }
        log.info(`${league}${day ? ` ${day}` : ''}: ${games.length} game(s), ${withSplits} with betting splits.`);
        if (!withSplits) await note(raw, 'games found but no betting splits published yet for them.');
        await sleep(400);
    }
}
await Actor.setValue('SUMMARY', { leagues: jobs, rows: pushed });
log.info(`Done. ${pushed} game(s); first ${FREE_TIER_ROWS} free, notes free.`);
await Actor.exit();
