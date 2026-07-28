// Business Locations Worldwide: Shops, Restaurants and Services by Area
//
// What it does
// ------------
// Every restaurant, hotel, pharmacy, supermarket, bank, gym or charging point
// in any city or map rectangle on earth, with the name, brand, address, phone,
// website and opening hours the map carries. Name a city and it resolves the
// boundary for you, or pass your own bounding box or a radius around a point.
//
// Why this and not a maps scraper
// -------------------------------
// This reads the open map database directly over plain HTTP. There is no
// browser, no antibot to fight and no proxy, so a run costs a fraction of a
// browser based scrape of a commercial maps product. The trade off is honest:
// coverage is community maintained, so it is excellent in Europe and strong in
// dense urban areas everywhere, while a quiet suburb may carry fewer listings
// and thinner contact details than a commercial directory.
//
// Pay per event
// -------------
//   place_row ($0.006) charged per place returned. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 60000;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// The main endpoint refuses these requests with a 406 while the mirrors serve
// them, and any instance can answer 429 or 504 when busy, so hosts rotate.
const OVERPASS_HOSTS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
];
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    city = 'Lisbon, Portugal',
    boundingBox = '',
    latitude = '',
    longitude = '',
    radiusMeters = 0,
    categories = ['restaurant', 'cafe', 'hotel'],
    brand = '',
    requireWebsite = false,
    requirePhone = false,
    requireOpeningHours = false,
    maxResults = 150,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Friendly names mapped to the map's own tags, grouped by tag key so the whole
// request goes out as one query rather than one per category.
const CATEGORIES = {
    restaurant: ['amenity', 'restaurant'],
    cafe: ['amenity', 'cafe'],
    bar: ['amenity', 'bar'],
    pub: ['amenity', 'pub'],
    fast_food: ['amenity', 'fast_food'],
    pharmacy: ['amenity', 'pharmacy'],
    doctor: ['amenity', 'doctors'],
    dentist: ['amenity', 'dentist'],
    hospital: ['amenity', 'hospital'],
    veterinary: ['amenity', 'veterinary'],
    bank: ['amenity', 'bank'],
    atm: ['amenity', 'atm'],
    fuel: ['amenity', 'fuel'],
    ev_charging: ['amenity', 'charging_station'],
    school: ['amenity', 'school'],
    kindergarten: ['amenity', 'kindergarten'],
    cinema: ['amenity', 'cinema'],
    supermarket: ['shop', 'supermarket'],
    convenience: ['shop', 'convenience'],
    bakery: ['shop', 'bakery'],
    butcher: ['shop', 'butcher'],
    clothing: ['shop', 'clothes'],
    hairdresser: ['shop', 'hairdresser'],
    beauty: ['shop', 'beauty'],
    car_dealer: ['shop', 'car'],
    car_repair: ['shop', 'car_repair'],
    electronics: ['shop', 'electronics'],
    furniture: ['shop', 'furniture'],
    hardware: ['shop', 'doityourself'],
    florist: ['shop', 'florist'],
    optician: ['shop', 'optician'],
    hotel: ['tourism', 'hotel'],
    guest_house: ['tourism', 'guest_house'],
    hostel: ['tourism', 'hostel'],
    museum: ['tourism', 'museum'],
    gym: ['leisure', 'fitness_centre'],
    coworking: ['office', 'coworking'],
};

const wantCategories = asList(categories).map((c) => c.toLowerCase().replace(/[\s-]+/g, '_'));
const brandFilter = clean(brand)?.toLowerCase() ?? null;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 150));

