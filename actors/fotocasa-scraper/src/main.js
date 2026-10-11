// Fotocasa Scraper: property listings for sale and rent from fotocasa.es,
// Spain's second-largest property portal, with price, size, rooms, floor,
// condition, coordinates, full description, photos and the agency's phone.
//
// Strategy
// --------
// A search page (fotocasa.es/es/{comprar|alquiler}/{type}/{location}/
// todas-las-zonas/l?filters) embeds __initial_props__ with
// initialSearch.params: the exact parameters the site sends to its search
// gateway (combinedLocationIds, propertyTypeId, transactionTypeId, sortType,
// and every filter from the query string, e.g. maxPrice, minRooms,
// minSurface). Those params are replayed against
//   https://web.gw.fotocasa.es/v2/propertysearch/search
// with pageNumber and size=100. The gateway pages to the end of any search
// (tested page 409 of 410 on Madrid, 12,284 listings) and returns each
// listing with its description, coordinates, features, photos and advertiser.
//
// Locations given as text are turned into the site's slug (accents and
// spaces removed) and tried as "{slug}", "{slug}-capital", "{slug}-provincia".
//
// Feature codes, mapped from listing pages on 2026-10-11:
//   floor             1 basement, 3 ground floor, 6..20 floor 1..15
//                     (code - 5), 21 "15th or higher"; other codes stay null
//   conservationState 1 almost new, 2 very good, 3 good, 4 needs renovation,
//                     8 renovated
//   subtypeId         1 flat, 2 apartment, 5 semi-detached house, 6 penthouse
//
// No key, no proxy.
//
// Pay per event
// -------------
//   listing ($0.0015) one property with every field above
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://www.fotocasa.es';
const API = 'https://web.gw.fotocasa.es/v2/propertysearch/search';
const PAGE = 100;

const OPERATION = { buy: 'comprar', sale: 'comprar', comprar: 'comprar', rent: 'alquiler', alquiler: 'alquiler' };
const TYPES = {
    homes: 'viviendas', viviendas: 'viviendas', garages: 'garajes', garajes: 'garajes', commercial: 'locales', locales: 'locales',
    offices: 'oficinas', oficinas: 'oficinas', land: 'terrenos', terrenos: 'terrenos', storage: 'trasteros', trasteros: 'trasteros',
    buildings: 'edificios', edificios: 'edificios',
};
const SORT = {
    relevance: ['scoring', true], newest: ['publicationDate', true], price_asc: ['price', false], price_desc: ['price', true],
    size_desc: ['surface', true], size_asc: ['surface', false],
};
const CONSERVATION = { 1: 'almost new', 2: 'very good', 3: 'good', 4: 'needs renovation', 8: 'renovated' };
const SUBTYPE = { 1: 'flat', 2: 'apartment', 5: 'semi-detached house', 6: 'penthouse' };
const TRANSACTION = { 1: 'sale', 3: 'rent' };
// Params the gateway does not need; the rest of initialSearch.params is sent.
const SKIP = new Set(['culture', 'isMobile', 'hasStickyFilter', 'userId', 'commuteTime', 'pathname', 'pageType', 'hasDynamicDualGrid', 'showLongTailChip',
    'sortTypeFromUrl', 'isMapView', 'language', 'level', 'locationCode', 'locationLiteral', 'locationSegment', 'zoneSegment', 'upperLevelValue', 'fatherCombinedLocationIds', 'pageNumber']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    locations = [],
    operation = 'buy',
    propertyType = 'homes',
    minPrice = null,
    maxPrice = null,
    minRooms = null,
    minBathrooms = null,
    minSizeM2 = null,
    maxSizeM2 = null,
    sortBy = 'relevance',
    includeDescription = true,
    maxItemsPerSearch = 300,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 300);

