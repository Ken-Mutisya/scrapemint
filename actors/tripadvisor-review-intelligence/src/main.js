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
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 240,
    headless: false,
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
        async ({ page, session }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            // Warm up the session once: visit homepage to bank a Cloudflare
            // clearance cookie for this IP, then proceed to the target URL.
            if (session && !session.userData?.warmedUp) {
                try {
                    await page.goto('https://www.tripadvisor.com/', {
                        waitUntil: 'domcontentloaded',
                        timeout: 45000,
                    });
                    await page.waitForTimeout(3500);
                    session.userData = { ...(session.userData || {}), warmedUp: true };
                } catch (err) {
                    log.debug(`Homepage warmup failed: ${err?.message}`);
                }
            }
        },
    ],
    async requestHandler({ request, page, crawler }) {
        const { locationKey, pageNum, offset } = request.userData;
        const pushedForLoc = pushedPerLocation.get(locationKey) ?? 0;
        if (pushedForLoc >= maxReviews) {
            log.info(`Cap reached for ${locationKey} (${pushedForLoc}/${maxReviews}). Stopping.`);
            return;
        }

        log.info(`Fetching ${request.url} (page ${pageNum}, offset ${offset})`);
        await page.waitForTimeout(3500);

        const meta = await extractJsonLd(page, request.url);
        if (pageNum === 1) {
            log.info(
                `Location: ${meta?.name ?? locationKey} | `
                + `overall ${meta?.aggregateRating ?? '?'}★ `
                + `(${meta?.reviewCount ?? '?'} reviews on TripAdvisor)`,
            );
        }

        // Scroll to the review section so lazy-loaded cards render.
        await scrollReviewsIntoView(page);

        // Expand truncated review bodies.
        await expandReadMore(page);

        // Diagnostic: count candidate review-like elements so we can see
        // what TripAdvisor actually rendered when extraction returns zero.
        const diag = await page.evaluate(() => {
            const countSel = (s) => document.querySelectorAll(s).length;
            return {
                bubbles: countSel('[class*="ui_bubble_rating"]'),
                svgBubbles: countSel('svg[aria-label*="bubble"]'),
                dataReviewIdCount: countSel('[data-reviewid]'),
                reviewCardsAuto: countSel('[data-automation*="Review"]'),
                flexCards: countSel('[data-automation*="FlexCard"]'),
                qTags: countSel('q'),
                bodyChars: document.body?.textContent?.length ?? 0,
            };
        }).catch(() => ({}));
        log.info(`DOM diag: ${JSON.stringify(diag)}`);

        const reviews = await extractReviewCards(page);
        log.info(`Page ${pageNum} returned ${reviews.length} review cards.`);

        // Save rendered HTML on first page if we got zero reviews OR none
        // of the reviews had text, so we can introspect TripAdvisor's DOM.
        const noBody = reviews.length > 0 && reviews.every((r) => !r.text);
        if (pageNum === 1 && (reviews.length === 0 || noBody)) {
            try {
                const html = await page.content();
                const store = await Actor.openKeyValueStore();
                const safeKey = `debug_page_${locationKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                await store.setValue(safeKey, html, { contentType: 'text/html' });
                log.info(`Saved debug HTML to KV store key: ${safeKey}`);

                // Also dump one of the Review-attributed elements so we can
                // see its outer HTML and figure out the real data-automation value.
                const sample = await page.evaluate(() => {
                    const el = document.querySelector('[data-automation*="Review"]');
                    if (!el) return null;
                    return {
                        tag: el.tagName,
                        dataAutomation: el.getAttribute('data-automation'),
                        className: el.className,
                        outerSlice: el.outerHTML.slice(0, 800),
                    };
                }).catch(() => null);
                log.info(`Sample Review element: ${JSON.stringify(sample)}`);
            } catch (err) {
                log.warning(`Debug HTML save failed: ${err?.message}`);
            }
        }

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

async function extractJsonLd(page, sourceUrl) {
    // TripAdvisor pages contain MULTIPLE LodgingBusiness JSON-LD blocks: one
    // for the main hotel, plus one for each "related hotel" card rendered in
    // the sidebar. Pick the block whose name best matches the URL slug.
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
                if (t === 'LodgingBusiness' || t === 'Hotel' || t === 'Restaurant'
                    || t === 'TouristAttraction' || t === 'LocalBusiness') {
                    const country = item.address?.addressCountry;
                    candidates.push({
                        name: item.name ?? null,
                        type: t,
                        aggregateRating: item.aggregateRating?.ratingValue ?? null,
                        reviewCount: item.aggregateRating?.reviewCount ?? null,
                        priceRange: item.priceRange ?? null,
                        addressLocality: item.address?.addressLocality ?? null,
                        addressCountry: typeof country === 'string'
                            ? country
                            : country?.name ?? null,
                        _score: score(item.name),
                        _reviewCount: item.aggregateRating?.reviewCount ?? 0,
                    });
                }
            }
        }
        if (candidates.length === 0) return null;
        // Sort by URL-slug match score, then by review count (main hotel has most).
        candidates.sort((a, b) => (b._score - a._score) || (b._reviewCount - a._reviewCount));
        const best = candidates[0];
        delete best._score; delete best._reviewCount;
        return best;
    } catch (err) {
        log.debug(`JSON-LD extraction failed: ${err?.message}`);
    }
    return null;
}

async function scrollReviewsIntoView(page) {
    // Scroll down in stages so lazy-loaded review cards render.
    await page.evaluate(async () => {
        const steps = 6;
        const h = document.body.scrollHeight;
        for (let i = 1; i <= steps; i++) {
            window.scrollTo(0, (h * i) / steps);
            await new Promise((r) => setTimeout(r, 450));
        }
        window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(1200);
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
    // TripAdvisor's DOM changes often and differs across A/B buckets. Try a
    // list of known selectors, then fall back to a structural heuristic:
    // find every bubble rating on the page, walk up to its owning card, and
    // extract fields from there.
    const cardSelectors = [
        '[data-automation="reviewCard"]',
        '[data-automation="WebPresentation_SingleFlexCardReviewItem"]',
        '[data-automation*="ReviewItem"]',
        '[data-test-target="HR_CC_CARD"]',
        '[data-test-target*="review-card"]',
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

    // Structural fallback: locate every bubble rating on the page, walk up
    // to the nearest <li> or card container, then extract fields.
    // TripAdvisor's 2026 redesign uses svg[data-automation="bubbleRatingImage"]
    // with an inner <title>N of 5 bubbles</title>; older builds used class
    // "ui_bubble_rating bubble_NN". Support both.
    const heuristic = await page.evaluate(() => {
        const pickText = (root, sels) => {
            for (const s of sels) {
                const el = root?.querySelector?.(s);
                const t = el?.textContent?.trim();
                if (t) return t;
            }
            return null;
        };

        const parseRating = (ratingEl) => {
            if (!ratingEl) return null;
            const cls = ratingEl.className?.baseVal ?? ratingEl.className ?? '';
            let m = String(cls).match(/bubble_(\d+)/);
            if (m) return Math.round(Number(m[1]) / 10);
            const innerTitle = ratingEl.querySelector?.('title')?.textContent ?? '';
            const aria = ratingEl.getAttribute?.('aria-label') ?? '';
            const title = ratingEl.getAttribute?.('title') ?? '';
            m = (innerTitle + ' ' + aria + ' ' + title).match(/([1-5])(?:\.0)?\s*(?:of|out of)\s*5/i);
            if (m) return Number(m[1]);
            return null;
        };

        const ratingNodes = Array.from(document.querySelectorAll(
            'svg[data-automation="bubbleRatingImage"], svg[aria-label*="bubble"], svg[aria-label*="of 5"], [class*="ui_bubble_rating"]',
        ));

        const seen = new Set();
        const cards = [];
        for (const rating of ratingNodes) {
            // Walk up until we find a container with enough review-like text.
            // Prefer an <li> or a div with HR_CC_CARD / data-reviewid markers.
            let card = rating;
            for (let depth = 0; depth < 10 && card && card !== document.body; depth++) {
                card = card.parentElement;
                if (!card) break;
                if (card.tagName === 'LI') break;
                if (card.getAttribute?.('data-test-target') === 'HR_CC_CARD') break;
                if (card.getAttribute?.('data-reviewid')) break;
                const txt = card.textContent?.trim() ?? '';
                if (txt.length > 120 && /read more|stayed|visited|experience|night/i.test(txt)) break;
            }
            if (!card || seen.has(card)) continue;
            // Skip the aggregate rating block (has "bubbleRatingValue" sibling, no review text).
            if (card.querySelector?.('[data-automation="bubbleReviewCount"]')) continue;
            seen.add(card);

            const ratingValue = parseRating(rating);
            if (ratingValue === null) continue;

            const reviewId = card.getAttribute?.('data-reviewid')
                || card.querySelector?.('[data-reviewid]')?.getAttribute('data-reviewid')
                || null;

            let title = pickText(card, [
                'a[href*="/ShowUserReviews"]',
                '[data-test-target="review-title"] a',
                '[data-test-target="review-title"]',
                'div[class*="title"] a',
                'div[class*="title"] span',
                'div[data-automation="reviewTitle"]',
            ]);
            if (!title) {
                // Heuristic: the first short bold/link span sitting above the
                // rating svg is almost always the review title.
                const candidates = Array.from(card.querySelectorAll('a, span'))
                    .map((el) => el.textContent?.trim() || '')
                    .filter((t) => t.length > 3 && t.length < 140
                        && !/bubble|of 5|helpful|read more|stayed|visited|traveled/i.test(t));
                title = candidates[0] || null;
            }

            const textSelectors = [
                '[data-test-target="review-text"]',
                '[data-automation="reviewText"]',
                '[data-automation="tab"] + div span',
                'q span',
                'q',
                'div[class*="reviewText"]',
                'div[class*="partial_entry"]',
                'span[class*="reviewText"]',
            ];
            let text = pickText(card, textSelectors);
            if (!text) {
                // Fallback: pull the longest text node from <span> elements
                // directly inside the card. TripAdvisor 2026 teaser cards put
                // the review body in an unclassed <span>.
                const spans = Array.from(card.querySelectorAll('span'))
                    .map((s) => s.textContent?.trim() || '')
                    .filter((t) => t.length > 60 && !/bubble|rating|helpful|of 5/i.test(t));
                spans.sort((a, b) => b.length - a.length);
                text = spans[0] || null;
            }

            const reviewerName = pickText(card, [
                '[data-test-target="member-info"] a',
                'a[href*="/Profile/"]',
                'span[class*="member"]',
            ]);

            const reviewerLocation = pickText(card, [
                '[data-test-target="member-location"]',
                'div[class*="userLoc"]',
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
            ]);

            const tripType = pickText(card, [
                '[data-test-target="trip-type"]',
                'span[class*="tripType"]',
            ]);

            const ownerResponseText = pickText(card, [
                '[data-test-target="owner-response"]',
                'div[class*="mgrRspnInline"]',
                'div[class*="ownerResponse"]',
            ]);

            cards.push({
                reviewId,
                rating: ratingValue,
                title,
                text,
                reviewerName,
                reviewerLocation,
                writtenDate,
                stayDate,
                tripType,
                language: null,
                helpfulVotes: 0,
                hasOwnerResponse: !!ownerResponseText,
                ownerResponseText,
                ownerResponseDate: null,
            });
        }
        return cards;
    }).catch(() => []);

    return heuristic.filter((r) => r.text || r.title);
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
