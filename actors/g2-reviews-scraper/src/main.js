// G2 Product Reviews Scraper (No Login)
//
// Strategy
// --------
// G2 exposes the product overview, pricing, features, and the first page of
// reviews to anonymous visitors at:
//   * /products/{slug}            (overview + aggregate ratings)
//   * /products/{slug}/reviews    (review snippets + star distribution + cons)
//   * /products/{slug}/pricing    (pricing tiers when listed)
//
// We anchor on the product slug parsed from any of those URLs, hit the
// reviews surface (which already contains overview signals + the snippet
// list), optionally fetch the pricing surface, and ship one row per product.
// Schema.org metadata (`itemprop="ratingValue"`, `aggregateRating`) is the
// most stable signal so we read JSON-LD first and fall back to defensive
// DOM selectors for the rest.
//
// Pay-per-event:
//   product_intel ($0.04) charged when a product row is pushed.
//   First 3 product rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_PRODUCTS = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    productUrls = [],
    includeReviews = true,
    reviewsPerProduct = 15,
    includeFeatures = true,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const products = [];
for (const raw of productUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseG2Url(String(v).trim());
    if (parsed && !products.some((p) => p.slug === parsed.slug)) products.push(parsed);
}

if (products.length === 0) {
    log.warning('No valid G2 product URLs provided. Examples: https://www.g2.com/products/notion/reviews, https://www.g2.com/products/figma/reviews');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const productBySlug = new Map(products.map((p) => [p.slug, p]));
const partials = new Map();
const stages = new Map(); // slug -> { reviews: bool, pricing: bool, pushed: bool }
const pushed = new Set();

for (const p of products) {
    stages.set(p.slug, { reviews: false, pricing: false, pushed: false });
}

const initialRequests = products.map((p) => ({
    url: p.reviewsUrl,
    userData: { type: 'reviews', slug: p.slug },
    uniqueKey: `reviews:${p.slug}`,
}));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(10, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 5, maxErrorScore: 1 },
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
        if (t === 'reviews') return handleReviews(ctx);
        if (t === 'pricing') return handlePricing(ctx);
    },
    async failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
        const slug = request.userData?.slug;
        const t = request.userData?.type;
        if (slug && t) {
            const s = stages.get(slug);
            if (s && !s[t]) {
                s[t] = true;
                await tryFlush(slug);
            }
        }
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Products requested: ${products.length}. Products pushed: ${pushed.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleReviews({ page, request, crawler: c }) {
    const product = productBySlug.get(request.userData.slug);
    if (!product) return;

    await dismissBanners(page);

    try {
        await page.waitForSelector('main, [itemprop="aggregateRating"], h1, [data-eventid]', { timeout: 12000 });
    } catch {}

    const data = await extractReviewsPage(page, reviewsPerProduct, includeReviews, includeFeatures);
    const partial = partials.get(product.slug) ?? blankRow(product);
    Object.assign(partial, normalizeReviewsPage(data));
    partials.set(product.slug, partial);

    const s = stages.get(product.slug);
    s.reviews = true;

    // Pricing page is optional and adds latency; we only fetch when we need it.
    // The reviews/overview surface usually carries a pricing summary already.
    const needsPricing = !partial.pricingTiers || partial.pricingTiers.length === 0;
    if (needsPricing) {
        await c.addRequests([{
            url: product.pricingUrl,
            userData: { type: 'pricing', slug: product.slug },
            uniqueKey: `pricing:${product.slug}`,
        }]);
    } else {
        s.pricing = true;
    }

    await tryFlush(product.slug);
}

async function handlePricing({ page, request }) {
    const product = productBySlug.get(request.userData.slug);
    if (!product) return;
    await dismissBanners(page);

    try {
        await page.waitForSelector('main, h1', { timeout: 10000 });
    } catch {}

    const tiers = await extractPricingTiers(page);
    const partial = partials.get(product.slug) ?? blankRow(product);
    if (tiers && tiers.length) partial.pricingTiers = tiers;
    partials.set(product.slug, partial);

    const s = stages.get(product.slug);
    s.pricing = true;
    await tryFlush(product.slug);
}

// ---------- Flush ----------

// pushData and charge must be awaited so a fast actor exit cannot drop the
// buffered write/charge (see forexfactory feed-path bug, 2026-06-27).
async function tryFlush(slug) {
    const s = stages.get(slug);
    if (!s || s.pushed) return;
    if (!s.reviews) return;
    if (!s.pricing) return;

    const row = partials.get(slug);
    if (!row) return;

    if (!includeReviews) row.reviews = [];
    row.scrapedAt = new Date().toISOString();

    s.pushed = true;
    pushed.add(slug);

    await Actor.pushData(row);
    if (pushed.size > FREE_TIER_PRODUCTS) {
        try {
            await Actor.charge({ eventName: 'product_intel' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
    log.info(`Pushed ${slug} ${row.productName ?? ''}: rating=${row.rating ?? '?'}, reviews=${row.reviews.length}, tiers=${row.pricingTiers.length}.`);
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const close = document.querySelector('[aria-label="Close"], button.modal__close, .cky-btn-accept, #onetrust-accept-btn-handler');
            if (close) close.click();
        });
    } catch {}
}

async function extractReviewsPage(page, max, withReviews, withFeatures) {
    return page.evaluate(({ max, withReviews, withFeatures }) => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const meta = (prop) => sel(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || null;

        // 1. JSON-LD aggregate rating + product/vendor identity.
        const ldJson = [];
        all('script[type="application/ld+json"]').forEach((s) => {
            try {
                const parsed = JSON.parse(s.textContent || 'null');
                if (Array.isArray(parsed)) ldJson.push(...parsed);
                else if (parsed) {
                    if (Array.isArray(parsed['@graph'])) ldJson.push(...parsed['@graph']);
                    else ldJson.push(parsed);
                }
            } catch {}
        });

        const productLd = ldJson.find((x) => {
            const t = x?.['@type'];
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => /SoftwareApplication|Product|Service/i.test(tt || ''));
        }) || null;

        const orgLd = ldJson.find((x) => {
            const t = x?.['@type'];
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => /Organization|Brand/i.test(tt || ''));
        }) || null;

        const productName = productLd?.name
            || text(sel('h1, [itemprop="name"]'))
            || meta('og:title')
            || null;

        const vendorName = productLd?.brand?.name
            || productLd?.manufacturer?.name
            || orgLd?.name
            || null;

        const rating = numeric(productLd?.aggregateRating?.ratingValue)
            ?? numeric(text(sel('[itemprop="ratingValue"], .rating-overall, .stars-rating-overall')));

        const reviewCount = parseIntSafe(productLd?.aggregateRating?.reviewCount ?? productLd?.aggregateRating?.ratingCount)
            ?? parseIntSafe(text(sel('[itemprop="reviewCount"], [itemprop="ratingCount"]')))
            ?? parseIntSafe((text(sel('a[href*="/reviews"], .ratings-count, .reviews-count')) || '').replace(/[^\d]/g, ''));

        const description = productLd?.description
            || meta('og:description')
            || text(sel('.product-description, [data-test="product-description"]'))
            || null;

        const websiteUrl = productLd?.url
            || sel('a[href*="utm_source=g2"], a[data-eventid*="vendor_url"], a.product-vendor__link')?.getAttribute('href')
            || null;

        // 2. Star distribution (5..1 percentage breakdown).
        const starDistribution = {};
        for (let star = 5; star >= 1; star -= 1) {
            const row = sel(`[data-star="${star}"], [data-rating="${star}"], li.rating-distribution__row[data-star="${star}"]`)
                || all('li, tr, .rating-bar').find(el => new RegExp(`^${star}\\s*star`, 'i').test(text(el)));
            if (!row) continue;
            const t = text(row);
            const m = t.match(/(\d{1,3})\s*%/);
            if (m) starDistribution[String(star)] = parseInt(m[1], 10);
        }

        // 3. Top features and most-mentioned pros/cons aggregate (G2 surfaces these
        //    as a curated block above the snippets).
        let topPros = [];
        let topCons = [];
        let topFeatures = [];
        if (withFeatures) {
            const aggregateBlocks = all('section, div').filter((el) => {
                const h = text(sel('h2, h3, h4, [data-test*="title"]', el));
                return /pros|cons|features|what users like|what users dislike/i.test(h);
            });
            for (const block of aggregateBlocks) {
                const heading = text(sel('h2, h3, h4, [data-test*="title"]', block)).toLowerCase();
                const items = all('li, .topic-pill, [data-test*="pill"], .label', block)
                    .map((li) => {
                        const label = text(sel('a, span', li) || li).replace(/\s*\d[\d,]*\s*$/, '').trim();
                        const countMatch = text(li).match(/(\d[\d,]*)\s*$/);
                        const count = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
                        return label ? { label, count } : null;
                    })
                    .filter(Boolean)
                    .slice(0, 12);
                if (!items.length) continue;
                if (/dislike|cons/i.test(heading)) topCons = topCons.length ? topCons : items;
                else if (/like|pros/i.test(heading)) topPros = topPros.length ? topPros : items;
                else if (/features/i.test(heading)) topFeatures = topFeatures.length ? topFeatures : items;
            }
        }

        // 4. Pricing tiers if surfaced on the reviews/overview page (sometimes the
        //    "Plans & Pricing" rail is rendered inline). We capture name + price.
        const pricingTiers = [];
        const tierBlocks = all('[data-test*="pricing"], .pricing-table__tier, .plan-card, .pricing-card');
        for (const t of tierBlocks) {
            const name = text(sel('h3, h4, .plan-card__title, [data-test*="plan-name"]', t));
            const price = text(sel('.plan-card__price, [data-test*="plan-price"], .price', t));
            if (!name) continue;
            pricingTiers.push({ name, price: price || null });
            if (pricingTiers.length >= 8) break;
        }

        // 5. Review snippets (first page only).
        const reviews = [];
        if (withReviews) {
            const cards = all('[itemprop="review"], article[itemtype*="Review"], .paper--white[data-eventid*="review"], .Container__container .paper');
            for (const card of cards) {
                const cardText = card.textContent || '';
                if (!/(rating|review|pros|cons)/i.test(cardText)) continue;

                const titleEl = sel('[itemprop="name"], h3, h4, .review-title', card);
                const title = text(titleEl);

                const ratingNode = sel('[itemprop="ratingValue"], .stars, .rating', card);
                const rate = numeric(ratingNode?.getAttribute?.('content')) ?? numeric(text(ratingNode));

                const pros = pickAfterLabel(card, /What do you like best/i)
                    || text(sel('[data-test*="pros"], .review-pros', card));
                const cons = pickAfterLabel(card, /What do you dislike/i)
                    || text(sel('[data-test*="cons"], .review-cons', card));
                const useCase = pickAfterLabel(card, /What problems is .* solving|recommendations to others/i);

                const reviewer = text(sel('[itemprop="author"], .reviewer__name, .author', card));
                const role = text(sel('[itemprop="jobTitle"], .reviewer__role, .author-info__role', card));
                const industry = text(sel('.reviewer__industry, [data-test*="industry"]', card));
                const companySize = text(sel('.reviewer__company-size, [data-test*="company-size"]', card));
                const dateEl = sel('time, [itemprop="datePublished"], .review-date', card);
                const date = dateEl?.getAttribute?.('datetime') || text(dateEl) || null;

                if (!title && !pros && !cons) continue;
                reviews.push({ title, rating: rate, pros, cons, useCase, reviewer, role, industry, companySize, date });
                if (reviews.length >= max) break;
            }
        }

        return {
            productName,
            vendorName,
            description,
            websiteUrl,
            rating,
            reviewCount,
            starDistribution,
            topPros,
            topCons,
            topFeatures,
            pricingTiers,
            reviews,
        };

        function pickAfterLabel(card, labelRe) {
            const labels = [...card.querySelectorAll('h5, .label, strong, dt, [class*="label"]')];
            for (const l of labels) {
                if (labelRe.test(l.textContent || '')) {
                    const sib = l.nextElementSibling || l.parentElement?.nextElementSibling;
                    const t = (sib?.textContent || '').replace(/\s+/g, ' ').trim();
                    if (t) return t;
                }
            }
            return null;
        }
        function numeric(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
            return Number.isFinite(n) ? n : null;
        }
        function parseIntSafe(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
            return Number.isFinite(n) ? n : null;
        }
    }, { max, withReviews, withFeatures });
}

