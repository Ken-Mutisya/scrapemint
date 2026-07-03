// GitHub Issue Monitor
// Polls the GitHub REST API for new issues and pull requests matching
// search queries or direct repo slugs. Filters by keyword, state, label,
// repo star floor, and age. Dedupes item IDs across runs via a named
// key value store and pushes only new matches to the dataset.
//
// Endpoints:
//   GET /search/issues?q={q}                  -> search issues + PRs
//   GET /repos/{owner}/{repo}/issues          -> list issues for a repo
//   GET /repos/{owner}/{repo}                 -> repo metadata (stars, language)
// Auth is optional. Anonymous rate limits are low (60 core / 10 search per min).
// A free personal access token raises this to 5000 core / 30 search per min.
//
// Free tier: first 50 items per run are free. After that charge per item.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 10;
const API_BASE = 'https://api.github.com';

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    repos = [],
    keywords = [],
    itemType = 'all',
    state = 'open',
    labels = [],
    minRepoStars = 0,
    maxAgeHours = 168,
    sortBy = 'created',
    maxItemsPerSource = 50,
    maxItemsTotal = 200,
    dedupe = true,
    githubToken = '',
    proxyConfiguration: proxyInput,
} = input;

const queries = (Array.isArray(searchQueries) ? searchQueries : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

const repoList = (Array.isArray(repos) ? repos : [])
    .map((r) => String(r).trim())
    .filter((r) => /^[^\/\s]+\/[^\/\s]+$/.test(r));

if (queries.length === 0 && repoList.length === 0) {
    throw new Error('Provide at least one query in searchQueries or one repo in repos (format: "owner/name").');
}

const kwList = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

const labelList = (Array.isArray(labels) ? labels : [])
    .map((l) => String(l).trim())
    .filter(Boolean);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

const authHeaders = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'scrapemint-github-issue-monitor/0.1',
};
if (githubToken && String(githubToken).trim()) {
    authHeaders['Authorization'] = `Bearer ${String(githubToken).trim()}`;
    log.info('Using authenticated GitHub requests (5000 core / 30 search per min).');
} else {
    log.info('Using anonymous GitHub requests (60 core / 10 search per min).');
}

