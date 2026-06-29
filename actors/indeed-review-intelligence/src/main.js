// Indeed Company Review Intelligence & Employer Reputation Monitor
// Apify actor: extracts Indeed company reviews with star ratings,
// titles, pros, cons, job titles, employment status, locations,
// dates, helpful votes, and company responses.
//
// Strategy:
//   1. Navigate to the company review page on Indeed.
//   2. Indeed reviews are server-side rendered HTML. Parse DOM
//      directly using data-testid and stable selectors.
//   3. Paginate via ?start=N (20 reviews per page).
//   4. Respect Cloudflare: 2-3s delays between pages.
//   5. Backoff on Cloudflare challenges or 403s.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 50;
const REVIEWS_PER_PAGE = 20;
const PAGE_DELAY_MS = 3000;

const SORT_MAP = {
    NEWEST: 'date',
    HIGHEST_RATED: 'rating_desc',
    LOWEST_RATED: 'rating_asc',
    MOST_HELPFUL: 'helpfulness',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyUrls,
    companyUrl,
    maxReviews = 200,
    sortBy = 'NEWEST',
    filterByRating = '',
    proxyConfiguration: proxyInput,
} = input;

const urls = [];
if (Array.isArray(companyUrls) && companyUrls.length > 0) {
    for (const item of companyUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) urls.push(u);
    }
} else if (companyUrl) {
    urls.push(companyUrl);
}

if (urls.length === 0) {
    throw new Error('Provide companyUrls or companyUrl. Example: https://www.indeed.com/cmp/Google/reviews');
}

// Normalize URLs to /reviews path
function toReviewUrl(rawUrl) {
    const cleaned = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.endsWith('/reviews')) return cleaned;
    // Handle /cmp/Company format without /reviews
    if (/\/cmp\/[^/]+$/.test(cleaned)) return cleaned + '/reviews';
    return cleaned;
}

