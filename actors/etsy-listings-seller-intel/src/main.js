// Etsy Listings & Seller Intel Scraper (No Login)
//
// Strategy
// --------
// Etsy renders search results and shop pages publicly. Each listing card
// carries a stable `data-listing-id` attribute that survives most React
// reflows. Each shop page exposes total sales, opened year, location,
// rating, review count, and star seller status to anonymous visitors.
//
// We accept search keywords and shop URLs as inputs. For each keyword we
// paginate the search SERP up to maxListingsPerSource. For each shop we
// paginate the shop's listing grid up to the same cap. When
// includeShopIntel is on we fetch each unique shop page once to enrich
// every listing row from that shop.
//
// Pay-per-event:
//   listing_row ($0.003) charged when a listing row is pushed.
//   First 30 listing rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 30;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    shopUrls = [],
    maxListingsPerSource = 60,
    country = 'US',
    includeShopIntel = true,
    concurrency = 5,
    proxyConfiguration: proxyInput,
} = input;

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
const cleanShops = (Array.isArray(shopUrls) ? shopUrls : [shopUrls])
    .map((u) => parseShopInput(String(u || '').trim())).filter(Boolean);

if (cleanQueries.length === 0 && cleanShops.length === 0) {
    log.warning('Provide at least one keyword in `queries` or one shop in `shopUrls`. Examples: queries=["leather wallet"], shopUrls=["https://www.etsy.com/shop/Beardbrand"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const baseHost = country === 'GB' ? 'www.etsy.com' : 'www.etsy.com';

const initialRequests = [];
for (const q of cleanQueries) {
    initialRequests.push({
        url: buildSearchUrl({ q, country }),
        userData: { type: 'search', sourceKey: `q:${q}`, query: q, page: 1 },
        uniqueKey: `search:${q}:1`,
    });
}
for (const shop of cleanShops) {
    initialRequests.push({
        url: buildShopListingsUrl({ shopName: shop.name, country }),
        userData: { type: 'shop_grid', sourceKey: `shop:${shop.name}`, shopName: shop.name, page: 1 },
        uniqueKey: `shop_grid:${shop.name}:1`,
    });
}

const seenListingIds = new Set();
const sourcePushed = new Map(); // sourceKey -> count
let totalRowsPushed = 0;
const shopIntelCache = new Map(); // shopName -> { ...intel } | 'pending'
const pendingListingsByShop = new Map(); // shopName -> [{ row, sourceKey }]

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(15, Number(concurrency) || 5)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 8, maxErrorScore: 1 },
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
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'shop_grid') return handleShopGrid(ctx);
        if (t === 'shop_intel') return handleShopIntel(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

// Drain any listings that never got their shop intel (because shop fetch failed).
for (const [shopName, pending] of pendingListingsByShop.entries()) {
    for (const { row } of pending) {
        flushRow(row);
    }
    pendingListingsByShop.delete(shopName);
}

log.info(`Run complete. Sources: ${initialRequests.length}. Listings pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    await dismissBanners(page);
    const { sourceKey, query, page: pageNum } = request.userData;
    log.info(`Search ${sourceKey} page ${pageNum}: ${request.url}`);

    try {
        await page.waitForSelector('[data-listing-id], [data-search-results], .listing-link, ol.tab-reorder', { timeout: 12000 });
    } catch {
        log.warning(`Search ${sourceKey}: no listing grid found, page may be gated.`);
    }

    const cards = await extractListingCards(page);
    let pushedThisPage = 0;

    for (const card of cards) {
        if (!card.listingId || seenListingIds.has(card.listingId)) continue;
        if ((sourcePushed.get(sourceKey) || 0) >= maxListingsPerSource) break;
        seenListingIds.add(card.listingId);

        const row = buildRow(card, { sourceType: 'search', searchQuery: query, country });
        await routeRow(row, c);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisPage += 1;
    }

    log.info(`Search ${sourceKey} page ${pageNum}: collected ${pushedThisPage} new listings (source total ${sourcePushed.get(sourceKey) || 0}).`);

    if ((sourcePushed.get(sourceKey) || 0) < maxListingsPerSource && pushedThisPage > 0) {
        const next = pageNum + 1;
        const nextUrl = buildSearchUrl({ q: query, country, page: next });
        await c.addRequests([{
            url: nextUrl,
            userData: { type: 'search', sourceKey, query, page: next },
            uniqueKey: `search:${query}:${next}`,
        }]);
    }
}

async function handleShopGrid({ page, request, crawler: c }) {
    await dismissBanners(page);
    const { sourceKey, shopName, page: pageNum } = request.userData;
    log.info(`Shop ${shopName} grid page ${pageNum}: ${request.url}`);

    try {
        await page.waitForSelector('[data-listing-id], [data-shop-grid], a.listing-link', { timeout: 12000 });
    } catch {
        log.warning(`Shop ${shopName}: no grid found, may be inactive or sold-out.`);
    }

    const cards = await extractListingCards(page);
    let pushedThisPage = 0;

    for (const card of cards) {
        if (!card.listingId || seenListingIds.has(card.listingId)) continue;
        if ((sourcePushed.get(sourceKey) || 0) >= maxListingsPerSource) break;
        seenListingIds.add(card.listingId);

        // Always tag with the shop we're scraping from.
        if (!card.shopName) card.shopName = shopName;

        const row = buildRow(card, { sourceType: 'shop', shopName, country });
        await routeRow(row, c);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisPage += 1;
    }

    log.info(`Shop ${shopName} grid page ${pageNum}: collected ${pushedThisPage} new listings (shop total ${sourcePushed.get(sourceKey) || 0}).`);

    if ((sourcePushed.get(sourceKey) || 0) < maxListingsPerSource && pushedThisPage > 0) {
        const next = pageNum + 1;
        const nextUrl = buildShopListingsUrl({ shopName, country, page: next });
        await c.addRequests([{
            url: nextUrl,
            userData: { type: 'shop_grid', sourceKey, shopName, page: next },
            uniqueKey: `shop_grid:${shopName}:${next}`,
        }]);
    }
}

async function handleShopIntel({ page, request }) {
    await dismissBanners(page);
    const { shopName } = request.userData;

    try {
        await page.waitForSelector('main, h1, [data-shop-name], .shop-name-and-title-container-icon', { timeout: 10000 });
    } catch {}

    const intel = await extractShopIntel(page, shopName);
    shopIntelCache.set(shopName, intel);

    const pending = pendingListingsByShop.get(shopName) || [];
    pendingListingsByShop.delete(shopName);
    for (const { row } of pending) {
        Object.assign(row, projectShopIntel(intel));
        flushRow(row);
    }
    log.info(`Shop intel ${shopName}: rating=${intel.rating ?? '?'}, sales=${intel.totalSales ?? '?'}, opened=${intel.openedYear ?? '?'}. Drained ${pending.length} listings.`);
}

// ---------- Routing ----------

async function routeRow(row, crawler) {
    if (!includeShopIntel || !row.shopName) {
        flushRow(row);
        return;
    }

    const cached = shopIntelCache.get(row.shopName);
    if (cached && cached !== 'pending') {
        Object.assign(row, projectShopIntel(cached));
        flushRow(row);
        return;
    }

    // Queue the listing pending shop intel; only enqueue one fetch per shop.
    if (!pendingListingsByShop.has(row.shopName)) pendingListingsByShop.set(row.shopName, []);
    pendingListingsByShop.get(row.shopName).push({ row });

    if (!cached) {
        shopIntelCache.set(row.shopName, 'pending');
        await crawler.addRequests([{
            url: buildShopHomeUrl({ shopName: row.shopName, country: row.country }),
            userData: { type: 'shop_intel', shopName: row.shopName },
            uniqueKey: `shop_intel:${row.shopName}`,
        }]);
    }
}

function flushRow(row) {
    row.scrapedAt = new Date().toISOString();
    Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        Actor.charge({ eventName: 'listing_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

function buildRow(card, ctx) {
    return {
        listingId: card.listingId,
        url: card.url || `https://${baseHost}/listing/${card.listingId}/`,
        title: card.title || null,
        priceCurrent: card.priceCurrent ?? null,
        priceOriginal: card.priceOriginal ?? null,
        currency: card.currency || null,
        salePercent: card.salePercent ?? null,
        rating: card.rating ?? null,
        reviewCount: card.reviewCount ?? null,
        favorites: card.favorites ?? null,
        isBestseller: !!card.isBestseller,
        isStarSeller: !!card.isStarSeller,
        freeShipping: !!card.freeShipping,
        shopName: card.shopName || null,
        shopUrl: card.shopName ? `https://${baseHost}/shop/${card.shopName}` : null,
        imageUrl: card.imageUrl || null,
        // Shop intel fields (populated later when includeShopIntel is on).
        shopRating: null,
        shopReviewCount: null,
        shopTotalSales: null,
        shopOpenedYear: null,
        shopLocation: null,
        shopIsStarSeller: null,
        shopAnnouncement: null,
        // Source tracking.
        sourceType: ctx.sourceType,
        searchQuery: ctx.searchQuery || null,
        sourceShop: ctx.shopName || null,
        country: ctx.country,
        scrapedAt: null,
    };
}

