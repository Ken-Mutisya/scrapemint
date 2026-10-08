// Tennis Scraper: live scores, results, fixtures, closing odds and match stats
// for ATP, WTA, Challenger and ITF, singles and doubles.
//
// Strategy
// --------
// Two keyless sources, both answer Apify's IPs with no proxy (probed 2026-10-08):
//
// * Flashscore's own feed (www.flashscore.com/x/feed/f_2_<dayOffset>_0_en_1,
//   header x-fsign) lists every tennis match for one UTC day, 7 days back to 7
//   ahead: status, live set scores, tiebreaks, winner, surface. Records are
//   "¬"-separated "KEY÷value" pairs; "~ZA" opens a tournament, "~AA" a match.
//   df_st_1_<id> is the per-match stats feed (aces, serve %, break points...).
// * Tennisexplorer's results and matches pages have average closing odds for
//   every match (back to the 2000s) and head-to-head counts for fixtures.
//
// Inside Flashscore's window, rows come from Flashscore and get odds from
// Tennisexplorer by matching the two player names (both sites print
// "Surname I."). Older dates come from Tennisexplorer alone.
//
// Pay per event
// -------------
//   match_row   ($0.002) one match with players, status, set scores and odds
//   match_stats ($0.002) the serve/return/points stats block on a match row
// No start fee. A run with no matches is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FS = 'https://www.flashscore.com/x/feed';
const FSIGN = 'SW9D1eZo';
const TE = 'https://www.tennisexplorer.com';
const DAY = 86_400_000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    dateFrom = '',
    dateTo = '',
    tours = ['atp', 'wta'],
    includeDoubles = false,
    status = 'all',
    players = [],
    includeOdds = true,
    includeStats = false,
    maxMatches = 1000,
} = input;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (d) => d.toISOString().slice(0, 10);
const today = new Date(isoDay(new Date()) + 'T00:00:00Z');
const parseDay = (s, dflt) => {
    const v = String(s || '').trim().toLowerCase();
    if (!v || v === 'today') return dflt;
    if (/^[+-]\d+$/.test(v)) return new Date(today.getTime() + Number(v) * DAY);
    if (v === 'yesterday') return new Date(today.getTime() - DAY);
    if (v === 'tomorrow') return new Date(today.getTime() + DAY);
    const d = new Date(v.slice(0, 10) + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? dflt : d;
};
let from = parseDay(dateFrom, today);
let to = parseDay(dateTo, from);
if (to < from) [from, to] = [to, from];
const maxDays = 366;
if ((to - from) / DAY + 1 > maxDays) { to = new Date(from.getTime() + (maxDays - 1) * DAY); log.warning(`Date range capped at ${maxDays} days.`); }

const tourSet = new Set((Array.isArray(tours) && tours.length ? tours : ['atp', 'wta']).map((t) => String(t).toLowerCase()));
const playerTerms = (Array.isArray(players) ? players : String(players || '').split(/[\n,]/)).map((s) => norm(s)).filter(Boolean);
const wantStatus = String(status || 'all').toLowerCase();
const limit = Math.max(1, Number(maxMatches) || 1000);

function norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

async function get(url, headers = {}) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers }, signal: AbortSignal.timeout(30_000) });
            if (r.ok) return await r.text();
            if (r.status === 404) return '';
            last = new Error(`HTTP ${r.status} ${url}`);
        } catch (err) { last = err; }
        await sleep(1000 * 2 ** attempt);
    }
    throw last;
}

// ---------- Flashscore ----------

// Tournament header "ATP - SINGLES: Shanghai (China), hard" -> level, draw, name, surface.
function classify(header) {
    const [cat = '', rest = ''] = header.split(/:\s(.*)/s);
    const c = cat.toUpperCase();
    const doubles = /DOUBLES|MIXED/.test(c);
    let tour = 'other';
    if (/^ATP\b/.test(c)) tour = 'atp';
    else if (/^WTA\b/.test(c)) tour = 'wta';
    else if (/^CHALLENGER MEN/.test(c)) tour = 'challenger-men';
    else if (/^CHALLENGER WOMEN|^WTA 125/.test(c)) tour = 'challenger-women';
    else if (/^ITF MEN/.test(c)) tour = 'itf-men';
    else if (/^ITF WOMEN/.test(c)) tour = 'itf-women';
    const m = rest.match(/^(.*?)(?:,\s*([a-z ]+))?$/i);
    const surface = m?.[2] && /hard|clay|grass|carpet|indoor/i.test(m[2]) ? m[2].trim().toLowerCase() : null;
    return { tour, doubles, category: cat.trim(), tournament: (surface ? m[1] : rest).trim(), surface };
}

const FS_STATUS = { 1: 'scheduled', 3: 'finished', 4: 'postponed', 5: 'cancelled', 8: 'retired', 9: 'walkover', 36: 'interrupted', 37: 'abandoned', 54: 'awarded' };