async function extractPricingTiers(page) {
    return page.evaluate(() => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const tiers = [];
        const blocks = all('[data-test*="pricing"], .pricing-table__tier, .plan-card, .pricing-card, .pricing-edition__tier');
        for (const b of blocks) {
            const name = text(sel('h3, h4, .plan-card__title, [data-test*="plan-name"], .pricing-edition__title', b));
            const price = text(sel('.plan-card__price, [data-test*="plan-price"], .price, .pricing-edition__price', b));
            const billing = text(sel('.pricing-edition__billing, [data-test*="billing"]', b));
            const includes = all('li, .feature-item', b).map((li) => text(li)).filter(Boolean).slice(0, 12);
            if (!name) continue;
            tiers.push({ name, price: price || null, billing: billing || null, includes });
            if (tiers.length >= 10) break;
        }
        return tiers;
    });
}

// ---------- Normalization ----------

function blankRow(product) {
    return {
        slug: product.slug,
        url: product.canonicalUrl,
        reviewsUrl: product.reviewsUrl,
        pricingUrl: product.pricingUrl,
        productName: null,
        vendorName: null,
        description: null,
        websiteUrl: null,
        rating: null,
        reviewCount: null,
        starDistribution: {},
        topPros: [],
        topCons: [],
        topFeatures: [],
        pricingTiers: [],
        reviews: [],
        scrapedAt: null,
    };
}

