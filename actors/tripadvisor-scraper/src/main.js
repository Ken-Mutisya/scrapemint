// TripAdvisor Scraper Pro
//
// Scrape TripAdvisor hotels, restaurants, attractions, things to do, vacation
// rentals, and tours. Each row ships pricing, contact, amenities, awards,
// ratings breakdown, photos, coordinates, hours, and review summaries.
//
// Strategy
// --------
// 1. If searchQuery is set, hit TripAdvisor's typeahead to resolve city -> geoId.
//    Build list URLs for the requested place types (Hotels-, Restaurants-, etc.).
// 2. Listing handler walks the page, pulling property cards and queueing detail
//    requests. Pagination follows the next-page link until cap.
// 3. Detail handler reads __NEXT_DATA__ + __APOLLO_STATE__ for the property and
//    parses every enrichment field requested.
// 4. Direct URLs short-circuit: jump straight to the appropriate handler.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const HOST = 'https://www.tripadvisor.com';

const PLACE_TYPE_PATH = {
    hotels: 'Hotels',
    restaurants: 'Restaurants',
    things_to_do: 'Attractions',
    vacation_rentals: 'VacationRentals',
    tours: 'Attractions',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQuery = '',
    startUrls = [],
    maxResults = 25,
    placeTypes = ['hotels', 'restaurants', 'things_to_do'],
    includeReviewTags = true,
    includeNearbyResults = false,
    extractAmenities = true,
    extractAwards = true,
    extractRatingBreakdown = true,
    extractRecentReviewSnippets = true,
    extractContact = true,
    extractHoursAndPricing = true,
    extractPhotos = true,
    maxPhotosPerProperty = 12,
    checkInDate = '',
    checkOutDate = '',
    guests = 2,
    rooms = 1,
    minRating = 0,
    language = 'en',
    currency = 'USD',
    dedupe = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxResults) > 0 ? Number(maxResults) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('tripadvisor-seen') : null;
const seenLocationIds = new Set(seenStore ? (await seenStore.getValue('seen-location-ids')) || [] : []);
const perSourceCount = new Map();
let pushedRows = 0;

const initial = await buildInitialRequests();
if (initial.length === 0) {
    log.warning('No valid input. Provide a searchQuery or startUrls.');
    await Actor.exit();
}

// Wall-clock budget: exit cleanly with partial results before the platform hard-kills
// the run (TIMED-OUT = a failed run). Derive the deadline from the run's ACTUAL timeout
// (ACTOR_TIMEOUT_AT) instead of assuming 3600s -- runs with a shorter timeout (e.g. 720s)
// were failing because a fixed 3300s budget never fired.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 4)),
    headless: true,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 2,
    retryOnBlocked: false,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 60,
        sessionOptions: { maxUsageCount: 25 },
        blockedStatusCodes: [],
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                operatingSystems: ['macos', 'windows'],
                locales: [`${language}-US`, 'en-US'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': `${language}-US,${language};q=0.9,en;q=0.8`,
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
            });
        },
    ],
    async requestHandler(ctx) {
        if (Date.now() > SOFT_DEADLINE_AT) { log.warning('Run-time budget reached; stopping crawler.'); crawler.stop(); return; }
        const t = ctx.request.userData?.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'listing') return handleListing(ctx);
        if (t === 'tourism') return handleTourism(ctx);
        if (t === 'hotel') return handleHotel(ctx);
        if (t === 'restaurant') return handleRestaurant(ctx);
        if (t === 'attraction') return handleAttraction(ctx);
        if (t === 'vacation_rental') return handleVacationRental(ctx);
        if (t === 'attraction_product') return handleAttractionProduct(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initial);
await crawler.run();

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-location-ids', [...seenLocationIds]);

log.info(`Run complete. Properties pushed: ${pushedRows}.`);
await Actor.exit();

// ---------- Seed builders ----------

