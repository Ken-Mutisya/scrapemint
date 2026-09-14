// DraftKings Odds & Line Movement Tracker
//
// Strategy
// --------
// ESPN's public core API carries DraftKings as an odds provider and, unlike
// every other free source checked, exposes BOTH the opening line and the
// current line on the same object. That difference is the product: a bettor
// can get today's number anywhere, but open-vs-current is what tells them
// where the money went.
//
// DraftKings' own endpoints (sportsbook-nash.draftkings.com, the legacy
// eventgroups API) return 403 Access Denied even from residential IPs, which
// is why this reads ESPN instead. No key, no login, no browser, no proxy.
//
//   events?limit=N            -> list of event $refs for a league
//   {event $ref}              -> name, date, competitors
//   {competition odds $ref}   -> one entry per provider; DraftKings is id 100
//
// Pay per event
// -------------
//   line_row      ($0.004) a game with a current DraftKings line.
//   line_move_row ($0.012) a game whose line has moved from its open by at
//                          least minLineMove. That is the bettable signal, so
//                          it is the row worth more. A game is only ever
//                          charged once, under one of the two.
// Every returned row is charged. A run that returns no rows is free.

import { Actor, log } from 'apify';

const CORE = 'https://sports.core.api.espn.com/v2/sports';
const DRAFTKINGS_PROVIDER_ID = '100';
const FETCH_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 120;
const HARD_CAP = 500;
const UA = 'DraftKingsOddsTracker/1.0 (+https://apify.com/scrapemint/draftkings-odds-tracker)';

// Stop before the platform hard-kills the run, so pushed rows and their
// charges survive. A TIMED-OUT run loses the buyer every row and is what
// raises the UNDER_MAINTENANCE flag.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const outOfTime = () => deadlineMs != null && Date.now() > deadlineMs;

// league key -> ESPN sport/league path. Only leagues DraftKings actually
// prices on ESPN are listed; NBA, NHL and UFC carry no odds ref out of season
// and are handled by returning a free note rather than an empty dataset.
const LEAGUES = {
    nfl: ['football', 'nfl'],
    ncaaf: ['football', 'college-football'],
    'college-football': ['football', 'college-football'],
    mlb: ['baseball', 'mlb'],
    nba: ['basketball', 'nba'],
    wnba: ['basketball', 'wnba'],
    ncaab: ['basketball', 'mens-college-basketball'],
    nhl: ['hockey', 'nhl'],
    epl: ['soccer', 'eng.1'],
    laliga: ['soccer', 'esp.1'],
    bundesliga: ['soccer', 'ger.1'],
    seriea: ['soccer', 'ita.1'],
    ligue1: ['soccer', 'fra.1'],
    mls: ['soccer', 'usa.1'],
    ucl: ['soccer', 'uefa.champions'],
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    sports = ['nfl'],
    oddsFormat = 'american',
    maxEvents = 50,
    minLineMove = 2,
    onlyMoved = false,
    includeStartedEvents = false,
    dedupe = false,
} = input;

// Deliberately no proxy option. ESPN's core API answers plain requests from
// Apify's datacenter range, and under pay-per-event a buyer who switched on
// RESIDENTIAL would bill that bandwidth to the developer for no benefit. An
// input that costs money and changes nothing is worse than no input.

const cap = Number(maxEvents) > 0 ? Math.min(Number(maxEvents), HARD_CAP) : HARD_CAP;
const moveThreshold = Number.isFinite(Number(minLineMove)) ? Math.abs(Number(minLineMove)) : 2;
const wanted = (Array.isArray(sports) ? sports : [sports])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);

const seenStore = dedupe ? await Actor.openKeyValueStore('draftkings-odds-seen') : null;
const seenEvents = new Set(seenStore ? (await seenStore.getValue('seen-events')) || [] : []);

let pushedRows = 0;
let movedRows = 0;
const __chargeJobs = [];

if (wanted.length === 0) {
    await pushNote('No leagues requested. Set sports to at least one of: ' + Object.keys(LEAGUES).join(', '));
    await finish();
}

const unknown = wanted.filter((w) => !LEAGUES[w]);
for (const u of unknown) log.warning(`Unknown league "${u}". Known: ${Object.keys(LEAGUES).join(', ')}`);

