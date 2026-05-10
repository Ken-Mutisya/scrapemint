// eBay Sold Listings Scraper (Comp & Resale Price Tracker)
//
// Strategy
// --------
// eBay renders sold and completed listings publicly when the SERP URL carries
// `LH_Sold=1&LH_Complete=1`. Each result card is a `<li class="s-item">` with
// a stable item ID embedded in the item link path `/itm/<itemId>`. Sale price
// is rendered in the green sold-price text; an optional strikethrough cell
// carries the original list price.
//
// We accept search keywords and optional category IDs as inputs. For each
// (query, category) pair we paginate the sold-items SERP up to
// maxListingsPerSource. Each row is normalized to one sold transaction with
// title, sold price, currency, sold date (ISO), condition, bids, shipping,
// and seller.
//
// Pay-per-event:
//   sold_listing_row ($0.005) charged when a row is pushed.
//   First 25 sold listing rows per run are free.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 25;

const REGION_HOSTS = {
    US: 'www.ebay.com',
    GB: 'www.ebay.co.uk',
    DE: 'www.ebay.de',
    AU: 'www.ebay.com.au',
    CA: 'www.ebay.ca',
    FR: 'www.ebay.fr',
    IT: 'www.ebay.it',
    ES: 'www.ebay.es',
};

const REGION_CURRENCY = {
    US: 'USD', GB: 'GBP', DE: 'EUR', AU: 'AUD',
    CA: 'CAD', FR: 'EUR', IT: 'EUR', ES: 'EUR',
};

const CONDITION_FILTER_IDS = {
    new: '1000',
    open_box: '1500',
    manufacturer_refurbished: '2000',
    seller_refurbished: '2500',
    used: '3000',
    for_parts: '7000',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    categoryIds = [],
    conditions = [],
    minPrice = 0,
    maxPrice = 0,
    daysBack = 90,
    region = 'US',
    maxListingsPerSource = 60,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
const cleanCategories = (Array.isArray(categoryIds) ? categoryIds : [categoryIds])
    .map((c) => String(c || '').trim()).filter(Boolean);
const cleanConditions = (Array.isArray(conditions) ? conditions : [conditions])
    .map((c) => String(c || '').trim().toLowerCase()).filter((c) => CONDITION_FILTER_IDS[c]);

const reg = REGION_HOSTS[region] ? region : 'US';
const baseHost = REGION_HOSTS[reg];
const defaultCurrency = REGION_CURRENCY[reg];

if (cleanQueries.length === 0 && cleanCategories.length === 0) {
    log.warning('Provide at least one keyword in `queries` or one category ID in `categoryIds`.');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const initialRequests = [];
const sources = cleanQueries.length === 0
    ? cleanCategories.map((c) => ({ query: '', categoryId: c }))
    : cleanQueries.flatMap((q) => (cleanCategories.length === 0 ? [{ query: q, categoryId: '' }] : cleanCategories.map((c) => ({ query: q, categoryId: c }))));

for (const src of sources) {
    const url = buildSearchUrl({ query: src.query, categoryId: src.categoryId, page: 1 });
    initialRequests.push({
        url,
        userData: {
            type: 'sold_serp',
            sourceKey: `q:${src.query}|cat:${src.categoryId || 'na'}`,
            query: src.query,
            categoryId: src.categoryId || null,
            page: 1,
        },
        uniqueKey: `sold:${src.query}|${src.categoryId}|1`,
    });
}

const seenItemIds = new Set();
const sourcePushed = new Map();
let totalRowsPushed = 0;

const cutoffMs = Date.now() - (Number(daysBack) * 86400000);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(10, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 5,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 200,
        sessionOptions: { maxUsageCount: 5, maxErrorScore: 1 },
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
        async ({ page, session }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            });
        },
    ],
    postNavigationHooks: [
        async ({ page, session, response }) => {
            const status = response?.status?.() ?? 0;
            if (status === 403 || status === 429) {
                session?.markBad?.();
                throw new Error(`Request blocked - received ${status} status code.`);
            }
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'sold_serp') return handleSoldSerp(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Sources: ${initialRequests.length}. Sold listings pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSoldSerp({ page, request, crawler: c }) {
    await dismissBanners(page);
    const { sourceKey, query, categoryId, page: pageNum } = request.userData;
    log.info(`Sold SERP ${sourceKey} page ${pageNum}: ${request.url}`);

    try {
        await page.waitForSelector('li.s-item, .srp-results, .srp-river-results, .s-card', { timeout: 15000 });
    } catch {
        log.warning(`Sold SERP ${sourceKey}: no result list rendered.`);
    }

    await autoScroll(page, 2);

    // Bot challenge guard. eBay serves a "Security Measure" page when their Akamai
    // layer flags the request. Detect and abort so we don't push junk.
    const pageTitle = await page.title().catch(() => '');
    if (/security measure|robot|captcha|verify/i.test(pageTitle)) {
        log.warning(`Sold SERP ${sourceKey}: Akamai bot challenge served (title: "${pageTitle}"). Marking session bad.`);
        return;
    }

    const cards = await extractSoldCards(page);
    let pushedThisPage = 0;
    let skippedOldThisPage = 0;

    for (const card of cards) {
        if (!card.itemId || seenItemIds.has(card.itemId)) continue;
        if ((sourcePushed.get(sourceKey) || 0) >= maxListingsPerSource) break;

        // Apply numeric filters.
        if (minPrice > 0 && card.soldPrice !== null && card.soldPrice < minPrice) continue;
        if (maxPrice > 0 && card.soldPrice !== null && card.soldPrice > maxPrice) continue;

        // Drop sales older than daysBack.
        if (card.soldDateMs !== null && card.soldDateMs < cutoffMs) {
            skippedOldThisPage += 1;
            continue;
        }

        seenItemIds.add(card.itemId);
        const row = buildRow(card, { query, categoryId });
        flushRow(row);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisPage += 1;
    }

    log.info(`Sold SERP ${sourceKey} page ${pageNum}: pushed ${pushedThisPage}, skipped (old) ${skippedOldThisPage}, source total ${sourcePushed.get(sourceKey) || 0}.`);

    if ((sourcePushed.get(sourceKey) || 0) < maxListingsPerSource && pushedThisPage > 0) {
        const next = pageNum + 1;
        const nextUrl = buildSearchUrl({ query, categoryId, page: next });
        await c.addRequests([{
            url: nextUrl,
            userData: { ...request.userData, page: next },
            uniqueKey: `sold:${query}|${categoryId || ''}|${next}`,
        }]);
    }
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const sel = [
                'button[aria-label*="accept" i]',
                'button[aria-label*="agree" i]',
                '#gdpr-banner-accept',
                '[class*="cookie"] button',
                'button.gdpr-banner-accept-all',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el) { el.click(); break; }
            }
        });
        await page.waitForTimeout(400);
    } catch {}
}

