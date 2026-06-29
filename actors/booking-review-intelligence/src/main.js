// Hotel Review Intelligence & Competitor Sentiment Tracker
// Apify actor: extracts hotel reviews from Booking.com with sentiment
// breakdown, category scores, and reviewer metadata.
//
// Strategy:
//   1. Load the hotel page with #tab-reviews to trigger the ReviewList
//      GraphQL query from Booking.com's frontend.
//   2. Intercept that response to get the GraphQL query text and variables.
//   3. Replay the query with pagination (skip/limit) to fetch all reviews.
//   4. DOM fallback if GraphQL interception fails.
//
// The GraphQL approach returns richer data than DOM scraping: booking
// details, room type, check-in/check-out dates, partner replies, review
// photos, helpful votes, and highlights.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 50;
const REVIEWS_PER_PAGE = 25;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    hotelUrls,
    hotelUrl,
    maxReviews = 500,
    sortBy = 'NEWEST_FIRST',
    travelerType = 'ALL',
    proxyConfiguration: proxyInput,
} = input;

// Build request list from hotelUrls array or single hotelUrl
const urls = [];
if (Array.isArray(hotelUrls) && hotelUrls.length > 0) {
    for (const item of hotelUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) urls.push(u);
    }
} else if (hotelUrl) {
    urls.push(hotelUrl);
}

