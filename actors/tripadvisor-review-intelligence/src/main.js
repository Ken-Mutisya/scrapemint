// TripAdvisor Review Intelligence and Hotel Reputation Monitor
// Apify actor: extracts reviews from TripAdvisor hotel, attraction, and
// restaurant pages.
//
// Strategy:
//   1. Load the location page with Playwright. TripAdvisor sits behind
//      Cloudflare so a real browser with residential proxies is required.
//   2. Parse the JSON-LD ld+json script for aggregate metadata
//      (name, rating, review count, price range, geo).
//   3. Walk the rendered review cards via DOM selectors. TripAdvisor
//      ships multiple selector shapes across A/B buckets, so we try a
//      fallback chain.
//   4. Expand any truncated review bodies by clicking "Read more"
//      before extracting text.
//   5. Paginate by inserting "-or{offset}" into the URL path. Offset
//      increments by REVIEWS_PER_PAGE (10) until maxReviews is reached.
//
// Filter and sort happen client-side post-extraction because TripAdvisor's
// URL-level filters vary by locale and A/B bucket.
//
// URL shapes supported:
//   Hotel_Review, Attraction_Review, Restaurant_Review
//   Each pages reviews 10 at a time.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 100;
const REVIEWS_PER_PAGE = 10;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    locationUrls,
    locationUrl,
    maxReviews = 500,
    sortBy = 'NEWEST_FIRST',
    filterByRating = [],
    language = '',
    proxyConfiguration: proxyInput,
} = input;

const starts = [];
if (Array.isArray(locationUrls) && locationUrls.length > 0) {
    for (const item of locationUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) starts.push(u);
    }
} else if (locationUrl) {
    starts.push(locationUrl);
}

