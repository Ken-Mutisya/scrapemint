// Flipkart Scraper: products from flipkart.com search and category pages,
// with price, MRP, discount, rating and rating breakdown, review count, key
// specs, stock state and images; optionally the full specification table,
// seller and return policy from each product page.
//
// Strategy
// --------
// The website fetches every page from Flipkart's page API:
//   POST https://2.rome.api.flipkart.com/api/4/page/fetch
//   { pageUri: "/search?q=...", pageContext: {...}, requestContext: {...} }
// with an X-User-Agent header ending in "FKUA/website/42/website/Desktop".
// Products sit in PRODUCT_SUMMARY widgets (40 per page on grid layouts, 24 on
// list layouts) with full pricing and rating fields.
//
// Paging: a page= parameter inside pageUri is ignored past page 2 (the API
// repeats the same products). The site instead sends pageContext
// { paginatedFetch: true, pageNumber: N, paginationContextMap } where the map
// comes from the previous response's pageData. That walks real pages; about
// 16 sponsored slots per page repeat, so rows are de-duplicated by product
// id, and a search stops after 3 pages in a row with nothing new, or when
// pageData.hasMorePages is false.
//
// Product pages come from the same API with the product path as pageUri.
// Specification rows are widgets with label_0 (name) and label_1 (list of
// values); the seller is the "Seller: NAME" row (phones) or the "Fulfilled by
// NAME" row (other layouts), with label_1 holding its rating;
// seoData.schema holds JSON-LD with colour, brand and return policy.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   product        ($0.001) one product from the search or category page
//   product_detail ($0.003) the same product plus its product page; charged
//                           instead of product
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop';
const API = 'https://2.rome.api.flipkart.com/api/4/page/fetch';
const SITE = 'https://www.flipkart.com';
const SORT = { relevance: null, popularity: 'popularity', price_asc: 'price_asc', price_desc: 'price_desc', newest: 'recency_desc' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    sortBy = 'relevance',
    includeSponsored = true,
    includeDetails = false,
    maxItemsPerSearch = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 200);

// schema.org MerchantReturnPolicy as text, e.g. "7-day return, free".
function returnText(p) {
    if (!p) return null;
    if (p.description) return p.description;
    if (/NotPermitted/.test(p.returnPolicyCategory || '')) return 'No returns';
    const days = Number(p.merchantReturnDays) > 0 ? `${p.merchantReturnDays}-day return` : null;
    const fee = /FreeReturn/.test(p.returnFees || '') ? 'free' : /ReturnFeesCustomerResponsibility|ReturnShippingFees/.test(p.returnFees || '') ? 'buyer pays return shipping' : null;
    return [days, fee].filter(Boolean).join(', ') || null;
}

async function fetchPage(body) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-User-Agent': UA, 'User-Agent': UA, Accept: 'application/json', Origin: SITE, Referer: `${SITE}/` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(45_000),
            });
            const d = await r.json().catch(() => null);
            if (r.ok && d?.RESPONSE) return d.RESPONSE;
            last = new Error(`HTTP ${r.status}${d?.ERROR_MESSAGE ? `: ${d.ERROR_MESSAGE}` : ''}`);
            if (r.status === 404) return null;
        } catch (err) {
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

function summaries(o, out = []) {
    if (Array.isArray(o)) { for (const v of o) summaries(v, out); return out; }
    if (o && typeof o === 'object') {
        if (o.type === 'PRODUCT_SUMMARY') { out.push(...(o.data?.products || [])); return out; }
        for (const v of Object.values(o)) summaries(v, out);
    }
    return out;
}

// ---------- Searches ----------

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)flipkart\.com$/.test(url.hostname) || !(url.pathname === '/search' || /\/pr$/.test(url.pathname))) {
            out.push({ error: `Not a Flipkart search or category URL (flipkart.com/search?q=... or .../pr?sid=...): ${u}` });
            continue;
        }
        url.searchParams.delete('page');
        out.push({ uri: url.pathname + url.search, label: u });
    }
    const sort = SORT[sortBy] ?? null;
    for (const q of list(queries)) {
        const p = new URLSearchParams({ q });
        if (sort) p.set('sort', sort);
        out.push({ uri: `/search?${p}`, label: `"${q}"` });
    }
    return out;
}

// ---------- Rows ----------

const img = (u, size = 832) => (u ? u.replace('{@width}', size).replace('{@height}', size).replace('{@quality}', '70').replace(/^http:/, 'https:') : null);
const abs = (u) => (u ? new URL(u, SITE).toString() : null);

