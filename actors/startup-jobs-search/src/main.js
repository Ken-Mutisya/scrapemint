// Startup Jobs Search: Roles at Top Tech Companies
//
// Strategy
// --------
// Distinct from our account-intelligence job actors (which need the buyer to
// name companies): this is DISCOVERY. The buyer gives keywords/location/remote
// and we search across a curated universe of ~50 top tech companies' public,
// keyless ATS boards, plus an optional keyless remote-jobs feed. One row per
// matching job. All sources verified reachable from Apify DC IPs.
//
//   Greenhouse: boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   Lever:      api.lever.co/v0/postings/{token}?mode=json  (bare array)
//   Ashby:      api.ashbyhq.com/posting-api/job-board/{token}
//   Remote feed: arbeitnow.com/api/job-board-api  ({data:[...]})
//
// Filtering is done locally after fetching each board once (these APIs have no
// server-side keyword search), so one board fetch can satisfy many keywords.
//
// Pay per event
// -------------
//   job_row per matching job. Boards that fail to load are logged, not
//   charged. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import { COMPANIES } from './companies.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REMOTE_FEED = 'https://www.arbeitnow.com/api/job-board-api';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const POOL_SIZE = 5;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [], location = '', remoteOnly = false,
    includeRemoteFeed = true, extraCompanies = [], maxRows = 500,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const kw = asTokens(keywords).map((s) => s.toLowerCase());
const loc = String(location || '').trim().toLowerCase();
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

const companies = [...COMPANIES];
for (const raw of asTokens(extraCompanies)) {
    const m = raw.toLowerCase().match(/^(greenhouse|lever|ashby)\s*[:/]\s*([a-z0-9._-]+)$/);
    if (m) companies.push([m[1], m[2], m[2]]);
    else log.warning(`Ignoring "${raw}" (use provider:token, e.g. greenhouse:airbnb).`);
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (res.status !== 200) return { status: res.status, json: null };
            const json = await res.json().catch(() => null);
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 2000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
}

const clean = (s) => s ? String(s).replace(/\s+/g, ' ').trim() : null;
const isRemoteText = (s) => /\bremote\b|work from home|wfh|anywhere/i.test(String(s || ''));

// Normalize each provider's job into a common row.
function normGreenhouse(job, company) {
    const locName = job.location?.name || null;
    return {
        company, title: clean(job.title), location: clean(locName),
        remote: isRemoteText(locName) || isRemoteText(job.title),
        department: clean(job.departments?.[0]?.name) || null,
        postedAt: job.updated_at || job.first_published || null,
        applyUrl: job.absolute_url || null, source: 'greenhouse',
    };
}
function normLever(job, company) {
    const c = job.categories || {};
    return {
        company, title: clean(job.text), location: clean(c.location),
        remote: job.workplaceType === 'remote' || isRemoteText(c.location) || isRemoteText(c.commitment),
        department: clean(c.department || c.team) || null,
        postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        applyUrl: job.hostedUrl || job.applyUrl || null, source: 'lever',
    };
}
function normAshby(job, company) {
    return {
        company, title: clean(job.title), location: clean(job.location),
        remote: Boolean(job.isRemote) || isRemoteText(job.location),
        department: clean(job.department || job.team) || null,
        postedAt: job.publishedAt || null,
        applyUrl: job.jobUrl || job.applyUrl || null, source: 'ashby',
    };
}
function normRemoteFeed(job) {
    return {
        company: clean(job.company_name), title: clean(job.title),
        location: clean(job.location),
        remote: Boolean(job.remote) || isRemoteText(job.location),
        department: Array.isArray(job.tags) && job.tags.length ? clean(job.tags[0]) : null,
        postedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : null,
        applyUrl: job.url || null, source: 'remote-feed',
    };
}

function matches(row) {
    if (!row.title) return false;
    if (kw.length && !kw.some((k) => row.title.toLowerCase().includes(k))) return false;
    if (loc && !String(row.location || '').toLowerCase().includes(loc)) return false;
    if (remoteOnly && !row.remote) return false;
    return true;
}

let rowsPushed = 0;
let chargeableRows = 0;
const seen = new Set();
async function pushJob(row) {
    if (rowsPushed >= cap) return false;
    const key = row.applyUrl || `${row.company}|${row.title}|${row.location}`;
    if (seen.has(key)) return true;
    seen.add(key);
    await Actor.pushData(row);
    rowsPushed += 1;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'job_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
    return true;
}

// Build the task list: one per company board (+ optional remote feed).
const tasks = companies.map(([provider, token, name]) => ({ provider, token, name }));
if (includeRemoteFeed) tasks.push({ provider: 'remote-feed' });

log.info(`Searching ${companies.length} company board(s)${includeRemoteFeed ? ' + remote feed' : ''} `
    + `for ${kw.length ? kw.map((k) => `"${k}"`).join('/') : 'all roles'}${loc ? ` in "${loc}"` : ''}${remoteOnly ? ' (remote only)' : ''}...`);

let cursor = 0;
let stopped = false;
let boardsOk = 0;
let boardsFailed = 0;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= tasks.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const t = tasks[i];

        let url;
        let extract;
        if (t.provider === 'greenhouse') { url = `https://boards-api.greenhouse.io/v1/boards/${t.token}/jobs?content=true`; extract = (j) => (j?.jobs || []).map((x) => normGreenhouse(x, t.name)); }
        else if (t.provider === 'lever') { url = `https://api.lever.co/v0/postings/${t.token}?mode=json`; extract = (j) => (Array.isArray(j) ? j : []).map((x) => normLever(x, t.name)); }
        else if (t.provider === 'ashby') { url = `https://api.ashbyhq.com/posting-api/job-board/${t.token}`; extract = (j) => (j?.jobs || []).map((x) => normAshby(x, t.name)); }
        else { url = REMOTE_FEED; extract = (j) => (j?.data || []).map(normRemoteFeed); }

        const { status, json, error } = await fetchJson(url);
        if (status !== 200 || !json) {
            boardsFailed += 1;
            log.warning(`${t.name || t.provider}: could not load (HTTP ${status || error || 'error'}).`);
            continue;
        }
        boardsOk += 1;
        let matched = 0;
        for (const row of extract(json)) {
            if (!matches(row)) continue;
            const cont = await pushJob(row);
            if (cont === false) { stopped = true; break; }
            matched += 1;
        }
        if (matched) log.info(`${t.name || 'remote feed'}: ${matched} match(es).`);
        await sleep(50);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, tasks.length) }, worker));

log.info(`Done. ${rowsPushed} matching job(s) pushed from ${boardsOk} board(s) `
    + `(${boardsFailed} failed to load, not charged; ${Math.max(0, chargeableRows - FREE_TIER_ROWS)} rows charged).`);
await Actor.exit();
