// E-commerce Scraper Pro
//
// Scrape products across 14+ marketplaces with auto detection and a
// JSON-LD fallback that covers any storefront with Schema.org Product data.
//
// Strategy
// --------
// 1. URL parser routes each URL to a marketplace handler (amazon, walmart,
//    target, ebay, etsy, aliexpress, shopify, generic).
// 2. Listing handlers walk category / search pages to queue product URLs.
// 3. Detail handler reads JSON-LD Product blocks (the universal path) plus
//    marketplace specific selectors for fields not in JSON-LD.
// 4. Optional AI summary calls OpenAI with the description + reviews to
//    generate the requested data points.

import { Actor, log } from 'apify';
import { PlaywrightCrawler, CheerioCrawler } from 'crawlee';

const MARKETPLACE_HOSTS = {
    amazon_us: 'www.amazon.com',
    amazon_uk: 'www.amazon.co.uk',
    amazon_de: 'www.amazon.de',
    amazon_fr: 'www.amazon.fr',
    amazon_jp: 'www.amazon.co.jp',
    amazon_in: 'www.amazon.in',
    walmart_us: 'www.walmart.com',
    target_us: 'www.target.com',
    bestbuy_us: 'www.bestbuy.com',
    costco_us: 'www.costco.com',
    wayfair_us: 'www.wayfair.com',
    homedepot_us: 'www.homedepot.com',
    ebay_us: 'www.ebay.com',
    etsy_us: 'www.etsy.com',
    aliexpress: 'www.aliexpress.com',
    ikea_us: 'www.ikea.com',
    zalando_de: 'www.zalando.de',
    asos_uk: 'www.asos.com',
};

const MARKETPLACE_SEARCH_URL = {
    amazon_us: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    amazon_uk: (q) => `https://www.amazon.co.uk/s?k=${encodeURIComponent(q)}`,
    amazon_de: (q) => `https://www.amazon.de/s?k=${encodeURIComponent(q)}`,
    amazon_fr: (q) => `https://www.amazon.fr/s?k=${encodeURIComponent(q)}`,
    amazon_jp: (q) => `https://www.amazon.co.jp/s?k=${encodeURIComponent(q)}`,
    amazon_in: (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
    walmart_us: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
    target_us: (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
    bestbuy_us: (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
    costco_us: (q) => `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(q)}`,
    wayfair_us: (q) => `https://www.wayfair.com/keyword.php?keyword=${encodeURIComponent(q)}`,
    homedepot_us: (q) => `https://www.homedepot.com/s/${encodeURIComponent(q)}`,
    ebay_us: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
    etsy_us: (q) => `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
    aliexpress: (q) => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}`,
    ikea_us: (q) => `https://www.ikea.com/us/en/search/?q=${encodeURIComponent(q)}`,
    zalando_de: (q) => `https://www.zalando.de/?q=${encodeURIComponent(q)}`,
    asos_uk: (q) => `https://www.asos.com/search/?q=${encodeURIComponent(q)}`,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    scrapeMode = 'auto',
    productUrls = [],
    categoryUrls = [],
    keyword = '',
    marketplaces = [],
    includeAdditionalProperties = true,
    aiSummaryDataPoints = [],
    aiSummaryCustomPrompt = '',
    totalMaxProducts = 25,
    searchEngine = 'none',
    searchEngineCountry = 'US',
    searchEngineLanguage = 'en',
    currency = 'original',
    extractImages = true,
    maxImagesPerProduct = 12,
    extractVariants = true,
    extractRatingHistogram = false,
    extractQuestionsCount = false,
    extractShippingInfo = true,
    dedupe = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(totalMaxProducts) > 0 ? Number(totalMaxProducts) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('ecommerce-scraper-seen') : null;
const seenProductIds = new Set(seenStore ? (await seenStore.getValue('seen-product-ids')) || [] : []);
let pushedRows = 0;

const initial = buildInitialRequests();
if (initial.length === 0) {
    log.warning('No valid input. Provide productUrls, categoryUrls, or keyword + marketplaces.');
    await Actor.exit();
}

// Decide which crawler engine to use. cheerio is faster but only handles
// server rendered pages; playwright handles every modern retailer.
const useCheerio = scrapeMode === 'cheerio';
const wantsPlaywright = scrapeMode === 'playwright' || scrapeMode === 'auto';

const crawlerOptions = {
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 4)),
    maxRequestRetries: 4,
    retryOnBlocked: false,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 60,
        sessionOptions: { maxUsageCount: 25 },
        blockedStatusCodes: [],
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
};

const crawler = useCheerio
    ? new CheerioCrawler({
        ...crawlerOptions,
        async requestHandler(ctx) { return runHandler(ctx, 'cheerio'); },
    })
    : new PlaywrightCrawler({
        ...crawlerOptions,
        headless: true,
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 240,
        launchContext: {
            launchOptions: {
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{ name: 'chrome', minVersion: 120 }],
                    operatingSystems: ['macos', 'windows'],
                    locales: ['en-US'],
                },
            },
        },
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                gotoOptions.waitUntil = 'domcontentloaded';
                gotoOptions.timeout = 90000;
                await page.setExtraHTTPHeaders({
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Upgrade-Insecure-Requests': '1',
                });
            },
        ],
        async requestHandler(ctx) { return runHandler(ctx, 'playwright'); },
    });

