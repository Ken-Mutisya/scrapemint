// Zillow Home Price Scraper
// Scrapes Zillow search result pages via PlaywrightCrawler with fingerprint
// injection + residential proxy. Parses embedded mapResults JSON for each
// listing.
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 10;

await Actor.init();
const __chargeJobs = [];

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let pageFetches = 0;

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    locations = [],
    listingType = 'for_sale',
    minPrice = 0,
    maxPrice = 0,
    minBeds = 0,
    maxBeds = 0,
    minSqft = 0,
    propertyTypes = [],
    maxPages = 3,
    maxItemsPerSource = 100,
    maxItemsTotal = 300,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const urlList = toArray(searchUrls).map((u) => String(u).trim()).filter(Boolean);
const locList = toArray(locations).map((l) => String(l).trim()).filter(Boolean);
const typeSet = new Set(toArray(propertyTypes).map((t) => String(t).toLowerCase()));

const store = await Actor.openKeyValueStore();
const seenState = (dedupe && (await store.getValue('SEEN_ZPIDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

try {
    const searchRoots = [];
    for (const u of urlList) searchRoots.push({ url: ensureTrailingSlash(u), label: u });
    for (const loc of locList) searchRoots.push({ url: buildSearchUrl(loc, listingType), label: loc });

    if (searchRoots.length === 0) {
        log.error('Provide at least one searchUrls entry or a location.');
    } else {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

        const requests = [];
        for (const root of searchRoots) {
            for (let page = 1; page <= maxPages; page++) {
                requests.push({
                    url: appendPage(root.url, page),
                    userData: { rootLabel: root.label, page, rootUrl: root.url },
                    uniqueKey: `${root.url}#p${page}`,
                });
            }
        }

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxConcurrency: 1,
            maxRequestRetries: 5,
            retryOnBlocked: true,
            useSessionPool: true,
            sessionPoolOptions: { maxPoolSize: 20 },
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 120,
            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 120 }],
                        devices: ['desktop'],
                        operatingSystems: ['macos', 'windows'],
                        locales: ['en-US', 'en'],
                    },
                },
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
                },
            ],
            requestHandler: async ({ page, request }) => {
                pageFetches += 1;
                await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});

                const title = await page.title();
                if (/access to this page has been denied|press and hold|just a moment/i.test(title)) {
                    log.warning(`Blocked page: "${title}" on ${request.url}, throwing to retry`);
                    throw new Error('Blocked - bot challenge');
                }

                await page.waitForSelector('[data-test="property-card"], script#__NEXT_DATA__, [id^="zpid_"]', { timeout: 20_000 }).catch(() => {});
                await page.waitForTimeout(2500);

                const html = await page.content();
                const listings = extractListings(html);
                log.info(`${request.userData.rootLabel} p${request.userData.page} -> ${listings.length} listings`);

                if (totalPushed >= maxItemsTotal) return;

                let pushedThis = 0;
                for (const l of listings) {
                    if (pushedThis >= maxItemsPerSource) break;
                    if (totalPushed >= maxItemsTotal) break;
                    const row = shapeRow(l, request.userData.rootLabel, request.url);
                    if (await pushRow(row)) pushedThis += 1;
                }
            },
            failedRequestHandler: async ({ request, error }) => {
                log.warning(`failed ${request.url}: ${error?.message}`);
            },
        });

        await crawler.run(requests);
    }

    if (dedupe) {
        const trimmed = [...newSeen].slice(-50_000);
        await store.setValue('SEEN_ZPIDS', trimmed);
    }
} catch (err) {
    log.exception(err, 'Unhandled error during run');
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} pageFetches=${pageFetches}`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

function ensureTrailingSlash(u) {
    return u.endsWith('/') ? u : `${u}/`;
}

function buildSearchUrl(loc, type) {
    const slug = loc.trim().replace(/,\s*/g, '-').replace(/\s+/g, '-');
    const suffix = type === 'for_rent' ? '_rb/rentals/' : type === 'sold' ? '_rb/sold/' : '_rb/';
    return `https://www.zillow.com/homes/${encodeURIComponent(slug)}${suffix}`;
}

