// Amazon Product Scraper: products from Amazon search results, Best Sellers
// and New Releases lists, or product URLs / ASINs, on amazon.com and
// amazon.ca: price, list price, rating, reviews, "bought in past month",
// badges, and optionally the full product page (brand, bullets, specs, Best
// Sellers Rank, seller, availability, images, variations).
//
// Strategy
// --------
// Search pages (/s?k=...) are server-rendered: each result is a
// <div role="listitem" data-asin data-component-type="s-search-result"> card
// with the title (h2 aria-label), price (a-price > a-offscreen), list price
// (a-text-price), rating ("4.5 out of 5 stars"), rating count ("5,248
// ratings"), "5K+ bought in past month", badges, coupon and delivery text.
// Amazon serves at most ~7 pages (48 per page) per search, so searches asked
// for more are read across price windows (low-price/high-price) round-robin.
//
// Best Sellers / New Releases / Movers & Shakers pages list 50 products a
// page (pg=1,2) in data-client-recs-list (ASIN + rank); the first 30 are
// rendered as cards, the rest load by script, so those are filled from their
// product pages.
//
// Product pages (/dp/ASIN) carry #productTitle, #bylineInfo, the core price
// block, #acrPopover, #feature-bullets, the breadcrumb, product details
// (prodDetSectionEntry rows, detailBullets, productOverview), #availability,
// merchant and fulfiller info, colorImages and the twister.
//
// No key, no proxy: amazon.com and amazon.ca answered Apify's IPs on 50 of 50
// search, product and list requests in the 2026-10-09 probes, with no delay.
// Other Amazon sites (.co.uk, .de, .fr, .in, .com.au) return 503 to Apify's
// IPs without a proxy, so they are not offered.
//
// Pay per event
// -------------
//   product        ($0.002) one product from a search or list page
//   product_detail ($0.004) one product with its product page read
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MARKETS = { US: 'www.amazon.com', CA: 'www.amazon.ca' };
const SORTS = { relevance: 'relevanceblender', priceAsc: 'price-asc-rank', priceDesc: 'price-desc-rank', reviews: 'review-rank', newest: 'date-desc-rank', bestSellers: 'exact-aware-popularity-rank' };
const WINDOWS = [[0, 10], [10, 20], [20, 30], [30, 50], [50, 75], [75, 100], [100, 150], [150, 250], [250, 500], [500, 1000], [1000, 100000]];
const MAX_PAGES = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    startUrls = [],
    asins = [],
    marketplace = 'US',
    sort = 'relevance',
    minPrice = null,
    maxPrice = null,
    includeDetails = false,
    maxItemsPerSearch = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 100);
const market = MARKETS[String(marketplace).toUpperCase()] ? String(marketplace).toUpperCase() : 'US';
const HOST = MARKETS[market];
const SITE = `https://${HOST}`;

