// Google Images Scraper: image search results with the full-size image URL,
// dimensions, file size, thumbnail, title and source page.
//
// Strategy
// --------
// google.com/search?q=<query>&udm=2 through Apify's GOOGLE_SERP proxy
// ($0.0025 per request, any page size). A page holds 50 images; see
// parse.js. Google's own image filters go in tbs (size, type, colour,
// licence, date). Further pages use start=50, 100...; paging stops as soon
// as a page brings no new images.
//
// Cost control
// ------------
// 50 images x $0.0004 against $0.0025 per request. SERP spend is capped at
// half of what the run has charged (proxy-guard). No proxy input is exposed.
//
// Pay per event
// -------------
//   image ($0.0004) one image result

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseImagesPage } from './parse.js';

const PRICE = 0.0004;
const SIZE = { large: 'isz:l', medium: 'isz:m', icon: 'isz:i' };
const TYPE = { photo: 'itp:photo', clipart: 'itp:clipart', lineart: 'itp:lineart', animated: 'itp:animated', face: 'itp:face' };
const COLOR = { color: 'ic:color', grayscale: 'ic:gray', transparent: 'ic:trans' };
const TIME = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = ['modern kitchen'],
    maxImagesPerQuery = 50,
    size = 'any',
    type = 'any',
    color = 'any',
    creativeCommonsOnly = false,
    postedWithin = 'any',
    country = 'us',
    language = 'en',
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const qs = list(queries);
const perQuery = Math.max(1, Math.min(500, Number(maxImagesPerQuery) || 50));
const tbs = [SIZE[size], TYPE[type], COLOR[color], creativeCommonsOnly ? 'il:cl' : null, TIME[postedWithin]].filter(Boolean).join(',');

if (!qs.length) {
    await Actor.pushData({ note: 'Add at least one search, e.g. "modern kitchen". Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({ tiers: ['serp'], share: 0.5, floorUsd: 0.01, isBlocked: (r) => r.statusCode !== 200 || /\/sorry\/index|unusual traffic/i.test(r.body.slice(0, 5000)) });
let out = 0;
let pages = 0;
let stop = false;
const perQuerySummary = [];
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { images: out, pages, ...guard.report(), queries: perQuerySummary }));

for (const q of qs) {
    if (stop || deadline.pastSoft()) break;
    const seen = new Set();
    let got = 0;
    for (let start = 0; got < perQuery && !stop && !deadline.pastSoft(); start += 50) {
        const params = new URLSearchParams({ q, udm: '2', hl: language, gl: country });
        if (tbs) params.set('tbs', tbs);
        if (start) params.set('start', String(start));
        const res = await guard.get(`http://www.google.com/search?${params}`, { timeoutMs: 60_000 });
        pages++;
        if (!res) { log.warning(`No page for "${q}" at ${start} (blocked or out of proxy budget).`); break; }
        const found = parseImagesPage(res.body);
        if (!found.length && /data-docid/.test(res.body)) log.warning(`Google returned images for "${q}" but none parsed: the page layout may have changed.`);
        const fresh = found.filter((r) => !seen.has(r.imageId) && seen.add(r.imageId)).slice(0, perQuery - got)
            .map((r) => ({ query: q, ...r, position: got + r.position, scrapedAt: new Date().toISOString() }));
        fresh.forEach((r, i) => { r.position = got + i + 1; });
        if (!fresh.length) break;
        await Actor.pushData(fresh);
        got += fresh.length;
        out += fresh.length;
        if (!(await chargeRows(guard, 'image', PRICE, fresh.length))) stop = true;
    }
    perQuerySummary.push({ query: q, images: got });
    log.info(`"${q}": ${got} images.`);
}

if (!out) await Actor.pushData({ note: 'No images found. Not charged. Try a broader search or fewer filters.' });
await Actor.setValue('SUMMARY', { images: out, pages, ...guard.report(), queries: perQuerySummary });
log.info(`Done: ${out} images from ${pages} pages. ${JSON.stringify(guard.report())}`);
await Actor.exit();
