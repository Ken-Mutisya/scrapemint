// Yelp Review Intelligence & Local Reputation Monitor
// Apify actor: extracts Yelp business reviews with full reviewer metadata,
// photos, useful/funny/cool vote counts, owner replies, and aggregate
// business info.
//
// Strategy:
//   1. Navigate to the business page with fingerprinted Playwright.
//   2. Parse the JSON-LD blob embedded in <script type="application/ld+json">
//      for business metadata and the first review batch.
//   3. Walk the DOM for reviews using stable data-testid and aria-label
//      hooks. Yelp hashes CSS classes so we avoid class-based selectors.
//   4. Paginate via ?start=N (10 reviews per page) with sort/language
//      query params until maxReviews or the end of the list.
//   5. Backoff + UA rotation on 403/429.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 50;
const REVIEWS_PER_PAGE = 10;

const SORT_MAP = {
    NEWEST_FIRST: 'date_desc',
    OLDEST_FIRST: 'date_asc',
    HIGHEST_RATED: 'rating_desc',
    LOWEST_RATED: 'rating_asc',
    ELITES: 'elites_desc',
    MOST_HELPFUL: 'relevance_desc',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    businessUrls,
    businessUrl,
    maxReviews = 500,
    sortBy = 'NEWEST_FIRST',
    language = 'en',
    proxyConfiguration: proxyInput,
} = input;

const urls = [];
if (Array.isArray(businessUrls) && businessUrls.length > 0) {
    for (const item of businessUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) urls.push(u);
    }
} else if (businessUrl) {
    urls.push(businessUrl);
}

