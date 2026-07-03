// Google Keyword Suggestions Scraper (Autocomplete)
//
// Strategy
// --------
// Google's autocomplete endpoint is keyless JSON:
//   GET https://suggestqueries.google.com/complete/search?client=firefox&q=<query>&hl=<lang>&gl=<country>
// (&ds=yt switches the source to YouTube search suggestions.)
// One request returns up to 10 suggestions. To expand a seed keyword we fan
// out modifier queries: the seed itself, seed + each letter a-z, seed + each
// digit 0-9, question prefixes (how/what/why/...), and preposition suffixes
// (for/with/without/vs/near). Results are deduped across modifiers and
// emitted one row per unique suggestion. No login, no API key, no browser.
//
// Pay per event
// -------------
//   suggestion_row ($0.001) charged when a suggestion row is pushed.
//   First 10 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 10;
const HARD_CAP = 20000;
const REQUEST_DELAY_MS = 120;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const QUESTIONS = ['how', 'what', 'why', 'when', 'where', 'which', 'who', 'can', 'is', 'are', 'best'];
const PREPOSITIONS = ['for', 'with', 'without', 'vs', 'versus', 'near', 'like', 'to'];
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    source = 'google',
    language = 'en',
    country = 'us',
    expandLetters = true,
    expandDigits = false,
    expandQuestions = true,
    expandPrepositions = true,
    maxRowsPerKeyword = 400,
    maxRows = 2000,
    proxyConfiguration: proxyInput,
} = input;

const seeds = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
if (!seeds.length) {
    log.warning('Provide at least one seed keyword in "keywords", e.g. ["project management software"].');
    await Actor.exit();
}

const ds = source === 'youtube' ? 'yt' : '';
const hl = String(language || 'en').trim().toLowerCase() || 'en';
const gl = String(country || 'us').trim().toLowerCase() || 'us';
const perSeedCap = Math.max(1, Math.min(2000, Number(maxRowsPerKeyword) || 400));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 2000));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function suggestions(query) {
    const params = new URLSearchParams({ client: 'firefox', q: query, hl, gl });
    if (ds) params.set('ds', ds);
    const res = await fetch(`https://suggestqueries.google.com/complete/search?${params}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            Accept: 'application/json',
        },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`suggest HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body?.[1]) ? body[1].map((s) => String(s)) : [];
}

let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'suggestion_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

function buildModifierQueries(seed) {
    const queries = [{ query: seed, modifier: 'base' }];
    if (expandLetters) for (const l of LETTERS) queries.push({ query: `${seed} ${l}`, modifier: `letter:${l}` });
    if (expandDigits) for (const d of DIGITS) queries.push({ query: `${seed} ${d}`, modifier: `digit:${d}` });
    if (expandQuestions) for (const q of QUESTIONS) queries.push({ query: `${q} ${seed}`, modifier: `question:${q}` });
    if (expandPrepositions) for (const p of PREPOSITIONS) queries.push({ query: `${seed} ${p}`, modifier: `preposition:${p}` });
    return queries;
}

const scrapedAt = new Date().toISOString();
log.info(`Expanding ${seeds.length} seed keyword(s) from ${source === 'youtube' ? 'YouTube' : 'Google'} autocomplete (${hl}/${gl}).`);

let stopped = false;
for (const seed of seeds) {
    if (stopped || totalRowsPushed >= cap) break;
    const seen = new Set();
    let pushedForSeed = 0;
    let failures = 0;
    for (const { query, modifier } of buildModifierQueries(seed)) {
        if (totalRowsPushed >= cap || pushedForSeed >= perSeedCap) break;
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            stopped = true;
            break;
        }
        let list;
        try {
            list = await suggestions(query);
            failures = 0;
        } catch (err) {
            failures += 1;
            log.warning(`Query "${query}" failed: ${err?.message}`);
            if (failures >= 5) {
                log.warning('Five consecutive failures; Google may be rate limiting this IP. Stopping.');
                stopped = true;
                break;
            }
            await sleep(1500);
            continue;
        }
        for (let i = 0; i < list.length; i++) {
            const s = list[i].trim().toLowerCase();
            if (!s || s === seed || seen.has(s)) continue;
            seen.add(s);
            if (totalRowsPushed >= cap || pushedForSeed >= perSeedCap) break;
            await flushRow({
                suggestion: s,
                seedKeyword: seed,
                modifier,
                position: i + 1,
                wordCount: s.split(/\s+/).length,
                source: source === 'youtube' ? 'youtube' : 'google',
                language: hl,
                country: gl,
                scrapedAt,
            });
            pushedForSeed += 1;
        }
        await sleep(REQUEST_DELAY_MS);
    }
    log.info(`Seed "${seed}": ${pushedForSeed} unique suggestion(s).`);
}

log.info(`Done. Pushed ${totalRowsPushed} suggestion row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
