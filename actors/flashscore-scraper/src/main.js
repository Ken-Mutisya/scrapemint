// Flashscore Scraper: live scores, results, fixtures, match stats (xG) and odds
//
// Strategy
// --------
// Flashscore's web app reads plain-text feeds from www.flashscore.com/x/feed/
// with a static public header (x-fsign). No key, no login, no browser:
//   f_{sport}_{dayOffset}_{tz}_en_1   every match of a sport on one day (-7..+7)
//   df_st_1_{matchId}                 match statistics (xG, xGOT, shots, possession...)
//   df_sui_1_{matchId}                match summary: goals, cards, substitutions
//   df_hh_1_{matchId}                 head-to-head and recent form
// Feed records are separated by "~", fields by "¬", key and value by "÷".
// Odds come from Flashscore's own odds service (global.ds.lsapp.eu, GraphQL
// persisted query "oce"): every bookmaker shown for the chosen country, with
// opening and current odds and the settled result per selection.
//
// Pay per event
// -------------
//   match ($0.001)          one match row (scores, status, teams, league)
//   match_details ($0.002)  extra charge for a match row enriched with stats,
//                           odds, events or head-to-head (any of them)
// The first FREE_TIER_ROWS rows of every run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const FEED = 'https://www.flashscore.com/x/feed/';
const ODDS = 'https://global.ds.lsapp.eu/odds/pq_graphql';
const FSIGN = 'SW9D1eZo';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SPORTS = {
    football: 1, soccer: 1, tennis: 2, basketball: 3, hockey: 4, 'ice-hockey': 4,
    'american-football': 5, baseball: 6, handball: 7, rugby: 8, 'rugby-union': 8,
    floorball: 9, bandy: 10, futsal: 11, volleyball: 12, cricket: 13, darts: 14,
    snooker: 15, boxing: 16, 'beach-volleyball': 17, 'aussie-rules': 18, 'rugby-league': 19,
    badminton: 21, 'water-polo': 22, golf: 23, 'field-hockey': 24, 'table-tennis': 25,
    'beach-soccer': 26, mma: 28, netball: 29, pesapallo: 30, 'motorsport': 31,
    cycling: 34, 'horse-racing': 35, esports: 36, kabaddi: 42,
};
const STATUS = { 1: 'scheduled', 2: 'live', 3: 'finished' };
const STAGE = {
    1: 'Not started', 2: 'Live', 3: 'Finished', 4: 'Postponed', 5: 'Cancelled', 6: 'Extra time',
    7: 'Penalties', 8: 'Finished (retired)', 9: 'Walkover', 10: 'After extra time', 11: 'After penalties',
    12: '1st half', 13: '2nd half', 14: '1st period', 15: '2nd period', 16: '3rd period',
    17: '1st set', 18: '2nd set', 19: '3rd set', 20: '4th set', 21: '5th set',
    22: '1st quarter', 23: '2nd quarter', 24: '3rd quarter', 25: '4th quarter',
    36: 'Interrupted', 37: 'Abandoned', 38: 'Half time', 42: 'Awaiting updates', 43: 'Delayed',
    45: 'To finish', 46: 'Break time', 54: 'Awarded',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    sports = ['football'],
    days = [0],
    leagues = [],
    teams = [],
    matchIds = [],
    status = 'all',
    includeStats = false,
    includeOdds = false,
    oddsMarkets = ['HOME_DRAW_AWAY', 'HOME_AWAY', 'OVER_UNDER', 'BOTH_TEAMS_TO_SCORE'],
    oddsScope = 'FULL_TIME',
    oddsCountry = 'GB',
    includeEvents = false,
    includeH2H = false,
    maxMatches = 200,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(5000, Number(maxMatches) || 200));
