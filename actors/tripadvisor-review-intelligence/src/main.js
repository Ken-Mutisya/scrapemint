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
    debugDump = false,
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

        if (debugDump && pageNum === 1) {
            try {
                const store = await Actor.openKeyValueStore();
                const safeKey = `debug_${locationKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                const html = await page.content();
                await store.setValue(`${safeKey}_html`, html, { contentType: 'text/html' });

                const scriptDump = await page.evaluate(() => {
                    const result = {};
                    const nextEl = document.querySelector('#__NEXT_DATA__');
                    if (nextEl) result.__NEXT_DATA__ = nextEl.textContent;

                    for (const s of document.querySelectorAll('script[type="application/json"]')) {
                        const id = s.id || `script_${Object.keys(result).length}`;
                        result[`json_${id}`] = (s.textContent ?? '').slice(0, 2000000);
                    }

                    const inlineHits = [];
                    for (const s of document.querySelectorAll('script:not([src]):not([type])')) {
                        const t = s.textContent ?? '';
                        if (/window\.__(APOLLO_STATE|INITIAL_STATE|PRELOADED_STATE|REDUX_STATE)__/.test(t)
                            || /__REDUX_STATE__\s*=/.test(t)
                            || /"reviews"\s*:\s*\[/.test(t)) {
                            inlineHits.push(t.slice(0, 500000));
                        }
                    }
                    if (inlineHits.length) result.inline_state = inlineHits.join('\n\n---SCRIPT-BREAK---\n\n');

                    const globals = {};
                    for (const name of ['__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__REDUX_STATE__']) {
                        try {
                            if (window[name]) globals[name] = JSON.stringify(window[name]).slice(0, 1000000);
                        } catch {}
                    }
                    if (Object.keys(globals).length) result.window_globals = globals;

                    return result;
                }).catch((err) => ({ _err: err?.message ?? 'eval failed' }));

                await store.setValue(`${safeKey}_state`, scriptDump);
                log.info(`Debug dump saved: ${safeKey}_html + ${safeKey}_state (${Object.keys(scriptDump).length} keys)`);
            } catch (err) {
                log.warning(`Debug dump failed: ${err?.message}`);
            }
        }

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
    // Primary path: TripAdvisor 2026 DOM. Reviews render as
    // <div data-test-target="HR_CC_CARD"> on hotel/attraction/restaurant pages.
    // Each card contains:
    //   - title+link at div[data-test-target="review-title"] a
    //     (href holds /ShowUserReviews-g{G}-d{D}-r{REVIEW_ID}-...)
    //   - rating at svg[data-automation="bubbleRatingImage"] with inner
    //     <title>N of 5 bubbles</title>
    //   - body text inside a .fIrGe container (with webkit-line-clamp)
    //   - reviewer at a[href^="/Profile/"] plus nearby "wrote a review <date>"
    //   - "Date of stay:" and "Trip type:" labelled pairs
    const primary = await page.$$eval('[data-test-target="HR_CC_CARD"]', (allCards) => {
        // HR_CC_CARD is reused across the page (filter chips, ratings widgets,
        // review cards). A genuine review card always contains a
        // /ShowUserReviews link inside data-test-target="review-title".
        const cards = allCards.filter((c) =>
            c.querySelector('[data-test-target="review-title"] a[href*="/ShowUserReviews-"]'),
        );
        const textOf = (el) => el?.textContent?.trim() || null;
        const pickText = (root, sels) => {
            for (const s of sels) {
                const el = root?.querySelector?.(s);
                const t = el?.textContent?.trim();
                if (t) return t;
            }
            return null;
        };

        const parseRating = (root) => {
            const svg = root.querySelector('svg[data-automation="bubbleRatingImage"]');
            const title = svg?.querySelector('title')?.textContent ?? '';
            const m = title.match(/(\d+(?:\.\d+)?)\s*of\s*5/i);
            if (m) return Math.round(Number(m[1]));
            const aria = svg?.getAttribute('aria-label') ?? '';
            const m2 = aria.match(/(\d+(?:\.\d+)?)\s*of\s*5/i);
            if (m2) return Math.round(Number(m2[1]));
            return null;
        };

        const parseLabelValue = (root, label) => {
            const labelEls = root.querySelectorAll('.F_ span, .F_');
            for (const el of labelEls) {
                const t = el.textContent?.trim() || '';
                if (t.toLowerCase().startsWith(label.toLowerCase())) {
                    const parent = el.closest('.f') || el.parentElement?.parentElement;
                    if (!parent) continue;
                    const spans = parent.querySelectorAll('span');
                    for (const s of spans) {
                        const st = s.textContent?.trim() || '';
                        if (st && !st.toLowerCase().startsWith(label.toLowerCase())
                            && !st.endsWith(':')) return st;
                    }
                }
            }
            return null;
        };

        return cards.map((card) => {
            const titleAnchor = card.querySelector('[data-test-target="review-title"] a');
            const title = titleAnchor?.textContent?.trim() || null;
            const href = titleAnchor?.getAttribute('href') || '';
            const idMatch = href.match(/-r(\d+)-/);
            const reviewId = idMatch ? idMatch[1] : null;
            const reviewUrl = href
                ? (href.startsWith('http') ? href : `https://www.tripadvisor.com${href}`)
                : null;

            const rating = parseRating(card);

            // Body text: inner-most span under .fIrGe (the clamped container).
            // Fall back to the container text itself.
            let text = null;
            const body = card.querySelector('.fIrGe');
            if (body) {
                const innerSpans = Array.from(body.querySelectorAll('span'))
                    .map((s) => s.textContent?.trim() || '')
                    .filter((t) => t.length > 30);
                innerSpans.sort((a, b) => b.length - a.length);
                text = innerSpans[0] || body.textContent?.trim() || null;
            }
            if (!text) {
                text = pickText(card, [
                    '[data-test-target="review-text"]',
                    'q span',
                    'q',
                ]);
            }

            // Reviewer: TA renders two /Profile/ anchors — the first wraps
            // the avatar image (no text), the second wraps the displayed name.
            // Prefer the anchor that actually has text content.
            const profileAnchors = Array.from(card.querySelectorAll('a[href^="/Profile/"]'));
            const namedAnchor = profileAnchors.find((a) => (a.textContent?.trim() || '').length > 0);
            const profileAnchor = namedAnchor || profileAnchors[0] || null;
            const reviewerName = namedAnchor?.textContent?.trim() || null;
            const profileSlug = profileAnchor?.getAttribute('href')?.split('/Profile/')[1] || null;
            const reviewerProfileUrl = profileAnchor
                ? `https://www.tripadvisor.com${profileAnchor.getAttribute('href')}`
                : null;

            // "wrote a review Nov 2025" -> extract "Nov 2025"
            let writtenDate = null;
            const metaBlocks = card.querySelectorAll('.ZRBpD .biGQs, .ZRBpD > div');
            for (const b of metaBlocks) {
                const t = b.textContent?.trim() || '';
                const m = t.match(/wrote a review\s+(.+)$/i);
                if (m) { writtenDate = m[1].trim(); break; }
            }

            // Contributions count ("3 contributions")
            let contributions = null;
            const contribEl = card.querySelector('.Mi');
            if (contribEl) {
                const m = contribEl.textContent?.trim().match(/(\d[\d,]*)/);
                if (m) contributions = Number(m[1].replace(/,/g, ''));
            }

            const stayDate = parseLabelValue(card, 'Date of stay');
            const tripType = parseLabelValue(card, 'Trip type');

            // Owner response: TA renders it as a nested block with a heading
            // like "Response from ... Manager" inside the same card.
            let ownerResponseText = null;
            let ownerResponseDate = null;
            const cardText = card.textContent || '';
            if (/Response from/i.test(cardText)) {
                // Find the block containing "Response from" and take the
                // next sibling text block as the response body.
                const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
                let node = walker.currentNode;
                while ((node = walker.nextNode())) {
                    const t = node.textContent?.trim() || '';
                    if (/^Response from/i.test(t) && t.length < 200) {
                        // Look at following siblings of the parent.
                        let sib = node.parentElement?.nextElementSibling;
                        for (let i = 0; i < 3 && sib; i++) {
                            const st = sib.textContent?.trim() || '';
                            if (st.length > 40 && !/^Response from/i.test(st)) {
                                ownerResponseText = st;
                                break;
                            }
                            sib = sib.nextElementSibling;
                        }
                        const dateMatch = t.match(/Responded\s+(.+?)(?:$|\.)/i);
                        if (dateMatch) ownerResponseDate = dateMatch[1].trim();
                        break;
                    }
                }
            }

            // Helpful votes: the button labelled "Click to add helpful vote"
            // has a numeric span as its only integer content.
            let helpfulVotes = 0;
            const helpfulBtn = card.querySelector('button[aria-label*="helpful vote" i]');
            if (helpfulBtn) {
                const m = helpfulBtn.textContent?.trim().match(/(\d+)/);
                if (m) helpfulVotes = Number(m[1]);
            }

            return {
                reviewId,
                reviewUrl,
                rating,
                title,
                text,
                reviewerName,
                reviewerProfileUrl,
                reviewerSlug: profileSlug,
                reviewerContributions: contributions,
                writtenDate,
                stayDate,
                tripType,
                language: null,
                helpfulVotes,
                hasOwnerResponse: !!ownerResponseText,
                ownerResponseText,
                ownerResponseDate,
            };
        }).filter((r) => r.reviewId || r.text || r.title);
    }).catch(() => []);

    if (primary.length > 0) return primary;

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
