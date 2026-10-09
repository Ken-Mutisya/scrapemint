// AliExpress Scraper: products from any AliExpress search with price,
// original price, discount, units sold, rating, ship-from country, listing
// date and badges, in your currency and ship-to country.
//
// Strategy
// --------
// The desktop search page only carries title, price and image, and its JSON
// endpoint (/fn/search-pc/index) answers with a slider captcha. The mobile
// search page (m.aliexpress.com/w/wholesale-<query>.html) is server-rendered
// with the full card in window.__ICE_APP_CONTEXT__ -> loaderData['/'].data.
// searchResult: 20 products a page, up to page 60 (1,200 per search), with
// realTradeCount (exact units sold), starRating, salePrice and discount,
// sellingPoints (Choice, free shipping, coins), lunchTime (listing date) and
// a trace whose pdp_npi string holds the original price
// ("6@dis!EUR!8.59!4.29!..." = currency, original, sale).
//
// Currency, ship-to country and language come from the aep_usuc_f cookie
// (site=glo&c_tp=USD&region=GB&b_locale=en_US). Sort is ?sortParam=
// default|ordersDesc|priceAsc|priceDesc, price range ?pr=min-max.
//
// Searches past 1,200 are split into fixed price windows and read
// round-robin, de-duplicated by product id.
//
// For new visitors shipping to the US or Canada, AliExpress swaps most cards
// for "free with your first order" promos that carry no price. Those rows
// keep their real product id and come back with price null and
// newUserPromo true; other ship-to countries return every price.
//
// No key, no proxy: mobile search answered Apify's IPs on every request in
// the 2026-10-09 probes.
//
// Pay per event
// -------------
//   product ($0.0015) one product from search results
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const MUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MSITE = 'https://m.aliexpress.com';
const PER_PAGE = 20;
const MAX_PAGES = 60;
const CAP = PER_PAGE * MAX_PAGES;
const WINDOWS = [[0, 1], [1, 2], [2, 3], [3, 5], [5, 8], [8, 12], [12, 20], [20, 35], [35, 60], [60, 100], [100, 200], [200, 500], [500, 100000]];
const SORTS = { default: 'default', bestMatch: 'default', orders: 'ordersDesc', ordersDesc: 'ordersDesc', priceAsc: 'priceAsc', priceDesc: 'priceDesc' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    sort = 'default',
    minPrice = null,
    maxPrice = null,
    freeShippingOnly = false,
    choiceOnly = false,
    shipToCountry = 'GB',
    currency = 'USD',
    maxItemsPerSearch = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 200);
const region = String(shipToCountry || 'GB').trim().toUpperCase().slice(0, 2);
const cur = String(currency || 'USD').trim().toUpperCase().slice(0, 3);
const cookie = `aep_usuc_f=site=glo&c_tp=${cur}&region=${region}&b_locale=en_US`;