function fsStatus(ab, ac) {
    if (ab === '2') return 'live';
    return FS_STATUS[ac] || (ab === '3' ? 'finished' : ab === '1' ? 'scheduled' : `status_${ac}`);
}

function parseFsFeed(text) {
    const out = [];
    let tour = null;
    for (const rec of text.split('¬~')) {
        const f = {};
        for (const kv of rec.split('¬')) {
            const i = kv.indexOf('÷');
            if (i > 0) f[kv.slice(0, i).replace(/^~/, '')] = kv.slice(i + 1);
        }
        if (f.ZA) { tour = { header: f.ZA, path: f.ZL || null, ...classify(f.ZA) }; continue; }
        if (!f.AA || !tour) continue;
        const sets = [];
        const keys = [['BA', 'BB', 'DA', 'DB'], ['BC', 'BD', 'DC', 'DD'], ['BE', 'BF', 'DE', 'DF'], ['BG', 'BH', 'DG', 'DH'], ['BI', 'BJ', 'DI', 'DJ']];
        for (const [h, a, th, ta] of keys) {
            if (f[h] == null && f[a] == null) break;
            const s = { player1: num(f[h]), player2: num(f[a]) };
            if (f[th] != null || f[ta] != null) { s.tiebreak1 = num(f[th]); s.tiebreak2 = num(f[ta]); }
            sets.push(s);
        }
        const st = fsStatus(f.AB, f.AC);
        out.push({
            matchId: f.AA,
            source: 'flashscore',
            startTime: f.AD ? new Date(Number(f.AD) * 1000).toISOString() : null,
            tour: tour.tour,
            doubles: tour.doubles,
            category: tour.category,
            tournament: tour.tournament,
            surface: tour.surface,
            status: st,
            note: f.AM || null,
            player1: { name: f.AE || f.CX || null, country: f.FU || null, slug: f.WU || null },
            player2: { name: f.AF || null, country: f.FV || null, slug: f.WV || null },
            winner: f.AS === '1' ? 1 : f.AS === '2' ? 2 : null,
            setsWon1: num(f.AG),
            setsWon2: num(f.AH),
            sets,
            score: scoreString(sets),
            tournamentUrl: tour.path ? `https://www.flashscore.com${tour.path}` : null,
            matchUrl: `https://www.flashscore.com/match/${f.AA}/#/match-summary`,
        });
    }
    return out;
}

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function scoreString(sets) {
    if (!sets.length) return null;
    return sets.map((s) => {
        let t = `${s.player1 ?? '-'}-${s.player2 ?? '-'}`;
        if (s.tiebreak1 != null || s.tiebreak2 != null) t += `(${Math.min(s.tiebreak1 ?? 99, s.tiebreak2 ?? 99)})`;
        return t;
    }).join(' ');
}

const camel = (s) => s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');

async function fsStats(id) {
    const text = await get(`${FS}/df_st_1_${id}`, { 'x-fsign': FSIGN });
    if (!text) return null;
    const periods = {};
    let period = null;
    let name = null;
    for (const rec of text.split('¬~')) {
        for (const kv of rec.split('¬')) {
            const i = kv.indexOf('÷');
            if (i < 0) continue;
            const k = kv.slice(0, i).replace(/^~/, '');
            const v = kv.slice(i + 1);
            if (k === 'SE') { period = v === 'Match' ? 'match' : camel(v); periods[period] = {}; }
            else if (k === 'SG') { name = camel(v); }
            else if (k === 'SH' && period && name) periods[period][name] = { player1: statVal(v) };
            else if (k === 'SI' && period && name && periods[period][name]) periods[period][name].player2 = statVal(v);
        }
    }
    return Object.keys(periods).length ? periods : null;
}

