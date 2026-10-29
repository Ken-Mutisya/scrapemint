// Redfin Scraper: For Sale & Sold Homes, Price Changes
//
// Strategy
// --------
// Each Redfin search page embeds its own map query result (up to 350 homes
// with the full listing record, see parse.js), so one page fetch is one
// search. Input is any Redfin search URL (city, neighborhood, county, ZIP,
// with redfin.com filters) or a ZIP code plus listing type and filters.
// A search that comes back at the 350 cap is split into price bands on
// Redfin's own price points until each band fits. Homes are deduped by
// propertyId across searches. Optional tracking keeps price and status
// per home in a named store and adds the change since the last run.
//
// Redfin's location lookup and home-detail endpoints return 403 on every
// proxy tier (tested 2026-10-29), so names cannot be resolved to IDs and
// per-home price history is not available; search pages are.
//
// Cost control
// ------------
// Search pages answer Apify's IPs directly most of the time; the rest get
// a 202 bot challenge that US residential clears. Pages are ~1.5 MB
// (~$0.012 on residential) for up to 350 homes. Residential is capped at
// ~20% of charged revenue (proxy-guard, see the share note below). No
// proxy input is exposed.
//
// Pay per event
// -------------
//   home ($0.002) one home row
//   unchanged_home ($0.0002) a home checked in only-changes mode with no
//   change since the last run; it pays for the page fetch on quiet runs.

import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import {
    PAGE_CAP, PRICE_LADDER, isRedfinBlock, parseSearchPage, homeRow,
    parseSearchUrl, buildSearchPath, priceToken, parsePriceToken,
} from './parse.js';

const HOME_PRICE = 0.002;
const UNCHANGED_PRICE = 0.0002;
const MAX_PAGES = 400;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    zipCodes = [],
    listingType = 'for_sale',
    minPrice,
    maxPrice,
    minBeds,
    splitLargeSearches = true,
    trackChanges = false,
    onlyChanges = false,
    maxHomes = 500,
} = input;

const asList = (x) => (Array.isArray(x) ? x : String(x || '').split(/[\n,]/))
    .map((s) => (typeof s === 'object' && s?.url ? s.url : String(s || '')).trim()).filter(Boolean);
const cap = Math.max(1, Math.min(20000, Number(maxHomes) || 500));

const searches = [];
for (const raw of asList(searchUrls)) {
    const s = parseSearchUrl(raw);
    if (s) searches.push({ ...s, label: raw });
    else log.warning(`Not a Redfin search URL, skipped: ${raw}`);
}
for (const z of asList(zipCodes)) {
    if (!/^\d{5}$/.test(z)) { log.warning(`Not a 5-digit ZIP code, skipped: ${z}`); continue; }
    const filters = new Map();
    if (listingType && listingType !== 'for_sale') filters.set('include', listingType);
    if (Number(minPrice) > 0) filters.set('min-price', priceToken(Number(minPrice)));
    if (Number(maxPrice) > 0) filters.set('max-price', priceToken(Number(maxPrice)));
    if (Number(minBeds) > 0) filters.set('min-beds', String(Math.floor(Number(minBeds))));
    searches.push({ base: `/zipcode/${z}`, filters, label: z });
}

if (!searches.length) {
    await Actor.pushData({ note: 'Add a Redfin search URL (e.g. https://www.redfin.com/city/30818/TX/Austin) or a ZIP code. Not charged.' });
    await Actor.exit();
}

// The guard meters decoded page bytes; Redfin pages compress ~5x on the wire
// (test run 10-29: metered $0.16, billed $0.029). share 1.0 of metered
// revenue is therefore ~20% of revenue in real proxy cost.
const guard = new ProxyGuard({ tiers: ['direct', 'datacenter', 'residential'], country: 'US', share: 1.0, floorUsd: 0.1, isBlocked: isRedfinBlock });
const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const stats = { searches: searches.length, pagesFetched: 0, pagesFailed: 0, bandsSplit: 0, cappedBands: 0, homesSeen: 0, rows: 0, unchangedSkipped: 0 };
const deadline = installDeadline(() => saveAll());

// --- change tracking ---
const trackKey = `state-${crypto.createHash('sha1').update(searches.map((s) => buildSearchPath(s)).sort().join('|')).digest('hex').slice(0, 16)}`;
const store = trackChanges ? await Actor.openKeyValueStore('redfin-price-tracker') : null;
const prev = (store && (await store.getValue(trackKey))) || {};
const next = { ...prev };
async function saveAll() {
    if (store) await store.setValue(trackKey, next);
    await Actor.setValue('SUMMARY', { ...stats, ...guard.report() });
}

