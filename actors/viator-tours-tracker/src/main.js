// Viator Tours + Activities Tracker
// Scrapes Viator destination, product, and search pages via PlaywrightCrawler
// with fingerprint injection + residential proxy to pass Cloudflare checks.
// Parses embedded __NEXT_DATA__ and JSON-LD scripts for tour data.
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 50;

await Actor.init();

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let pageFetches = 0;

const input = (await Actor.getInput()) ?? {};
const {
    destinationUrls = [],
    searchQueries = [],
    productUrls = [],
    minRating = 0,
    minReviewCount = 0,
    maxPriceUsd = 0,
    minPriceUsd = 0,
    languageCode = 'en',
    maxItemsPerSource = 50,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const destList = toArray(destinationUrls).map((u) => String(u).trim()).filter(Boolean);
const queryList = toArray(searchQueries).map((q) => String(q).trim()).filter(Boolean);
const productList = toArray(productUrls).map((u) => String(u).trim()).filter(Boolean);

const store = await Actor.openKeyValueStore('viator-tours-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

try {
    if (destList.length === 0 && queryList.length === 0 && productList.length === 0) {
        log.error('Provide at least one of destinationUrls, searchQueries, or productUrls.');
    } else {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

        const requests = [
            ...destList.map((url) => ({ url, userData: { type: 'destination' } })),
            ...queryList.map((q) => ({
                url: `https://www.viator.com/searchResults/all?text=${encodeURIComponent(q)}`,
                userData: { type: 'search', query: q },
            })),
            ...productList.map((url) => ({ url, userData: { type: 'product' } })),
        ];

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxConcurrency: 1,
            maxRequestRetries: 6,
            retryOnBlocked: true,
            useSessionPool: true,
            sessionPoolOptions: { maxPoolSize: 20 },
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 120,
            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 120 }],
                        devices: ['desktop'],
                        operatingSystems: ['macos', 'windows'],
                        locales: [`${languageCode}-US`, languageCode],
                    },
                },
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await page.setExtraHTTPHeaders({
                        'accept-language': `${languageCode}-US,${languageCode};q=0.9`,
                    });
                },
            ],
            requestHandler: async ({ page, request }) => {
                pageFetches += 1;
                await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});

                const title = await page.title();
                if (/just a moment/i.test(title) || /checking your browser/i.test(title)) {
                    log.info(`Cloudflare challenge on ${request.url}, waiting...`);
                    await page.waitForFunction(
                        () => !/just a moment|checking your browser/i.test(document.title),
                        null,
                        { timeout: 45_000 },
                    ).catch(() => {});
                }

                await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

                const html = await page.content();
                const finalTitle = await page.title();
                log.info(`title="${finalTitle}" html=${html.length}b has__NEXT_DATA__=${html.includes('__NEXT_DATA__')} hasLd=${html.includes('application/ld+json')}`);

                if (totalPushed >= maxItemsTotal) return;
                await handlePage(html, request);
            },
            failedRequestHandler: async ({ request, error }) => {
                log.warning(`failed ${request.url}: ${error?.message}`);
            },
        });

        await crawler.run(requests);
    }

    if (dedupe) {
        const trimmed = [...newSeen].slice(-50_000);
        await store.setValue('SEEN_IDS', trimmed);
    }
} catch (err) {
    log.exception(err, 'Unhandled error during run');
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} pageFetches=${pageFetches}`);
await Actor.exit();

async function handlePage(html, request) {
    const type = request.userData?.type;
    const destMeta = parseDestinationMeta(html, request.url);
    const products = extractProductsFromHtml(html);
    log.info(`${type} ${request.url} -> products=${products.length}`);

    const sourceTag = type === 'search' ? `search:${request.userData.query}` : type;
    const cap = type === 'product' ? 1 : maxItemsPerSource;

    let pushedThis = 0;
    const candidates = type === 'product'
        ? (products.find((p) => request.url.includes(String(p.productCode || ''))) ? [products.find((p) => request.url.includes(String(p.productCode || '')))] : products.slice(0, 1))
        : products;

    for (const p of candidates) {
        if (pushedThis >= cap) break;
        if (totalPushed >= maxItemsTotal) break;
        const row = shapeRow(p, destMeta, request.url, sourceTag);
        if (await pushRow(row)) pushedThis += 1;
    }
}

function extractProductsFromHtml(html) {
    const products = new Map();

    const blobMatch = html.match(/<script[^>]*>(\{"__TRANSLATION_CDN_URL__":[\s\S]*?\})<\/script>/);
    if (blobMatch) {
        try {
            const state = JSON.parse(blobMatch[1]);
            walkForProducts(state, products);
        } catch {}
    }

    return [...products.values()];
}

function walkForProducts(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) {
        for (const v of obj) walkForProducts(v, out, depth + 1);
        return;
    }

    if (Array.isArray(obj.items)) {
        for (const item of obj.items) {
            const prod = item?.product && typeof item.product === 'object' ? item.product : item;
            if (prod?.productCode && (prod.title || prod.canonicalName)) {
                if (!out.has(prod.productCode)) out.set(prod.productCode, prod);
            }
        }
    }

    if (obj.productCode && (obj.title || obj.canonicalName) && (obj.pricingInfo || obj.reviewSummary || obj.itinerary)) {
        if (!out.has(obj.productCode)) out.set(obj.productCode, obj);
    }

    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') walkForProducts(v, out, depth + 1);
    }
}

function pickImage(img) {
    if (!img) return null;
    if (typeof img === 'string') return img;
    if (Array.isArray(img)) return pickImage(img[0]);
    if (typeof img === 'object') return img.url || img.contentUrl || null;
    return null;
}

function extractProductCodeFromUrl(url) {
    const m = String(url).match(/-([A-Z0-9]+)(?:\?|$|#)/);
    return m ? m[1] : null;
}

function parseDestinationMeta(html, url) {
    const destIdMatch = url.match(/\/d(\d+)(?:-|$)/);
    const destinationId = destIdMatch ? Number(destIdMatch[1]) : null;

    let destinationName = null;
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (h1) destinationName = h1[1].replace(/\s+/g, ' ').trim();

    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
    const canonicalUrl = canonical ? canonical[1] : url;

    return { destinationId, destinationName, canonicalUrl };
}

function shapeRow(p, destMeta, sourceUrl, sourceTag) {
    totalSeen += 1;

    const title = extractTitle(p);
    const productCode = p.productCode || p.code || null;
    const price = extractPrice(p);
    const rating = extractRating(p);
    const reviewCount = extractReviewCount(p);
    const duration = extractDuration(p);
    const destId = extractDestinationId(p) ?? destMeta.destinationId;
    const destName = p.primaryDestination?.name || p.primaryDestination?.canonicalName || destMeta.destinationName || null;
    const badges = toArray(p.productBadges).map((b) => (typeof b === 'string' ? b : b?.type || b?.text || b?.label)).filter(Boolean);
    const url = productCode ? `https://www.viator.com/tours/${encodeURIComponent(destName || 'city').replace(/%20/g, '-')}/${productCode}` : sourceUrl;
    const imageUrl = pickViatorImage(p.defaultPhoto) || pickImage(p.image || p.images);
    const freeCancellation = Boolean(p.cancellationPolicy?.freeCancellation ?? p.freeCancellation);

    const flags = [];
    if (rating != null && rating >= 4.8 && (reviewCount || 0) >= 200) flags.push('highly_rated');
    if (badges.some((b) => /best.?seller/i.test(b))) flags.push('bestseller');
    if (p.newProduct === true) flags.push('new_listing');
    else if (reviewCount != null && reviewCount < 10) flags.push('new_listing');
    if (price?.fromPrice != null && price.fromPrice <= 20) flags.push('budget');
    if (price?.fromPrice != null && price.fromPrice >= 200) flags.push('premium');
    if (/skip.{0,3}the.{0,3}line/i.test(title || '')) flags.push('skip_the_line');
    if (p.privateTour === true || /private/i.test(title || '')) flags.push('private');
    if (p.likelyToSellOut === true) flags.push('likely_to_sell_out');
    if (freeCancellation) flags.push('free_cancellation');

    return {
        source: 'viator',
        sourceTag,
        sourceUrl,
        productCode,
        title,
        destinationName: destName,
        destinationId: destId,
        durationMinutes: duration.minutes,
        durationLabel: duration.label,
        priceFrom: price?.fromPrice ?? null,
        priceCurrency: price?.currencyCode || 'USD',
        rating,
        reviewCount,
        freeCancellation,
        privateTour: Boolean(p.privateTour),
        likelyToSellOut: Boolean(p.likelyToSellOut),
        newProduct: Boolean(p.newProduct),
        badges,
        imageUrl,
        flags,
        url,
        dedupeKey: productCode || url,
        scrapedAt: new Date().toISOString(),
    };
}