if (starts.length === 0) {
    throw new Error('Provide locationUrls or locationUrl. Example: https://www.tripadvisor.com/Hotel_Review-g60763-d93589-Reviews-The_Pierre_A_Taj_Hotel.html');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const validRatings = new Set(
    (Array.isArray(filterByRating) ? filterByRating : [])
        .map((r) => String(r).trim())
        .filter((r) => /^[1-5]$/.test(r)),
);

const pushedPerLocation = new Map();
let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: Math.max(
        starts.length * 5,
        Math.ceil(maxReviews / REVIEWS_PER_PAGE) * starts.length + 5,
    ),
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
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
            },
        ],
    },
    async requestHandler({ request, page, crawler }) {
        const { locationKey, pageNum, offset } = request.userData;
        const pushedForLoc = pushedPerLocation.get(locationKey) ?? 0;
        if (pushedForLoc >= maxReviews) {
            log.info(`Cap reached for ${locationKey} (${pushedForLoc}/${maxReviews}). Stopping.`);
            return;
        }

        log.info(`Fetching ${request.url} (page ${pageNum}, offset ${offset})`);
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);

        const meta = await extractJsonLd(page);
        if (pageNum === 1) {
            log.info(
                `Location: ${meta?.name ?? locationKey} | `
                + `overall ${meta?.aggregateRating ?? '?'}★ `
                + `(${meta?.reviewCount ?? '?'} reviews on TripAdvisor)`,
            );
        }

        // Expand truncated review bodies.
        await expandReadMore(page);

        const reviews = await extractReviewCards(page);
        log.info(`Page ${pageNum} returned ${reviews.length} review cards.`);

        for (const review of reviews) {
            const currentCount = pushedPerLocation.get(locationKey) ?? 0;
            if (currentCount >= maxReviews) break;

            if (validRatings.size > 0 && !validRatings.has(String(review.rating))) continue;
            if (language && review.language && review.language !== language) continue;

            const normalized = {
                ...review,
                locationName: meta?.name ?? null,
                locationType: meta?.type ?? null,
                locationAggregateRating: meta?.aggregateRating ?? null,
                locationReviewCount: meta?.reviewCount ?? null,
                locationPriceRange: meta?.priceRange ?? null,
                locationCity: meta?.addressLocality ?? null,
                locationCountry: meta?.addressCountry ?? null,
                sourceUrl: request.url,
                scrapedAt: new Date().toISOString(),
            };

            await Actor.pushData(normalized);
            pushedPerLocation.set(locationKey, currentCount + 1);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_REVIEWS) {
                await Actor.charge({ eventName: 'review_extracted' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        const pushedNow = pushedPerLocation.get(locationKey) ?? 0;
        const shouldPaginate = reviews.length >= REVIEWS_PER_PAGE && pushedNow < maxReviews;

        if (shouldPaginate) {
            const nextOffset = offset + REVIEWS_PER_PAGE;
            const nextUrl = buildPageUrl(starts.find((u) => deriveLocationKey(u) === locationKey) ?? request.url, nextOffset, language);
            await crawler.addRequests([{
                url: nextUrl,
                userData: { locationKey, pageNum: pageNum + 1, offset: nextOffset },
            }]);
        } else {
            log.info(
                `Done with ${locationKey}. Pushed ${pushedNow} reviews `
                + `(${reviews.length < REVIEWS_PER_PAGE ? 'end of list' : 'cap reached'}).`,
            );
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const seedRequests = starts.map((u) => {
    const locationKey = deriveLocationKey(u);
    const firstUrl = buildPageUrl(u, 0, language);
    return {
        url: firstUrl,
        userData: { locationKey, pageNum: 1, offset: 0 },
    };
});

await crawler.run(seedRequests);

log.info(`Run complete. Total reviews pushed: ${totalPushed} across ${pushedPerLocation.size} location(s). Sort: ${sortBy}.`);
await Actor.exit();

// ---- helpers ----

async function extractJsonLd(page) {
    try {
        const blocks = await page.$$eval(
            'script[type="application/ld+json"]',
            (nodes) => nodes.map((n) => n.textContent ?? '').filter(Boolean),
        );
        for (const raw of blocks) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch { continue; }
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const t = item?.['@type'];
                if (t === 'LodgingBusiness' || t === 'Hotel' || t === 'Restaurant'
                    || t === 'TouristAttraction' || t === 'LocalBusiness') {
                    return {
                        name: item.name ?? null,
                        type: t,
                        aggregateRating: item.aggregateRating?.ratingValue ?? null,
                        reviewCount: item.aggregateRating?.reviewCount ?? null,
                        priceRange: item.priceRange ?? null,
                        addressLocality: item.address?.addressLocality ?? null,
                        addressCountry: item.address?.addressCountry ?? null,
                    };
                }
            }
        }
    } catch (err) {
        log.debug(`JSON-LD extraction failed: ${err?.message}`);
    }
    return null;
}

async function expandReadMore(page) {
    const selectors = [
        'span:has-text("Read more")',
        'button:has-text("Read more")',
        '[data-automation="expandButton"]',
    ];
    for (const sel of selectors) {
        const buttons = await page.$$(sel).catch(() => []);
        for (const btn of buttons.slice(0, 20)) {
            await btn.click({ timeout: 1500 }).catch(() => {});
        }
        if (buttons.length > 0) break;
    }
    await page.waitForTimeout(800);
}

async function extractReviewCards(page) {
    // Try each selector shape in order. TripAdvisor ships several across A/B buckets.
    const cardSelectors = [
        '[data-automation="reviewCard"]',
        '[data-test-target="HR_CC_CARD"]',
        '.review-container',
        'div[data-reviewid]',
    ];

    for (const sel of cardSelectors) {
        const cards = await page.$$eval(sel, (nodes) => {
            const parseRating = (root) => {
                // Rating sits on an element whose class or aria-label encodes the bubbles.
                const labelEl = root.querySelector(
                    '[class*="ui_bubble_rating"], svg[aria-label*="bubbles"], [aria-label*="of 5"]',
                );
                const aria = labelEl?.getAttribute?.('aria-label') ?? '';
                const title = labelEl?.getAttribute?.('title') ?? '';
                const cls = labelEl?.className ?? '';
                // Classes look like "ui_bubble_rating bubble_50" meaning 5.0 stars.
                let m = String(cls).match(/bubble_(\d+)/);
                if (m) return Math.round(Number(m[1]) / 10);
                m = (aria + ' ' + title).match(/([1-5])(?:\.0)?\s*(?:of|out of)\s*5/i);
                if (m) return Number(m[1]);
                return null;
            };

            const pickText = (root, sels) => {
                for (const s of sels) {
                    const el = root.querySelector(s);
                    const t = el?.textContent?.trim();
                    if (t) return t;
                }
                return null;
            };

            return nodes.map((card) => {
                const reviewId = card.getAttribute('data-reviewid')
                    || card.querySelector('[data-reviewid]')?.getAttribute('data-reviewid')
                    || null;

                const title = pickText(card, [
                    '[data-test-target="review-title"] a',
                    '[data-test-target="review-title"]',
                    '[data-automation="reviewTitle"]',
                    'a[href*="/ShowUserReviews"]',
                    'div[class*="title"] a',
                ]);

                const text = pickText(card, [
                    '[data-test-target="review-text"]',
                    '[data-automation="reviewText"]',
                    'q span',
                    'q',
                    'div[class*="reviewText"] span',
                    'div[class*="partial_entry"]',
                ]);

                const reviewerName = pickText(card, [
                    '[data-test-target="member-info"] a',
                    '[data-automation="reviewerName"]',
                    'a[href*="/Profile/"]',
                    'div[class*="info_text"] div',
                ]);

                const reviewerLocation = pickText(card, [
                    '[data-test-target="member-location"]',
                    'div[class*="userLoc"]',
                    'span[class*="default"][class*="small"]',
                ]);

                const writtenDate = pickText(card, [
                    '[data-test-target="review-date"]',
                    'span[class*="ratingDate"]',
                    'span[class*="DateLabel"]',
                    'div[class*="reviewDate"]',
                ]);

                const stayDate = pickText(card, [
                    '[data-test-target="trip-date"]',
                    'span[class*="stayDate"]',
                    'div[class*="prw_reviews_stay_date"]',
                ]);

                const tripType = pickText(card, [
                    '[data-test-target="trip-type"]',
                    'span[class*="tripType"]',
                    'div[data-prwidget-name="reviews_trip_type_labels"]',
                ]);

                const ownerResponseText = pickText(card, [
                    '[data-test-target="owner-response"]',
                    'div[class*="mgrRspnInline"]',
                    'div[class*="ownerResponse"]',
                ]);

                const ownerResponseDate = pickText(card, [
                    '[data-test-target="owner-response-date"]',
                    'div[class*="mgrRspnInline"] span[class*="date"]',
                ]);

                const helpfulVotesText = pickText(card, [
                    '[data-test-target="helpful-votes"]',
                    'span[class*="helpfulValue"]',
                    'span[class*="numHelp"]',
                ]);
                const helpfulVotes = Number(String(helpfulVotesText || '').replace(/[^0-9]/g, '')) || 0;

                const langAttr = card.querySelector('[lang]')?.getAttribute('lang')
                    || card.closest('[lang]')?.getAttribute('lang')
                    || null;

                return {
                    reviewId,
                    rating: parseRating(card),
                    title,
                    text,
                    reviewerName,
                    reviewerLocation,
                    writtenDate,
                    stayDate,
                    tripType,
                    language: langAttr,
                    helpfulVotes,
                    hasOwnerResponse: !!ownerResponseText,
                    ownerResponseText,
                    ownerResponseDate,
                };
            }).filter((r) => r.rating !== null || r.text);
        }, sel).catch(() => []);

        if (cards.length > 0) return cards;
    }
    return [];
}

function deriveLocationKey(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/(Hotel_Review|Attraction_Review|Restaurant_Review)-g(\d+)-d(\d+)/);
        if (m) return `${m[1]}:g${m[2]}:d${m[3]}`;
        return u.pathname;
    } catch {
        return url;
    }
}

function buildPageUrl(url, offset, lang) {
    try {
        const u = new URL(url);
        // Strip any existing -orN segment and filterLang.
        u.pathname = u.pathname.replace(/-or\d+-/, '-');
        u.searchParams.delete('filterLang');

        if (offset > 0) {
            // Insert -or{offset}- right after "-Reviews".
            u.pathname = u.pathname.replace(/-Reviews-/, `-Reviews-or${offset}-`);
        }
        if (lang) u.searchParams.set('filterLang', lang);

        return u.toString();
    } catch {
        return url;
    }
}
