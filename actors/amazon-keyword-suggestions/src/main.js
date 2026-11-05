// Amazon Keyword Suggestions (Autocomplete) Scraper
//
// Strategy
// --------
// Amazon's search box calls a keyless JSON endpoint per marketplace:
//   GET https://completion.amazon.<tld>/api/2017/suggestions?mid=<marketplaceId>&alias=<department>&prefix=<query>
// One call returns up to 10 suggestions in Amazon's own order (the order
// shoppers see while typing, which tracks search popularity). To expand a
// seed we fan out modifier queries: the seed, seed + a-z, seed + 0-9,
// question/intent prefixes and preposition suffixes, dedupe, and emit one
// row per unique suggestion per marketplace. No login, no key, no browser,
// no proxy.
//
// Pay per event
// -------------
//   suggestion_row ($0.001) per unique suggestion pushed.
//   The first row per run is free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const HARD_CAP = 50000;
const REQUEST_DELAY_MS = 120;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const PREFIXES = ['best', 'cheap', 'how to', 'what', 'which', 'top', 'small', 'large', 'kids', 'women', 'men'];
const SUFFIXES = ['for', 'with', 'without', 'vs', 'set', 'pack', 'kit', 'accessories', 'replacement', 'gift'];

// tld + marketplace id per country.
const MARKETS = {
    us: ['com', 'ATVPDKIKX0DER'], uk: ['co.uk', 'A1F83G8C2ARO7P'], de: ['de', 'A1PA6795UKMFR9'],
    fr: ['fr', 'A13V1IB3VIYZZH'], it: ['it', 'APJ6JRA9NG5V4'], es: ['es', 'A1RKKUPIHCS9HS'],
    ca: ['ca', 'A2EUQ1WTGCTBG2'], jp: ['co.jp', 'A1VC38T7YXB528'], in: ['in', 'A21TJRUUN4KGV'],
    mx: ['com.mx', 'A1AM78C64UM0Y8'], au: ['com.au', 'A39IBJ37TRP1C6'], br: ['com.br', 'A2Q3Y263D00KWC'],
    nl: ['nl', 'A1805IZSGTT6HS'], ae: ['ae', 'A2VIGQ35RCS4UG'], sa: ['sa', 'A17E79C6D8DWNP'],
    se: ['se', 'A2NODRKZP88ZB9'], pl: ['pl', 'A1C3SOZRARQ6R3'], tr: ['com.tr', 'A33AVAJ2PDY3EV'],
    sg: ['sg', 'A19VAU5U5O7RUS'], be: ['com.be', 'AMEN7PMS3EDWL'], eg: ['eg', 'ARBP9OOSHTCHU'],
};
const ALIASES = { gb: 'uk', 'united kingdom': 'uk', usa: 'us', 'united states': 'us', germany: 'de', france: 'fr', italy: 'it', spain: 'es', canada: 'ca', japan: 'jp', india: 'in', mexico: 'mx', australia: 'au', brazil: 'br', netherlands: 'nl', sweden: 'se', poland: 'pl', turkey: 'tr', singapore: 'sg', belgium: 'be', egypt: 'eg' };

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    marketplaces = ['us'],
    department = 'aps',
    expandLetters = true,
    expandDigits = false,
    expandPrefixes = true,
    expandSuffixes = true,
    maxRowsPerKeyword = 300,
    maxRows = 3000,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const seeds = [...new Set(asList(keywords).map((k) => k.toLowerCase()))];
const markets = [...new Set(asList(marketplaces).map((m) => {
    const k = m.toLowerCase().replace(/^amazon\./, '');
    if (MARKETS[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    return Object.keys(MARKETS).find((c) => MARKETS[c][0] === k) || null;
}).filter(Boolean))];
const alias = String(department || 'aps').trim() || 'aps';
const perSeedCap = Math.max(1, Math.min(5000, Number(maxRowsPerKeyword) || 300));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 3000));

