// Historical Football Odds & Results: 38 leagues, back to 1993
//
// Strategy
// --------
// football-data.co.uk publishes free CSV files of results, match stats and
// bookmaker odds (opening and, since 2019/20, closing), no key:
//   /mmz4281/{yyyy}/{DIV}.csv   22 main European divisions, one file per season
//                               (e.g. 2526/E0.csv = Premier League 2025/26)
//   /new/{CODE}.csv             16 extra leagues (MLS, Brazil, Japan...), one file
//                               with every season, closing odds only
// Column sets change across seasons (Betbrain averages before 2019, Pinnacle
// from 2012, closing odds from 2019/20, xG from 2026/27), so every row is
// normalised to the same fields: 1X2, over/under 2.5 and Asian handicap, opening
// and closing, for Bet365, Pinnacle, Betfair Exchange, market max and market
// average, plus no-vig implied probabilities from the sharpest available line.
//
// Pay per event
// -------------
//   match ($0.0005) one match row. The first FREE_TIER_ROWS rows of every run
//   are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const BASE = 'https://www.football-data.co.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAIN = {
    E0: ['England', 'Premier League'], E1: ['England', 'Championship'], E2: ['England', 'League One'], E3: ['England', 'League Two'], EC: ['England', 'National League'],
    SC0: ['Scotland', 'Premiership'], SC1: ['Scotland', 'Championship'], SC2: ['Scotland', 'League One'], SC3: ['Scotland', 'League Two'],
    D1: ['Germany', 'Bundesliga'], D2: ['Germany', '2. Bundesliga'], I1: ['Italy', 'Serie A'], I2: ['Italy', 'Serie B'],
    SP1: ['Spain', 'La Liga'], SP2: ['Spain', 'Segunda Division'], F1: ['France', 'Ligue 1'], F2: ['France', 'Ligue 2'],
    N1: ['Netherlands', 'Eredivisie'], B1: ['Belgium', 'Pro League'], P1: ['Portugal', 'Primeira Liga'], T1: ['Turkey', 'Super Lig'], G1: ['Greece', 'Super League'],
};
const EXTRA = {
    ARG: 'Argentina', AUT: 'Austria', BRA: 'Brazil', CHN: 'China', DNK: 'Denmark', FIN: 'Finland', IRL: 'Ireland', JPN: 'Japan',
    MEX: 'Mexico', NOR: 'Norway', POL: 'Poland', ROU: 'Romania', RUS: 'Russia', SWE: 'Sweden', SWZ: 'Switzerland', USA: 'USA',
};
const ALIASES = {
    'premier league': 'E0', epl: 'E0', championship: 'E1', 'league one': 'E2', 'league two': 'E3', 'national league': 'EC',
    'scottish premiership': 'SC0', 'bundesliga': 'D1', '2. bundesliga': 'D2', 'serie a': 'I1', 'serie b': 'I2', 'la liga': 'SP1', laliga: 'SP1',
    'segunda': 'SP2', 'ligue 1': 'F1', 'ligue 2': 'F2', eredivisie: 'N1', 'jupiler': 'B1', 'belgium': 'B1', 'primeira liga': 'P1', 'portugal': 'P1',
    'super lig': 'T1', turkey: 'T1', greece: 'G1', mls: 'USA', brazil: 'BRA', 'brasileirao': 'BRA', japan: 'JPN', 'j league': 'JPN', mexico: 'MEX', 'liga mx': 'MEX',
    argentina: 'ARG', austria: 'AUT', china: 'CHN', denmark: 'DNK', finland: 'FIN', ireland: 'IRL', norway: 'NOR', poland: 'POL', romania: 'ROU',
    russia: 'RUS', sweden: 'SWE', switzerland: 'SWZ', usa: 'USA',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    leagues = ['E0'],
    seasons = [],
    lastSeasons = 1,
    teams = [],
    dateFrom = '',
    dateTo = '',
    includeAllBookmakers = false,
    maxRows = 5000,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(200000, Number(maxRows) || 5000));
