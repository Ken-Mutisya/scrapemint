// Rightmove Scraper: UK property for sale and to rent from rightmove.co.uk,
// with price, beds, baths, type, size, address, coordinates, the agent and
// their phone, key features and dates; optionally the full description,
// floor area, tenure and lease length, service charge, ground rent, council
// tax band, postcode, nearest stations, floorplans and EPC.
//
// Strategy
// --------
// Search pages (/property-for-sale/find.html, /property-to-rent/find.html)
// are Next.js pages: __NEXT_DATA__ props.pageProps.searchResults holds 24
// properties a page (plus a featured one), resultCount and pagination.
// Paging is &index=0,24,48... and stops at index 984: a search shows at most
// ~1,000 properties. When resultCount is above that and more are wanted,
// the price range is halved (minPrice/maxPrice accept any value) until each
// band holds under 1,000, using the exact resultCount of each band.
//
// Places become locationIdentifier values ("REGION^87490") through
// los.rightmove.co.uk/typeahead.
//
// The property page (/properties/{id}) carries window.__PAGE_MODEL, a JSON
// string of a flat array in which objects refer to other entries by index
// ("encoding": "on"); decoding entry 0 gives propertyData.
//
// sortType: 1 lowest price, 2 highest price, 6 newest, 10 oldest.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   property        ($0.001) one property from the search page
//   property_detail ($0.003) the same property plus its property page;
//                            charged instead of property
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://www.rightmove.co.uk';
const PAGE = 24;
const MAX_INDEX = 984;
const WINDOW = MAX_INDEX + PAGE;
const SORT = { newest: '6', price_asc: '1', price_desc: '2', oldest: '10' };
const TYPES = ['detached', 'semi-detached', 'terraced', 'flat', 'bungalow', 'land', 'park-home'];
const MUST = ['garden', 'parking', 'retirement', 'sharedOwnership', 'auction', 'newHome'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    locations = [],
    operation = 'buy',
    radiusMiles = null,
    minPrice = null,
    maxPrice = null,
    minBedrooms = null,
    maxBedrooms = null,
    propertyTypes = [],
    mustHave = [],
    addedWithinDays = null,
    includeUnderOffer = false,
    sortBy = 'newest',
    includeDetails = false,
    maxItemsPerSearch = 300,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 300);

async function fetchRetry(url, accept) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
            if (r.status === 404 || r.status === 410) return null;
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
    return m ? JSON.parse(m[1])?.props?.pageProps?.searchResults || null : null;
}

const count = (sr) => Number(String(sr?.resultCount ?? '0').replace(/,/g, '')) || 0;

async function locationIdentifier(text) {
    const r = await fetchRetry(`https://los.rightmove.co.uk/typeahead?query=${encodeURIComponent(text)}&limit=10&exclude=STREET`, 'application/json');
    const d = r ? await r.json() : null;
    const hit = (d?.matches || [])[0];
    return hit ? { id: `${hit.type}^${hit.id}`, label: hit.displayName } : null;
}

// ---------- Searches ----------

function filterParams() {
    const p = new URLSearchParams();
    if (radiusMiles !== null && radiusMiles !== '' && Number(radiusMiles) > 0) p.set('radius', String(radiusMiles));
    if (Number(minPrice) > 0) p.set('minPrice', String(minPrice));
    if (Number(maxPrice) > 0) p.set('maxPrice', String(maxPrice));
    if (Number(minBedrooms) > 0) p.set('minBedrooms', String(minBedrooms));
    if (Number(maxBedrooms) > 0) p.set('maxBedrooms', String(maxBedrooms));
    const types = list(propertyTypes).map((t) => t.toLowerCase()).filter((t) => TYPES.includes(t) || (log.warning(`Unknown property type "${t}" ignored. Use: ${TYPES.join(', ')}`), false));
    if (types.length) p.set('propertyTypes', types.join(','));
    const must = list(mustHave).filter((m) => MUST.includes(m) || (log.warning(`Unknown must-have "${m}" ignored. Use: ${MUST.join(', ')}`), false));
    if (must.length) p.set('mustHave', must.join(','));
    if ([1, 3, 7, 14].includes(Number(addedWithinDays))) p.set('maxDaysSinceAdded', String(addedWithinDays));
    if (includeUnderOffer) p.set(operation === 'rent' ? 'includeLetAgreed' : 'includeSSTC', 'true');
    p.set('sortType', SORT[sortBy] || SORT.newest);
    return p;
}

async function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)rightmove\.co\.uk$/.test(url.hostname) || !/\/(property-for-sale|property-to-rent|new-homes-for-sale|commercial-property-for-sale|commercial-property-to-let)\//.test(url.pathname)) {
            out.push({ error: `Not a Rightmove search URL (rightmove.co.uk/property-for-sale/find.html?...): ${u}` });
            continue;
        }
        url.searchParams.delete('index');
        out.push({ url, label: u });
    }
    const path = operation === 'rent' ? '/property-to-rent/find.html' : '/property-for-sale/find.html';
    for (const loc of list(locations)) {
        const hit = await locationIdentifier(loc).catch(() => null);
        if (!hit) { out.push({ error: `No Rightmove place matches "${loc}". Try a town, area or postcode district.` }); continue; }
        const p = filterParams();
        p.set('locationIdentifier', hit.id);
        out.push({ url: new URL(`${SITE}${path}?${p}`), label: `${operation === 'rent' ? 'to rent' : 'for sale'} in ${hit.label}` });
    }
    return out;
}

