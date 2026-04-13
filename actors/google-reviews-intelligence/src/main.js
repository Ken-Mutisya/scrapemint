// Google Reviews Export and Local Business Reputation Monitor
// Apify actor: extracts reviews from Google Maps business listings.
//
// Strategy:
//   1. Resolve input into a Google Maps place URL (direct URL, single URL,
//      or search query that resolves to the first Maps result).
//   2. Load the place page with Playwright. Click the Reviews tab.
//   3. Switch sort order when requested.
//   4. Scroll the reviews panel to lazy load more cards until maxReviews
//      is reached or no new reviews appear after 3 scrolls.
//   5. Expand "More" buttons to reveal truncated review bodies.
//   6. Extract fields from each review card via data-review-id anchors.
//
// URL shapes supported:
//   https://www.google.com/maps/place/NAME/@lat,lng,zoom/data=...
//   https://maps.google.com/?cid=...
//   https://g.co/kgs/... (redirects to maps)

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_REVIEWS = 100;
const SCROLL_PAUSE_MS = 900;
const MAX_STALE_SCROLLS = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    placeUrls,
    placeUrl,
    searchQueries,
    maxReviews = 500,
    sortBy = 'NEWEST',
    filterByRating = [],
    language = '',
    proxyConfiguration: proxyInput,
} = input;

const starts = [];
if (Array.isArray(placeUrls) && placeUrls.length > 0) {
    for (const item of placeUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) starts.push({ type: 'url', value: u });
    }
} else if (placeUrl) {
    starts.push({ type: 'url', value: placeUrl });
}
if (Array.isArray(searchQueries)) {
    for (const q of searchQueries) {
        if (q && typeof q === 'string') starts.push({ type: 'query', value: q });
    }
}

if (starts.length === 0) {
    throw new Error('Provide placeUrls, placeUrl, or searchQueries. Example: https://www.google.com/maps/place/Eleven+Madison+Park/');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const validRatings = new Set(
    (Array.isArray(filterByRating) ? filterByRating : [])
        .map((r) => String(r).trim())
        .filter((r) => /^[1-5]$/.test(r)),
);

const pushedPerPlace = new Map();
let totalPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: starts.length * 3 + 5,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 480,
    headless: false,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 20,
        sessionOptions: { maxUsageCount: 15 },
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
                devices: ['desktop'],
            },
        },
        preLaunchHooks: [
            async (_pageId, launchContext) => {
                launchContext.launchOptions ??= {};
                launchContext.launchOptions.locale = 'en-US';
            },
        ],
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            // Accept consent cookie if the EU consent wall appears.
            await page.addInitScript(() => {
                document.cookie = 'CONSENT=YES+; domain=.google.com; path=/';
            });
        },
    ],
    async requestHandler({ request, page }) {
        const { placeKey, searchTerm } = request.userData;

        // Handle search query requests by resolving to a maps URL first.
        if (searchTerm) {
            const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(3500);
            // If the search resolves to a single place, Maps auto navigates.
            // Otherwise we pick the first result card.
            const firstResult = await page.$('a[href*="/maps/place/"]').catch(() => null);
            if (firstResult) {
                await firstResult.click().catch(() => {});
                await page.waitForTimeout(3000);
            }
        } else {
            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(3500);
        }

        log.info(`Fetching ${page.url()}`);
        const pushedForPlace = pushedPerPlace.get(placeKey) ?? 0;
        if (pushedForPlace >= maxReviews) {
            log.info(`Cap reached for ${placeKey}. Stopping.`);
            return;
        }

        const meta = await extractPlaceMeta(page);
        log.info(
            `Place: ${meta?.name ?? placeKey} | `
            + `${meta?.aggregateRating ?? '?'}★ (${meta?.reviewCount ?? '?'} reviews)`,
        );

        // Click the Reviews tab if present.
        await clickReviewsTab(page);

        // Switch sort order if requested.
        if (sortBy && sortBy !== 'MOST_RELEVANT') {
            await setSortOrder(page, sortBy);
        }

        // Scroll the reviews panel until cap is reached or no new cards load.
        const reviews = await scrollAndCollectReviews(page, maxReviews);
        log.info(`Collected ${reviews.length} reviews for ${placeKey}.`);

        // Save debug HTML if nothing came back on first page.
        if (reviews.length === 0) {
            try {
                const html = await page.content();
                const store = await Actor.openKeyValueStore();
                const safeKey = `debug_page_${placeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
                await store.setValue(safeKey, html, { contentType: 'text/html' });
                log.info(`Saved debug HTML to KV key: ${safeKey}`);
            } catch (err) {
                log.warning(`Debug HTML save failed: ${err?.message}`);
            }
        }

        for (const review of reviews) {
            const currentCount = pushedPerPlace.get(placeKey) ?? 0;
            if (currentCount >= maxReviews) break;
            if (validRatings.size > 0 && !validRatings.has(String(review.rating))) continue;
            if (language && review.language && review.language !== language) continue;

            const normalized = {
                ...review,
                businessName: meta?.name ?? null,
                businessCategory: meta?.category ?? null,
                businessAddress: meta?.address ?? null,
                businessPhone: meta?.phone ?? null,
                businessWebsite: meta?.website ?? null,
                businessAggregateRating: meta?.aggregateRating ?? null,
                businessReviewCount: meta?.reviewCount ?? null,
                sourceUrl: page.url(),
                scrapedAt: new Date().toISOString(),
            };

            await Actor.pushData(normalized);
            pushedPerPlace.set(placeKey, currentCount + 1);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_REVIEWS) {
                await Actor.charge({ eventName: 'review_extracted' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        const pushedNow = pushedPerPlace.get(placeKey) ?? 0;
        log.info(`Done with ${placeKey}. Pushed ${pushedNow}/${maxReviews} reviews.`);
    },
    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} (${error?.message})`);
    },
});

