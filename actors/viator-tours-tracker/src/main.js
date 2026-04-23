// Viator Tours + Activities Tracker
// Scrapes Viator destination pages, product pages, and search results.
// Parses embedded __NEXT_DATA__ JSON + JSON-LD scripts from the HTML to
// extract tour cards with price, rating, reviews, duration, highlights,
// and category.
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';
import { launchPlaywright } from 'crawlee';

const FREE_TIER_ITEMS = 50;
const PAGE_SLEEP_MS = 400;

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

let proxyUrl = null;
let browser = null;

try {
    if (destList.length === 0 && queryList.length === 0 && productList.length === 0) {
        log.error('Provide at least one of destinationUrls, searchQueries, or productUrls.');
    } else {
        const proxyCfg = await Actor.createProxyConfiguration(proxyInput);
        if (proxyCfg) proxyUrl = await proxyCfg.newUrl();

        browser = await launchPlaywright({
            proxyUrl: proxyUrl || undefined,
            launchOptions: { headless: true },
            useChrome: false,
        });

        for (const url of destList) {
            if (totalPushed >= maxItemsTotal) break;
            await processDestination(url);
        }

        for (const q of queryList) {
            if (totalPushed >= maxItemsTotal) break;
            await processSearch(q);
        }

        for (const url of productList) {
            if (totalPushed >= maxItemsTotal) break;
            await processProduct(url);
        }
    }

    if (dedupe) {
        const trimmed = [...newSeen].slice(-50_000);
        await store.setValue('SEEN_IDS', trimmed);
    }
} catch (err) {
    log.exception(err, 'Unhandled error during run');
} finally {
    if (browser) await browser.close().catch(() => {});
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} pageFetches=${pageFetches}`);
await Actor.exit();

async function processDestination(url) {
    const html = await fetchPage(url);
    if (!html) return;

    const destMeta = parseDestinationMeta(html, url);
    const products = extractProductsFromHtml(html);
    log.info(`${url} -> dest=${destMeta.destinationName || '?'} products=${products.length}`);

    let pushedThis = 0;
    for (const p of products) {
        if (pushedThis >= maxItemsPerSource) break;
        if (totalPushed >= maxItemsTotal) break;
        const row = shapeRow(p, destMeta, url, 'destination');
        if (await pushRow(row)) pushedThis += 1;
    }
}

async function processSearch(query) {
    const url = `https://www.viator.com/searchResults/all?text=${encodeURIComponent(query)}`;
    const html = await fetchPage(url);
    if (!html) return;

    const products = extractProductsFromHtml(html);
    log.info(`search "${query}" -> products=${products.length}`);

    let pushedThis = 0;
    for (const p of products) {
        if (pushedThis >= maxItemsPerSource) break;
        if (totalPushed >= maxItemsTotal) break;
        const row = shapeRow(p, { destinationName: null, destinationId: null }, url, `search:${query}`);
        if (await pushRow(row)) pushedThis += 1;
    }
}

async function processProduct(url) {
    const html = await fetchPage(url);
    if (!html) return;

    const products = extractProductsFromHtml(html);
    const chosen = products.find((p) => url.includes(String(p.productCode || ''))) || products[0];
    if (!chosen) { log.warning(`No product data on ${url}`); return; }

    const destMeta = parseDestinationMeta(html, url);
    const row = shapeRow(chosen, destMeta, url, 'product');
    await pushRow(row);
}

async function fetchPage(url) {
    if (!browser) return null;
    const page = await browser.newPage();
    try {
        await sleep(PAGE_SLEEP_MS);
        pageFetches += 1;
        await page.setExtraHTTPHeaders({
            'accept-language': `${languageCode}-US,${languageCode};q=0.9`,
        });
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        if (!res) { log.warning(`no response for ${url}`); return null; }
        if (res.status() >= 400) { log.warning(`HTTP ${res.status()} on ${url}`); return null; }
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        return await page.content();
    } catch (err) {
        log.warning(`fetch failed for ${url}: ${err?.message}`);
        return null;
    } finally {
        await page.close().catch(() => {});
    }
}

function extractProductsFromHtml(html) {
    const products = new Map();

    const nextData = extractJsonScript(html, /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextData) collectProducts(nextData, products);

    const preloaded = extractJsonAssignment(html, /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (preloaded) collectProducts(preloaded, products);

    const jsonLdMatches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const m of jsonLdMatches) {
        try {
            const ld = JSON.parse(m[1]);
            collectJsonLd(ld, products);
        } catch {}
    }

    return [...products.values()];
}

function extractJsonScript(html, regex) {
    const m = html.match(regex);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function extractJsonAssignment(html, regex) {
    const m = html.match(regex);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function collectProducts(obj, out) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const v of obj) collectProducts(v, out);
        return;
    }

    const maybeCode = obj.productCode || obj.code;
    const maybeTitle = obj.title || obj.productTitle || obj.name;
    const looksLikeProduct = maybeCode && maybeTitle && (obj.price || obj.reviewsSummary || obj.rating || obj.duration || obj.reviewCount);
    if (looksLikeProduct && typeof maybeCode === 'string' && maybeCode.length < 40) {
        if (!out.has(maybeCode)) out.set(maybeCode, obj);
    }

    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') collectProducts(v, out);
    }
}

