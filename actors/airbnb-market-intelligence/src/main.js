// Vacation Rental Revenue Estimator & Competitor Intelligence
// Entry point for the Apify actor. Crawls Airbnb search result pages and
// pushes normalized listing records to the default dataset.
//
// Design notes:
//   * Search pages ship a JSON blob in #data-deferred-state-0. The listings
//     live at niobeClientData[0][1].data.presentation.staysSearch.results
//     .searchResults. Shape verified 2026-04-11 against real Airbnb HTML.
//   * DOM selectors are a fallback in case Airbnb ships a shape change. The
//     primary path is the JSON blob because it carries coords, beds, rating,
//     and price breakdowns the DOM does not.
//   * Locale is pinned to en-US and currency=USD is injected into URLs so
//     the actor returns consistent dollar prices regardless of the runner's
//     egress IP geolocation. Airbnb localizes aggressively by IP otherwise.
//   * maxProperties is a hard cap so a bad input cannot burn the budget.

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

const FREE_TIER_PROPERTIES = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls,
    location,
    checkIn,
    checkOut,
    adults = 2,
    maxProperties = 50,
    proxyConfiguration: proxyInput,
} = input;

// Build start URLs: prefer explicit list, else construct from location.
const requests = [];
if (Array.isArray(startUrls) && startUrls.length > 0) {
    for (const item of startUrls) {
        const url = typeof item === 'string' ? item : item?.url;
        if (url) requests.push({ url: ensureUsd(url), userData: { label: 'SEARCH' } });
    }
} else if (location) {
    const slug = encodeURIComponent(location.trim().replace(/\s+/g, '-'));
    const params = new URLSearchParams({ adults: String(adults), currency: 'USD' });
    if (checkIn) params.set('checkin', checkIn);
    if (checkOut) params.set('checkout', checkOut);
    const url = `https://www.airbnb.com/s/${slug}/homes?${params.toString()}`;
    requests.push({ url, userData: { label: 'SEARCH' } });
}

if (requests.length === 0) {
    throw new Error('Provide startUrls or a location.');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

let pushedCount = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: Math.max(10, maxProperties * 2),
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    headless: true,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        preLaunchHooks: [
            async (_pageId, launchContext) => {
                launchContext.launchOptions ??= {};
                launchContext.launchOptions.locale = 'en-US';
                launchContext.launchOptions.timezoneId = 'America/Los_Angeles';
            },
        ],
    },
    async requestHandler({ request, page, enqueueLinks }) {
        if (pushedCount >= maxProperties) {
            log.info(`Cap reached (${maxProperties}). Stopping.`);
            return;
        }

        log.info(`Crawling ${request.url}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('#data-deferred-state-0, [data-testid="card-container"]', {
            timeout: 20_000,
        }).catch(() => {});

        const listings = await extractFromDeferredState(page);
        const records = listings.length > 0 ? listings : await extractFromDom(page);

        for (const record of records) {
            if (pushedCount >= maxProperties) break;
            await Actor.pushData({
                ...record,
                sourceUrl: request.url,
                scrapedAt: new Date().toISOString(),
            });
            pushedCount += 1;
            // Per-run free tier: first 20 properties are free, rest are billed.
            // Matches the README pricing table. Charge events must be declared
            // in the actor pricing config (PAY_PER_EVENT) on the platform.
            if (pushedCount > FREE_TIER_PROPERTIES) {
                await Actor.charge({ eventName: 'property_scanned' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        log.info(
            `Extracted ${records.length} from page `
            + `(via ${listings.length > 0 ? 'json' : 'dom'}), total pushed ${pushedCount}.`,
        );

        if (pushedCount < maxProperties) {
            await enqueueLinks({
                selector: 'a[aria-label="Next"]',
                userData: { label: 'SEARCH' },
                transformRequestFunction: (req) => ({ ...req, url: ensureUsd(req.url) }),
            });
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Request failed: ${request.url} (${error?.message})`);
    },
});

await crawler.run(requests);

log.info(`Run complete. Pushed ${pushedCount} properties.`);

await Actor.exit();

// ---- helpers ----

function ensureUsd(url) {
    try {
        const u = new URL(url);
        if (!u.searchParams.has('currency')) u.searchParams.set('currency', 'USD');
        return u.toString();
    } catch {
        return url;
    }
}

async function extractFromDeferredState(page) {
    try {
        const raw = await page.$eval('#data-deferred-state-0', (el) => el.textContent);
        if (!raw) return [];
        const json = JSON.parse(raw);
        const results = findStaysResults(json);
        return results.map(normalizeListing).filter(Boolean);
    } catch (err) {
        log.debug(`deferred state parse skipped: ${err?.message}`);
        return [];
    }
}

function findStaysResults(json) {
    // Direct path, verified 2026-04-11.
    const direct = json?.niobeClientData?.[0]?.[1]?.data?.presentation?.staysSearch?.results?.searchResults;
    if (Array.isArray(direct) && direct.length > 0) return direct;
    // Fallback walker in case Airbnb nudges the shape.
    return walkForStaySearchResults(json);
}

