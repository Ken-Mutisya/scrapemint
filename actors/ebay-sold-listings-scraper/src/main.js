// Mercari Sold Listings Scraper (eBay Alternative Comp Tracker)
//
// Strategy
// --------
// Mercari publishes sold-listing search results at:
//   https://www.mercari.com/search/?keyword=<q>&status=sold_out&sortBy=2
// Filter `status=sold_out` returns items in the SOLD state. Mercari is a
// fixed-price marketplace, so the listed price equals the sale price
// (no auction Best Offer ambiguity). The site is a React SPA backed by an
// internal JSON API; we render it with Playwright and walk the rendered
// result cards.
//
// Each result card carries a link to `/item/<itemId>` (or `/us/item/<id>`
// in newer routing). We anchor on that link and pull title, price,
// condition, shipping, seller, and image URL. Pagination is handled by
// scrolling the infinite-scroll list until we have enough items.
//
// Pay-per-event:
//   sold_listing_row ($0.005) charged when a row is pushed.
//   First 25 sold listing rows per run are free.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 25;
const BASE = 'https://www.mercari.com';

const CONDITION_LABEL_MAP = {
    'new': 'new',
    'brand new': 'new',
    'like new': 'like_new',
    'good': 'good',
    'fair': 'fair',
    'poor': 'poor',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    conditions = [],
    minPrice = 0,
    maxPrice = 0,
    maxListingsPerSource = 60,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
const cleanConditions = new Set((Array.isArray(conditions) ? conditions : [conditions])
    .map((c) => String(c || '').trim().toLowerCase()).filter(Boolean));

if (cleanQueries.length === 0) {
    log.warning('Provide at least one keyword in `queries`.');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const initialRequests = cleanQueries.map((q) => ({
    url: buildSearchUrl({ query: q }),
    userData: { type: 'sold_serp', sourceKey: `q:${q}`, query: q },
    uniqueKey: `mercari:${q}`,
}));

const seenItemIds = new Set();
const sourcePushed = new Map();
let totalRowsPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(10, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    maxRequestRetries: 4,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 122 }],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos'],
                locales: ['en-US', 'en'],
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
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            });
        },
    ],
    async requestHandler(ctx) {
        if (ctx.request.userData.type === 'sold_serp') return handleSerp(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Sources: ${initialRequests.length}. Sold listings pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- Handler ----------

async function handleSerp({ page, request }) {
    const { sourceKey, query } = request.userData;
    log.info(`Mercari sold SERP ${sourceKey}: ${request.url}`);

    await dismissBanners(page);

    try {
        await page.waitForSelector('[data-testid="ItemCell"], [data-testid="Item"], a[href*="/item/"]', { timeout: 20000 });
    } catch {
        log.warning(`${sourceKey}: result list did not render in time.`);
    }

    // Mercari uses infinite scroll. Scroll until we have enough cards or stop seeing new ones.
    let lastCount = 0;
    let stagnantRounds = 0;
    const target = maxListingsPerSource;
    for (let i = 0; i < 25; i += 1) {
        const count = await page.evaluate(() => document.querySelectorAll('a[href*="/item/"]').length).catch(() => 0);
        if (count >= target * 1.3) break;
        if (count === lastCount) {
            stagnantRounds += 1;
            if (stagnantRounds >= 3) break;
        } else {
            stagnantRounds = 0;
            lastCount = count;
        }
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await page.waitForTimeout(900);
    }

    const cards = await extractSoldCards(page);
    log.info(`${sourceKey}: parsed ${cards.length} candidate cards.`);

    let pushedThisQuery = 0;
    for (const card of cards) {
        if (pushedThisQuery >= target) break;
        if (!card.itemId || seenItemIds.has(card.itemId)) continue;

        if (minPrice > 0 && card.soldPrice !== null && card.soldPrice < minPrice) continue;
        if (maxPrice > 0 && card.soldPrice !== null && card.soldPrice > maxPrice) continue;

        seenItemIds.add(card.itemId);
        const row = buildRow(card, query);
        flushRow(row);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisQuery += 1;
    }

    log.info(`${sourceKey}: pushed ${pushedThisQuery} sold listings.`);
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const sel = [
                'button[aria-label*="accept" i]',
                'button[aria-label*="agree" i]',
                'button[data-testid*="cookie" i]',
                '[class*="cookie"] button',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el) { el.click(); break; }
            }
        });
        await page.waitForTimeout(400);
    } catch {}
}

async function extractSoldCards(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const out = [];

        // Mercari renders each result as <div data-testid="ItemContainer" data-productid="m...">.
        const cards = document.querySelectorAll('[data-testid="ItemContainer"][data-productid]');
        for (const card of cards) {
            const itemId = card.getAttribute('data-productid');
            if (!itemId) continue;

            // Link wraps the card.
            const link = card.closest('a[href*="/item/"]') || card.querySelector('a[href*="/item/"]');
            const href = link?.getAttribute('href') || `/us/item/${itemId}/`;
            const url = href.startsWith('http') ? href.split('?')[0] : `https://www.mercari.com${href.split('?')[0]}`;

            const title = text(card.querySelector('[data-testid="ItemName"]')) || null;

            const priceText = text(card.querySelector('[data-testid="ProductThumbItemPrice"]'));
            const soldPrice = parsePrice(priceText);
            const currency = priceText && priceText.includes('$') ? 'USD' : null;

            // Mercari exposes some structured attributes on the container.
            const brand = card.getAttribute('data-brand') || null;
            const size = card.getAttribute('data-size') || null;
            const isOnSale = card.getAttribute('data-is-on-sale') === 'true';

            // Image.
            const img = card.querySelector('img');
            const imageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || null;

            out.push({
                itemId,
                url,
                title,
                soldPrice,
                currency,
                brand,
                size,
                isDiscounted: isOnSale,
                imageUrl,
            });
        }

        return out;

        function parsePrice(t) {
            if (!t) return null;
            const m = String(t).match(/-?[\d,]+(?:\.\d+)?/);
            if (!m) return null;
            const n = parseFloat(m[0].replace(/,/g, ''));
            return Number.isFinite(n) ? n : null;
        }
    });
}

// ---------- Routing ----------

function buildRow(card, query) {
    return {
        itemId: card.itemId,
        url: card.url,
        title: card.title,
        soldPrice: card.soldPrice,
        currency: card.currency || 'USD',
        brand: card.brand,
        size: card.size,
        isDiscounted: !!card.isDiscounted,
        imageUrl: card.imageUrl,
        marketplace: 'mercari',
        searchQuery: query,
        scrapedAt: null,
    };
}

function flushRow(row) {
    row.scrapedAt = new Date().toISOString();
    Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        Actor.charge({ eventName: 'sold_listing_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

// ---------- URL ----------

function buildSearchUrl({ query }) {
    const params = new URLSearchParams();
    params.set('keyword', query);
    params.set('status', 'sold_out');
    params.set('sortBy', '2');
    return `${BASE}/search/?${params.toString()}`;
}