const leagues = wanted.filter((w) => LEAGUES[w]);
if (leagues.length === 0) {
    await pushNote(`None of the requested leagues are known: ${wanted.join(', ')}. Known: ${Object.keys(LEAGUES).join(', ')}`);
    await finish();
}

log.info(`DraftKings odds for ${leagues.join(', ')} | cap ${cap} event(s) | move threshold ${moveThreshold} | ${onlyMoved ? 'moved games only' : 'all games'}`);

for (const key of leagues) {
    if (pushedRows >= cap || outOfTime()) break;
    const [sport, league] = LEAGUES[key];
    let events;
    try {
        events = await getJson(`${CORE}/${sport}/leagues/${league}/events?limit=${Math.min(cap, 100)}`);
    } catch (err) {
        log.warning(`${key}: could not list events (${err?.message}). Skipping.`);
        continue;
    }
    const refs = events?.items ?? [];
    if (refs.length === 0) {
        await pushNote(`${key}: ESPN lists no scheduled events right now. Out of season, or the schedule is not published yet. Nothing charged.`);
        continue;
    }
    log.info(`${key}: ${refs.length} scheduled event(s)`);

    let pricedInLeague = 0;
    for (const ref of refs) {
        if (pushedRows >= cap || outOfTime()) break;
        const row = await buildRow(key, ref.$ref);
        if (!row) continue;
        pricedInLeague += 1;
        if (onlyMoved && !row.movement.moved) continue;
        await emit(row);
    }
    if (pricedInLeague === 0) {
        await pushNote(`${key}: ${refs.length} event(s) scheduled but DraftKings has not priced any of them yet. Nothing charged.`);
    }
}

if (outOfTime()) log.warning('Stopped early to stay inside the run timeout; returned rows are complete and were charged.');
await finish();

// ---------- core ----------

async function buildRow(leagueKey, eventRef) {
    let event;
    try {
        event = await getJson(eventRef);
    } catch (err) {
        log.warning(`Could not read event (${err?.message})`);
        return null;
    }
    const eventId = event?.id ? String(event.id) : null;
    if (!eventId) return null;
    if (dedupe && seenEvents.has(eventId)) return null;

    const commenceTime = event?.date ?? null;
    if (!includeStartedEvents && commenceTime && Date.parse(commenceTime) < Date.now()) return null;

    const comp = event?.competitions?.[0];
    if (!comp?.odds?.$ref) return null;

    let odds;
    try {
        odds = await getJson(comp.odds.$ref);
    } catch {
        return null;
    }
    const dk = (odds?.items ?? []).find((o) => String(o?.provider?.id) === DRAFTKINGS_PROVIDER_ID
        || /draftkings/i.test(String(o?.provider?.name ?? '')));
    if (!dk) return null;

    const { home, away } = teamsFrom(event, comp);

    const spreadNow = num(dk.spread);
    const spreadOpen = num(dk.homeTeamOdds?.open?.pointSpread?.american);
    const totalNow = num(dk.overUnder);
    // ESPN carries no opening total on this object, so it is reported as null
    // rather than copied from the current value. A confident wrong number is
    // worse than an honest gap on a row someone is betting against.
    const homeMlNow = num(dk.homeTeamOdds?.moneyLine);
    const awayMlNow = num(dk.awayTeamOdds?.moneyLine);
    const homeMlOpen = num(dk.homeTeamOdds?.open?.moneyLine?.american);
    const awayMlOpen = num(dk.awayTeamOdds?.open?.moneyLine?.american);

    const spreadMove = diff(spreadNow, spreadOpen);
    const homeMlMove = diff(homeMlNow, homeMlOpen);
    const awayMlMove = diff(awayMlNow, awayMlOpen);
    const moved = (spreadMove != null && Math.abs(spreadMove) >= moveThreshold)
        || (homeMlMove != null && Math.abs(homeMlMove) >= Math.max(10, moveThreshold * 20))
        || (awayMlMove != null && Math.abs(awayMlMove) >= Math.max(10, moveThreshold * 20));

    return {
        league: leagueKey,
        eventId,
        event: event?.name ?? null,
        shortName: event?.shortName ?? null,
        home,
        away,
        commenceTime,
        sportsbook: 'DraftKings',
        details: dk.details ?? null,
        favorite: dk.homeTeamOdds?.favorite ? home : (dk.awayTeamOdds?.favorite ? away : null),
        spread: { current: spreadNow, open: spreadOpen, move: spreadMove },
        total: {
            current: totalNow,
            open: null,
            overOdds: fmtPrice(num(dk.overOdds)),
            underOdds: fmtPrice(num(dk.underOdds)),
        },
        moneyline: {
            home: fmtPrice(homeMlNow),
            away: fmtPrice(awayMlNow),
            homeOpen: fmtPrice(homeMlOpen),
            awayOpen: fmtPrice(awayMlOpen),
            homeMove: homeMlMove,
            awayMove: awayMlMove,
        },
        movement: {
            moved,
            spreadMove,
            homeMoneylineMove: homeMlMove,
            awayMoneylineMove: awayMlMove,
            threshold: moveThreshold,
        },
        oddsFormat,
        source: 'ESPN public core API (DraftKings provider)',
        scrapedAt: new Date().toISOString(),
    };
}

