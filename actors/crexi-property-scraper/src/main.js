// Crexi Scraper: commercial real estate for sale on Crexi, with the
// property facts and the listing brokers.
//
// Strategy
// --------
//   1. POST api.crexi.com/assets/search {count, offset, types, states, term,
//      askingPriceMin/Max, capRateMin, sortOrder, sortDirection}. Up to 500
//      a request, and offset + count must stay under 1,500 per search, so
//      several states or types run as one search per combination.
//      sortOrder accepts rank, activatedOn and updatedOn (2026-10-19).
//   2. GET api.crexi.com/assets/{id} for the property facts table, the
//      investment highlights and broker of record; GET /assets/{id}/brokers
//      for the listing brokers (name, brokerage, licenses, website).
//      Facts Crexi hides from logged-out users come back as "*****" and are
//      dropped.
//
// No login, no key, no proxy. Tested from Apify on 2026-10-19.
//
// Pay per event
// -------------
//   listing_row ($0.002) one listing
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const API = 'https://api.crexi.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PAGE = 500;
const WINDOW = 1499; // offset + count must be < 1500
const CONCURRENCY = 6;
const SORTS = { newest: 'activatedOn', relevance: 'rank', updated: 'updatedOn' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerm = '',
    states = [],
    propertyTypes = [],
    minPrice,
    maxPrice,
    minCapRate,
    includeUnpriced = true,
    sort = 'newest',
    includeDetails = true,
    maxListings = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const cap = Math.min(20000, Math.max(1, Number(maxListings) || 100));
const stateList = list(states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
const typeList = list(propertyTypes);
const pMin = num(minPrice);
const pMax = num(maxPrice);
const crMin = num(minCapRate);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

async function req(path, body) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(API + path, {
                method: body ? 'POST' : 'GET',
                body: body ? JSON.stringify(body) : undefined,
                headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://www.crexi.com', Referer: 'https://www.crexi.com/' },
                signal: AbortSignal.timeout(60_000),
            });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(2000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            return await r.json();
        } catch (err) {
            last = err;
            if (/HTTP 4\d\d/.test(err.message)) break;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

const strip = (html) => (html ? String(html).replace(/<\/(p|li|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t​]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() || null : null);
const hidden = (v) => typeof v === 'string' && /^\*+$/.test(v.trim());

function searchRow(a) {
    const loc = a.locations?.[0] || {};
    const capRate = num(String(a.description || '').match(/(\d+(?:\.\d+)?)\s*%\s*cap/i)?.[1]);
    return {
        id: a.id,
        name: a.name,
        url: `https://www.crexi.com/properties/${a.id}/${a.urlSlug || ''}`,
        status: a.status || null,
        propertyTypes: a.types || [],
        headline: a.description || null,
        askingPrice: a.askingPrice ?? null,
        capRatePct: capRate,
        squareFootage: a.squareFootage ?? null,
        pricePerSqft: a.askingPrice && a.squareFootage ? Math.round((a.askingPrice / a.squareFootage) * 100) / 100 : null,
        address: loc.address || null,
        city: loc.city || null,
        county: loc.county || null,
        state: loc.state?.code || null,
        zip: loc.zip || null,
        fullAddress: loc.fullAddress || null,
        latitude: loc.latitude ?? null,
        longitude: loc.longitude ?? null,
        brokerageName: a.brokerageName || null,
        listedAt: a.activatedOn || null,
        updatedAt: a.updatedOn || null,
        offersDueAt: a.offersDueOn || null,
        opportunityZone: !!a.isInOpportunityZone,
        hasOfferingMemorandum: !!a.hasOM,
        hasVideo: !!a.hasVideo,
        hasVirtualTour: !!a.hasVirtualTour,
        imageCount: a.numberOfImages ?? null,
        thumbnailUrl: a.thumbnailUrl || null,
        isNew: !!a.isNew,
    };
}

async function enrich(row) {
    const [d, brokers] = await Promise.all([
        req(`/assets/${row.id}`).catch((err) => { log.debug(`${row.id} detail: ${err.message}`); return null; }),
        req(`/assets/${row.id}/brokers`).catch(() => null),
    ]);
    if (d) {
        const details = {};
        for (const [k, v] of Object.entries(d.details || {})) if (v != null && v !== '' && !hidden(v)) details[k] = v;
        row.details = details;
        row.subtypes = d.subtypes || [];
        row.capRatePct = row.capRatePct ?? num(details['Cap Rate']);
        row.noi = num(details.NOI ?? details['Net Operating Income']);
        row.yearBuilt = num(details['Year Built']);
        row.lotSizeAcres = num(details['Lot Size (acres)']);
        row.investmentHighlights = strip(d.investmentHighlights);
        row.marketingDescription = strip(d.marketingDescription);
        row.isSold = !!d.isSold;
        row.brokerOfRecord = d.hasBrokerOfRecord ? { name: d.brokerOfRecordName || null, brokerage: d.brokerOfRecordBrokerageName || null, license: d.brokerOfRecordLicense || null, phone: d.brokerOfRecordPhone || null } : null;
    }
    row.brokers = (Array.isArray(brokers) ? brokers : []).map((b) => ({
        name: [b.firstName, b.lastName].filter(Boolean).join(' ') || null,
        brokerage: b.brokerage?.name || b.licenseDetails?.[0]?.brokerageName || null,
        brokerageWebsite: b.brokerage?.website || null,
        brokerageCity: b.brokerage?.location?.city || null,
        brokerageState: b.brokerage?.location?.state?.code || null,
        licenses: (b.licenseDetails || []).map((l) => `${l.licenseStateCode || ''} ${l.number}`.trim()),
        crexiProfileId: b.publicProfileId || null,
        activeListings: b.numberOfAssets ?? null,
        photoUrl: b.thumbnailUrl || null,
    }));
    return row;
}

// ---- 1. search ----
const combos = [];
for (const s of stateList.length ? stateList : [null]) for (const t of typeList.length ? typeList : [null]) combos.push({ s, t });
const base = { sortOrder: SORTS[sort] || 'activatedOn', sortDirection: 'Descending', includeUnpriced: pMin == null && pMax == null ? !!includeUnpriced : false };
if (searchTerm) base.term = String(searchTerm).trim();
if (pMin != null) base.askingPriceMin = pMin;
if (pMax != null) base.askingPriceMax = pMax;
if (crMin != null) base.capRateMin = crMin;

// Each state/type search gets an even share of maxListings, so TX does not use it all before FL.
const quota = Math.ceil(cap / combos.length);
const found = new Map();
const perSearch = {};
for (const { s, t } of combos) {
    if (found.size >= cap || pastDeadline()) break;
    const body = { ...base, ...(s ? { states: [s] } : {}), ...(t ? { types: [t] } : {}) };
    const label = [s || 'US', t || 'all types'].join(' / ');
    let total = null;
    const stopAt = Math.min(cap, found.size + quota);
    for (let offset = 0; offset < WINDOW && found.size < stopAt; offset += PAGE) {
        const count = Math.min(PAGE, WINDOW - offset, stopAt - found.size);
        let res;
        try { res = await req('/assets/search', { ...body, count, offset }); } catch (err) { log.warning(`${label}: ${err.message}`); break; }
        total = res?.totalCount ?? total;
        const data = res?.data || [];
        for (const a of data) if (!found.has(a.id) && found.size < stopAt) found.set(a.id, searchRow(a));
        if (data.length < count) break;
    }
    perSearch[label] = total;
    log.info(`${label}: ${total ?? 0} matching listings, ${found.size} collected so far.`);
    if (total > WINDOW && quota > WINDOW) log.info(`  ${label} has more than ${WINDOW + 1} listings; Crexi returns the first ${WINDOW + 1}. Split by state or type to go deeper.`);
}

// ---- 2. details + output ----
const rows = [...found.values()];
let out = 0;
let stop = false;
let next = 0;
async function worker() {
    while (next < rows.length && !stop && !pastDeadline()) {
        let row = rows[next++];
        if (includeDetails) row = await enrich(row);
        await Actor.pushData(row);
        out++;
        try {
            const res = await Actor.charge({ eventName: 'listing_row' });
            if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        if (out % 100 === 0) log.info(`${out}/${rows.length} listings written.`);
    }
}
await Promise.all(Array.from({ length: includeDetails ? CONCURRENCY : 1 }, worker));
if (pastDeadline()) log.warning(`Close to the run timeout; wrote ${out} of ${rows.length}.`);

if (!out) await Actor.pushData({ note: 'No Crexi listings matched. Not charged.' });
await Actor.setValue('SUMMARY', { listings: out, matchingPerSearch: perSearch });
log.info(`Done: ${out} listings.`);
await Actor.exit();