// Price bands of a search, each with under ~1,000 results.
async function bands(base, need) {
    const sr = await searchPage(base.toString());
    const total = count(sr);
    if (total <= WINDOW || need <= WINDOW) return { total, bands: [[null, null, sr]] };
    log.info(`${base.searchParams.get('locationIdentifier') || 'search'}: ${total} results, splitting by price.`);
    const lo0 = Number(base.searchParams.get('minPrice')) || 0;
    const hi0 = Number(base.searchParams.get('maxPrice')) || null;
    const out = [];
    const queue = [[lo0, hi0]];
    let got = 0;
    while (queue.length && got < need) {
        const [lo, hi] = queue.shift();
        const u = new URL(base);
        u.searchParams.delete('minPrice'); u.searchParams.delete('maxPrice');
        if (lo > 0) u.searchParams.set('minPrice', String(lo));
        if (hi) u.searchParams.set('maxPrice', String(hi));
        const s = await searchPage(u.toString());
        const n = count(s);
        const top = hi ?? Math.max(lo * 4, operation === 'rent' ? 20_000 : 2_000_000);
        if (n > WINDOW && top - lo > 1) {
            const mid = Math.round((lo + top) / 2);
            queue.unshift([lo, mid], [mid + 1, hi]);
            continue;
        }
        if (n) out.push([lo || null, hi, s]);
        got += Math.min(n, WINDOW);
        await sleep(300);
    }
    return { total, bands: out };
}

// ---------- Rows ----------

const decodeEntities = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&pound;/g, '£');
const toText = (h) => decodeEntities(String(h || '').replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\s*\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

function row(p, search) {
    const c = p.customer || {};
    return {
        propertyId: p.id,
        url: `${SITE}/properties/${p.id}`,
        transactionType: p.transactionType || null,
        price: p.price?.amount ?? null,
        priceFrequency: p.price?.frequency && p.price.frequency !== 'not specified' ? p.price.frequency : null,
        displayPrice: p.price?.displayPrices?.[0]?.displayPrice || null,
        priceQualifier: p.price?.displayPrices?.[0]?.displayPriceQualifier || null,
        currency: p.price?.currencyCode || null,
        bedrooms: p.bedrooms ?? null,
        bathrooms: p.bathrooms ?? null,
        propertyType: p.propertySubType || null,
        description: p.propertyTypeFullDescription || null,
        displaySize: p.displaySize || null,
        tenure: p.tenure?.tenureType || null,
        address: p.displayAddress || null,
        latitude: p.location?.latitude ?? null,
        longitude: p.location?.longitude ?? null,
        summary: p.summary || null,
        keyFeatures: (p.keyFeatures || []).map((k) => decodeEntities(k.description)).filter(Boolean),
        addedOrReduced: p.addedOrReduced || null,
        firstListedAt: p.firstVisibleDate || null,
        updatedAt: p.updateDate || p.listingUpdate?.listingUpdateDate || null,
        lastUpdateReason: p.listingUpdate?.listingUpdateReason || null,
        letAvailableDate: p.letAvailableDate || null,
        status: p.displayStatus || null,
        agentName: c.brandTradingName || null,
        agentBranch: c.branchDisplayName || null,
        agentPhone: c.contactTelephone || null,
        agentBranchId: c.branchId ?? null,
        agentUrl: c.branchLandingPageUrl ? `${SITE}${c.branchLandingPageUrl}` : null,
        isAuction: p.auction ?? null,
        isNewHome: p.development ?? null,
        isFeatured: p.featuredProperty ?? null,
        photoCount: p.numberOfImages ?? null,
        floorplanCount: p.numberOfFloorplans ?? null,
        hasVirtualTour: (p.numberOfVirtualTours || 0) > 0,
        photos: (p.propertyImages?.images || p.images || []).map((i) => (i.url ? `https://media.rightmove.co.uk/${i.url}` : i.srcUrl)).filter(Boolean),
        search,
        scrapedAt: new Date().toISOString(),
    };
}

function pageModel(html) {
    const i = html.indexOf('window.__PAGE_MODEL = ');
    if (i < 0) return null;
    let depth = 0;
    const s = html.slice(html.indexOf('{', i));
    for (let k = 0; k < s.length; k++) {
        const ch = s[k];
        if (ch === '"') { k++; while (k < s.length && s[k] !== '"') { if (s[k] === '\\') k++; k++; } continue; }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
            const wrap = JSON.parse(s.slice(0, k + 1));
            if (typeof wrap.data !== 'string') return wrap;
            const arr = JSON.parse(wrap.data);
            const resolve = (ix, d = 0) => {
                if (typeof ix !== 'number' || ix < 0 || d > 60) return null;
                const v = arr[ix];
                if (Array.isArray(v)) return v.map((x) => resolve(x, d + 1));
                if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, resolve(x, d + 1)]));
                return v;
            };
            return resolve(0);
        }
    }
    return null;
}