if (!seeds.length) {
    await Actor.pushData({ note: 'Provide at least one seed keyword in "keywords", e.g. ["yoga mat"]. Not charged.' });
    await Actor.exit();
}
if (!markets.length) {
    await Actor.pushData({ note: `No known marketplace in "marketplaces". Use country codes: ${Object.keys(MARKETS).join(', ')}. Not charged.` });
    await Actor.exit();
}

async function suggest(market, query) {
    const [tld, mid] = MARKETS[market];
    const params = new URLSearchParams({ mid, alias, prefix: query, 'suggestion-type': 'KEYWORD' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(`https://completion.amazon.${tld}/api/2017/suggestions?${params}`, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
                Accept: 'application/json',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        return (body?.suggestions || [])
            .filter((s) => s && s.value && (!s.type || s.type === 'KEYWORD'))
            .map((s) => String(s.value));
    } finally {
        clearTimeout(timer);
    }
}

function modifierQueries(seed) {
    const out = [{ query: seed, modifier: 'base' }];
    if (expandLetters) for (const l of LETTERS) out.push({ query: `${seed} ${l}`, modifier: `letter:${l}` });
    if (expandDigits) for (const d of DIGITS) out.push({ query: `${seed} ${d}`, modifier: `digit:${d}` });
    if (expandPrefixes) for (const p of PREFIXES) out.push({ query: `${p} ${seed}`, modifier: `prefix:${p}` });
    if (expandSuffixes) for (const s of SUFFIXES) out.push({ query: `${seed} ${s}`, modifier: `suffix:${s}` });
    return out;
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'suggestion_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const scrapedAt = new Date().toISOString();
const summary = { seeds: seeds.length, marketplaces: markets, requests: 0, failedRequests: 0, rows: 0, perSeed: {} };
log.info(`Expanding ${seeds.length} seed(s) across ${markets.length} Amazon marketplace(s), department "${alias}".`);

let stopped = false;
outer: for (const market of markets) {
    for (const seed of seeds) {
        if (stopped || rowsPushed >= cap) break outer;
        const seen = new Set();
        let pushedForSeed = 0;
        let failures = 0;
        for (const { query, modifier } of modifierQueries(seed)) {
            if (rowsPushed >= cap || pushedForSeed >= perSeedCap) break;
            if (deadlineMs && Date.now() > deadlineMs) {
                log.warning('Approaching run timeout; stopping early with results so far.');
                stopped = true;
                break;
            }
            let list;
            summary.requests += 1;
            try {
                list = await suggest(market, query);
                failures = 0;
            } catch (err) {
                summary.failedRequests += 1;
                failures += 1;
                log.warning(`[${market}] "${query}" failed: ${err?.message}`);
                if (failures >= 5) {
                    log.warning(`[${market}] five failures in a row; skipping the rest of "${seed}" on this marketplace.`);
                    break;
                }
                await sleep(1500);
                continue;
            }
            for (let i = 0; i < list.length; i++) {
                const s = list[i].trim().toLowerCase();
                if (!s || seen.has(s)) continue;
                seen.add(s);
                if (rowsPushed >= cap || pushedForSeed >= perSeedCap) break;
                await flushRow({
                    keyword: s,
                    seedKeyword: seed,
                    marketplace: market,
                    amazonDomain: `amazon.${MARKETS[market][0]}`,
                    department: alias,
                    modifier,
                    position: i + 1,
                    wordCount: s.split(/\s+/).length,
                    containsSeed: s.includes(seed),
                    searchUrl: `https://www.amazon.${MARKETS[market][0]}/s?k=${encodeURIComponent(s)}`,
                    scrapedAt,
                });
                pushedForSeed += 1;
            }
            await sleep(REQUEST_DELAY_MS);
        }
        summary.perSeed[`${market}:${seed}`] = pushedForSeed;
        log.info(`[${market}] "${seed}": ${pushedForSeed} unique keyword(s).`);
    }
}

summary.rows = rowsPushed;
if (!rowsPushed) await Actor.pushData({ note: 'Amazon returned no suggestions for these seeds and marketplaces. Not charged.' });
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${rowsPushed} keyword row(s); ${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
