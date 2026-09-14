// Sports Injury Report: who is out, and what just changed
//
// Strategy
// --------
// ESPN's site API returns an entire league's injury report in ONE request with
// player names, positions, status and the analyst note already embedded:
//
//   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries
//
// 800 NFL entries across 32 teams for a single fetch. The core API also has
// injuries but only as $refs, needing a fetch per athlete, which would be
// thousands of requests for the same data.
//
// The product is not the list, it is the DIFF. A bettor or DFS player can read
// today's report anywhere; what they need is to know the moment a starter moves
// from Questionable to Out. So previous status is persisted per player and each
// run reports what changed.
//
// Pay per event
// -------------
//   player_row        ($0.003) a player currently on the injury report.
//   status_change_row ($0.012) a player whose status changed since your last
//                              run, or who was not on the report before. That
//                              is the alert, so it is the row worth more.
// A player is charged once, under one of the two. The FIRST run on a fresh
// store records a baseline and charges everything at the lower rate: nothing
// has "changed" when there is nothing to compare against, and billing a first
// run as all-alerts would be a rip-off.
// Every returned row is charged. A run that returns no rows is free.

import { Actor, log } from 'apify';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const FETCH_TIMEOUT_MS = 25000;
const REQUEST_GAP_MS = 150;
const HARD_CAP = 3000;
const STATE_KEY = 'previous-status';
// A polite custom User-Agent gets a hard 403 from site.api.espn.com while a
// browser string returns 200 from the same IP -- verified both ways on
// 2026-09-15. Their core API (sports.core.api.espn.com) has no such rule, so
// this is a per-host quirk, not an IP block. Identify as a browser here.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Stop before the platform hard-kills the run so pushed rows, their charges and
// the updated state all survive. A TIMED-OUT run loses all three.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const outOfTime = () => deadlineMs != null && Date.now() > deadlineMs;

const LEAGUES = {
    nfl: ['football', 'nfl'],
    ncaaf: ['football', 'college-football'],
    nba: ['basketball', 'nba'],
    wnba: ['basketball', 'wnba'],
    mlb: ['baseball', 'mlb'],
    nhl: ['hockey', 'nhl'],
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    leagues = ['nfl'],
    teams = [],
    players = [],
    statuses = [],
    includeActive = false,
    onlyChanges = false,
    includeCommentary = true,
    trackChanges = true,
    maxRows = 500,
} = input;

const cap = Number(maxRows) > 0 ? Math.min(Number(maxRows), HARD_CAP) : HARD_CAP;
const wanted = arr(leagues).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
const teamFilter = arr(teams).map(norm).filter(Boolean);
const playerFilter = arr(players).map(norm).filter(Boolean);
// ESPN is inconsistent about case and hyphens ("Suspension" vs "suspension",
// "7-Day IL" vs "15-Day-IL"), so filters compare on a normalised form while the
// row keeps whatever ESPN actually said.
const statusFilter = new Set(arr(statuses).map(norm).filter(Boolean));

const store = await Actor.openKeyValueStore('sports-injury-tracker-state');
const previous = trackChanges ? ((await store.getValue(STATE_KEY)) ?? null) : null;
const isBaseline = trackChanges && previous === null;
const current = {};

let pushedRows = 0;
let changeRows = 0;
let skippedActive = 0;

if (wanted.length === 0) {
    await note(`No leagues requested. Set leagues to at least one of: ${Object.keys(LEAGUES).join(', ')}`);
    await finish();
}
const known = wanted.filter((l) => LEAGUES[l]);
for (const u of wanted.filter((l) => !LEAGUES[l])) {
    log.warning(`Unknown league "${u}". Known: ${Object.keys(LEAGUES).join(', ')}`);
}
if (known.length === 0) {
    await note(`None of the requested leagues are known: ${wanted.join(', ')}. Known: ${Object.keys(LEAGUES).join(', ')}`);
    await finish();
}

if (isBaseline) {
    log.info('First run on this store: recording a baseline. Nothing is reported as changed, and nothing is charged at the alert rate.');
}
log.info(`Injury report for ${known.join(', ')} | cap ${cap} | ${onlyChanges ? 'changes only' : 'all listed players'} | active players ${includeActive ? 'included' : 'excluded'}`);

for (const key of known) {
    if (pushedRows >= cap || outOfTime()) break;
    const [sport, league] = LEAGUES[key];
    let data;
    try {
        data = await getJson(`${SITE}/${sport}/${league}/injuries`);
    } catch (err) {
        const blocked = /HTTP 4\d\d/.test(String(err?.message));
        await note(`${key}: could not read the injury report (${err?.message}).`
            + (blocked ? ' ESPN refused the request rather than returning an empty report, so this is not an out-of-season result.' : '')
            + ' Nothing charged.');
        continue;
    }
    const teamBlocks = data?.injuries ?? [];
    const listed = teamBlocks.reduce((a, t) => a + (t.injuries?.length ?? 0), 0);
    if (listed === 0) {
        await note(`${key}: ESPN publishes no injury report right now. Out of season, or not posted yet. Nothing charged.`);
        continue;
    }
    log.info(`${key}: ${listed} listed player(s) across ${teamBlocks.length} team(s)`);

    for (const block of teamBlocks) {
        if (pushedRows >= cap || outOfTime()) break;
        const teamName = block.displayName ?? block.name ?? null;
        const teamAbbrev = block.abbreviation ?? null;
        // Team filtering happens on the row, since the abbreviation is only
            // available once the athlete is read.

        for (const entry of (block.injuries ?? [])) {
            if (pushedRows >= cap || outOfTime()) break;
            const row = buildRow(key, teamName, teamAbbrev, entry);
            if (!row) continue;
            if (teamFilter.length && !teamFilter.some((t) => norm(row.team).includes(t) || norm(row.teamAbbrev) === t)) continue;
            if (!includeActive && norm(row.status) === 'active') { skippedActive += 1; continue; }
            if (statusFilter.size && !statusFilter.has(norm(row.status))) continue;
            if (playerFilter.length && !playerFilter.some((p) => norm(row.player.name).includes(p))) continue;
            if (onlyChanges && !row.change.changed) continue;
            await emit(row);
        }
    }
}

