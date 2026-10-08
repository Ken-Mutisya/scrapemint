// Craigslist Scraper: listings from any Craigslist search (for sale, housing,
// jobs, gigs, services, cars) in any area, up to 10,000 per search.
//
// Strategy
// --------
// The Craigslist site reads search results from sapi.craigslist.org as compact
// JSON arrays. Three calls, the same ones the site makes (read from its
// search bundle, 2026-10-08):
//   search/full?batch=<area>-0-360-0-0        first 360 rows, rich, + cacheTs
//   search/full?batch=<area>-<cacheTs>-0-0-0  every row (up to 10,000), slim,
//                                             + cacheId and maxPostedTs
//   search/batch?batch=<area>-<start>-1080-0-1-<maxPostedTs>-<cacheTs>&cacheId=
//                                             titles, slugs, images for 1,080 rows
// Website filters (min_price, postal, search_distance, hasPic, bedrooms,
// auto_make_model...) pass straight through as query parameters, so a search
// URL copied from the browser works as input. No key, no proxy: sapi answered
// Apify's IPs in the 2026-10-08 probe.
//
// Row layout (slim): [pidOffset, postedOffset, categoryId, price, "loc:desc[:hood]~lat~lon", ...]
// then tagged arrays: [4, images...] [5, bedrooms, sqft] [6, slug] [7, pay]
// [8, employer] [10, priceText] [12, jobTitle] [13, uuid]; the title is the
// plain string among them.
//
// Pay per event
// -------------
//   listing        ($0.0015) one listing from search results
//   listing_detail ($0.003)  one listing with its full description and
//                            attributes, read from the posting page
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAPI = 'https://sapi.craigslist.org/web/v8/postings';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    areas = [],
    category = 'sss',
    query = '',
    minPrice = null,
    maxPrice = null,
    postal = '',
    searchDistance = null,
    hasPic = false,
    postedToday = false,
    includeDetails = false,
    maxItemsPerSearch = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 1000);

async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.craigslist.org/' }, signal: AbortSignal.timeout(45_000) });
            if (r.ok) return await r.json();
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 400 || r.status === 404) break;
        } catch (err) { last = err; }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// ---------- Reference data ----------

const ref = { areasByHost: new Map(), areasByName: new Map(), cats: new Map() };
async function loadReference() {
    const [areasJson, catsJson] = await Promise.all([getJson('https://reference.craigslist.org/Areas'), getJson('https://reference.craigslist.org/Categories')]);
    for (const a of areasJson) {
        ref.areasByHost.set(a.Hostname.toLowerCase(), a);
        for (const n of [a.Description, a.ShortDescription, a.Abbreviation]) if (n) ref.areasByName.set(n.toLowerCase(), a);
    }
    for (const c of catsJson) ref.cats.set(c.CategoryID, c);
}

function findArea(s) {
    const k = String(s || '').trim().toLowerCase().replace(/\.craigslist\.org.*$/, '').replace(/^https?:\/\//, '');
    if (!k) return null;
    if (/^\d+$/.test(k)) return [...ref.areasByHost.values()].find((a) => a.AreaID === Number(k)) || null;
    return ref.areasByHost.get(k) || ref.areasByName.get(k) || ref.areasByHost.get(k.replace(/[^a-z]/g, '')) || null;
}

// ---------- Searches ----------

// https://sfbay.craigslist.org/search/sfc/apa?max_price=3000
// https://www.craigslist.org/search/area/sfbay?cat=apa&query=bike
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    const host = url.hostname.split('.')[0];
    const parts = url.pathname.split('/').filter(Boolean);
    const params = Object.fromEntries(url.searchParams);
    let area = null;
    let path = null;
    if (host === 'www' && parts[0] === 'search' && parts[1] === 'area') {
        area = findArea(parts[2]);
        path = params.cat || 'sss';
        delete params.cat;
    } else {
        area = findArea(host);
        const i = parts.indexOf('search');
        path = i >= 0 ? parts.slice(i + 1).join('/') || 'sss' : 'sss';
    }
    for (const k of ['lang', 'cc', 'cat']) delete params[k];
    return area ? { area, searchPath: path, params, label: u } : null;
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        const s = parseSearchUrl(u);
        if (s) out.push(s); else out.push({ error: `Not a Craigslist search URL, or unknown area: ${u}` });
    }
    const params = {};
    if (query) params.query = String(query);
    if (minPrice != null && minPrice !== '') params.min_price = String(minPrice);
    if (maxPrice != null && maxPrice !== '') params.max_price = String(maxPrice);
    if (postal) params.postal = String(postal);
    if (postal && searchDistance) params.search_distance = String(searchDistance);
    if (hasPic) params.hasPic = '1';
    if (postedToday) params.postedToday = '1';
    for (const a of list(areas)) {
        const area = findArea(a);
        if (!area) { out.push({ error: `Unknown Craigslist area: ${a}. Use the subdomain, e.g. sfbay, newyork, london.` }); continue; }
        out.push({ area, searchPath: String(category || 'sss').trim(), params, label: `${area.Hostname} ${category || 'sss'}${query ? ` "${query}"` : ''}` });
    }
    return out;
}