async function fetchRetry(url, accept) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
            if (r.status === 404) return null;
            if (r.ok) return r;
            last = new Error(`HTTP ${r.status}`);
        } catch (err) {
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

async function searchParams(url) {
    const r = await fetchRetry(url, 'text/html');
    if (!r) return null;
    const html = await r.text();
    const m = html.match(/<script[^>]*id="__initial_props__"[^>]*>([\s\S]*?)<\/script>/);
    const props = m ? JSON.parse(m[1]) : null;
    const params = props?.initialSearch?.params;
    if (!params?.combinedLocationIds) return null;
    return { params, total: props.initialSearch.result?.count ?? null, place: props.geoFilterLiteral || params.locationLiteral || null };
}

async function apiPage(params, page) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (SKIP.has(k) || v === null || v === undefined || v === '') continue;
        if (Array.isArray(v)) { if (v.length) q.set(k, v.join(',')); continue; }
        if (typeof v === 'object') continue;
        q.set(k, String(v));
    }
    q.set('culture', 'es-ES');
    q.set('platformId', '1');
    q.set('pageNumber', String(page));
    q.set('size', String(PAGE));
    const r = await fetchRetry(`${API}?${q}`, 'application/json');
    return r ? r.json() : null;
}

// ---------- Searches ----------

const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function filterQuery() {
    const p = new URLSearchParams();
    if (Number(minPrice) > 0) p.set('minPrice', String(minPrice));
    if (Number(maxPrice) > 0) p.set('maxPrice', String(maxPrice));
    if (Number(minRooms) > 0) p.set('minRooms', String(minRooms));
    if (Number(minBathrooms) > 0) p.set('minBathrooms', String(minBathrooms));
    if (Number(minSizeM2) > 0) p.set('minSurface', String(minSizeM2));
    if (Number(maxSizeM2) > 0) p.set('maxSurface', String(maxSizeM2));
    const sort = SORT[sortBy];
    if (sort && sortBy !== 'relevance') { p.set('sortType', sort[0]); p.set('sortOrderDesc', String(sort[1])); }
    return p.toString();
}

function buildSearches(locs = list(locations)) {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)fotocasa\.es$/.test(url.hostname) || !/\/(comprar|alquiler|compartir|traspaso)\//.test(url.pathname)) {
            out.push({ error: `Not a Fotocasa search URL (fotocasa.es/es/comprar/... or /alquiler/...): ${u}` });
            continue;
        }
        // Drop a trailing page number (/l/3) so paging starts at 1.
        url.pathname = url.pathname.replace(/\/l\/\d+$/, '/l');
        out.push({ urls: [url.toString()], label: u });
    }
    const op = OPERATION[String(operation).toLowerCase()] || 'comprar';
    const type = TYPES[String(propertyType).toLowerCase()] || 'viviendas';
    const fq = filterQuery();
    for (const loc of locs) {
        const slug = slugify(loc);
        if (!slug) continue;
        const tries = /-(capital|provincia)$/.test(slug) || slug === 'espana' ? [slug] : [slug, `${slug}-capital`, `${slug}-provincia`];
        out.push({ urls: tries.map((s) => `${SITE}/es/${op}/${type}/${s}/todas-las-zonas/l${fq ? `?${fq}` : ''}`), label: `${Object.keys(TYPES).find((k) => TYPES[k] === type)} ${op === 'comprar' ? 'for sale' : 'for rent'} in ${loc}` });
    }
    return out;
}

// ---------- Rows ----------

const feat = (r) => Object.fromEntries((r.features || []).map((f) => [f.key, Array.isArray(f.value) ? f.value[0] : f.value]));
const yes = (v) => (v === undefined || v === null ? null : Number(v) > 0);
const pos = (v) => (Number(v) > 0 ? Number(v) : null);

function floorOf(code) {
    const c = Number(code);
    if (!c) return { floor: null, floorLabel: null };
    if (c === 1) return { floor: -1, floorLabel: 'basement' };
    if (c === 3) return { floor: 0, floorLabel: 'ground floor' };
    if (c >= 6 && c <= 20) return { floor: c - 5, floorLabel: `floor ${c - 5}` };
    if (c === 21) return { floor: null, floorLabel: '15th floor or higher' };
    return { floor: null, floorLabel: null };
}