async function pushRow(row) {
    if (!row?.productCode && !row?.url) { filteredOut += 1; return false; }

    if (minRating > 0 && (row.rating == null || row.rating < minRating)) { filteredOut += 1; return false; }
    if (minReviewCount > 0 && (row.reviewCount == null || row.reviewCount < minReviewCount)) { filteredOut += 1; return false; }
    if (maxPriceUsd > 0 && row.priceFrom != null && row.priceFrom > maxPriceUsd) { filteredOut += 1; return false; }
    if (minPriceUsd > 0 && (row.priceFrom == null || row.priceFrom < minPriceUsd)) { filteredOut += 1; return false; }

    if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; return false; }

    await Actor.pushData(row);
    totalPushed += 1;
    newSeen.add(row.dedupeKey);
    maybeCharge();
    return true;
}

function extractTitle(p) {
    const t = p.title;
    if (!t) return p.canonicalName || p.name || null;
    if (typeof t === 'string') return t;
    if (typeof t === 'object') return t.text || t.value || p.canonicalName || null;
    return null;
}

function extractPrice(p) {
    const pricing = p.pricingInfo || p.pricing;
    if (!pricing) return null;
    const fp = pricing.fromPrice ?? pricing.price ?? pricing;
    if (typeof fp === 'number') return { fromPrice: fp, currencyCode: 'USD' };
    if (!fp || typeof fp !== 'object') return null;
    return {
        fromPrice: toNumber(fp.amount ?? fp.value ?? fp.price),
        currencyCode: fp.currency || fp.currencyCode || pricing.currency || 'USD',
    };
}