const wantDetails = includeStats || includeOdds || includeEvents || includeH2H;
const leagueFilters = arr(leagues).map((s) => s.toLowerCase());
const teamFilters = arr(teams).map((s) => s.toLowerCase());
const markets = new Set(arr(oddsMarkets).map((s) => s.toUpperCase()));
const scopes = new Set(arr(oddsScope).map((s) => s.toUpperCase()));
const num = (v) => { if (v === undefined || v === null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

async function get(url, headers = {}, kind = 'text') {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.flashscore.com/', ...headers }, signal: AbortSignal.timeout(30000) });
            if (res.ok) return kind === 'json' ? await res.json() : await res.text();
            if (res.status === 404) return null;
            log.warning(`${url.slice(0, 90)}: HTTP ${res.status} (attempt ${attempt})`);
        } catch (err) {
            log.warning(`${url.slice(0, 90)}: ${err.message} (attempt ${attempt})`);
        }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    return null;
}
const feed = (path) => get(FEED + path, { 'x-fsign': FSIGN });

// Parse a feed into records: [{KEY: value, ...}, ...]. Duplicate keys keep the first value
// unless the record collects them in a list (handled by callers that need order).
function records(text) {
    if (!text) return [];
    return text.split('~').map((rec) => {
        const o = {};
        for (const kv of rec.split('¬')) {
            const i = kv.indexOf('÷');
            if (i < 1) continue;
            const k = kv.slice(0, i);
            if (!(k in o)) o[k] = kv.slice(i + 1);
        }
        return o;
    }).filter((o) => Object.keys(o).length);
}
// Like records() but keeps every key/value pair in order (needed for incidents with in+out players).
function recordPairs(text) {
    if (!text) return [];
    return text.split('~').map((rec) => rec.split('¬').map((kv) => { const i = kv.indexOf('÷'); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : null; }).filter(Boolean)).filter((r) => r.length);
}

function matchUrl(id) { return `https://www.flashscore.com/match/${id}/#/match-summary`; }

function buildMatch(e, t, sportName) {
    // Period scores keep their position (1st half/set/quarter = index 0). The day feed
    // often leaves out the football 1st half; derive it from the regular-time score
    // minus the 2nd half when both are present.
    const periods = [['BA', 'BB'], ['BC', 'BD'], ['BE', 'BF'], ['BG', 'BH'], ['BI', 'BJ']]
        .map(([h, a]) => (e[h] === undefined && e[a] === undefined ? null : { home: num(e[h]), away: num(e[a]) }));
    while (periods.length && periods[periods.length - 1] === null) periods.pop();
    if (sportName.match(/^(football|soccer)$/) && periods[0] === null && periods[1] && num(e.AT) !== null && num(e.AU) !== null) {
        periods[0] = { home: num(e.AT) - periods[1].home, away: num(e.AU) - periods[1].away };
    }
    const [country, ...rest] = String(t.ZA || '').split(': ');
    return {
        matchId: e.AA,
        sport: sportName,
        country: t.ZY || country || null,
        league: rest.length ? rest.join(': ') : t.ZA || null,
        leagueFull: t.ZA || null,
        leagueId: t.ZEE || null,
        leagueUrl: t.ZL ? `https://www.flashscore.com${t.ZL}` : null,
        round: e.ER || null,
        startTime: e.AD ? new Date(Number(e.AD) * 1000).toISOString() : null,
        status: { 4: 'postponed', 5: 'cancelled', 37: 'cancelled', 9: 'finished' }[e.AC] || STATUS[e.AB] || 'other',
        stage: STAGE[e.AC] || (e.AC ? `code ${e.AC}` : null),
        homeTeam: e.AE || e.FH || null,
        awayTeam: e.AF || e.FK || null,
        homeTeamId: e.JA || null,
        awayTeamId: e.JB || null,
        homeScore: num(e.AG),
        awayScore: num(e.AH),
        homeScoreFullTime: num(e.AT),
        awayScoreFullTime: num(e.AU),
        periods,
        winner: e.AB === '3' ? (num(e.AG) > num(e.AH) ? 'home' : num(e.AG) < num(e.AH) ? 'away' : (num(e.AG) !== null ? 'draw' : null)) : null,
        homeRedCards: num(e.AJ),
        awayRedCards: num(e.AK),
        note: e.AM || null,
        url: matchUrl(e.AA),
    };
}

// ---------- detail parsers ----------
function parseStats(text) {
    const out = {};
    let section = null;
    for (const r of records(text)) {
        if (r.SE) { section = r.SE; continue; }
        if (r.SF) continue;
        if (!r.SG || section !== 'Match') continue; // keep full-match stats only
        const key = r.SG;
        if (key in out) continue;
        out[key] = { home: r.SH ?? null, away: r.SI ?? null };
    }
    return out;
}
function statNum(stats, name, side) {
    const v = stats?.[name]?.[side];
    if (v === undefined || v === null) return null;
    const m = String(v).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
}

function parseEvents(text) {
    const out = [];
    let period = null;
    for (const pairs of recordPairs(text)) {
        const first = Object.fromEntries(pairs.slice(0, 1));
        if (first.AC !== undefined) { period = first.AC; continue; }
        const o = {}; const players = [];
        for (const [k, v] of pairs) {
            if (k === 'IF') players.push(v);
            else if (!(k in o)) o[k] = v;
        }
        if (!o.IK && !o.IB) continue;
        out.push({
            period,
            minute: o.IB || null,
            team: o.IA === '1' ? 'home' : o.IA === '2' ? 'away' : null,
            type: o.IK || null,
            player: players[0] || null,
            secondPlayer: players[1] || null,
            detail: o.IL || null,
            score: o.IG !== undefined ? `${o.IG}-${o.IH}` : null,
            text: o.ICT || null,
        });
    }
    return out;
}

function parseH2H(text) {
    const groups = [];
    let tab = null; let cur = null;
    for (const r of records(text)) {
        if (r.KA) { if (tab) break; tab = r.KA; continue; } // first tab = overall / all surfaces
        if (r.KB) { cur = { title: r.KB, matches: [] }; groups.push(cur); continue; }
        if (r.KC && cur && cur.matches.length < 10) {
            cur.matches.push({
                date: new Date(Number(r.KC) * 1000).toISOString().slice(0, 10),
                league: r.KF || null,
                home: (r.KJ || '').replace(/^\*/, ''),
                away: (r.KK || '').replace(/^\*/, ''),
                score: r.KL || null,
                outcome: r.WIS || null,
                matchId: r.KP || null,
            });
        }
    }
    return groups;
}

let bookmakerNames = new Map();
function selectionLabel(type, item, homeId, awayId) {
    const side = item.eventParticipantId === homeId ? 'home' : item.eventParticipantId === awayId ? 'away' : null;
    switch (type) {
        case 'HOME_DRAW_AWAY': case 'HOME_AWAY': return side || 'draw';
        case 'DOUBLE_CHANCE': return side === 'home' ? 'home_or_draw' : side === 'away' ? 'away_or_draw' : 'home_or_away';
        case 'BOTH_TEAMS_TO_SCORE': return item.bothTeamsToScore ? 'yes' : 'no';
        case 'OVER_UNDER': case 'ODD_OR_EVEN': return String(item.selection || '').toLowerCase() || null;
        case 'HALF_FULL_TIME': return item.winner || null;
        case 'CORRECT_SCORE': return item.score || null;
        default: return side || (item.selection ? String(item.selection).toLowerCase() : null);
    }
}
async function fetchOdds(matchId, homeId, awayId) {
    const url = `${ODDS}?_hash=oce&eventId=${encodeURIComponent(matchId)}&projectId=2&geoIpCode=${encodeURIComponent(oddsCountry)}&geoIpSubdivisionCode=${encodeURIComponent(oddsCountry)}`;
    const j = await get(url, { Accept: 'application/json' }, 'json');
    const d = j?.data?.findOddsByEventId;
    if (!d) return [];
    for (const b of d.settings?.bookmakers || []) bookmakerNames.set(b.bookmaker?.id, b.bookmaker?.name);
    const out = [];
    for (const o of d.odds || []) {
        if (markets.size && !markets.has(o.bettingType)) continue;
        if (scopes.size && !scopes.has(o.bettingScope)) continue;
        for (const it of o.odds || []) {
            out.push({
                bookmaker: bookmakerNames.get(o.bookmakerId) || String(o.bookmakerId),
                market: o.bettingType,
                scope: o.bettingScope,
                selection: selectionLabel(o.bettingType, it, homeId, awayId),
                line: it.handicap?.value != null ? Number(it.handicap.value) : null,
                odds: num(it.value),
                openingOdds: num(it.opening),
                active: it.active ?? null,
                result: it.result || null,
            });
        }
    }
    return out;
}
function bestOf(odds, market, selection) {
    let best = null;
    for (const o of odds) {
        if (!market.includes(o.market) || o.scope !== 'FULL_TIME' || o.selection !== selection || o.odds == null) continue;
        if (!best || o.odds > best.odds) best = o;
    }
    return best ? { odds: best.odds, bookmaker: best.bookmaker } : null;
}

// ---------- collect matches ----------
const sportList = arr(sports).map((s) => s.toLowerCase().replace(/\s+/g, '-'));
const dayList = [...new Set(arr(days).map((d) => Math.max(-7, Math.min(7, Math.trunc(Number(d))))).filter((d) => Number.isFinite(d)))];
if (!dayList.length) dayList.push(0);
const matches = [];
const seen = new Set();
for (const s of sportList) {
    const sid = SPORTS[s] ?? (Number.isInteger(Number(s)) ? Number(s) : null);
    if (!sid) { log.warning(`Unknown sport "${s}". Known: ${Object.keys(SPORTS).join(', ')}`); continue; }
    for (const d of dayList) {
        const text = await feed(`f_${sid}_${d}_3_en_1`);
        let tour = {};
        let n = 0;
        for (const r of records(text)) {
            if (r.ZA) { tour = r; continue; }
            if (!r.AA || seen.has(r.AA)) continue;
            seen.add(r.AA);
            matches.push(buildMatch(r, tour, s));
            n += 1;
        }
        log.info(`${s} day ${d >= 0 ? '+' : ''}${d}: ${n} matches`);
    }
}

// Direct match IDs (or Flashscore match URLs): fetch the core feed for basic data.
for (const raw of arr(matchIds).slice(0, 500)) {
    const id = (raw.match(/match\/(?:[^/]+\/)*?([A-Za-z0-9]{8})(?:\/|#|$|\?)/) || [])[1] || (/^[A-Za-z0-9]{8}$/.test(raw) ? raw : null);
    if (!id) { log.warning(`Match "${raw}" ignored: pass an 8-character Flashscore match ID or match URL`); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    const core = records(await feed(`dc_1_${id}`))[0] || {};
    matches.push({
        matchId: id, sport: null, country: null, league: null, leagueFull: null, leagueId: null, leagueUrl: null, round: null,
        startTime: core.DC ? new Date(Number(core.DC) * 1000).toISOString() : null,
        status: STATUS[core.DA] || 'other', stage: STAGE[core.DB] || null,
        homeTeam: null, awayTeam: null, homeTeamId: null, awayTeamId: null,
        homeScore: num(core.DE), awayScore: num(core.DF), homeScoreFullTime: num(core.DG), awayScoreFullTime: num(core.DH),
        periods: [], winner: null, homeRedCards: null, awayRedCards: null, note: null, url: matchUrl(id), _direct: true,
    });
}

// ---------- filter ----------
let filtered = matches.filter((m) => {
    if (m._direct) return true;
    if (status !== 'all' && m.status !== status) return false;
    if (leagueFilters.length) {
        const hay = `${m.leagueFull || ''} ${m.country || ''}`.toLowerCase();
        if (!leagueFilters.some((f) => hay.includes(f))) return false;
    }
    if (teamFilters.length) {
        const hay = `${m.homeTeam || ''} | ${m.awayTeam || ''}`.toLowerCase();
        if (!teamFilters.some((f) => hay.includes(f))) return false;
    }
    return true;
});
filtered.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
filtered = filtered.slice(0, cap);

if (!filtered.length) {
    await Actor.pushData({ note: `No matches found (${matches.length} before filters). Check sports, days (-7 to 7), leagues, teams and status. Not charged.` });
    await Actor.exit();
}
log.info(`${filtered.length} matches after filters${wantDetails ? ', fetching details' : ''}`);

// ---------- details + push ----------
let pushed = 0;
async function enrich(m) {
    const extra = {};
    if (includeStats) {
        const stats = m.status === 'scheduled' ? {} : parseStats(await feed(`df_st_1_${m.matchId}`));
        extra.homeXg = statNum(stats, 'Expected goals (xG)', 'home');
        extra.awayXg = statNum(stats, 'Expected goals (xG)', 'away');
        extra.homePossessionPct = statNum(stats, 'Ball possession', 'home');
        extra.awayPossessionPct = statNum(stats, 'Ball possession', 'away');
        extra.homeShots = statNum(stats, 'Total shots', 'home');
        extra.awayShots = statNum(stats, 'Total shots', 'away');
        extra.homeShotsOnTarget = statNum(stats, 'Shots on target', 'home');
        extra.awayShotsOnTarget = statNum(stats, 'Shots on target', 'away');
        extra.homeCorners = statNum(stats, 'Corner kicks', 'home');
        extra.awayCorners = statNum(stats, 'Corner kicks', 'away');
        extra.stats = stats;
    }
    if (includeEvents) extra.events = m.status === 'scheduled' ? [] : parseEvents(await feed(`df_sui_1_${m.matchId}`));
    if (includeH2H) extra.headToHead = parseH2H(await feed(`df_hh_1_${m.matchId}`));
    if (includeOdds) {
        const odds = await fetchOdds(m.matchId, m.homeTeamId, m.awayTeamId);
        extra.bookmakerCount = new Set(odds.map((o) => o.bookmaker)).size;
        extra.bestHomeOdds = bestOf(odds, ['HOME_DRAW_AWAY', 'HOME_AWAY'], 'home');
        extra.bestDrawOdds = bestOf(odds, ['HOME_DRAW_AWAY'], 'draw');
        extra.bestAwayOdds = bestOf(odds, ['HOME_DRAW_AWAY', 'HOME_AWAY'], 'away');
        extra.odds = odds;
    }
    return extra;
}

const CONC = 4;
for (let i = 0; i < filtered.length; i += CONC) {
    const batch = filtered.slice(i, i + CONC);
    const rows = await Promise.all(batch.map(async (m) => {
        const { _direct, ...row } = m;
        if (!wantDetails) return { row, detailed: false };
        try { return { row: { ...row, ...(await enrich(m)) }, detailed: true }; } catch (err) {
            log.warning(`${m.matchId}: details failed: ${err.message}`);
            return { row, detailed: false };
        }
    }));
    for (const { row, detailed } of rows) {
        row.scrapedAt = new Date().toISOString();
        await Actor.pushData(row);
        pushed += 1;
        if (pushed > FREE_TIER_ROWS) {
            try {
                await Actor.charge({ eventName: 'match' });
                if (detailed) await Actor.charge({ eventName: 'match_details' });
            } catch (err) { log.warning(`charge failed: ${err?.message}`); }
        }
    }
}
await Actor.setValue('SUMMARY', { matchesFound: matches.length, returned: pushed, sports: sportList, days: dayList });
log.info(`Done. ${pushed} matches returned.`);
await Actor.exit();