function appendPage(url, page) {
    if (page === 1) return url;
    return url.endsWith('/') ? `${url}${page}_p/` : `${url}/${page}_p/`;
}

function extractListings(html) {
    const out = new Map();

    // Primary: __NEXT_DATA__ often includes the search results
    const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (next) {
        try {
            const json = JSON.parse(next[1]);
            walkForListings(json, out);
        } catch {}
    }

    // Secondary: embedded JSON inside the HTML for search page state
    const preload = html.match(/<script[^>]*>window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (preload) {
        try {
            const json = JSON.parse(preload[1]);
            walkForListings(json, out);
        } catch {}
    }

    // Tertiary: embedded "listResults" or "mapResults" JSON blobs escaped inside scripts
    const blobMatches = html.match(/"listResults":\s*(\[[\s\S]*?\])\s*,\s*"mapResults"/);
    if (blobMatches) {
        try {
            const arr = JSON.parse(blobMatches[1]);
            for (const item of arr) addListing(item, out);
        } catch {}
    }

    const mapMatches = html.match(/"mapResults":\s*(\[[\s\S]*?\])\s*,\s*"resultsHash"/);
    if (mapMatches) {
        try {
            const arr = JSON.parse(mapMatches[1]);
            for (const item of arr) addListing(item, out);
        } catch {}
    }

    return [...out.values()];
}

function walkForListings(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 14) return;
    if (Array.isArray(obj)) {
        for (const v of obj) walkForListings(v, out, depth + 1);
        return;
    }
    if (Array.isArray(obj.listResults)) for (const l of obj.listResults) addListing(l, out);
    if (Array.isArray(obj.mapResults)) for (const l of obj.mapResults) addListing(l, out);
    if (Array.isArray(obj.searchResults)) for (const l of obj.searchResults) addListing(l, out);
    if (obj.zpid && (obj.address || obj.addressStreet || obj.hdpUrl || obj.detailUrl)) {
        addListing(obj, out);
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') walkForListings(v, out, depth + 1);
    }
}

function addListing(l, out) {
    if (!l || typeof l !== 'object') return;
    const zpid = l.zpid || l.id;
    if (!zpid) return;
    if (!out.has(String(zpid))) out.set(String(zpid), l);
}