async function getText(url, opts = {}, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
        return { status: res.status, body: await res.text() };
    } catch (err) {
        if (attempt < 1) { await sleep(1500); return getText(url, opts, attempt + 1); }
        return { status: 0, body: '', error: err?.message };
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'place_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// Resolve a place name to a bounding box. One call, and the service asks for
// no more than one request a second with a descriptive user agent.
async function geocode(place) {
    const { status, body } = await getText(`${NOMINATIM}?q=${encodeURIComponent(place)}&format=json&limit=1`);
    if (status !== 200) return null;
    let json;
    try { json = JSON.parse(body); } catch { return null; }
    const hit = Array.isArray(json) ? json[0] : null;
    if (!hit?.boundingbox) return null;
    const [south, north, west, east] = hit.boundingbox.map(Number);
    return { south, west, north, east, name: clean(hit.display_name) };
}

function parseBoundingBox(text) {
    const parts = String(text || '').split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [south, west, north, east] = parts;
    if (south >= north || west >= east) return null;
    return { south, west, north, east, name: null };
}

// Overpass answers with an XML error document even when JSON was requested,
// so a body that does not start with a brace is an error, not data.
async function runOverpass(query) {
    for (const host of OVERPASS_HOSTS) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const { status, body, error } = await getText(`${host}?data=${encodeURIComponent(query)}`);
        if (status === 200 && body.trimStart().startsWith('{')) {
            try { return { json: JSON.parse(body), host }; } catch { /* fall through */ }
        }
        log.warning(`${host.split('/')[2]} unavailable (status ${status}${error ? `, ${error}` : ''}), trying the next mirror`);
        await sleep(2500);
    }
    return null;
}

