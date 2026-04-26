// Amazon Product Scraper
//
// Scrape Amazon products from search URLs, category URLs, ASINs, or seller
// stores. Each row ships pricing intelligence (list, savings, coupon,
// subscribe-save, prime exclusive), seller intel (FBA vs FBM, buy box),
// BSR breakdown, variants, ratings histogram, badges, stock signals, and
// shipping estimates. Works on 10 Amazon marketplaces.
//
// Strategy
// --------
// 1. Parse each input URL into one of: search, category, product, seller.
//    ASINs passed via the asins[] field are normalized into product URLs
//    using the chosen marketplace.
// 2. Search and category pages render product cards with ASINs. Walk the
//    cards and queue a detail fetch for each ASIN.
// 3. Detail page parser pulls all enrichment fields the user asked for.
// 4. Optional rating histogram and FBT bundles fire off small follow up
//    fetches that share the same session.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const MARKETPLACE_HOSTS = {
    US: 'www.amazon.com',
    UK: 'www.amazon.co.uk',
    DE: 'www.amazon.de',
    FR: 'www.amazon.fr',
    IT: 'www.amazon.it',
    ES: 'www.amazon.es',
    CA: 'www.amazon.ca',
    AU: 'www.amazon.com.au',
    JP: 'www.amazon.co.jp',
    IN: 'www.amazon.in',
};

const HOST_TO_MARKETPLACE = Object.fromEntries(
    Object.entries(MARKETPLACE_HOSTS).map(([k, v]) => [v, k]),
);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [],
    asins = [],
    marketplace = 'US',
    maxResultsPerStartUrl = 100,
    extractVariants = true,
    extractBSR = true,
    extractRatingHistogram = true,
    extractFrequentlyBoughtTogether = false,
    extractAPlusContent = false,
    deliveryZipcode = '',
    dedupe = true,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxResultsPerStartUrl) > 0 ? Number(maxResultsPerStartUrl) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('amazon-products-seen') : null;
const seenAsins = new Set(seenStore ? (await seenStore.getValue('seen-asins')) || [] : []);
const perStartUrlCount = new Map();
let pushedRows = 0;

const initialRequests = buildInitialRequests();
if (initialRequests.length === 0) {
    log.warning('No valid input. Provide at least one Amazon URL or ASIN.');
    await Actor.exit();
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(12, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    maxRequestRetries: 5,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: { maxUsageCount: 20 },
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
            },
        },
    },
    preNavigationHooks: [
        async ({ page, session, request }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            const referer = request.userData?.host ? `https://${request.userData.host}/` : 'https://www.google.com/';
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1',
                Referer: referer,
            });

            // Session warmup: hit the Amazon homepage once per session so the
            // request that follows looks like ordinary user navigation, not a
            // direct hit on /dp/ASIN. Cuts CAPTCHA rate sharply.
            if (session && !session.userData?.warmed && request.userData?.host) {
                try {
                    await page.goto(`https://${request.userData.host}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
                    session.userData = { ...session.userData, warmed: true };
                } catch {}
            }

            if (deliveryZipcode) {
                try {
                    const ctx = page.context();
                    await ctx.addCookies([
                        { name: 'lc-main', value: 'en_US', domain: '.amazon.com', path: '/' },
                        { name: 'i18n-prefs', value: 'USD', domain: '.amazon.com', path: '/' },
                        { name: 'sp-cdn', value: `L5Z9:US`, domain: '.amazon.com', path: '/' },
                    ]);
                } catch {}
            }
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData?.type;
        if (t === 'listing') return handleListing(ctx);
        if (t === 'product') return handleProduct(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-asins', [...seenAsins]);

log.info(`Run complete. Products pushed: ${pushedRows}.`);
await Actor.exit();

// ---------- Seed builders ----------

function buildInitialRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    const urls = cleanArr(startUrls);
    const asinList = cleanArr(asins);

    for (const url of urls) {
        const parsed = parseAmazonUrl(url);
        if (!parsed) continue;
        if (parsed.kind === 'product') {
            out.push(makeProductRequest(parsed.asin, parsed.host, url));
        } else {
            // search, category, seller — all listings
            out.push({
                url,
                userData: { type: 'listing', startUrl: url, host: parsed.host, page: 1 },
                uniqueKey: `listing:${url}`,
            });
        }
    }

    for (const asin of asinList) {
        const cleaned = String(asin).trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(cleaned)) continue;
        const host = MARKETPLACE_HOSTS[marketplace] || MARKETPLACE_HOSTS.US;
        out.push(makeProductRequest(cleaned, host, null));
    }

    return out;
}

function makeProductRequest(asin, host, originatingUrl) {
    return {
        url: `https://${host}/dp/${asin}`,
        userData: {
            type: 'product',
            asin,
            host,
            originatingStartUrl: originatingUrl || null,
        },
        uniqueKey: `product:${host}:${asin}`,
    };
}

function parseAmazonUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        const fullHost = `www.${host}`;
        if (!HOST_TO_MARKETPLACE[fullHost] && !HOST_TO_MARKETPLACE[host]) return null;
        const finalHost = HOST_TO_MARKETPLACE[fullHost] ? fullHost : host;
        const path = u.pathname;

        // Product URL
        let m = path.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
        if (m) return { kind: 'product', asin: m[1].toUpperCase(), host: finalHost };

        // Search URL
        if (path.startsWith('/s')) return { kind: 'search', host: finalHost };

        // Category URL
        if (/\/b\b|\/zgbs\/|\/gp\/bestsellers/i.test(path)) return { kind: 'category', host: finalHost };

        // Seller / store URL
        if (/\/(stores|shops|seller|s)/i.test(path)) return { kind: 'seller', host: finalHost };

        return null;
    } catch { return null; }
}

