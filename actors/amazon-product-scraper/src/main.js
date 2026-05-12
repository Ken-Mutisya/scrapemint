// Walmart Product Scraper (Amazon Alternative)
//
// Strategy
// --------
// Amazon's anti bot wall (Akamai + Captcha-Enforced PerimeterX) blocks public
// product fetches at any meaningful volume on residential proxy, so this
// actor targets Walmart instead. Same buyer pool (DTC researchers, FBA
// sourcers, retail arbitrage, brand monitors), much softer defense, no
// developer account required.
//
// Discovery feeds:
//   1. startUrls        search, category, or product URLs
//   2. itemIds          direct Walmart item IDs
//
// Search and category pages embed product cards in `window.__NEXT_DATA__`.
// We walk that JSON, queue product URLs, then load each product page and
// read `__NEXT_DATA__` again for the canonical product record (price,
// seller, variants, stock signal, rating, image, brand).
//
// Pay-per-event:
//   result_item ($0.005) charged once per row pushed, after the first 20
//   rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const HOST = 'https://www.walmart.com';
const FREE_TIER_ITEMS = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [],
    itemIds = [],
    maxResultsPerStartUrl = 25,
    deliveryZipcode = '',
    extractVariants = true,
    extractSeller = true,
    extractStock = true,
    extractRatingHistogram = false,
    dedupe = true,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const perSourceCap = Number(maxResultsPerStartUrl) > 0 ? Number(maxResultsPerStartUrl) : Infinity;
const zip = String(deliveryZipcode || '').trim();

const sources = [];
const seenSourceKey = new Set();

for (const raw of startUrls) {
    const url = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = normalizeWalmartUrl(url);
    if (!cleaned) {
        log.warning(`Skipping non-Walmart URL: ${url}`);
        continue;
    }
    const kind = classifyUrl(cleaned);
    if (!kind) {
        log.warning(`Cannot classify URL: ${cleaned}`);
        continue;
    }
    const key = `${kind}:${cleaned}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    sources.push({ kind, url: cleaned, key, label: cleaned });
}

for (const raw of itemIds) {
    const v = typeof raw === 'string' ? raw : raw?.value || raw?.id || '';
    const cleaned = String(v).trim().replace(/^.*\//, '');
    if (!/^\d{6,12}$/.test(cleaned)) {
        log.warning(`Skipping invalid item id: ${v}`);
        continue;
    }
    const url = `${HOST}/ip/${cleaned}`;
    const key = `product:${url}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    sources.push({ kind: 'product', url, key, label: cleaned });
}