function extractRating(p) {
    const rs = p.reviewSummary || p.reviewsSummary;
    const r = rs?.exactRating ?? rs?.averageRating ?? rs?.rating ?? p.rating ?? p.aggregateRating?.ratingValue;
    return toNumber(r);
}

function extractReviewCount(p) {
    const rs = p.reviewSummary || p.reviewsSummary;
    const c = rs?.count ?? rs?.totalReviews ?? p.reviewCount ?? p.totalReviews ?? p.aggregateRating?.reviewCount;
    return toNumber(c);
}

function extractDuration(p) {
    const d = p.itinerary?.duration || p.duration;
    if (!d) return { minutes: null, label: null };
    if (typeof d === 'string') return { minutes: null, label: d };
    if (typeof d === 'number') return { minutes: d, label: formatDuration(d) };
    const raw = toNumber(d.duration ?? d.minutes ?? d.fromMinutes ?? d.value);
    if (raw == null) return { minutes: null, label: d.label || null };
    const unit = String(d.unit || 'MINUTES').toUpperCase();
    let minutes = raw;
    if (unit === 'HOURS') minutes = raw * 60;
    else if (unit === 'DAYS') minutes = raw * 60 * 24;
    return { minutes, label: d.label || formatDuration(minutes) };
}

function extractDestinationId(p) {
    const raw = p.primaryDestination?.id ?? p.primaryDestinationId;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function pickViatorImage(photo) {
    if (!photo) return null;
    const sizes = toArray(photo.sizes);
    if (!sizes.length) return photo.url || null;
    const target = sizes.find((s) => s.width >= 400 && s.width <= 800) || sizes[Math.floor(sizes.length / 2)];
    return target?.url || sizes[0]?.url || null;
}

function formatDuration(mins) {
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'tour_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}