function walkForStaySearchResults(node, depth = 0) {
    if (!node || depth > 10) return [];
    if (Array.isArray(node)) {
        if (node.length > 0 && node.every((n) => n && typeof n === 'object' && n.__typename === 'StaySearchResult')) {
            return node;
        }
        for (const child of node) {
            const found = walkForStaySearchResults(child, depth + 1);
            if (found.length) return found;
        }
        return [];
    }
    if (typeof node === 'object') {
        for (const key of Object.keys(node)) {
            const found = walkForStaySearchResults(node[key], depth + 1);
            if (found.length) return found;
        }
    }
    return [];
}

function normalizeListing(result) {
    if (!result) return null;
    const stay = result.demandStayListing ?? {};
    const numericId = decodeDemandStayListingId(stay.id);
    if (!numericId) return null;

    const price = result.structuredDisplayPrice ?? {};
    const primary = price.primaryLine ?? {};
    const ratingInfo = parseRating(result.avgRatingA11yLabel, result.avgRatingLocalized);
    const beds = parseStructuredContent(result.structuredContent);

    return {
        id: numericId,
        name: stay?.description?.name?.localizedStringWithTranslationPreference
            ?? result?.nameLocalized?.localizedStringWithTranslationPreference
            ?? null,
        title: result.title ?? null,
        subtitle: result.subtitle ?? null,
        url: `https://www.airbnb.com/rooms/${numericId}`,
        latitude: stay?.location?.coordinate?.latitude ?? null,
        longitude: stay?.location?.coordinate?.longitude ?? null,
        bedrooms: beds.bedrooms,
        beds: beds.beds,
        bedInfo: beds.bedInfo,
        rating: ratingInfo.rating,
        reviewsCount: ratingInfo.reviewsCount,
        ratingLabel: result.avgRatingA11yLabel ?? null,
        priceLabel: primary.accessibilityLabel ?? primary.price ?? null,
        priceText: primary.price ?? null,
        priceQualifier: primary.qualifier ?? null,
        priceTotalLabel: price?.explanationData?.priceDetails?.[0]?.items?.[0]?.priceString ?? null,
        priceBreakdownDescription: price?.explanationData?.priceDetails?.[0]?.items?.[0]?.description ?? null,
        badges: Array.isArray(result.badges) ? result.badges.map((b) => b?.text).filter(Boolean) : [],
        pictureUrl: result?.contextualPictures?.[0]?.picture ?? null,
    };
}

function decodeDemandStayListingId(base64Id) {
    if (!base64Id) return null;
    try {
        const decoded = Buffer.from(base64Id, 'base64').toString('utf8');
        // Format: "DemandStayListing:1618298236649214789"
        const match = decoded.match(/:(\d+)$/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

function parseRating(a11yLabel, localized) {
    if (a11yLabel) {
        const ratingMatch = a11yLabel.match(/([0-9.]+)\s*out of 5/);
        const reviewsMatch = a11yLabel.match(/(\d+)\s*review/);
        return {
            rating: ratingMatch ? Number(ratingMatch[1]) : null,
            reviewsCount: reviewsMatch ? Number(reviewsMatch[1]) : null,
        };
    }
    if (localized) {
        // "4.7 (10)"
        const match = localized.match(/([0-9.]+)\s*\((\d+)\)/);
        if (match) return { rating: Number(match[1]), reviewsCount: Number(match[2]) };
    }
    return { rating: null, reviewsCount: null };
}

function parseStructuredContent(structured) {
    const primary = Array.isArray(structured?.primaryLine) ? structured.primaryLine : [];
    const texts = primary.map((p) => p?.body).filter((s) => typeof s === 'string');
    let bedrooms = null;
    let beds = null;
    for (const text of texts) {
        const bedroomMatch = text.match(/(\d+(?:\.\d+)?)\s*bedroom/i);
        if (bedroomMatch) bedrooms = Number(bedroomMatch[1]);
        const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:king|queen|double|single|twin|full)?\s*bed(?!room)/i);
        if (bedMatch) beds = Number(bedMatch[1]);
    }
    return { bedrooms, beds, bedInfo: texts };
}

async function extractFromDom(page) {
    return page.$$eval('[data-testid="card-container"]', (cards) => {
        return cards.map((card) => {
            const link = card.querySelector('a[href*="/rooms/"]');
            const href = link?.getAttribute('href') ?? null;
            const id = href?.match(/\/rooms\/(\d+)/)?.[1] ?? null;
            const name = card.querySelector('[data-testid="listing-card-title"]')?.textContent?.trim() ?? null;
            const priceLabel = card.querySelector('[data-testid="price-availability-row"] span')?.textContent?.trim() ?? null;
            const ratingEl = card.querySelector('[aria-label*="out of 5"], [aria-label*="rating"]');
            const ratingLabel = ratingEl?.getAttribute('aria-label') ?? null;
            const ratingMatch = ratingLabel?.match(/([0-9.]+)\s*out of 5/);
            const reviewsMatch = ratingLabel?.match(/(\d+)\s*review/);
            return {
                id: id ?? null,
                name,
                url: href ? new URL(href, 'https://www.airbnb.com').toString() : null,
                priceLabel,
                rating: ratingMatch ? Number(ratingMatch[1]) : null,
                reviewsCount: reviewsMatch ? Number(reviewsMatch[1]) : null,
            };
        }).filter((r) => r.id);
    });
}