// "78% (35/45)" -> { pct: 78, won: 35, total: 45 }; "7" -> 7; "2/2" -> { won: 2, total: 2 }
function statVal(v) {
    const m = v.match(/^(\d+)%\s*\((\d+)\/(\d+)\)$/);
    if (m) return { pct: Number(m[1]), won: Number(m[2]), total: Number(m[3]) };
    const f = v.match(/^(\d+)\/(\d+)$/);
    if (f) return { won: Number(f[1]), total: Number(f[2]) };
    const p = v.match(/^(\d+)%$/);
    if (p) return { pct: Number(p[1]) };
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

// ---------- Tennisexplorer ----------

const teCache = new Map();
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();

function teTypes() {
    const t = [];
    const men = ['atp', 'challenger-men', 'itf-men', 'other'].some((x) => tourSet.has(x));
    const women = ['wta', 'challenger-women', 'itf-women', 'other'].some((x) => tourSet.has(x));
    if (men) t.push('atp-single');
    if (women) t.push('wta-single');
    if (includeDoubles && men) t.push('atp-double');
    if (includeDoubles && women) t.push('wta-double');
    return t;
}

// Results (past) and matches (today and later) pages share one table layout:
// a "head" row per tournament, then two rows per match (player 1, player 2).
async function teDay(type, day) {
    const key = `${type}|${isoDay(day)}`;
    if (teCache.has(key)) return teCache.get(key);
    const p = (async () => {
        const [y, m, d] = isoDay(day).split('-');
        const page = day < today ? 'results' : 'matches';
        const html = await get(`${TE}/${page}/?type=${type}&year=${y}&month=${m}&day=${d}`);
        const rows = [];
        let tournament = null;
        let tournamentUrl = null;
        let pending = null;
        for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
            // Only the row's own class: fixture rows carry a live-streams popup
            // with <div class="head tl"> inside them.
            if (/^<tr[^>]*class="head/.test(tr)) {
                const a = tr.match(/<td class="t-name"[^>]*><a href="([^"]+)">([\s\S]*?)<\/a>/);
                if (a) { tournament = strip(a[2]); tournamentUrl = TE + a[1]; }
                continue;
            }
            const name = tr.match(/<td class="t-name"><a href="([^"]+)">([\s\S]*?)<\/a>/);
            if (!name) continue;
            const cells = [...tr.matchAll(/<td class="(result|score[^"]*|nbr)"[^>]*>([\s\S]*?)<\/td>/g)];
            const resultCell = cells.find((c) => c[1] === 'result' || c[1] === 'nbr');
            const scores = cells.filter((c) => c[1].startsWith('score')).map((c) => {
                const g = c[2].match(/^\s*(\d+)(?:<sup>(\d+)<\/sup>)?/);
                return g ? { games: Number(g[1]), tb: g[2] != null ? Number(g[2]) : null } : null;
            });
            const side = { name: strip(name[2]), url: TE + name[1], sets: num(strip(resultCell?.[2])), scores };
            const id = tr.match(/match-detail\/\?id=(\d+)/);
            if (id) {
                const time = strip(tr.match(/<td class="first time"[^>]*>([\s\S]*?)(?:<br|<\/td>)/)?.[1]);
                const odds = [...tr.matchAll(/<td class="course\w*"[^>]*>([\s\S]*?)<\/td>/g)].map((c) => num(strip(c[1])));
                const h2h = strip(tr.match(/<td class="h2h"[^>]*>([\s\S]*?)<\/td>/)?.[1]);
                pending = { id: id[1], time, odds, h2h, p1: side, tournament, tournamentUrl };
            } else if (pending) {
                rows.push({ ...pending, p2: side, day: isoDay(day), type });
                pending = null;
            }
        }
        return rows;
    })();
    teCache.set(key, p);
    return p;
}

const pairKey = (a, b) => [norm(a), norm(b)].sort().join('|');

function teToRow(t) {
    const sets = [];
    for (let i = 0; i < 5; i++) {
        const a = t.p1.scores[i];
        const b = t.p2.scores[i];
        if (!a && !b) break;
        const s = { player1: a?.games ?? null, player2: b?.games ?? null };
        if (a?.tb != null || b?.tb != null) { s.tiebreak1 = a?.tb ?? null; s.tiebreak2 = b?.tb ?? null; }
        sets.push(s);
    }
    const done = t.p1.sets != null && t.p2.sets != null;
    const doubles = t.type.endsWith('double');
    return {
        matchId: `te-${t.id}`,
        source: 'tennisexplorer',
        startTime: null,
        localDate: t.day,
        localTime: /^\d\d:\d\d$/.test(t.time) ? t.time : null,
        timezone: 'Europe/Prague',
        tour: t.type.startsWith('atp') ? 'men' : 'women',
        doubles,
        category: t.type,
        tournament: t.tournament,
        surface: null,
        status: done ? 'finished' : t.day < isoDay(today) ? 'unknown' : 'scheduled',
        note: null,
        player1: { name: t.p1.name, country: null, slug: null, url: t.p1.url },
        player2: { name: t.p2.name, country: null, slug: null, url: t.p2.url },
        winner: done ? (t.p1.sets > t.p2.sets ? 1 : t.p2.sets > t.p1.sets ? 2 : null) : null,
        setsWon1: t.p1.sets,
        setsWon2: t.p2.sets,
        sets,
        score: scoreString(sets),
        tournamentUrl: t.tournamentUrl,
        matchUrl: `${TE}/match-detail/?id=${t.id}`,
    };
}