function projectShopIntel(intel) {
    return {
        shopRating: intel.rating ?? null,
        shopReviewCount: intel.reviewCount ?? null,
        shopTotalSales: intel.totalSales ?? null,
        shopOpenedYear: intel.openedYear ?? null,
        shopLocation: intel.location ?? null,
        shopIsStarSeller: intel.isStarSeller ?? null,
        shopAnnouncement: intel.announcement ?? null,
    };
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const close = document.querySelector('button[data-gdpr-single-choice-accept], button[aria-label*="accept" i], #gdpr-single-choice-overlay button');
            if (close) close.click();
        });
        await page.waitForTimeout(400);
    } catch {}
}

async function extractListingCards(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const out = [];
        const seen = new Set();

        const cards = [...document.querySelectorAll('[data-listing-id], a.listing-link[href*="/listing/"]')];
        for (const el of cards) {
            const card = el.closest('[data-listing-id]') || el;
            let listingId = card.getAttribute('data-listing-id');
            if (!listingId) {
                const link = card.querySelector('a[href*="/listing/"]') || (el.tagName === 'A' ? el : null);
                const m = link?.getAttribute('href')?.match(/\/listing\/(\d+)/);
                if (m) listingId = m[1];
            }
            if (!listingId || seen.has(listingId)) continue;
            seen.add(listingId);

            const link = card.querySelector('a[href*="/listing/"]') || (el.tagName === 'A' ? el : null);
            const url = link ? (link.href || link.getAttribute('href')) : null;

            const title = (link?.getAttribute('title') || '').trim()
                || text(card.querySelector('h2, h3, [data-listing-title]'));

            const cardText = card.textContent || '';

            // Price parsing. Etsy renders sale + original prices in adjacent spans.
            const priceCurrent = parsePriceNumber(text(card.querySelector('.currency-value, [data-buy-box-region="price"] .currency-value')))
                ?? firstPriceNumber(cardText);
            const currency = (text(card.querySelector('.currency-symbol')) || guessCurrencyFromText(cardText) || null);
            const priceOriginal = parsePriceNumber(text(card.querySelector('.search-collage-promotion-price-original .currency-value, .listing-page-strikethrough-price .currency-value, .wt-text-strikethrough .currency-value')));
            let salePercent = null;
            const saleMatch = cardText.match(/(\d{1,2})%\s*off/i);
            if (saleMatch) salePercent = parseInt(saleMatch[1], 10);

            // Rating + review count.
            let rating = null;
            const ratingEl = card.querySelector('.search-result-rating, [aria-label*="out of 5" i], input[name="rating"]');
            if (ratingEl) {
                const aria = ratingEl.getAttribute('aria-label') || '';
                const m = aria.match(/([\d.]+)\s*out of/i);
                if (m) rating = parseFloat(m[1]);
            }
            if (rating === null) {
                const m = cardText.match(/([\d.]+)\s*out of\s*5\s*stars?/i);
                if (m) rating = parseFloat(m[1]);
            }
            let reviewCount = null;
            const rcMatch = cardText.match(/\(([\d,kKmM.]+)\)/);
            if (rcMatch) reviewCount = parseCountToken(rcMatch[1]);

            // Favorites (people-have-favorited badge).
            let favorites = null;
            const favMatch = cardText.match(/([\d,]+)\s*favorites?/i)
                || cardText.match(/([\d,kKmM.]+)\s*people\s*want\s*this/i);
            if (favMatch) favorites = parseCountToken(favMatch[1]);

            // Bestseller / star seller / free shipping flags.
            const isBestseller = /bestseller/i.test(cardText);
            const isStarSeller = /star seller/i.test(cardText);
            const freeShipping = /free shipping/i.test(cardText) || /free postage/i.test(cardText);

            // Shop name.
            let shopName = null;
            const shopLink = card.querySelector('a[href*="/shop/"]');
            if (shopLink) {
                const m = shopLink.getAttribute('href').match(/\/shop\/([^/?]+)/);
                if (m) shopName = decodeURIComponent(m[1]);
            }
            if (!shopName) {
                const m = cardText.match(/(?:Ad by|by)\s+([A-Za-z0-9_\-]{2,32})/);
                if (m) shopName = m[1];
            }

            // Image URL.
            const img = card.querySelector('img');
            const imageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || null;

            out.push({
                listingId,
                url: url ? (url.startsWith('http') ? url.split('?')[0] : `https://www.etsy.com${url.split('?')[0]}`) : null,
                title,
                priceCurrent,
                priceOriginal,
                currency,
                salePercent,
                rating,
                reviewCount,
                favorites,
                isBestseller,
                isStarSeller,
                freeShipping,
                shopName,
                imageUrl,
            });
        }

        return out;

        function parsePriceNumber(t) {
            if (!t) return null;
            const cleaned = String(t).replace(/[^\d.,]/g, '').replace(/,/g, '');
            const n = parseFloat(cleaned);
            return Number.isFinite(n) ? n : null;
        }
        function firstPriceNumber(t) {
            if (!t) return null;
            const m = t.match(/[$£€¥₹]\s*([\d,]+(?:\.\d{2})?)/);
            if (!m) return null;
            return parseFloat(m[1].replace(/,/g, ''));
        }
        function guessCurrencyFromText(t) {
            if (/\$/.test(t)) return 'USD';
            if (/£/.test(t)) return 'GBP';
            if (/€/.test(t)) return 'EUR';
            if (/¥/.test(t)) return 'JPY';
            if (/₹/.test(t)) return 'INR';
            return null;
        }
        function parseCountToken(s) {
            if (!s) return null;
            const t = String(s).toLowerCase().replace(/,/g, '');
            const m = t.match(/^([\d.]+)\s*([kmb])?/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            if (m[2] === 'k') n *= 1000;
            else if (m[2] === 'm') n *= 1000000;
            else if (m[2] === 'b') n *= 1000000000;
            return Math.round(n);
        }
    });
}