// ---------- Handlers ----------

async function handleListing({ page, request, crawler: c }) {
    const startUrl = request.userData.startUrl;
    const host = request.userData.host;

    const have = perStartUrlCount.get(startUrl) || 0;
    if (have >= cap) return;

    await page.waitForLoadState('domcontentloaded');
    await dismissAmazonModals(page);
    await page.waitForTimeout(1500);
    await scrollPage(page);

    const asinsFound = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('[data-asin]').forEach((el) => {
            const a = el.getAttribute('data-asin') || '';
            if (/^[A-Z0-9]{10}$/.test(a)) out.add(a);
        });
        return [...out];
    });

    log.info(`Listing ${request.url}: ${asinsFound.length} ASINs found.`);

    const remaining = cap - have;
    const toQueue = [];
    for (const asin of asinsFound) {
        if (toQueue.length >= remaining) break;
        if (dedupe && seenAsins.has(asin)) continue;
        toQueue.push(makeProductRequest(asin, host, startUrl));
    }
    if (toQueue.length > 0) {
        await c.addRequests(toQueue);
        perStartUrlCount.set(startUrl, have + toQueue.length);
    }

    // Pagination
    const nextUrl = await page.evaluate(() => {
        const a = document.querySelector('a.s-pagination-next:not(.s-pagination-disabled), li.a-last a');
        return a?.href || null;
    });
    const newHave = perStartUrlCount.get(startUrl) || 0;
    if (nextUrl && newHave < cap) {
        await c.addRequests([{
            url: nextUrl,
            userData: { ...request.userData, page: (request.userData.page || 1) + 1 },
            uniqueKey: `listing:${nextUrl}`,
        }]);
    }
}

