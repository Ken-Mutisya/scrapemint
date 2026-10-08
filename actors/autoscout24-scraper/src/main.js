// AutoScout24 Scraper: car listings from any AutoScout24 search across eight
// European countries, past the 4,000-per-search cap, with dealer phones.
//
// Strategy
// --------
// AutoScout24 search pages (/lst...) are server-rendered by Next.js. Each page
// carries 20 listings in __NEXT_DATA__ props.pageProps.listings, with price,
// price rating, vehicle data, location, seller and phones, plus
// numberOfResults. Pages stop at 200 (4,000 cars), so larger searches are
// split into price windows (pricefrom/priceto, halved until each holds 4,000
// or fewer) and read newest first (sort=age&desc=1).
//
// The website's query parameters (mmmv, cy, fuel, gear, custtype, offer,
// pricefrom, fregfrom, kmto, zip, zipr...) pass straight through, so a search
// URL copied from the browser works as input. Built searches use the
// /lst/<make>/<model> path, which the site resolves itself.
//
// Listing pages (/angebote/...) add the description, equipment, body, colour,
// seats, coordinates, market median price and creation time.
//
// No key, no proxy: Apify's IPs got 200 in the 2026-10-09 probe (a home IP
// got 403).
//
// Pay per event
// -------------
//   listing        ($0.0005) one car from search pages
//   listing_detail ($0.0015) one car with its listing page read
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PER_PAGE = 20;
const MAX_PAGES = 200;
const CAP = PER_PAGE * MAX_PAGES;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    site = 'com',
    makes = [],
    countries = [],
    offerTypes = [],
    sellerType = '',
    fuelTypes = [],
    gearbox = '',
    priceFrom = null,
    priceTo = null,
    yearFrom = null,
    yearTo = null,
    mileageTo = null,
    zip = '',
    radiusKm = null,
    includeDetails = false,
    maxItemsPerSearch = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 1000);

async function getPage(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
            if (r.status === 404) return null;
            if (r.ok) {
                const t = await r.text();
                const m = t.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
                if (m) return JSON.parse(m[1])?.props?.pageProps || {};
                last = new Error('No page data');
            } else last = new Error(`HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

// ---------- Searches ----------

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/(^|\.)autoscout24\.[a-z.]+$/.test(url.hostname) || !url.pathname.startsWith('/lst')) return null;
    url.searchParams.delete('page');
    return { origin: url.origin, path: url.pathname, params: [...url.searchParams], label: u };
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) out.push(parseSearchUrl(u) || { error: `Not an AutoScout24 search URL (…/lst…): ${u}` });
    const p = [['atype', 'C']];
    if (countries.length) p.push(['cy', countries.join(',')]);
    if (offerTypes.length) p.push(['offer', offerTypes.join(',')]);
    if (sellerType) p.push(['custtype', sellerType]);
    if (fuelTypes.length) p.push(['fuel', fuelTypes.join(',')]);
    if (gearbox) p.push(['gear', gearbox]);
    if (priceFrom != null && priceFrom !== '') p.push(['pricefrom', String(priceFrom)]);
    if (priceTo != null && priceTo !== '') p.push(['priceto', String(priceTo)]);
    if (yearFrom) p.push(['fregfrom', String(yearFrom)]);
    if (yearTo) p.push(['fregto', String(yearTo)]);
    if (mileageTo != null && mileageTo !== '') p.push(['kmto', String(mileageTo)]);
    if (zip) p.push(['zip', String(zip)]);
    if (zip && radiusKm) p.push(['zipr', String(radiusKm)]);
    for (const m of list(makes)) {
        const [make, ...rest] = m.split('/').map((x) => x.trim()).filter(Boolean);
        const model = rest.join(' ');
        out.push({ origin: `https://www.autoscout24.${/^(com|de|it|fr|es|nl|be|at)$/.test(site) ? site : 'com'}`, path: `/lst/${slug(make)}${model ? `/${slug(model)}` : ''}`, params: p, label: m, wantModel: !!model });
    }
    return out;
}

function pageUrl(s, extra = []) {
    const qs = new URLSearchParams([...s.params.filter(([k]) => !['sort', 'desc', ...extra.map(([k2]) => k2)].includes(k)), ['sort', 'age'], ['desc', '1'], ...extra]);
    return `${s.origin}${s.path}?${qs}`;
}

const hasParam = (s, k) => s.params.some(([k2]) => k2 === k);
const paramNum = (s, k) => { const v = s.params.find(([k2]) => k2 === k)?.[1]; return v != null && v !== '' ? Number(v) : null; };