function row(p, search) {
    const v = p.productInfo?.value || {};
    const prices = v.pricing?.prices || [];
    const price = prices.filter((x) => !x.strikeOff).at(-1)?.value ?? null;
    const mrp = prices.find((x) => x.strikeOff)?.value ?? null;
    const r = v.rating || null;
    const tags = (v.productCardTagDetails || []).map((t) => t.type).filter(Boolean);
    const productUrl = abs(v.baseUrl || p.productInfo?.action?.url || v.smartUrl);
    const breakup = Array.isArray(r?.breakup) && r.breakup.length === 5 ? { 1: r.breakup[0], 2: r.breakup[1], 3: r.breakup[2], 4: r.breakup[3], 5: r.breakup[4] } : null;
    return {
        productId: v.id || null,
        listingId: v.listingId || null,
        url: productUrl ? `${SITE}${new URL(productUrl).pathname}${v.id ? `?pid=${v.id}` : ''}` : null,
        title: v.titles?.title || null,
        name: v.titles?.newTitle || null,
        brand: v.productBrand || v.titles?.superTitle || null,
        variant: v.titles?.subtitle || null,
        price,
        mrp,
        currency: price !== null ? 'INR' : null,
        discountPercent: v.pricing?.totalDiscount ?? (price && mrp ? Math.round((1 - price / mrp) * 100) : null),
        rating: r?.average || null,
        ratingCount: r?.count ?? null,
        reviewCount: r?.reviewCount ?? null,
        ratingBreakdown: breakup,
        keySpecs: v.keySpecs || [],
        inStock: v.availability?.displayState ? v.availability.displayState === 'IN_STOCK' : null,
        availability: v.availability?.displayState || null,
        isFlipkartAssured: tags.includes('F_ASSURED'),
        isSponsored: Boolean(p.adInfo),
        warranty: v.warrantySummary || null,
        category: v.analyticsData?.category || null,
        subCategory: v.analyticsData?.subCategory || null,
        superCategory: v.analyticsData?.superCategory || null,
        vertical: v.vertical || v.analyticsData?.vertical || null,
        imageUrl: img(v.media?.images?.[0]?.url),
        imageUrls: (v.media?.images || []).map((i) => img(i.url)).filter(Boolean),
        search,
        scrapedAt: new Date().toISOString(),
    };
}

function textOf(x) {
    const t = x?.value?.text;
    if (Array.isArray(t)) return t.filter((s) => typeof s === 'string').join(', ');
    return typeof t === 'string' ? t : null;
}

async function addDetails(r) {
    const path = r.url ? new URL(r.url).pathname + new URL(r.url).search : null;
    if (!path) { r.detailError = 'No product URL.'; return r; }
    try {
        const d = await fetchPage({ pageUri: path, pageContext: { fetchSeoData: true } });
        if (!d) { r.detailError = 'Product page not found.'; return r; }
        const specs = {};
        let seller = null;
        let sellerRating = null;
        // Phones show "Seller: NAME"; most other layouts only "Fulfilled by NAME".
        let fulfilledBy = null;
        let fulfilledRating = null;
        const walk = (o) => {
            if (Array.isArray(o)) { for (const v of o) walk(v); return; }
            if (!o || typeof o !== 'object') return;
            const name = typeof o.label_0?.value?.text === 'string' ? o.label_0.value.text.trim() : null;
            if (name && o.label_1) {
                const raw = o.label_1.value?.text;
                if (Array.isArray(raw)) { if (!(name in specs)) specs[name] = textOf(o.label_1); }
                else if (/^Seller:\s*/i.test(name) && !seller) { seller = name.replace(/^Seller:\s*/i, '').trim(); sellerRating = Number(raw) || null; }
                else if (/^Fulfilled by\s+/i.test(name) && !fulfilledBy) { fulfilledBy = name.replace(/^Fulfilled by\s+/i, '').trim(); fulfilledRating = Number(raw) || null; }
            }
            for (const v of Object.values(o)) walk(v);
        };
        walk(d.slots);
        const ld = (d.pageData?.seoData?.schema || []).find((x) => x && (x['@type'] === 'Product' || x.sku)) || {};
        Object.assign(r, {
            specifications: specs,
            seller: seller || fulfilledBy,
            sellerRating: seller ? sellerRating : fulfilledRating,
            color: ld.color || null,
            returnPolicy: returnText(ld.offers?.hasMerchantReturnPolicy),
            metaDescription: ld.description || d.pageData?.seoData?.seo?.description || null,
            imageUrls: Array.isArray(ld.image) && ld.image.length > r.imageUrls.length ? ld.image : r.imageUrls,
        });
        if (!Object.keys(specs).length && !seller && !fulfilledBy) r.detailError = 'Product page had no specification table.';
    } catch (err) {
        r.detailError = String(err?.message || err);
    }
    return r;
}

// ---------- Run ----------

let products = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge(eventName) {
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = buildSearches();
if (!searches.length) searches.push({ uri: '/search?q=wireless%20earbuds', label: '"wireless earbuds"' });

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let pages = 0;
    const seen = new Set();
    try {
        let pcm = null;
        let stale = 0;
        for (let page = 1; keepGoing && count < perSearch && stale < 3; page++) {
            const body = page === 1
                ? { pageUri: s.uri, pageContext: { fetchSeoData: true }, requestContext: { type: 'BROWSE_PAGE' } }
                : { pageUri: s.uri, pageContext: { paginatedFetch: true, pageNumber: page, fetchAllPages: false, paginationContextMap: pcm }, requestContext: { type: 'BROWSE_PAGE' } };
            const d = await fetchPage(body);
            if (!d) break;
            pages += 1;
            pcm = d.pageData?.paginationContextMap || pcm;
            const rows = [];
            for (const p of summaries(d.slots)) {
                const id = p.productInfo?.value?.id;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                if (!includeSponsored && p.adInfo) continue;
                if (rows.length + count >= perSearch) break;
                rows.push(row(p, s.label));
            }
            stale = rows.length ? 0 : stale + 1;
            if (includeDetails) for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(addDetails));
            for (const r of rows) {
                await Actor.pushData(r);
                products += 1;
                count += 1;
                if (!(await charge(includeDetails && !r.detailError ? 'product_detail' : 'product'))) { keepGoing = false; break; }
            }
            if (d.pageData?.hasMorePages === false || !pcm) break;
            await sleep(400);
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${count} product(s) from ${pages} page(s).`);
    perSearchCounts.push({ search: s.label, products: count, pages });
}

if (!products) await Actor.pushData({ rowType: 'note', note: 'No products found. Not charged.' });
await Actor.setValue('SUMMARY', { products, searches: perSearchCounts, failures });
log.info(`Done. ${products} product(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