const qs = (o) => new URLSearchParams(o).toString();

// ---------- Decoding ----------

function decodeRow(row, dec, area) {
    const tags = {};
    let title = null;
    // row[5] is an image hint string; the title is the plain string after it
    // (housing rows put [5, bedrooms, sqft] after the title).
    for (let i = 6; i < row.length; i++) {
        const x = row[i];
        if (Array.isArray(x) && typeof x[0] === 'number') tags[x[0]] = x.slice(1);
        else if (typeof x === 'string') title = x;
    }
    const [locPart, lat, lon] = String(row[4] || '').split('~');
    const idx = locPart.split(':').map(Number);
    const loc = dec.locations?.[idx[0]] || null;
    const cat = ref.cats.get(row[2]);
    const pid = dec.minPostingId + row[0];
    const slug = tags[6]?.[0] || null;
    const sub = loc?.[2] || null;
    const host = loc?.[1] || area.Hostname;
    return {
        postingId: String(pid),
        title,
        url: slug ? `https://${host}.craigslist.org/${sub ? `${sub}/` : ''}${cat?.Abbreviation || 'sss'}/d/${slug}/${pid}.html` : null,
        price: row[3] >= 0 ? row[3] : null,
        priceText: tags[10]?.[0] || null,
        currency: area.Country === 'US' ? 'USD' : null,
        postedAt: dec.minPostedDate != null && row[1] != null ? new Date((dec.minPostedDate + row[1]) * 1000).toISOString() : null,
        category: cat ? { id: cat.CategoryID, abbr: cat.Abbreviation, name: cat.Description } : { id: row[2] },
        area: host,
        subarea: sub,
        neighborhood: idx.length > 2 ? dec.neighborhoods?.[idx[2]] || null : null,
        location: dec.locationDescriptions?.[idx[1]] || null,
        latitude: lat ? Number(lat) : null,
        longitude: lon ? Number(lon) : null,
        bedrooms: tags[5]?.[0] ?? null,
        sqft: tags[5]?.[1] || null,
        compensation: tags[7]?.[0] || null,
        jobTitle: tags[12]?.[0] || null,
        employer: tags[8]?.[0] || null,
        images: (tags[4] || []).map((im) => `https://images.craigslist.org/${String(im).replace(/^\d+:/, '')}_600x450.jpg`),
        uuid: tags[13]?.[0] || null,
    };
}

// Merge the slim row (dates, price, location) with its batch row (title, slug, images).
function decodeSlimWithBatch(slim, batchRow, dec, area) {
    const merged = [slim[0], slim[1], slim[2], slim[3], slim[4], slim[5] ?? 0];
    if (batchRow) {
        for (let i = 2; i < batchRow.length; i++) merged.push(Array.isArray(batchRow[i]) && typeof batchRow[i][0] === 'string' ? [4, ...batchRow[i]] : batchRow[i]);
        merged.push(batchRow[1]);
    }
    return decodeRow(merged, dec, area);
}

