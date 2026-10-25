// Google Shopping Price Tracker: prices, merchants, discounts and ratings from
// Google Shopping, with price changes since the last run.
//
// Strategy
// --------
// google.com/search?q=<product>&udm=28 through Apify's GOOGLE_SERP proxy
// ($0.0025 per request, any page size). A page holds 40 products; start=40,
// 80... page further (tested 2026-10-25). Each row carries title, price,
// was-price, discount, merchant, delivery, returns, rating, reviews, brand,
// image and Google's product ids.
//
// Price tracking
// --------------
// With trackPriceChanges on, the last price of every merchant+title seen for
// a query is kept in the named key-value store "google-shopping-price-history".
// The next run adds previousPrice, priceChange and isNewListing; onlyChanges
// returns just the rows whose price moved or that are new.
//
// Cost control
// ------------
// A page costs $0.0025 and earns up to 40 x $0.002. Paging stops when a page
// adds no new products, and SERP spend is capped at half of what the run has
// charged (proxy-guard). No proxy input is exposed.
//
// Pay per event
// -------------
//   product ($0.002) one product row returned

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseShoppingPage, shoppingHealth } from './parse.js';

const PRICE = 0.002;
const PAGE = 40;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = ['airpods pro 2'],
    maxProductsPerQuery = 40,
    country = 'us',
    language = 'en',
    minPrice = 0,
    maxPrice = 0,
    merchants = [],
    excludeMerchants = [],
    trackPriceChanges = true,
    onlyChanges = false,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const qs = list(queries);
const perQuery = Math.max(1, Math.min(400, Number(maxProductsPerQuery) || 40));
const only = list(merchants).map((m) => m.toLowerCase());
const skip = list(excludeMerchants).map((m) => m.toLowerCase());

if (!qs.length) {
    await Actor.pushData({ note: 'Add at least one product search, e.g. "airpods pro 2". Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({ tiers: ['serp'], share: 0.5, floorUsd: 0.01, isBlocked: (r) => r.statusCode !== 200 || /\/sorry\/index|unusual traffic/i.test(r.body.slice(0, 5000)) });
const history = trackPriceChanges ? await Actor.openKeyValueStore('google-shopping-price-history') : null;
let out = 0;
let pages = 0;
let stop = false;
const perQuerySummary = [];
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { products: out, pages, ...guard.report(), queries: perQuerySummary }));

function keep(r) {
    if (Number(minPrice) > 0 && (r.price ?? 0) < Number(minPrice)) return false;
    if (Number(maxPrice) > 0 && (r.price ?? Infinity) > Number(maxPrice)) return false;
    const m = (r.merchant || '').toLowerCase();
    if (only.length && !only.some((x) => m.includes(x))) return false;
    if (skip.some((x) => m.includes(x))) return false;
    return true;
}

for (const q of qs) {
    if (stop || deadline.pastSoft()) break;
    const histKey = `q-${createHash('sha1').update(`${q.toLowerCase()}|${country}|${language}`).digest('hex').slice(0, 20)}`;
    const prev = history ? ((await history.getValue(histKey)) || {}) : {};
    const next = { ...prev };
    const seen = new Set();
    const rows = [];
    let changes = 0;
    for (let start = 0; start < perQuery && !stop && !deadline.pastSoft(); start += PAGE) {
        const params = new URLSearchParams({ q, udm: '28', hl: language, gl: country });
        if (start) params.set('start', String(start));
        const res = await guard.get(`http://www.google.com/search?${params}`, { timeoutMs: 60_000 });
        pages++;
        if (!res) { log.warning(`No page for "${q}" at ${start} (blocked or out of proxy budget).`); break; }
        const found = parseShoppingPage(res.body);
        const health = shoppingHealth(res.body, found);
        if (health.cards && !health.parsed) log.warning(`Google returned ${health.cards} products for "${q}" but none parsed: the page layout may have changed.`);
        let added = 0;
        for (const r of found) {
            const key = `${(r.merchant || '').toLowerCase()}|${r.title.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            added++;
            if (!keep(r)) continue;
            const before = prev[key];
            const row = { query: q, ...r, position: start + r.position };
            if (history) {
                row.previousPrice = before?.price ?? null;
                row.priceChange = before && r.price != null && before.price != null ? +(r.price - before.price).toFixed(2) : null;
                row.priceChangePct = row.priceChange && before.price ? +((row.priceChange / before.price) * 100).toFixed(2) : null;
                row.isNewListing = !before;
                row.lastSeenAt = before?.seenAt ?? null;
                next[key] = { price: r.price, seenAt: new Date().toISOString() };
                if (!before || row.priceChange) changes++;
            }
            row.scrapedAt = new Date().toISOString();
            rows.push(row);
        }
        if (!added || found.length < PAGE / 2) break;
    }
    const emit = (onlyChanges && history ? rows.filter((r) => r.isNewListing || r.priceChange) : rows).slice(0, perQuery);
    if (emit.length) {
        await Actor.pushData(emit);
        out += emit.length;
        if (!(await chargeRows(guard, 'product', PRICE, emit.length))) stop = true;
    }
    if (history) await history.setValue(histKey, next);
    perQuerySummary.push({ query: q, products: rows.length, returned: emit.length, newOrChanged: changes });
    log.info(`"${q}": ${rows.length} products, ${emit.length} returned${history ? `, ${changes} new or changed price` : ''}.`);
}

if (!out) await Actor.pushData({ note: onlyChanges ? 'No new products or price changes since the last run. Not charged.' : 'No products matched. Not charged. Try a broader search or fewer filters.' });
await Actor.setValue('SUMMARY', { products: out, pages, ...guard.report(), queries: perQuerySummary });
log.info(`Done: ${out} products from ${pages} pages. ${JSON.stringify(guard.report())}`);
await Actor.exit();