function shapeRow(l, rootLabel, sourceUrl) {
    totalSeen += 1;
    const zpid = String(l.zpid || l.id || '');

    const price = toNumber(l.price ?? l.unformattedPrice ?? l.hdpData?.homeInfo?.price);
    const beds = toNumber(l.beds ?? l.bedrooms ?? l.hdpData?.homeInfo?.bedrooms);
    const baths = toNumber(l.baths ?? l.bathrooms ?? l.hdpData?.homeInfo?.bathrooms);
    const sqft = toNumber(l.area ?? l.livingArea ?? l.hdpData?.homeInfo?.livingArea);
    const lotSize = toNumber(l.lotAreaValue ?? l.hdpData?.homeInfo?.lotAreaValue);
    const yearBuilt = toNumber(l.yearBuilt ?? l.hdpData?.homeInfo?.yearBuilt);
    const zestimate = toNumber(l.zestimate ?? l.hdpData?.homeInfo?.zestimate);
    const rentZestimate = toNumber(l.rentZestimate ?? l.hdpData?.homeInfo?.rentZestimate);
    const daysOnMarket = toNumber(l.daysOnZillow ?? l.hdpData?.homeInfo?.daysOnZillow);
    const statusType = (l.statusType || l.homeStatus || l.hdpData?.homeInfo?.statusType || '').toString().toLowerCase();
    const propertyType = (l.hdpData?.homeInfo?.homeType || l.homeType || l.propertyType || '').toString().toLowerCase();

    const address = l.address || l.addressStreet || l.hdpData?.homeInfo?.streetAddress || '';
    const city = l.addressCity || l.hdpData?.homeInfo?.city || '';
    const state = l.addressState || l.hdpData?.homeInfo?.state || '';
    const zip = l.addressZipcode || l.hdpData?.homeInfo?.zipcode || '';
    const lat = toNumber(l.latLong?.latitude ?? l.latitude ?? l.hdpData?.homeInfo?.latitude);
    const lng = toNumber(l.latLong?.longitude ?? l.longitude ?? l.hdpData?.homeInfo?.longitude);

    const detailPath = l.hdpUrl || l.detailUrl;
    const url = detailPath
        ? (detailPath.startsWith('http') ? detailPath : `https://www.zillow.com${detailPath}`)
        : `https://www.zillow.com/homedetails/${zpid}_zpid/`;

    const flags = [];
    if (statusType.includes('new') || daysOnMarket != null && daysOnMarket <= 3) flags.push('new_listing');
    if (statusType.includes('open_house') || l.openHouse) flags.push('open_house');
    if (l.isHotHome || l.priceChange < 0) flags.push('price_cut');
    if (statusType.includes('pending') || statusType.includes('contingent')) flags.push('pending');
    if (statusType.includes('sold')) flags.push('sold');
    if (statusType.includes('foreclosure')) flags.push('foreclosure');
    if (price != null && zestimate != null && price < zestimate * 0.92) flags.push('below_zestimate');
    if (price != null && zestimate != null && price > zestimate * 1.08) flags.push('above_zestimate');
    if (propertyType === 'condo') flags.push('condo');
    if (propertyType === 'townhouse') flags.push('townhouse');
    if (daysOnMarket != null && daysOnMarket > 60) flags.push('stale_listing');

    return {
        source: 'zillow',
        rootLabel,
        zpid,
        address,
        city,
        state,
        zip,
        latitude: lat,
        longitude: lng,
        propertyType,
        listingType: mapListingType(statusType, listingType),
        statusType,
        price,
        beds,
        baths,
        sqft,
        lotSize,
        yearBuilt,
        zestimate,
        rentZestimate,
        daysOnMarket,
        priceCutTotal: toNumber(l.priceChange),
        url,
        flags,
        sourceUrl,
        dedupeKey: zpid,
        scrapedAt: new Date().toISOString(),
    };
}

function mapListingType(statusType, fallback) {
    const s = statusType || '';
    if (s.includes('rent')) return 'for_rent';
    if (s.includes('sold')) return 'sold';
    if (s.includes('for_sale') || s.includes('sale')) return 'for_sale';
    return fallback;
}

async function pushRow(row) {
    if (!row.zpid) { filteredOut += 1; return false; }
    // Never push (and therefore never charge for) a row that has no real data.
    // Zillow's anti-bot can return cards that carry a zpid but strip the actual
    // listing fields; charging for those is what produced "empty results, charged"
    // complaints. Require at least one substantive field beyond the id.
    const hasValue = row.price != null || row.zestimate != null || row.rentZestimate != null
        || row.beds != null || row.baths != null || row.sqft != null || Boolean(row.address);
    if (!hasValue) { filteredOut += 1; return false; }
    if (minPrice > 0 && row.price != null && row.price < minPrice) { filteredOut += 1; return false; }
    if (maxPrice > 0 && row.price != null && row.price > maxPrice) { filteredOut += 1; return false; }
    if (minBeds > 0 && row.beds != null && row.beds < minBeds) { filteredOut += 1; return false; }
    if (maxBeds > 0 && row.beds != null && row.beds > maxBeds) { filteredOut += 1; return false; }
    if (minSqft > 0 && row.sqft != null && row.sqft < minSqft) { filteredOut += 1; return false; }
    if (typeSet.size > 0 && row.propertyType && !typeSet.has(row.propertyType)) { filteredOut += 1; return false; }

    if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; return false; }

    await Actor.pushData(row);
    totalPushed += 1;
    newSeen.add(row.dedupeKey);
    maybeCharge();
    return true;
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
        const cleaned = v.replace(/[^0-9.\-]/g, '');
        if (!cleaned) return null;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    // Must match the event defined in pricing.json / the deployed pricing
    // ('property_row'). The old 'item_extracted' name was undefined, so charges
    // were silently dropped on a fresh push and the repo drifted from production.
    if (totalPushed > FREE_TIER_ITEMS) {
        __chargeJobs.push(Actor.charge({ eventName: 'property_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }));
    }
}
