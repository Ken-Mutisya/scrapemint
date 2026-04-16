// Facebook Review Intelligence & Business Reputation Monitor
// Apify actor: extracts Facebook business page recommendations with
// reviewer names, recommendation text, dates, like counts, comment
// counts, and aggregate page info.
//
// Strategy:
//   1. Inject user-provided Facebook cookies for authentication.
//   2. Navigate to the business page /reviews tab.
//   3. Scroll the review feed to load more reviews (infinite scroll).
//   4. Parse each review card from the DOM: recommendation status,
//      text, reviewer, date, reactions, comments.
//   5. Also try mbasic.facebook.com as fallback for simpler HTML.
//   6. Backoff on login walls or rate limits.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 50;
const SCROLL_PAUSE = 2500;
const MAX_SCROLL_ATTEMPTS = 200;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    pageUrls,
    pageUrl,
    maxReviews = 500,
    loginCookies: loginCookiesRaw,
    proxyConfiguration: proxyInput,
} = input;

const urls = [];
if (Array.isArray(pageUrls) && pageUrls.length > 0) {
    for (const item of pageUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) urls.push(u);
    }
} else if (pageUrl) {
    urls.push(pageUrl);
}

if (urls.length === 0) {
    throw new Error('Provide pageUrls or pageUrl. Example: https://www.facebook.com/InNOut/reviews');
}

// Parse login cookies
let loginCookies = [];
if (loginCookiesRaw) {
    try {
        loginCookies = typeof loginCookiesRaw === 'string'
            ? JSON.parse(loginCookiesRaw)
            : loginCookiesRaw;
        if (!Array.isArray(loginCookies)) loginCookies = [];
    } catch (err) {
        log.warning(`Could not parse loginCookies: ${err.message}. Proceeding without login.`);
    }
}

// Normalize URLs to /reviews path
function toReviewUrl(rawUrl) {
    const cleaned = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.endsWith('/reviews')) return cleaned;
    return cleaned + '/reviews';
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: urls.length * 2 + 10,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 300,
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
    preNavigationHooks: [
        async ({ page }) => {
            // Inject Facebook cookies before navigation
            if (loginCookies.length > 0) {
                const fbCookies = loginCookies.map(c => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain || '.facebook.com',
                    path: c.path || '/',
                    httpOnly: c.httpOnly ?? false,
                    secure: c.secure ?? true,
                    sameSite: c.sameSite || 'None',
                }));
                await page.context().addCookies(fbCookies);
            }
        },
    ],
    async requestHandler({ request, page }) {
        const { label, pageData } = request.userData;
        log.info(`[${label}] ${request.url}`);

        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        // Check for login wall
        const isLoginWall = await detectLoginWall(page);
        if (isLoginWall) {
            if (loginCookies.length === 0) {
                log.error('Facebook login wall detected. Please provide loginCookies in the input.');
                log.info('Export your Facebook cookies using a browser extension like EditThisCookie or Cookie-Editor.');
                return;
            }
            log.warning('Login wall detected despite cookies. Cookies may be expired.');

            // Try mbasic fallback
            log.info('Trying mbasic.facebook.com fallback...');
            const mbasicUrl = request.url.replace('www.facebook.com', 'mbasic.facebook.com');
            await crawler.addRequests([{
                url: mbasicUrl,
                userData: { label: 'MBASIC_REVIEWS', pageData },
            }]);
            return;
        }

        if (label === 'PAGE_REVIEWS') {
            // Extract page metadata
            const pageMeta = await extractPageMetadata(page);
            log.info(`Page: ${pageMeta.pageName} | ${pageMeta.overallRating ?? 'N/A'} rating`);

            // Scroll and extract reviews
            const reviews = await scrollAndExtractReviews(page, maxReviews);
            log.info(`Extracted ${reviews.length} reviews from main feed.`);

            for (const r of reviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, pageMeta, request.url);
            }

            // If we didn't get enough, try mbasic
            if (totalPushed < maxReviews && reviews.length < 5) {
                log.info('Few reviews from main page, trying mbasic fallback...');
                const mbasicUrl = request.url.replace('www.facebook.com', 'mbasic.facebook.com');
                await crawler.addRequests([{
                    url: mbasicUrl,
                    userData: { label: 'MBASIC_REVIEWS', pageData: pageMeta },
                }]);
            }
            return;
        }

        if (label === 'MBASIC_REVIEWS') {
            // mbasic.facebook.com has simpler server-rendered HTML
            const pageMeta = pageData ?? await extractMbasicPageMeta(page);
            const reviews = await extractMbasicReviews(page);
            log.info(`[mbasic] Extracted ${reviews.length} reviews.`);

            for (const r of reviews) {
                if (totalPushed >= maxReviews) break;
                await pushReview(r, pageMeta, request.url);
            }

            // Follow "See more" pagination links on mbasic
            if (totalPushed < maxReviews) {
                const nextUrl = await page.evaluate(() => {
                    const links = [...document.querySelectorAll('a')];
                    const seeMore = links.find(a =>
                        /see more|show more|more reviews/i.test(a.textContent)
                    );
                    return seeMore?.href || null;
                });
                if (nextUrl) {
                    log.info(`[mbasic] Following pagination: ${nextUrl}`);
                    await crawler.addRequests([{
                        url: nextUrl,
                        userData: { label: 'MBASIC_REVIEWS', pageData: pageMeta },
                    }]);
                }
            }
        }
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const initialRequests = urls.map(url => ({
    url: toReviewUrl(url),
    userData: { label: 'PAGE_REVIEWS' },
}));

