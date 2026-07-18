// Global News & Media Monitor (GDELT)
//
// Strategy
// --------
// GDELT DOC 2.0 API (api.gdeltproject.org/api/v2/doc/doc), keyless JSON
// over worldwide news monitoring in 100+ languages. Each topic becomes its
// own query; the source-country / language / advanced operators are folded
// into GDELT's query language, e.g.
//   "supply chain" sourcecountry:UnitedStates sourcelang:english
// Two modes:
//   articles  -> mode=artlist, up to 250 most-recent matching articles
//   timeline  -> mode=timelinevol, share-of-coverage over time
// GDELT rate-limits aggressively (~1 request / 5s), so requests are spaced
// and 429s are retried with backoff.
//
// Distinct from our Google News Scraper: that reads Google News RSS for one
// locale; this queries GDELT's cross-country, multi-language index with
// source country/language and coverage-volume analytics.
//
// Pay per event
// -------------
//   news_row per article or timeline point. Empty searches are free note
//   rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 40000;
const SPACING_MS = 6000; // GDELT asks for ~1 request / 5s
const MAX_ARTLIST = 250;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [], mode = 'articles', timespanDays = 7, sourceCountry = '',
    language = '', advancedFilters = '', maxPerQuery = 75, maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const queryList = [...new Set(asTokens(queries))];
const runMode = mode === 'timeline' ? 'timeline' : 'articles';
const days = clampNum(timespanDays, 7, 1, 365);
const country = String(sourceCountry || '').trim().replace(/\s+/g, '');
const lang = String(language || '').trim();
const extra = String(advancedFilters || '').trim();
const perQuery = clampNum(maxPerQuery, 75, 1, MAX_ARTLIST);
const rowCap = clampNum(maxRows, 1000, 1, HARD_CAP);

if (queryList.length === 0) {
    log.warning('No search topics given. Add a topic like "supply chain".');
    await Actor.exit();
}

// Build the full GDELT query string for a topic.
function gdeltQuery(topic) {
    const parts = [topic];
    if (country) parts.push(`sourcecountry:${country}`);
    if (lang) parts.push(`sourcelang:${lang.toLowerCase()}`);
    if (extra) parts.push(extra);
    return parts.join(' ');
}

async function apiGet(params) {
    const usp = new URLSearchParams({ format: 'json', timespan: `${days}d`, ...params });
    const url = `${API}?${usp}`;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Global News Monitor (admin@scrapemint.com)' } });
            if (res.status === 429) {
                if (attempt === 4) return { error: 'rate limited (GDELT is busy); try fewer topics or wait' };
                log.info('GDELT rate limit; backing off...');
                await sleep(10000);
                continue;
            }
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (!res.ok) return { error: `HTTP ${res.status}` };
            // GDELT returns an HTML/text notice instead of JSON on some query errors.
            if (!text.trim().startsWith('{')) return { error: text.trim().slice(0, 120) || 'non-JSON response' };
            let json;
            try { json = JSON.parse(text); } catch { return { error: 'could not parse GDELT response' }; }
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 4) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'news_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// "20260718T174500Z" -> "2026-07-18T17:45:00Z"
const parseSeen = (s) => {
    const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : (s || null);
};

async function runArticles(topic) {
    const json = await apiGet({ query: gdeltQuery(topic), mode: 'artlist', maxrecords: String(perQuery), sort: 'datedesc' });
    if (json?.error) {
        await flushRow({ type: 'note', input: topic, found: false, note: `search failed (${json.error}); not charged` }, false);
        return;
    }
    const articles = json.articles || [];
    if (articles.length === 0) {
        await flushRow({ type: 'note', input: topic, found: false, note: 'no articles matched this topic and filters; not charged' }, false);
        return;
    }
    const seen = new Set();
    for (const a of articles) {
        if (shouldStop()) break;
        if (!a.url || seen.has(a.url)) continue;
        seen.add(a.url);
        await flushRow({
            type: 'article',
            title: a.title || null,
            url: a.url,
            mobileUrl: a.url_mobile || null,
            domain: a.domain || null,
            language: a.language || null,
            sourceCountry: a.sourcecountry || null,
            seenDate: parseSeen(a.seendate),
            image: a.socialimage || null,
            topic,
        }, true);
    }
}

async function runTimeline(topic) {
    const json = await apiGet({ query: gdeltQuery(topic), mode: 'timelinevol' });
    if (json?.error) {
        await flushRow({ type: 'note', input: topic, found: false, note: `timeline failed (${json.error}); not charged` }, false);
        return;
    }
    const series = (json.timeline || [])[0]?.data || [];
    if (series.length === 0) {
        await flushRow({ type: 'note', input: topic, found: false, note: 'no coverage data for this topic and filters; not charged' }, false);
        return;
    }
    for (const p of series) {
        if (shouldStop()) break;
        await flushRow({
            type: 'coverage_point',
            topic,
            date: parseSeen(p.date) || p.date || null,
            coveragePct: typeof p.value === 'number' ? p.value : (p.value != null ? Number(p.value) : null),
        }, true);
    }
}

log.info(`Monitoring ${queryList.length} topic(s) in ${runMode} mode, last ${days} day(s)`
    + `${country ? `, country=${country}` : ''}${lang ? `, lang=${lang}` : ''}...`);

for (const topic of queryList) {
    if (shouldStop()) break;
    if (runMode === 'timeline') await runTimeline(topic);
    else await runArticles(topic);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