function oddsFrom(t, swap) {
    const [o1, o2] = t.odds;
    if (o1 == null && o2 == null) return null;
    const a = swap ? o2 : o1;
    const b = swap ? o1 : o2;
    const imp = (o) => (o ? Math.round((1 / o) * 1000) / 10 : null);
    return {
        player1: a ?? null,
        player2: b ?? null,
        impliedPct1: imp(a),
        impliedPct2: imp(b),
        favourite: a && b ? (a < b ? 1 : b < a ? 2 : null) : null,
        source: 'tennisexplorer average odds',
        h2hMatches: t.h2h ? num(t.h2h) : null,
    };
}

// ---------- Run ----------

let matchRows = 0;
let statsRows = 0;
let keepGoing = true;
const failures = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    return true;
}

function keep(row) {
    if (row.source === 'flashscore') {
        if (!tourSet.has(row.tour)) return false;
        if (row.doubles && !includeDoubles) return false;
    } else if (row.doubles && !includeDoubles) return false;
    if (wantStatus === 'finished' && !['finished', 'retired', 'walkover', 'awarded'].includes(row.status)) return false;
    if (wantStatus === 'scheduled' && row.status !== 'scheduled') return false;
    if (wantStatus === 'live' && row.status !== 'live') return false;
    if (playerTerms.length) {
        const names = norm(row.player1.name) + '|' + norm(row.player2.name);
        if (!playerTerms.some((p) => names.includes(p))) return false;
    }
    return true;
}

async function emit(row) {
    if (matchRows >= limit) { keepGoing = false; return; }
    let stats = null;
    if (includeStats && row.source === 'flashscore' && ['finished', 'retired', 'live', 'awarded'].includes(row.status)) {
        try { stats = await fsStats(row.matchId); } catch (err) { log.debug(`stats ${row.matchId}: ${err?.message}`); }
    }
    await Actor.pushData({ ...row, ...(includeStats ? { stats } : {}), scrapedAt: new Date().toISOString() });
    matchRows += 1;
    if (!(await charge('match_row'))) { keepGoing = false; return; }
    if (stats) { statsRows += 1; if (!(await charge('match_stats'))) keepGoing = false; }
}

const types = teTypes();
log.info(`Tennis ${isoDay(from)} to ${isoDay(to)}; tours ${[...tourSet].join(', ')}${includeDoubles ? ' + doubles' : ''}; status ${wantStatus}.`);

for (let d = new Date(from); d <= to && keepGoing; d = new Date(d.getTime() + DAY)) {
    const offset = Math.round((d - today) / DAY);
    const day = isoDay(d);
    if (offset >= -7 && offset <= 7) {
        let rows;
        try {
            rows = parseFsFeed(await get(`${FS}/f_2_${offset}_0_en_1`, { 'x-fsign': FSIGN })).filter(keep);
        } catch (err) {
            log.warning(`Flashscore ${day}: ${err?.message}`);
            failures.push({ date: day, source: 'flashscore', error: String(err?.message || err) });
            continue;
        }
        // Tennisexplorer days are Central European; a UTC day overlaps two of them.
        const odds = new Map();
        if (includeOdds && rows.length) {
            for (const type of types) {
                for (const dd of [d, new Date(d.getTime() + DAY)]) {
                    try {
                        for (const t of await teDay(type, dd)) odds.set(pairKey(t.p1.name, t.p2.name), t);
                    } catch (err) { log.debug(`tennisexplorer ${type} ${isoDay(dd)}: ${err?.message}`); }
                }
            }
        }
        log.info(`${day}: ${rows.length} match(es) from Flashscore${includeOdds ? `, ${odds.size} with odds to match against` : ''}.`);
        for (const row of rows) {
            if (!keepGoing) break;
            if (includeOdds) {
                const t = odds.get(pairKey(row.player1.name, row.player2.name));
                row.odds = t ? oddsFrom(t, norm(t.p1.name) !== norm(row.player1.name)) : null;
            }
            await emit(row);
        }
    } else {
        let n = 0;
        for (const type of types) {
            if (!keepGoing) break;
            let list;
            try { list = await teDay(type, d); } catch (err) {
                log.warning(`Tennisexplorer ${type} ${day}: ${err?.message}`);
                failures.push({ date: day, source: 'tennisexplorer', type, error: String(err?.message || err) });
                continue;
            }
            for (const t of list) {
                if (!keepGoing) break;
                const row = teToRow(t);
                if (!keep(row)) continue;
                if (includeOdds) row.odds = oddsFrom(t, false);
                await emit(row);
                n += 1;
            }
            await sleep(400);
        }
        log.info(`${day}: ${n} match(es) from Tennisexplorer.`);
    }
}

if (!matchRows) await Actor.pushData({ rowType: 'note', note: 'No matches for these dates and filters. Not charged.' });
await Actor.setValue('SUMMARY', { matchRows, statsRows, from: isoDay(from), to: isoDay(to), failures });
log.info(`Done. ${matchRows} match(es), ${statsRows} with stats${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
