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
            // Pre-accept Google's EU consent wall by planting SOCS and CONSENT
            // cookies before the first Maps request. Without this Google
            // redirects to consent.google.com and no map ever renders.
            await page.context().addCookies([
                {
                    name: 'SOCS',
                    value: 'CAISHAgBEhJnd3NfMjAyMzAzMjEtMF9SQzIaAmVuIAEaBgiA_LyaBg',
                    domain: '.google.com',
                    path: '/',
                },
                {
                    name: 'CONSENT',
                    value: 'YES+cb.20210328-17-p0.en+FX+000',
                    domain: '.google.com',
                    path: '/',
                },
                {
                    name: 'NID',
                    value: '511=Kz7Z_placeholder',
                    domain: '.google.com',
                    path: '/',
                },
            ]).catch(() => {});
        },
    ],
    async requestHandler({ request, page }) {
        const { placeKey, searchTerm } = request.userData;

        // Force English and US locale so the consent wall and review
        // selectors stay in the DOM shape the extractor expects.
        const forceLocale = (url) => {
            try {
                const u = new URL(url);
                u.searchParams.set('hl', 'en');
                u.searchParams.set('gl', 'us');
                return u.toString();
            } catch { return url; }
        };

        // Handle search query requests by resolving to a maps URL first.
        if (searchTerm) {
            const searchUrl = forceLocale(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await acceptConsent(page);
            // If the search resolves to a single place, Maps auto navigates.
            // Otherwise we pick the first result card.
            const firstResult = await page.waitForSelector('a[href*="/maps/place/"], h1.DUwDvf', { timeout: 20000 }).catch(() => null);
            if (firstResult && (await firstResult.evaluate((el) => el.tagName)) === 'A') {
                await firstResult.click().catch(() => {});
            }
        } else {
            await page.goto(forceLocale(request.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
            await acceptConsent(page);
        }

        // Wait for the place-page side panel to hydrate. Maps renders a
        // shell at domcontentloaded and paints h1.DUwDvf a few seconds later.
        await page.waitForSelector('h1.DUwDvf', { timeout: 25000 }).catch(() => {});

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

        if (process.env.GRI_DEBUG_CARD) {
            const cardHtml = await page.$eval('div[data-review-id], div.jftiEf', (c) => c.outerHTML).catch(() => null);
            if (cardHtml) {
                const store = await Actor.openKeyValueStore();
                await store.setValue(`debug_card_${placeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`, cardHtml, { contentType: 'text/html' });
                log.info('Saved first-card HTML (GRI_DEBUG_CARD).');
            }
        }

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

        const seenReviewIds = new Set();
        for (const review of reviews) {
            const currentCount = pushedPerPlace.get(placeKey) ?? 0;
            if (currentCount >= maxReviews) break;
            if (review.reviewId && seenReviewIds.has(review.reviewId)) continue;
            if (review.reviewId) seenReviewIds.add(review.reviewId);
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
        // The place title h1 class has churned over time (DUwDvf -> LoqBob).
        // Try the known classes, ignore the search pane's "Results" heading,
        // then fall back to the document title ("<Name> - Google Maps").
        const titleEls = [...document.querySelectorAll('h1.DUwDvf, h1.LoqBob, h1[class*="DUwDvf"], h1[class*="LoqBob"], h1')];
        let name = null;
        for (const el of titleEls) {
            const t = el.textContent?.trim();
            if (t && !/^results$/i.test(t)) { name = t; break; }
        }
        if (!name) {
            const dt = (document.title || '').replace(/\s*-\s*Google Maps\s*$/i, '').trim();
            if (dt) name = dt;
        }

        // The rating block exposes one aria-label like "4.3 stars 14,013 Reviews".
        // That single attribute is the most stable source for both numbers.
        let ratingNum = null;
        let reviewCount = null;
        const labelled = [...document.querySelectorAll('[aria-label*="stars" i][aria-label*="review" i], [role="img"][aria-label*="star" i]')];
        for (const el of labelled) {
            const lbl = el.getAttribute('aria-label') || '';
            const m = lbl.match(/([\d.,]+)\s*stars?\s*([\d.,]+)?\s*reviews?/i);
            if (m) {
                ratingNum = parseFloat(m[1].replace(/,/g, ''));
                if (m[2]) reviewCount = Number(m[2].replace(/[^0-9]/g, '')) || null;
                break;
            }
        }
        if (ratingNum === null) {
            const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]')
                || document.querySelector('[class*="F7nice"] span');
            const ratingText = ratingEl?.textContent?.trim() ?? '';
            const n = parseFloat(ratingText.replace(',', '.'));
            ratingNum = Number.isFinite(n) ? n : null;
        }
        if (reviewCount === null) {
            const rc = document.querySelector('button[aria-label*="reviews" i]')?.getAttribute('aria-label')
                || document.querySelector('div.F7nice')?.textContent
                || '';
            const m = rc.match(/([\d,]+)\s*reviews?/i);
            if (m) reviewCount = Number(m[1].replace(/[^0-9]/g, '')) || null;
        }

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

async function acceptConsent(page) {
    // Google shows the consent wall on consent.google.com or as an
    // interstitial dialog. Click the "Accept all" button if present.
    const url = page.url();
    if (!/consent/.test(url) && !(await page.$('form[action*="consent"]').catch(() => null))) {
        return;
    }
    const candidates = [
        'button[aria-label*="Accept all" i]',
        'button:has-text("Accept all")',
        'button:has-text("I agree")',
        'button:has-text("Alle akzeptieren")',
        'form[action*="consent"] button[type="submit"]',
    ];
    for (const sel of candidates) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) {
            await btn.click().catch(() => {});
            await page.waitForTimeout(3000);
            return;
        }
    }
}

async function clickReviewsTab(page) {
    // If review cards are already in the DOM we are on the reviews feed.
    // Note: a plain div[role="feed"] is NOT a reliable signal because the
    // search-results list also uses role="feed" with zero review cards, which
    // previously made this function early-return and scroll the wrong panel.
    if (await page.$('div[data-review-id], div.jftiEf').catch(() => null)) return;

    // The reviews tab is a [role="tab"] button. Its aria-label in English is
    // "Reviews for <name>" on place pages. Wait up to 10s for it to render.
    const tab = await page.waitForSelector(
        'button[role="tab"][aria-label*="Reviews" i], button[jsaction*="pane.rating.moreReviews"], button[jsaction*="reviewChart.moreReviews"]',
        { timeout: 10000 },
    ).catch(() => null);

    if (!tab) return;
    await tab.click().catch(() => {});
    // Wait for actual review cards (not just any feed) to populate.
    await page.waitForSelector('div[data-review-id], div.jftiEf', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
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
    // The reviews scroll container is the role=feed that actually holds review
    // cards. Pick it by walking up from the first data-review-id card so we do
    // not accidentally scroll the search-results feed (also role=feed).
    const rawHandle = await page.evaluateHandle(() => {
        const card = document.querySelector('div[data-review-id], div.jftiEf');
        if (card) {
            let el = card.parentElement;
            while (el && el !== document.body) {
                if (el.getAttribute('role') === 'feed' || /Reviews of/i.test(el.getAttribute('aria-label') || '')) return el;
                el = el.parentElement;
            }
        }
        const feeds = [...document.querySelectorAll('div[role="feed"]')];
        // Prefer a feed that contains review cards over the search-results feed.
        return feeds.find((f) => f.querySelector('div[data-review-id], div.jftiEf'))
            || document.querySelector('div[aria-label*="Reviews of" i]')
            || feeds[0]
            || null;
    }).catch(() => null);
    const panelHandle = rawHandle ? rawHandle.asElement() : null;

    let stale = 0;
    let lastCount = 0;

    for (let i = 0; i < 80; i++) {
        await expandMoreButtons(page);
        const currentCount = await page.$$eval('div[data-review-id], div.jftiEf', (els) => els.length).catch(() => 0);
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

    return await page.$$eval('div[data-review-id], div.jftiEf', (cards) => {
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
            // Google dropped the data-review-id attribute from review cards.
            // Take it where present, else fall back to the jslog/jsdata token
            // some cards still carry, else null (deduped later by content).
            const reviewId = card.getAttribute('data-review-id')
                || card.querySelector('[data-review-id]')?.getAttribute('data-review-id')
                || (card.getAttribute('jsdata')?.match(/;([^;]+);/)?.[1] ?? null)
                || (card.getAttribute('jslog')?.match(/2:\[[^\]]*"([^"]{8,})"/)?.[1] ?? null);
            const nameEl = card.querySelector('div.d4r55, div[class*="d4r55"]');
            const profileEl = card.querySelector('button[data-review-id] img, a[class*="WNxzHc"] img');
            const reviewerReviewCountEl = card.querySelector('div.RfnDt, div[class*="RfnDt"]');
            // Photo buttons have aria-label like "Photo 1" or "Review photo".
            // Exclude the reviewer-profile-link button whose aria-label is
            // "Photo of <name>" — that wraps the profile avatar, not a review photo.
            const photos = Array.from(card.querySelectorAll('button[aria-label*="Photo" i]'))
                .filter((btn) => !/^Photo of /i.test(btn.getAttribute('aria-label') || ''))
                .map((btn) => btn.querySelector('img')?.getAttribute('src'))
                .filter(Boolean)
                .slice(0, 20);
            const ownerResponse = parseOwnerResponse(card);

            const rating = parseStars(card);
            const text = parseText(card);
            const reviewerName = nameEl?.textContent?.trim() ?? null;
            const writtenDate = parseDate(card);
            // Fall back to a content fingerprint so cards with no id still dedupe.
            const stableId = reviewId
                || (reviewerName || text || writtenDate
                    ? `syn:${(reviewerName || '').slice(0, 40)}|${writtenDate || ''}|${(text || '').slice(0, 40)}`
                    : null);

            return {
                reviewId: stableId,
                rating,
                text,
                reviewerName,
                reviewerProfileImage: profileEl?.getAttribute('src') ?? null,
                reviewerReviewCount: reviewerReviewCountEl?.textContent?.trim() ?? null,
                writtenDate,
                photoUrls: photos,
                language: null,
                hasOwnerResponse: !!ownerResponse.text,
                ownerResponseText: ownerResponse.text,
                ownerResponseDate: ownerResponse.date,
            };
        }).filter((r) => r.reviewId && (r.rating !== null || r.text || r.reviewerName));
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
