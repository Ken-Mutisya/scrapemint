// Underdog & Sleeper Player Props: every live pick'em line on Underdog
// Fantasy and Sleeper Picks (NFL, college football, NBA, WNBA, MLB, NHL,
// soccer, tennis, MMA, esports...) in one format, with payout multipliers,
// odds, Sleeper's last-10 results and pick popularity, and a side-by-side
// of the two apps' lines where both list the same player and stat.
//
// Strategy
// --------
// - Underdog: GET https://api.underdogfantasy.com/v1/over_under_lines, one
//   ~35 MB JSON with over_under_lines, appearances, players, games and
//   solo_games. Join line -> appearance_stat.appearance_id -> appearance ->
//   player + match. The /beta/v5 path answers 426 "upgrade required"; v1
//   answers from Apify's US IPs (it 403s from some non-US IPs).
// - Sleeper: GET https://api.sleeper.app/lines/available (all sports) and
//   the player directory /players/{sport} for names, one per sport seen.
// - PrizePicks was dropped: DataDome captcha from datacenter IPs.
//
// No key, no proxy. Tested from Apify on 2026-10-17.
//
// Pay per event
// -------------
//   prop_row ($0.002) one player line from either app
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UNDERDOG = 'https://api.underdogfantasy.com/v1/over_under_lines';
const SLEEPER = 'https://api.sleeper.app/lines/available?dynamic=true&include_preseason=true&eg=15.control';
// Sleeper sport keys -> the labels Underdog uses, so one filter works for both.
const SPORT = {
    nfl: 'NFL', cfb: 'CFB', nba: 'NBA', nba_szn: 'NBA', cbb: 'CBB', wnba: 'WNBA', mlb: 'MLB', nhl: 'NHL',
    tennis: 'TENNIS', mma: 'MMA', cs: 'CS', golf: 'PGA', pga: 'PGA',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    sources = ['underdog', 'sleeper'],
    sports = [],
    players = [],
    stats = [],
    includeAlternates = false,
    maxRows = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const cap = Math.max(1, Number(maxRows) || 1000);
const srcs = list(sources).map((s) => s.toLowerCase());
const sportKeys = list(sports).map((s) => s.toUpperCase().replace(/^SOCCER$/, 'SOCCER'));
const playerKeys = list(players).map((p) => norm(p));
const statKeys = list(stats).map((s) => statNorm(s));

function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+(jr|sr|ii|iii|iv)$/, '').replace(/\s+/g, ' ').trim();
}

// "Pass Attempts", "passing_attempts", "Rush + Rec Yds" -> one key, so the
// two apps' stats can be matched and the stat filter accepts either wording.
function statNorm(s) {
    const words = String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/[_/-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const syn = {
        yds: 'yards', yd: 'yards', yard: 'yards', att: 'attempts', atts: 'attempts', attempt: 'attempts', pass: 'passing', rush: 'rushing',
        rec: 'receiving', recs: 'receptions', receptions: 'receptions', td: 'touchdowns', tds: 'touchdowns', touchdown: 'touchdowns',
        pts: 'points', pt: 'points', reb: 'rebounds', rebs: 'rebounds', ast: 'assists', asts: 'assists', stl: 'steals', blk: 'blocks',
        so: 'strikeouts', ks: 'strikeouts', k: 'strikeouts', sog: 'shots', fpts: 'fantasy', int: 'interceptions', ints: 'interceptions',
        comp: 'completions', comps: 'completions', cmp: 'completions', threes: '3pt', '3pm': '3pt', bat: '', pitch: '', player: '', over: '', under: '',
    };
    return words.map((w) => (w in syn ? syn[w] : w)).filter(Boolean).filter((w) => w !== 'made' && w !== 'total').join(' ');
}

async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90_000) });
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * (attempt + 1)); continue; }
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: r.status === 403 || r.status === 404 || r.status === 426 });
            return await r.json();
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

function keep(row) {
    if (sportKeys.length && !sportKeys.some((s) => row.sport === s || (s === 'SOCCER' && /^SOCCER|^CLUBSOCCER|^FIFA|^EPL/.test(row.sport)))) return false;
    if (playerKeys.length && !playerKeys.some((p) => norm(row.player).includes(p))) return false;
    if (statKeys.length && !statKeys.some((s) => statNorm(row.stat) === s || statNorm(row.statKey) === s)) return false;
    return true;
}