async function* searchRows(s) {
    const base = { cc: s.area.Country || 'US', lang: 'en', searchPath: s.searchPath, ...s.params };
    const areaId = s.area.AreaID;
    const first = await getJson(`${SAPI}/search/full?${qs({ ...base, batch: `${areaId}-0-360-0-0` })}`);
    const d = first?.data;
    if (!d || !Array.isArray(d.items)) throw new Error(first?.errors?.[0]?.message || 'No results data');
    const total = d.totalResultCount || 0;
    log.info(`${s.label}: ${total} result(s).`);
    let n = 0;
    for (const row of d.items) { if (n >= perSearch) return; n += 1; yield decodeRow(row, d.decode, s.area); }
    if (n >= perSearch || d.items.length >= total) return;

    // Everything past the first 360: the slim full list, then titles in batches.
    const full = (await getJson(`${SAPI}/search/full?${qs({ ...base, batch: `${areaId}-${d.cacheTs}-0-0-0` })}`))?.data;
    if (!full?.items?.length || !full.cacheId) return;
    const seen = new Set(d.items.map((r) => d.decode.minPostingId + r[0]));
    const rest = full.items.filter((r) => !seen.has(full.decode.minPostingId + r[0]));
    const order = full.items.map((r) => full.decode.minPostingId + r[0]);
    const posOf = new Map(order.map((pid, i) => [pid, i]));
    const BATCH = 1080;
    const batches = new Map();
    async function batchFor(index) {
        const start = Math.floor(index / BATCH) * BATCH;
        if (!batches.has(start)) {
            batches.set(start, (async () => {
                const b = (await getJson(`${SAPI}/search/batch?${qs({ cc: base.cc, lang: 'en', cacheId: full.cacheId, batch: `${areaId}-${start}-${BATCH}-0-${full.bundleDups ?? 1}-${full.maxPostedTs}-${full.cacheTs}` })}`))?.data;
                const map = new Map();
                for (const row of b?.batch || []) map.set((b.minPostingId ?? full.decode.minPostingId) + row[0], row);
                return map;
            })());
        }
        return batches.get(start);
    }
    for (const slim of rest) {
        if (n >= perSearch) return;
        const pid = full.decode.minPostingId + slim[0];
        // Rows near a batch edge can sit in the neighbouring batch (the two
        // lists are ordered slightly differently), so look there too.
        const pos = posOf.get(pid);
        let hit = null;
        for (const at of [pos, pos - BATCH, pos + BATCH]) {
            if (hit || at < 0 || at >= order.length) continue;
            try { hit = (await batchFor(at)).get(pid) || null; } catch (err) { log.debug(`batch: ${err?.message}`); }
        }
        n += 1;
        yield decodeSlimWithBatch(slim, hit, full.decode, s.area);
    }
}

// ---------- Posting page ----------

const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

async function details(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return { detailError: `HTTP ${r.status}` };
    const t = await r.text();
    const body = t.match(/<section id="postingbody">([\s\S]*?)<\/section>/)?.[1] || '';
    const description = strip(body.replace(/<div class="print-information[\s\S]*?<\/div>\s*<\/div>/, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() || null;
    const attributes = {};
    const flags = [];
    for (const g of t.match(/<div class="attrgroup">[\s\S]*?<\/div>\s*(?=<div class="attrgroup">|<\/div>|<section|<p)/g) || []) {
        for (const a of g.match(/<div class="attr[^"]*">[\s\S]*?<\/div>/g) || []) {
            const k = strip(a.match(/<span class="labl">([\s\S]*?)<\/span>/)?.[1]).replace(/:$/, '').trim();
            const v = strip(a.match(/<span class="valu">([\s\S]*?)<\/span>/)?.[1]).trim();
            if (k && v) attributes[k] = v; else if (v) flags.push(v);
        }
        for (const sp of g.match(/<span class="attr important[^"]*">([\s\S]*?)<\/span>/g) || []) flags.push(strip(sp).trim());
    }
    const times = [...t.matchAll(/<time class="date timeago" datetime="([^"]+)"/g)].map((m) => m[1]);
    return {
        description,
        attributes,
        attributeFlags: [...new Set(flags.filter(Boolean))],
        address: strip(t.match(/class="mapaddress">([^<]+)/)?.[1]).trim() || null,
        postedAtLocal: times[0] || null,
        updatedAtLocal: times.length > 1 ? times[times.length - 1] : null,
        canonicalUrl: r.url,
    };
}

// ---------- Run ----------

let listings = 0;
let detailed = 0;
let keepGoing = true;
const failures = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

await loadReference();
const searches = buildSearches();
if (!searches.length) searches.push(...(() => { const a = findArea('sfbay'); return [{ area: a, searchPath: 'sss', params: { query: 'bike' }, label: 'sfbay sss "bike"' }]; })());

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    const seen = new Set();
    try {
        for await (const row of searchRows(s)) {
            if (!keepGoing) break;
            if (seen.has(row.postingId)) continue;
            seen.add(row.postingId);
            let extra = {};
            if (includeDetails && row.url) {
                try { extra = await details(row.url); } catch (err) { extra = { detailError: String(err?.message || err) }; }
            }
            const withDetail = includeDetails && extra.description !== undefined;
            await Actor.pushData({ ...row, ...extra, search: s.label, scrapedAt: new Date().toISOString() });
            listings += 1;
            if (withDetail) detailed += 1;
            if (!(await charge(withDetail ? 'listing_detail' : 'listing'))) keepGoing = false;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
}

if (!listings) await Actor.pushData({ rowType: 'note', note: 'No listings matched. Not charged.' });
await Actor.setValue('SUMMARY', { listings, withDetails: detailed, failures });
log.info(`Done. ${listings} listing(s)${includeDetails ? `, ${detailed} with details` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
