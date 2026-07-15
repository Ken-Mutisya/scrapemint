// Stack Overflow Scraper: Questions, Answers & Tags
//
// Strategy
// --------
// Stack Exchange public API v2.3 (api.stackexchange.com), keyless JSON.
// Query mode uses /search/advanced?q= (relevance sort), tag mode uses
// /search/advanced?tagged= (votes sort). filter=withbody adds the question
// body. includeAnswers batches question ids 100 per call into
// /questions/{ids}/answers, so the quota cost stays tiny.
//
// Quota: 300 requests/day per IP anonymous (shared on Apify), 10k/day with a
// buyer-supplied key (sanctioned buyer-owned-credential pattern, like
// githubToken). Every response carries quota_remaining and an optional
// backoff seconds field — both respected; on quota exhaustion the run stops
// cleanly with partial data and a clear log line.
//
// Pay per event
// -------------
//   question_row per question row. Searches/tags that match nothing are
//   free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const API = 'https://api.stackexchange.com/2.3';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 30000;
const BODY_TEXT_CAP = 3000;
const TOP_ANSWERS = 5;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [], tags = [], maxPerQuery = 15, includeAnswers = false,
    site = 'stackoverflow', newerThanDays = 0, apiKey = '', maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const qList = [...new Set(asTokens(queries))];
const tagList = [...new Set(asTokens(tags).map((t) => t.toLowerCase().replace(/\s+/g, '-')))];
const perQuery = Math.max(1, Math.min(100, Number(maxPerQuery) || 15));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const siteSlug = String(site || 'stackoverflow').trim().toLowerCase() || 'stackoverflow';
const key = String(apiKey || '').trim();
const minCreated = Number(newerThanDays) > 0 ? Math.floor(Date.now() / 1000) - Number(newerThanDays) * 86400 : 0;

if (qList.length === 0 && tagList.length === 0) {
    log.warning('No queries or tags given. Add a search like "playwright timeout" or a tag like "web-scraping".');
    await Actor.exit();
}

let quotaRemaining = null;
let quotaExhausted = false;

async function apiGet(path, params) {
    if (quotaExhausted) return null;
    const usp = new URLSearchParams({ site: siteSlug, ...params });
    if (key) usp.set('key', key);
    const url = `${API}${path}?${usp}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            const json = await res.json().catch(() => null);
            if (res.status === 400 && json?.error_name === 'throttle_violation') {
                log.warning(`API throttled: ${json.error_message}`);
                quotaExhausted = true;
                return null;
            }
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok || !json) return { error: `HTTP ${res.status}` };
            quotaRemaining = json.quota_remaining ?? quotaRemaining;
            if (json.quota_remaining === 0) {
                quotaExhausted = true;
                log.warning('Shared API quota exhausted (300/day per IP anonymous). Add your own free Stack Exchange key (stackapps.com) to raise it to 10k/day.');
            }
            if (json.backoff) {
                log.info(`API asked for a ${json.backoff}s backoff; complying.`);
                await sleep(json.backoff * 1000);
            }
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

let rowsPushed = 0;
let chargeableRows = 0;
let found = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'question_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const htmlToText = (html) => cheerio.load(html || '')('body').text().replace(/\s+/g, ' ').trim().slice(0, BODY_TEXT_CAP) || null;
const decode = (s) => (s == null ? null : cheerio.load(`<x>${s}</x>`)('x').text());

function toRow(job, q) {
    return {
        input: job.input,
        mode: job.mode,
        questionId: q.question_id,
        title: decode(q.title),
        url: q.link || null,
        bodyText: htmlToText(q.body),
        tags: q.tags || [],
        score: q.score ?? null,
        views: q.view_count ?? null,
        answerCount: q.answer_count ?? null,
        isAnswered: q.is_answered ?? null,
        acceptedAnswerId: q.accepted_answer_id ?? null,
        closed: q.closed_date ? (decode(q.closed_reason) || true) : null,
        author: q.owner?.display_name ? decode(q.owner.display_name) : null,
        authorReputation: q.owner?.reputation ?? null,
        authorUrl: q.owner?.link || null,
        createdAt: q.creation_date ? new Date(q.creation_date * 1000).toISOString() : null,
        lastActivityAt: q.last_activity_date ? new Date(q.last_activity_date * 1000).toISOString() : null,
        site: siteSlug,
    };
}

const jobs = [
    ...qList.map((q) => ({ mode: 'search', input: q, params: { q, sort: 'relevance' } })),
    ...tagList.map((t) => ({ mode: 'tag', input: t, params: { tagged: t, sort: 'votes' } })),
];

log.info(`Sweeping ${qList.length} search(es) + ${tagList.length} tag(s) on ${siteSlug} (${perQuery} question(s) each${includeAnswers ? ', with top answers' : ''})...`);

const seen = new Set();
const pending = [];

for (const job of jobs) {
    if (rowsPushed + pending.length >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    if (quotaExhausted) break;

    const json = await apiGet('/search/advanced', {
        ...job.params, order: 'desc', pagesize: String(perQuery), filter: 'withbody',
        ...(minCreated ? { fromdate: String(minCreated) } : {}),
    });
    if (!json || json.error) {
        await flushRow({ input: job.input, mode: job.mode, found: false, note: `could not search (${json?.error || 'quota exhausted'}); not charged, try again later` }, false);
        continue;
    }
    const items = (json.items || []).filter((q) => q.question_id && !seen.has(q.question_id));
    if (items.length === 0) {
        await flushRow({ input: job.input, mode: job.mode, found: false, note: 'no questions found' }, false);
        continue;
    }
    for (const q of items) {
        if (rowsPushed + pending.length >= cap) break;
        seen.add(q.question_id);
        pending.push({ job, q });
    }
    await sleep(300);
}

// One batched answers call per 100 questions keeps the quota cost tiny.
const answersById = new Map();
if (includeAnswers && pending.length > 0 && !quotaExhausted) {
    const ids = pending.map((p) => p.q.question_id);
    for (let i = 0; i < ids.length; i += 100) {
        // The batch endpoint sorts answers by votes ACROSS all requested
        // questions, so a question with only low-vote answers lands on later
        // pages. Paginate (up to 5 pages per batch) until every question has
        // its top answers or the pages run out.
        for (let page = 1; page <= 5; page += 1) {
            if (pastDeadline() || quotaExhausted) break;
            const json = await apiGet(`/questions/${ids.slice(i, i + 100).join(';')}/answers`, {
                order: 'desc', sort: 'votes', pagesize: '100', page: String(page), filter: 'withbody',
            });
            for (const a of json?.items || []) {
                const list = answersById.get(a.question_id) || [];
                if (list.length < TOP_ANSWERS) {
                    list.push({
                        answerId: a.answer_id,
                        score: a.score ?? null,
                        accepted: a.is_accepted ?? false,
                        bodyText: htmlToText(a.body),
                        author: a.owner?.display_name ? decode(a.owner.display_name) : null,
                        createdAt: a.creation_date ? new Date(a.creation_date * 1000).toISOString() : null,
                    });
                    answersById.set(a.question_id, list);
                }
            }
            await sleep(300);
            if (!json?.has_more) break;
        }
    }
}

for (const { job, q } of pending) {
    if (rowsPushed >= cap) break;
    found += 1;
    const row = toRow(job, q);
    if (includeAnswers) row.topAnswers = answersById.get(q.question_id) || [];
    await flushRow(row, true);
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} question(s) found `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; empty searches free). API quota remaining: ${quotaRemaining ?? 'unknown'}.`);
await Actor.exit();
