// Property Finder Scraper: property listings for sale and rent from
// propertyfinder.ae, .sa, .qa, .bh and .eg, with price and price per area,
// beds, baths, size, location and coordinates, completion status, furnishing,
// description, photos, the agent and the agency, and the listing's phone and
// WhatsApp numbers.
//
// Strategy
// --------
// propertyfinder.{tld}/en/search?... is a Next.js page whose __NEXT_DATA__
// carries searchResult.listings (25 per page, plus a few project cards) and
// searchResult.meta (total_count, page_count). Paging is &page=N and runs to
// the end of a search (page 2,000 of 7,608 tested on the UAE sale search).
//
// Search parameters (short names, as the site's own URLs use them):
//   c   category: 1 buy, 2 rent, 3 commercial buy, 4 commercial rent
//   l   location id         t   property type id
//   bdr[] bedrooms           pf / pt  price from / to
//   rp  rent period y/m/w/d  fu  furnishing 0 any, 1 yes, 2 no, 3 partly
//   ob  sort: mr featured, nd newest, pa price low, pd price high
// Location names become ids through /api/pwa/locations?filters.name=...
//
// No key, no proxy.
//
// Pay per event
// -------------
//   listing ($0.0015) one property with every field above
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HOSTS = { ae: 'www.propertyfinder.ae', uae: 'www.propertyfinder.ae', sa: 'www.propertyfinder.sa', ksa: 'www.propertyfinder.sa', qa: 'www.propertyfinder.qa', bh: 'www.propertyfinder.bh', eg: 'www.propertyfinder.eg' };
const CATEGORY = { buy: 1, rent: 2, commercial_buy: 3, commercial_rent: 4 };
const TYPES = {
    apartment: 1, villa: 35, townhouse: 22, penthouse: 20, compound: 42, duplex: 24, full_floor: 18, half_floor: 29, whole_building: 10,
    land: 5, bungalow: 31, hotel_apartment: 45, office: 4, retail: 27, warehouse: 13, shop: 21, showroom: 12, factory: 44,
};
const SORT = { featured: 'mr', newest: 'nd', price_asc: 'pa', price_desc: 'pd' };
const RENT_PERIOD = { yearly: 'y', monthly: 'm', weekly: 'w', daily: 'd' };
const FURNISHED = { any: '0', furnished: '1', unfurnished: '2', partly: '3' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    locations = [],
    country = 'ae',
    operation = 'buy',
    propertyType = '',
    minBedrooms = null,
    minPrice = null,
    maxPrice = null,
    rentPeriod = 'yearly',
    furnished = 'any',
    sortBy = 'newest',
    includeDescription = true,
    maxItemsPerSearch = 300,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 300);
const host = HOSTS[String(country).toLowerCase()] || HOSTS.ae;

async function fetchRetry(url, accept) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
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

async function searchPage(url) {
    const r = await fetchRetry(url, 'text/html');
    if (!r) return null;
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const sr = m ? JSON.parse(m[1])?.props?.pageProps?.searchResult : null;
    if (!sr) throw new Error('Property Finder returned a page without search results.');
    return sr;
}

async function locationId(h, name) {
    const r = await fetchRetry(`https://${h}/api/pwa/locations?locale=en&filters.name=${encodeURIComponent(name)}`, 'application/json');
    const d = r ? await r.json() : null;
    const hits = d?.data?.attributes || [];
    const exact = hits.find((x) => x.name?.toLowerCase() === name.toLowerCase());
    const hit = exact || hits[0];
    return hit ? { id: hit.id, label: [hit.name, hit.path_name].filter(Boolean).join(', ') } : null;
}

// ---------- Searches ----------

function filterParams() {
    const p = new URLSearchParams();
    p.set('c', String(CATEGORY[operation] || 1));
    const t = TYPES[String(propertyType || '').toLowerCase().replace(/[\s-]+/g, '_')];
    if (t) p.set('t', String(t));
    else if (propertyType) log.warning(`Unknown property type "${propertyType}" ignored. Use: ${Object.keys(TYPES).join(', ')}`);
    if (Number(minBedrooms) > 0) for (let b = Number(minBedrooms); b <= 7; b++) p.append('bdr[]', String(b));
    if (Number(minPrice) > 0) p.set('pf', String(minPrice));
    if (Number(maxPrice) > 0) p.set('pt', String(maxPrice));
    if ((operation === 'rent' || operation === 'commercial_rent') && RENT_PERIOD[rentPeriod]) p.set('rp', RENT_PERIOD[rentPeriod]);
    if (FURNISHED[furnished] && furnished !== 'any') p.set('fu', FURNISHED[furnished]);
    p.set('ob', SORT[sortBy] || 'nd');
    return p;
}

async function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)propertyfinder\.(ae|sa|qa|bh|eg)$/.test(url.hostname) || !url.pathname.startsWith('/en/') && !url.pathname.startsWith('/ar/')) {
            out.push({ error: `Not a Property Finder search URL (propertyfinder.ae/en/search?... or a listings page): ${u}` });
            continue;
        }
        url.searchParams.delete('page');
        out.push({ url, label: u });
    }
    const op = Object.keys(CATEGORY).includes(operation) ? operation : 'buy';
    for (const loc of list(locations)) {
        const hit = await locationId(host, loc).catch(() => null);
        if (!hit) { out.push({ error: `No ${host.replace('www.', '')} location matches "${loc}".` }); continue; }
        const p = filterParams();
        p.set('l', String(hit.id));
        out.push({ url: new URL(`https://${host}/en/search?${p}`), label: `${op.replace('_', ' ')} in ${hit.label}` });
    }
    return out;
}