function collectJsonLd(ld, out) {
    if (!ld) return;
    const items = Array.isArray(ld) ? ld : (ld['@graph'] || [ld]);
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const type = it['@type'];
        if (type === 'Product' || type === 'TouristAttraction' || type === 'Trip' || type === 'Event') {
            const code = it.sku || it.productID || it.identifier || (it.url && extractProductCodeFromUrl(it.url));
            if (!code) continue;
            const key = String(code);
            const normalized = {
                productCode: key,
                title: it.name,
                shortDescription: it.description,
                imageUrl: pickImage(it.image),
                rating: it.aggregateRating?.ratingValue ? Number(it.aggregateRating.ratingValue) : null,
                reviewCount: it.aggregateRating?.reviewCount ? Number(it.aggregateRating.reviewCount) : null,
                price: it.offers?.price ? { fromPrice: Number(it.offers.price), currencyCode: it.offers.priceCurrency } : null,
                url: it.url,
                __fromLd: true,
            };
            if (!out.has(key)) out.set(key, normalized);
        }
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

    const price = extractPrice(p);
    const rating = extractRating(p);
    const reviewCount = extractReviewCount(p);
    const duration = extractDuration(p);
    const title = p.title || p.productTitle || p.name || null;
    const productCode = p.productCode || p.code || null;
    const url = p.productUrl || p.url || (productCode ? `https://www.viator.com/tours/${productCode}` : sourceUrl);

    const flags = [];
    if (rating != null && rating >= 4.8 && (reviewCount || 0) >= 200) flags.push('highly_rated');
    if (p.isBestSeller || p.badges?.some?.((b) => /best/i.test(String(b.text || b.type || '')))) flags.push('bestseller');
    if (reviewCount != null && reviewCount < 10) flags.push('new_listing');
    if (price?.fromPrice != null && price.fromPrice <= 20) flags.push('budget');
    if (price?.fromPrice != null && price.fromPrice >= 200) flags.push('premium');
    if (/skip.{0,3}the.{0,3}line/i.test(title || '') || p.skipTheLine === true) flags.push('skip_the_line');
    if (/private/i.test(title || '')) flags.push('private');

    return {
        source: 'viator',
        sourceTag,
        sourceUrl,
        productCode,
        title,
        shortDescription: p.shortDescription || p.description || null,
        destinationName: destMeta.destinationName || p.primaryDestinationName || null,
        destinationId: destMeta.destinationId || p.primaryDestinationId || null,
        primaryCategory: p.primaryCategory || p.categoryName || null,
        categoryTags: toArray(p.categoryTags).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
        durationMinutes: duration.minutes,
        durationLabel: duration.label,
        priceFrom: price?.fromPrice ?? null,
        priceCurrency: price?.currencyCode || 'USD',
        rating,
        reviewCount,
        bookableNow: p.bookableNow !== false,
        freeCancellation: Boolean(p.freeCancellation ?? p.isFreeCancellation),
        supplier: p.supplier?.name || p.supplierName || null,
        imageUrl: pickImage(p.image || p.images || p.thumbnail || p.primaryImage || p.imageUrl),
        highlights: toArray(p.highlights).map((h) => (typeof h === 'string' ? h : h.text || h.name)).filter(Boolean).slice(0, 10),
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

function extractPrice(p) {
    const price = p.price || p.fromPrice || p.pricing || p.offerPrice;
    if (!price) return null;
    if (typeof price === 'number') return { fromPrice: price, currencyCode: 'USD' };
    return {
        fromPrice: toNumber(price.fromPrice ?? price.price ?? price.amount ?? price.value),
        currencyCode: price.currencyCode || price.currency || 'USD',
    };
}

function extractRating(p) {
    const r = p.rating || p.reviewsSummary?.rating || p.aggregateRating?.ratingValue || p.averageRating;
    return toNumber(r);
}

function extractReviewCount(p) {
    const c = p.reviewCount ?? p.reviewsSummary?.totalReviews ?? p.aggregateRating?.reviewCount ?? p.totalReviews;
    return toNumber(c);
}

function extractDuration(p) {
    const d = p.duration;
    if (!d) return { minutes: null, label: null };
    if (typeof d === 'string') return { minutes: null, label: d };
    if (typeof d === 'number') return { minutes: d, label: `${d} min` };
    const minutes = toNumber(d.minutes ?? d.fromMinutes ?? d.duration);
    const label = d.label || d.description || (minutes ? formatDuration(minutes) : null);
    return { minutes, label };
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
        Actor.charge({ eventName: 'item_extracted' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