await crawler.addRequests(initial);
await crawler.run();

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-product-ids', [...seenProductIds]);
log.info(`Run complete. Products pushed: ${pushedRows}.`);
await Actor.exit();

// ---------- Routing ----------

async function runHandler(ctx, engine) {
    const t = ctx.request.userData?.type;
    if (t === 'category') return handleCategory(ctx, engine);
    if (t === 'product') return handleProduct(ctx, engine);
}

// ---------- Seed builders ----------

function buildInitialRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    for (const url of cleanArr(productUrls)) {
        const parsed = identifyMarketplace(url);
        out.push(makeProductRequest(parsed.marketplace, url, parsed.productId));
    }
    for (const url of cleanArr(categoryUrls)) {
        const parsed = identifyMarketplace(url);
        out.push({
            url,
            userData: { type: 'category', marketplace: parsed.marketplace, sourceKey: `category:${url}`, page: 1 },
            uniqueKey: `category:${url}`,
        });
    }
    if (keyword && keyword.trim() && Array.isArray(marketplaces)) {
        for (const m of marketplaces) {
            const builder = MARKETPLACE_SEARCH_URL[m];
            if (!builder) continue;
            const url = builder(keyword.trim());
            out.push({
                url,
                userData: { type: 'category', marketplace: m, sourceKey: `search:${m}:${keyword}`, page: 1, isSearch: true },
                uniqueKey: `search:${m}:${keyword}`,
            });
        }
    }
    return out;
}

function makeProductRequest(marketplace, url, productId) {
    return {
        url,
        userData: { type: 'product', marketplace, productId: productId || null },
        uniqueKey: `product:${marketplace || 'generic'}:${productId || url}`,
    };
}

