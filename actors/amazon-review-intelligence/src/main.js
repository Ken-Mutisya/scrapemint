// Amazon Product Review Intelligence & Sentiment Monitor
// Apify actor: extracts Amazon product reviews with star ratings,
// titles, full text, verified purchase flags, helpful vote counts,
// reviewer names, dates, images, and product metadata.
//
// Strategy:
//   1. Accept product URLs or raw ASINs. Extract the ASIN from any
//      Amazon URL format (dp/, gp/, product-reviews/).
//   2. Build the review listing URL: /product-reviews/{ASIN}/
//      with sort, filter, and pagination query params.
//   3. Amazon reviews are server-side rendered HTML. Parse the DOM
//      directly using stable data-hook and id selectors.
//   4. Paginate via ?pageNumber=N (10 reviews per page, ~10 pages max).
//   5. Backoff on CAPTCHA or 503 responses.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 50;
const REVIEWS_PER_PAGE = 10;
const MAX_PAGES = 50;

const SORT_MAP = {
    RECENT: 'recent',
    HELPFUL: 'helpful',
};

const STAR_FILTER_MAP = {
    '1': 'one_star',
    '2': 'two_star',
    '3': 'three_star',
    '4': 'four_star',
    '5': 'five_star',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    productUrls,
    asins: asinsRaw,
    maxReviews = 100,
    sortBy = 'RECENT',
    filterByRating = '',
    verifiedOnly = false,
    amazonDomain = 'amazon.com',
    proxyConfiguration: proxyInput,
} = input;

// Collect ASINs from URLs and/or raw ASIN string
const asinSet = new Set();

