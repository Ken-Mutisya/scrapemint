// GitHub Repo Stats: Stars, Forks, Issues & More
//
// Strategy
// --------
// Official GitHub REST API (api.github.com/repos/{owner}/{repo}), keyless, no
// browser, no proxy. One call per repo returns everything we emit (stars,
// forks, watchers, issues, language, license, topics, size, dates, owner), so
// we never spend more than one request per row.
//
// Rate limit: unauthenticated is 60 requests/hour PER IP. Since Apify runs on
// shared datacenter IPs, a big keyless run can hit the cap; the buyer can paste
// their own free token to get 5,000/hour. We read x-ratelimit-remaining and, on
// a rate-limit 403/429, stop cleanly, save what we have, and log the reset time
// instead of erroring out.
//
// Pay per event
// -------------
//   repo_stats per FOUND repo. Not-found repos are pushed free. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://api.github.com';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 25000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { repos = [], githubToken = '', maxRows = 500 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;\s]+/))
    .map((s) => String(s || '').trim()).filter(Boolean);

// Accept "owner/name", "github.com/owner/name", full URLs, trailing .git.
function parseRepo(token) {
    let t = String(token).trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '');
    t = t.replace(/\.git$/i, '').replace(/\/$/, '');
    const parts = t.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, name] = parts;
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
    return `${owner}/${name}`;
}

const repoList = [...new Set(asTokens(repos).map(parseRepo).filter(Boolean))].slice(0, HARD_CAP);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));
const token = String(githubToken || '').trim();

if (repoList.length === 0) {
    log.warning('No valid repositories given. Use owner/name, e.g. facebook/react.');
    await Actor.exit();
}

const headers = {
    'user-agent': 'scrapemint-github-repo-stats/0.1 (+https://apify.com)',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
};

let rateLimited = false;
async function fetchRepo(slug) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API}/repos/${slug}`, { signal: controller.signal, headers, redirect: 'follow' });
        const remaining = Number(res.headers.get('x-ratelimit-remaining'));
        if (res.status === 404) return { status: 'not_found' };
        if ((res.status === 403 || res.status === 429) && remaining === 0) {
            const reset = Number(res.headers.get('x-ratelimit-reset'));
            rateLimited = { reset: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'soon' };
            return { status: 'rate_limited' };
        }
        if (!res.ok) return { status: 'error', code: res.status };
        return { status: 'ok', data: await res.json(), remaining };
    } finally {
        clearTimeout(timer);
    }
}

function toRow(slug, d) {
    return {
        repo: slug,
        found: true,
        owner: d.owner?.login || slug.split('/')[0],
        name: d.name,
        description: d.description || null,
        stars: d.stargazers_count ?? null,
        forks: d.forks_count ?? null,
        watchers: d.subscribers_count ?? null,
        openIssues: d.open_issues_count ?? null,
        language: d.language || null,
        topics: d.topics || [],
        license: d.license?.spdx_id && d.license.spdx_id !== 'NOASSERTION' ? d.license.spdx_id : null,
        isFork: Boolean(d.fork),
        isArchived: Boolean(d.archived),
        sizeKb: d.size ?? null,
        defaultBranch: d.default_branch || null,
        homepage: d.homepage || null,
        createdAt: d.created_at || null,
        updatedAt: d.updated_at || null,
        pushedAt: d.pushed_at || null,
        url: d.html_url || `https://github.com/${slug}`,
    };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!row.found) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'repo_stats' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`${repoList.length} repo(s), ${token ? 'using supplied token (5,000/hr)' : 'keyless (60/hr shared limit)'}...`);

let notFound = 0;
for (const slug of repoList) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

    const r = await fetchRepo(slug);
    if (r.status === 'rate_limited') {
        log.warning(`GitHub rate limit reached (resets ${rateLimited.reset}). Stopping with ${rowsPushed} row(s) saved. Add a GitHub token to check more per run.`);
        break;
    }
    if (r.status === 'not_found') { notFound += 1; await flushRow({ repo: slug, found: false, note: 'repository not found or private' }); continue; }
    if (r.status === 'error') { log.warning(`${slug}: HTTP ${r.code}; skipping.`); continue; }
    await flushRow(toRow(slug, r.data));
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${notFound} not found (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; not-found free).`);
await Actor.exit();