function identifyMarketplace(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (/(^|\.)amazon\.(com|co\.uk|de|fr|it|es|ca|com\.au|co\.jp|in|com\.mx|com\.br)/.test(host)) {
            const m = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
            return { marketplace: 'amazon', productId: m?.[1] || null };
        }
        if (host.includes('walmart.com')) {
            const m = u.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)/);
            return { marketplace: 'walmart', productId: m?.[1] || null };
        }
        if (host.includes('target.com')) {
            const m = u.pathname.match(/\/A-(\d+)/);
            return { marketplace: 'target', productId: m?.[1] || null };
        }
        if (host.includes('bestbuy.com')) {
            const m = u.searchParams.get('skuId') || u.pathname.match(/\/(\d{6,})/)?.[1] || null;
            return { marketplace: 'bestbuy', productId: m };
        }
        if (host.includes('ebay.com')) {
            const m = u.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
            return { marketplace: 'ebay', productId: m?.[1] || null };
        }
        if (host.includes('etsy.com')) {
            const m = u.pathname.match(/\/listing\/(\d+)/);
            return { marketplace: 'etsy', productId: m?.[1] || null };
        }
        if (host.includes('aliexpress.com')) {
            const m = u.pathname.match(/\/item\/(\d+)/);
            return { marketplace: 'aliexpress', productId: m?.[1] || null };
        }
        if (host.includes('costco.com')) {
            const m = u.pathname.match(/product\.(\d+)/);
            return { marketplace: 'costco', productId: m?.[1] || null };
        }
        if (host.includes('wayfair.com')) {
            const m = u.pathname.match(/(W\d+)/i);
            return { marketplace: 'wayfair', productId: m?.[1] || null };
        }
        if (host.includes('homedepot.com')) {
            const m = u.pathname.match(/\/(\d+)/);
            return { marketplace: 'homedepot', productId: m?.[1] || null };
        }
        if (host.includes('ikea.com')) {
            const m = u.pathname.match(/-(\d{8,})\/?$/);
            return { marketplace: 'ikea', productId: m?.[1] || null };
        }
        if (host.includes('zalando.')) return { marketplace: 'zalando', productId: null };
        if (host.includes('asos.com')) {
            const m = u.searchParams.get('iid') || u.pathname.match(/\/prd\/(\d+)/)?.[1];
            return { marketplace: 'asos', productId: m };
        }
        return { marketplace: 'generic', productId: null };
    } catch { return { marketplace: 'generic', productId: null }; }
}

// ---------- Category / listing handler ----------

async function handleCategory(ctx, engine) {
    const { request } = ctx;
    if (pushedRows >= cap) return;

    const cards = engine === 'playwright'
        ? await extractCategoryCardsPW(ctx)
        : await extractCategoryCardsCheerio(ctx);

    log.info(`Category ${request.userData.marketplace || 'generic'} ${request.url.slice(0, 80)}: ${cards.length} cards.`);

    const remaining = cap - pushedRows;
    const toQueue = [];
    for (const c of cards) {
        if (toQueue.length >= remaining) break;
        if (dedupe && c.productId && seenProductIds.has(c.productId)) continue;
        toQueue.push(makeProductRequest(request.userData.marketplace, c.url, c.productId));
    }
    if (toQueue.length > 0) await crawler.addRequests(toQueue);
}

async function extractCategoryCardsPW({ page, request }) {
    await page.waitForLoadState('domcontentloaded');
    try { await page.waitForSelector('a[href*="/dp/"], a[href*="/ip/"], a[href*="/A-"], a[href*="/itm/"], a[href*="/listing/"], a[href*="/item/"], a[href*="/skuId"], a[href*="/product"]', { timeout: 12000 }); } catch {}
    return page.evaluate(() => {
        const out = new Map();
        const re = /(\/(?:dp|gp\/product)\/[A-Z0-9]{10}|\/ip\/[^"'#\s]+\/\d+|\/A-\d+|\/itm\/[^"'#\s?]+|\/listing\/\d+|\/item\/\d+|\/products\/[^"'#\s?]+|\/p\/[A-Za-z0-9-]+|\/prd\/\d+)/i;
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            const m = href.match(re);
            if (!m) continue;
            const full = href.startsWith('http') ? href : new URL(href, location.origin).toString();
            const cleaned = full.split('#')[0];
            if (out.has(cleaned)) continue;
            const idMatch = cleaned.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})|\/ip\/(?:[^/]+\/)?(\d+)|\/A-(\d+)|\/itm\/(?:[^/]+\/)?(\d+)|\/listing\/(\d+)|\/item\/(\d+)|\/skuId=(\d+)|\/prd\/(\d+)/);
            const productId = idMatch ? (idMatch.slice(1).find(Boolean) || null) : null;
            out.set(cleaned, { url: cleaned, productId });
        }
        return [...out.values()];
    }).catch(() => []);
}