function extractAsin(urlOrAsin) {
    // Raw ASIN: 10 alphanumeric chars
    if (/^[A-Z0-9]{10}$/i.test(urlOrAsin.trim())) return urlOrAsin.trim().toUpperCase();
    // URL patterns: /dp/ASIN, /gp/product/ASIN, /product-reviews/ASIN
    const match = urlOrAsin.match(/(?:\/dp\/|\/gp\/product\/|\/product-reviews\/|\/ASIN\/)([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
}

if (Array.isArray(productUrls) && productUrls.length > 0) {
    for (const item of productUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) {
            const asin = extractAsin(u);
            if (asin) asinSet.add(asin);
        }
    }
}

if (asinsRaw && typeof asinsRaw === 'string') {
    for (const chunk of asinsRaw.split(/[,\s]+/)) {
        const asin = extractAsin(chunk);
        if (asin) asinSet.add(asin);
    }
}

const asins = [...asinSet];
if (asins.length === 0) {
    throw new Error('Provide productUrls or asins. Example URL: https://www.amazon.com/dp/B0D1XD1ZV3');
}

log.info(`Found ${asins.length} ASIN(s): ${asins.join(', ')}`);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const sortParam = SORT_MAP[sortBy] ?? 'recent';
const starFilter = STAR_FILTER_MAP[filterByRating] ?? '';

let totalPushed = 0;

function buildReviewUrl(asin, pageNumber) {
    const params = new URLSearchParams();
    params.set('pageNumber', String(pageNumber));
    params.set('sortBy', sortParam);
    if (starFilter) params.set('filterByStar', starFilter);
    if (verifiedOnly) params.set('reviewerType', 'avp_only_reviews');
    return `https://www.${amazonDomain}/product-reviews/${asin}/?${params.toString()}`;
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: asins.length * MAX_PAGES + asins.length,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 120,
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
    async requestHandler({ request, page }) {
        const { asin, pageNumber, productData } = request.userData;
        log.info(`[${asin}] page ${pageNumber} | ${request.url}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // Check for CAPTCHA or block
        const blocked = await detectBlock(page);
        if (blocked) {
            log.warning(`Blocked on ${request.url}. Try RESIDENTIAL proxies.`);
            return;
        }

        // First page: extract product metadata
        let product = productData;
        if (pageNumber === 1 && !product) {
            product = await extractProductMetadata(page, asin);
            log.info(`Product: ${product.productTitle} | ${product.averageRating} stars | ${product.totalReviewCount} reviews`);
        }

        // Extract reviews from this page
        const reviews = await extractReviews(page);
        log.info(`[${asin}] page ${pageNumber}: ${reviews.length} reviews`);

        if (reviews.length === 0) {
            log.info(`[${asin}] No reviews on page ${pageNumber}. Stopping pagination.`);
            return;
        }

        for (const r of reviews) {
            if (totalPushed >= maxReviews * asins.length) break;
            await pushReview(r, product, asin);
        }

        // Queue next page if we haven't hit the cap
        const pushedForAsin = totalPushed; // approximation
        if (reviews.length >= REVIEWS_PER_PAGE && pageNumber < MAX_PAGES) {
            const nextPage = pageNumber + 1;
            await crawler.addRequests([{
                url: buildReviewUrl(asin, nextPage),
                userData: { asin, pageNumber: nextPage, productData: product },
                uniqueKey: `${asin}-page-${nextPage}`,
            }]);
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const initialRequests = asins.map(asin => ({
    url: buildReviewUrl(asin, 1),
    userData: { asin, pageNumber: 1 },
    uniqueKey: `${asin}-page-1`,
}));

await crawler.run(initialRequests);
log.info(`Run complete. Total reviews pushed: ${totalPushed}`);
await Actor.exit();

// ---- helpers ----

async function pushReview(review, product, asin) {
    await Actor.pushData({
        ...review,
        asin,
        productTitle: product?.productTitle ?? null,
        productPrice: product?.productPrice ?? null,
        averageRating: product?.averageRating ?? null,
        totalReviewCount: product?.totalReviewCount ?? null,
        amazonDomain,
        productUrl: `https://www.${amazonDomain}/dp/${asin}`,
        scrapedAt: new Date().toISOString(),
    });
    totalPushed += 1;

    if (totalPushed > FREE_TIER_REVIEWS) {
        await Actor.charge({ eventName: 'review_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

async function detectBlock(page) {
    const url = page.url();
    if (/\/captcha|\/errors\/validateCaptcha/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/robot check|captcha|sorry/i.test(title)) return true;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '').catch(() => '');
    if (/enter the characters you see|type the characters|automated access/i.test(bodyText)) return true;
    return false;
}

async function extractProductMetadata(page, asin) {
    return page.evaluate((asinArg) => {
        const result = {
            productTitle: null,
            productPrice: null,
            averageRating: null,
            totalReviewCount: null,
        };

        // Product title from the review page header
        const titleEl = document.querySelector('[data-hook="product-link"]') ||
            document.querySelector('.product-title a, a[data-hook="product-link"]');
        if (titleEl) result.productTitle = titleEl.textContent.trim();

        // Average rating
        const avgEl = document.querySelector('[data-hook="rating-out-of-text"]') ||
            document.querySelector('.averageStarRating span, [data-hook="average-star-rating"] span');
        if (avgEl) {
            const m = avgEl.textContent.match(/([\d.]+)/);
            if (m) result.averageRating = parseFloat(m[1]);
        }

        // Total review count
        const countEl = document.querySelector('[data-hook="total-review-count"]') ||
            document.querySelector('.totalReviewCount');
        if (countEl) {
            const m = countEl.textContent.match(/([\d,]+)/);
            if (m) result.totalReviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        }

        return result;
    }, asin);
}

async function extractReviews(page) {
    return page.evaluate(() => {
        const out = [];
        const reviewEls = document.querySelectorAll('[data-hook="review"]');

        reviewEls.forEach((el) => {
            // Star rating
            const starEl = el.querySelector('[data-hook="review-star-rating"] span, [data-hook="cmps-review-star-rating"] span');
            const starText = starEl?.textContent ?? '';
            const starMatch = starText.match(/([\d.]+)/);
            const rating = starMatch ? parseFloat(starMatch[1]) : null;

            // Review title
            const titleEl = el.querySelector('[data-hook="review-title"] span:not(.a-letter-space), [data-hook="review-title"]');
            let reviewTitle = null;
            if (titleEl) {
                // The title span sometimes has nested spans; get the last meaningful one
                const spans = titleEl.querySelectorAll('span');
                if (spans.length > 0) {
                    reviewTitle = spans[spans.length - 1].textContent.trim();
                } else {
                    reviewTitle = titleEl.textContent.trim();
                }
            }

            // Review text
            const bodyEl = el.querySelector('[data-hook="review-body"] span');
            const reviewText = bodyEl?.textContent?.trim() ?? null;

            // Reviewer name
            const nameEl = el.querySelector('.a-profile-name, [data-hook="genome-widget"] .a-profile-name');
            const reviewerName = nameEl?.textContent?.trim() ?? null;

            // Reviewer profile URL
            const profileLink = el.querySelector('a.a-profile');
            const reviewerUrl = profileLink?.href ?? null;

            // Review date and location
            const dateEl = el.querySelector('[data-hook="review-date"]');
            const dateText = dateEl?.textContent?.trim() ?? null;
            // Format: "Reviewed in the United States on March 15, 2026"
            let reviewDate = null;
            let reviewLocation = null;
            if (dateText) {
                const dateMatch = dateText.match(/on\s+(.+)$/i);
                if (dateMatch) reviewDate = dateMatch[1];
                const locMatch = dateText.match(/in\s+(?:the\s+)?(.+?)\s+on\s+/i);
                if (locMatch) reviewLocation = locMatch[1];
            }

            // Verified purchase
            const verifiedEl = el.querySelector('[data-hook="avp-badge"], .a-color-state');
            const isVerified = !!verifiedEl && /verified/i.test(verifiedEl.textContent);

            // Helpful votes
            const helpfulEl = el.querySelector('[data-hook="helpful-vote-statement"]');
            let helpfulVotes = 0;
            if (helpfulEl) {
                const hm = helpfulEl.textContent.match(/([\d,]+)\s+(?:people|person)/i);
                if (hm) helpfulVotes = parseInt(hm[1].replace(/,/g, ''), 10);
                else if (/one person/i.test(helpfulEl.textContent)) helpfulVotes = 1;
            }

            // Images
            const imgEls = el.querySelectorAll('[data-hook="review-image-tile"], .review-image-tile-section img');
            const images = [];
            imgEls.forEach((img) => {
                const src = img.getAttribute('src') || '';
                if (src) {
                    // Get full size URL by replacing thumbnail suffix
                    const fullSrc = src.replace(/\._SY\d+_CR\d+,\d+,\d+,\d+_/, '').replace(/\._SS\d+_/, '');
                    images.push(fullSrc);
                }
            });

            if (rating !== null || reviewText) {
                out.push({
                    rating,
                    reviewTitle,
                    reviewText,
                    reviewerName,
                    reviewerUrl,
                    reviewDate,
                    reviewLocation,
                    isVerifiedPurchase: isVerified,
                    helpfulVotes,
                    imageCount: images.length,
                    images,
                });
            }
        });

        return out;
    });
}