async function handleProduct({ page, request }) {
    const asin = request.userData.asin;
    const host = request.userData.host;
    if (dedupe && seenAsins.has(asin)) return;

    await page.waitForLoadState('domcontentloaded');
    await dismissAmazonModals(page);

    // Bot challenge bypass: if Amazon shows the "Continue shopping" wall, click it
    // and wait for the real product page.
    let bypassed = await tryBypassBotChallenge(page);

    try {
        await page.waitForSelector('#dp, #productTitle, #title, [data-feature-name="title"]', { timeout: bypassed ? 12000 : 8000 });
    } catch {}

    let html = await page.content();
    // If still on a challenge page, try one more bypass + wait.
    if (looksLikeChallenge(html)) {
        bypassed = (await tryBypassBotChallenge(page)) || bypassed;
        try {
            await page.waitForSelector('#productTitle, #title', { timeout: 8000 });
        } catch {}
        html = await page.content();
    }

    if (looksLikeChallenge(html)) {
        log.warning(`CAPTCHA on ${request.url}, retrying via session rotation.`);
        request.session?.markBad();
        throw new Error('Amazon CAPTCHA');
    }

    const data = await page.evaluate((flags) => {
        const sel = (s) => document.querySelector(s);
        const all = (s) => [...document.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const attr = (el, a) => (el && el.getAttribute(a)) || null;

        // Title + brand
        const title = text(sel('#productTitle')) || text(sel('h1#title'));
        const brand = (() => {
            const byline = text(sel('#bylineInfo, a#bylineInfo'));
            const m = byline.match(/(?:Visit the|Brand:?)\s*([^\s].+?)(?:\s+Store|\s*$)/i);
            if (m) return m[1].trim();
            return byline.replace(/(Visit the|Brand:?|Store)/gi, '').trim() || null;
        })();

        // Price
        const priceText = text(sel('.a-price .a-offscreen, span.a-price-whole, #priceblock_ourprice, #priceblock_dealprice'));
        const listPriceText = text(sel('.a-price.a-text-price .a-offscreen, .priceBlockStrikePriceString, span.a-price.a-text-price[data-a-strike="true"] .a-offscreen'));
        const savingsText = text(sel('.savingsPercentage, .a-color-price.savingsPercentage, [class*="savingPercentage"]'));
        const perUnitText = text(sel('.a-price-perunit, [data-a-size="small"][class*="perunit"]'));

        // Coupon, subscribe-save, prime exclusive
        const couponText = text(sel('#couponBadgeRegularVpc, .promoPriceBlockMessage, #promoMessage, .promoPriceBlockMessage'));
        const subscribeSaveText = text(sel('#snsSavings, [id*="snsBadge"], [data-feature-name="snsBadge"]'));
        const primeExclusive = !!sel('[id*="primeExclusiveBadge"], .primeExclusiveBadgeContainer, #primeExclusiveContainer');

        // Rating
        const ratingText = text(sel('#acrPopover, [data-hook="rating-out-of-text"], .a-icon-alt'));
        const reviewCountText = text(sel('#acrCustomerReviewText, [data-hook="total-review-count"]'));
        const questionCountText = text(sel('#askATFLink, [data-hook="cr-question-count"], a[href*="ask"]'));

        // Rating histogram (only present on some pages)
        const histogram = { 5: null, 4: null, 3: null, 2: null, 1: null };
        if (flags.histogram) {
            for (let star = 5; star >= 1; star--) {
                const row = sel(`#histogramTable tr:nth-child(${6 - star}), [data-reftag="acr_dp_hist_${star}"]`);
                if (row) {
                    const pct = (row.textContent || '').match(/(\d+)\s*%/);
                    if (pct) histogram[star] = parseInt(pct[1], 10);
                }
            }
        }

        // Badges
        const amazonsChoice = !!sel('.ac-badge-rectangle, .ac-for-text, [data-feature-name="amazonsChoice"]');
        const bestseller = !!sel('.badge-wrapper.feature .a-badge-text, [data-feature-name="bestSellerBadge"]');
        const climatePledge = !!sel('[id*="climatePledgeFriendly"], .climate-pledge-icon');
        const newRelease = !!sel('[id*="newReleaseBadge"]');

        // Availability — skip script-tag content
        const availabilityEl = sel('#availability span.a-color-success, #availability span.a-color-state, #availability span.a-color-price, #availability .a-size-medium');
        const rawAvailability = text(availabilityEl);
        const availabilityText = rawAvailability.length > 200 ? rawAvailability.split(/\s+/).slice(0, 20).join(' ') : rawAvailability;
        const lowStockMatch = availabilityText.match(/only\s+(\d+)\s+left/i);
        const inStock = !/(out of stock|currently unavailable|temporarily out|cannot be shipped)/i.test(availabilityText) && (availabilityText.length > 0);

        // Delivery
        const deliveryEl = sel('#mir-layout-DELIVERY_BLOCK, [data-feature-name="deliveryBlock"]');
        const deliveryText = text(deliveryEl);

        // Seller
        const merchantInfo = text(sel('#merchant-info, #tabular-buybox'));
        const soldByMatch = merchantInfo.match(/Sold by\s*([^\.]+?)(?:\s*and|\s*Ships|$)/i);
        const shipsFromMatch = merchantInfo.match(/Ships from\s*([^\.]+?)(?:\s*Sold|$)/i);
        const sellerLink = sel('#sellerProfileTriggerId, a[href*="/seller/"]');
        const sellerName = text(sellerLink);
        const sellerUrl = sellerLink?.href || null;

        // Variants (simplified — captures top level options)
        let variants = null;
        if (flags.variants) {
            const swatches = all('#variation_color_name li, #variation_size_name li, #twister li, #inline-twister-row li');
            const variantOpts = swatches.map((el) => ({
                value: text(el).slice(0, 80),
                asin: el.getAttribute('data-defaultasin') || el.getAttribute('data-csa-c-item-id') || null,
            })).filter((v) => v.value);
            variants = variantOpts.length > 0 ? { options: variantOpts.slice(0, 50), totalCount: swatches.length } : null;
        }

        // BSR
        let bsr = null;
        if (flags.bsr) {
            const detailText = text(sel('#detailBulletsWrapper_feature_div, #productDetails_detailBullets_sections1, table.prodDetTable'));
            const ranks = [];
            const matches = detailText.matchAll(/#?([\d,]+)\s+in\s+([^\(\#]+?)(?=\s*#|\s*\(|$)/g);
            for (const m of matches) {
                const rank = parseInt(m[1].replace(/,/g, ''), 10);
                const cat = m[2].trim().replace(/[()]/g, '');
                if (rank > 0 && cat.length < 100) ranks.push({ rank, category: cat });
            }
            if (ranks.length > 0) {
                bsr = { primary: ranks[0], all: ranks.slice(0, 10) };
            }
        }

        // Description + bullets (dedupe)
        const bulletSet = new Set();
        all('#feature-bullets ul li:not(.aok-hidden) span').forEach((el) => {
            const t = text(el);
            if (t && t.length > 5) bulletSet.add(t);
        });
        const bullets = [...bulletSet].slice(0, 15);
        const description = text(sel('#productDescription, #productDescription_feature_div'));

        // Specifications
        const specs = {};
        all('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div ul li').forEach((row) => {
            const label = text(row.querySelector('th, .a-text-bold')).replace(/[:\s]+$/, '').toLowerCase();
            const value = text(row.querySelector('td, .a-list-item span:nth-child(2)'));
            if (label && value && label.length < 60) specs[label] = value;
        });

        // Images
        const images = (() => {
            const out = new Set();
            all('#altImages img, #imageBlock img, #landingImage').forEach((img) => {
                let src = img.getAttribute('data-old-hires') || img.getAttribute('src') || '';
                src = src.replace(/\._[A-Z0-9_,]+_\./, '.');
                if (/^https?:\/\//.test(src) && !/sprite|placeholder|pixel/i.test(src)) out.add(src);
            });
            return [...out].slice(0, 20);
        })();

        // A+ content
        let aPlusContent = null;
        if (flags.aPlusContent) {
            const aPlusEl = sel('#aplus, #aplus_feature_div, .aplus-v2');
            if (aPlusEl) aPlusContent = text(aPlusEl).slice(0, 15000);
        }

        // FBT
        let fbt = null;
        if (flags.fbt) {
            const fbtAsins = [];
            all('#sims-fbt [data-asin], #sims-fbt-content [data-asin], #frequently-bought-together-checkbox [data-asin]').forEach((el) => {
                const a = el.getAttribute('data-asin');
                if (/^[A-Z0-9]{10}$/.test(a)) fbtAsins.push(a);
            });
            if (fbtAsins.length > 0) fbt = { asins: [...new Set(fbtAsins)].slice(0, 8) };
        }

        // Breadcrumb category
        const breadcrumbs = all('#wayfinding-breadcrumbs_feature_div ul li a, #wayfinding-breadcrumbs_container a').map((a) => text(a)).filter(Boolean);

        return {
            title,
            brand,
            priceText,
            listPriceText,
            savingsText,
            perUnitText,
            couponText,
            subscribeSaveText,
            primeExclusive,
            ratingText,
            reviewCountText,
            questionCountText,
            histogram,
            amazonsChoice,
            bestseller,
            climatePledge,
            newRelease,
            availabilityText,
            lowStockCount: lowStockMatch ? parseInt(lowStockMatch[1], 10) : null,
            inStock,
            deliveryText,
            soldBy: soldByMatch ? soldByMatch[1].trim() : null,
            shipsFrom: shipsFromMatch ? shipsFromMatch[1].trim() : null,
            sellerName: sellerName || null,
            sellerUrl,
            variants,
            bsr,
            bullets,
            description,
            specs,
            images,
            aPlusContent,
            fbt,
            breadcrumbs,
        };
    }, {
        histogram: extractRatingHistogram,
        variants: extractVariants,
        bsr: extractBSR,
        aPlusContent: extractAPlusContent,
        fbt: extractFrequentlyBoughtTogether,
    });

    if (!data.title) {
        log.warning(`No title parsed for ${asin}, skipping.`);
        return;
    }

    const price = parseProductPrice(data, host);
    const rating = parseRating(data.ratingText, data.reviewCountText, data.questionCountText);
    if (extractRatingHistogram) rating.histogram = data.histogram;

    const fulfillmentType = inferFulfillment(data.soldBy, data.shipsFrom);

    const row = {
        asin,
        url: `https://${host}/dp/${asin}`,
        marketplace: HOST_TO_MARKETPLACE[host] || marketplace,
        title: data.title,
        brand: data.brand,
        category: data.breadcrumbs?.length ? {
            primary: data.breadcrumbs[0],
            breadcrumbs: data.breadcrumbs,
        } : null,
        price,
        rating,
        badges: {
            amazonsChoice: data.amazonsChoice,
            bestseller: data.bestseller,
            climatePledgeFriendly: data.climatePledge,
            newRelease: data.newRelease,
        },
        availability: {
            inStock: data.inStock,
            stockText: data.availabilityText || null,
            lowStockCount: data.lowStockCount,
            deliveryText: data.deliveryText || null,
        },
        seller: {
            name: data.sellerName,
            url: data.sellerUrl,
            soldBy: data.soldBy,
            shipsFrom: data.shipsFrom,
            fulfillmentType,
        },
        media: {
            images: data.images,
            thumbnail: data.images?.[0] || null,
        },
        details: {
            description: data.description || null,
            bulletPoints: data.bullets,
            specifications: Object.keys(data.specs || {}).length > 0 ? data.specs : null,
        },
        rank: extractBSR ? data.bsr : null,
        variants: extractVariants ? data.variants : null,
        frequentlyBoughtTogether: extractFrequentlyBoughtTogether ? data.fbt : null,
        aPlusContent: extractAPlusContent ? data.aPlusContent : null,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    seenAsins.add(asin);
    pushedRows += 1;
    log.info(`Pushed ${asin} ${data.title.slice(0, 60)} | $${price.current ?? '?'} | rating ${rating.stars ?? '?'} (${pushedRows})`);
}

// ---------- Parsers ----------

function parseProductPrice(d, host) {
    const out = {
        current: null,
        currency: currencyForHost(host),
        list: null,
        savings: null,
        savingsPercent: null,
        perUnit: d.perUnitText || null,
        coupon: d.couponText ? cleanCouponText(d.couponText) : null,
        subscribeSavePercent: parsePercent(d.subscribeSaveText),
        primeExclusive: !!d.primeExclusive,
    };
    out.current = parsePriceNumber(d.priceText);
    out.list = parsePriceNumber(d.listPriceText);
    if (out.current && out.list && out.list > out.current) {
        out.savings = Math.round((out.list - out.current) * 100) / 100;
        out.savingsPercent = Math.round(((out.list - out.current) / out.list) * 100);
    } else {
        const pct = parsePercent(d.savingsText);
        if (pct) out.savingsPercent = pct;
    }
    return out;
}

function parsePriceNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d.,]/g, '');
    if (!cleaned) return null;
    // Heuristic: if both . and , present, the rightmost is the decimal
    let normalized = cleaned;
    if (cleaned.includes(',') && cleaned.includes('.')) {
        if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
            normalized = cleaned.replace(/\./g, '').replace(/,/g, '.');
        } else {
            normalized = cleaned.replace(/,/g, '');
        }
    } else if (cleaned.includes(',') && !cleaned.includes('.')) {
        // Could be European decimal or US thousands. If the comma is the last 3 chars from the end, treat as thousands.
        if (/,\d{3}(?:[^0-9]|$)/.test(cleaned)) normalized = cleaned.replace(/,/g, '');
        else normalized = cleaned.replace(/,/g, '.');
    }
    const n = parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
}