async function addDetails(r) {
    try {
        const res = await fetchRetry(r.url, 'text/html');
        const pd = res ? pageModel(await res.text())?.propertyData : null;
        if (!pd) { r.detailError = 'Property page not available.'; return r; }
        const size = (unit) => (pd.sizings || []).find((x) => x.unit === unit)?.maximumSize ?? null;
        const lc = pd.livingCosts || {};
        const feat = pd.features || {};
        const pick = (k) => (feat[k] || []).map((x) => x.displayText).filter(Boolean);
        Object.assign(r, {
            fullDescription: toText(pd.text?.description) || null,
            sizeSqFt: size('sqft'),
            sizeSqM: size('sqm'),
            pricePerSqFt: pd.prices?.pricePerSqFt || null,
            postcode: pd.address?.outcode && pd.address?.incode ? `${pd.address.outcode} ${pd.address.incode}` : null,
            outcode: pd.address?.outcode || null,
            tenure: pd.tenure?.tenureType || r.tenure,
            leaseYearsRemaining: pd.tenure?.yearsRemainingOnLease ?? null,
            annualServiceCharge: lc.annualServiceCharge ?? null,
            annualGroundRent: lc.annualGroundRent ?? null,
            councilTaxBand: lc.councilTaxBand || null,
            councilTaxExempt: lc.councilTaxExempt ?? null,
            nearestStations: (pd.nearestStations || []).map((s) => ({ name: s.name, types: s.types, distanceMiles: s.distance != null ? Math.round(s.distance * 100) / 100 : null })),
            heating: pick('heating'),
            parking: pick('parking'),
            garden: pick('garden'),
            broadband: pick('broadband'),
            accessibility: pick('accessibility'),
            floorplans: (pd.floorplans || []).map((f) => f.url).filter(Boolean),
            epcUrls: (pd.epcGraphs || []).map((e) => e.url).filter(Boolean),
            agentAddress: pd.customer?.displayAddress ? pd.customer.displayAddress.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean).join(', ') : null,
            agentCompany: pd.customer?.companyName || null,
        });
    } catch (err) {
        r.detailError = String(err?.message || err);
    }
    return r;
}

// ---------- Run ----------

let properties = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];
const seen = new Set();

async function charge(eventName) {
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = await buildSearches();
if (!searches.length) {
    const p = filterParams();
    p.set('locationIdentifier', 'REGION^87490');
    searches.push({ url: new URL(`${SITE}/property-for-sale/find.html?${p}`), label: 'for sale in London' });
}

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let saved = 0;
    let total = null;
    try {
        const plan = await bands(s.url, perSearch);
        total = plan.total;
        log.info(`${s.label}: ${total} propert${total === 1 ? 'y' : 'ies'} on Rightmove.`);
        for (const [lo, hi, first] of plan.bands) {
            if (!keepGoing || saved >= perSearch) break;
            const u = new URL(s.url);
            if (lo !== null || hi !== null) {
                u.searchParams.delete('minPrice'); u.searchParams.delete('maxPrice');
                if (lo) u.searchParams.set('minPrice', String(lo));
                if (hi) u.searchParams.set('maxPrice', String(hi));
            }
            for (let index = 0; index <= MAX_INDEX && keepGoing && saved < perSearch; index += PAGE) {
                let sr = index === 0 ? first : null;
                if (!sr) { u.searchParams.set('index', String(index)); sr = await searchPage(u.toString()); await sleep(300); }
                const props = sr?.properties || [];
                const rows = [];
                for (const p of props) {
                    if (!p?.id || seen.has(p.id) || saved + rows.length >= perSearch) continue;
                    seen.add(p.id);
                    rows.push(row(p, s.label));
                }
                if (includeDetails) for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(addDetails));
                for (const r of rows) {
                    await Actor.pushData(r);
                    properties += 1;
                    saved += 1;
                    if (!(await charge(includeDetails && !r.detailError ? 'property_detail' : 'property'))) { keepGoing = false; break; }
                }
                const next = sr?.pagination?.next;
                if (!props.length || next === undefined || next === null || Number(next) <= index) break;
            }
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${saved} propert${saved === 1 ? 'y' : 'ies'} saved.`);
    perSearchCounts.push({ search: s.label, propertiesOnRightmove: total, propertiesSaved: saved });
}

if (!properties) await Actor.pushData({ rowType: 'note', note: 'No properties matched. Not charged.' });
await Actor.setValue('SUMMARY', { properties, searches: perSearchCounts, failures });
log.info(`Done. ${properties} propert${properties === 1 ? 'y' : 'ies'}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