if (urls.length === 0) {
    throw new Error('Provide hotelUrls or hotelUrl. Example: https://www.booking.com/hotel/us/ace-new-york.html');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: urls.length * 2,
    navigationTimeoutSecs: 45,
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
    async requestHandler({ request, page }) {
        const hotelPageUrl = request.url.replace(/#.*$/, '');
        log.info(`Processing ${hotelPageUrl}`);

        // Intercept the initial ReviewList GraphQL response
        let capturedQuery = null;
        let capturedVariables = null;
        let initialReviewData = null;
        let graphqlUrl = null;

        page.on('request', (req) => {
            if (req.url().includes('graphql') && req.method() === 'POST') {
                try {
                    const body = JSON.parse(req.postData());
                    if (body.operationName === 'ReviewList') {
                        capturedQuery = body.query;
                        capturedVariables = body.variables;
                        graphqlUrl = req.url();
                    }
                } catch {}
            }
        });

        page.on('response', async (res) => {
            if (res.url().includes('graphql') && res.status() === 200) {
                try {
                    const body = JSON.parse(res.request().postData() || '{}');
                    if (body.operationName === 'ReviewList' && !initialReviewData) {
                        initialReviewData = await res.json();
                    }
                } catch {}
            }
        });

        // Navigate to hotel page with reviews tab
        const reviewTabUrl = hotelPageUrl.replace(/#.*$/, '') + '#tab-reviews';
        await page.goto(reviewTabUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);

        // Scroll to reviews to trigger the GraphQL call
        await page.evaluate(() => {
            const el = document.querySelector('[data-testid="PropertyReviewsRegionBlock"]');
            if (el) el.scrollIntoView({ behavior: 'instant' });
        });
        await page.waitForTimeout(5000);

        if (!capturedQuery || !initialReviewData) {
            log.warning('GraphQL interception failed. Trying DOM fallback...');
            const domReviews = await extractFromDom(page);
            for (const review of domReviews.slice(0, maxReviews)) {
                await pushReview(review, hotelPageUrl);
            }
            return;
        }

        const frontend = initialReviewData?.data?.reviewListFrontend;
        const totalAvailable = frontend?.reviewsCount ?? 0;
        const categoryScores = (frontend?.ratingScores ?? []).map(s => ({
            category: s.translation,
            score: Math.round(s.value * 10) / 10,
        }));

        log.info(`Hotel has ${totalAvailable} reviews. Category scores: ${JSON.stringify(categoryScores)}`);

        const targetCount = Math.min(maxReviews, totalAvailable);

        // Process initial batch
        const initialCards = frontend?.reviewCard ?? [];
        for (const card of initialCards) {
            if (totalPushed >= targetCount) break;
            await pushReview(normalizeGraphQL(card, categoryScores), hotelPageUrl);
        }

        // Paginate: replay GraphQL query with incrementing skip
        let skip = initialCards.length;
        while (totalPushed < targetCount && skip < totalAvailable) {
            log.info(`Fetching reviews ${skip} to ${skip + REVIEWS_PER_PAGE} of ${totalAvailable}...`);

            const variables = {
                ...capturedVariables,
                input: {
                    ...capturedVariables.input,
                    skip,
                    limit: REVIEWS_PER_PAGE,
                    sorter: sortBy,
                    ...(travelerType !== 'ALL' && {
                        filters: { ...capturedVariables.input?.filters, customerType: travelerType },
                    }),
                },
            };

            const result = await page.evaluate(
                async ({ url, query, variables }) => {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ operationName: 'ReviewList', query, variables }),
                    });
                    return res.json();
                },
                { url: graphqlUrl, query: capturedQuery, variables },
            );

            const cards = result?.data?.reviewListFrontend?.reviewCard ?? [];
            if (cards.length === 0) break;

            for (const card of cards) {
                if (totalPushed >= targetCount) break;
                await pushReview(normalizeGraphQL(card, categoryScores), hotelPageUrl);
            }

            skip += cards.length;
            // Small delay to be polite
            await page.waitForTimeout(1500);
        }

        log.info(`Done. Pushed ${totalPushed} reviews for ${hotelPageUrl}`);
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const requests = urls.map(url => ({
    url: url.replace(/#.*$/, '') + '#tab-reviews',
    userData: { label: 'HOTEL' },
}));

await crawler.run(requests);
log.info(`Run complete. Total reviews pushed: ${totalPushed}`);
await Actor.exit();

// ---- helpers ----

async function pushReview(review, sourceUrl) {
    await Actor.pushData({
        ...review,
        sourceUrl,
        scrapedAt: new Date().toISOString(),
    });
    totalPushed += 1;

    if (totalPushed > FREE_TIER_REVIEWS) {
        await Actor.charge({ eventName: 'review_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function normalizeGraphQL(card, categoryScores) {
    const text = card.textDetails ?? {};
    const guest = card.guestDetails ?? {};
    const booking = card.bookingDetails ?? {};

    return {
        reviewScore: card.reviewScore ?? null,
        title: text.title ?? null,
        positiveText: text.positiveText ?? null,
        negativeText: text.negativeText ?? null,
        language: text.lang ?? null,
        reviewerName: guest.username ?? null,
        reviewerCountry: guest.countryName ?? null,
        reviewerCountryCode: guest.countryCode ?? null,
        travelerType: guest.guestTypeTranslation ?? null,
        customerType: booking.customerType ?? null,
        roomType: booking.roomType?.name ?? null,
        checkinDate: booking.checkinDate ?? null,
        checkoutDate: booking.checkoutDate ?? null,
        numNights: booking.numNights ?? null,
        reviewedDate: card.reviewedDate
            ? new Date(card.reviewedDate * 1000).toISOString().slice(0, 10)
            : null,
        helpfulVotes: card.helpfulVotesCount ?? 0,
        hasPartnerReply: !!card.partnerReply,
        partnerReplyText: card.partnerReply?.text ?? null,
        hasPhotos: Array.isArray(card.photos) && card.photos.length > 0,
        photoCount: card.photos?.length ?? 0,
        reviewUrl: card.reviewUrl ?? null,
        categoryScores,
    };
}

async function extractFromDom(page) {
    return page.$$eval('[data-testid="review-card"]', (cards) => {
        return cards.map(card => {
            const score = card.querySelector('[data-testid="review-score"]');
            const title = card.querySelector('[data-testid="review-title"]');
            const pos = card.querySelector('[data-testid="review-positive-text"]');
            const neg = card.querySelector('[data-testid="review-negative-text"]');
            const date = card.querySelector('[data-testid="review-date"]');
            const stayDate = card.querySelector('[data-testid="review-stay-date"]');
            const traveler = card.querySelector('[data-testid="review-traveler-type"]');
            const room = card.querySelector('[data-testid="review-room-name"]');
            const nights = card.querySelector('[data-testid="review-num-nights"]');
            const avatar = card.querySelector('[data-testid="review-avatar"]');

            const scoreText = score?.textContent?.trim();
            const scoreNum = scoreText ? parseFloat(scoreText) : null;

            return {
                reviewScore: scoreNum,
                title: title?.textContent?.trim() ?? null,
                positiveText: pos?.textContent?.trim() ?? null,
                negativeText: neg?.textContent?.trim() ?? null,
                reviewerName: avatar?.textContent?.trim() ?? null,
                reviewedDate: date?.textContent?.replace('Reviewed:', '').trim() ?? null,
                stayDate: stayDate?.textContent?.trim() ?? null,
                travelerType: traveler?.textContent?.trim() ?? null,
                roomType: room?.textContent?.trim() ?? null,
                numNights: nights?.textContent?.match(/(\d+)/)?.[1] ? Number(nights.textContent.match(/(\d+)/)[1]) : null,
            };
        }).filter(r => r.reviewScore !== null || r.positiveText);
    });
}
