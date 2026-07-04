// Google Maps Scraper
// Extracts places, reviews, images, and contact info from Google Maps.
//
// Flow:
//   1. Build initial requests from searchQueries + startUrls
//   2. For a search request: scroll the feed panel, collect place URLs, enqueue them
//   3. For a place request: extract business metadata, optional reviews, images, website enrichment
//   4. Push one row per place with dedupeKey = place cid (from URL)
//
// Google Maps relies heavily on dynamic DOM. Selectors below use both
// data attributes and aria labels for resilience across A/B buckets.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_PLACES = 2;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    startUrls = [],
    language = 'en',
    maxPlacesPerQuery = 10,
    maxPlacesTotal = 50,
    scrapeReviews = true,
    maxReviewsPerPlace = 5,
    scrapeImages = false,
    maxImagesPerPlace = 5,
    enrichFromWebsite = false,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const queries = Array.isArray(searchQueries)
    ? searchQueries.map((q) => String(q).trim()).filter(Boolean)
    : [];

const directUrls = Array.isArray(startUrls)
    ? startUrls.map((u) => (typeof u === 'string' ? u : u?.url)).filter(Boolean)
    : [];

if (queries.length === 0 && directUrls.length === 0) {
    queries.push('coffee shops in Austin TX');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('google-maps-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-ids')) || [];
    for (const id of prev) seen.add(id);
}