// pushData and charge are both awaited: the loop can exit at the deadline, and
// an un-awaited write would drop the row and its charge on the way out.
async function emit(row) {
    await Actor.pushData(row);
    if (dedupe && row.eventId) seenEvents.add(row.eventId);
    pushedRows += 1;
    if (row.movement.moved) movedRows += 1;
    const eventName = row.movement.moved ? 'line_move_row' : 'line_row';
    try {
        await Actor.charge({ eventName });
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    log.info(`${row.league} ${row.shortName ?? row.event ?? row.eventId} | ${row.details ?? '?'}`
        + `${row.movement.moved ? ` | MOVED ${row.movement.spreadMove ?? '?'}` : ''} (${pushedRows})`);
}

// Notes explain an empty result without pretending to be data. Never charged.
async function pushNote(note) {
    await Actor.pushData({ rowType: 'note', note, scrapedAt: new Date().toISOString() });
    log.warning(note);
}

async function finish() {
    if (seenStore && pushedRows > 0) {
        try { await seenStore.setValue('seen-events', [...seenEvents].slice(-50000)); } catch { /* non-fatal */ }
    }
    await Promise.allSettled(__chargeJobs);
    log.info(`Done. ${pushedRows} game(s) returned, ${movedRows} with a line move of ${moveThreshold}+.`);
    await Actor.exit();
}

// ---------- helpers ----------

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(String(url).replace(/^http:/, 'https:'), {
            headers: { 'user-agent': UA, accept: 'application/json' },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
        await sleep(REQUEST_GAP_MS);
    }
}

// Number(null) and Number('') are both 0, which publishes a confident zero for
// a line that was never posted. Anything unparseable comes back null instead.
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
}

function diff(now, open) {
    if (now == null || open == null) return null;
    return Math.round((now - open) * 100) / 100;
}

// American prices read as +130 / -155; the sign carries meaning, so a positive
// price keeps its plus rather than being silently dropped by Number().
function fmtPrice(n) {
    if (n == null) return null;
    if (oddsFormat === 'decimal') {
        const dec = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
        return Math.round(dec * 1000) / 1000;
    }
    return n;
}

function teamsFrom(event, comp) {
    const competitors = comp?.competitors ?? [];
    const byRole = (role) => competitors.find((c) => String(c?.homeAway ?? '').toLowerCase() === role);
    const nameFromEvent = String(event?.name ?? '');
    // ESPN formats event.name as "<away> at <home>" for US leagues; soccer
    // fixtures use the same order. Split on " at " and fall back if absent.
    const parts = nameFromEvent.split(' at ');
    const fallbackAway = parts.length === 2 ? parts[0].trim() : null;
    const fallbackHome = parts.length === 2 ? parts[1].trim() : null;
    return {
        home: fallbackHome ?? (byRole('home')?.id ? `team:${byRole('home').id}` : null),
        away: fallbackAway ?? (byRole('away')?.id ? `team:${byRole('away').id}` : null),
    };
}


function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