function row(r, search) {
    const f = feat(r);
    const t = (r.transactions || [])[0] || {};
    const price = pos((t.value || [])[0]);
    const size = pos(f.surface);
    const loc = r.address?.location || {};
    const adv = r.advertiser || {};
    const path = r.detail?.es || null;
    const fl = floorOf(f.floor);
    const out = {
        listingId: r.id,
        url: path ? `${SITE}${path}` : null,
        operation: TRANSACTION[t.transactionTypeId] || null,
        price,
        priceCurrency: price ? 'EUR' : null,
        priceReduction: pos(t.reduced),
        pricePerM2: price && size ? Math.round(price / size) : null,
        sizeM2: size,
        rooms: pos(f.rooms),
        bathrooms: pos(f.bathrooms),
        floor: fl.floor,
        floorLabel: fl.floorLabel,
        floorCode: pos(f.floor),
        propertySubtype: SUBTYPE[r.subtypeId] || null,
        propertySubtypeId: r.subtypeId ?? null,
        condition: CONSERVATION[f.conservationState] || null,
        conditionCode: pos(f.conservationState),
        hasElevator: yes(f.elevator),
        hasParking: yes(f.parking),
        hasTerrace: yes(f.terrace),
        hasBalcony: yes(f.balcony),
        hasGarden: yes(f.garden),
        hasPool: yes(f.swimming_pool),
        hasAirConditioning: yes(f.air_conditioner),
        hasHeating: yes(f.heater),
        isNewBuild: Boolean(r.promotionId) || r.isNew === true,
        street: r.address?.ubication || null,
        neighbourhood: loc.level8 || null,
        district: loc.level7 || null,
        city: (loc.level5 || '').trim() || null,
        province: loc.level2 || null,
        region: loc.level1 || null,
        zipCode: r.address?.zipCode || null,
        latitude: r.address?.coordinates?.latitude ?? null,
        longitude: r.address?.coordinates?.longitude ?? null,
        advertiserName: adv.clientAlias || null,
        advertiserPhone: adv.phone || null,
        advertiserUrl: adv.logo?.url?.es ? `${SITE}${adv.logo.url.es}` : null,
        advertiserId: adv.clientId || null,
        publishedAt: r.date || null,
        isHighlighted: r.isTop ?? null,
        hasVirtualTour: r.isVirtualTour ?? null,
        photoCount: (r.multimedias || []).filter((m) => m.typeId === 2).length,
        photos: (r.multimedias || []).filter((m) => m.typeId === 2).map((m) => m.url),
        search,
        scrapedAt: new Date().toISOString(),
    };
    if (includeDescription) out.description = (r.description || '').trim() || null;
    return out;
}

// ---------- Run ----------

let listings = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];
const seen = new Set();

async function charge() {
    try {
        const r = await Actor.charge({ eventName: 'listing' });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = buildSearches();
if (!searches.length) searches.push(...buildSearches(['Madrid']));

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let found = null;
    try {
        for (const u of s.urls) {
            found = await searchParams(u);
            if (found) { found.url = u; break; }
        }
        if (!found) {
            const msg = `${s.label}: Fotocasa has no search page for this. Paste the search URL from fotocasa.es instead.`;
            log.warning(msg);
            failures.push({ search: s.label, error: msg });
            await Actor.pushData({ rowType: 'error', error: `${msg} Not charged.` });
            perSearchCounts.push({ search: s.label, listingsOnFotocasa: 0, listingsSaved: 0 });
            continue;
        }
        log.info(`${s.label}: ${found.total ?? '?'} listing(s) on Fotocasa${found.place ? ` (${found.place})` : ''}.`);
        for (let page = 1; keepGoing && count < perSearch; page++) {
            const d = await apiPage(found.params, page);
            const items = d?.realEstates || [];
            for (const r of items) {
                if (!keepGoing || count >= perSearch) break;
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                await Actor.pushData(row(r, s.label));
                listings += 1;
                count += 1;
                if (!(await charge())) keepGoing = false;
            }
            if (items.length < PAGE) break;
            await sleep(300);
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${count} listing(s) saved.`);
    perSearchCounts.push({ search: s.label, searchUrl: found?.url || null, listingsOnFotocasa: found?.total ?? null, listingsSaved: count });
}

if (!listings) await Actor.pushData({ rowType: 'note', note: 'No listings matched. Not charged.' });
await Actor.setValue('SUMMARY', { listings, searches: perSearchCounts, failures });
log.info(`Done. ${listings} listing(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
