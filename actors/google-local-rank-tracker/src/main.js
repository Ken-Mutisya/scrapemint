// Google Local Rank Tracker: where a business ranks in Google's local results
// (the map pack and the local finder behind it) for each keyword and place,
// with the competitors around it.
//
// Strategy
// --------
// google.com/search?q=<keyword> <place>&tbm=lcl through Apify's GOOGLE_SERP
// proxy ($0.0025 per request). One page = 20 businesses with rating, review
// count, category, address, phone, hours and Google place ids (parse.js).
// start=20, 40 read deeper. Places can be cities or ZIP codes, so a list of
// ZIPs gives a coarse geo-grid.
//
// Your business is matched by name (case-insensitive substring), phone
// digits or Google CID. With trackChanges on, the last rank per keyword and
// place is kept in the named key-value store "local-rank-tracker-history".
//
// Cost control
// ------------
// Charged per page of 20 results read ($0.008 vs $0.0025), so depth never
// costs more than it earns. Google takes 8-50s per local page, so checks run
// four at a time and deeper pages get a single try. SERP spend is capped at 60% of charged
// revenue.
//
// Pay per event
// -------------
//   results_page ($0.008) one keyword x place check, per 20 results read

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseLocalPage } from './parse.js';

const PRICE = 0.008;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = ['plumber'],
    locations = ['Austin, TX'],
    yourBusiness = [],
    depth = 20,
    includeResults = true,
    trackChanges = true,
    country = 'us',
    language = 'en',
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/)).map((x) => String(x).trim()).filter(Boolean);
const kws = list(keywords);
const places = Array.isArray(locations) ? locations.map((x) => String(x).trim()).filter(Boolean) : list(locations);
const mine = list(yourBusiness);
const pagesWanted = Math.max(1, Math.min(3, Math.ceil((Number(depth) || 20) / 20)));
const digits = (s) => String(s || '').replace(/\D/g, '');

if (!kws.length) {
    await Actor.pushData({ note: 'Add at least one keyword, e.g. "plumber". Not charged.' });
    await Actor.exit();
}

function isMine(b) {
    return mine.some((m) => {
        const d = digits(m);
        if (/^\d{15,22}$/.test(m)) return b.cid === m;
        if (d.length >= 7 && d.length === m.replace(/[\s()+.-]/g, '').length) return digits(b.phone).endsWith(d.slice(-10));
        return b.name.toLowerCase().includes(m.toLowerCase());
    });
}

const guard = new ProxyGuard({ tiers: ['serp'], share: 0.6, floorUsd: 0.01, isBlocked: (r) => r.statusCode !== 200 || /\/sorry\/index|unusual traffic/i.test(r.body.slice(0, 5000)) });
const history = trackChanges ? await Actor.openKeyValueStore('local-rank-tracker-history') : null;
let checks = 0;
let pagesRead = 0;
let stop = false;
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { checks, pagesRead, ...guard.report() }));

const combos = kws.flatMap((k) => (places.length ? places.map((p) => ({ k, p })) : [{ k, p: null }]));
async function check({ k, p }) {
    const query = p ? `${k} ${p}` : k;
    const results = [];
    let read = 0;
    for (let page = 0; page < pagesWanted && !deadline.pastSoft(); page++) {
        const params = new URLSearchParams({ q: query, tbm: 'lcl', hl: language, gl: country });
        if (page) params.set('start', String(page * 20));
        // Local results take 8-50s through the SERP proxy (measured 2026-10-25). Deeper pages are optional: one try.
        const res = await guard.get(`http://www.google.com/search?${params}`, { timeoutMs: 75_000, retriesPerTier: page ? 0 : 1 });
        if (!res) { log.warning(`No ${page ? `page ${page + 1}` : 'page'} for "${query}" (blocked, slow or out of proxy budget).`); break; }
        read++;
        const found = parseLocalPage(res.body);
        if (!found.length && /VkpGBb/.test(res.body)) log.warning(`Google returned local results for "${query}" but none parsed: the page layout may have changed.`);
        for (const b of found) if (!results.some((x) => x.name === b.name && x.address === b.address)) results.push({ ...b, position: results.length + 1 });
        // Without the competitor list, there is no reason to read past the page that has your listing.
        if (found.length < 20 || (mine.length && !includeResults && results.some(isMine))) break;
    }
    if (!read) return;
    pagesRead += read;
    const hit = mine.length ? results.find(isMine) : null;
    const row = {
        keyword: k,
        location: p,
        query,
        yourRank: hit ? hit.position : null,
        inMapPack: hit ? hit.position <= 3 : mine.length ? false : null,
        yourListing: hit || null,
        resultsChecked: results.length,
        topCompetitor: results.find((b) => !isMine(b)) || null,
        results: includeResults ? results : undefined,
        country,
        checkedAt: new Date().toISOString(),
    };
    if (history && mine.length) {
        const key = `l-${createHash('sha1').update(`${query.toLowerCase()}|${country}|${mine.join('|').toLowerCase()}`).digest('hex').slice(0, 20)}`;
        const before = await history.getValue(key);
        row.previousRank = before ? before.rank : null;
        row.rankChange = before && before.rank && row.yourRank ? before.rank - row.yourRank : null;
        row.lastCheckedAt = before?.checkedAt ?? null;
        await history.setValue(key, { rank: row.yourRank, checkedAt: row.checkedAt });
    }
    await Actor.pushData(row);
    checks++;
    if (!(await chargeRows(guard, 'results_page', PRICE, read))) stop = true;
    log.info(`"${query}": ${results.length} businesses${mine.length ? `, you are ${hit ? `#${hit.position}` : `not in the top ${results.length}`}` : ''}.`);
}

// Requests mostly wait on Google, so four checks at a time cut the paid compute per check to about a quarter.
let next = 0;
async function worker() {
    while (!stop && !deadline.pastSoft() && next < combos.length) await check(combos[next++]);
}
await Promise.all([worker(), worker(), worker(), worker()]);

if (!checks) await Actor.pushData({ note: 'No local results could be read. Not charged.' });
await Actor.setValue('SUMMARY', { checks, pagesRead, ...guard.report() });
log.info(`Done: ${checks} checks, ${pagesRead} pages. ${JSON.stringify(guard.report())}`);
await Actor.exit();