// Price windows of 4,000 or fewer.
async function priceWindows(s, total) {
    const lo0 = paramNum(s, 'pricefrom') ?? 0;
    const hi0 = paramNum(s, 'priceto') ?? 5_000_000;
    const count = async (a, b) => (await getPage(pageUrl(s, [['pricefrom', String(a)], ['priceto', String(b)]])))?.numberOfResults ?? 0;
    const out = [];
    const stack = [[lo0, hi0, total]];
    while (stack.length) {
        const [a, b, n] = stack.pop();
        if (!n) continue;
        if (n <= CAP || b - a < 50) { out.push([a, b, n]); continue; }
        const mid = Math.floor((a + b) / 2);
        const [nLo, nHi] = await Promise.all([count(a, mid), count(mid + 1, b)]);
        stack.push([mid + 1, b, nHi], [a, mid, nLo]);
    }
    return out;
}

async function* searchCars(s) {
    const first = await getPage(pageUrl(s));
    if (!first) throw new Error('Search page not found (404)');
    const total = first.numberOfResults ?? 0;
    if (s.wantModel && !/(mo|gr|ml)\d/.test(first.pageQuery?.cat || '')) log.warning(`${s.label}: model not recognised by AutoScout24, searching the whole make. Paste a search URL for this one.`);
    log.info(`${s.label}: ${total} car(s).`);
    if (!total) return;
    const windows = total > CAP && perSearch > CAP ? await priceWindows(s, total) : [[null, null, total]];
    if (windows.length > 1) log.info(`${s.label}: split into ${windows.length} price windows.`);
    // Windows are read round-robin (page 1 of each, then page 2...), so a
    // capped run gets the newest cars across all prices, not just the cheapest.
    // The consumer stops pulling once it has enough (after de-duplication).
    let active = windows.map(([a, b]) => ({ extra: a == null ? [] : [['pricefrom', String(a)], ['priceto', String(b)]], first: a == null, done: false }));
    for (let page = 1; page <= MAX_PAGES && active.length; page++) {
        for (const w of active) {
            const pp = w.first && page === 1 ? first : await getPage(pageUrl(s, [...w.extra, ['page', String(page)]]));
            const ls = pp?.listings || [];
            for (const l of ls) yield toRow(l, s.origin);
            if (ls.length < PER_PAGE || page >= (pp?.numberOfPages || 0)) w.done = true;
            await sleep(250);
        }
        active = active.filter((w) => !w.done);
    }
}

// ---------- Rows ----------

const OFFER = { U: 'used', N: 'new', J: 'employee car', D: 'demonstration', S: 'pre-registered', O: 'classic' };
const detail = (l, icon) => (l.vehicleDetails || []).find((d) => d.iconName === icon && !d.isPlaceholder)?.data || null;

function toRow(l, origin) {
    const v = l.vehicle || {};
    const t = l.tracking || {};
    const reg = String(t.firstRegistration || '').match(/^(\d{2})-(\d{4})$/);
    const power = detail(l, 'speedometer');
    const seller = l.seller || {};
    return {
        listingId: l.id,
        url: l.url ? new URL(l.url, origin).href : null,
        title: [v.make, v.model, v.modelVersionInput].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        make: v.make || null,
        model: v.model || null,
        modelGroup: v.modelGroup || null,
        variant: v.variant || null,
        version: (v.modelVersionInput || '').trim() || null,
        price: l.price?.priceRaw ?? (t.price ? Number(t.price) : null),
        priceFormatted: l.price?.priceFormatted || null,
        currency: /€/.test(l.price?.priceFormatted || '') || !l.price?.priceFormatted ? 'EUR' : null,
        // AutoScout24's market band: 0 = cheapest against similar cars, 6 = most expensive.
        // Only the country sites (.de, .it...) publish it; autoscout24.com does not.
        priceRatingScore: l.price?.isPriceEvaluationEnabled && Number.isInteger(l.price?.priceEvaluation) ? l.price.priceEvaluation : null,
        mileageKm: t.mileage != null && t.mileage !== '' ? Number(t.mileage) : null,
        firstRegistration: reg ? `${reg[2]}-${reg[1]}` : null,
        firstRegistrationYear: reg ? Number(reg[2]) : null,
        fuel: v.fuel || null,
        transmission: v.transmission || null,
        power: power || null,
        powerKw: power ? Number(power.match(/(\d+)\s*kW/)?.[1]) || null : null,
        powerHp: power ? Number(power.match(/(\d+)\s*(?:hp|PS|CV|ch|pk)/i)?.[1]) || null : null,
        engineCc: v.engineDisplacementInCCM ? Number(String(v.engineDisplacementInCCM).replace(/\D/g, '')) || null : null,
        condition: OFFER[v.offerType] || v.offerType || null,
        isDamaged: v.isCurrentlyDamaged ?? null,
        equipmentSummary: v.subtitle || null,
        countryCode: l.location?.countryCode || null,
        zip: l.location?.zip || null,
        city: l.location?.city || null,
        street: l.location?.street || null,
        sellerType: seller.type === 'PrivateSeller' ? 'private' : seller.type ? 'dealer' : null,
        sellerId: seller.id ? String(seller.id) : null,
        sellerName: seller.companyName || seller.contactName || null,
        sellerContact: seller.contactName || null,
        sellerPhones: (seller.phones || []).map((p) => ({ type: p.phoneType, number: p.callTo || p.formattedNumber })),
        sellerPage: seller.links?.infoPage || null,
        sellerRating: l.ratings?.ratingsEnabled ? l.ratings.ratingsStars ?? null : null,
        sellerRatingCount: l.ratings?.ratingsEnabled ? l.ratings.ratingsCount ?? null : null,
        leadsRange: l.statistics?.leadsRange || null,
        images: (l.images || []).map((i) => i.replace(/\/\d+x\d+\.webp$/, '/1280x960.webp')),
    };
}