async function buildInitialRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    const urls = cleanArr(startUrls);
    for (const url of urls) {
        const parsed = parseTripAdvisorUrl(url);
        if (!parsed) continue;
        if (parsed.kind === 'hotel') out.push(makeDetailRequest('hotel', url, parsed.locationId));
        else if (parsed.kind === 'restaurant') out.push(makeDetailRequest('restaurant', url, parsed.locationId));
        else if (parsed.kind === 'attraction') out.push(makeDetailRequest('attraction', url, parsed.locationId));
        else if (parsed.kind === 'vacation_rental') out.push(makeDetailRequest('vacation_rental', url, parsed.locationId));
        else if (parsed.kind === 'attraction_product') out.push(makeDetailRequest('attraction_product', url, parsed.locationId));
        else if (parsed.kind === 'tourism') out.push({
            url,
            userData: { type: 'tourism', sourceKey: `tourism:${url}` },
            uniqueKey: `tourism:${url}`,
        });
        else if (parsed.kind === 'list') out.push({
            url,
            userData: { type: 'listing', listKind: parsed.listKind, sourceKey: `list:${url}`, page: 0 },
            uniqueKey: `list:${url}`,
        });
    }

    if (searchQuery && String(searchQuery).trim()) {
        const q = String(searchQuery).trim();
        out.push({
            url: `${HOST}/Search?q=${encodeURIComponent(q)}&searchSessionId=`,
            userData: { type: 'search', query: q, sourceKey: `search:${q}` },
            uniqueKey: `search:${q}`,
        });
    }

    return out;
}

function parseTripAdvisorUrl(url) {
    try {
        const u = new URL(url);
        if (!/tripadvisor\.[a-z.]+$/.test(u.hostname.replace(/^www\./, ''))) return null;
        const path = u.pathname;

        let m = path.match(/Hotel_Review-g(\d+)-d(\d+)/);
        if (m) return { kind: 'hotel', locationId: m[2], geoId: m[1] };

        m = path.match(/Restaurant_Review-g(\d+)-d(\d+)/);
        if (m) return { kind: 'restaurant', locationId: m[2], geoId: m[1] };

        m = path.match(/Attraction_Review-g(\d+)-d(\d+)/);
        if (m) return { kind: 'attraction', locationId: m[2], geoId: m[1] };

        m = path.match(/AttractionProductReview-g(\d+)-d(\d+)/);
        if (m) return { kind: 'attraction_product', locationId: m[2], geoId: m[1] };

        m = path.match(/VacationRentalReview-g(\d+)-d(\d+)/);
        if (m) return { kind: 'vacation_rental', locationId: m[2], geoId: m[1] };

        m = path.match(/Tourism-g(\d+)/);
        if (m) return { kind: 'tourism', geoId: m[1] };

        m = path.match(/(Hotels|Restaurants|Attractions|VacationRentals)-g(\d+)/);
        if (m) {
            const map = { Hotels: 'hotels', Restaurants: 'restaurants', Attractions: 'things_to_do', VacationRentals: 'vacation_rentals' };
            return { kind: 'list', listKind: map[m[1]], geoId: m[2] };
        }

        return null;
    } catch { return null; }
}

function makeDetailRequest(kind, url, locationId) {
    return {
        url,
        userData: { type: kind, locationId, sourceKey: `${kind}:${locationId}` },
        uniqueKey: `${kind}:${locationId}`,
    };
}

function makeListingRequest(listKind, geoId) {
    const segment = ({
        hotels: 'Hotels',
        restaurants: 'Restaurants',
        things_to_do: 'Attractions',
        vacation_rentals: 'VacationRentals',
        tours: 'Attractions-c-Tours',
    })[listKind] || 'Hotels';
    let url;
    if (listKind === 'tours') {
        url = `${HOST}/Attractions-g${geoId}-Activities-c42`;
    } else {
        url = `${HOST}/${segment}-g${geoId}`;
    }
    return {
        url,
        userData: { type: 'listing', listKind, geoId, sourceKey: `list:${listKind}:${geoId}`, page: 0 },
        uniqueKey: `list:${listKind}:${geoId}`,
    };
}

// ---------- Search handler ----------