async function get(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': MUA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9', Cookie: cookie }, signal: AbortSignal.timeout(45_000) });
            const t = await r.text();
            if (r.ok && t.includes('__ICE_APP_CONTEXT__')) return t;
            last = new Error(r.ok ? 'No search data on the page (challenge or empty page)' : `HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

function pageData(html) {
    const i = html.indexOf('window.__ICE_APP_CONTEXT__');
    const k = html.indexOf('var b =', i);
    if (i < 0 || k < 0) return null;
    let obj;
    try { obj = JSON.parse(extractJson(html, k + 7)); } catch { return null; }
    const sr = obj?.loaderData?.['/']?.data?.searchResult;
    if (!sr) return null;
    return { items: sr.mods?.itemList?.content || [], total: Number(sr.pageInfo?.totalResults) || 0, page: Number(sr.pageInfo?.page) || 0 };
}

// The balanced {...} starting at or after pos.
function extractJson(s, pos) {
    const start = s.indexOf('{', pos);
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
    }
    throw new Error('unbalanced JSON');
}

// ---------- Searches ----------

const slugify = (q) => String(q).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'x';

// aliexpress.com/w/wholesale-phone-case.html?..., m.aliexpress.com/wholesale/phone-case.html, /wholesale?SearchText=...
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/(^|\.)aliexpress\.[a-z.]+$/.test(url.hostname)) return null;
    let slug = url.pathname.match(/\/w\/wholesale-([^/]+)\.html/)?.[1] || url.pathname.match(/\/wholesale\/([^/]+)\.html/)?.[1];
    if (!slug && url.searchParams.get('SearchText')) slug = slugify(url.searchParams.get('SearchText'));
    if (!slug) return null;
    const p = url.searchParams;
    const params = {};
    const st = p.get('sortParam') || { total_tranpro_desc: 'ordersDesc', price_asc: 'priceAsc', price_desc: 'priceDesc' }[p.get('SortType')];
    if (st) params.sortParam = st;
    if (p.get('pr')) params.pr = p.get('pr');
    else if (p.get('minPrice') || p.get('maxPrice')) params.pr = `${p.get('minPrice') || ''}-${p.get('maxPrice') || ''}`;
    if (p.get('selectedSwitches')) params.selectedSwitches = p.get('selectedSwitches');
    if (p.get('attr')) params.attr = p.get('attr');
    return { slug, params, label: u };
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) out.push(parseSearchUrl(u) || { error: `Not an AliExpress search URL (…/w/wholesale-….html): ${u}` });
    const params = {};
    const s = SORTS[sort] || 'default';
    if (s !== 'default') params.sortParam = s;
    if ((minPrice != null && minPrice !== '') || (maxPrice != null && maxPrice !== '')) params.pr = `${minPrice ?? ''}-${maxPrice ?? ''}`;
    const sw = [freeShippingOnly && 'filterCode:freeshipping', choiceOnly && 'filterCode:choice_atm'].filter(Boolean);
    if (sw.length) params.selectedSwitches = sw.join(',');
    for (const q of list(queries)) out.push({ slug: slugify(q), params, label: `"${q}"` });
    return out;
}

function pageUrl(s, page, pr = null) {
    const p = new URLSearchParams({ ...s.params, ...(pr ? { pr } : {}), ...(page > 1 ? { page: String(page) } : {}) });
    const qs = p.toString();
    return `${MSITE}/w/wholesale-${encodeURIComponent(s.slug).replace(/%2D/g, '-')}.html${qs ? `?${qs}` : ''}`;
}

async function* searchProducts(s) {
    const first = pageData(await get(pageUrl(s, 1)));
    if (!first) throw new Error('No search data on the page');
    const total = first.total;
    log.info(`${s.label}: about ${total.toLocaleString('en-US')} product(s).`);
    if (!first.items.length) return;
    // A user price range wins over automatic splitting.
    const split = total > CAP && perSearch > CAP && !s.params.pr;
    const windows = split ? WINDOWS.map(([a, b]) => ({ pr: `${a}-${b}`, done: false, pages: MAX_PAGES })) : [{ pr: null, done: false, pages: Math.min(MAX_PAGES, Math.ceil(total / PER_PAGE) || 1) }];
    if (split) log.info(`${s.label}: over ${CAP} products, reading ${windows.length} price ranges (${cur}).`);
    let active = windows;
    for (let page = 1; page <= MAX_PAGES && active.length; page++) {
        for (const w of active) {
            const data = !split && page === 1 ? first : pageData(await get(pageUrl(s, page, w.pr)));
            if (data && split && page === 1) w.pages = Math.min(MAX_PAGES, Math.ceil(data.total / PER_PAGE) || 1);
            if (!data || !data.items.length || page >= w.pages) w.done = true;
            for (const it of data?.items || []) yield it;
            await sleep(300);
        }
        active = active.filter((w) => !w.done);
    }
}

// ---------- Rows ----------

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };

function row(it, search) {
    const pdp = it.trace?.pdpParams || {};
    let cdi = {};
    try { cdi = JSON.parse(decodeURIComponent(pdp.pdp_cdi || '') || '{}'); } catch { cdi = {}; }
    const npi = decodeURIComponent(pdp.pdp_npi || '').split('!');
    const sale = it.prices?.salePrice;
    const promoId = it.productDetailUrl?.match(/productIds=(\d+)/)?.[1];
    const id = promoId || it.productId;
    const tags = (it.sellingPoints || []).map((s) => s.tagContent?.tagText).filter(Boolean);
    const sources = (it.sellingPoints || []).map((s) => s.source || '');
    const price = sale?.minPrice ?? null;
    const orig = npi.length > 3 && npi[1] ? num(npi[2]) : null;
    const original = orig != null && price != null && orig > price ? orig : null;
    return {
        productId: id,
        url: `https://www.aliexpress.com/item/${id}.html`,
        title: it.title?.displayTitle || it.title?.seoTitle || null,
        imageUrl: it.image?.imgUrl ? (it.image.imgUrl.startsWith('//') ? `https:${it.image.imgUrl}` : it.image.imgUrl) : null,
        price,
        originalPrice: original,
        discountPercent: sale?.discount || (original ? Math.round((1 - price / original) * 100) : null),
        currency: sale?.currencyCode || (npi[1] && /^[A-Z]{3}$/.test(npi[1]) ? npi[1] : null),
        priceText: sale?.formattedPrice || null,
        soldCount: num(it.trade?.realTradeCount),
        soldText: it.trade?.tradeDesc || null,
        rating: it.evaluation?.starRating ?? null,
        shipFrom: cdi.shipFrom || null,
        listedAt: it.lunchTime ? it.lunchTime.slice(0, 10) : null,
        isChoice: sources.includes('choice_atm'),
        freeShipping: tags.some((t) => /free shipping/i.test(t)),
        tags,
        isAd: it.productType === 'ad',
        newUserPromo: !sale && !!promoId,
        skuId: it.prices?.skuId || cdi.skuId || null,
        shipTo: region,
        search,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- Run ----------

let products = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge() {
    try {
        const r = await Actor.charge({ eventName: 'product' });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = buildSearches();
if (!searches.length) searches.push({ slug: 'phone-case', params: {}, label: '"phone case"' });
const seen = new Set();
if (['US', 'CA'].includes(region)) log.warning(`Ship-to ${region}: AliExpress can hide prices from new visitors in this country behind a first-order promo, depending on the search. Those rows have price null and newUserPromo true. Use GB or DE (with currency ${cur}) for every price.`);

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    try {
        for await (const it of searchProducts(s)) {
            if (!keepGoing || count >= perSearch) break;
            const r = row(it, s.label);
            if (!r.productId || seen.has(r.productId)) continue;
            seen.add(r.productId);
            await Actor.pushData(r);
            products += 1;
            count += 1;
            if (!(await charge())) keepGoing = false;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    perSearchCounts.push({ search: s.label, products: count });
}

if (!products) await Actor.pushData({ rowType: 'note', note: 'No products matched. Not charged.' });
await Actor.setValue('SUMMARY', { products, shipTo: region, currency: cur, searches: perSearchCounts, failures });
log.info(`Done. ${products} product(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