async function autoScroll(page, rounds = 2) {
    for (let i = 0; i < rounds; i += 1) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await page.waitForTimeout(700);
    }
}

async function extractSoldCards(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const out = [];
        const seen = new Set();

        const cards = [...document.querySelectorAll('li.s-item, li[class*="s-item"]')];
        for (const card of cards) {
            // Skip placeholder "Shop on eBay" banner item.
            if (card.querySelector('.s-item__title--tag, .s-item__title-tagblock--tag-only')) continue;

            const link = card.querySelector('a.s-item__link, a[class*="s-item__link"]');
            if (!link) continue;
            const href = link.getAttribute('href') || '';
            const m = href.match(/\/itm\/(?:[^/?#]+\/)?(\d{6,})/);
            if (!m) continue;
            const itemId = m[1];
            if (seen.has(itemId)) continue;
            seen.add(itemId);

            const url = href.startsWith('http') ? href.split('?')[0] : `https://www.ebay.com${href.split('?')[0]}`;
            const title = text(card.querySelector('.s-item__title, h3.s-item__title')) || (link.getAttribute('title') || '').trim();

            // Sold price. eBay may show a strikethrough original next to the sold price.
            // Anchor on the green "POSITIVE" or .s-item__price block. Skip strikethrough siblings.
            const priceEl = card.querySelector('.s-item__price, span.s-item__price');
            const priceText = text(priceEl);
            const { value: soldPrice, currency } = parsePrice(priceText);

            // Sold date. eBay renders a caption like "Sold  Apr 15, 2026" or "Sold  3 days ago".
            let soldDateText = null;
            const captionEls = card.querySelectorAll('.s-item__caption, .s-item__caption--row, .s-item__title--tagblock, span.POSITIVE');
            for (const el of captionEls) {
                const t = text(el);
                if (/sold/i.test(t)) { soldDateText = t; break; }
            }
            const { iso: soldDate, ms: soldDateMs } = parseSoldDate(soldDateText);

            // Condition.
            const condText = text(card.querySelector('.s-item__subtitle, .SECONDARY_INFO, .s-item__condition'));
            const condition = mapCondition(condText);

            // Auction vs Buy It Now + bid count.
            const cardText = card.textContent || '';
            const bidsMatch = cardText.match(/(\d+)\s*bids?/i);
            const bidsCount = bidsMatch ? parseInt(bidsMatch[1], 10) : null;
            const isAuction = bidsCount !== null;
            const isBuyItNow = /buy\s*it\s*now|or best offer/i.test(cardText) || (!isAuction && !!soldPrice);

            // Shipping cost.
            let shippingCost = null;
            let freeShipping = false;
            const shipText = text(card.querySelector('.s-item__shipping, .s-item__logisticsCost'));
            if (/free/i.test(shipText)) { freeShipping = true; shippingCost = 0; }
            else {
                const sp = parsePrice(shipText);
                if (sp.value !== null) shippingCost = sp.value;
            }

            // Seller name (sometimes shown).
            const sellerEl = card.querySelector('.s-item__seller-info-text, .s-item__seller, span[class*="seller"]');
            let sellerName = null;
            if (sellerEl) {
                const t = text(sellerEl);
                const sm = t.match(/^([^()\s]+)/);
                if (sm) sellerName = sm[1];
            }

            // Image.
            const img = card.querySelector('img');
            const imageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || null;

            out.push({
                itemId,
                url,
                title,
                soldPrice,
                currency,
                soldDate,
                soldDateMs,
                soldDateText,
                condition,
                isAuction,
                isBuyItNow,
                bidsCount,
                shippingCost,
                freeShipping,
                sellerName,
                imageUrl,
            });
        }

        return out;

        function parsePrice(s) {
            if (!s) return { value: null, currency: null };
            const txt = String(s).trim();
            const symMatch = txt.match(/([£$€¥A-Z]{1,3}|\b(?:USD|GBP|EUR|AUD|CAD|JPY)\b)/);
            const numMatch = txt.match(/-?[\d,]+(?:\.\d+)?/);
            if (!numMatch) return { value: null, currency: null };
            const val = parseFloat(numMatch[0].replace(/,/g, ''));
            if (!Number.isFinite(val)) return { value: null, currency: null };
            const sym = symMatch ? symMatch[1] : '';
            const currency = sym === '$' ? 'USD'
                : sym === '£' ? 'GBP'
                : sym === '€' ? 'EUR'
                : sym === '¥' ? 'JPY'
                : (sym && sym.length === 3) ? sym
                : null;
            return { value: val, currency };
        }

        function parseSoldDate(s) {
            if (!s) return { iso: null, ms: null };
            const cleaned = s.replace(/sold/i, '').trim();
            // "X days ago" form.
            const rel = cleaned.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);
            if (rel) {
                const n = parseInt(rel[1], 10);
                const unit = rel[2].toLowerCase();
                const ms = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[unit];
                if (ms) {
                    const t = Date.now() - n * ms;
                    return { iso: new Date(t).toISOString().slice(0, 10), ms: t };
                }
            }
            // "Apr 15, 2026" or "15 Apr 2026" form.
            const monthAbbr = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
            const lower = cleaned.toLowerCase();
            const m1 = lower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/);
            const m2 = lower.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/);
            const pm = m1 || m2;
            if (pm) {
                let day, month, year;
                if (m1) { month = monthAbbr[m1[1]]; day = parseInt(m1[2], 10); year = m1[3] ? parseInt(m1[3], 10) : (new Date()).getUTCFullYear(); }
                else { day = parseInt(m2[1], 10); month = monthAbbr[m2[2]]; year = m2[3] ? parseInt(m2[3], 10) : (new Date()).getUTCFullYear(); }
                const t = Date.UTC(year, month, day);
                return { iso: new Date(t).toISOString().slice(0, 10), ms: t };
            }
            return { iso: null, ms: null };
        }

        function mapCondition(t) {
            if (!t) return null;
            const s = t.toLowerCase();
            if (s.includes('brand new') || /\bnew\b/.test(s)) return 'new';
            if (s.includes('open box')) return 'open_box';
            if (s.includes('manufacturer refurbished')) return 'manufacturer_refurbished';
            if (s.includes('seller refurbished') || s.includes('refurbished')) return 'seller_refurbished';
            if (s.includes('pre-owned') || s.includes('preowned') || s.includes('used')) return 'used';
            if (s.includes('parts') || s.includes('not working')) return 'for_parts';
            return null;
        }
    });
}