async function get(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': market === 'CA' ? 'en-CA,en;q=0.9' : 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(45_000) });
            if (r.status === 404) return null;
            const t = await r.text();
            // A captcha page is ~5 KB and has no nav; real pages are 400 KB+.
            if (r.ok && t.length > 50_000 && !/\/errors\/validateCaptcha/.test(t)) return t;
            last = new Error(r.ok ? 'Captcha page' : `HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2500 * 2 ** attempt + Math.random() * 1000);
    }
    throw last;
}

// ---------- Helpers ----------

const decode = (s) => String(s ?? '').replace(/&rlm;|&lrm;/g, '').replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/[‎‏]/g, '');
const text = (h) => decode(String(h ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const money = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const count = (s) => {
    const m = String(s ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
    if (!m) return null;
    return Math.round(Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1000 : 1_000_000) : 1));
};
const currencyOf = (s) => (/CA\$|C\$/.test(s) || market === 'CA' ? 'CAD' : /\$/.test(s) ? 'USD' : null);
const productUrl = (asin) => `${SITE}/dp/${asin}`;

function section(html, id, len = 60_000) {
    const i = html.indexOf(`id="${id}"`);
    return i < 0 ? '' : html.slice(i, i + len);
}

// ---------- Search cards ----------

function parseCards(html) {
    const starts = [...html.matchAll(/<div role="listitem" data-asin="(\w{10})"/g)].map((m) => m.index);
    const out = [];
    for (let k = 0; k < starts.length; k++) {
        const c = html.slice(starts[k], starts[k + 1] ?? starts[k] + 60_000);
        if (!c.includes('data-component-type="s-search-result"')) continue;
        const asin = c.match(/data-asin="(\w{10})"/)[1];
        const title = decode(c.match(/<h2[^>]*aria-label="([^"]+)"/)?.[1] || text(c.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]) || '');
        const prices = [...c.matchAll(/<span class="a-price(?: [^"]*)?"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/g)].map((m) => decode(m[1]));
        const strike = decode(c.match(/<span class="a-price a-text-price"[^>]*data-a-strike="true"[^>]*>\s*<span class="a-offscreen">([^<]+)/)?.[1] || '');
        const priceText = prices.find((p) => p !== strike && !/^List/.test(p)) || null;
        const rating = Number(c.match(/aria-label="([\d.]+) out of 5 stars/)?.[1]) || null;
        const reviews = count(c.match(/aria-label="([\d,.]+K?) ratings?"/)?.[1]);
        const bought = decode(c.match(/>\s*([\d.,]+[KkMm]?\+? bought in past (?:month|week))/)?.[1] || '') || null;
        const badges = [...new Set([...c.matchAll(/rio-badge-label[^>]*><span[^>]*>([^<]+)</g)].map((m) => decode(m[1]).trim())
            .concat(/Amazon's\s*<\/span>\s*<span[^>]*>Choice|Amazon&#x27;s Choice|Amazon's Choice/.test(c) ? ["Amazon's Choice"] : [])
            .concat(/Overall Pick/.test(c) ? ['Overall Pick'] : [])
            .concat(/Limited time deal/.test(c) ? ['Limited time deal'] : []))];
        const coupon = text(c.match(/class="[^"]*s-coupon[^"]*"[^>]*>([\s\S]{0,600}?)<\/span>\s*<\/span>/)?.[1] || '') || (c.match(/(Save [\d.$%]+[^<]{0,20}with coupon|\$[\d.,]+ off coupon applied)/)?.[1] ?? null);
        const delivery = text(c.match(/data-cy="delivery-recipe"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1] || '') || null;
        out.push({
            asin,
            url: productUrl(asin),
            title: title || null,
            price: money(priceText),
            listPrice: money(strike) || null,
            currency: priceText ? currencyOf(priceText) : null,
            priceText,
            rating,
            reviewsCount: reviews,
            boughtPastMonth: bought,
            badges,
            isBestSeller: badges.includes('Best Seller'),
            isAmazonsChoice: badges.includes("Amazon's Choice"),
            isSponsored: /puis-sponsored-label|>Sponsored</.test(c),
            isPrime: /aria-label="Amazon Prime"|a-icon-prime/.test(c),
            coupon: coupon ? coupon.replace(/\s+/g, ' ').trim() : null,
            delivery: delivery ? delivery.replace(/\s+/g, ' ').slice(0, 200) : null,
            imageUrl: c.match(/<img class="s-image" src="([^"]+)"/)?.[1] || null,
            variationsCount: Number(c.match(/\+(\d+)\s*</)?.[1]) || null,
            position: Number(c.match(/data-index="(\d+)"/)?.[1]) || null,
        });
    }
    return out;
}

function resultTotal(html) {
    const t = text(html.match(/<span[^>]*>([\d,]+-[\d,]+ of (?:over )?[\d,]+ results)/)?.[1] || '');
    const m = t.match(/of (over )?([\d,]+)/);
    return m ? { total: Number(m[2].replace(/,/g, '')), over: !!m[1] } : null;
}

const hasNext = (html) => /class="s-pagination-item s-pagination-next s-pagination-button/.test(html) && !/s-pagination-next s-pagination-disabled/.test(html);

// ---------- Best Sellers ----------

function parseList(html) {
    const recs = (() => { try { return JSON.parse(decode(html.match(/data-client-recs-list="([^"]+)"/)?.[1] || '[]')); } catch { return []; } })();
    const cards = new Map();
    const starts = [...html.matchAll(/id="gridItemRoot"/g)].map((m) => m.index);
    for (let k = 0; k < starts.length; k++) {
        const c = html.slice(starts[k], starts[k + 1] ?? starts[k] + 20_000);
        const asin = c.match(/data-asin="(\w{10})"/)?.[1] || c.match(/\/dp\/(\w{10})/)?.[1];
        if (!asin) continue;
        const priceText = decode(c.match(/class="[^"]*(?:p13n-sc-price|_cDEzb_p13n-sc-price_[^"]*)"[^>]*>([^<]+)</)?.[1] || c.match(/<span class="a-color-price">\s*<span[^>]*>([^<]+)</)?.[1] || '') || null;
        cards.set(asin, {
            title: decode(c.match(/<img alt="([^"]+)"/)?.[1] || '') || null,
            price: money(priceText),
            currency: priceText ? currencyOf(priceText) : null,
            priceText,
            rating: Number(c.match(/([\d.]+) out of 5 stars/)?.[1]) || null,
            reviewsCount: count(c.match(/out of 5 stars, ([\d,]+) ratings?/)?.[1] || c.match(/<span[^>]*class="a-size-small">([\d,]+)<\/span>/)?.[1]),
            imageUrl: c.match(/<img[^>]+src="([^"]+)"/)?.[1] || null,
            byline: text(c.match(/<div class="a-row a-size-small">([\s\S]*?)<\/div>/)?.[1] || '') || null,
        });
    }
    const heads = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => text(m[1]));
    const category = heads.find((t) => / in /.test(t)) || heads[0] || null;
    return {
        category,
        items: recs.map((r) => ({ asin: r.id, rank: Number(r.metadataMap?.['render.zg.rank']) || null, card: cards.get(r.id) || null })),
    };
}

// ---------- Product page ----------

function parseProduct(html, asin) {
    const core = section(html, 'corePriceDisplay_desktop_feature_div', 30_000) || section(html, 'corePrice_feature_div', 20_000) || section(html, 'apex_desktop', 30_000);
    const pay = html.match(/priceToPay[^"]*"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/)?.[1]
        || core.match(/<span class="a-offscreen">([^<]+)<\/span>/)?.[1]
        || (() => { const w = core.match(/a-price-whole">([\d,]+)/)?.[1]; const f = core.match(/a-price-fraction">(\d+)/)?.[1]; return w ? `$${w}.${f || '00'}` : ''; })();
    const coreText = text(core.slice(0, 15_000));
    const listPrice = money(coreText.match(/(?:List Price|List|Typical price|Was Price|Was):?\s*(?:CDN\$|C\$|\$)\s?([\d,.]+)/)?.[1]);
    const details = {};
    for (const m of html.matchAll(/<th class="[^"]*prodDetSectionEntry[^"]*">([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
        const k = text(m[1]); const v = text(m[2]);
        if (k && v && !details[k]) details[k] = v.replace(/\s+/g, ' ').slice(0, 1000);
    }
    for (const m of section(html, 'detailBullets_feature_div', 40_000).matchAll(/<span class="a-text-bold">([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/g)) {
        const k = text(m[1]).replace(/[\s:]+$/, ''); const v = text(m[2]);
        if (k && v && !details[k]) details[k] = v.replace(/\s+/g, ' ').slice(0, 1000);
    }
    const overview = {};
    for (const m of section(html, 'productOverview_feature_div', 30_000).matchAll(/<span class="a-size-base a-text-bold">([\s\S]*?)<\/span>[\s\S]*?<span class="a-size-base po-break-word">([\s\S]*?)<\/span>/g)) overview[text(m[1])] = text(m[2]);
    const bsrText = details['Best Sellers Rank'] || text((html.match(/Best Sellers Rank[\s\S]{0,4000}?<\/ul>/) || html.match(/Best Sellers Rank[\s\S]{0,3000}?(?:<\/td>|<\/li>)/) || [''])[0]);
    const ranks = [...bsrText.matchAll(/#([\d,]+) in ([^#(]+?)(?=\s*\(|\s*#|$)/g)].map((m) => ({ rank: Number(m[1].replace(/,/g, '')), category: m[2].trim() }));
    const images = (() => {
        const m = html.match(/'colorImages':\s*\{\s*'initial':\s*(\[[\s\S]*?\])\s*\}/);
        if (!m) return [];
        try { return JSON.parse(m[1]).map((x) => x.hiRes || x.large).filter(Boolean); } catch { return []; }
    })();
    // Books and media keep their cover in data-a-dynamic-image instead.
    if (!images.length) {
        const dyn = html.match(/id="(?:landingImage|imgBlkFront|ebooksImgBlkFront)"[^>]*data-a-dynamic-image="([^"]+)"/)?.[1];
        try { if (dyn) images.push(...Object.keys(JSON.parse(decode(dyn))).sort((a, b) => b.length - a.length).slice(0, 1)); } catch { /* none */ }
    }
    const bullets = [...section(html, 'feature-bullets', 20_000).matchAll(/<span class="a-list-item">([\s\S]*?)<\/span>/g)].map((m) => text(m[1])).filter((x) => x && x.length > 3);
    const crumbSeg = section(html, 'wayfinding-breadcrumbs_feature_div', 8000);
    const crumbs = [...crumbSeg.slice(0, Math.max(0, crumbSeg.indexOf('</ul>'))).matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1])).filter(Boolean);
    const byline = text(section(html, 'bylineInfo', 3000).match(/<a[^>]*id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/)?.[1] || html.match(/<a id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    const brand = overview.Brand || details.Brand || details.Manufacturer || byline.replace(/^(Visit the |Brand: )/, '').replace(/ Store$/, '') || null;
    // "Sold by" / "Ships from" boxes; a single "Shipper / Seller" box means both.
    const feature = (name) => {
        const i = html.search(new RegExp(`class="offer-display-feature-text[^"]*"[^>]*offer-display-feature-name="${name}"`));
        return i < 0 ? null : text(html.slice(i, i + 4000).match(/offer-display-feature-text-message">([\s\S]*?)<\/span>/)?.[1] || '') || null;
    };
    const merchant = feature('desktop-merchant-info');
    const shipsFrom = feature('desktop-fulfiller-info') || (/Shipper \/ Seller/.test(html) ? merchant : null);
    const variations = [...new Set([...html.matchAll(/<li[^>]*data-asin="(\w{10})"[^>]*data-csa-c-content-id="twister/g)].map((m) => m[1]))];
    const descr = text(section(html, 'productDescription', 20_000).match(/<p>([\s\S]*?)<\/p>|<span>([\s\S]*?)<\/span>/)?.slice(1).find(Boolean) || '')
        || text(section(html, 'bookDescription_feature_div', 30_000).match(/<div[^>]*a-expander-content[^>]*>([\s\S]*?)<\/div>/)?.[1] || '');
    const avail = text(section(html, 'availability', 3000).match(/<span[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    return {
        asin,
        url: productUrl(asin),
        title: text(html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '') || null,
        brand,
        price: money(pay) || null,
        listPrice: listPrice && money(pay) && listPrice > money(pay) ? listPrice : null,
        savingsPercent: Number(core.match(/savingsPercentage[^>]*>-?(\d+)%/)?.[1]) || null,
        currency: pay ? currencyOf(pay) : null,
        rating: Number(html.match(/id="acrPopover"[^>]*title="([\d.]+) out of 5 stars/)?.[1]) || null,
        reviewsCount: count(text(html.match(/id="acrCustomerReviewText"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '')),
        boughtPastMonth: text(html.match(/id="social-proofing-faceout-title-tk_bought"[^>]*>([\s\S]*?)<\/span>\s*<\/span>|id="social-proofing-faceout-title-tk_bought"[\s\S]{0,300}?>([^<]*bought[^<]*)</)?.slice(1).find(Boolean) || '') || null,
        badge: (() => {
            // The badge sits in a sibling of the (often empty) acBadge widget.
            const i = html.indexOf('id="acBadge_feature_div"');
            const t = i < 0 ? '' : text(html.slice(i, i + 8000)).replace(/\s+/g, ' ');
            const bs = t.match(/#\d+ Best Seller in (.{2,80}?)(?= [\d.,]+[KkMm]?\+? bought| [A-Z][a-z]+ [a-z]| ?$)/)?.[0];
            if (bs) return bs.trim();
            return /ac-badge-text-primary|"acBadgeLabel"/.test(html.slice(i, i + 8000)) ? "Amazon's Choice" : null;
        })(),
        availability: avail || null,
        inStock: avail ? !/unavailable|out of stock/i.test(avail) : null,
        soldBy: merchant,
        shipsFrom,
        categories: crumbs,
        bestSellersRank: ranks,
        features: bullets,
        description: descr || null,
        overview,
        details,
        images,
        mainImage: images[0] || null,
        variationAsins: variations,
        parentAsin: html.match(/"parentAsin":"(\w{10})"/)?.[1] || null,
        dateFirstAvailable: details['Date First Available'] || null,
        manufacturer: details.Manufacturer || null,
        modelNumber: details['Item model number'] || null,
    };
}

// ---------- Inputs ----------

function classify(u) {
    let url;
    try { url = new URL(u); } catch { return /^\w{10}$/.test(u) ? { kind: 'asin', asin: u.toUpperCase() } : null; }
    if (!/amazon\.(com|ca)$/.test(url.hostname)) return { error: `Only amazon.com and amazon.ca are supported: ${u}` };
    const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/(\w{10})/)?.[1];
    if (asin) return { kind: 'asin', asin };
    if (/\/(zgbs|bestsellers|new-releases|movers-and-shakers|most-wished-for|most-gifted)\b/.test(url.pathname) || /\/gp\/(bestsellers|new-releases|movers-and-shakers)/.test(url.pathname)) return { kind: 'list', url: `${url.origin}${url.pathname}`, label: u };
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
        const params = Object.fromEntries(url.searchParams);
        delete params.page; delete params.ref; delete params.qid; delete params.crid; delete params.sprefix;
        return { kind: 'search', params, label: u };
    }
    return { error: `Not an Amazon search, list or product URL: ${u}` };
}

function buildJobs() {
    const jobs = [];
    const asinRows = [];
    for (const u of [...list(startUrls), ...list(asins)]) {
        const c = classify(u);
        if (!c) jobs.push({ error: `Not an Amazon URL or ASIN: ${u}` });
        else if (c.kind === 'asin') asinRows.push(c.asin);
        else jobs.push(c);
    }
    for (const q of list(searchQueries)) {
        const params = { k: q };
        if (SORTS[sort] && sort !== 'relevance') params.s = SORTS[sort];
        if (minPrice != null && minPrice !== '') params['low-price'] = String(minPrice);
        if (maxPrice != null && maxPrice !== '') params['high-price'] = String(maxPrice);
        jobs.push({ kind: 'search', params, label: `"${q}"` });
    }
    if (asinRows.length) jobs.push({ kind: 'asins', asins: [...new Set(asinRows)], label: 'ASINs and product URLs' });
    return jobs;
}

const searchUrl = (params, page, win) => {
    const p = new URLSearchParams({ ...params, ...(win ? { 'low-price': String(win[0]), 'high-price': String(win[1]) } : {}), ...(page > 1 ? { page: String(page) } : {}) });
    return `${SITE}/s?${p}`;
};

async function* searchProducts(job) {
    const first = await get(searchUrl(job.params, 1));
    if (!first) throw new Error('Search page not found');
    const tot = resultTotal(first);
    log.info(`${job.label}: ${tot ? `${tot.over ? 'over ' : ''}${tot.total.toLocaleString('en-US')}` : 'unknown number of'} result(s).`);
    const userPrice = job.params['low-price'] || job.params['high-price'];
    // Amazon serves ~7 pages a search; read price windows when more is wanted.
    const split = perSearch > 300 && !userPrice && (tot?.total ?? 0) > 300;
    if (split) log.info(`${job.label}: reading ${WINDOWS.length} price ranges to go past Amazon's page limit.`);
    let active = split ? WINDOWS.map((w) => ({ win: w, done: false })) : [{ win: null, done: false }];
    for (let page = 1; page <= MAX_PAGES && active.length; page++) {
        for (const w of active) {
            const html = !w.win && page === 1 ? first : await get(searchUrl(job.params, page, w.win));
            const cards = html ? parseCards(html) : [];
            if (!cards.length || !hasNext(html || '')) w.done = true;
            for (const c of cards) yield c;
            await sleep(300);
        }
        active = active.filter((w) => !w.done);
    }
}

// ---------- Run ----------

let products = 0;
let detailed = 0;
let keepGoing = true;
const failures = [];
const perJob = [];
const seen = new Set();
const scrapedAt = () => new Date().toISOString();

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function pool(items, fn, width = 4) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

async function detail(asin) {
    try {
        const html = await get(productUrl(asin));
        if (!html) return { detailError: 'Product page not found' };
        return parseProduct(html, asin);
    } catch (err) { return { detailError: String(err?.message || err) }; }
}

// Emits rows; base rows without a card (list overflow) are filled from the
// product page and charged as product unless details were asked for.
async function flush(batch, label, extra = {}) {
    const needPage = batch.map((r) => includeDetails || r._needsPage);
    const pages = await pool(batch.map((r, i) => (needPage[i] ? r.asin : null)), (a) => (a ? detail(a) : null));
    let n = 0;
    for (let i = 0; i < batch.length && keepGoing; i++) {
        const { _needsPage, ...base } = batch[i];
        const pg = pages[i];
        const ok = pg && !pg.detailError;
        let row;
        if (!pg) row = base;
        else if (ok && includeDetails) row = { ...base, ...pg, price: pg.price ?? base.price, listPrice: pg.listPrice ?? base.listPrice ?? null, currency: pg.currency ?? base.currency, badges: base.badges, position: base.position };
        else if (ok) row = { ...base, title: pg.title, price: pg.price, listPrice: pg.listPrice, currency: pg.currency, rating: pg.rating, reviewsCount: pg.reviewsCount, imageUrl: pg.mainImage, brand: pg.brand };
        else row = { ...base, detailError: pg.detailError };
        await Actor.pushData({ ...row, marketplace: HOST, ...extra, search: label, scrapedAt: scrapedAt() });
        products += 1;
        n += 1;
        const withDetail = includeDetails && ok;
        if (withDetail) detailed += 1;
        if (!(await charge(withDetail ? 'product_detail' : 'product'))) keepGoing = false;
    }
    return n;
}

const jobs = buildJobs();
if (!jobs.length) jobs.push({ kind: 'search', params: { k: 'standing desk' }, label: '"standing desk"' });

for (const job of jobs) {
    if (!keepGoing) break;
    if (job.error) {
        log.warning(job.error);
        failures.push({ error: job.error });
        await Actor.pushData({ rowType: 'error', error: `${job.error} Not charged.` });
        continue;
    }
    let n = 0;
    try {
        if (job.kind === 'search') {
            let batch = [];
            for await (const c of searchProducts(job)) {
                if (!keepGoing || n + batch.length >= perSearch) break;
                if (seen.has(c.asin)) continue;
                seen.add(c.asin);
                batch.push(c);
                if (batch.length >= (includeDetails ? 16 : 48)) { n += await flush(batch, job.label); batch = []; }
            }
            if (keepGoing && batch.length) n += await flush(batch.slice(0, perSearch - n), job.label);
        } else if (job.kind === 'list') {
            for (let pg = 1; pg <= 2 && keepGoing && n < perSearch; pg++) {
                const html = await get(`${job.url}?pg=${pg}`);
                if (!html) break;
                const { category, items } = parseList(html);
                if (!items.length) break;
                if (pg === 1) log.info(`${job.label}: ${category || 'list'}.`);
                const batch = items.slice(0, perSearch - n).map((it) => ({
                    asin: it.asin,
                    url: productUrl(it.asin),
                    rank: it.rank,
                    ...(it.card || {}),
                    _needsPage: !it.card,
                }));
                n += await flush(batch, job.label, { listCategory: category, listType: /new-releases/.test(job.url) ? 'New Releases' : /movers-and-shakers/.test(job.url) ? 'Movers & Shakers' : /most-wished-for/.test(job.url) ? 'Most Wished For' : /most-gifted/.test(job.url) ? 'Gift Ideas' : 'Best Sellers' });
            }
        } else if (job.kind === 'asins') {
            for (let i = 0; i < job.asins.length && keepGoing; i += 8) {
                const chunk = job.asins.slice(i, i + 8).filter((a) => !seen.has(a));
                chunk.forEach((a) => seen.add(a));
                const pages = await pool(chunk, detail);
                for (let k = 0; k < chunk.length && keepGoing; k++) {
                    const pg = pages[k];
                    if (pg.detailError) {
                        failures.push({ asin: chunk[k], error: pg.detailError });
                        await Actor.pushData({ rowType: 'error', asin: chunk[k], error: `${pg.detailError}. Not charged.` });
                        continue;
                    }
                    await Actor.pushData({ ...pg, marketplace: HOST, search: job.label, scrapedAt: scrapedAt() });
                    products += 1; n += 1; detailed += 1;
                    if (!(await charge('product_detail'))) keepGoing = false;
                }
            }
        }
    } catch (err) {
        log.warning(`${job.label}: ${err?.message}`);
        failures.push({ search: job.label, error: String(err?.message || err) });
    }
    log.info(`${job.label}: ${n} product(s).`);
    perJob.push({ search: job.label, products: n });
}

if (!products) await Actor.pushData({ rowType: 'note', note: 'No products returned. Not charged.' });
await Actor.setValue('SUMMARY', { products, withDetails: detailed, marketplace: HOST, searches: perJob, failures });
log.info(`Done. ${products} product(s)${includeDetails ? `, ${detailed} with details` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