// Coordinates come in as text, because an Apify input schema has no decimal
// number type and an integer field rejects 52.52 outright.
const lat = Number(String(latitude).trim());
const lon = Number(String(longitude).trim());
const hasPoint = Number.isFinite(lat) && Number.isFinite(lon)
    && (lat !== 0 || lon !== 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

const area = parseBoundingBox(boundingBox)
    || (hasPoint && Number(radiusMeters) ? { around: true } : null)
    || (clean(city) ? await geocode(clean(city)) : null);

if (!area) {
    await flushRow({
        type: 'note', found: false,
        note: 'could not work out an area; give a city name such as "Lisbon, Portugal", a bounding box as south,west,north,east, or a latitude, longitude and radius; not charged',
    }, false);
    log.error('no area resolved');
    await Actor.exit();
}

const selected = wantCategories.filter((c) => CATEGORIES[c]);
const unknown = wantCategories.filter((c) => !CATEGORIES[c]);
for (const u of unknown) {
    await flushRow({
        type: 'note', found: false, requested: u,
        note: `unknown category; available: ${Object.keys(CATEGORIES).join(', ')}; not charged`,
    }, false);
}
if (!selected.length) {
    await flushRow({ type: 'note', found: false, note: 'no valid categories requested; not charged' }, false);
    log.error('no categories');
    await Actor.exit();
}

// One union query for every requested category, grouped by tag key.
const byKey = new Map();
for (const c of selected) {
    const [key, value] = CATEGORIES[c];
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(value);
}
const areaClause = area.around
    ? `(around:${Math.max(1, Math.min(50000, Number(radiusMeters)))},${lat},${lon})`
    : `(${area.south},${area.west},${area.north},${area.east})`;
const brandClause = brandFilter ? `["brand"~"${brandFilter.replace(/["\\]/g, '')}",i]` : '';
const union = [...byKey.entries()]
    .map(([key, values]) => `  nwr["${key}"~"^(${values.join('|')})$"]${brandClause}${areaClause};`)
    .join('\n');
// `out center` is what gives ways and relations a coordinate. Without it a
// hotel or supermarket mapped as a building outline comes back with no
// position at all and would be dropped, which quietly removes a large share of
// the larger businesses from every result.
const query = `[out:json][timeout:90];\n(\n${union}\n);\nout center ${Math.min(cap * 3, 6000)};`;

log.info(`Area: ${area.name || (area.around ? `${radiusMeters}m around ${lat},${lon}` : areaClause)} | categories: ${selected.join(', ')}`);

const result = await runOverpass(query);
if (!result) {
    await flushRow({
        type: 'note', found: false,
        note: 'every map server was busy or refused the request; these are free community servers, so waiting a minute and running again usually works, and a smaller area always helps; not charged',
    }, false);
    log.error('all overpass hosts failed');
    await Actor.exit();
}

const elements = result.json.elements || [];
log.info(`${elements.length} element(s) returned by ${result.host.split('/')[2]}`);

const categoryOf = (tags) => {
    for (const [name, [key, value]] of Object.entries(CATEGORIES)) {
        if (tags?.[key] === value) return name;
    }
    return null;
};

// The map server returns every point first, then every building outline. With
// a row cap that ordering hands back only the points and silently drops the
// businesses mapped as outlines, which skews towards the larger premises.
// Ranking by how complete a listing is removes the bias and puts the most
// usable records first.
function completeness(el) {
    const t = el.tags || {};
    const has = (...keys) => keys.some((k) => clean(t[k]));
    return (has('name') ? 3 : 0)
        + (has('website', 'contact:website', 'url') ? 3 : 0)
        + (has('phone', 'contact:phone', 'contact:mobile') ? 3 : 0)
        + (has('opening_hours') ? 2 : 0)
        + (has('addr:street') ? 2 : 0)
        + (has('email', 'contact:email') ? 2 : 0)
        + (has('brand') ? 1 : 0);
}
const ranked = [...elements].sort((a, b) => completeness(b) - completeness(a));

let emitted = 0;
let skippedNoCoords = 0;
let skippedFilters = 0;
const seen = new Set();

for (const el of ranked) {
    if (emitted >= cap) break;
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;
    if (lat == null || lon == null) { skippedNoCoords += 1; continue; }

    const website = clean(tags.website || tags['contact:website'] || tags.url);
    const phone = clean(tags.phone || tags['contact:phone'] || tags['contact:mobile']);
    const openingHours = clean(tags.opening_hours);
    if (requireWebsite && !website) { skippedFilters += 1; continue; }
    if (requirePhone && !phone) { skippedFilters += 1; continue; }
    if (requireOpeningHours && !openingHours) { skippedFilters += 1; continue; }

    // The same business can appear as both a point and a building outline.
    const name = clean(tags.name);
    const dedupeKey = name ? `${name.toLowerCase()}|${lat.toFixed(4)}|${lon.toFixed(4)}` : `${el.type}|${el.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    await flushRow({
        category: categoryOf(tags),
        name,
        brand: clean(tags.brand),
        operator: clean(tags.operator),
        latitude: lat,
        longitude: lon,
        street: clean(tags['addr:street']),
        houseNumber: clean(tags['addr:housenumber']),
        postcode: clean(tags['addr:postcode']),
        cityName: clean(tags['addr:city']),
        country: clean(tags['addr:country']),
        phone,
        website,
        email: clean(tags.email || tags['contact:email']),
        openingHours,
        cuisine: clean(tags.cuisine),
        wheelchair: clean(tags.wheelchair),
        takeaway: clean(tags.takeaway),
        outdoorSeating: clean(tags.outdoor_seating),
        hasWebsite: Boolean(website),
        hasPhone: Boolean(phone),
        osmType: el.type,
        osmId: el.id,
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        searchedArea: area.name || null,
        source: 'OpenStreetMap contributors, ODbL',
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
}

if (skippedNoCoords) log.info(`${skippedNoCoords} element(s) had no coordinate and were skipped`);
if (skippedFilters) log.info(`${skippedFilters} place(s) removed by the contact filters`);

if (!emitted && !notePushed) {
    await flushRow({
        type: 'note', found: false, elementsReturned: elements.length,
        note: elements.length
            ? 'places were found but every one was removed by the filters; turn off requireWebsite, requirePhone or requireOpeningHours; not charged'
            : 'no places of these categories are mapped in this area; try a larger area, a bigger city, or different categories; not charged',
    }, false);
}

log.info(`Done. ${emitted} place(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