// ---------- Routing ----------

function buildRow(card, ctx) {
    return {
        itemId: card.itemId,
        url: card.url,
        title: card.title || null,
        soldPrice: card.soldPrice,
        currency: card.currency || defaultCurrency,
        soldDate: card.soldDate,
        soldDateText: card.soldDateText || null,
        condition: card.condition || null,
        isAuction: !!card.isAuction,
        isBuyItNow: !!card.isBuyItNow,
        bidsCount: card.bidsCount,
        shippingCost: card.shippingCost,
        freeShipping: !!card.freeShipping,
        sellerName: card.sellerName || null,
        imageUrl: card.imageUrl || null,
        region: reg,
        searchQuery: ctx.query || null,
        categoryId: ctx.categoryId || null,
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

// ---------- URL helpers ----------

function buildSearchUrl({ query, categoryId, page }) {
    const params = new URLSearchParams();
    if (query) params.set('_nkw', query);
    if (categoryId) params.set('_sacat', String(categoryId));
    params.set('LH_Sold', '1');
    params.set('LH_Complete', '1');
    params.set('_ipg', '120');
    params.set('_sop', '13'); // ended recently first
    if (page && page > 1) params.set('_pgn', String(page));
    if (cleanConditions.length > 0) {
        const ids = cleanConditions.map((c) => CONDITION_FILTER_IDS[c]).filter(Boolean).join('|');
        if (ids) params.set('LH_ItemCondition', ids);
    }
    return `https://${baseHost}/sch/i.html?${params.toString()}`;
}