// ---- Underdog ----
async function underdog() {
    const d = await getJson(UNDERDOG);
    const players = new Map((d.players || []).map((p) => [p.id, p]));
    const apps = new Map((d.appearances || []).map((a) => [a.id, a]));
    const games = new Map((d.games || []).map((g) => [g.id, g]));
    const solo = new Map((d.solo_games || []).map((g) => [g.id, g]));
    const rows = [];
    for (const l of d.over_under_lines || []) {
        if (l.status && l.status !== 'active') continue;
        if (!includeAlternates && l.line_type && l.line_type !== 'balanced') continue;
        const ou = l.over_under || {};
        const st = ou.appearance_stat || {};
        const app = apps.get(st.appearance_id);
        const p = app ? players.get(app.player_id) : null;
        if (!p) continue;
        const g = app.match_type === 'SoloGame' ? solo.get(app.match_id) : games.get(app.match_id);
        const opt = (choice) => (l.options || []).find((o) => o.choice === choice);
        const hi = opt('higher');
        const lo = opt('lower');
        const dec = (o) => num(o?.decimal_price);
        // "CAR @ PHI": the player's side is whichever team id matches.
        const [awayAbbr, homeAbbr] = String(g?.abbreviated_title || '').split(/\s+@\s+/);
        const home = g && p.team_id && g.home_team_id === p.team_id;
        const away = g && p.team_id && g.away_team_id === p.team_id;
        rows.push({
            source: 'underdog',
            sport: String(p.sport_id || g?.sport_id || '').toUpperCase(),
            player: [p.first_name, p.last_name].filter(Boolean).join(' '),
            position: p.position_name || null,
            team: (home ? homeAbbr : away ? awayAbbr : null) || null,
            opponent: (home ? awayAbbr : away ? homeAbbr : null) || null,
            game: g?.abbreviated_title || g?.title || null,
            gameTitle: g?.full_team_names_title || g?.full_title || g?.title || null,
            gameTime: g?.scheduled_at || null,
            stat: st.display_stat || null,
            statKey: st.stat || null,
            line: num(l.stat_value),
            lineType: l.line_type || null,
            overMultiplier: num(hi?.payout_multiplier),
            underMultiplier: num(lo?.payout_multiplier),
            overAmericanOdds: hi?.american_price || null,
            underAmericanOdds: lo?.american_price || null,
            overImpliedProbability: dec(hi) ? r3(1 / dec(hi)) : null,
            underImpliedProbability: dec(lo) ? r3(1 / dec(lo)) : null,
            recentValues: null,
            hitRateLast10: null,
            pickPopularity: null,
            overPickShare: null,
            updatedAt: l.updated_at || null,
            playerImageUrl: p.image_url || null,
            lineId: l.id,
            teamId: p.team_id || null,
        });
    }
    return rows;
}

// ---- Sleeper ----
const directory = new Map();
async function sleeperPlayers(sport) {
    if (!directory.has(sport)) {
        directory.set(sport, getJson(`https://api.sleeper.app/players/${encodeURIComponent(sport)}`).catch((e) => {
            log.warning(`Sleeper ${sport} player names unavailable: ${e.message}`);
            return {};
        }));
    }
    return directory.get(sport);
}

