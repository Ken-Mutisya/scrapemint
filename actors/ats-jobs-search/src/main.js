// ATS Jobs Search: one job search across the public career sites of thousands
// of companies on Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable,
// Recruitee and Personio.
//
// Strategy
// --------
// Every one of these ATSes serves its job boards from a public, keyless API.
// src/directories/<ats>.json lists the live boards on each (built by
// scripts/build-directory.mjs from the Common Crawl URL index, checked live),
// so a search with no company list runs across every board in them. A company
// list (names or career-site URLs) narrows it to those boards. ats.js turns
// each ATS's listing into one row shape; filters, salary and billing never
// care where a job came from.
//
// Live at run time, not a stored database: each run reads the boards as they
// are, so a closed job is gone and a new one is there the minute it posts.
//
// Pay per event
// -------------
//   job_row        ($0.004) a job with its full description
//   job_row_basic  ($0.002) a job without description (includeDescription off)
// No per-run free allowance: buyers schedule searches with onlyNew. A run that
// returns no jobs is free.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FETCHERS } from './ats.js';
import { HttpError } from './http.js';
import { parseWorkdayUrl } from './workday-url.js';

const ALL_ATS = Object.keys(FETCHERS);
// Boards read at once, per platform. Each platform has its own workers, so
// one that rate-limits (Workable: 72 of 167 boards took HTTP 429 in a
// directory-wide run) only slows itself; with one shared pool its retries held
// every worker and the run took 28 minutes.
const BOARD_CONCURRENCY = { greenhouse: 10, ashby: 8, workday: 8, smartrecruiters: 6, personio: 6, lever: 6, recruitee: 4, workable: 2 };
const DETAIL_CONCURRENCY = 6;

const DIRS = Object.fromEntries(ALL_ATS.map((a) => {
    try { return [a, JSON.parse(readFileSync(new URL(`./directories/${a}.json`, import.meta.url), 'utf8'))]; } catch { return [a, []]; }
}));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchText = '',
    strictKeyword = true,
    matchDescription = false,
    platforms = [],
    companies = [],
    locations = [],
    remoteOnly = false,
    postedWithinDays = 0,
    includeDescription = true,
    onlyNew = false,
    maxJobsPerCompany = 100,
    maxJobs = 500,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const keyword = String(searchText || '').trim();
const atsList = listOf(platforms).map((p) => p.toLowerCase()).filter((p) => ALL_ATS.includes(p) || log.warning(`Unknown platform ${p}; ignored.`));
const useAts = atsList.length ? atsList : ALL_ATS;
const locQ = listOf(locations).map((s) => s.toLowerCase());
const withinDays = Math.max(0, Number(postedWithinDays) || 0);
const perBoardCap = Math.max(1, Number(maxJobsPerCompany) || 100);
const totalCap = Math.max(1, Number(maxJobs) || 500);

// Workday's and SmartRecruiters' own search is loose ("data engineer" also
// returns "Regional Operations Manager"), and the others have none, so strict
// mode keeps a job only when every keyword word starts a word in its title
// (or its description, with matchDescription on).
const keywordWords = strictKeyword ? keyword.toLowerCase().split(/\s+/).filter(Boolean) : [];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keywordRes = keywordWords.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, 'u'));
const hasAllWords = (hay) => keywordRes.every((re) => re.test(String(hay || '').toLowerCase()));

// ---------- Resolve boards ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const boards = new Map();
const unresolved = [];
const addBoard = (ats, b, label) => {
    if (!useAts.includes(ats)) return;
    const key = `${ats}|${String(b.tenant).toLowerCase()}|${b.site || ''}|${b.region || ''}`;
    if (boards.has(key)) return;
    const known = DIRS[ats].find((d) => d.tenant.toLowerCase() === String(b.tenant).toLowerCase() && (!b.site || d.site === b.site));
    boards.set(key, { ats, ...known, ...b, ...(known?.name && !b.name ? { name: known.name } : {}), label });
};

function boardFromUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    const first = segs[0] ? decodeURIComponent(segs[0]) : '';
    const wd = parseWorkdayUrl(raw);
    if (wd) return ['workday', wd];
    if (/(^|\.)greenhouse\.io$/.test(host)) {
        const t = u.searchParams.get('for') || (host.startsWith('boards-api') ? segs[2] : first);
        return t && t !== 'embed' ? ['greenhouse', { tenant: t.toLowerCase() }] : null;
    }
    if (/^jobs(\.eu)?\.lever\.co$/.test(host) && first) return ['lever', { tenant: first.toLowerCase(), ...(host.includes('.eu.') ? { region: 'eu' } : {}) }];
    if (host === 'jobs.ashbyhq.com' && first) return ['ashby', { tenant: first }];
    if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && first) return ['smartrecruiters', { tenant: first }];
    if (host === 'apply.workable.com' && first) return ['workable', { tenant: first.toLowerCase() }];
    const rc = host.match(/^([a-z0-9-]+)\.recruitee\.com$/);
    if (rc) return ['recruitee', { tenant: rc[1] }];
    const px = host.match(/^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/);
    if (px) return ['personio', { tenant: px[1], region: px[2] }];
    return null;
}

// A name the directories do not know is probed live on the ATSes whose boards
// live at a predictable slug.
async function probeName(name) {
    const slug = norm(name);
    if (!slug) return [];
    const tries = {
        greenhouse: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        lever: `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
        ashby: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        recruitee: `https://${slug}.recruitee.com/api/offers/`,
        smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
        workable: `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
    };
    const hits = await Promise.all(Object.entries(tries).filter(([a]) => useAts.includes(a)).map(async ([ats, url]) => {
        try {
            const post = ats === 'workable';
            const r = await fetch(url, { method: post ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(post ? { 'Content-Type': 'application/json' } : {}) }, body: post ? '{}' : undefined, signal: AbortSignal.timeout(15_000) });
            if (!r.ok) return null;
            const j = await r.json();
            const n = Array.isArray(j) ? j.length : (j.jobs?.length ?? j.offers?.length ?? j.totalFound ?? j.total ?? 0);
            return n > 0 ? ats : null;
        } catch { return null; }
    }));
    return hits.filter(Boolean).map((ats) => [ats, { tenant: slug }]);
}

const companyInputs = listOf(companies);
for (const raw of companyInputs) {
    const tagged = raw.match(/^([a-z]+):(.+)$/i);
    if (tagged && ALL_ATS.includes(tagged[1].toLowerCase())) {
        addBoard(tagged[1].toLowerCase(), { tenant: tagged[2].trim() }, raw);
        continue;
    }
    if (/^https?:\/\//i.test(raw)) {
        const r = boardFromUrl(raw);
        if (r) addBoard(r[0], r[1], raw); else unresolved.push({ input: raw, reason: 'not a career-site URL on a supported ATS' });
        continue;
    }
    const q = norm(raw);
    let hit = false;
    for (const ats of useAts) {
        const matches = DIRS[ats].filter((d) => norm(d.tenant) === q || norm(d.name) === q);
        // A Workday tenant can run several sites; the busiest one is the public board.
        const pick = ats === 'workday' ? matches.sort((a, b) => b.jobs - a.jobs).slice(0, 1) : matches;
        for (const m of pick) { addBoard(ats, m, raw); hit = true; }
    }
    if (!hit) {
        const probed = await probeName(raw);
        for (const [ats, b] of probed) addBoard(ats, b, raw);
        if (!probed.length) unresolved.push({ input: raw, reason: 'not found on any supported ATS; pass its career-site URL' });
    }
}

const searchAll = companyInputs.length === 0;
if (searchAll) {
    if (!keyword && !withinDays) {
        await failInput('With no companies listed, the search runs across every company in the directories, so it needs a keyword (searchText) or postedWithinDays to keep the run bounded.');
    }
    for (const ats of useAts) {
        const seenTenant = new Set();
        for (const d of DIRS[ats]) {
            if (!d.jobs) continue;
            // One Workday site per tenant: the rest are internal or campus boards.
            if (ats === 'workday') { if (seenTenant.has(d.tenant)) continue; seenTenant.add(d.tenant); }
            addBoard(ats, d, d.name || d.tenant);
        }
    }
}

if (!boards.size) {
    await failInput(unresolved.length
        ? `No job board resolved: ${unresolved.map((u) => `${u.input} (${u.reason})`).join('; ')}.`
        : 'No job boards to read for the chosen platforms.');
}
for (const u of unresolved) log.warning(`Skipped ${u.input}: ${u.reason}.`);
const perAts = {};
for (const b of boards.values()) perAts[b.ats] = (perAts[b.ats] || 0) + 1;
log.info(`Reading ${boards.size} job board(s) (${Object.entries(perAts).map(([a, n]) => `${a} ${n}`).join(', ')})${keyword ? ` for "${keyword}"` : ''}${withinDays ? `, posted within ${withinDays} day(s)` : ''}.`);

// ---------- Only-new state ----------

const filterKey = createHash('sha1').update(JSON.stringify({ b: [...boards.keys()].sort(), keyword, strictKeyword, matchDescription, locQ, remoteOnly, withinDays })).digest('hex').slice(0, 12);
const store = onlyNew ? await Actor.openKeyValueStore('ats-jobs-search-state') : null;
const stateName = `SEEN_${filterKey}`;
const seen = new Set(store ? ((await store.getValue(stateName)) || []) : []);
const firstRun = onlyNew && seen.size === 0;

// ---------- Filters ----------

function keepEarly(j) {
    if (keywordWords.length && !hasAllWords(j.title) && !(matchDescription && j.description && hasAllWords(j.description))) {
        // A title miss can still match on a description we have not fetched yet.
        if (!(matchDescription && j.description == null && j._detail)) return false;
    }
    if (withinDays && j.postedDaysAgo != null && j.postedDaysAgo > withinDays) return false;
    if (remoteOnly && j.remote === false && !j._detail) return false;
    if (locQ.length && !matchesLocation(j) && !(j._detail && /^\d+ locations?$/i.test(String(j.location || '').trim()))) return false;
    return true;
}

function matchesLocation(j) {
    const hay = [j.location, ...(j.additionalLocations || []), j.country, j.workplaceType].join(' ').toLowerCase();
    return locQ.some((q) => hay.includes(q) || (q === 'remote' && j.remote));
}

function keepFinal(j) {
    if (keywordWords.length && !hasAllWords(j.title) && !(matchDescription && hasAllWords(j.description))) return false;
    if (withinDays && j.postedDaysAgo != null && j.postedDaysAgo > withinDays) return false;
    if (remoteOnly && !j.remote) return false;
    if (locQ.length && !matchesLocation(j)) return false;
    return true;
}

// ---------- Run ----------

let pushed = 0;
let charged = 0;
let stopAll = false;
const returned = [];
const boardStats = [];

async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length && !stopAll) await fn(items[i++]);
    }));
}

async function emit(j) {
    if (stopAll || pushed >= totalCap) { stopAll = true; return false; }
    if (!keepFinal(j)) return false;
    const key = `${j.ats}|${String(j.boardTenant).toLowerCase()}|${j.jobId || j.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const { _detail, boardTenant, postedText, ...row } = j;
    const withDesc = includeDescription && row.description != null;
    if (!includeDescription) delete row.description;
    // Counted before the await so concurrent emits cannot overshoot maxJobs.
    pushed += 1;
    await Actor.pushData({ ...row, atsBoard: boardTenant, postedText: postedText || undefined, scrapedAt: new Date().toISOString() });
    returned.push(key);
    try {
        const r = await Actor.charge({ eventName: withDesc ? 'job_row' : 'job_row_basic' });
        charged += 1;
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stopAll = true; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    return true;
}

// Every platform runs in parallel with its own workers, so a run capped by
// maxJobs samples every ATS instead of filling up on whichever directory is
// read first (a 100-job prefill run once came back all Greenhouse).
const byPlatform = {};
for (const b of boards.values()) (byPlatform[b.ats] ||= []).push(b);
const done = {};
const progress = setInterval(() => {
    log.info(`Progress: ${pushed} job(s) so far. Boards read: ${Object.entries(byPlatform).map(([a, l]) => `${a} ${done[a] || 0}/${l.length}`).join(', ')}.`);
}, 60_000);
progress.unref?.();

// A platform that rate-limits hard (Workable) gets PLATFORM_BUDGET_MS to start
// boards; after that it stops picking up new ones, and the boards it did not
// reach are named in the summary instead of holding the run open.
const PLATFORM_BUDGET_MS = 8 * 60_000;
const runStart = Date.now();
// The budget stops new boards, not ones in flight: a Workday board splitting
// thousands of loose matches, or a Workable board in 429 backoff, held a
// directory-wide run open for 15+ minutes after everything else had finished.
// Two minutes past the budget the run saves what it has and exits; boards
// still in flight are named in the summary. Named-company runs are left alone.
const HARD_STOP_MS = PLATFORM_BUDGET_MS + 2 * 60_000;
const hardStop = searchAll ? setTimeout(() => {
    log.warning('Time budget reached with boards still in flight; finishing with the jobs found so far.');
    finish(true);
}, HARD_STOP_MS) : null;
hardStop?.unref?.();
await Promise.all(Object.entries(byPlatform).map(([ats, list]) => pool(list, BOARD_CONCURRENCY[ats] || 4, async (b) => {
    if (searchAll && Date.now() - runStart > PLATFORM_BUDGET_MS) return;
    await readBoard(b);
})));
clearInterval(progress);

async function readBoard(b) {
    const stat = { ats: b.ats, company: b.name || b.label || b.tenant, board: b.tenant, listed: 0, returned: 0 };
    boardStats.push(stat);
    const f = FETCHERS[b.ats];
    try {
        const jobs = await f.list(b, { keyword, withinDays, budget: perBoardCap * 20 });
        stat.listed = jobs.length;
        const keep = jobs.filter((j) => keepEarly(j) && !seen.has(`${j.ats}|${String(j.boardTenant).toLowerCase()}|${j.jobId || j.url}`));
        keep.sort((a, c) => (a.postedDaysAgo ?? 999) - (c.postedDaysAgo ?? 999));
        let n = 0;
        await pool(keep, f.describe && (includeDescription || matchDescription || remoteOnly || locQ.length) ? DETAIL_CONCURRENCY : 1, async (j) => {
            // Reserve the slot before the detail call so concurrent jobs cannot overshoot.
            if (n >= perBoardCap) return;
            n += 1;
            const needDetail = f.describe && j.description == null
                && (includeDescription || matchDescription || (remoteOnly && !j.remote) || (locQ.length && !matchesLocation(j)));
            if (needDetail) {
                try { await f.describe(j); } catch (err) { log.debug(`${b.ats}/${b.tenant} detail: ${err?.message}`); }
            }
            if (!(await emit(j))) n -= 1;
        });
        stat.returned = n;
    } catch (err) {
        stat.error = err instanceof HttpError && err.status === 404 ? 'board not found' : String(err?.message || err);
        log.debug(`${b.ats}/${b.tenant}: ${stat.error}`);
    }
    done[b.ats] = (done[b.ats] || 0) + 1;
    stat.finished = true;
}

clearTimeout(hardStop);
await finish(false);

async function finish(cutShort) {
    if (finish.started) return;
    finish.started = true;
    stopAll = true;
    if (store) {
        const prior = (await store.getValue(stateName)) || [];
        await store.setValue(stateName, [...new Set([...prior, ...returned])].slice(-200000));
    }

    const failed = boardStats.filter((x) => x.error);
    if (!pushed && (!onlyNew || firstRun)) {
        await Actor.pushData({
            rowType: 'note',
            note: `No jobs matched across ${boards.size} job board(s)${onlyNew ? ' that earlier runs had not already returned' : ''}. `
                + `${unresolved.length ? `Not resolved: ${unresolved.map((u) => u.input).join(', ')}. ` : ''}Loosen the filters. Not charged.`,
        });
    }

    const byAts = {};
    for (const s of boardStats) {
        const a = (byAts[s.ats] ||= { boards: 0, jobsListed: 0, jobsReturned: 0, failed: 0 });
        a.boards += 1; a.jobsListed += s.listed; a.jobsReturned += s.returned; if (s.error) a.failed += 1;
    }
    if (cutShort) {
        for (const st of boardStats.filter((x) => !x.finished && !x.error)) {
            byAts[st.ats].unfinished = (byAts[st.ats].unfinished || 0) + 1;
        }
    }
    // Boards never started: skipped after the budget, or still queued when the
    // run was cut short.
    for (const [ats, list] of Object.entries(byPlatform)) {
        const n = list.length - (byAts[ats]?.boards || 0);
        if (n <= 0) continue;
        (byAts[ats] ||= { boards: 0, jobsListed: 0, jobsReturned: 0, failed: 0 }).notReachedInTime = n;
        log.warning(`${ats}: ${n} of ${list.length} board(s) not read within the ${Math.round(HARD_STOP_MS / 60000)}-minute budget for a search across every company; narrow it with platforms or companies to read them all.`);
    }
    await Actor.setValue('SUMMARY', {
        jobs: pushed,
        charged,
        byPlatform: byAts,
        unresolved,
        companies: boardStats.filter((s) => s.returned || s.error || !searchAll),
    });
    log.info(`Done. ${pushed} job(s) from ${boards.size} board(s), ${charged} charged. ${Object.entries(byAts).map(([a, s]) => `${a}: ${s.jobsReturned} from ${s.boards}${s.failed ? ` (${s.failed} failed)` : ''}`).join('; ')}.`);
    await Actor.exit();
}

async function failInput(msg) {
    log.error(msg);
    await Actor.pushData({ rowType: 'note', note: `${msg} Not charged.` });
    await Actor.exit();
}