function normalizeReviewsPage(d) {
    return {
        productName: d.productName || null,
        vendorName: d.vendorName || null,
        description: d.description || null,
        websiteUrl: d.websiteUrl || null,
        rating: d.rating ?? null,
        reviewCount: d.reviewCount ?? null,
        starDistribution: d.starDistribution || {},
        topPros: Array.isArray(d.topPros) ? d.topPros : [],
        topCons: Array.isArray(d.topCons) ? d.topCons : [],
        topFeatures: Array.isArray(d.topFeatures) ? d.topFeatures : [],
        pricingTiers: Array.isArray(d.pricingTiers) ? d.pricingTiers : [],
        reviews: Array.isArray(d.reviews) ? d.reviews : [],
    };
}

// ---------- URL helpers ----------

function parseG2Url(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)g2\.com$/.test(host)) return null;

    const m = u.pathname.match(/^\/products\/([^/]+)/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).toLowerCase();

    const base = `${u.protocol}//${host}`;
    const overviewUrl = `${base}/products/${slug}`;
    const reviewsUrl = `${base}/products/${slug}/reviews`;
    const pricingUrl = `${base}/products/${slug}/pricing`;
    const featuresUrl = `${base}/products/${slug}/features`;

    return {
        slug,
        canonicalUrl: overviewUrl,
        overviewUrl,
        reviewsUrl,
        pricingUrl,
        featuresUrl,
    };
}
