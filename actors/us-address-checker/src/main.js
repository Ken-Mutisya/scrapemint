// US Address Checker & GPS Finder: Verify & Geocode
//
// Strategy
// --------
// The US Census Bureau geocoder is a keyless, official JSON API. One GET per
// unique address (results cached within the run, duplicates in the input
// still get their own output row):
//   - /geocoder/locations/onelineaddress — match + coordinates only
//   - /geocoder/geographies/onelineaddress — adds county, official place,
//     congressional district and census tract (includeAreaInfo, default on)
// No match = HTTP 200 with an empty addressMatches array.
// Lookups run through a small pool; ~20k addresses fit in the 600s timeout.
//
// Pay per event
// -------------
//   address_found per MATCHED pushed row; unmatched addresses are pushed
//   free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const BASE = 'https://geocoding.geo.census.gov/geocoder';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const CHUNK_SIZE = 200;
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 25000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    addresses = [],
    includeAreaInfo = true,
    maxRows = 500,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const tokens = asTokens(addresses).slice(0, HARD_CAP);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

if (tokens.length === 0) {
    log.warning('No addresses given. Paste at least one US address.');
    await Actor.exit();
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-us-address-checker/0.1 (+https://apify.com)', accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const first = (g, layer) => (g?.[layer] || [])[0] || null;

function toResult(match) {
    if (!match) return { matched: false };
    const g = match.geographies || {};
    const county = first(g, 'Counties');
    const state = first(g, 'States');
    const tract = first(g, 'Census Tracts');
    const place = first(g, 'Incorporated Places');
    const congress = Object.keys(g).find((k) => /Congressional Districts/.test(k));
    const cd = congress ? first(g, congress) : null;
    return {
        matched: true,
        cleanAddress: match.matchedAddress || null,
        latitude: match.coordinates?.y ?? null,
        longitude: match.coordinates?.x ?? null,
        city: match.addressComponents?.city || null,
        state: match.addressComponents?.state || null,
        zip: match.addressComponents?.zip || null,
        ...(includeAreaInfo ? {
            county: county?.NAME || null,
            countyFips: county?.GEOID || null,
            stateName: state?.NAME || null,
            officialPlace: place?.NAME || null,
            congressionalDistrict: cd?.NAME || null,
            censusTract: tract?.GEOID || null,
        } : {}),
    };
}

// Geocode results per unique address string, cached within the run.
const cache = new Map();
async function lookup(addr) {
    if (cache.has(addr)) return cache.get(addr);
    const path = includeAreaInfo
        ? `${BASE}/geographies/onelineaddress?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
        : `${BASE}/locations/onelineaddress?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`;
    let out;
    try {
        const j = await fetchJson(path);
        out = toResult((j?.result?.addressMatches || [])[0]);
    } catch (err) {
        log.warning(`Lookup failed for "${addr.slice(0, 60)}": ${err?.message}`);
        out = { matched: false, error: 'lookup failed' };
    }
    cache.set(addr, out);
    return out;
}

async function resolveAll(addrs) {
    const queue = addrs.filter((a) => !cache.has(a));
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !pastDeadline()) {
            const a = queue.shift();
            if (a) await lookup(a);
        }
    });
    await Promise.all(workers);
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, { chargeable = true } = {}) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'address_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Checking ${tokens.length} address(es), pool of ${CONCURRENCY}${includeAreaInfo ? ', with area info' : ''}...`);

let matchedCount = 0;
outer:
for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    await resolveAll([...new Set(chunk)]);
    for (const addr of chunk) {
        if (rowsPushed >= cap) break outer;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break outer; }
        const res = cache.get(addr) ?? { matched: false, error: 'lookup skipped (timeout)' };
        if (res.matched) matchedCount += 1;
        await flushRow({ input: addr, ...res }, { chargeable: res.matched });
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${matchedCount} matched (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; unmatched are free).`);
await Actor.exit();