// ---------- Rows ----------

const pos = (v) => (Number(v) > 0 ? Number(v) : null);
const contact = (p, type) => (p.contact_options || []).find((c) => c.type === type && c.value)?.value || null;

function row(p, h, search) {
    const price = p.price || {};
    const loc = p.location || {};
    const tree = p.location_tree || [];
    const byType = (t) => tree.find((x) => x.type === t)?.name || null;
    const out = {
        listingId: p.id,
        url: p.share_url || (p.details_path ? `https://${h}${p.details_path}` : null),
        title: p.title || null,
        offeringType: p.offering_type || null,
        propertyType: p.property_type || null,
        price: price.is_hidden ? null : pos(price.value),
        currency: price.currency || null,
        pricePeriod: price.period || null,
        pricePerArea: pos(p.price_per_area?.price),
        areaUnit: p.size?.unit || p.price_per_area?.unit || null,
        size: pos(p.size?.value),
        plotSize: pos(p.plot_size),
        bedrooms: p.bedrooms === 'studio' ? 0 : p.bedrooms_value ?? (Number.isFinite(Number(p.bedrooms)) ? Number(p.bedrooms) : null),
        isStudio: p.bedrooms === 'studio',
        bathrooms: p.bathrooms_value ?? (Number.isFinite(Number(p.bathrooms)) ? Number(p.bathrooms) : null),
        furnished: p.furnished === 'YES' ? true : p.furnished === 'NO' ? false : p.furnished === 'PARTLY' ? 'partly' : null,
        completionStatus: p.completion_status || null,
        amenities: p.amenity_names || [],
        location: loc.full_name || null,
        city: byType('CITY'),
        community: byType('COMMUNITY'),
        subCommunity: byType('SUBCOMMUNITY'),
        tower: byType('TOWER'),
        latitude: loc.coordinates?.lat ?? null,
        longitude: loc.coordinates?.lon ?? null,
        agentName: p.agent?.name || null,
        agentId: p.agent?.id || null,
        agentIsSuperAgent: p.agent?.is_super_agent ?? null,
        agencyName: p.broker?.name || p.client?.name || null,
        agencyId: p.broker?.id || p.client?.id || null,
        agencyLogoUrl: p.broker?.logo || p.client?.logo || null,
        phone: contact(p, 'phone'),
        whatsapp: contact(p, 'whatsapp'),
        email: contact(p, 'email') || p.broker?.email || p.client?.email || null,
        reference: p.reference || null,
        permitNumber: p.rera || null,
        listedAt: p.listed_date || null,
        refreshedAt: p.last_refreshed_at || null,
        isVerified: p.is_verified ?? null,
        isFeatured: p.is_featured ?? null,
        isExclusive: p.is_exclusive ?? null,
        isPriceDrop: p.is_price_drop ?? null,
        isGreatValue: p.is_great_value ?? null,
        isDirectFromDeveloper: p.is_direct_from_developer ?? null,
        photoCount: p.images_count ?? (p.images || []).length,
        photos: (p.images || []).map((i) => i.full || i.medium || i.small).filter(Boolean),
        videoUrl: p.video_url || null,
        search,
        scrapedAt: new Date().toISOString(),
    };
    if (includeDescription) out.description = (p.description || '').trim() || null;
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
        const res = await Actor.charge({ eventName: 'listing' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = await buildSearches();
if (!searches.length) searches.push({ url: new URL(`https://${host}/en/search?${filterParams()}`), label: `${operation} in all of ${host.replace('www.', '')}` });

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let total = null;
    try {
        for (let page = 1; keepGoing && count < perSearch; page++) {
            if (page > 1) s.url.searchParams.set('page', String(page));
            const sr = await searchPage(s.url.toString());
            if (!sr) break;
            if (page === 1) { total = sr.meta?.total_count ?? null; log.info(`${s.label}: ${total ?? '?'} listing(s) on Property Finder.`); }
            const props = (sr.listings || []).filter((x) => x.listing_type === 'property' && x.property).map((x) => x.property);
            for (const p of props) {
                if (!keepGoing || count >= perSearch) break;
                if (seen.has(p.id)) continue;
                seen.add(p.id);
                await Actor.pushData(row(p, s.url.hostname, s.label));
                listings += 1;
                count += 1;
                if (!(await charge())) keepGoing = false;
            }
            if (!props.length || page >= (sr.meta?.page_count || 1)) break;
            await sleep(400);
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${count} listing(s) saved.`);
    perSearchCounts.push({ search: s.label, listingsOnPropertyFinder: total, listingsSaved: count });
}

if (!listings) await Actor.pushData({ rowType: 'note', note: 'No listings matched. Not charged.' });
await Actor.setValue('SUMMARY', { listings, searches: perSearchCounts, failures });
log.info(`Done. ${listings} listing(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