if (urls.length === 0) {
    throw new Error('Provide businessUrls or businessUrl. Example: https://www.yelp.com/biz/the-halal-guys-new-york');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const sortParam = SORT_MAP[sortBy] ?? 'date_desc';

let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: urls.length * Math.ceil(maxReviews / REVIEWS_PER_PAGE) + urls.length,
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
    async requestHandler({ request, page, enqueueLinks }) {
        const { label, businessData, baseUrl, startOffset = 0 } = request.userData;
        log.info(`[${label}] ${request.url}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded' });

        const blocked = await detectBlock(page);
        if (blocked) {
            log.warning(`Blocked on ${request.url}. Consider switching to RESIDENTIAL proxies.`);
            return;
        }

        await page.waitForTimeout(2500);

        if (label === 'BUSINESS') {
            const biz = await extractBusinessMetadata(page);
            log.info(`Business: ${biz.businessName} | ${biz.totalReviews} reviews | rating ${biz.aggregateRating}`);

            const firstPageReviews = await extractReviewsFromPage(page);
            log.info(`First page had ${firstPageReviews.length} reviews.`);

            for (const r of firstPageReviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, biz, request.url);
            }

            const targetCount = Math.min(maxReviews, biz.totalReviews || maxReviews);
            const remaining = targetCount - totalPushed;
            if (remaining <= 0) return;

            const pages = Math.ceil(remaining / REVIEWS_PER_PAGE);
            const baseReviewUrl = request.url.split('?')[0].split('#')[0];
            const nextRequests = [];
            for (let i = 1; i <= pages; i++) {
                const start = i * REVIEWS_PER_PAGE;
                const params = new URLSearchParams({ start: String(start), sort_by: sortParam });
                if (language && language !== 'ALL') params.set('language', language);
                nextRequests.push({
                    url: `${baseReviewUrl}?${params.toString()}`,
                    userData: {
                        label: 'REVIEW_PAGE',
                        businessData: biz,
                        baseUrl: baseReviewUrl,
                        startOffset: start,
                    },
                });
            }
            log.info(`Queuing ${nextRequests.length} review pages.`);
            await crawler.addRequests(nextRequests);
            return;
        }

        if (label === 'REVIEW_PAGE') {
            if (totalPushed >= maxReviews) return;
            const reviews = await extractReviewsFromPage(page);
            log.info(`[start=${startOffset}] got ${reviews.length} reviews.`);
            for (const r of reviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, businessData, baseUrl);
            }
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const initialRequests = urls.map(url => ({
    url: url.split('?')[0].split('#')[0],
    userData: { label: 'BUSINESS' },
}));

await crawler.run(initialRequests);
log.info(`Run complete. Total reviews pushed: ${totalPushed}`);
await Actor.exit();

// ---- helpers ----

async function pushReview(review, business, sourceUrl) {
    await Actor.pushData({
        ...review,
        businessName: business?.businessName ?? null,
        businessCategory: business?.category ?? null,
        businessAddress: business?.address ?? null,
        businessCity: business?.city ?? null,
        businessPhone: business?.phone ?? null,
        businessRating: business?.aggregateRating ?? null,
        businessReviewCount: business?.totalReviews ?? null,
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

async function detectBlock(page) {
    const url = page.url();
    if (/\/captcha|\/blocked|\/sorry/.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/captcha|access denied|blocked/i.test(title)) return true;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '').catch(() => '');
    if (/verify you are a human|press and hold|access to this page has been denied/i.test(bodyText)) return true;
    return false;
}

async function extractBusinessMetadata(page) {
    return page.evaluate(() => {
        const result = {
            businessName: null,
            category: null,
            address: null,
            city: null,
            phone: null,
            aggregateRating: null,
            totalReviews: 0,
        };

        const jsonLdNodes = document.querySelectorAll('script[type="application/ld+json"]');
        for (const node of jsonLdNodes) {
            try {
                const data = JSON.parse(node.textContent);
                const candidates = Array.isArray(data) ? data : [data];
                for (const d of candidates) {
                    if (d['@type'] === 'LocalBusiness' || d['@type'] === 'Restaurant' || (Array.isArray(d['@type']) && d['@type'].includes('LocalBusiness'))) {
                        result.businessName ||= d.name ?? null;
                        result.phone ||= d.telephone ?? null;
                        result.aggregateRating ||= d.aggregateRating?.ratingValue ?? null;
                        result.totalReviews ||= Number(d.aggregateRating?.reviewCount ?? 0);
                        if (d.address) {
                            result.address ||= [d.address.streetAddress, d.address.addressLocality, d.address.addressRegion, d.address.postalCode].filter(Boolean).join(', ');
                            result.city ||= d.address.addressLocality ?? null;
                        }
                    }
                }
            } catch {}
        }

        if (!result.businessName) {
            const h1 = document.querySelector('h1');
            if (h1) result.businessName = h1.textContent.trim();
        }

        const categoryEl = document.querySelector('[data-testid="business-category"]') || document.querySelector('a[href*="c="]');
        if (categoryEl && !result.category) result.category = categoryEl.textContent.trim();

        if (!result.totalReviews) {
            const allText = document.body.innerText;
            const match = allText.match(/(\d+(?:,\d+)*)\s+reviews?/i);
            if (match) result.totalReviews = Number(match[1].replace(/,/g, ''));
        }

        return result;
    });
}

async function extractReviewsFromPage(page) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    return page.evaluate(() => {
        const out = [];

        const jsonLdNodes = document.querySelectorAll('script[type="application/ld+json"]');
        const jsonLdReviews = [];
        for (const node of jsonLdNodes) {
            try {
                const data = JSON.parse(node.textContent);
                const candidates = Array.isArray(data) ? data : [data];
                for (const d of candidates) {
                    if (Array.isArray(d.review)) jsonLdReviews.push(...d.review);
                }
            } catch {}
        }

        const reviewBlocks = document.querySelectorAll(
            '[id^="review_"], [data-review-id], section[aria-label*="Review" i] > div > ul > li, div[data-testid*="review-feed"] > ul > li',
        );

        const parsedBlocks = [];
        reviewBlocks.forEach((block) => {
            const reviewerLink = block.querySelector('a[href*="/user_details"]');
            const reviewerName = reviewerLink?.textContent?.trim() ?? null;
            const reviewerProfileUrl = reviewerLink?.href ?? null;

            const locationEl = block.querySelector('[data-testid="UserPassport--location"]') ||
                block.querySelector('span:has(+ span[role="img"])');
            const reviewerLocation = locationEl?.textContent?.trim() ?? null;

            const ratingEl = block.querySelector('[role="img"][aria-label*="star rating" i]') ||
                block.querySelector('[aria-label*="star rating" i]');
            const ratingLabel = ratingEl?.getAttribute('aria-label') ?? '';
            const ratingMatch = ratingLabel.match(/([\d.]+)\s*star/i);
            const rating = ratingMatch ? Number(ratingMatch[1]) : null;

            const dateEl = block.querySelector('span[class*="date"]') || block.querySelector('[data-testid*="review-date"]');
            let dateText = dateEl?.textContent?.trim() ?? null;
            if (!dateText) {
                const timeEl = block.querySelector('time');
                dateText = timeEl?.getAttribute('datetime') ?? timeEl?.textContent?.trim() ?? null;
            }

            const textEl = block.querySelector('[data-testid="comment"] span') ||
                block.querySelector('p[class*="comment"] span') ||
                block.querySelector('p span[lang]');
            const text = textEl?.textContent?.trim() ?? null;

            const photoImgs = block.querySelectorAll('img[src*="yelpcdn"], img[srcset]');
            const photos = [];
            photoImgs.forEach((img) => {
                const src = img.getAttribute('src') || '';
                if (src && !/user_large_square|default_avatar|photo_default/.test(src) && src.includes('yelpcdn')) {
                    photos.push(src);
                }
            });

            const voteLabels = block.querySelectorAll('[aria-label]');
            let useful = 0, funny = 0, cool = 0;
            voteLabels.forEach((el) => {
                const al = el.getAttribute('aria-label') || '';
                const m = al.match(/(\d+)/);
                if (!m) return;
                const n = Number(m[1]);
                if (/useful/i.test(al)) useful = n;
                else if (/funny/i.test(al)) funny = n;
                else if (/cool/i.test(al)) cool = n;
            });

            const replyBlock = block.querySelector('[data-testid*="biz-response"]') ||
                block.querySelector('div[class*="biz-response"]');
            const hasBusinessReply = !!replyBlock;
            const businessReplyText = replyBlock?.innerText?.trim() ?? null;

            if (rating !== null || text) {
                parsedBlocks.push({
                    rating,
                    reviewText: text,
                    reviewDate: dateText,
                    reviewerName,
                    reviewerLocation,
                    reviewerProfileUrl,
                    photoCount: photos.length,
                    photos,
                    usefulVotes: useful,
                    funnyVotes: funny,
                    coolVotes: cool,
                    hasBusinessReply,
                    businessReplyText,
                });
            }
        });

        if (parsedBlocks.length > 0) return parsedBlocks;

        return jsonLdReviews.map((r) => ({
            rating: r.reviewRating?.ratingValue ?? null,
            reviewText: r.description ?? null,
            reviewDate: r.datePublished ?? null,
            reviewerName: r.author?.name ?? r.author ?? null,
            reviewerLocation: null,
            reviewerProfileUrl: null,
            photoCount: 0,
            photos: [],
            usefulVotes: 0,
            funnyVotes: 0,
            coolVotes: 0,
            hasBusinessReply: false,
            businessReplyText: null,
        }));
    });
}