await crawler.run(initialRequests);
log.info(`Run complete. Total reviews pushed: ${totalPushed}`);
await Actor.exit();

// ---- helpers ----

async function pushReview(review, pageMeta, sourceUrl) {
    await Actor.pushData({
        ...review,
        pageName: pageMeta?.pageName ?? null,
        pageCategory: pageMeta?.pageCategory ?? null,
        pageAddress: pageMeta?.pageAddress ?? null,
        pagePhone: pageMeta?.pagePhone ?? null,
        overallRating: pageMeta?.overallRating ?? null,
        totalReviewCount: pageMeta?.totalReviewCount ?? null,
        sourceUrl,
        scrapedAt: new Date().toISOString(),
    });
    totalPushed += 1;

    if (totalPushed > FREE_TIER_REVIEWS) {
        await Actor.charge({ eventName: 'review_extracted' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

async function detectLoginWall(page) {
    const url = page.url();
    if (/\/login|\/checkpoint/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/log in|sign up|facebook.*login/i.test(title)) return true;
    const hasLoginForm = await page.$('form[action*="login"], #loginform, [data-testid="royal_login_form"]').catch(() => null);
    if (hasLoginForm) return true;
    return false;
}

async function extractPageMetadata(page) {
    return page.evaluate(() => {
        const result = {
            pageName: null,
            pageCategory: null,
            pageAddress: null,
            pagePhone: null,
            overallRating: null,
            totalReviewCount: null,
        };

        // Try og:title meta
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) result.pageName = ogTitle.content;

        // Try h1
        if (!result.pageName) {
            const h1 = document.querySelector('h1');
            if (h1) result.pageName = h1.textContent.trim();
        }

        // Look for rating text
        const allText = document.body?.innerText ?? '';
        const ratingMatch = allText.match(/([\d.]+)\s*(?:out of 5|\/\s*5)/i);
        if (ratingMatch) result.overallRating = parseFloat(ratingMatch[1]);

        // Look for review count
        const countMatch = allText.match(/([\d,]+)\s*(?:reviews?|recommendations?)/i);
        if (countMatch) result.totalReviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);

        // Look for category
        const categoryEl = document.querySelector('[data-testid="page_category"]') ||
            document.querySelector('a[href*="/pages/category/"]');
        if (categoryEl) result.pageCategory = categoryEl.textContent.trim();

        // Address
        const addressEl = document.querySelector('[data-testid="page_address"]');
        if (addressEl) result.pageAddress = addressEl.textContent.trim();

        // Phone
        const phoneEl = document.querySelector('[data-testid="page_phone"]');
        if (phoneEl) result.pagePhone = phoneEl.textContent.trim();

        return result;
    });
}

async function scrollAndExtractReviews(page, maxTarget) {
    const allReviews = [];
    const seenTexts = new Set();
    let scrollAttempts = 0;
    let noNewReviewsCount = 0;

    while (allReviews.length < maxTarget && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        // Extract visible reviews
        const batch = await page.evaluate(() => {
            const out = [];

            // Facebook review containers vary; try multiple selectors
            const reviewSelectors = [
                '[role="article"]',
                '[data-testid="UFI2Comment/root_depth_0"]',
                'div[class*="review"]',
            ];

            let reviewEls = [];
            for (const sel of reviewSelectors) {
                reviewEls = document.querySelectorAll(sel);
                if (reviewEls.length > 0) break;
            }

            // Fallback: grab divs that look like review blocks
            if (reviewEls.length === 0) {
                reviewEls = document.querySelectorAll('div[role="listitem"], div[data-pagelet*="review"]');
            }

            reviewEls.forEach((el) => {
                // Skip very short elements (navigation chrome, not reviews)
                if (el.innerText.length < 20) return;

                // Recommendation status
                let recommendation = null;
                const recText = el.innerText;
                if (/recommends/i.test(recText) && !/doesn.t recommend/i.test(recText)) {
                    recommendation = 'positive';
                } else if (/doesn.t recommend/i.test(recText) || /does not recommend/i.test(recText)) {
                    recommendation = 'negative';
                }

                // Reviewer name: usually a link near the top of the review card
                const nameLink = el.querySelector('a[role="link"] strong, h3 a, h4 a, a[href*="/profile"], a[href*="facebook.com/"][tabindex="0"]');
                const reviewerName = nameLink?.textContent?.trim() ?? null;
                const reviewerUrl = nameLink?.href ?? null;

                // Review text: look for the main text block
                const textBlocks = el.querySelectorAll('div[dir="auto"], span[dir="auto"]');
                let reviewText = null;
                for (const tb of textBlocks) {
                    const t = tb.textContent?.trim() ?? '';
                    // Skip very short or recommendation-only text
                    if (t.length > 15 && !/^(recommends|doesn.t recommend)/i.test(t)) {
                        reviewText = t;
                        break;
                    }
                }

                // Date
                const timeEl = el.querySelector('abbr[data-utime], span[id*="jsc"] a[role="link"], a[href*="permalink"] span');
                let reviewDate = timeEl?.getAttribute('title') ?? timeEl?.textContent?.trim() ?? null;
                // Also try aria-label on timestamp links
                if (!reviewDate) {
                    const tsLinks = el.querySelectorAll('a[role="link"]');
                    for (const link of tsLinks) {
                        const al = link.getAttribute('aria-label') ?? '';
                        if (/\d{4}|ago|january|february|march|april|may|june|july|august|september|october|november|december/i.test(al)) {
                            reviewDate = al;
                            break;
                        }
                        const linkText = link.textContent?.trim() ?? '';
                        if (/\d+[hdwmy]\b|ago|january|february|march|april|may|june|july|august|september|october|november|december/i.test(linkText)) {
                            reviewDate = linkText;
                            break;
                        }
                    }
                }

                // Reactions count
                const reactionEl = el.querySelector('[aria-label*="reaction"], [aria-label*="like"]');
                const reactionLabel = reactionEl?.getAttribute('aria-label') ?? '';
                const reactionMatch = reactionLabel.match(/(\d+)/);
                const reactionCount = reactionMatch ? parseInt(reactionMatch[1], 10) : 0;

                // Comment count
                const commentLinks = el.querySelectorAll('a, span');
                let commentCount = 0;
                commentLinks.forEach((cl) => {
                    const ct = cl.textContent?.trim() ?? '';
                    const cm = ct.match(/(\d+)\s*comments?/i);
                    if (cm) commentCount = parseInt(cm[1], 10);
                });

                if (recommendation || reviewText) {
                    out.push({
                        recommendation,
                        reviewText,
                        reviewDate,
                        reviewerName,
                        reviewerUrl,
                        reactionCount,
                        commentCount,
                    });
                }
            });

            return out;
        });

        // Deduplicate
        let newCount = 0;
        for (const r of batch) {
            const key = `${r.reviewerName}|${r.reviewText?.slice(0, 80)}`;
            if (!seenTexts.has(key)) {
                seenTexts.add(key);
                allReviews.push(r);
                newCount++;
            }
        }

        if (newCount === 0) {
            noNewReviewsCount++;
            if (noNewReviewsCount >= 5) {
                log.info('No new reviews after 5 scroll attempts. Stopping.');
                break;
            }
        } else {
            noNewReviewsCount = 0;
        }

        log.info(`Scroll ${scrollAttempts + 1}: ${newCount} new, ${allReviews.length} total`);

        // Scroll down
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(SCROLL_PAUSE);

        // Click "See more" or expand buttons if present
        const seeMoreBtn = await page.$('div[role="button"]:has-text("See more"), [role="button"]:has-text("See More Reviews")');
        if (seeMoreBtn) {
            await seeMoreBtn.click().catch(() => {});
            await page.waitForTimeout(2000);
        }

        scrollAttempts++;
    }

    return allReviews;
}

async function extractMbasicPageMeta(page) {
    return page.evaluate(() => {
        const result = {
            pageName: null,
            pageCategory: null,
            pageAddress: null,
            pagePhone: null,
            overallRating: null,
            totalReviewCount: null,
        };

        const titleEl = document.querySelector('title');
        if (titleEl) result.pageName = titleEl.textContent.replace(/ \| Facebook$/, '').trim();

        const h3 = document.querySelector('h3');
        if (h3 && !result.pageName) result.pageName = h3.textContent.trim();

        const allText = document.body?.innerText ?? '';
        const ratingMatch = allText.match(/([\d.]+)\s*(?:out of 5|\/\s*5)/i);
        if (ratingMatch) result.overallRating = parseFloat(ratingMatch[1]);

        const countMatch = allText.match(/([\d,]+)\s*(?:reviews?|recommendations?)/i);
        if (countMatch) result.totalReviewCount = parseInt(countMatch[1].replace(/,/g, ''), 10);

        return result;
    });
}

async function extractMbasicReviews(page) {
    return page.evaluate(() => {
        const out = [];

        // mbasic uses simple divs and tables
        const storyDivs = document.querySelectorAll('div[data-ft], div.story_body_container, div[id^="u_"]');

        storyDivs.forEach((el) => {
            const text = el.innerText ?? '';
            if (text.length < 20) return;

            let recommendation = null;
            if (/recommends/i.test(text) && !/doesn.t recommend/i.test(text)) {
                recommendation = 'positive';
            } else if (/doesn.t recommend/i.test(text) || /does not recommend/i.test(text)) {
                recommendation = 'negative';
            }

            const nameEl = el.querySelector('a[href*="profile"], a[href*="facebook.com/"], strong a, h3 a');
            const reviewerName = nameEl?.textContent?.trim() ?? null;
            const reviewerUrl = nameEl?.href ?? null;

            // Extract the review text (skip the recommendation line and reviewer name)
            let reviewText = null;
            const paragraphs = el.querySelectorAll('p, div > span');
            for (const p of paragraphs) {
                const t = p.textContent?.trim() ?? '';
                if (t.length > 15 && !/^(recommends|doesn.t recommend)/i.test(t) && t !== reviewerName) {
                    reviewText = t;
                    break;
                }
            }

            const dateEl = el.querySelector('abbr, span[data-utime], a[href*="permalink"]');
            const reviewDate = dateEl?.getAttribute('title') ?? dateEl?.textContent?.trim() ?? null;

            if (recommendation || reviewText) {
                out.push({
                    recommendation,
                    reviewText,
                    reviewDate,
                    reviewerName,
                    reviewerUrl,
                    reactionCount: 0,
                    commentCount: 0,
                });
            }
        });

        return out;
    });
}
