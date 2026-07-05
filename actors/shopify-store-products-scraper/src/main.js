// Shopify Store Products Scraper: Full Catalog, Prices, Stock
//
// Strategy
// --------
// Every Shopify storefront exposes its catalog at /products.json (and per
// collection at /collections/{handle}/products.json): an official, public,
// keyless JSON endpoint paginated with ?limit=250&page=N. We walk it with
// plain HTTP, normalize each product (price range, availability, variants,
// images), and push one row per product or per variant. No browser, no
// proxy needed, no API key.
//
// Pay per event
// -------------
//   product_row ($0.003) charged per row pushed (product or variant,
//   depending on oneRowPerVariant). Stores that block or disable
//   products.json yield no rows and cost nothing. First 2 rows per run
//   are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP_STORES = 100;
const HARD_CAP_PRODUCTS = 5000;
const PAGE_SIZE = 250;
const FETCH_TIMEOUT_MS = 15000;
const STORE_CONCURRENCY = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    storeUrls = [],
    collectionHandle = '',
    maxProductsPerStore = 50,
    oneRowPerVariant = false,
    includeImages = true,
    proxyConfiguration: proxyInput,
} = input;

const stores = (Array.isArray(storeUrls) ? storeUrls : String(storeUrls).split(/[\n,]/))
    .map((s) => (typeof s === 'string' ? s : s?.url))
    .map((s) => String(s || '').trim()).filter(Boolean)
    .slice(0, HARD_CAP_STORES);
if (!stores.length) {
    log.warning('Provide "storeUrls": a list of Shopify store domains or URLs, e.g. ["gymshark.com"].');
    await Actor.exit();
}
const productCap = Math.max(1, Math.min(HARD_CAP_PRODUCTS, Number(maxProductsPerStore) || 50));
const collection = String(collectionHandle || '').trim().replace(/^\/+|\/+$/g, '').replace(/^collections\//, '');

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

function storeOrigin(raw) {
    let s = String(raw).trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        return u.origin;
    } catch { return null; }
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                Accept: 'application/json',
            },
            ...(dispatcher ? { dispatcher } : {}),
        });
        if (!res.ok) return { status: res.status, data: null };
        const ctype = res.headers.get('content-type') || '';
        if (!/json/.test(ctype)) return { status: res.status, data: null };
        return { status: res.status, data: await res.json() };
    } catch {
        return { status: 0, data: null };
    } finally {
        clearTimeout(timer);
    }
}

function priceNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function normalizeProduct(p, store) {
    const variants = (p.variants || []).map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku || null,
        price: priceNum(v.price),
        compareAtPrice: priceNum(v.compare_at_price),
        available: typeof v.available === 'boolean' ? v.available : null,
        grams: v.grams ?? null,
        requiresShipping: v.requires_shipping ?? null,
    }));
    const prices = variants.map((v) => v.price).filter((n) => n != null);
    const anyAvailable = variants.some((v) => v.available === true);
    return {
        store,
        productId: p.id,
        title: p.title,
        handle: p.handle,
        url: `${store}/products/${p.handle}`,
        vendor: p.vendor || null,
        productType: p.product_type || null,
        tags: Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(',').map((t) => t.trim()) : []),
        priceMin: prices.length ? Math.min(...prices) : null,
        priceMax: prices.length ? Math.max(...prices) : null,
        available: variants.length ? anyAvailable : null,
        variantCount: variants.length,
        variants,
        images: includeImages ? (p.images || []).map((im) => im.src).filter(Boolean) : undefined,
        options: (p.options || []).map((o) => ({ name: o.name, values: o.values })),
        publishedAt: p.published_at || null,
        createdAt: p.created_at || null,
        updatedAt: p.updated_at || null,
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'product_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function scrapeStore(raw) {
    const origin = storeOrigin(raw);
    if (!origin) { log.warning(`Skipping invalid store: ${raw}`); return { store: raw, products: 0, note: 'invalid URL' }; }
    const path = collection ? `/collections/${encodeURIComponent(collection)}/products.json` : '/products.json';

    let pushed = 0;
    for (let page = 1; pushed < productCap; page++) {
        if (deadlineMs && Date.now() > deadlineMs) return { store: origin, products: pushed, note: 'stopped at deadline' };
        const { status, data } = await fetchJson(`${origin}${path}?limit=${PAGE_SIZE}&page=${page}`);
        if (!data || !Array.isArray(data.products)) {
            if (page === 1) log.warning(`${origin}: products.json unavailable (HTTP ${status}). Not a Shopify store, or the endpoint is disabled. No charge.`);
            return { store: origin, products: pushed, note: page === 1 ? `unavailable (HTTP ${status})` : null };
        }
        if (!data.products.length) break;
        for (const p of data.products) {
            if (pushed >= productCap) break;
            const row = normalizeProduct(p, origin);
            if (oneRowPerVariant && row.variants.length) {
                for (const v of row.variants) {
                    if (pushed >= productCap) break;
                    const { variants, variantCount, priceMin, priceMax, ...base } = row;
                    await flushRow({ ...base, variant: v, price: v.price, available: v.available });
                    pushed += 1;
                }
            } else {
                await flushRow(row);
                pushed += 1;
            }
        }
        if (data.products.length < PAGE_SIZE) break;
    }
    return { store: origin, products: pushed };
}

log.info(`Scraping ${stores.length} store(s), up to ${productCap} ${oneRowPerVariant ? 'variant' : 'product'} row(s) each${collection ? `, collection "${collection}"` : ''}.`);

for (let i = 0; i < stores.length; i += STORE_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = stores.slice(i, i + STORE_CONCURRENCY);
    const results = await Promise.all(batch.map((s) => scrapeStore(s)));
    for (const r of results) log.info(`${r.store}: ${r.products} row(s)${r.note ? ` (${r.note})` : ''}`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