const initialRequests = [];
for (const q of queries) {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}/?hl=${encodeURIComponent(language)}`;
    initialRequests.push({ url, userData: { type: 'search', query: q, pushedForQuery: 0 }, uniqueKey: `search:${q}` });
}
for (const url of directUrls) {
    initialRequests.push({ url, userData: { type: 'place' } });
}

let placesPushed = 0;
// Wall-clock budget: exit cleanly with partial results before the platform hard-kills
// the run (TIMED-OUT = a failed run). Derive the deadline from the run's ACTUAL timeout
// (ACTOR_TIMEOUT_AT) instead of assuming 3600s -- runs with a shorter timeout (e.g. 720s)
// were failing because a fixed 3300s budget never fired. Leave a margin big enough for
// one in-flight request to finish.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 300,
    maxRequestRetries: 2,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 20, sessionOptions: { maxUsageCount: 25 } },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                operatingSystems: ['macos', 'windows'],
            },
        },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    async requestHandler({ page, request, crawler: c }) {
        if (placesPushed >= maxPlacesTotal) {
            log.info(`Cap reached (${placesPushed}/${maxPlacesTotal}), skipping ${request.url}`);
            return;
        }
        if (Date.now() > SOFT_DEADLINE_AT) {
            log.warning('Run-time budget reached; stopping crawler and finishing with partial results.');
            crawler.stop();
            return;
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);

        const { type } = request.userData;

        if (type === 'search') {
            await handleSearch(page, request, c);
        } else {
            await handlePlace(page, request);
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && placesPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen]);
}

log.info(`Run complete. Pushed ${placesPushed} places.`);
await Actor.exit();

async function dismissConsent(page) {
    const selectors = [
        'button[aria-label*="Accept all"]',
        'button[aria-label*="Reject all"]',
        'button:has-text("Accept all")',
        'button:has-text("I agree")',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(1200);
                return;
            }
        } catch {}
    }
}

async function handleSearch(page, request, crawler) {
    const { query } = request.userData;
    log.info(`Search: "${query}"`);

    const feedSel = 'div[role="feed"]';
    try {
        await page.waitForSelector(feedSel, { timeout: 20000 });
    } catch {
        const title = await page.title().catch(() => '');
        if (/consent|sorry|unusual traffic/i.test(title)) {
            throw new Error(`Blocked on search: ${title}`);
        }
        const placeLink = await page.$('a[href*="/maps/place/"]');
        if (placeLink) {
            log.info(`Search redirected to single place for "${query}"`);
            await crawler.addRequests([{ url: page.url(), userData: { type: 'place' } }]);
            return;
        }
        log.warning(`No feed panel for "${query}"`);
        return;
    }

    let prev = 0;
    const cap = Math.min(maxPlacesPerQuery, maxPlacesTotal - placesPushed);
    const maxScrolls = Math.max(3, Math.ceil(cap / 5) + 2);

    for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate((sel) => {
            const feed = document.querySelector(sel);
            if (feed) feed.scrollTo(0, feed.scrollHeight);
        }, feedSel);
        await page.waitForTimeout(1600);
        const count = await page.evaluate(
            (sel) => document.querySelectorAll(`${sel} a[href*="/maps/place/"]`).length,
            feedSel,
        );
        if (count === prev && count > 0) break;
        prev = count;
        if (count >= cap) break;
    }

    const urls = await page.evaluate(
        ({ sel, cap }) => {
            const anchors = document.querySelectorAll(`${sel} a[href*="/maps/place/"]`);
            const out = [];
            const s = new Set();
            for (const a of anchors) {
                const href = a.href;
                if (!s.has(href)) {
                    s.add(href);
                    out.push(href);
                    if (out.length >= cap) break;
                }
            }
            return out;
        },
        { sel: feedSel, cap },
    );

    log.info(`"${query}" -> ${urls.length} place URLs`);

    for (const url of urls) {
        await crawler.addRequests([{ url, userData: { type: 'place', query } }]);
    }
}

async function handlePlace(page, request) {
    try {
        await page.waitForSelector('h1', { timeout: 20000 });
    } catch {
        log.warning(`No h1 on place page: ${request.url}`);
        return;
    }
    await page.waitForTimeout(800);

    const core = await page.evaluate(() => {
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const name = text('h1');

        const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
        const ratingCountEl = document.querySelector('div.F7nice span[aria-label*="review"]');
        const rating = ratingEl ? parseFloat(ratingEl.textContent.replace(',', '.')) : null;
        const reviewCount = ratingCountEl
            ? parseInt(ratingCountEl.textContent.replace(/[^\d]/g, ''), 10) || null
            : null;

        let category = null;
        let priceLevel = null;
        const catBtn = document.querySelector('button[jsaction*="category"]');
        if (catBtn) category = catBtn.textContent?.trim() || null;
        const priceEl = document.querySelector('span[aria-label^="Price:"]');
        if (priceEl) priceLevel = priceEl.getAttribute('aria-label')?.replace('Price: ', '') || null;

        const extract = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return el.getAttribute('aria-label') || el.textContent?.trim() || null;
        };
        const stripPrefix = (v, p) => (v && v.startsWith(p) ? v.slice(p.length).trim() : v);

        const address = stripPrefix(extract('button[data-item-id="address"]'), 'Address:');
        const phoneRaw = extract('button[data-item-id^="phone:tel:"]');
        const phone = stripPrefix(phoneRaw, 'Phone:');
        const websiteEl = document.querySelector('a[data-item-id="authority"]');
        const website = websiteEl?.getAttribute('href') || null;
        const plusCode = stripPrefix(extract('button[data-item-id="oloc"]'), 'Plus code:');

        const hoursBtn = document.querySelector('div[jslog*="metadata"] [aria-label*="Hours"]');
        let hoursRaw = hoursBtn?.getAttribute('aria-label') || null;
        let openState = null;
        if (hoursRaw) {
            const m = hoursRaw.match(/^(Open|Closed|Closes|Opens)[^.]*/);
            if (m) openState = m[0];
        }

        let coords = null;
        const href = window.location.href;
        const at = href.match(/@(-?[\d.]+),(-?[\d.]+)/);
        const bang = href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
        if (at) coords = { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
        else if (bang) coords = { lat: parseFloat(bang[1]), lng: parseFloat(bang[2]) };

        let cid = null;
        const cidMatch = window.location.href.match(/0x[a-f\d]+:0x[a-f\d]+/i);
        if (cidMatch) cid = cidMatch[0];

        return { name, rating, reviewCount, category, priceLevel, address, phone, website, plusCode, hoursRaw, openState, coords, cid };
    });

    const dedupeKey = core.cid || request.url;
    if (dedupe && seen.has(dedupeKey)) {
        log.info(`Skipped duplicate: ${core.name || dedupeKey}`);
        return;
    }
    seen.add(dedupeKey);

    const hoursList = await extractHours(page);

    let reviews = [];
    if (scrapeReviews && maxReviewsPerPlace > 0) {
        reviews = await extractReviews(page, maxReviewsPerPlace).catch((err) => {
            log.warning(`Reviews failed: ${err.message}`);
            return [];
        });
    }

    let images = [];
    if (scrapeImages && maxImagesPerPlace > 0) {
        images = await extractImages(page, maxImagesPerPlace).catch(() => []);
    }

    let enrichment = null;
    if (enrichFromWebsite && core.website) {
        enrichment = await enrichWebsite(page, core.website).catch(() => null);
    }

    const row = {
        source: 'google_maps',
        placeId: core.cid,
        name: core.name,
        category: core.category,
        rating: core.rating,
        reviewCount: core.reviewCount,
        address: core.address,
        phone: core.phone,
        website: core.website,
        priceLevel: core.priceLevel,
        plusCode: core.plusCode,
        latitude: core.coords?.lat ?? null,
        longitude: core.coords?.lng ?? null,
        openState: core.openState,
        hoursRaw: core.hoursRaw,
        hours: hoursList,
        reviews,
        images,
        contacts: enrichment?.persons || [],
        emails: enrichment?.emails || [],
        url: request.url,
        searchQuery: request.userData.query || null,
        dedupeKey,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    placesPushed++;

    if (placesPushed > FREE_TIER_PLACES) {
        await Actor.charge({ eventName: 'place_row' }).catch(() => {});
    }

    log.info(`[${placesPushed}/${maxPlacesTotal}] ${core.name} | ${reviews.length} reviews | ${images.length} images`);
}

async function extractHours(page) {
    try {
        const btn = await page.$('button[data-item-id="oh"], [aria-label*="Hours"]');
        if (!btn) return [];
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
        const rows = await page.$$eval('table tr', (trs) =>
            trs
                .map((tr) => {
                    const cells = tr.querySelectorAll('td, th');
                    if (cells.length < 2) return null;
                    const day = cells[0]?.textContent?.trim();
                    const val = cells[1]?.textContent?.trim();
                    if (!day || !val) return null;
                    return { day, hours: val };
                })
                .filter(Boolean),
        );
        return rows.slice(0, 7);
    } catch {
        return [];
    }
}

async function extractReviews(page, cap) {
    const tab = await page.$('button[aria-label*="Reviews for"], button[role="tab"][aria-label*="Reviews"]');
    if (tab) {
        await tab.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1800);
    }

    const panelSel = 'div[aria-label*="Reviews"][tabindex="-1"], div.m6QErb[aria-label]';

    const maxScrolls = Math.max(3, Math.ceil(cap / 5));
    for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate((sel) => {
            const nodes = document.querySelectorAll(sel);
            const panel = Array.from(nodes).find((n) => n.scrollHeight > n.clientHeight);
            if (panel) panel.scrollTo(0, panel.scrollHeight);
        }, panelSel);
        await page.waitForTimeout(1200);
    }

    await page.$$eval('button[aria-label*="See more"], button[jsaction*="review.expandReview"]', (btns) =>
        btns.forEach((b) => b.click?.()),
    ).catch(() => {});
    await page.waitForTimeout(600);

    const data = await page.evaluate((limit) => {
        const cards = document.querySelectorAll('div[data-review-id], div[jslog*="review"]');
        const out = [];
        const seenIds = new Set();
        for (const card of cards) {
            if (out.length >= limit) break;
            const reviewId = card.getAttribute('data-review-id');
            if (reviewId && seenIds.has(reviewId)) continue;
            if (reviewId) seenIds.add(reviewId);
            const nameEl = card.querySelector('.d4r55, div[class*="fontTitle"]');
            const author = nameEl?.textContent?.trim() || null;
            const authorLink = card.querySelector('button[data-href*="/maps/contrib/"], a[href*="/maps/contrib/"]');
            const authorUrl = authorLink?.getAttribute('data-href') || authorLink?.getAttribute('href') || null;
            const ratingEl = card.querySelector('span[role="img"][aria-label*="star"]');
            const ratingLabel = ratingEl?.getAttribute('aria-label') || '';
            const rating = parseFloat(ratingLabel.match(/([\d.]+)/)?.[1] || '') || null;
            const dateEl = card.querySelector('.rsqaWe, span[class*="dehysf"]');
            const relativeDate = dateEl?.textContent?.trim() || null;
            const textEl = card.querySelector('.wiI7pd, span[class*="review-full-text"]');
            const text = textEl?.textContent?.trim() || null;
            const reviewerMetaEl = card.querySelector('.RfnDt, div[class*="WNxzHc"]');
            const reviewerMeta = reviewerMetaEl?.textContent?.trim() || null;
            out.push({ reviewId, author, authorUrl, rating, relativeDate, text, reviewerMeta });
        }
        return out;
    }, cap);

    return data;
}

async function extractImages(page, cap) {
    try {
        const photoTab = await page.$('button[aria-label*="Photos"], button[jsaction*="pane.heroHeaderImage"]');
        if (photoTab) {
            await photoTab.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(1500);
        }
        const urls = await page.evaluate((limit) => {
            const imgs = document.querySelectorAll('img[src*="googleusercontent"], a[data-photo-index] img');
            const out = [];
            const seen = new Set();
            for (const img of imgs) {
                const src = img.src?.replace(/=w\d+-h\d+.*/, '=w1600-h1200') || null;
                if (src && !seen.has(src)) {
                    seen.add(src);
                    out.push(src);
                    if (out.length >= limit) break;
                }
            }
            return out;
        }, cap);
        return urls;
    } catch {
        return [];
    }
}

async function enrichWebsite(page, website) {
    const ctx = page.context();
    const p = await ctx.newPage();
    try {
        await p.goto(website, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await p.waitForTimeout(1500);

        let html = await p.content();

        const contactLink = await p.$('a[href*="contact" i], a[href*="about" i], a[href*="team" i]');
        if (contactLink) {
            const href = await contactLink.getAttribute('href').catch(() => null);
            if (href) {
                const abs = new URL(href, p.url()).toString();
                try {
                    await p.goto(abs, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await p.waitForTimeout(1200);
                    html += '\n' + (await p.content());
                } catch {}
            }
        }

        const emailRegex = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
        const emails = [...new Set(html.match(emailRegex) || [])]
            .map((e) => e.toLowerCase())
            .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e))
            .filter((e) => !/sentry|wixpress|example|noreply/i.test(e))
            .slice(0, 5);

        const titleWords = 'CEO|Founder|Co Founder|Cofounder|Owner|Manager|Director|President|Partner|Head of [A-Za-z ]+|Chief [A-Za-z ]+ Officer';
        const personRegex = new RegExp(`([A-Z][a-z]+ (?:[A-Z]\\. )?[A-Z][a-z]+)[\\s,<>/\\|\\-]{0,40}?(${titleWords})`, 'g');
        const persons = [];
        const seenNames = new Set();
        for (const m of html.matchAll(personRegex)) {
            const name = m[1];
            const title = m[2];
            if (!seenNames.has(name)) {
                seenNames.add(name);
                persons.push({ fullName: name, jobTitle: title });
                if (persons.length >= 5) break;
            }
        }

        return { emails, persons };
    } finally {
        await p.close().catch(() => {});
    }
}