async function extractShopIntel(page, shopName) {
    return page.evaluate((shopName) => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];

        const body = document.body?.textContent || '';

        let rating = null;
        const ratingMatch = body.match(/([\d.]+)\s*\(\s*[\d,kKmM.]+\s*\)/) // e.g. "4.9 (12,345)"
            || body.match(/([\d.]+)\s*out of\s*5\s*stars?/i);
        if (ratingMatch) rating = parseFloat(ratingMatch[1]);

        let reviewCount = null;
        const rcMatch = body.match(/\(\s*([\d,kKmM.]+)\s*\)\s*(?:Reviews|reviews)?/) // capture inside parens near rating
            || body.match(/([\d,kKmM.]+)\s+(?:Reviews|reviews)/);
        if (rcMatch) reviewCount = parseCountToken(rcMatch[1]);

        let totalSales = null;
        const salesMatch = body.match(/([\d,kKmM.]+)\s+(?:Sales|sales)/);
        if (salesMatch) totalSales = parseCountToken(salesMatch[1]);

        let openedYear = null;
        const openedMatch = body.match(/(?:On Etsy since|Etsy since)\s+(\d{4})/i);
        if (openedMatch) openedYear = parseInt(openedMatch[1], 10);

        let location = null;
        const locMatch = body.match(/(?:Based in|Located in|in\s+)([A-Z][A-Za-z .,'’\-]{2,40})(?:\s*\.|\s*$|\s*Star Seller|\s*On Etsy)/);
        if (locMatch) location = locMatch[1].trim();
        // Fallback: dedicated location element if Etsy renders one.
        const locEl = sel('[data-shop-location], .shop-location, .shop-info-section .location');
        if (!location && locEl) location = text(locEl);

        const isStarSeller = /Star Seller/i.test(body);

        let announcement = null;
        const annEl = sel('.announcement, [data-shop-announcement], .shop-home-section--description p');
        if (annEl) announcement = text(annEl).slice(0, 600);

        return { rating, reviewCount, totalSales, openedYear, location, isStarSeller, announcement };

        function parseCountToken(s) {
            if (!s) return null;
            const t = String(s).toLowerCase().replace(/,/g, '');
            const m = t.match(/^([\d.]+)\s*([kmb])?/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            if (m[2] === 'k') n *= 1000;
            else if (m[2] === 'm') n *= 1000000;
            else if (m[2] === 'b') n *= 1000000000;
            return Math.round(n);
        }
    }, shopName);
}

// ---------- URL helpers ----------

function buildSearchUrl({ q, country, page }) {
    const params = new URLSearchParams({ q, ref: 'search_bar' });
    if (page && page > 1) params.set('page', String(page));
    if (country && country !== 'US') params.set('ship_to', country);
    return `https://${baseHost}/search?${params.toString()}`;
}

function buildShopListingsUrl({ shopName, country, page }) {
    const params = new URLSearchParams();
    if (page && page > 1) params.set('page', String(page));
    const qs = params.toString();
    return `https://${baseHost}/shop/${encodeURIComponent(shopName)}${qs ? `?${qs}` : ''}`;
}

function buildShopHomeUrl({ shopName, country }) {
    return `https://${baseHost}/shop/${encodeURIComponent(shopName)}`;
}

function parseShopInput(raw) {
    if (!raw) return null;
    if (/^[A-Za-z0-9_\-]{2,40}$/.test(raw)) return { name: raw };
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)etsy\.com$/.test(host)) return null;
    const m = u.pathname.match(/\/shop\/([^/?#]+)/i);
    if (!m) return null;
    return { name: decodeURIComponent(m[1]) };
}