async function handleSearch({ page, request, crawler: c }) {
    await page.waitForLoadState('domcontentloaded');
    await passCloudflareIfPresent(page);
    await dismissModals(page);

    const query = request.userData.query;

    // TripAdvisor's typeahead returns geo IDs as JSON in __NEXT_DATA__.
    // Use the public typeahead endpoint via page fetch as a fallback.
    let geoId = null;
    try {
        const geo = await page.evaluate(async (q) => {
            const r = await fetch(`/data/graphql/ids?q=${encodeURIComponent(q)}`).catch(() => null);
            if (r && r.ok) return r.text().catch(() => null);
            const r2 = await fetch(`/TypeAheadJson?action=API&query=${encodeURIComponent(q)}&types=geo`);
            if (r2 && r2.ok) return r2.text();
            return null;
        }, query);
        if (geo) {
            const m = geo.match(/"locationId":"?(\d+)"?/) || geo.match(/g(\d+)/);
            if (m) geoId = m[1];
        }
    } catch {}

    if (!geoId) {
        // Fallback: parse the search results page
        try { await page.waitForSelector('a[href*="Tourism-g"], a[href*="Hotels-g"]', { timeout: 12000 }); } catch {}
        geoId = await page.evaluate(() => {
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/(?:Tourism|Hotels|Restaurants|Attractions)-g(\d+)/);
                if (m) return m[1];
            }
            return null;
        }).catch(() => null);
    }

    if (!geoId) {
        log.warning(`Could not resolve geo ID for query "${query}". Try passing a Tourism URL directly.`);
        return;
    }

    log.info(`Search "${query}" resolved to geoId=${geoId}. Crawling place types: ${(placeTypes || []).join(', ')}`);

    const requests = [];
    for (const pt of (placeTypes || [])) {
        requests.push(makeListingRequest(pt, geoId));
    }
    if (requests.length > 0) await c.addRequests(requests);
}

// ---------- Tourism handler (for direct Tourism-g URLs) ----------

async function handleTourism({ page, request, crawler: c }) {
    await page.waitForLoadState('domcontentloaded');
    await passCloudflareIfPresent(page);
    await dismissModals(page);

    const m = request.url.match(/Tourism-g(\d+)/);
    if (!m) return;
    const geoId = m[1];

    const requests = [];
    for (const pt of (placeTypes || [])) {
        requests.push(makeListingRequest(pt, geoId));
    }
    if (requests.length > 0) await c.addRequests(requests);
}

// ---------- Listing handler ----------

async function handleListing({ page, request, crawler: c }) {
    const sourceKey = request.userData.sourceKey;
    const have = perSourceCount.get(sourceKey) || 0;
    if (have >= cap) return;

    await page.waitForLoadState('domcontentloaded');
    await passCloudflareIfPresent(page);
    await dismissModals(page);

    try { await page.waitForSelector('a[href*="Hotel_Review-"], a[href*="Restaurant_Review-"], a[href*="Attraction_Review-"], a[href*="VacationRentalReview-"]', { timeout: 18000 }); } catch {}

    const items = await page.evaluate((listKind) => {
        const out = new Map();
        const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
        const reviewPaths = {
            hotels: 'Hotel_Review-g(\\d+)-d(\\d+)',
            restaurants: 'Restaurant_Review-g(\\d+)-d(\\d+)',
            things_to_do: 'Attraction(?:Product)?Review-g(\\d+)-d(\\d+)',
            vacation_rentals: 'VacationRentalReview-g(\\d+)-d(\\d+)',
            tours: 'AttractionProductReview-g(\\d+)-d(\\d+)',
        };
        const re = new RegExp(reviewPaths[listKind] || reviewPaths.hotels);
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            const m = href.match(re);
            if (!m) continue;
            const locationId = m[2];
            if (out.has(locationId)) continue;
            const card = a.closest('[data-automation], li, article, div');
            const title = text(a) || text(card?.querySelector('h3, h2, [data-automation*="Title"]'));
            const ratingEl = card?.querySelector('[aria-label*="bubbles" i], [aria-label*="of 5" i]');
            const ratingLabel = ratingEl?.getAttribute('aria-label') || '';
            const reviewCountEl = card?.querySelector('[data-automation*="reviewCount"], a[href*="REVIEWS"]');
            const reviewCountText = text(reviewCountEl);
            const fullUrl = href.startsWith('http') ? href : new URL(href, location.origin).toString();
            out.set(locationId, {
                locationId,
                kind: listKind === 'hotels' ? 'hotel'
                    : listKind === 'restaurants' ? 'restaurant'
                    : listKind === 'things_to_do' ? 'attraction'
                    : listKind === 'vacation_rentals' ? 'vacation_rental'
                    : listKind === 'tours' ? 'attraction_product'
                    : 'attraction',
                title,
                url: fullUrl.split('#')[0],
                ratingLabel,
                reviewCountText,
            });
        }
        return [...out.values()];
    }, request.userData.listKind).catch(() => []);

    log.info(`Listing ${request.userData.listKind} (geo ${request.userData.geoId || '?'}): ${items.length} cards.`);

    const remaining = cap - have;
    const toQueue = [];
    for (const it of items) {
        if (toQueue.length >= remaining) break;
        if (dedupe && seenLocationIds.has(it.locationId)) continue;
        toQueue.push(makeDetailRequest(it.kind, it.url, it.locationId));
    }
    if (toQueue.length > 0) await c.addRequests(toQueue);
    perSourceCount.set(sourceKey, have + toQueue.length);

    // Pagination
    const nextHref = await page.evaluate(() => {
        const a = document.querySelector('a[aria-label*="Next" i], a[data-page-number]:has(+ a[aria-current])');
        return a?.href || null;
    }).catch(() => null);
    if (nextHref && (perSourceCount.get(sourceKey) || 0) < cap) {
        await c.addRequests([{
            url: nextHref,
            userData: { ...request.userData, page: (request.userData.page || 0) + 1 },
            uniqueKey: `list:next:${nextHref}`,
        }]);
    }
}