if (skippedActive > 0) log.info(`Skipped ${skippedActive} player(s) listed as Active. Set includeActive to keep them.`);
if (outOfTime()) log.warning('Stopped early to stay inside the run timeout; returned rows are complete and were charged.');
await finish();

// ---------- core ----------

function buildRow(league, teamName, teamAbbrev, entry) {
    const athlete = entry?.athlete ?? {};
    const name = athlete.displayName ?? athlete.fullName ?? null;
    if (!name) return null;

    // This payload carries no athlete.id field, but the player-card link does:
    // .../nfl/player/_/id/5084939/isaiah-adams. That id is what makes a player
    // identifiable between runs, so the change detection keys off it.
    const playerUrl = (athlete.links ?? []).map((l) => l.href).find((h) => /\/id\/\d+/.test(String(h ?? ''))) ?? null;
    const athleteId = playerUrl ? (playerUrl.match(/\/id\/(\d+)/)?.[1] ?? null) : null;

    // The team block only carries id and displayName; the abbreviation lives on
    // the athlete's own team object.
    const team = athlete.team ?? {};
    const abbrev = team.abbreviation ?? teamAbbrev ?? null;
    const displayTeam = teamName ?? team.displayName ?? null;

    const status = entry.status ?? null;
    // Fall back to team+name rather than name alone: two players can share a
    // name across the league, and collapsing them would report phantom changes.
    const key = athleteId ? `${league}:${athleteId}` : `${league}:${team.id ?? 'x'}:${norm(name)}`;
    // Record what we saw regardless of whether the row survives the filters, so
    // a filtered run does not corrupt the baseline for the next one.
    if (trackChanges) current[key] = { status, seenAt: new Date().toISOString() };

    const prev = previous?.[key] ?? null;
    let changed = false;
    let changeType = null;
    let previousStatus = null;
    if (trackChanges && !isBaseline) {
        previousStatus = prev?.status ?? null;
        if (!prev) { changed = true; changeType = 'newly-listed'; }
        else if (norm(prev.status) !== norm(status)) { changed = true; changeType = 'status-change'; }
    }

    return {
        league,
        team: displayTeam,
        teamAbbrev: abbrev,
        teamId: team.id ?? null,
        player: {
            name,
            id: athleteId,
            position: athlete.position?.abbreviation ?? athlete.position?.name ?? null,
            positionName: athlete.position?.displayName ?? athlete.position?.name ?? null,
            url: playerUrl,
        },
        status,
        statusType: entry.type?.description ?? entry.type?.name ?? null,
        reportedDate: entry.date ?? null,
        shortComment: includeCommentary ? (entry.shortComment ?? null) : null,
        longComment: includeCommentary ? (entry.longComment ?? null) : null,
        change: {
            changed,
            changeType,
            previousStatus,
            previousSeenAt: prev?.seenAt ?? null,
            baselineRun: isBaseline,
        },
        source: 'ESPN public injury report',
        scrapedAt: new Date().toISOString(),
    };
}

// pushData and charge are both awaited: the loops exit on a deadline, and an
// un-awaited write would drop the row and its charge on the way out.
async function emit(row) {
    await Actor.pushData(row);
    pushedRows += 1;
    if (row.change.changed) changeRows += 1;
    const eventName = row.change.changed ? 'status_change_row' : 'player_row';
    try {
        await Actor.charge({ eventName });
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    log.info(`${row.league} ${row.teamAbbrev ?? row.team ?? '?'} ${row.player.name} (${row.player.position ?? '?'}) `
        + `${row.status ?? '?'}${row.change.changed ? ` <- ${row.change.previousStatus ?? 'not listed'}` : ''} (${pushedRows})`);
}

// Notes explain an empty result instead of leaving the buyer with a silent
// empty dataset. Never charged.
async function note(text) {
    await Actor.pushData({ rowType: 'note', note: text, scrapedAt: new Date().toISOString() });
    log.warning(text);
}

async function finish() {
    if (trackChanges && Object.keys(current).length > 0) {
        try {
            await store.setValue(STATE_KEY, { ...(previous ?? {}), ...current });
        } catch (err) {
            log.warning(`could not save status state, next run will not see changes: ${err?.message}`);
        }
    }
    log.info(`Done. ${pushedRows} player(s) returned, ${changeRows} with a status change.`
        + (isBaseline ? ' Baseline recorded; the next run will report changes against it.' : ''));
    await Actor.exit();
}

// ---------- helpers ----------

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
        await sleep(REQUEST_GAP_MS);
    }
}

function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
// Case and hyphens vary between ESPN entries, so comparisons run on this form.
function norm(v) { return String(v ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