async function fetchSearch(path) {
    if (stats.pagesFetched + stats.pagesFailed >= MAX_PAGES) return null;
    const res = await guard.get(`https://www.redfin.com${path}`, { headers, timeoutMs: 45_000, retriesPerTier: 1 });
    if (!res || res.statusCode !== 200) {
        stats.pagesFailed++;
        log.warning(`${path}: ${res ? `HTTP ${res.statusCode} on ${res.tier}` : 'blocked on every tier'}`);
        return null;
    }
    const parsed = parseSearchPage(res.body);
    if (!parsed.found) {
        stats.pagesFailed++;
        log.warning(`${path}: page had no search data (${res.tier}, ${Math.round(res.body.length / 1024)} KB)`);
        return null;
    }
    stats.pagesFetched++;
    return parsed.homes;
}

const seen = new Set();
let rowsPushed = 0;
let stop = false;

async function emit(homes, label) {
    const rows = [];
    let unchanged = 0;
    for (const h of homes) {
        if (rowsPushed + rows.length >= cap) break;
        if (h?.propertyId == null || seen.has(h.propertyId)) continue;
        seen.add(h.propertyId);
        stats.homesSeen++;
        const row = homeRow(h);
        if (store) {
            const p = prev[row.propertyId];
            next[row.propertyId] = [row.price, row.status, p?.[2] || new Date().toISOString().slice(0, 10)];
            row.isNew = !p;
            row.previousPrice = p ? p[0] : null;
            row.priceChange = p && row.price != null && p[0] != null ? row.price - p[0] : null;
            row.previousStatus = p ? p[1] : null;
            row.firstSeen = p?.[2] || next[row.propertyId][2];
            if (onlyChanges && p && p[0] === row.price && p[1] === row.status) { stats.unchangedSkipped++; unchanged++; continue; }
        }
        rows.push({ ...row, search: label, scrapedAt: new Date().toISOString() });
    }
    if (unchanged && !(await chargeRows(guard, 'unchanged_home', UNCHANGED_PRICE, unchanged))) stop = true;
    if (!rows.length) return;
    await Actor.pushData(rows);
    rowsPushed += rows.length;
    stats.rows += rows.length;
    if (!(await chargeRows(guard, 'home', HOME_PRICE, rows.length))) stop = true;
}

// Ladder points strictly inside (lo, hi); hi null means no upper bound.
const innerPoints = (lo, hi) => PRICE_LADDER.filter((p) => p > (lo ?? 0) && (hi == null || p < hi));

async function runSearch(s, lo, hi, depth = 0) {
    if (stop || rowsPushed >= cap || deadline.pastSoft()) return;
    const filters = new Map(s.filters);
    if (lo != null && lo > 0) filters.set('min-price', priceToken(lo)); else if (depth) filters.delete('min-price');
    if (hi != null) filters.set('max-price', priceToken(hi)); else if (depth) filters.delete('max-price');
    const path = buildSearchPath({ base: s.base, filters });
    const homes = await fetchSearch(path);
    if (!homes) { log.warning(`${s.label}: could not read ${path}`); return; }
    const band = lo != null || hi != null ? ` ($${priceToken(lo ?? 0)}-${hi != null ? `$${priceToken(hi)}` : 'any'})` : '';
    if (homes.length >= PAGE_CAP && splitLargeSearches && rowsPushed + homes.length < cap) {
        const pts = innerPoints(lo, hi);
        if (pts.length) {
            const mid = pts[Math.floor(pts.length / 2)];
            stats.bandsSplit++;
            log.info(`${s.label}${band}: hit the ${PAGE_CAP}-home cap, splitting at $${priceToken(mid)}.`);
            await runSearch(s, lo, mid, depth + 1);
            await runSearch(s, mid, hi, depth + 1);
            return;
        }
        stats.cappedBands++;
        log.warning(`${s.label}${band}: still ${PAGE_CAP}+ homes in the narrowest price band; some homes in it are not returned.`);
    }
    await emit(homes, s.label);
    log.info(`${s.label}${band}: ${homes.length} homes, ${rowsPushed} rows so far.`);
}

for (const s of searches) {
    if (stop || rowsPushed >= cap || deadline.pastSoft()) break;
    const lo = s.filters.has('min-price') ? parsePriceToken(s.filters.get('min-price')) : null;
    const hi = s.filters.has('max-price') ? parsePriceToken(s.filters.get('max-price')) : null;
    await runSearch(s, lo, hi);
}

if (!rowsPushed) {
    const note = stats.unchangedSkipped
        ? `No new or changed homes since the last run; ${stats.unchangedSkipped} homes checked.`
        : stats.pagesFetched ? 'No homes matched these searches. Not charged.' : 'Redfin could not be read for these searches right now. Not charged; try again later.';
    await Actor.pushData({ note });
}
await saveAll();
log.info(`Done: ${JSON.stringify(stats)} ${JSON.stringify(guard.report())}`);
await Actor.exit();