if (sources.length === 0) {
    log.warning('No startUrls or itemIds provided. Examples: startUrls=["https://www.walmart.com/search?q=ninja+blender"], itemIds=["592159451"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenProductKeys = new Set();
let totalPushed = 0;

const queuedBySource = new Map();
sources.forEach((s) => queuedBySource.set(s.key, 0));

const initialRequests = sources.map((s) => ({
    url: s.url,
    userData: {
        type: s.kind,
        sourceKey: s.key,
        sourceLabel: s.label,
    },
    uniqueKey: `${s.kind}:${s.url}`,
}));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(12, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 8, maxErrorScore: 2 },
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
                'Referer': 'https://www.google.com/',
            });
            if (zip) {
                await page.context().addCookies([{
                    name: 'locGuestData',
                    value: `intent:SHIPPING|postalCode:${zip}|`,
                    domain: '.walmart.com',
                    path: '/',
                }]);
            }
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search' || t === 'category') return handleListing(ctx);
        if (t === 'product') return handleProduct(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Sources: ${sources.length}. Products pushed: ${totalPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleListing({ page, request, crawler: c }) {
    const { sourceKey } = request.userData;

    if (await isBlocked(page)) {
        throw new Error('Walmart anti-bot block on listing');
    }

    const next = await page.evaluate(() => {
        const s = document.querySelector('script#__NEXT_DATA__');
        if (!s?.textContent) return null;
        try { return JSON.parse(s.textContent); } catch { return null; }
    });

    let items = [];
    if (next) {
        const queue = [next];
        while (queue.length) {
            const node = queue.shift();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) { queue.push(...node); continue; }
            if (Array.isArray(node.itemStacks)) {
                for (const stack of node.itemStacks) {
                    if (Array.isArray(stack.items)) items.push(...stack.items);
                }
            }
            for (const v of Object.values(node)) {
                if (v && typeof v === 'object') queue.push(v);
            }
        }
    }

    const seenIds = new Set();
    const productUrls = [];
    for (const it of items) {
        const id = it?.usItemId || it?.id || it?.itemId;
        if (!id) continue;
        const idStr = String(id).replace(/^.*\//, '');
        if (seenIds.has(idStr)) continue;
        seenIds.add(idStr);
        const canonicalUrl = it.canonicalUrl
            ? (it.canonicalUrl.startsWith('http') ? it.canonicalUrl : `${HOST}${it.canonicalUrl}`)
            : `${HOST}/ip/${idStr}`;
        productUrls.push({ id: idStr, url: stripQuery(canonicalUrl) });
    }

    if (productUrls.length === 0) {
        const fromDom = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            document.querySelectorAll('a[href*="/ip/"]').forEach((a) => {
                const m = a.href.match(/\/ip\/(?:[^/?#]*\/)?(\d{6,12})/);
                if (m && !seen.has(m[1])) {
                    seen.add(m[1]);
                    out.push({ id: m[1], url: a.href });
                }
            });
            return out;
        });
        productUrls.push(...fromDom);
    }

    const already = queuedBySource.get(sourceKey) || 0;
    const remaining = perSourceCap === Infinity ? productUrls.length : Math.max(0, perSourceCap - already);
    const take = productUrls.slice(0, remaining);

    let queued = 0;
    for (const p of take) {
        const dedupeKey = `product:${p.id}`;
        if (dedupe && seenProductKeys.has(dedupeKey)) continue;
        seenProductKeys.add(dedupeKey);
        queued += 1;

        await c.addRequests([{
            url: p.url,
            userData: { type: 'product', sourceKey, itemId: p.id },
            uniqueKey: `product:${p.id}`,
        }]);
    }
    queuedBySource.set(sourceKey, already + queued);

    log.info(`Listing ${request.url}: ${productUrls.length} cards, queued ${queued} products (cap ${perSourceCap}).`);

    if (queuedBySource.get(sourceKey) < perSourceCap) {
        const nextPageUrl = await page.evaluate(() => {
            const a = document.querySelector('a[data-testid="NextPage"], a[aria-label*="next" i], link[rel="next"]');
            return a ? a.getAttribute('href') || a.getAttribute('content') : null;
        });
        if (nextPageUrl) {
            const abs = nextPageUrl.startsWith('http') ? nextPageUrl : `${HOST}${nextPageUrl}`;
            await c.addRequests([{
                url: abs,
                userData: { ...request.userData },
                uniqueKey: `next:${abs}`,
            }]);
        }
    }
}

async function handleProduct({ page, request }) {
    const { sourceKey, itemId } = request.userData;

    if (await isBlocked(page)) {
        throw new Error('Walmart anti-bot block on product');
    }

    const next = await page.evaluate(() => {
        const s = document.querySelector('script#__NEXT_DATA__');
        if (!s?.textContent) return null;
        try { return JSON.parse(s.textContent); } catch { return null; }
    });

    let product = null;
    if (next) {
        const queue = [next];
        while (queue.length && !product) {
            const node = queue.shift();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node)) { queue.push(...node); continue; }
            const looksLikeProduct =
                (node.usItemId || node.itemId) &&
                (node.name || node.title) &&
                (node.priceInfo || node.price || node.currentPrice);
            if (looksLikeProduct) {
                product = node;
                break;
            }
            for (const v of Object.values(node)) {
                if (v && typeof v === 'object') queue.push(v);
            }
        }
    }

    const ld = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
            try {
                const j = JSON.parse(s.textContent || 'null');
                if (j) out.push(j);
            } catch {}
        });
        return out;
    });

    const ldProduct = (() => {
        const flat = [];
        const walk = (n) => {
            if (!n) return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            if (typeof n === 'object') {
                flat.push(n);
                if (n['@graph']) walk(n['@graph']);
            }
        };
        ld.forEach(walk);
        return flat.find((n) => {
            const t = n['@type'];
            return Array.isArray(t) ? t.some((x) => /product/i.test(x)) : /product/i.test(t || '');
        });
    })();

    if (!product && !ldProduct) {
        log.warning(`Product ${itemId} on ${request.url}: no parsable data, skipping.`);
        return;
    }

    const row = buildRow({ product, ldProduct, fallbackId: itemId, url: request.url, sourceKey });
    if (!row) {
        log.warning(`Product ${itemId}: row build returned empty.`);
        return;
    }

    await Actor.pushData(row);
    totalPushed += 1;
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'result_item' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed product ${row.id}: "${(row.title || '').slice(0, 60)}" $${row.price?.value ?? ''}.`);
}

// ---------- Row builder ----------

function buildRow({ product, ldProduct, fallbackId, url, sourceKey }) {
    const p = product || {};
    const ld = ldProduct || {};

    const idRaw = p.usItemId || p.itemId || p.id || fallbackId;
    if (!idRaw) return null;
    const id = String(idRaw);

    const title = p.name || p.title || ld.name || null;
    const brand = p.brand || (typeof ld.brand === 'object' ? ld.brand.name : ld.brand) || null;

    const priceInfo = p.priceInfo || {};
    const current = priceInfo.currentPrice || p.currentPrice || (ld.offers ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) : null);
    const list = priceInfo.wasPrice || priceInfo.linePrice || p.listPrice || null;

    const priceValue = numberOrNull(current?.price ?? current?.priceString ?? current?.amount ?? current?.price);
    const listValue = numberOrNull(list?.price ?? list?.priceString ?? list?.amount);
    const currency = current?.currencyUnit || current?.priceCurrency || ld.offers?.priceCurrency || 'USD';

    const savings = (priceValue != null && listValue != null && listValue > priceValue)
        ? { amount: round2(listValue - priceValue), percent: round2(((listValue - priceValue) / listValue) * 100) }
        : null;

    const rating = numberOrNull(p.averageRating ?? p.rating ?? ld.aggregateRating?.ratingValue);
    const reviewCount = numberOrNull(p.numberOfReviews ?? p.ratingsCount ?? ld.aggregateRating?.reviewCount ?? ld.aggregateRating?.ratingCount);

    const seller = extractSellerBlock(p, ld);
    const stock = extractStockBlock(p, ld);
    const variants = extractVariantsList(p);
    const ratingHistogram = extractRatingHistogramBlock(p);

    const image = p.imageInfo?.thumbnailUrl
        || p.imageInfo?.allImages?.[0]?.url
        || (Array.isArray(ld.image) ? ld.image[0] : ld.image)
        || null;

    const images = (() => {
        const out = new Set();
        if (Array.isArray(p.imageInfo?.allImages)) {
            for (const im of p.imageInfo.allImages) {
                if (im?.url) out.add(im.url);
            }
        }
        if (Array.isArray(ld.image)) ld.image.forEach((u) => u && out.add(u));
        else if (ld.image) out.add(ld.image);
        return [...out];
    })();

    const category = p.category?.path
        ? p.category.path.map((c) => c.name).filter(Boolean)
        : null;

    const row = {
        id,
        url: stripQuery(url || (p.canonicalUrl ? (p.canonicalUrl.startsWith('http') ? p.canonicalUrl : `${HOST}${p.canonicalUrl}`) : `${HOST}/ip/${id}`)),
        title,
        brand,
        model: p.model || null,
        price: priceValue != null ? { value: priceValue, currency } : null,
        listPrice: listValue != null ? { value: listValue, currency } : null,
        savings,
        rating,
        reviewCount,
        image,
        images,
        category,
        discoveredVia: { sourceKey },
        scrapedAt: new Date().toISOString(),
    };

    if (extractSeller) row.seller = seller;
    if (extractStock) row.stock = stock;
    if (extractVariants) row.variants = variants;
    if (extractRatingHistogram) row.ratingHistogram = ratingHistogram;

    return row;
}

function extractSellerBlock(p, ld) {
    const sellerInfo = p.sellerName || p.sellerDisplayName || p.seller || ld.offers?.seller?.name;
    const fulfillmentRaw = JSON.stringify(p.fulfillmentBadges || p.fulfillmentBadgeGroups || p.fulfillmentLabel || '').toLowerCase();
    const walmartFulfilled = /walmart fulfilled|sold and shipped by walmart|sold by walmart/.test(fulfillmentRaw)
        || /walmart\.com$/i.test(sellerInfo || '');
    return {
        name: typeof sellerInfo === 'string' ? sellerInfo : (sellerInfo?.name || null),
        walmartFulfilled,
        kind: walmartFulfilled ? 'walmart' : (sellerInfo ? 'marketplace' : 'unknown'),
    };
}

function extractStockBlock(p, ld) {
    const av = (p.availabilityStatus || p.fulfillmentLabel || ld.offers?.availability || '').toString();
    const lower = av.toLowerCase();
    let status = 'unknown';
    if (/in[ _-]?stock|instock|available/.test(lower)) status = 'in_stock';
    else if (/out[ _-]?of[ _-]?stock|outofstock/.test(lower)) status = 'out_of_stock';
    else if (/limited|low/.test(lower)) status = 'limited';
    return { status, statusText: av || null };
}

function extractVariantsList(p) {
    const out = [];
    const variants = p.variantsMap || p.variants || p.variantList;
    if (!variants) return out;
    const collection = Array.isArray(variants) ? variants : Object.values(variants);
    for (const v of collection) {
        if (!v) continue;
        const idV = v.usItemId || v.itemId || v.id;
        if (!idV) continue;
        const priceV = numberOrNull(v.priceInfo?.currentPrice?.price ?? v.price?.price);
        out.push({
            id: String(idV),
            name: v.name || v.title || null,
            attrs: v.variants || v.attributes || null,
            price: priceV,
        });
    }
    return out;
}

function extractRatingHistogramBlock(p) {
    const ratings = p.reviewSummary || p.ratingDistribution || null;
    if (!ratings) return null;
    const arr = ratings.ratingValueFiveCount !== undefined
        ? [
            ratings.ratingValueOneCount,
            ratings.ratingValueTwoCount,
            ratings.ratingValueThreeCount,
            ratings.ratingValueFourCount,
            ratings.ratingValueFiveCount,
        ]
        : null;
    if (!arr) return null;
    const total = arr.reduce((s, n) => s + (Number(n) || 0), 0);
    return {
        oneStar: numberOrNull(arr[0]),
        twoStar: numberOrNull(arr[1]),
        threeStar: numberOrNull(arr[2]),
        fourStar: numberOrNull(arr[3]),
        fiveStar: numberOrNull(arr[4]),
        total,
    };
}

// ---------- Helpers ----------

function normalizeWalmartUrl(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (!/walmart\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
        return `https://www.walmart.com${u.pathname}${u.search || ''}`;
    } catch { return null; }
}

function classifyUrl(url) {
    if (!url) return null;
    if (/\/ip\//.test(url)) return 'product';
    if (/\/search\b/.test(url)) return 'search';
    if (/\/cp\/|\/browse\/|\/shop\//.test(url)) return 'category';
    return null;
}

function stripQuery(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch { return url; }
}

function numberOrNull(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[$,]/g, '').trim();
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function round2(n) { return Math.round(n * 100) / 100; }

async function isBlocked(page) {
    const url = page.url();
    if (/\/blocked|captcha|robotcheck/i.test(url)) return true;
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    return /press & hold|robot or human|are you a robot|verify you are a human/i.test(text);
}