const seedRequests = starts.map((s, idx) => {
    const placeKey = s.type === 'url' ? derivePlaceKey(s.value) : `query:${s.value}`;
    const url = s.type === 'url' ? s.value : 'https://www.google.com/maps';
    return {
        url,
        uniqueKey: `${placeKey}:${idx}`,
        userData: {
            placeKey,
            searchTerm: s.type === 'query' ? s.value : null,
        },
    };
});

await crawler.run(seedRequests);

log.info(`Run complete. Total reviews pushed: ${totalPushed} across ${pushedPerPlace.size} place(s). Sort: ${sortBy}.`);
await Actor.exit();

// ---- helpers ----

async function extractPlaceMeta(page) {
    return await page.evaluate(() => {
        const pick = (sels) => {
            for (const s of sels) {
                const el = document.querySelector(s);
                const t = el?.textContent?.trim();
                if (t) return t;
            }
            return null;
        };
        const name = pick(['h1.DUwDvf', 'h1[class*="DUwDvf"]', 'h1']);
        // Aggregate rating sits in a div with role=img aria-label like "4.6 stars".
        const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]')
            || document.querySelector('[class*="F7nice"] span');
        const ratingText = ratingEl?.textContent?.trim() ?? '';
        const ratingNum = parseFloat(ratingText.replace(',', '.'));
        const reviewCountEl = document.querySelector('div.F7nice span:nth-child(2) span')
            || document.querySelector('button[aria-label*="reviews" i] span');
        const reviewCountText = reviewCountEl?.textContent?.trim() ?? '';
        const reviewCount = Number(reviewCountText.replace(/[^0-9]/g, '')) || null;

        const category = pick(['button[jsaction*="category"]', 'button[class*="DkEaL"]']);
        const address = pick(['button[data-item-id="address"]', 'button[aria-label*="Address"]']);
        const phone = pick(['button[data-item-id*="phone"]', 'button[aria-label*="Phone"]']);
        const websiteEl = document.querySelector('a[data-item-id="authority"]')
            || document.querySelector('a[aria-label*="Website"]');
        const website = websiteEl?.href ?? null;

        return {
            name,
            aggregateRating: Number.isFinite(ratingNum) ? ratingNum : null,
            reviewCount,
            category,
            address,
            phone,
            website,
        };
    }).catch(() => null);
}

async function clickReviewsTab(page) {
    const tab = await page.$('button[aria-label*="Reviews" i][role="tab"]')
        || await page.$('button[jsaction*="pane.rating.moreReviews"]')
        || await page.$('button:has-text("Reviews")');
    if (tab) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(2500);
    }
}

async function setSortOrder(page, sortBy) {
    const sortButton = await page.$('button[aria-label*="Sort" i]')
        || await page.$('button[data-value*="Sort"]');
    if (!sortButton) return;
    await sortButton.click().catch(() => {});
    await page.waitForTimeout(800);

    const labelMap = {
        NEWEST: /newest/i,
        HIGHEST_RATING: /highest/i,
        LOWEST_RATING: /lowest/i,
        MOST_RELEVANT: /relevant|most helpful/i,
    };
    const pattern = labelMap[sortBy];
    if (!pattern) return;

    const menuItems = await page.$$('div[role="menuitemradio"], div[role="menuitem"]');
    for (const item of menuItems) {
        const txt = (await item.textContent().catch(() => '')) || '';
        if (pattern.test(txt)) {
            await item.click().catch(() => {});
            await page.waitForTimeout(2000);
            return;
        }
    }
}

