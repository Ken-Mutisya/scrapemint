// TripAdvisor Property Rank & Competitor Benchmark Tracker
//
// One row per property per run. Tracks rank in destination category, rating
// drift, review volume, owner response rate, Travelers' Choice and Certificate
// of Excellence status, claim status, price tier, and amenities for any
// TripAdvisor hotel, restaurant, or attraction.
//
// Strategy
// --------
// 1. Load the property page with Playwright. TripAdvisor sits behind
//    Cloudflare so a real browser with residential proxy is required.
// 2. Parse JSON-LD ld+json blocks for name, type, aggregate rating,
//    review count, price range, and address.
// 3. Scrape the rendered DOM for rank text ("#3 of 1,234 hotels in Paris"),
//    rating histogram, badges, claim status, amenities, and hotel class.
// 4. Sample N recent reviews to compute owner response rate as
//    respondedTo / sampleSize.
// 5. Optionally sweep top N properties from a destination listing URL.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    targetUrls = [],
    destinationUrls = [],
    maxPerDestination = 25,
    responseRateSampleSize = 30,
    extractAmenities = true,
    extractRatingHistogram = true,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const props = [];
for (const raw of targetUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = String(v).trim();
    if (cleaned && isPropertyUrl(cleaned)) props.push(cleaned);
}

const dests = [];
for (const raw of destinationUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = String(v).trim();
    if (cleaned && isDestinationUrl(cleaned)) dests.push(cleaned);
}

