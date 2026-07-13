// Home Prices & Listings Scraper: Redfin Homes by Area
//
// Strategy
// --------
// Redfin's internal "stingray" JSON API, plain HTTP with a browser
// user-agent, no browser, no proxy, no API key. Notes from probing:
//   - /stingray/api/* endpoints answer plain requests; /stingray/do/*
//     (autocomplete) sits behind CloudFront and 403s, so we resolve areas
//     from Redfin URLs (region id is in city/neighborhood/county URLs) or
//     by fetching the zip page and reading the embedded regionId.
//   - Responses are prefixed with "{}&&", strip before JSON.parse.
//   - num_homes caps around 350 per region. Sold-home queries were probed
//     (sold_within_days, include=sold-6mo, sf=..., status=130/131) but the
//     current gis version ignores them all and returns active listings, so
//     v0.1 is for-sale only. Do not re-add a sold mode without finding a
//     param set that actually returns mlsStatus "Sold".
//   - Price/bed filters are ALSO applied locally so results stay correct
//     even if a server-side filter param is ignored.
//
// DC-block gate: Redfin may block datacenter IPs. Per policy the live run
// on Apify must return rows BEFORE pricing/publishing; 0 rows = stop.
//
// Pay per event
// -------------
//   home_listing per pushed row. First 2 rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://www.redfin.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const PER_REGION_MAX = 350;
const FETCH_TIMEOUT_MS = 30000;

const UIPT = { house: 1, condo: 2, townhouse: 3, multi_family: 4, land: 5, other: 6 };

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    areas = [],
    minPrice = null,
    maxPrice = null,
    minBeds = null,
    propertyTypes = [],
    maxRows = 100,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const areaTokens = asTokens(areas);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const types = (Array.isArray(propertyTypes) && propertyTypes.length > 0 ? propertyTypes : ['house', 'condo', 'townhouse', 'multi_family'])
    .map((t) => UIPT[t]).filter(Boolean);

if (areaTokens.length === 0) {
    log.warning('No areas given. Paste a Redfin page link (city, zip, neighborhood or county) or a 5 digit zip code.');
    await Actor.exit();
}

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

const stingrayJson = (text) => JSON.parse(text.replace(/^\{\}&&/, ''));

// Redfin region types: 1 neighborhood, 2 zipcode, 5 county, 6 city.
async function resolveArea(token) {
    let m = token.match(/\/city\/(\d+)/);
    if (m) return { id: m[1], type: 6, label: token };
    m = token.match(/\/neighborhood\/(\d+)/);
    if (m) return { id: m[1], type: 1, label: token };
    m = token.match(/\/county\/(\d+)/);
    if (m) return { id: m[1], type: 5, label: token };
    const zip = token.match(/\/zipcode\/(\d{5})/)?.[1] || token.match(/^(\d{5})$/)?.[1];
    if (zip) {
        const html = await fetchText(`${BASE}/zipcode/${zip}`);
        const id = html.match(/regionId=(\d+)/)?.[1] || html.match(/"regionId":(\d+)/)?.[1];
        if (id) return { id, type: 2, label: `zip ${zip}` };
        throw new Error(`could not find the Redfin region for zip ${zip}`);
    }
    throw new Error('not a Redfin link or 5 digit zip code');
}

function num(v) {
    const n = typeof v === 'object' && v !== null ? v.value : v;
    return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
}

function toRow(h, areaLabel) {
    const path = h.url || null;
    return {
        area: areaLabel,
        address: h.streetLine?.value || null,
        city: h.city || null,
        state: h.state || null,
        zip: h.zip || null,
        price: num(h.price),
        beds: num(h.beds),
        baths: num(h.baths),
        squareFeet: num(h.sqFt),
        pricePerSquareFoot: num(h.pricePerSqFt),
        lotSizeSquareFeet: num(h.lotSize),
        yearBuilt: num(h.yearBuilt),
        hoaPerMonth: num(h.hoa),
        daysOnMarket: num(h.dom),
        lastSoldDate: h.soldDate ? new Date(h.soldDate).toISOString().slice(0, 10) : null,
        isNewConstruction: Boolean(h.isNewConstruction),
        latitude: h.latLong?.value?.latitude ?? null,
        longitude: h.latLong?.value?.longitude ?? null,
        mlsNumber: h.mlsId?.value || null,
        url: path ? `${BASE}${path}` : null,
    };
}

function passesFilters(row) {
    if (minPrice != null && row.price != null && row.price < Number(minPrice)) return false;
    if (maxPrice != null && Number(maxPrice) > 0 && row.price != null && row.price > Number(maxPrice)) return false;
    if (minBeds != null && Number(minBeds) > 0 && (row.beds ?? 0) < Number(minBeds)) return false;
    return true;
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'home_listing' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`${areaTokens.length} area(s), for sale now, home types [${types.join(',')}]...`);

const seenUrls = new Set();
outer:
for (const token of areaTokens) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

    let region;
    try {
        region = await resolveArea(token);
    } catch (err) {
        log.warning(`Skipping "${token}": ${err?.message}`);
        continue;
    }

    const params = new URLSearchParams({
        al: '1',
        num_homes: String(PER_REGION_MAX),
        page_number: '1',
        region_id: region.id,
        region_type: String(region.type),
        status: '9',
        uipt: types.join(','),
        v: '8',
        ord: 'redfin-recommended-asc',
    });
    if (minPrice != null && Number(minPrice) > 0) params.set('min_price', String(Number(minPrice)));
    if (maxPrice != null && Number(maxPrice) > 0) params.set('max_price', String(Number(maxPrice)));
    if (minBeds != null && Number(minBeds) > 0) params.set('num_beds', String(Number(minBeds)));

    let homes;
    try {
        const j = stingrayJson(await fetchText(`${BASE}/stingray/api/gis?${params}`));
        homes = j?.payload?.homes || [];
    } catch (err) {
        log.warning(`Area "${token}" failed: ${err?.message}`);
        continue;
    }
    log.info(`${region.label}: ${homes.length} home(s) returned.`);

    for (const h of homes) {
        if (rowsPushed >= cap) break outer;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break outer; }
        const row = toRow(h, region.label);
        if (!passesFilters(row)) continue;
        if (row.url && seenUrls.has(row.url)) continue;
        if (row.url) seenUrls.add(row.url);
        await flushRow(row);
    }
}

log.info(`Done. ${rowsPushed} home(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable past the ${FREE_TIER_ROWS} free).`);
await Actor.exit();