const teamFilters = arr(teams).map((s) => s.toLowerCase());
const num = (v) => { if (v === undefined || v === null || String(v).trim() === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const r4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000);

// Season start year from "2025/2026", "2025-26", "2526", "2025".
function seasonStart(s) {
    const t = String(s).trim();
    let m = t.match(/^(\d{4})\s*[/-]\s*(\d{2,4})$/); if (m) return Number(m[1]);
    m = t.match(/^(\d{2})(\d{2})$/); if (m && (Number(m[2]) === (Number(m[1]) + 1) % 100)) return Number(m[1]) >= 90 ? 1900 + Number(m[1]) : 2000 + Number(m[1]);
    m = t.match(/^(\d{4})$/); if (m) return Number(m[1]);
    return null;
}
const now = new Date();
const currentStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; // European season starts Jul/Aug
let startYears = [...new Set(arr(seasons).map(seasonStart).filter((y) => y && y >= 1993 && y <= currentStart))];
if (!startYears.length) {
    const n = Math.max(1, Math.min(35, Number(lastSeasons) || 1));
    startYears = Array.from({ length: n }, (_, i) => currentStart - i);
}
const code = (y) => `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;

function parseDate(s) {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    let y = Number(m[3]); if (y < 100) y += y >= 90 ? 1900 : 2000;
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
const fromD = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom : null;
const toD = /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo : null;

async function getCsv(path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(BASE + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
            if (res.status === 404) return null;
            if (res.ok) {
                const buf = new Uint8Array(await res.arrayBuffer());
                if (buf.length < 20 || (buf[0] === 0x3c)) return null; // HTML error page
                try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('latin1').decode(buf); }
            }
            log.warning(`${path}: HTTP ${res.status} (attempt ${attempt})`);
        } catch (err) {
            log.warning(`${path}: ${err.message} (attempt ${attempt})`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return null;
}
function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.replace(/,/g, '').trim());
    if (!lines.length) return [];
    const split = (l) => {
        const out = []; let cur = ''; let q = false;
        for (let i = 0; i < l.length; i++) {
            const c = l[i];
            if (c === '"') { q = !q; continue; }
            if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
            cur += c;
        }
        out.push(cur);
        return out.map((s) => s.trim());
    };
    const head = split(lines[0]);
    return lines.slice(1).map((l) => { const v = split(l); const o = {}; head.forEach((h, i) => { if (h) o[h] = v[i] ?? ''; }); return o; });
}

// Normalised odds triplets. `pick` returns the first column that has a number.
const pick = (r, ...cols) => { for (const c of cols) { const v = num(r[c]); if (v !== null) return v; } return null; };
const trip = (r, h, d, a) => { const o = { home: pick(r, ...h), draw: pick(r, ...d), away: pick(r, ...a) }; return o.home === null && o.draw === null && o.away === null ? null : o; };
const pair = (r, o, u) => { const x = { over: pick(r, ...o), under: pick(r, ...u) }; return x.over === null && x.under === null ? null : x; };
function noVig(o) {
    if (!o || !o.home || !o.away) return null;
    const inv = [1 / o.home, o.draw ? 1 / o.draw : 0, 1 / o.away];
    const s = inv.reduce((a, b) => a + b, 0);
    return { home: r4(inv[0] / s), draw: o.draw ? r4(inv[1] / s) : null, away: r4(inv[2] / s), overround: r4(s - 1) };
}

function mainRow(r, div, startYear) {
    const [country, league] = MAIN[div];
    const fthg = num(r.FTHG ?? r.HG); const ftag = num(r.FTAG ?? r.AG);
    const open = {
        bet365: trip(r, ['B365H'], ['B365D'], ['B365A']),
        pinnacle: trip(r, ['PSH', 'PH'], ['PSD', 'PD'], ['PSA', 'PA']),
        betfairExchange: trip(r, ['BFEH'], ['BFED'], ['BFEA']),
        max: trip(r, ['MaxH', 'BbMxH'], ['MaxD', 'BbMxD'], ['MaxA', 'BbMxA']),
        avg: trip(r, ['AvgH', 'BbAvH'], ['AvgD', 'BbAvD'], ['AvgA', 'BbAvA']),
    };
    const close = {
        bet365: trip(r, ['B365CH'], ['B365CD'], ['B365CA']),
        pinnacle: trip(r, ['PSCH'], ['PSCD'], ['PSCA']),
        betfairExchange: trip(r, ['BFECH'], ['BFECD'], ['BFECA']),
        max: trip(r, ['MaxCH'], ['MaxCD'], ['MaxCA']),
        avg: trip(r, ['AvgCH'], ['AvgCD'], ['AvgCA']),
    };
    const ouOpen = { bet365: pair(r, ['B365>2.5'], ['B365<2.5']), pinnacle: pair(r, ['P>2.5'], ['P<2.5']), max: pair(r, ['Max>2.5', 'BbMx>2.5'], ['Max<2.5', 'BbMx<2.5']), avg: pair(r, ['Avg>2.5', 'BbAv>2.5'], ['Avg<2.5', 'BbAv<2.5']), betfairExchange: pair(r, ['BFE>2.5'], ['BFE<2.5']) };
    const ouClose = { bet365: pair(r, ['B365C>2.5'], ['B365C<2.5']), pinnacle: pair(r, ['PC>2.5'], ['PC<2.5']), max: pair(r, ['MaxC>2.5'], ['MaxC<2.5']), avg: pair(r, ['AvgC>2.5'], ['AvgC<2.5']), betfairExchange: pair(r, ['BFEC>2.5'], ['BFEC<2.5']) };
    // books: { name: [[home columns...], [away columns...]] }
    const ah = (line, books) => {
        const l = pick(r, ...line);
        if (l === null) return null;
        const out = { line: l };
        for (const [k, [hc, ac]] of Object.entries(books)) { const v = { home: pick(r, ...hc), away: pick(r, ...ac) }; if (v.home !== null || v.away !== null) out[k] = v; }
        return out;
    };
    const clean = (o) => { const x = Object.fromEntries(Object.entries(o).filter(([, v]) => v)); return Object.keys(x).length ? x : null; };
    return {
        country, league, division: div, season: `${startYear}/${startYear + 1}`,
        date: parseDate(r.Date), time: r.Time || null,
        homeTeam: r.HomeTeam ?? r.Home ?? null, awayTeam: r.AwayTeam ?? r.Away ?? null,
        homeGoals: fthg, awayGoals: ftag, result: r.FTR ?? r.Res ?? null,
        halfTimeHomeGoals: num(r.HTHG), halfTimeAwayGoals: num(r.HTAG), halfTimeResult: r.HTR || null,
        totalGoals: fthg !== null && ftag !== null ? fthg + ftag : null,
        over2_5: fthg !== null && ftag !== null ? fthg + ftag > 2.5 : null,
        bothTeamsScored: fthg !== null && ftag !== null ? fthg > 0 && ftag > 0 : null,
        referee: r.Referee || null, attendance: num(r.Attendance),
        homeXg: num(r.HxG), awayXg: num(r.AxG),
        homeShots: num(r.HS), awayShots: num(r.AS), homeShotsOnTarget: num(r.HST), awayShotsOnTarget: num(r.AST),
        homeCorners: num(r.HC), awayCorners: num(r.AC), homeFouls: num(r.HF), awayFouls: num(r.AF),
        homeYellow: num(r.HY), awayYellow: num(r.AY), homeRed: num(r.HR), awayRed: num(r.AR),
        odds1x2Opening: clean(open), odds1x2Closing: clean(close),
        overUnder25Opening: clean(ouOpen), overUnder25Closing: clean(ouClose),
        asianHandicapOpening: ah(['AHh', 'BbAHh'], { bet365: [['B365AHH'], ['B365AHA']], pinnacle: [['PAHH'], ['PAHA']], max: [['MaxAHH', 'BbMxAHH'], ['MaxAHA', 'BbMxAHA']], avg: [['AvgAHH', 'BbAvAHH'], ['AvgAHA', 'BbAvAHA']], betfairExchange: [['BFEAHH'], ['BFEAHA']] }),
        asianHandicapClosing: ah(['AHCh'], { bet365: [['B365CAHH'], ['B365CAHA']], pinnacle: [['PCAHH'], ['PCAHA']], max: [['MaxCAHH'], ['MaxCAHA']], avg: [['AvgCAHH'], ['AvgCAHA']], betfairExchange: [['BFECAHH'], ['BFECAHA']] }),
        ...implied(close, open),
    };
}
function implied(close, open) {
    const order = [['pinnacle', close.pinnacle, 'closing'], ['betfairExchange', close.betfairExchange, 'closing'], ['avg', close.avg, 'closing'], ['pinnacle', open.pinnacle, 'opening'], ['avg', open.avg, 'opening'], ['bet365', open.bet365, 'opening']];
    for (const [src, o, when] of order) { const p = noVig(o); if (p) return { impliedProbability: p, impliedProbabilitySource: `${src} ${when}` }; }
    return { impliedProbability: null, impliedProbabilitySource: null };
}
function extraRow(r, cc) {
    const hg = num(r.HG); const ag = num(r.AG);
    const close = {
        pinnacle: trip(r, ['PSCH', 'PH'], ['PSCD', 'PD'], ['PSCA', 'PA']),
        bet365: trip(r, ['B365CH'], ['B365CD'], ['B365CA']),
        betfairExchange: trip(r, ['BFECH'], ['BFECD'], ['BFECA']),
        max: trip(r, ['MaxCH'], ['MaxCD'], ['MaxCA']),
        avg: trip(r, ['AvgCH'], ['AvgCD'], ['AvgCA']),
    };
    const c = Object.fromEntries(Object.entries(close).filter(([, v]) => v));
    const sy = String(r.Season || '').match(/^(\d{4})/)?.[1];
    return {
        country: r.Country || EXTRA[cc], league: r.League || null, division: cc,
        season: r.Season ? String(r.Season).replace(/^(\d{4})\/(\d{4})$/, '$1/$2') : null, _startYear: sy ? Number(sy) : null,
        date: parseDate(r.Date), time: r.Time || null,
        homeTeam: r.Home || null, awayTeam: r.Away || null, homeGoals: hg, awayGoals: ag, result: r.Res || null,
        halfTimeHomeGoals: null, halfTimeAwayGoals: null, halfTimeResult: null,
        totalGoals: hg !== null && ag !== null ? hg + ag : null,
        over2_5: hg !== null && ag !== null ? hg + ag > 2.5 : null,
        bothTeamsScored: hg !== null && ag !== null ? hg > 0 && ag > 0 : null,
        odds1x2Opening: null, odds1x2Closing: Object.keys(c).length ? c : null,
        overUnder25Opening: null, overUnder25Closing: null, asianHandicapOpening: null, asianHandicapClosing: null,
        ...implied(close, {}),
    };
}

// ---------- run ----------
const divs = [];
for (const l of arr(leagues)) {
    const u = l.toUpperCase();
    const d = MAIN[u] ? u : EXTRA[u] ? u : ALIASES[l.toLowerCase()];
    if (!d) { log.warning(`Unknown league "${l}". Codes: ${Object.keys(MAIN).join(', ')}, ${Object.keys(EXTRA).join(', ')}`); continue; }
    if (!divs.includes(d)) divs.push(d);
}
if (!divs.length) {
    await Actor.pushData({ note: 'No known league. Use names (Premier League, La Liga, Serie A, Bundesliga, MLS...) or codes (E0, SP1, I1, D1, F1, USA, BRA...). Not charged.' });
    await Actor.exit();
}
const minYear = Math.min(...startYears); const yearSet = new Set(startYears);

let pushed = 0;
const keep = (row) => {
    if (fromD && (!row.date || row.date < fromD)) return false;
    if (toD && (!row.date || row.date > toD)) return false;
    if (teamFilters.length) {
        const hay = `${row.homeTeam || ''} | ${row.awayTeam || ''}`.toLowerCase();
        if (!teamFilters.some((f) => hay.includes(f))) return false;
    }
    return true;
};
let buffer = [];
async function flush() {
    if (!buffer.length) return;
    const batch = buffer; buffer = [];
    await Actor.pushData(batch);
    const before = pushed; pushed += batch.length;
    const billable = pushed - Math.max(before, FREE_TIER_ROWS);
    if (billable > 0) {
        try { await Actor.charge({ eventName: 'match', count: billable }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}
async function emit(row, raw) {
    if (includeAllBookmakers) row.allOddsColumns = Object.fromEntries(Object.entries(raw).filter(([k, v]) => /^(B365|BFD|BFE|BMGM|BV|BW|CL|LB|PS|P[CA>< ]|Max|Avg|Bb|IW|WH|VC|SJ|GB|SB|SO|SY|PP|SKB|1XB|AH)/.test(k) && num(v) !== null).map(([k, v]) => [k, num(v)]));
    row.scrapedAt = new Date().toISOString();
    buffer.push(row);
    if (buffer.length >= 200) await flush();
}

outer:
for (const d of divs) {
    if (MAIN[d]) {
        for (const y of [...startYears].sort((a, b) => b - a)) {
            const text = await getCsv(`/mmz4281/${code(y)}/${d}.csv`);
            if (!text) { log.info(`${d} ${y}/${y + 1}: no file`); continue; }
            const rows = parseCsv(text).filter((r) => r.HomeTeam || r.Home).map((r) => [mainRow(r, d, y), r]).filter(([row]) => keep(row));
            rows.sort((a, b) => String(b[0].date).localeCompare(String(a[0].date)) || String(a[0].homeTeam).localeCompare(String(b[0].homeTeam)));
            log.info(`${MAIN[d][1]} ${y}/${y + 1}: ${rows.length} matches`);
            for (const [row, raw] of rows) { if (pushed + buffer.length >= cap) break outer; await emit(row, raw); }
        }
    } else {
        const text = await getCsv(`/new/${d}.csv`);
        if (!text) { log.warning(`${d}: no file`); continue; }
        const rows = parseCsv(text).map((r) => [extraRow(r, d), r])
            .filter(([row]) => row._startYear !== null && row._startYear >= minYear && (yearSet.has(row._startYear) || yearSet.has(row._startYear - 1)))
            .filter(([row]) => keep(row));
        rows.sort((a, b) => String(b[0].date).localeCompare(String(a[0].date)) || String(a[0].homeTeam).localeCompare(String(b[0].homeTeam)));
        log.info(`${EXTRA[d]}: ${rows.length} matches`);
        for (const [row, raw] of rows) { delete row._startYear; if (pushed + buffer.length >= cap) break outer; await emit(row, raw); }
    }
}

await flush();
if (!pushed) await Actor.pushData({ note: 'No matches for these leagues, seasons, dates and teams. Seasons look like 2025/2026; most main leagues go back to 1993/94, odds to 2000/01 and closing odds to 2019/20. Not charged.' });
await Actor.setValue('SUMMARY', { leagues: divs, seasons: startYears.map((y) => `${y}/${y + 1}`), returned: pushed });
log.info(`Done. ${pushed} matches.`);
await Actor.exit();