const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|ul)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;| /g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function details(url) {
    const pp = await getPage(url);
    const d = pp?.listingDetails;
    if (!d) return { detailError: 'Listing no longer available' };
    const v = d.vehicle || {};
    const eq = v.equipment || {};
    return {
        description: strip(d.description) || null,
        equipment: Object.values(eq).flat().map((e) => e?.id).filter(Boolean),
        bodyType: v.bodyType || null,
        bodyColor: v.bodyColor || null,
        bodyColorOriginal: v.bodyColorOriginal || null,
        paintType: v.paintType || null,
        upholstery: v.upholstery || null,
        seats: v.numberOfSeats ?? null,
        doors: v.numberOfDoors ?? null,
        driveTrain: v.driveTrain || null,
        gears: v.gears ?? null,
        cylinders: v.cylinders ?? null,
        weightKg: v.weight ?? null,
        co2GPerKm: v.co2emissionInGramPerKmWithFallback?.raw ?? null,
        fuelConsumption: v.fuelConsumptionCombined?.raw != null ? v.fuelConsumptionCombined.formatted : null,
        electricRangeKm: v.electricRangeWithFallback?.raw ?? null,
        emissionClass: v.environmentEuDirective?.formatted || null,
        previousOwners: v.noOfPreviousOwners ?? null,
        hadAccident: v.hadAccident ?? null,
        hasFullServiceHistory: v.hasFullServiceHistory ?? null,
        nonSmoking: v.nonSmoking ?? null,
        productionYear: v.productionYear ?? null,
        latitude: d.location?.latitude ?? null,
        longitude: d.location?.longitude ?? null,
        marketMedianPrice: d.prices?.public?.median ?? null,
        priceNegotiable: d.prices?.public?.negotiable ?? null,
        vatDeductible: d.prices?.public?.taxDeductible ?? null,
        listedAt: d.createdTimestampWithOffset || null,
        hasWarranty: d.warrantyExists ?? null,
        sellerRatingAverage: d.ratings?.ratingsAverage || null,
        sellerRecommendPercent: d.ratings?.recommendPercentage ?? null,
        views: d.dpvStatistics?.interaction ?? null,
        favorites: d.dpvStatistics?.favorites ?? null,
    };
}

// ---------- Run ----------

let cars = 0;
let detailed = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function pool(rows, fn, width = 4) {
    const out = new Array(rows.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, rows.length) }, async () => {
        while (i < rows.length) { const k = i++; out[k] = await fn(rows[k]); }
    }));
    return out;
}

const searches = buildSearches();
if (!searches.length) searches.push({ origin: 'https://www.autoscout24.com', path: '/lst/volkswagen/golf', params: [['atype', 'C']], label: 'Volkswagen / Golf', wantModel: true });
const seen = new Set();

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let batch = [];
    const flush = async () => {
        const extras = includeDetails ? await pool(batch, async (row) => {
            if (!row.url) return {};
            try { return await details(row.url); } catch (err) { return { detailError: String(err?.message || err) }; }
        }) : batch.map(() => ({}));
        for (let k = 0; k < batch.length && keepGoing; k++) {
            const extra = extras[k];
            const withDetail = includeDetails && !extra.detailError;
            await Actor.pushData({ ...batch[k], ...extra, search: s.label, scrapedAt: new Date().toISOString() });
            cars += 1;
            count += 1;
            if (withDetail) detailed += 1;
            if (!(await charge(withDetail ? 'listing_detail' : 'listing'))) keepGoing = false;
        }
        batch = [];
    };
    try {
        for await (const row of searchCars(s)) {
            if (!keepGoing) break;
            if (seen.has(row.listingId)) continue;
            seen.add(row.listingId);
            batch.push(row);
            if (count + batch.length >= perSearch) break;
            if (batch.length >= (includeDetails ? 20 : 100)) await flush();
        }
        if (keepGoing && batch.length) await flush();
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    perSearchCounts.push({ search: s.label, cars: count });
}

if (!cars) await Actor.pushData({ rowType: 'note', note: 'No cars matched. Not charged.' });
await Actor.setValue('SUMMARY', { cars, withDetails: detailed, searches: perSearchCounts, failures });
log.info(`Done. ${cars} car(s)${includeDetails ? `, ${detailed} with details` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