if (props.length === 0 && dests.length === 0) {
    log.warning('No valid TripAdvisor URLs provided. Provide property URLs (Hotel_Review, Restaurant_Review, Attraction_Review) or destination listing URLs (Hotels-, Restaurants-, Attractions-).');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenProperties = new Set();
let pushed = 0;

const initialRequests = [];
for (const url of props) {
    initialRequests.push({
        url,
        userData: { type: 'property' },
        uniqueKey: `property:${propertyIdFromUrl(url) || url}`,
    });
}
for (const url of dests) {
    initialRequests.push({
        url,
        userData: { type: 'destination', sweepCount: 0 },
        uniqueKey: `dest:${url}`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(12, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 4,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 30,
        sessionOptions: { maxUsageCount: 25 },
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
                locales: ['en-US'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 90000;
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'destination') return handleDestination(ctx);
        if (t === 'property') return handleProperty(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Properties pushed: ${pushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleDestination({ page, request, crawler: c }) {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    await scrollPage(page);

    const propertyUrls = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.href || '';
            if (/\/(Hotel_Review|Restaurant_Review|Attraction_Review)-/i.test(href)) out.add(href.split('#')[0]);
        });
        return [...out];
    });

    log.info(`Destination ${request.url}: found ${propertyUrls.length} property links.`);

    const cap = Math.max(1, Math.min(200, Number(maxPerDestination) || 25));
    const queued = [];
    for (const u of propertyUrls) {
        if (queued.length >= cap) break;
        const id = propertyIdFromUrl(u);
        if (!id || seenProperties.has(id)) continue;
        seenProperties.add(id);
        queued.push({
            url: u,
            userData: { type: 'property' },
            uniqueKey: `property:${id}`,
        });
    }
    if (queued.length > 0) await c.addRequests(queued);
}

async function handleProperty({ page, request }) {
    const url = request.url;
    const propertyId = propertyIdFromUrl(url);
    const propertyType = propertyTypeFromUrl(url);

    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await scrollPage(page);

    const jsonLd = await extractJsonLd(page, url);
    const dom = await extractFromDom(page, propertyType);

    let responseRate = null;
    if (Number(responseRateSampleSize) > 0) {
        responseRate = await sampleResponseRate(page, Number(responseRateSampleSize));
    }

    const rating = mergeRating(jsonLd, dom, extractRatingHistogram);
    const destination = parseDestination(dom.rankText, propertyType, url);

    const row = {
        id: propertyId,
        url,
        type: propertyType,
        name: jsonLd?.name || dom.name || null,
        address: {
            street: jsonLd?.streetAddress || null,
            locality: jsonLd?.addressLocality || dom.locality || null,
            region: jsonLd?.addressRegion || null,
            postalCode: jsonLd?.postalCode || null,
            country: jsonLd?.addressCountry || null,
            latitude: jsonLd?.latitude ?? null,
            longitude: jsonLd?.longitude ?? null,
        },
        destination,
        rank: dom.rank,
        rating,
        badges: dom.badges,
        ownerEngagement: responseRate,
        priceTier: jsonLd?.priceRange || dom.priceTier || null,
        hotelClass: dom.hotelClass,
        amenities: extractAmenities ? dom.amenities : null,
        cuisines: dom.cuisines,
        tripTypes: dom.tripTypes,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    pushed += 1;
    if (pushed > 5) Actor.charge({ eventName: 'rank_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    log.info(`Pushed ${propertyId} ${row.name || '(no name)'} rank=${row.rank?.position ?? '?'}/${row.rank?.totalInCategory ?? '?'} rating=${rating.overall ?? '?'} reviews=${rating.reviewCount ?? '?'} (${pushed})`);
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
                if (!types.some((x) => /(LodgingBusiness|Hotel|Restaurant|TouristAttraction|LocalBusiness)/i.test(x))) continue;
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

// ---------- DOM extraction ----------

async function extractFromDom(page, propertyType) {
    return page.evaluate((kind) => {
        const text = (sel) => {
            const el = document.querySelector(sel);
            return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
        };
        const all = (sel) => [...document.querySelectorAll(sel)];

        const bodyText = (document.body?.innerText || '').slice(0, 80000);

        // Property name from header.
        const name = text('h1, [data-test-target="top-info-header"]');

        // Rank text. TripAdvisor renders "#3 of 1,234 hotels in Paris" etc.
        // It can sit in different containers across A/B variants, so search the
        // top of the body text for the pattern.
        const headerText = bodyText.slice(0, 12000);
        const rankMatch = headerText.match(/#?\s*([\d,]+)\s*(?:of|out of|sur)\s*([\d,]+)\s+([A-Za-z][^\n]{0,80})/i);
        let rank = { position: null, totalInCategory: null, percentile: null, raw: null };
        if (rankMatch) {
            const pos = parseInt(rankMatch[1].replace(/,/g, ''), 10);
            const tot = parseInt(rankMatch[2].replace(/,/g, ''), 10);
            if (pos > 0 && tot > 0 && pos <= tot) {
                rank = {
                    position: pos,
                    totalInCategory: tot,
                    percentile: Math.round(((tot - pos + 1) / tot) * 10000) / 100,
                    raw: rankMatch[0].trim(),
                };
            }
        }

        // Rating histogram. TripAdvisor lists rating tiers with bars and a count.
        const histogram = { 5: null, 4: null, 3: null, 2: null, 1: null };
        const histLabels = ['Excellent', 'Very good', 'Average', 'Poor', 'Terrible'];
        for (let i = 0; i < histLabels.length; i++) {
            const label = histLabels[i];
            const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`${escaped}\\s*[\\n\\r]?\\s*([\\d,]+)`, 'i');
            const m = bodyText.match(re);
            if (m) histogram[5 - i] = parseInt(m[1].replace(/,/g, ''), 10);
        }
        const histTotal = Object.values(histogram).reduce((a, b) => a + (b || 0), 0);
        if (histTotal === 0) Object.keys(histogram).forEach((k) => { histogram[k] = null; });

        // Badges: Travelers' Choice, Certificate of Excellence, owner claim.
        const tcMatch = bodyText.match(/Travele?lers'?\s+Choice[^\n]{0,40}(\d{4})?/i);
        const certMatch = /Certificate\s+of\s+Excellence/i.test(bodyText);
        const claimedMatch = /(Claimed|This (?:hotel|business|restaurant|attraction) is claimed)/i.test(bodyText);
        const badges = {
            travelersChoice: !!tcMatch,
            travelersChoiceYear: tcMatch?.[1] ? parseInt(tcMatch[1], 10) : null,
            certificateOfExcellence: certMatch,
            ownerClaimed: claimedMatch,
        };

        // Hotel class (1.0 to 5.0). Pulled from the star icon group.
        let hotelClass = null;
        const classEl = document.querySelector('svg[aria-label*="of 5 bubbles"][aria-label*="Hotel class"], [class*="hotelClass"]');
        if (classEl) {
            const lbl = classEl.getAttribute('aria-label') || classEl.textContent || '';
            const m = lbl.match(/([\d.]+)\s*(?:of|out of)\s*5/i);
            if (m) hotelClass = parseFloat(m[1]);
        }

        // Price tier ($, $$, $$$, $$$$)
        let priceTier = null;
        const priceMatch = bodyText.match(/(?:Price\s*range|Price)[:\s]*(\$+|\$+\s*–\s*\$+|US\$[\d,]+\s*–\s*US\$[\d,]+)/i);
        if (priceMatch) priceTier = priceMatch[1].trim();

        // Amenities. Look for chips in the amenity / about sections.
        const amenityRoot = document.querySelector('[data-test-target="amenities"], [data-section-id*="AMENITIES"], [data-test-target="HR_CC_LEFT"]');
        let amenities = [];
        if (amenityRoot) {
            amenities = [...amenityRoot.querySelectorAll('div, span, li')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => t && t.length < 60 && /^[A-Za-z]/.test(t) && !/of 5|bubbles|reviews?|See all/i.test(t));
            amenities = [...new Set(amenities)].slice(0, 60);
        }

        // Cuisines (restaurants only).
        let cuisines = null;
        if (kind === 'restaurant') {
            const c = bodyText.match(/CUISINES?\s*([^\n]{0,200})/i);
            if (c) cuisines = c[1].split(/[,•]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
        }

        // Trip types ratings (Families / Couples / Solo / Business / Friends).
        const tripTypes = {};
        for (const t of ['Families', 'Couples', 'Solo', 'Business', 'Friends']) {
            const re = new RegExp(`${t}\\s*([\\d,]+)`, 'i');
            const m = bodyText.match(re);
            if (m) tripTypes[t.toLowerCase()] = parseInt(m[1].replace(/,/g, ''), 10);
        }

        // Locality fallback from breadcrumbs.
        let locality = null;
        const crumbs = all('a[href*="-g"][class*="breadcrumbs"], nav a[href*="-g"]')
            .map((a) => (a.textContent || '').trim()).filter(Boolean);
        if (crumbs.length > 0) locality = crumbs[crumbs.length - 1];

        return {
            name,
            rank,
            rankText: rank.raw,
            histogram,
            badges,
            hotelClass,
            priceTier,
            amenities,
            cuisines,
            tripTypes: Object.keys(tripTypes).length > 0 ? tripTypes : null,
            locality,
        };
    }, propertyType).catch((err) => {
        log.debug(`DOM extraction failed: ${err?.message}`);
        return {
            name: null, rank: { position: null, totalInCategory: null, percentile: null, raw: null },
            rankText: null, histogram: {}, badges: {}, hotelClass: null, priceTier: null,
            amenities: [], cuisines: null, tripTypes: null, locality: null,
        };
    });
}

// ---------- Response rate sampling ----------

async function sampleResponseRate(page, sampleSize) {
    try {
        const result = await page.evaluate((max) => {
            const cards = [...document.querySelectorAll('[data-automation="reviewCard"], div[data-test-target="HR_CC_CARD"], div[class*="reviewSelector"]')];
            const slice = cards.slice(0, max);
            let respondedTo = 0;
            for (const card of slice) {
                const owner = card.querySelector('[data-automation="ownerResponse"], [class*="mgrRespBlock"], div:has(> div:has-text("Response from"))');
                const txt = (card.innerText || '').toLowerCase();
                if (owner || /response from|reply from/.test(txt)) respondedTo += 1;
            }
            return { sampleSize: slice.length, respondedTo };
        }, sampleSize);

        if (!result || result.sampleSize === 0) {
            return { sampleSize: 0, respondedTo: 0, responseRatePercent: null };
        }
        return {
            sampleSize: result.sampleSize,
            respondedTo: result.respondedTo,
            responseRatePercent: Math.round((result.respondedTo / result.sampleSize) * 1000) / 10,
        };
    } catch (err) {
        log.debug(`response rate sampling failed: ${err?.message}`);
        return { sampleSize: 0, respondedTo: 0, responseRatePercent: null };
    }
}

// ---------- Merge + parse helpers ----------

function mergeRating(jsonLd, dom, includeHistogram) {
    const overall = jsonLd?.aggregateRating ?? null;
    const reviewCount = jsonLd?.reviewCount ?? null;
    const out = { overall, reviewCount };
    if (includeHistogram) out.histogram = dom?.histogram || {};
    return out;
}

function parseDestination(rankText, propertyType, url) {
    const out = { id: null, name: null, category: null };
    try {
        const u = new URL(url);
        const m = u.pathname.match(/-(g\d+)-/);
        if (m) out.id = m[1];
    } catch {}
    if (propertyType === 'hotel') out.category = 'hotels';
    else if (propertyType === 'restaurant') out.category = 'restaurants';
    else if (propertyType === 'attraction') out.category = 'things to do';
    if (rankText) {
        const m = rankText.match(/(?:of\s*[\d,]+\s+\S+\s+(?:in|en)\s+)([^\d\n]{2,80})$/i);
        if (m) out.name = m[1].trim().replace(/[.,]\s*$/, '');
        else {
            const m2 = rankText.match(/in\s+([A-Z][^\n]{1,80})/);
            if (m2) out.name = m2[1].trim().replace(/[.,]\s*$/, '');
        }
    }
    return out;
}

function isPropertyUrl(url) {
    return /tripadvisor\.[a-z.]+\/(Hotel_Review|Restaurant_Review|Attraction_Review)-/i.test(url);
}

function isDestinationUrl(url) {
    return /tripadvisor\.[a-z.]+\/(Hotels|Restaurants|Attractions)-g\d+/i.test(url);
}

function propertyIdFromUrl(url) {
    const m = String(url).match(/-d(\d+)-/);
    return m ? `d${m[1]}` : null;
}

function propertyTypeFromUrl(url) {
    if (/Hotel_Review/i.test(url)) return 'hotel';
    if (/Restaurant_Review/i.test(url)) return 'restaurant';
    if (/Attraction_Review/i.test(url)) return 'attraction';
    return 'unknown';
}

function numberOrNull(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

async function scrollPage(page) {
    await page.evaluate(async () => {
        const steps = 5;
        const h = document.body.scrollHeight;
        for (let i = 1; i <= steps; i++) {
            window.scrollTo(0, (h * i) / steps);
            await new Promise((r) => setTimeout(r, 350));
        }
        window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(800);
}
