// Shopify Price & Stock Monitor: Change Alerts for Any Store
//
// Strategy
// --------
// Every Shopify store publishes its catalog at /products.json (keyless,
// CDN-served, works from datacenter IPs — this actor uses NO proxy at
// all). Each run pages through the catalog per store and diffs
// variant-level price and availability against the previous run's
// snapshot in a named key-value store. One row per CHANGE: price up,
// price down, back in stock, out of stock, new product, removed
// product. First run per store emits one free baseline row; scanning a
// catalog where nothing changed pushes nothing and costs nothing.
//
// Pay per event
// -------------
//   change_row ($0.01) per pushed change. Baseline rows are free.
//   First 2 change rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_CHANGES = 2;
const HARD_CAP = 2000;
const PAGE_SIZE = 250;
const FETCH_TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    storeUrls = [],
    trackPrices = true,
    trackAvailability = true,
    trackNewProducts = true,
    trackRemovedProducts = true,
    minPriceChangePercent = 0,
    maxProductsPerStore = 1000,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const stores = [...new Set(asList(storeUrls).map((u) => {
    try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).origin; } catch { return null; }
}).filter(Boolean))];
const productCap = Math.max(1, Math.min(5000, Number(maxProductsPerStore) || 1000));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const minPct = Math.max(0, Number(minPriceChangePercent) || 0);

if (!stores.length) {
    log.error('Provide at least one Shopify store URL in "storeUrls".');
    await Actor.exit();
}
log.info(`Monitoring ${stores.length} store(s), up to ${productCap} products each. No proxy used.`);

const state = await Actor.openKeyValueStore('shopify-price-monitor-state');
const storeKey = (origin) => `store-${origin.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status}: ${url}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Fetch failed (${url}): ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchCatalog(origin) {
    const products = [];
    for (let page = 1; products.length < productCap; page++) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const data = await fetchJson(`${origin}/products.json?limit=${PAGE_SIZE}&page=${page}`);
        if (!data || !Array.isArray(data.products)) return products.length ? products : null;
        products.push(...data.products);
        if (data.products.length < PAGE_SIZE) break;
    }
    return products.slice(0, productCap);
}

let changeRows = 0;
let baselineRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    if (chargeable) {
        changeRows += 1;
        if (changeRows > FREE_TIER_CHANGES) {
            try {
                await Actor.charge({ eventName: 'change_row' });
            } catch (err) {
                log.warning(`charge failed: ${err?.message}`);
            }
        }
    } else {
        baselineRows += 1;
    }
}

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

function snapshotOf(products) {
    // Variant map + product meta map; compact keys keep the KV record small.
    const variants = {};
    const productsMeta = {};
    for (const p of products) {
        productsMeta[p.id] = { t: p.title, h: p.handle };
        for (const v of p.variants || []) {
            variants[v.id] = {
                p: num(v.price),
                a: v.available === true,
                pid: p.id,
                vt: v.title || null,
                sku: v.sku || null,
            };
        }
    }
    return { variants, products: productsMeta };
}

const checkedAt = new Date().toISOString();

async function processStore(origin) {
    const key = storeKey(origin);
    const products = await fetchCatalog(origin);
    if (products === null) {
        log.warning(`${origin}: catalog unavailable (products.json disabled or store offline); skipping.`);
        return;
    }
    const current = snapshotOf(products);
    const prev = await state.getValue(key);
    const meta = (pid, cur) => {
        const m = current.products[pid] || prev?.products?.[pid] || {};
        return {
            store: origin,
            productId: pid,
            productTitle: m.t || null,
            productUrl: m.h ? `${origin}/products/${m.h}` : null,
        };
    };

    if (!prev) {
        await flushRow({
            changeType: 'baseline',
            store: origin,
            productCount: products.length,
            variantCount: Object.keys(current.variants).length,
            note: 'First run for this store: catalog snapshot saved. Changes appear from the next run.',
            checkedAt,
        }, false);
        await state.setValue(key, current);
        log.info(`${origin}: baseline saved (${products.length} products).`);
        return;
    }

    let changes = 0;
    const emit = async (row) => {
        if (changeRows >= cap) return false;
        await flushRow({ ...row, checkedAt }, true);
        changes += 1;
        return true;
    };

    // Variant-level price & availability diffs.
    for (const [vid, cur] of Object.entries(current.variants)) {
        if (changeRows >= cap) break;
        const old = prev.variants?.[vid];
        const base = { ...meta(cur.pid, cur), variantId: Number(vid), variantTitle: cur.vt, sku: cur.sku };
        if (!old) {
            if (trackNewProducts && !prev.products?.[cur.pid]) {
                // Whole product is new: report once per product (first variant seen).
                if (!current.products[cur.pid].reported) {
                    current.products[cur.pid].reported = true;
                    if (!await emit({ changeType: 'new_product', ...base, newPrice: cur.p, newAvailable: cur.a })) break;
                }
            }
            continue;
        }
        if (trackPrices && old.p != null && cur.p != null && old.p !== cur.p) {
            const pct = old.p > 0 ? Math.abs((cur.p - old.p) / old.p) * 100 : 100;
            if (pct >= minPct) {
                if (!await emit({
                    changeType: cur.p > old.p ? 'price_increase' : 'price_decrease',
                    ...base,
                    oldPrice: old.p,
                    newPrice: cur.p,
                    priceChangePercent: Math.round(((cur.p - old.p) / old.p) * 10000) / 100,
                })) break;
            }
        }
        if (trackAvailability && old.a !== cur.a) {
            if (!await emit({
                changeType: cur.a ? 'back_in_stock' : 'out_of_stock',
                ...base,
                oldAvailable: old.a,
                newAvailable: cur.a,
                price: cur.p,
            })) break;
        }
    }

    // Removed products (all previous products absent from the current catalog).
    if (trackRemovedProducts) {
        for (const pid of Object.keys(prev.products || {})) {
            if (changeRows >= cap) break;
            if (current.products[pid]) continue;
            if (!await emit({ changeType: 'product_removed', ...meta(pid, null) })) break;
        }
    }

    // Strip the transient "reported" flags before persisting.
    for (const m of Object.values(current.products)) delete m.reported;
    await state.setValue(key, current);
    log.info(`${origin}: ${changes} change(s) across ${products.length} products.`);
}

for (const origin of stores) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
    if (changeRows >= cap) break;
    await processStore(origin);
}

log.info(`Done. ${changeRows} change(s) (${Math.max(0, changeRows - FREE_TIER_CHANGES)} chargeable), ${baselineRows} baseline(s). Unchanged catalogs cost nothing.`);
await Actor.exit();