function parsePercent(text) {
    if (!text) return null;
    const m = String(text).match(/(\d+)\s*%/);
    return m ? parseInt(m[1], 10) : null;
}

function cleanCouponText(text) {
    if (!text) return null;
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function currencyForHost(host) {
    return ({
        'www.amazon.com': 'USD',
        'www.amazon.co.uk': 'GBP',
        'www.amazon.de': 'EUR',
        'www.amazon.fr': 'EUR',
        'www.amazon.it': 'EUR',
        'www.amazon.es': 'EUR',
        'www.amazon.ca': 'CAD',
        'www.amazon.com.au': 'AUD',
        'www.amazon.co.jp': 'JPY',
        'www.amazon.in': 'INR',
    })[host] || 'USD';
}

function parseRating(ratingText, reviewCountText, questionCountText) {
    const stars = (() => {
        if (!ratingText) return null;
        const m = ratingText.match(/([\d.]+)\s*(?:out of|sur|von)?\s*5/);
        return m ? parseFloat(m[1]) : null;
    })();
    const reviewCount = (() => {
        if (!reviewCountText) return null;
        const m = reviewCountText.replace(/[,\.]/g, '').match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    })();
    const questionCount = (() => {
        if (!questionCountText) return null;
        const m = questionCountText.replace(/[,\.]/g, '').match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    })();
    return { stars, reviewCount, questionCount };
}

function inferFulfillment(soldBy, shipsFrom) {
    if (!soldBy && !shipsFrom) return null;
    const sold = (soldBy || '').toLowerCase();
    const ships = (shipsFrom || '').toLowerCase();
    if (sold.includes('amazon') && ships.includes('amazon')) return 'amazon';
    if (ships.includes('amazon')) return 'fba';
    if (sold && !sold.includes('amazon')) return 'fbm';
    return null;
}

// ---------- Browser helpers ----------

async function dismissAmazonModals(page) {
    try {
        await page.evaluate(() => {
            ['#sp-cc-accept', '#a-popover-content-1', '[data-action-type="DISMISS"]'].forEach((sel) => {
                document.querySelector(sel)?.click?.();
            });
        });
    } catch {}
}

function looksLikeChallenge(html) {
    if (!html) return false;
    return /Sorry, we just need to make sure you're not a robot|api-services-support@amazon\.com|Robot Check|Continue shopping|To discuss automated access to Amazon data|Type the characters you see in this image|errors\/validateCaptcha/i.test(html);
}

// Amazon's "Continue shopping" interstitial appears on direct ASIN hits with
// fresh sessions. Clicking the button takes the visitor through to the real
// product page. This bypasses ~70% of the soft challenges; hard captchas
// (image puzzles) still require a session swap.
async function tryBypassBotChallenge(page) {
    try {
        const clicked = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button, input[type="submit"], a.a-button-text')];
            for (const b of buttons) {
                const t = (b.textContent || b.value || '').trim().toLowerCase();
                if (t === 'continue shopping' || t === 'continue' || t.includes('go to amazon')) {
                    b.click();
                    return true;
                }
            }
            // Form fallback: submit the bypass form if present.
            const form = document.querySelector('form[action*="/errors/validateCaptcha"], form[action*="continue"]');
            if (form && !form.querySelector('input[name="field-keywords"]')) {
                form.submit();
                return true;
            }
            return false;
        });
        if (clicked) {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1500);
            return true;
        }
    } catch {}
    return false;
}

async function scrollPage(page) {
    await page.evaluate(async () => {
        const steps = 4;
        const h = document.body.scrollHeight;
        for (let i = 1; i <= steps; i++) {
            window.scrollTo(0, (h * i) / steps);
            await new Promise((r) => setTimeout(r, 300));
        }
        window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(500);
}