async function scrollAndCollectReviews(page, maxReviews) {
    // The reviews scroll container is the div with role=feed or the aria-label
    // "reviews of <name>" div. Fall back to document scroll.
    const panelHandle = await page.$('div[role="feed"]')
        || await page.$('div[aria-label*="Reviews of" i]');

    let stale = 0;
    let lastCount = 0;

    for (let i = 0; i < 80; i++) {
        await expandMoreButtons(page);
        const currentCount = await page.$$eval('div[data-review-id]', (els) => els.length).catch(() => 0);
        if (currentCount >= maxReviews) break;
        if (currentCount === lastCount) {
            stale += 1;
            if (stale >= MAX_STALE_SCROLLS) break;
        } else {
            stale = 0;
        }
        lastCount = currentCount;

        if (panelHandle) {
            await panelHandle.evaluate((el) => { el.scrollBy(0, el.clientHeight * 1.5); }).catch(() => {});
        } else {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
        }
        await page.waitForTimeout(SCROLL_PAUSE_MS);
    }

    await expandMoreButtons(page);

    return await page.$$eval('div[data-review-id]', (cards) => {
        const parseStars = (card) => {
            const starEl = card.querySelector('span[role="img"][aria-label*="star" i]')
                || card.querySelector('[aria-label*="star" i]');
            const label = starEl?.getAttribute('aria-label') ?? '';
            const m = label.match(/([1-5])\s*(?:of\s*5)?\s*stars?/i);
            return m ? Number(m[1]) : null;
        };
        const parseDate = (card) => {
            const el = card.querySelector('span.rsqaWe, span[class*="rsqaWe"]');
            return el?.textContent?.trim() ?? null;
        };
        const parseText = (card) => {
            const el = card.querySelector('span.wiI7pd, span[class*="wiI7pd"]');
            return el?.textContent?.trim() ?? null;
        };
        const parseOwnerResponse = (card) => {
            const textEl = card.querySelector('div.CDe7pd, div[class*="CDe7pd"]');
            const dateEl = card.querySelector('span.DZSIDd, span[class*="DZSIDd"]');
            return {
                text: textEl?.textContent?.trim() ?? null,
                date: dateEl?.textContent?.trim() ?? null,
            };
        };
        return cards.slice(0, 5000).map((card) => {
            const reviewId = card.getAttribute('data-review-id');
            const nameEl = card.querySelector('div.d4r55, div[class*="d4r55"]');
            const profileEl = card.querySelector('button[data-review-id] img, a[class*="WNxzHc"] img');
            const reviewerReviewCountEl = card.querySelector('div.RfnDt, div[class*="RfnDt"]');
            const photos = Array.from(card.querySelectorAll('button[aria-label*="Photo" i] img'))
                .map((img) => img.getAttribute('src'))
                .filter(Boolean)
                .slice(0, 20);
            const ownerResponse = parseOwnerResponse(card);

            return {
                reviewId,
                rating: parseStars(card),
                text: parseText(card),
                reviewerName: nameEl?.textContent?.trim() ?? null,
                reviewerProfileImage: profileEl?.getAttribute('src') ?? null,
                reviewerReviewCount: reviewerReviewCountEl?.textContent?.trim() ?? null,
                writtenDate: parseDate(card),
                photoUrls: photos,
                language: null,
                hasOwnerResponse: !!ownerResponse.text,
                ownerResponseText: ownerResponse.text,
                ownerResponseDate: ownerResponse.date,
            };
        }).filter((r) => r.reviewId);
    }).catch(() => []);
}

async function expandMoreButtons(page) {
    const buttons = await page.$$('button[aria-label*="See more" i], button[jsaction*="review.expandReview"]').catch(() => []);
    for (const btn of buttons.slice(0, 30)) {
        await btn.click({ timeout: 1200 }).catch(() => {});
    }
    if (buttons.length > 0) await page.waitForTimeout(600);
}

function derivePlaceKey(url) {
    try {
        const u = new URL(url);
        // Google Maps place URLs: /maps/place/NAME/@lat,lng,zoom/data=!...!1s0x...:0xPLACEID
        const m = u.pathname.match(/\/maps\/place\/([^/]+)/);
        if (m) return decodeURIComponent(m[1]).replace(/\+/g, ' ');
        const cid = u.searchParams.get('cid');
        if (cid) return `cid:${cid}`;
        return u.pathname;
    } catch {
        return url;
    }
}