const store = await Actor.openKeyValueStore('github-issue-monitor-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const repoMetaCache = new Map();

const ageCutoffMs = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600 * 1000 : null;

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

for (const q of queries) {
    if (totalPushed >= maxItemsTotal) break;
    await harvestSearch(q);
}
for (const repoSlug of repoList) {
    if (totalPushed >= maxItemsTotal) break;
    await harvestRepo(repoSlug);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---- search ----

async function harvestSearch(userQuery) {
    const q = buildSearchQuery(userQuery);
    let page = 1;
    let pulled = 0;
    const perPage = Math.min(100, maxItemsPerSource);
    const sort = sortBy === 'updated' ? 'updated' : 'created';

    while (pulled < maxItemsPerSource && totalPushed < maxItemsTotal) {
        const url = `${API_BASE}/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&sort=${sort}&order=desc`;
        log.info(`Search page=${page} q="${q}"`);

        const json = await ghFetch(url);
        if (!json) break;

        const items = Array.isArray(json.items) ? json.items : [];
        if (items.length === 0) break;

        for (const item of items) {
            if (totalPushed >= maxItemsTotal) break;
            if (pulled >= maxItemsPerSource) break;
            pulled += 1;
            totalSeen += 1;
            await handleIssue(item, { sourceKind: 'search', sourceValue: userQuery });
        }

        if (items.length < perPage) break;
        page += 1;
        if (page > 10) break;
        await sleep(2100);
    }
}

function buildSearchQuery(userQuery) {
    const parts = [userQuery.trim()];
    if (itemType === 'issues') parts.push('is:issue');
    else if (itemType === 'prs') parts.push('is:pr');
    if (state === 'open' || state === 'closed') parts.push(`is:${state}`);
    for (const label of labelList) parts.push(`label:"${label}"`);
    return parts.join(' ');
}

// ---- direct repo polling ----

async function harvestRepo(repoSlug) {
    const stars = await getRepoStars(repoSlug);
    if (stars === null) {
        log.warning(`Skipping ${repoSlug} (repo fetch failed).`);
        return;
    }
    if (minRepoStars > 0 && stars < minRepoStars) {
        log.info(`Skipping ${repoSlug} (stars=${stars} < minRepoStars=${minRepoStars}).`);
        return;
    }

    let page = 1;
    let pulled = 0;
    const perPage = Math.min(100, maxItemsPerSource);
    const sort = sortBy === 'updated' ? 'updated' : 'created';

    while (pulled < maxItemsPerSource && totalPushed < maxItemsTotal) {
        const params = new URLSearchParams({
            state,
            per_page: String(perPage),
            page: String(page),
            sort,
            direction: 'desc',
        });
        if (labelList.length > 0) params.set('labels', labelList.join(','));

        const url = `${API_BASE}/repos/${repoSlug}/issues?${params.toString()}`;
        log.info(`Repo ${repoSlug} page=${page}`);

        const items = await ghFetch(url);
        if (!Array.isArray(items) || items.length === 0) break;

        for (const item of items) {
            if (totalPushed >= maxItemsTotal) break;
            if (pulled >= maxItemsPerSource) break;
            pulled += 1;
            totalSeen += 1;
            await handleIssue(item, { sourceKind: 'repo', sourceValue: repoSlug });
        }

        if (items.length < perPage) break;
        page += 1;
        if (page > 10) break;
        await sleep(500);
    }
}

async function getRepoStars(repoSlug) {
    if (repoMetaCache.has(repoSlug)) return repoMetaCache.get(repoSlug).stars;
    const url = `${API_BASE}/repos/${repoSlug}`;
    const json = await ghFetch(url);
    if (!json || typeof json.stargazers_count !== 'number') {
        repoMetaCache.set(repoSlug, { stars: null, language: null });
        return null;
    }
    const meta = { stars: json.stargazers_count, language: json.language || null };
    repoMetaCache.set(repoSlug, meta);
    return meta.stars;
}

// ---- handler ----

async function handleIssue(item, source) {
    if (!item || typeof item.id !== 'number') return;
    const id = String(item.id);
    if (dedupe && seen.has(id)) { deduped += 1; return; }

    const isPr = !!item.pull_request;
    if (itemType === 'issues' && isPr) { filteredOut += 1; return; }
    if (itemType === 'prs' && !isPr) { filteredOut += 1; return; }

    const createdMs = item.created_at ? Date.parse(item.created_at) : 0;
    if (ageCutoffMs !== null && createdMs && createdMs < ageCutoffMs) { filteredOut += 1; return; }

    const title = item.title || '';
    const body = item.body || '';
    let matchedKeywords = [];
    if (kwList.length > 0) {
        const hay = `${title}\n${body}`.toLowerCase();
        matchedKeywords = kwList.filter((kw) => hay.includes(kw));
        if (matchedKeywords.length === 0) { filteredOut += 1; return; }
    }

    const { owner, name } = parseRepoFromIssueUrl(item.repository_url) || {};
    let repoMeta = null;
    if (owner && name) {
        const slug = `${owner}/${name}`;
        if (minRepoStars > 0 || source.sourceKind === 'search') {
            const stars = await getRepoStars(slug);
            if (stars === null) {
                filteredOut += 1;
                return;
            }
            if (minRepoStars > 0 && stars < minRepoStars) { filteredOut += 1; return; }
            repoMeta = repoMetaCache.get(slug);
        }
    }

    await Actor.pushData({
        issueId: id,
        number: item.number ?? null,
        itemType: isPr ? 'pull_request' : 'issue',
        title: title || null,
        body: body || null,
        state: item.state || null,
        locked: !!item.locked,
        url: item.html_url || null,
        apiUrl: item.url || null,
        repo: owner && name ? {
            slug: `${owner}/${name}`,
            owner,
            name,
            stars: repoMeta?.stars ?? null,
            language: repoMeta?.language ?? null,
            url: `https://github.com/${owner}/${name}`,
        } : null,
        author: item.user ? {
            login: item.user.login,
            id: item.user.id,
            url: item.user.html_url,
            avatar: item.user.avatar_url,
            type: item.user.type,
        } : null,
        labels: Array.isArray(item.labels) ? item.labels.map((l) => ({
            name: l.name,
            color: l.color,
            description: l.description,
        })) : [],
        assignees: Array.isArray(item.assignees) ? item.assignees.map((a) => a.login) : [],
        milestone: item.milestone ? {
            title: item.milestone.title,
            state: item.milestone.state,
        } : null,
        commentsCount: item.comments ?? 0,
        reactions: item.reactions ? {
            total: item.reactions.total_count,
            plusOne: item.reactions['+1'],
            minusOne: item.reactions['-1'],
            laugh: item.reactions.laugh,
            hooray: item.reactions.hooray,
            confused: item.reactions.confused,
            heart: item.reactions.heart,
            rocket: item.reactions.rocket,
            eyes: item.reactions.eyes,
        } : null,
        isDraft: item.draft ?? null,
        createdAt: item.created_at || null,
        updatedAt: item.updated_at || null,
        closedAt: item.closed_at || null,
        matchedKeywords,
        sourceKind: source.sourceKind,
        sourceValue: source.sourceValue,
        scrapedAt: new Date().toISOString(),
    });

    newSeen.add(id);
    totalPushed += 1;
    maybeCharge();
}

function parseRepoFromIssueUrl(repoUrl) {
    if (!repoUrl) return null;
    const m = String(repoUrl).match(/\/repos\/([^\/]+)\/([^\/]+)$/);
    if (!m) return null;
    return { owner: m[1], name: m[2] };
}

// ---- helpers ----

async function ghFetch(url) {
    try {
        const res = await fetch(url, { headers: authHeaders });
        if (res.status === 403 || res.status === 429) {
            const remaining = res.headers.get('x-ratelimit-remaining');
            const reset = res.headers.get('x-ratelimit-reset');
            log.warning(`GitHub rate limited (status=${res.status}, remaining=${remaining}, reset=${reset}).`);
            return null;
        }
        if (!res.ok) {
            log.warning(`GitHub HTTP ${res.status} for ${url}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`GitHub fetch failed: ${err?.message}`);
        return null;
    }
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        __chargeJobs.push(Actor.charge({ eventName: 'issue_match' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }));
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