function buildPageUrl(baseUrl, start) {
    const params = new URLSearchParams();
    if (start > 0) params.set('start', String(start));
    const sortParam = SORT_MAP[sortBy] ?? 'date';
    params.set('sort', sortParam);
    if (filterByRating) params.set('fcountry=all&frating', filterByRating);
    const qs = params.toString();
    return qs ? `${baseUrl}?${qs}` : baseUrl;
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: urls.length * Math.ceil(maxReviews / REVIEWS_PER_PAGE) + urls.length,
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
    async requestHandler({ request, page }) {
        const { label, companyData, baseUrl, startOffset = 0 } = request.userData;
        log.info(`[${label}] start=${startOffset} | ${request.url}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        // Check for Cloudflare challenge or block
        const blocked = await detectBlock(page);
        if (blocked) {
            log.warning(`Blocked on ${request.url}. Try RESIDENTIAL proxies.`);
            return;
        }

        if (label === 'COMPANY') {
            // Extract company metadata
            const company = await extractCompanyMetadata(page);
            log.info(`Company: ${company.companyName} | ${company.overallRating} stars | ${company.totalReviewCount} reviews`);

            // Extract reviews from first page
            const reviews = await extractReviews(page);
            log.info(`First page: ${reviews.length} reviews.`);

            for (const r of reviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, company, request.url);
            }

            // Queue remaining pages
            const targetCount = Math.min(maxReviews, company.totalReviewCount || maxReviews);
            const remaining = targetCount - totalPushed;
            if (remaining <= 0) return;

            const reviewBase = toReviewUrl(request.url.split('?')[0]);
            const pages = Math.ceil(remaining / REVIEWS_PER_PAGE);
            const nextRequests = [];
            for (let i = 1; i <= pages; i++) {
                const start = i * REVIEWS_PER_PAGE;
                nextRequests.push({
                    url: buildPageUrl(reviewBase, start),
                    userData: {
                        label: 'REVIEW_PAGE',
                        companyData: company,
                        baseUrl: reviewBase,
                        startOffset: start,
                    },
                    uniqueKey: `${reviewBase}-start-${start}`,
                });
            }
            log.info(`Queuing ${nextRequests.length} review pages.`);
            await crawler.addRequests(nextRequests);
            return;
        }

        if (label === 'REVIEW_PAGE') {
            if (totalPushed >= maxReviews) return;

            // Respect rate limits
            await page.waitForTimeout(PAGE_DELAY_MS);

            const reviews = await extractReviews(page);
            log.info(`[start=${startOffset}] got ${reviews.length} reviews.`);

            if (reviews.length === 0) {
                log.info('No reviews on this page. Stopping.');
                return;
            }

            for (const r of reviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, companyData, baseUrl);
            }
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const initialRequests = urls.map(url => ({
    url: buildPageUrl(toReviewUrl(url), 0),
    userData: { label: 'COMPANY' },
}));

await crawler.run(initialRequests);
log.info(`Run complete. Total reviews pushed: ${totalPushed}`);
await Actor.exit();

// ---- helpers ----

async function pushReview(review, company, sourceUrl) {
    await Actor.pushData({
        ...review,
        companyName: company?.companyName ?? null,
        companyIndustry: company?.industry ?? null,
        companySize: company?.companySize ?? null,
        companyLocation: company?.headquarters ?? null,
        overallRating: company?.overallRating ?? null,
        totalReviewCount: company?.totalReviewCount ?? null,
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
    if (/\/challenge|\/captcha|\/blocked/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|cloudflare/i.test(title)) return true;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '').catch(() => '');
    if (/verify you are human|checking your browser|enable javascript and cookies/i.test(bodyText)) return true;
    return false;
}

async function extractCompanyMetadata(page) {
    return page.evaluate(() => {
        const result = {
            companyName: null,
            industry: null,
            companySize: null,
            headquarters: null,
            overallRating: null,
            totalReviewCount: 0,
        };

        // Company name
        const nameEl = document.querySelector('[data-testid="company-name"], [data-testid="employerHeaderCompanyName"], h1');
        if (nameEl) result.companyName = nameEl.textContent.trim();

        // Overall rating
        const ratingEl = document.querySelector('[data-testid="rating-value"], [data-testid="company-rating"], [itemprop="ratingValue"]');
        if (ratingEl) {
            const m = ratingEl.textContent.match(/([\d.]+)/);
            if (m) result.overallRating = parseFloat(m[1]);
        }
        // Fallback: aria-label with star info
        if (!result.overallRating) {
            const starEl = document.querySelector('[aria-label*="out of 5 stars"]');
            if (starEl) {
                const m = starEl.getAttribute('aria-label').match(/([\d.]+)/);
                if (m) result.overallRating = parseFloat(m[1]);
            }
        }

        // Total review count
        const countEl = document.querySelector('[data-testid="review-count"], a[href*="reviews"]');
        if (countEl) {
            const m = countEl.textContent.match(/([\d,]+)\s*reviews?/i);
            if (m) result.totalReviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        }
        if (!result.totalReviewCount) {
            const allText = document.body?.innerText ?? '';
            const m = allText.match(/([\d,]+)\s*reviews?/i);
            if (m) result.totalReviewCount = parseInt(m[1].replace(/,/g, ''), 10);
        }

        // Industry, size, headquarters from company info sidebar
        const infoItems = document.querySelectorAll('[data-testid="companyInfo-item"], .cmp-CompanyInfoItem');
        infoItems.forEach((item) => {
            const text = item.textContent.trim();
            if (/industry/i.test(text)) result.industry = text.replace(/industry:?\s*/i, '').trim();
            if (/employees|company size/i.test(text)) result.companySize = text.replace(/(?:company size|employees):?\s*/i, '').trim();
            if (/headquarters|hq/i.test(text)) result.headquarters = text.replace(/(?:headquarters|hq):?\s*/i, '').trim();
        });

        return result;
    });
}

async function extractReviews(page) {
    return page.evaluate(() => {
        const out = [];

        // Indeed review containers
        const reviewEls = document.querySelectorAll(
            '[data-testid^="review-"], [data-tn-component="review"], .cmp-Review'
        );

        // Fallback: look for review-like article elements
        const containers = reviewEls.length > 0
            ? reviewEls
            : document.querySelectorAll('div[id^="review_"], article, [itemtype*="Review"]');

        containers.forEach((el) => {
            // Skip tiny elements
            if (el.innerText.length < 30) return;

            // Star rating
            const starEl = el.querySelector('[data-testid="review-rating"] button, [aria-label*="out of 5 stars"]');
            let rating = null;
            if (starEl) {
                const ariaLabel = starEl.getAttribute('aria-label') ?? starEl.textContent ?? '';
                const m = ariaLabel.match(/([\d.]+)/);
                if (m) rating = parseFloat(m[1]);
            }

            // Review title
            const titleEl = el.querySelector('[data-testid="review-title"], h2 a, h2 span');
            const reviewTitle = titleEl?.textContent?.trim() ?? null;

            // Pros
            const prosEl = el.querySelector('[data-testid="pros-text"], .cmp-ReviewProsCons--pros span');
            const pros = prosEl?.textContent?.trim() ?? null;

            // Cons
            const consEl = el.querySelector('[data-testid="cons-text"], .cmp-ReviewProsCons--cons span');
            const cons = consEl?.textContent?.trim() ?? null;

            // Full review text (some reviews have a single text block instead of pros/cons)
            const bodyEl = el.querySelector('[data-testid="review-text"], .cmp-ReviewBody span');
            const reviewText = bodyEl?.textContent?.trim() ?? null;

            // Job title
            const jobEl = el.querySelector('[data-testid="review-job-title"], .cmp-ReviewAuthor span:first-child');
            const jobTitle = jobEl?.textContent?.trim()?.replace(/^[-–]\s*/, '') ?? null;

            // Employment status (current/former)
            const statusEl = el.querySelector('[data-testid="review-employment-status"]');
            let employmentStatus = null;
            if (statusEl) {
                employmentStatus = statusEl.textContent.trim();
            } else {
                // Try to find "Current Employee" or "Former Employee" in the author area
                const authorText = el.querySelector('.cmp-ReviewAuthor')?.textContent ?? '';
                if (/current employee/i.test(authorText)) employmentStatus = 'Current Employee';
                else if (/former employee/i.test(authorText)) employmentStatus = 'Former Employee';
            }

            // Location
            const locEl = el.querySelector('[data-testid="review-location"], .cmp-ReviewAuthor--location');
            const location = locEl?.textContent?.trim()?.replace(/^[-–,]\s*/, '') ?? null;

            // Date
            const dateEl = el.querySelector('[data-testid="review-date"], .cmp-ReviewDate, time, span[itemprop="datePublished"]');
            const reviewDate = dateEl?.getAttribute('datetime') ?? dateEl?.textContent?.trim() ?? null;

            // Helpful count
            const helpfulEl = el.querySelector('[data-testid="helpful-count"], .cmp-ReviewHelpful');
            let helpfulCount = 0;
            if (helpfulEl) {
                const m = helpfulEl.textContent.match(/(\d+)/);
                if (m) helpfulCount = parseInt(m[1], 10);
            }

            // Company response
            const responseEl = el.querySelector('[data-testid="employer-response"], .cmp-EmployerResponse');
            const hasCompanyResponse = !!responseEl;
            const companyResponseText = responseEl?.textContent?.trim() ?? null;

            if (rating !== null || pros || cons || reviewText) {
                out.push({
                    rating,
                    reviewTitle,
                    pros,
                    cons,
                    reviewText,
                    jobTitle,
                    employmentStatus,
                    location,
                    reviewDate,
                    helpfulCount,
                    hasCompanyResponse,
                    companyResponseText,
                });
            }
        });

        return out;
    });
}