async function extractCategoryCardsCheerio({ $, request }) {
    const out = new Map();
    const re = /(\/(?:dp|gp\/product)\/[A-Z0-9]{10}|\/ip\/[^"'#\s]+\/\d+|\/A-\d+|\/itm\/[^"'#\s?]+|\/listing\/\d+|\/item\/\d+|\/products\/[^"'#\s?]+|\/p\/[A-Za-z0-9-]+|\/prd\/\d+)/i;
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(re);
        if (!m) return;
        const base = new URL(request.url);
        const full = href.startsWith('http') ? href : new URL(href, base.origin).toString();
        const cleaned = full.split('#')[0];
        if (out.has(cleaned)) return;
        const idMatch = cleaned.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})|\/ip\/(?:[^/]+\/)?(\d+)|\/A-(\d+)|\/itm\/(?:[^/]+\/)?(\d+)|\/listing\/(\d+)|\/item\/(\d+)|\/skuId=(\d+)|\/prd\/(\d+)/);
        const productId = idMatch ? (idMatch.slice(1).find(Boolean) || null) : null;
        out.set(cleaned, { url: cleaned, productId });
    });
    return [...out.values()];
}

// ---------- Product detail handler ----------

async function handleProduct(ctx, engine) {
    const { request } = ctx;
    if (pushedRows >= cap) return;
    const productId = request.userData.productId;
    if (productId && dedupe && seenProductIds.has(productId)) return;

    const data = engine === 'playwright'
        ? await extractProductPW(ctx)
        : await extractProductCheerio(ctx);

    if (!data || !data.title) {
        log.warning(`No product title for ${request.url}, skipping.`);
        return;
    }

    if (Number(currency) && currency !== 'original' && data.currency && data.price) {
        // Currency conversion stub: in v0.1 we keep original. A future version
        // can call an FX endpoint. Document this in the README.
    }

    const row = assembleRow(request, data);

    if (Array.isArray(aiSummaryDataPoints) && aiSummaryDataPoints.length > 0) {
        const summary = await buildAiSummary(row, aiSummaryDataPoints, aiSummaryCustomPrompt);
        if (summary) row.aiSummary = summary;
    }

    await Actor.pushData(row);
    if (productId) seenProductIds.add(productId);
    pushedRows += 1;
    log.info(`Pushed ${request.userData.marketplace || 'generic'} ${(row.title || '').slice(0, 55)} | ${row.price?.value ?? '?'} ${row.price?.currency ?? ''} (${pushedRows})`);
}

// ---------- AI summary ----------

