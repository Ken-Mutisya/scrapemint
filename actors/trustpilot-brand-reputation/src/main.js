// Brand Reputation Tracker: Trustpilot Sentiment & Competitor Monitor
// Apify actor: extracts reviews from Trustpilot business review pages.
//
// Strategy:
//   1. Trustpilot is a Next.js app. Every business review page ships a
//      <script id="__NEXT_DATA__"> element containing the full page
//      state as JSON. Reviews live at props.pageProps.reviews (20 per page).
//   2. businessUnit block in the same JSON carries brand metadata
//      (overall rating, total review count, categories).
//   3. Pagination is query-string based: ?page=2, ?page=3, etc.
//   4. Sorting and filtering supported via query params:
//        sort=recency | relevance
//        stars=1..5 (repeatable)
//        languages=en,fr,...
//
// Why this shape is better than DOM scraping:
//   * One JSON parse replaces dozens of selectors.
//   * Survives UI changes since the JSON is the data contract.
//   * Carries fields the DOM doesn't surface (consumer country, verified
//     status, review source, language, company reply text).

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 100;
const REVIEWS_PER_PAGE = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    businessUrls,
    businessUrl,
    maxReviews = 500,
    sortBy = 'NEWEST_FIRST',
    filterByStars = [],
    language = '',
    proxyConfiguration: proxyInput,
} = input;

// Build the starting request list
const starts = [];
if (Array.isArray(businessUrls) && businessUrls.length > 0) {
    for (const item of businessUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) starts.push(u);
    }
} else if (businessUrl) {
    starts.push(businessUrl);
}

