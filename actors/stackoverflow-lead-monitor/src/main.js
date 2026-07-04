// Stack Overflow Lead Monitor
// Polls Stack Exchange API v2.3 for questions matching tags and/or search
// queries, filters by keyword, score, age, answered/accepted state, dedupes
// question IDs across runs via a named key value store.
//
// Endpoints:
//   /questions            -> list by tag, newest/activity/votes order
//   /search/advanced      -> full text title + body search
// Both return {items, has_more, quota_max, quota_remaining, backoff}.
//
// Auth: none required. 300 API calls/day anonymous. Optional free API key
// bumps to 10,000/day (stackapps.com/apps/oauth/register).
//
// Free tier: first 2 questions per run are free. After that charge per
// question.

import { Actor, log } from 'apify';

const FREE_TIER_QUESTIONS = 2;
const BASE = 'https://api.stackexchange.com/2.3';
const FILTER = 'withbody'; // returns body + is_answered + view_count fields

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tags = [],
    searchQueries = [],
    keywords = [],
    site = 'stackoverflow',
    sortBy = 'creation',
    maxAgeHours = 168,
    minScore = 0,
    onlyUnanswered = false,
    onlyNoAcceptedAnswer = false,
    includeBody = true,
    maxQuestionsPerSource = 100,
    maxQuestionsTotal = 200,
    dedupe = true,
    apiKey = '',
    proxyConfiguration: proxyInput,
} = input;

const tagList = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);

const queryList = (Array.isArray(searchQueries) ? searchQueries : [])
    .map((q) => String(q).trim())
    .filter(Boolean);

if (tagList.length === 0 && queryList.length === 0) {
    throw new Error('Provide at least one tag in tags or one query in searchQueries.');
}

const kwList = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
if (proxyUrl) log.info('Routing Stack Exchange requests through Apify proxy.');