async function buildAiSummary(row, dataPoints, customPrompt) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (!apiKey) {
        log.warning('aiSummaryDataPoints requested but OPENAI_API_KEY env var is missing. Set it in the actor run to enable summaries.');
        return null;
    }
    const sourceText = [
        row.title && `Title: ${row.title}`,
        row.brand && `Brand: ${row.brand}`,
        row.price?.value && `Price: ${row.price.value} ${row.price.currency || ''}`,
        row.rating?.stars != null && `Rating: ${row.rating.stars} (${row.rating.reviewCount || 0} reviews)`,
        row.bullets?.length && `Highlights:\n- ${row.bullets.slice(0, 12).join('\n- ')}`,
        row.description && `Description: ${String(row.description).slice(0, 4000)}`,
        row.specs && `Specs: ${Object.entries(row.specs).slice(0, 25).map(([k, v]) => `${k}=${v}`).join('; ')}`,
    ].filter(Boolean).join('\n\n');

    if (!sourceText.trim()) return null;

    const fieldGuide = {
        pros: '"pros": string[] (3-6 bullet positives buyers consistently mention)',
        cons: '"cons": string[] (3-6 bullet negatives or risks)',
        best_for: '"best_for": string[] (target audiences, 2-4 items)',
        avoid_if: '"avoid_if": string[] (warning signals, 2-4 items)',
        value_rating: '"value_rating": { "score": number 1-10, "reasoning": string }',
        sentiment_breakdown: '"sentiment_breakdown": { "positive": number 0-100, "neutral": number 0-100, "negative": number 0-100 }',
        feature_highlights: '"feature_highlights": string[] (3-6 standout features)',
        comparison_notes: '"comparison_notes": string (one paragraph on how it compares to typical alternatives)',
        buyer_questions: '"buyer_questions": string[] (3-6 likely buyer FAQs)',
        fit_recommendation: '"fit_recommendation": string (sizing or compatibility guidance)',
    };

    const wanted = dataPoints.filter((k) => fieldGuide[k]);
    if (wanted.length === 0) return null;

    const schemaLines = wanted.map((k) => `  ${fieldGuide[k]}`).join(',\n');
    const prompt = `You are an e-commerce product analyst. Read the product info below and return ONLY a JSON object with these fields:\n{\n${schemaLines}\n}\nNo prose outside the JSON.${customPrompt ? `\n\nExtra instruction: ${customPrompt}` : ''}\n\nProduct info:\n${sourceText}`;

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                temperature: 0.2,
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: prompt }],
            }),
        });
        if (!res.ok) {
            log.warning(`OpenAI call failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
            return null;
        }
        const json = await res.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) return null;
        try { return JSON.parse(content); } catch { return { raw: content }; }
    } catch (err) {
        log.warning(`OpenAI call error: ${err?.message}`);
        return null;
    }
}

async function extractProductPW({ page, request }) {
    await page.waitForLoadState('domcontentloaded');
    try { await page.waitForSelector('h1, [data-automation="title"], #productTitle, script[type="application/ld+json"]', { timeout: 18000 }); } catch {}
    return page.evaluate((opts) => {
        return parseProductFromPage(opts);
        function parseProductFromPage(opts) {
            const text = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
            const all = (s) => [...document.querySelectorAll(s)];

            // JSON-LD primary parser
            const ldBlocks = all('script[type="application/ld+json"]').map((n) => {
                try { return JSON.parse(n.textContent || ''); } catch { return null; }
            }).filter(Boolean);
            const flatten = (b) => Array.isArray(b) ? b : (b?.['@graph'] ? b['@graph'] : [b]);
            const products = [];
            for (const block of ldBlocks) {
                for (const item of flatten(block)) {
                    if (!item) continue;
                    const t = item['@type'];
                    const types = Array.isArray(t) ? t : [t];
                    if (types.some((x) => /Product/i.test(String(x)))) products.push(item);
                }
            }
            const ld = products[0] || null;

            const title = ld?.name
                || text(document.querySelector('#productTitle, h1[data-automation="title"], h1[itemprop="name"], h1.product-title, h1'));

            const ogPrice = parseFloat(document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') || '');
            const ogCurrency = document.querySelector('meta[property="product:price:currency"]')?.getAttribute('content') || null;

            const offers = ld?.offers ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) : null;
            const price = offers?.price != null ? Number(offers.price)
                : offers?.priceSpecification?.price != null ? Number(offers.priceSpecification.price)
                : Number.isFinite(ogPrice) ? ogPrice
                : (() => {
                    const txt = text(document.querySelector('.a-price .a-offscreen, [data-automation="product-price"], .price, [itemprop="price"], [data-test="product-price"]'));
                    const m = txt.match(/([\d,.]+)/);
                    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
                })();

            const currency = offers?.priceCurrency || offers?.priceSpecification?.priceCurrency || ogCurrency
                || (() => {
                    const blob = (document.body?.innerText || '').slice(0, 5000);
                    if (/\$/.test(blob)) return 'USD';
                    if (/£/.test(blob)) return 'GBP';
                    if (/€/.test(blob)) return 'EUR';
                    if (/¥/.test(blob)) return 'JPY';
                    if (/₹/.test(blob)) return 'INR';
                    return null;
                })();

            const availability = (() => {
                const a = String(offers?.availability || '').toLowerCase();
                if (a.includes('instock') || a.includes('in_stock')) return 'in_stock';
                if (a.includes('outofstock') || a.includes('out_of_stock')) return 'out_of_stock';
                if (a.includes('preorder')) return 'preorder';
                const txt = (document.body?.innerText || '').slice(0, 5000).toLowerCase();
                if (/in stock|en stock|disponible/.test(txt)) return 'in_stock';
                if (/out of stock|sold out|unavailable|currently unavailable/.test(txt)) return 'out_of_stock';
                return null;
            })();

            const ratingValue = ld?.aggregateRating?.ratingValue != null
                ? Number(ld.aggregateRating.ratingValue)
                : (() => {
                    const txt = text(document.querySelector('[data-hook="rating-out-of-text"], .a-icon-alt, [data-automation="ratings-and-reviews"], [itemprop="ratingValue"]'));
                    const m = txt.match(/([\d.]+)\s*(?:out of|\/|of|sur)\s*5/i) || txt.match(/^([\d.]+)/);
                    return m ? parseFloat(m[1]) : null;
                })();

            const reviewCount = ld?.aggregateRating?.reviewCount != null
                ? Number(ld.aggregateRating.reviewCount)
                : ld?.aggregateRating?.ratingCount != null ? Number(ld.aggregateRating.ratingCount)
                : (() => {
                    const txt = text(document.querySelector('[data-hook="total-review-count"], #acrCustomerReviewText, [data-automation="reviewCount"], [itemprop="reviewCount"]'));
                    const m = txt.replace(/[, ]/g, '').match(/(\d+)/);
                    return m ? parseInt(m[1], 10) : null;
                })();

            const brand = ld?.brand?.name || ld?.brand
                || text(document.querySelector('[itemprop="brand"], #bylineInfo, .product-brand'));

            const sku = ld?.sku || ld?.mpn || ld?.gtin13 || ld?.gtin12 || ld?.gtin || null;

            const description = (() => {
                if (ld?.description) return String(ld.description).slice(0, 8000);
                const el = document.querySelector('#productDescription, [data-automation="product-description"], #feature-bullets, [itemprop="description"], .product-description');
                return el ? text(el).slice(0, 8000) : null;
            })();

            const bullets = all('#feature-bullets li:not(.aok-hidden) span, [data-automation="bullet-points"] li, .product-bullets li, [data-test="item-details-bullets"] li').map((el) => text(el)).filter((t) => t && t.length > 5).slice(0, 20);

            // Images
            const images = opts.wantImages ? (() => {
                const out = new Set();
                if (Array.isArray(ld?.image)) ld.image.forEach((u) => typeof u === 'string' && out.add(u));
                else if (typeof ld?.image === 'string') out.add(ld.image);
                else if (ld?.image?.url) out.add(ld.image.url);
                all('img').forEach((img) => {
                    const src = img.getAttribute('data-old-hires') || img.getAttribute('data-zoom-image') || img.getAttribute('data-large-image-url') || img.getAttribute('src') || '';
                    if (/^https?:\/\//.test(src) && !/sprite|placeholder|pixel|tracking|1x1\.(gif|png)/i.test(src) && (img.width > 100 || img.naturalWidth > 100)) {
                        out.add(src.replace(/\._[A-Z0-9_,]+_\./, '.'));
                    }
                });
                return [...out].slice(0, opts.maxImages || 12);
            })() : null;

            // Variants
            const variants = opts.wantVariants ? (() => {
                const list = [];
                all('#twister li, #inline-twister-row li, [data-automation*="variant"] li, [data-test*="variant"] [role="option"], select[name*="variant"] option').forEach((el) => {
                    const v = text(el).slice(0, 80);
                    if (v && v.length > 0 && !/select|choose/i.test(v)) {
                        list.push({ value: v, sku: el.getAttribute('data-defaultasin') || el.getAttribute('value') || null });
                    }
                });
                return list.length > 0 ? list.slice(0, 100) : null;
            })() : null;

            // Rating histogram
            const ratingHistogram = opts.wantHistogram ? (() => {
                const bars = all('[id*="histogramTable"] tr, [data-test="rating-histogram"] [aria-label]');
                if (bars.length === 0) return null;
                const out = { 5: null, 4: null, 3: null, 2: null, 1: null };
                bars.forEach((row, i) => {
                    const aria = row.getAttribute('aria-label') || (row.textContent || '').replace(/\s+/g, ' ');
                    const m = aria.match(/(\d+)\s*%/);
                    if (m) out[5 - i] = parseInt(m[1], 10);
                });
                return Object.values(out).some((v) => v != null) ? out : null;
            })() : null;

            // Specs / additional properties
            const specs = (() => {
                const out = {};
                if (Array.isArray(ld?.additionalProperty)) {
                    for (const p of ld.additionalProperty) {
                        const k = String(p.name || '').toLowerCase().slice(0, 60);
                        const v = String(p.value || '').slice(0, 240);
                        if (k && v) out[k] = v;
                    }
                }
                all('table[data-test="product-specifications"] tr, table#productDetails_techSpec_section_1 tr, [data-automation="product-specifications"] tr, .specs-table tr').forEach((row) => {
                    const cells = row.querySelectorAll('th, td');
                    if (cells.length >= 2) {
                        const k = (cells[0].textContent || '').replace(/\s+/g, ' ').trim().replace(/[:\s]+$/, '').toLowerCase();
                        const v = (cells[1].textContent || '').replace(/\s+/g, ' ').trim();
                        if (k && v && k.length < 60) out[k] = v;
                    }
                });
                return Object.keys(out).length > 0 ? out : null;
            })();

            // Q&A count
            const questionsCount = opts.wantQuestions ? (() => {
                const txt = text(document.querySelector('#askATFLink, [data-automation="qa-link"], a[href*="ask"], [data-test="questions-link"]'));
                const m = txt.replace(/[, ]/g, '').match(/(\d+)/);
                return m ? parseInt(m[1], 10) : null;
            })() : null;

            // Shipping
            const shipping = opts.wantShipping ? (() => {
                const txt = text(document.querySelector('[data-test="fulfillment-cell"], [data-automation="shipping-message"], #deliveryBlockMessage, [data-automation="fulfillment"]')) || '';
                return {
                    text: txt || null,
                    freeShipping: /free\s+shipping|free delivery/i.test(txt),
                    storePickup: /pickup|store/i.test(txt),
                };
            })() : null;

            const seller = ld?.offers?.seller?.name || text(document.querySelector('#sellerProfileTriggerId, [data-automation="seller-name"], .product-seller'));
            const breadcrumbs = all('nav[aria-label*="breadcrumb" i] a, [data-automation="breadcrumbs"] a, ol.breadcrumbs li, #wayfinding-breadcrumbs_feature_div a').map((a) => text(a)).filter(Boolean);

            return {
                title,
                brand: brand && typeof brand === 'object' ? brand.name : brand || null,
                sku,
                description,
                bullets,
                price: price != null ? { value: price, currency } : null,
                originalPrice: offers?.priceSpecification?.priceCurrency != null && offers?.priceSpecification?.price != null ? { value: Number(offers.priceSpecification.price), currency: offers.priceSpecification.priceCurrency } : null,
                availability,
                rating: { stars: ratingValue, reviewCount, histogram: ratingHistogram, questionsCount },
                images,
                variants,
                specs,
                shipping,
                seller: seller || null,
                breadcrumbs,
                productType: ld?.['@type'] ? (Array.isArray(ld['@type']) ? ld['@type'][0] : ld['@type']) : null,
                gtin: ld?.gtin13 || ld?.gtin12 || ld?.gtin || null,
                category: Array.isArray(ld?.category) ? ld.category[0] : ld?.category || null,
            };
        }
    }, {
        wantImages: extractImages,
        maxImages: maxImagesPerProduct,
        wantVariants: includeAdditionalProperties && extractVariants,
        wantHistogram: includeAdditionalProperties && extractRatingHistogram,
        wantQuestions: includeAdditionalProperties && extractQuestionsCount,
        wantShipping: includeAdditionalProperties && extractShippingInfo,
    }).catch((err) => {
        log.debug(`Product extraction failed: ${err?.message}`);
        return null;
    });
}

async function extractProductCheerio({ $, request }) {
    // Cheerio path: parse JSON-LD only (works on static product pages with
    // structured data: Shopify, WooCommerce, BigCommerce, most CMS storefronts).
    const blocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try { blocks.push(JSON.parse($(el).contents().text())); } catch {}
    });
    const flatten = (b) => Array.isArray(b) ? b : (b?.['@graph'] ? b['@graph'] : [b]);
    let ld = null;
    for (const block of blocks) {
        for (const item of flatten(block)) {
            if (!item) continue;
            const t = item['@type'];
            const types = Array.isArray(t) ? t : [t];
            if (types.some((x) => /Product/i.test(String(x)))) { ld = item; break; }
        }
        if (ld) break;
    }
    if (!ld) {
        const title = $('h1').first().text().trim() || $('title').text();
        if (!title) return null;
        return { title, price: null, brand: null, description: null, images: null, rating: { stars: null, reviewCount: null }, sku: null };
    }
    const offers = ld.offers ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) : null;
    const images = extractImages ? (Array.isArray(ld.image) ? ld.image : (typeof ld.image === 'string' ? [ld.image] : (ld.image?.url ? [ld.image.url] : []))).slice(0, maxImagesPerProduct) : null;
    return {
        title: ld.name || $('h1').first().text().trim(),
        brand: typeof ld.brand === 'object' ? ld.brand?.name : ld.brand || null,
        sku: ld.sku || ld.mpn || null,
        description: ld.description ? String(ld.description).slice(0, 8000) : null,
        bullets: [],
        price: offers?.price != null ? { value: Number(offers.price), currency: offers.priceCurrency || null } : null,
        availability: String(offers?.availability || '').toLowerCase().includes('instock') ? 'in_stock' : (String(offers?.availability || '').toLowerCase().includes('outofstock') ? 'out_of_stock' : null),
        rating: {
            stars: ld.aggregateRating?.ratingValue ? Number(ld.aggregateRating.ratingValue) : null,
            reviewCount: ld.aggregateRating?.reviewCount ? Number(ld.aggregateRating.reviewCount) : (ld.aggregateRating?.ratingCount ? Number(ld.aggregateRating.ratingCount) : null),
            histogram: null,
            questionsCount: null,
        },
        images,
        variants: null,
        specs: null,
        shipping: null,
        seller: offers?.seller?.name || null,
        breadcrumbs: [],
        productType: ld['@type'] ? (Array.isArray(ld['@type']) ? ld['@type'][0] : ld['@type']) : null,
        gtin: ld.gtin13 || ld.gtin12 || ld.gtin || null,
        category: Array.isArray(ld.category) ? ld.category[0] : ld.category || null,
    };
}

// ---------- Row assembly ----------

function assembleRow(request, d) {
    const productId = request.userData.productId || (() => {
        try {
            const u = new URL(request.url);
            return u.pathname.split('/').filter(Boolean).pop() || null;
        } catch { return null; }
    })();
    return {
        productId,
        marketplace: request.userData.marketplace || 'generic',
        url: request.url,
        title: d.title || null,
        brand: d.brand,
        sku: d.sku,
        gtin: d.gtin,
        productType: d.productType,
        category: d.category,
        breadcrumbs: d.breadcrumbs && d.breadcrumbs.length > 0 ? d.breadcrumbs : null,
        price: d.price,
        originalPrice: d.originalPrice,
        availability: d.availability,
        rating: d.rating,
        description: d.description,
        bullets: d.bullets && d.bullets.length > 0 ? d.bullets : null,
        specs: includeAdditionalProperties ? d.specs : null,
        variants: includeAdditionalProperties ? d.variants : null,
        images: d.images,
        shipping: includeAdditionalProperties ? d.shipping : null,
        seller: d.seller,
        aiSummary: null,
        scrapedAt: new Date().toISOString(),
    };
}