// ---------- Detail handlers ----------

async function handleHotel(ctx) { return handleDetail(ctx, 'hotel'); }
async function handleRestaurant(ctx) { return handleDetail(ctx, 'restaurant'); }
async function handleAttraction(ctx) { return handleDetail(ctx, 'attraction'); }
async function handleVacationRental(ctx) { return handleDetail(ctx, 'vacation_rental'); }
async function handleAttractionProduct(ctx) { return handleDetail(ctx, 'attraction_product'); }

async function handleDetail({ page, request }, kind) {
    const locationId = request.userData.locationId;
    if (dedupe && seenLocationIds.has(locationId)) return;
    if (pushedRows >= cap) return;

    await page.waitForLoadState('domcontentloaded');
    await passCloudflareIfPresent(page);
    await dismissModals(page);

    try { await page.waitForSelector('h1, [data-automation="mainH1"], script[type="application/ld+json"]', { timeout: 18000 }); } catch {}

    const ldData = await extractJsonLd(page, request.url);

    const data = await page.evaluate((opts) => {
        const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
        const all = (s) => [...document.querySelectorAll(s)];

        const getAppData = () => {
            try {
                const nd = document.querySelector('script#__NEXT_DATA__')?.textContent;
                if (nd) return JSON.parse(nd);
            } catch {}
            return null;
        };

        const findApolloEntity = (next, idHint) => {
            try {
                const apollo = next?.props?.pageProps?.urqlState
                    || next?.props?.pageProps?.apolloState
                    || next?.props?.pageProps?.dehydratedState
                    || null;
                if (!apollo || typeof apollo !== 'object') return null;
                const findInValues = (obj, depth) => {
                    if (depth > 6 || !obj || typeof obj !== 'object') return null;
                    if (obj.locationId && String(obj.locationId) === String(idHint)) return obj;
                    if (obj.id && String(obj.id) === String(idHint) && (obj.name || obj.placeType)) return obj;
                    for (const v of Object.values(obj)) {
                        const found = findInValues(v, depth + 1);
                        if (found) return found;
                    }
                    return null;
                };
                return findInValues(apollo, 7);
            } catch { return null; }
        };

        const next = getAppData();
        const apolloEntity = findApolloEntity(next, opts.locationId);

        const bodyText = (document.body?.innerText || '').slice(0, 80000);
        const title = text(document.querySelector('h1[data-automation="mainH1"], h1.QdLfr, h1.HjBfq, h1'));
        // Rank text fallback. TripAdvisor renders "#3 of 1,234 hotels in Paris".
        const rankFromBody = (() => {
            const m = bodyText.slice(0, 12000).match(/#?\s*([\d,]+)\s*(?:of|out of|sur)\s*([\d,]+)\s+([A-Za-z][^\n]{0,80})/i);
            if (!m) return null;
            const pos = parseInt(m[1].replace(/,/g, ''), 10);
            const tot = parseInt(m[2].replace(/,/g, ''), 10);
            if (pos > 0 && tot > 0 && pos <= tot) return { position: pos, total: tot, text: m[0].trim() };
            return null;
        })();
        // Badge detection from body text
        const tcMatch = bodyText.match(/Travele?lers'?\s+Choice[^\n]{0,40}(\d{4})?/i);
        const certMatch = /Certificate\s+of\s+Excellence/i.test(bodyText);
        const claimedMatch = /(Claimed|This (?:hotel|business|restaurant|attraction) is claimed)/i.test(bodyText);
        const badgesFromBody = {
            travelersChoice: !!tcMatch,
            travelersChoiceYear: tcMatch?.[1] ? parseInt(tcMatch[1], 10) : null,
            certificateOfExcellence: certMatch,
            ownerClaimed: claimedMatch,
        };
        // Hotel class
        const classEl = document.querySelector('svg[aria-label*="of 5 bubbles"][aria-label*="Hotel class"], [class*="hotelClass"]');
        let hotelClass = null;
        if (classEl) {
            const lbl = classEl.getAttribute('aria-label') || classEl.textContent || '';
            const mm = lbl.match(/([\d.]+)\s*(?:of|out of)\s*5/i);
            if (mm) hotelClass = parseFloat(mm[1]);
        }
        const ratingFromAria = (() => {
            const el = document.querySelector('[data-automation="reviewBubble"], [class*="ui_bubble_rating"]');
            const aria = el?.getAttribute('aria-label') || '';
            const m = aria.match(/([\d.]+)\s*of\s*5|([\d.]+)\s*out of/i);
            if (m) return parseFloat(m[1] || m[2]);
            const cls = el?.getAttribute('class') || '';
            const m2 = cls.match(/bubble_(\d+)/);
            if (m2) return parseInt(m2[1], 10) / 10;
            return null;
        })();

        const reviewCountText = text(document.querySelector('a[href*="REVIEWS"], [data-automation="reviewCount"], span.AbCk'));
        const reviewCount = (() => {
            const m = (reviewCountText || '').replace(/[, ]/g, '').match(/(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        })();

        const rankingText = text(document.querySelector('[data-automation="rankingDetails"], span.cNFlb, [class*="ranking"]'));
        const rankingMatch = rankingText.match(/#?(\d+)\s*(?:of|sur|von)\s*([\d,]+)/i);

        const priceTier = (() => {
            // Match $, $$, $$$, $$$$ pattern only.
            const sel = document.querySelector('[data-automation="restaurantsAboutMenu_priceRange"]');
            const t = (sel?.textContent || '').trim();
            if (/^\${1,4}(\s*-\s*\${1,4})?$/.test(t)) return t;
            const m = bodyText.match(/(?:Price\s*range)[:\s]*(\${1,4}(?:\s*-\s*\${1,4})?|US\$[\d,]+\s*-\s*US\$[\d,]+)/i);
            return m ? m[1].trim() : null;
        })();
        const phone = (() => {
            const a = document.querySelector('a[href^="tel:"]');
            return a?.getAttribute('href')?.replace(/^tel:/, '') || null;
        })();
        const website = (() => {
            const a = document.querySelector('a[href^="http"][data-encoded-url], a[data-automation="restaurantsAboutMenu_website"], a[data-automation="websiteLink"]');
            const enc = a?.getAttribute('data-encoded-url');
            if (enc) {
                try {
                    let raw = atob(enc.split('').reverse().join(''));
                    if (/^https?:/.test(raw)) return raw;
                } catch {}
            }
            return a?.getAttribute('href') || null;
        })();

        const addressText = text(document.querySelector('button[data-automation="aboutAddress"], a[href*="maps.google.com"], span.fHvkI'));

        const amenities = opts.wantAmenities
            ? all('[data-automation="amenities_list"] li, [data-automation*="amenity"] li, [class*="amenity_list"] li').map((el) => text(el)).filter((s) => s && s.length < 80).slice(0, 80)
            : null;

        const awardsList = opts.wantAwards
            ? all('[data-automation*="award"], [class*="awardLink"], [class*="travelersChoice"]').map((el) => text(el)).filter((s) => s.length > 3 && s.length < 120).slice(0, 8)
            : null;

        const ratingBreakdown = opts.wantBreakdown ? (() => {
            const out = {};
            all('[data-automation*="ratingBreakdown"] [role="img"], [data-automation*="reviewSubratings"] [aria-label*="bubbles"]').forEach((el) => {
                const aria = el.getAttribute('aria-label') || '';
                const m = aria.match(/^([^,]+?)\s+([\d.]+)/);
                if (m) out[m[1].trim().toLowerCase()] = parseFloat(m[2]);
            });
            return Object.keys(out).length > 0 ? out : null;
        })() : null;

        const recentReviewSnippets = opts.wantReviewSnippets
            ? all('[data-automation="reviewCard"] [data-automation="reviewText"], [data-test-target="review-title"]').slice(0, 5).map((el) => text(el)).filter(Boolean)
            : null;

        const photos = opts.wantPhotos
            ? all('img[data-test-target="photo-card"] img, [data-automation*="photoGrid"] img, [class*="HeroBlock"] img, [data-automation="photo"] img').map((img) => {
                const src = img.getAttribute('data-lazyurl') || img.getAttribute('src') || '';
                if (!/^https?:\/\//.test(src)) return null;
                return src.replace(/(\/photo-[a-z]\/)\d+x\d+\//, '$1original/').replace(/\?.*$/, '');
            }).filter(Boolean).slice(0, opts.maxPhotos || 12)
            : null;

        const reviewTagsList = opts.wantReviewTags
            ? all('[data-automation*="reviewTag"] button, [class*="kerning"] button[aria-pressed]').map((el) => text(el).replace(/\(\d+\)/, '').trim()).filter((s) => s && s.length < 60).slice(0, 30)
            : null;

        const coords = (() => {
            try {
                const next = getAppData();
                const blob = JSON.stringify(next || {});
                const lat = blob.match(/"latitude":\s*([-\d.]+)/);
                const lng = blob.match(/"longitude":\s*([-\d.]+)/);
                if (lat && lng) return { lat: parseFloat(lat[1]), lng: parseFloat(lng[1]) };
            } catch {}
            return null;
        })();

        const tags = all('[data-automation="tagBar"] li, [class*="tagsContainer"] a').map((el) => text(el)).filter(Boolean).slice(0, 20);

        const cuisineTypes = all('[data-automation="restaurantsAboutMenu_cuisines"] a, [data-automation*="cuisine"] a').map((el) => text(el)).filter(Boolean);
        const mealTypes = all('[data-automation="restaurantsAboutMenu_meals"] a').map((el) => text(el)).filter(Boolean);

        const hours = (() => {
            const rows = all('[data-automation*="hours"] tr, [data-automation*="openingHours"] li');
            if (rows.length === 0) return null;
            return rows.map((r) => text(r)).filter(Boolean).slice(0, 14);
        })();

        const lowestRateText = text(document.querySelector('[data-automation="hr_priceLink"], [data-automation*="priceFromText"], [class*="priceBox"]'));
        const tourPriceText = text(document.querySelector('[data-automation*="productPrice"], [data-automation*="price-from"]'));
        const durationText = text(document.querySelector('[data-automation="durationText"], [data-automation*="duration"]'));

        const nearbyHotels = opts.wantNearby
            ? all('[data-automation*="nearby"] a[href*="Hotel_Review"], [data-automation*="nearby"] a[href*="Restaurant_Review"], [data-automation*="nearby"] a[href*="Attraction_Review"]').map((a) => {
                const href = a.getAttribute('href') || '';
                const m = href.match(/-d(\d+)/);
                return m ? { locationId: m[1], title: text(a), url: href.startsWith('http') ? href : new URL(href, location.origin).toString() } : null;
            }).filter(Boolean).slice(0, 20)
            : null;

        return {
            title,
            ratingStars: ratingFromAria,
            reviewCount,
            reviewCountText,
            rankingText,
            rankingPosition: rankingMatch ? parseInt(rankingMatch[1], 10) : (rankFromBody?.position ?? null),
            rankingTotal: rankingMatch ? parseInt(rankingMatch[2].replace(/,/g, ''), 10) : (rankFromBody?.total ?? null),
            rankingTextFallback: rankFromBody?.text || null,
            badgesFromBody,
            hotelClass,
            priceTier,
            phone,
            website,
            addressText,
            amenities,
            awards: awardsList,
            ratingBreakdown,
            recentReviewSnippets,
            photos,
            reviewTags: reviewTagsList,
            coords,
            tags,
            cuisineTypes: cuisineTypes.length > 0 ? cuisineTypes : null,
            mealTypes: mealTypes.length > 0 ? mealTypes : null,
            hours,
            lowestRateText,
            tourPriceText,
            durationText,
            nearby: nearbyHotels,
            apolloEntity,
        };
    }, {
        locationId,
        wantAmenities: extractAmenities,
        wantAwards: extractAwards,
        wantBreakdown: extractRatingBreakdown,
        wantReviewSnippets: extractRecentReviewSnippets,
        wantPhotos: extractPhotos,
        wantReviewTags: includeReviewTags,
        wantNearby: includeNearbyResults,
        maxPhotos: maxPhotosPerProperty,
    });

    const name = data.title || ldData?.name;
    if (!name) {
        log.warning(`No title parsed for ${kind} ${locationId}, skipping.`);
        return;
    }

    const ratingStars = data.ratingStars ?? ldData?.aggregateRating ?? null;
    if (Number(minRating) > 0 && ratingStars != null && ratingStars < Number(minRating)) {
        log.info(`Skipping ${name} (rating ${ratingStars} < ${minRating}).`);
        return;
    }

    const row = assembleRow(kind, locationId, request.url, data, ldData);
    await Actor.pushData(row);
    seenLocationIds.add(locationId);
    pushedRows += 1;
    if (pushedRows > 10) Actor.charge({ eventName: 'property_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    log.info(`Pushed ${kind} ${locationId} ${(row.name || '').slice(0, 55)} | ${row.rating?.stars ?? '?'}★ (${pushedRows})`);
}

// ---------- Row assembly ----------

function assembleRow(kind, locationId, url, d, ld) {
    const address = parseAddress(d.addressText) || (ld ? {
        full: [ld.streetAddress, ld.addressLocality, ld.addressRegion, ld.postalCode, ld.addressCountry].filter(Boolean).join(', '),
        street: ld.streetAddress,
        city: ld.addressLocality,
        region: ld.addressRegion,
        country: ld.addressCountry,
    } : null);
    const coords = d.coords || (ld?.latitude && ld?.longitude ? { lat: ld.latitude, lng: ld.longitude } : null);
    const lowestRate = parseLowestRate(d.lowestRateText, currency);
    const tourPrice = parseLowestRate(d.tourPriceText, currency);
    const awards = extractAwards ? mergeAwards(d.awards, d.badgesFromBody) : undefined;

    return {
        locationId,
        kind,
        url,
        name: d.title || ld?.name || null,
        category: deriveCategory(kind, d.tags || [], ld),
        rating: {
            stars: d.ratingStars ?? ld?.aggregateRating ?? null,
            reviewCount: d.reviewCount ?? ld?.reviewCount ?? null,
            reviewCountText: d.reviewCountText || null,
            ranking: d.rankingPosition && d.rankingTotal ? {
                position: d.rankingPosition,
                total: d.rankingTotal,
                text: d.rankingText || d.rankingTextFallback || null,
                percentile: d.rankingPosition && d.rankingTotal ? Math.round(((d.rankingTotal - d.rankingPosition + 1) / d.rankingTotal) * 10000) / 100 : null,
            } : null,
            breakdown: extractRatingBreakdown ? d.ratingBreakdown : undefined,
        },
        priceTier: d.priceTier || ld?.priceRange || null,
        hotelClass: kind === 'hotel' ? d.hotelClass : undefined,
        contact: extractContact ? {
            phone: d.phone,
            website: d.website,
            address: d.addressText || (ld ? [ld.streetAddress, ld.addressLocality].filter(Boolean).join(', ') : null),
            addressStructured: address,
            coordinates: coords,
        } : undefined,
        amenities: extractAmenities ? d.amenities : undefined,
        awards,
        reviewTags: includeReviewTags ? d.reviewTags : undefined,
        recentReviewSnippets: extractRecentReviewSnippets ? d.recentReviewSnippets : undefined,
        cuisineTypes: d.cuisineTypes,
        mealTypes: d.mealTypes,
        hours: extractHoursAndPricing ? d.hours : undefined,
        pricing: extractHoursAndPricing ? {
            lowestRate,
            tourPrice,
            durationText: d.durationText || null,
            checkInDate: checkInDate || null,
            checkOutDate: checkOutDate || null,
            guests,
            rooms,
            currency,
        } : undefined,
        photos: extractPhotos ? d.photos : undefined,
        tags: d.tags && d.tags.length > 0 ? d.tags : null,
        nearby: includeNearbyResults ? d.nearby : undefined,
        scrapedAt: new Date().toISOString(),
    };
}

function mergeAwards(domAwards, badgesFromBody) {
    const out = Array.isArray(domAwards) ? [...domAwards] : [];
    if (badgesFromBody?.travelersChoice) {
        out.push(`Travelers' Choice${badgesFromBody.travelersChoiceYear ? ` ${badgesFromBody.travelersChoiceYear}` : ''}`);
    }
    if (badgesFromBody?.certificateOfExcellence) out.push('Certificate of Excellence');
    return [...new Set(out)];
}

// ---------- Parsers ----------

function parseAddress(text) {
    if (!text) return null;
    const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return { full: text };
    const last = parts[parts.length - 1];
    const country = /^[A-Za-z .]+$/.test(last) && last.length < 30 ? last : null;
    const region = parts.length >= 3 ? parts[parts.length - 2] : null;
    const city = parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
    const street = parts.slice(0, -2).join(', ') || null;
    return {
        full: text,
        street,
        city,
        region,
        country,
    };
}

function parseLowestRate(text, ccy) {
    if (!text) return null;
    const m = String(text).match(/([\d,]+(?:\.\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    return { amount: n, currency: ccy, rawText: text };
}

function deriveCategory(kind, tags, ld) {
    if (ld?.type) return ld.type;
    if (kind === 'hotel') return 'Hotel';
    if (kind === 'restaurant') return 'Restaurant';
    if (kind === 'attraction' || kind === 'attraction_product') return 'Attraction';
    if (kind === 'vacation_rental') return 'Vacation rental';
    if (tags?.length > 0) return tags[0];
    return null;
}

// ---------- JSON-LD ----------

async function extractJsonLd(page, sourceUrl) {
    const urlSlug = (() => {
        try {
            const m = new URL(sourceUrl).pathname.match(/Reviews-(?:or\d+-)?([^/.]+)/);
            return m ? m[1].replace(/_/g, ' ').toLowerCase() : '';
        } catch { return ''; }
    })();
    const score = (name) => {
        if (!name || !urlSlug) return 0;
        const n = String(name).toLowerCase();
        let hits = 0;
        for (const tok of urlSlug.split(' ').filter((t) => t.length > 2)) {
            if (n.includes(tok)) hits += 1;
        }
        return hits;
    };
    try {
        const blocks = await page.$$eval(
            'script[type="application/ld+json"]',
            (nodes) => nodes.map((n) => n.textContent ?? '').filter(Boolean),
        );
        const candidates = [];
        for (const raw of blocks) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch { continue; }
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const t = item?.['@type'];
                if (!t) continue;
                const types = Array.isArray(t) ? t : [t];
                if (!types.some((x) => /(LodgingBusiness|Hotel|Restaurant|TouristAttraction|LocalBusiness|Apartment|VacationRental)/i.test(x))) continue;
                const country = item.address?.addressCountry;
                candidates.push({
                    name: item.name ?? null,
                    type: types[0],
                    aggregateRating: numberOrNull(item.aggregateRating?.ratingValue),
                    reviewCount: numberOrNull(item.aggregateRating?.reviewCount),
                    priceRange: item.priceRange ?? null,
                    streetAddress: item.address?.streetAddress ?? null,
                    addressLocality: item.address?.addressLocality ?? null,
                    addressRegion: item.address?.addressRegion ?? null,
                    postalCode: item.address?.postalCode ?? null,
                    addressCountry: typeof country === 'string' ? country : country?.name ?? null,
                    latitude: numberOrNull(item.geo?.latitude),
                    longitude: numberOrNull(item.geo?.longitude),
                    image: typeof item.image === 'string' ? item.image : Array.isArray(item.image) ? item.image[0] : null,
                    _score: score(item.name),
                    _reviewCount: numberOrNull(item.aggregateRating?.reviewCount) || 0,
                });
            }
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => (b._score - a._score) || (b._reviewCount - a._reviewCount));
        const best = candidates[0];
        delete best._score; delete best._reviewCount;
        return best;
    } catch (err) {
        log.debug(`JSON-LD extraction failed: ${err?.message}`);
    }
    return null;
}

function numberOrNull(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ---------- Browser helpers ----------

async function dismissModals(page) {
    try {
        await page.evaluate(() => {
            ['button[aria-label*="Close" i]', 'button[aria-label*="dismiss" i]', '[data-test-target*="cookie"] button[aria-label*="Accept" i]'].forEach((sel) => {
                document.querySelector(sel)?.click?.();
            });
        });
    } catch {}
}

async function passCloudflareIfPresent(page) {
    try {
        const isChallenge = await page.evaluate(() => {
            const t = (document.title || '').toLowerCase();
            return t.includes('just a moment') || t.includes('attention required') || !!document.querySelector('#challenge-running, #cf-please-wait');
        });
        if (!isChallenge) return;
        for (let i = 0; i < 5; i += 1) {
            await page.waitForTimeout(2500);
            const stillChallenge = await page.evaluate(() => {
                const t = (document.title || '').toLowerCase();
                return t.includes('just a moment') || t.includes('attention required');
            }).catch(() => false);
            if (!stillChallenge) return;
        }
    } catch {}
}