const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function sleeper() {
    const d = await getJson(SLEEPER);
    const rows = [];
    for (const m of Array.isArray(d) ? d : []) {
        if (m.status !== 'active' || m.subject_type !== 'player') continue;
        if (!includeAlternates && m.line_type && m.line_type !== 'normal') continue;
        const over = (m.options || []).find((o) => o.outcome === 'over');
        const under = (m.options || []).find((o) => o.outcome === 'under');
        const any = over || under || (m.options || [])[0];
        if (!any) continue;
        const sport = SPORT[m.sport] || String(m.sport).toUpperCase().replace(/^CLUBSOCCER:/, 'SOCCER:');
        const dir = await sleeperPlayers(m.sport);
        const p = dir?.[m.subject_id] || {};
        const name = p.full_name || p.metadata?.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
        const line = num(any.outcome_value);
        const recent = (m.recent_performance?.values || []).map((v) => ({ date: v.date, opponent: v.opponent || null, value: num(v.value) }));
        const vals = recent.map((v) => v.value).filter((v) => v != null);
        const counts = m.pick_stats?.counts || {};
        rows.push({
            source: 'sleeper',
            sport,
            player: name,
            position: any.subject_position || p.position || null,
            team: any.subject_team || p.team || null,
            opponent: null,
            game: null,
            gameTitle: null,
            gameTime: null,
            stat: titleCase(m.wager_type),
            statKey: m.wager_type || null,
            line,
            lineType: m.line_type || null,
            overMultiplier: num(over?.payout_multiplier),
            underMultiplier: num(under?.payout_multiplier),
            overAmericanOdds: null,
            underAmericanOdds: null,
            overImpliedProbability: null,
            underImpliedProbability: null,
            recentValues: recent.length ? recent : null,
            hitRateLast10: vals.length && line != null ? r3(vals.filter((v) => v > line).length / vals.length) : null,
            pickPopularity: num(m.pick_stats?.popularity) != null ? r3(num(m.pick_stats.popularity)) : null,
            overPickShare: counts.total ? r3((counts.over || 0) / counts.total) : null,
            updatedAt: m.updated_at ? new Date(m.updated_at).toISOString() : null,
            playerImageUrl: null,
            lineId: any.line_id || null,
            sleeperPlayerId: m.subject_id,
            gameStatus: m.game_status || null,
        });
    }
    return rows;
}

// ---- run ----
const failures = [];
const all = [];
const perSource = {};
if (!srcs.length) srcs.push('underdog', 'sleeper');
for (const [name, fn] of [['underdog', underdog], ['sleeper', sleeper]]) {
    if (!srcs.includes(name)) continue;
    try {
        const rows = (await fn()).filter((r) => r.player && keep(r));
        perSource[name] = rows.length;
        all.push(...rows);
        log.info(`${name}: ${rows.length} line(s) after filters.`);
    } catch (err) {
        log.warning(`${name}: ${err.message}`);
        failures.push({ source: name, error: String(err.message) });
    }
}

// Line shopping: where both apps list the same player and stat, show the
// other app's line on each row.
const bySide = new Map();
for (const r of all) {
    const k = `${r.sport.replace(/^SOCCER:.*/, 'SOCCER')}|${norm(r.player)}|${statNorm(r.stat)}`;
    if (!bySide.has(k)) bySide.set(k, {});
    const slot = bySide.get(k);
    if (!slot[r.source] || r.lineType === 'balanced' || r.lineType === 'normal') slot[r.source] = r;
}
for (const r of all) {
    const slot = bySide.get(`${r.sport.replace(/^SOCCER:.*/, 'SOCCER')}|${norm(r.player)}|${statNorm(r.stat)}`) || {};
    const other = slot[r.source === 'underdog' ? 'sleeper' : 'underdog'];
    r.otherAppLine = other ? other.line : null;
    r.lineDifference = other && r.line != null && other.line != null ? r3(r.line - other.line) : null;
}

// Push and charge in batches: thousands of rows one by one take minutes.
let rowsOut = 0;
const rows = all.slice(0, cap);
for (let i = 0; i < rows.length; i += 500) {
    let batch = rows.slice(i, i + 500);
    const room = Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit('prop_row');
    if (Number.isFinite(room) && room < batch.length) batch = batch.slice(0, Math.max(0, room));
    if (!batch.length) { log.warning('Maximum cost per run reached; stopping.'); break; }
    await Actor.pushData(batch);
    rowsOut += batch.length;
    try {
        await Actor.charge({ eventName: 'prop_row', count: batch.length });
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    if (batch.length < Math.min(500, rows.length - i)) { log.warning('Maximum cost per run reached; stopping.'); break; }
}

if (!rowsOut) {
    const why = failures.length && failures.length === srcs.length ? `No source answered (${failures.map((f) => `${f.source}: ${f.error}`).join('; ')}).` : 'No lines matched the filters.';
    await Actor.pushData({ type: 'note', note: `${why} Not charged.` });
}
await Actor.setValue('SUMMARY', { rows: rowsOut, perSource, matchedAcrossApps: all.filter((r) => r.otherAppLine != null).length, failures });
log.info(`Done. ${rowsOut} line(s)${failures.length ? `, ${failures.length} source(s) failed` : ''}.`);
await Actor.exit();