const store = await Actor.openKeyValueStore('stackoverflow-lead-monitor-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const ageCutoffSec = maxAgeHours > 0 ? Math.floor(Date.now() / 1000) - maxAgeHours * 3600 : null;

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let quotaRemaining = null;

// Tags first, then search queries
for (const tag of tagList) {
    if (totalPushed >= maxQuestionsTotal) break;
    await harvestTag(tag);
}
for (const q of queryList) {
    if (totalPushed >= maxQuestionsTotal) break;
    await harvestSearch(q);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} quota=${quotaRemaining}`);
await Actor.exit();

// ---- helpers ----

async function harvestTag(tag) {
    let page = 1;
    let pulled = 0;
    while (pulled < maxQuestionsPerSource && totalPushed < maxQuestionsTotal) {
        const perPage = Math.min(100, maxQuestionsPerSource - pulled);
        const params = new URLSearchParams({
            order: 'desc',
            sort: sortBy === 'relevance' ? 'creation' : sortBy,
            tagged: tag,
            site,
            filter: FILTER,
            page: String(page),
            pagesize: String(perPage),
        });
        if (apiKey) params.set('key', apiKey);

        const endpoint = onlyUnanswered
            ? 'questions/unanswered'
            : onlyNoAcceptedAnswer
                ? 'questions/no-answers'
                : 'questions';
        const url = `${BASE}/${endpoint}?${params.toString()}`;
        log.info(`tag:${tag} page=${page} (${endpoint})`);

        const json = await request(url, `tag:${tag}`);
        if (!json) break;

        const items = Array.isArray(json.items) ? json.items : [];
        if (items.length === 0) break;

        for (const item of items) {
            if (totalPushed >= maxQuestionsTotal) break;
            if (pulled >= maxQuestionsPerSource) break;
            pulled += 1;
            totalSeen += 1;
            await handleItem(item, 'tag', tag);
        }

        if (!json.has_more) break;
        page += 1;
        if (json.backoff) {
            log.info(`Backoff ${json.backoff}s requested`);
            await sleep(json.backoff * 1000);
        } else {
            await sleep(250);
        }
    }
}

async function harvestSearch(q) {
    let page = 1;
    let pulled = 0;
    while (pulled < maxQuestionsPerSource && totalPushed < maxQuestionsTotal) {
        const perPage = Math.min(100, maxQuestionsPerSource - pulled);
        const params = new URLSearchParams({
            order: 'desc',
            sort: ['creation', 'activity', 'votes', 'relevance'].includes(sortBy) ? sortBy : 'creation',
            q,
            site,
            filter: FILTER,
            page: String(page),
            pagesize: String(perPage),
        });
        if (onlyUnanswered) params.set('answers', '0');
        if (onlyNoAcceptedAnswer) params.set('accepted', 'False');
        if (apiKey) params.set('key', apiKey);

        const url = `${BASE}/search/advanced?${params.toString()}`;
        log.info(`search:"${q}" page=${page}`);

        const json = await request(url, `search:${q}`);
        if (!json) break;

        const items = Array.isArray(json.items) ? json.items : [];
        if (items.length === 0) break;

        for (const item of items) {
            if (totalPushed >= maxQuestionsTotal) break;
            if (pulled >= maxQuestionsPerSource) break;
            pulled += 1;
            totalSeen += 1;
            await handleItem(item, 'search', q);
        }

        if (!json.has_more) break;
        page += 1;
        if (json.backoff) {
            log.info(`Backoff ${json.backoff}s requested`);
            await sleep(json.backoff * 1000);
        } else {
            await sleep(250);
        }
    }
}

async function handleItem(item, sourceKind, sourceValue) {
    const id = String(item.question_id || '');
    if (!id) return;
    if (dedupe && seen.has(id)) { deduped += 1; return; }

    if (ageCutoffSec !== null && (item.creation_date || 0) < ageCutoffSec) { filteredOut += 1; return; }
    if ((item.score ?? 0) < minScore) { filteredOut += 1; return; }

    const title = decodeEntities(item.title || '');
    const bodyText = includeBody ? stripHtml(item.body || '') : '';
    let matchedKeywords = [];
    if (kwList.length > 0) {
        const hay = `${title}\n${bodyText}`.toLowerCase();
        matchedKeywords = kwList.filter((kw) => hay.includes(kw));
        if (matchedKeywords.length === 0) { filteredOut += 1; return; }
    }

    await Actor.pushData({
        questionId: Number(id),
        title,
        body: includeBody ? bodyText : null,
        link: item.link,
        tags: Array.isArray(item.tags) ? item.tags : [],
        score: item.score ?? 0,
        viewCount: item.view_count ?? 0,
        answerCount: item.answer_count ?? 0,
        isAnswered: !!item.is_answered,
        hasAcceptedAnswer: !!item.accepted_answer_id,
        creationDate: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
        lastActivityDate: item.last_activity_date ? new Date(item.last_activity_date * 1000).toISOString() : null,
        closedDate: item.closed_date ? new Date(item.closed_date * 1000).toISOString() : null,
        closedReason: item.closed_reason || null,
        author: item.owner
            ? {
                userId: item.owner.user_id ?? null,
                displayName: decodeEntities(item.owner.display_name || ''),
                reputation: item.owner.reputation ?? null,
                profileUrl: item.owner.link || null,
                userType: item.owner.user_type || null,
            }
            : null,
        site,
        matchedKeywords,
        sourceKind,
        sourceValue,
        scrapedAt: new Date().toISOString(),
    });

    newSeen.add(id);
    totalPushed += 1;

    if (totalPushed > FREE_TIER_QUESTIONS) {
        await Actor.charge({ eventName: 'lead_match' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

async function request(url, label) {
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
        });
        if (res.status === 429 || res.status === 503) {
            log.warning(`${label} throttled (HTTP ${res.status}). Waiting 30s.`);
            await sleep(30_000);
            return null;
        }
        if (!res.ok) {
            log.warning(`${label} HTTP ${res.status}`);
            return null;
        }
        const json = await res.json();
        if (json?.error_id) {
            log.warning(`${label} API error ${json.error_id}: ${json.error_message || json.error_name}`);
            return null;
        }
        if (typeof json.quota_remaining === 'number') {
            quotaRemaining = json.quota_remaining;
            if (json.quota_remaining < 10) {
                log.warning(`Quota low: ${json.quota_remaining} calls left today`);
            }
        }
        return json;
    } catch (err) {
        log.warning(`${label} fetch failed: ${err?.message}`);
        return null;
    }
}

function stripHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<li>/gi, '\n- ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+$/g, '')
        .trim()
        .split('\n')
        .map((line) => decodeEntities(line))
        .join('\n');
}

function decodeEntities(s) {
    if (!s) return s;
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