if (starts.length === 0) {
    throw new Error('Provide businessUrls or businessUrl. Example: https://www.trustpilot.com/review/booking.com');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

// Track progress per business unit so we can stop at maxReviews each
const pushedPerBusiness = new Map();
let totalPushed = 0;

// Trustpilot server-renders the full page state into <script id="__NEXT_DATA__">,
// so we never need a browser. A plain HTTP fetch (got-scraping, via
// CheerioCrawler) with a residential proxy carries a real browser header /
// TLS profile and slips past the PerimeterX challenge that 403s a headless
// Playwright fingerprint. Sessions rotate on a block so a bad IP is retired.
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: Math.max(starts.length * 10, Math.ceil(maxReviews / REVIEWS_PER_PAGE) * starts.length + 5),
    requestHandlerTimeoutSecs: 90,
    navigationTimeoutSecs: 45,
    maxRequestRetries: 6,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 50 },
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...request.headers,
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                Referer: 'https://www.trustpilot.com/',
            };
        },
    ],
    async requestHandler({ request, $, body, crawler, session }) {
        const { businessKey, pageNum } = request.userData;
        const reviewCap = maxReviews;
        const pushedForBiz = pushedPerBusiness.get(businessKey) ?? 0;
        if (pushedForBiz >= reviewCap) {
            log.info(`Cap reached for ${businessKey} (${pushedForBiz}/${reviewCap}). Stopping pages.`);
            return;
        }

        log.info(`Fetching ${request.url} (page ${pageNum})`);

        const nextData = extractNextData($, body);
        if (!nextData) {
            // No data contract on the page usually means a soft block or a
            // challenge interstitial. Retire the session and retry on a new IP.
            session?.retire();
            throw new Error(`No __NEXT_DATA__ for ${request.url} (possible block); retrying on a fresh session.`);
        }

        const pageProps = nextData?.props?.pageProps;
        const reviews = pageProps?.reviews ?? [];
        const businessUnit = pageProps?.businessUnit;

        if (pageNum === 1) {
            log.info(
                `Business: ${businessUnit?.displayName ?? businessKey} | `
                + `overall ${businessUnit?.stars ?? '?'}★ (${businessUnit?.numberOfReviews ?? '?'} total reviews)`,
            );
        }

        log.info(`Page ${pageNum} returned ${reviews.length} reviews.`);

        for (const review of reviews) {
            const currentCount = pushedPerBusiness.get(businessKey) ?? 0;
            if (currentCount >= reviewCap) break;

            const normalized = normalizeReview(review, businessUnit, request.url);
            await Actor.pushData(normalized);
            pushedPerBusiness.set(businessKey, currentCount + 1);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_REVIEWS) {
                await Actor.charge({ eventName: 'review_row' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        const pushedNow = pushedPerBusiness.get(businessKey) ?? 0;
        const totalAvailable = businessUnit?.numberOfReviews ?? Infinity;
        const shouldPaginate = reviews.length === REVIEWS_PER_PAGE && pushedNow < reviewCap && pushedNow < totalAvailable;

        if (shouldPaginate) {
            const nextUrl = buildPageUrl(request.url, pageNum + 1, sortBy, filterByStars, language);
            await crawler.addRequests([{
                url: nextUrl,
                userData: { businessKey, pageNum: pageNum + 1 },
            }]);
        } else {
            log.info(
                `Done with ${businessKey}. Pushed ${pushedNow} reviews `
                + `(${reviews.length < REVIEWS_PER_PAGE ? 'end of list' : 'cap reached'}).`,
            );
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

// Seed the crawler with page 1 of each business URL
const seedRequests = starts.map((u) => {
    const businessKey = deriveBusinessKey(u);
    const firstPageUrl = buildPageUrl(u, 1, sortBy, filterByStars, language);
    return {
        url: firstPageUrl,
        userData: { businessKey, pageNum: 1 },
    };
});

await crawler.run(seedRequests);

log.info(`Run complete. Total reviews pushed: ${totalPushed} across ${pushedPerBusiness.size} business(es).`);
await Actor.exit();

// ---- helpers ----

function extractNextData($, body) {
    try {
        let raw = $ ? $('#__NEXT_DATA__').first().html() : null;
        if (!raw && body) {
            // Fallback: pull the script payload straight out of the raw HTML.
            const m = String(body).match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
            raw = m ? m[1] : null;
        }
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        log.debug(`__NEXT_DATA__ extraction failed: ${err?.message}`);
        return null;
    }
}

function deriveBusinessKey(url) {
    try {
        const u = new URL(url);
        // Path shape: /review/{domain} or /review/{domain}/location/{id}
        const match = u.pathname.match(/\/review\/([^/]+)/);
        return match ? match[1] : u.pathname;
    } catch {
        return url;
    }
}

function buildPageUrl(url, pageNum, sortBy, stars, lang) {
    try {
        const u = new URL(url);
        // Clean any preexisting sort/page/stars params so we own them
        u.searchParams.delete('page');
        u.searchParams.delete('sort');
        u.searchParams.delete('stars');
        u.searchParams.delete('languages');

        if (pageNum > 1) u.searchParams.set('page', String(pageNum));
        if (sortBy === 'NEWEST_FIRST') u.searchParams.set('sort', 'recency');
        else if (sortBy === 'MOST_RELEVANT') u.searchParams.set('sort', 'relevance');

        if (Array.isArray(stars) && stars.length > 0) {
            // Stars arrive as strings from Apify stringList input. Keep only 1..5.
            const valid = new Set(['1', '2', '3', '4', '5']);
            for (const s of stars) {
                const v = String(s).trim();
                if (valid.has(v)) u.searchParams.append('stars', v);
            }
        }
        if (lang) u.searchParams.set('languages', lang);

        return u.toString();
    } catch {
        return url;
    }
}

function normalizeReview(review, businessUnit, sourceUrl) {
    const consumer = review?.consumer ?? {};
    const dates = review?.dates ?? {};
    const reply = review?.reply;
    const verification = review?.labels?.verification;

    return {
        reviewId: review?.id ?? null,
        businessName: businessUnit?.displayName ?? null,
        businessDomain: businessUnit?.identifyingName ?? null,
        businessOverallStars: businessUnit?.stars ?? null,
        businessTotalReviews: businessUnit?.numberOfReviews ?? null,
        businessTrustScore: businessUnit?.trustScore ?? null,
        rating: review?.rating ?? null,
        title: review?.title ?? null,
        text: review?.text ?? null,
        language: review?.language ?? null,
        location: review?.location ?? null,
        source: review?.source ?? null,
        likes: review?.likes ?? 0,
        experiencedDate: dates?.experiencedDate ?? null,
        publishedDate: dates?.publishedDate ?? null,
        updatedDate: dates?.updatedDate ?? null,
        isVerified: verification?.isVerified ?? false,
        verificationSource: verification?.verificationSource ?? null,
        verificationLevel: verification?.verificationLevel ?? null,
        consumerId: consumer?.id ?? null,
        consumerName: consumer?.displayName ?? null,
        consumerCountry: consumer?.countryCode ?? null,
        consumerReviewCount: consumer?.numberOfReviews ?? null,
        consumerIsVerified: consumer?.isVerified ?? false,
        hasCompanyReply: !!reply,
        companyReplyText: reply?.message ?? null,
        companyReplyDate: reply?.publishedDate ?? null,
        sourceUrl,
        scrapedAt: new Date().toISOString(),
    };
}
