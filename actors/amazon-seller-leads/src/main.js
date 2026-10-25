// Amazon Seller Leads: third-party Amazon.com sellers with their registered
// business name and address, 12-month rating, and the products and prices
// they were found selling.
//
// Strategy
// --------
// keyword or listing URL -> ASINs (search, bestseller or category pages)
// -> all-offers panel per ASIN (every third-party seller and its price)
// -> seller profile /sp?seller=<ID> (business name and address, which US
// sellers must publish under the INFORM Consumers Act). Seller IDs can also
// be given directly. See parse.js.
//
// Cost control
// ------------
// Amazon answered Apify's own IPs with no proxy on 2026-10-25 (search,
// offers and profiles), while datacenter proxies got AWS WAF challenges. So
// requests go direct first, then datacenter, then US residential. Residential
// is expensive here (a search page is ~2.4 MB = $0.02), so it is only reached
// after three blocks in a row and its spend is capped at 25% of what the run
// has charged (proxy-guard). No proxy input is exposed.
//
// Pay per event
// -------------
//   seller_lead ($0.004) one seller with business name and address
// Sellers without published business details, filtered-out sellers and
// Amazon's own storefronts are free.

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { isAmazonBlock, parseListing, parseOffers, parseSellerProfile } from './parse.js';

const PRICE = 0.004;
const BASE = 'https://www.amazon.com';
const AMAZON_IDS = new Set(['ATVPDKIKX0DER', 'A2L77EE7U53NWQ']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searches = ['yoga mat'],
    listingUrls = [],
    asins = [],
    sellerIds = [],
    maxSellers = 50,
    maxProductsPerSearch = 30,
    pagesPerSearch = 1,
    sellerCountries = [],
    minRatings12Months = 0,
    requireBusinessAddress = true,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x?.url ? x.url : String(x)).trim()).filter(Boolean);
const cap = Math.max(1, Math.min(5000, Number(maxSellers) || 50));
const perSearch = Math.max(1, Math.min(200, Number(maxProductsPerSearch) || 30));
const pages = Math.max(1, Math.min(7, Number(pagesPerSearch) || 1));
const countries = list(sellerCountries).map((c) => c.toUpperCase());

const guard = new ProxyGuard({ tiers: ['direct', 'datacenter', 'residential'], country: 'US', share: 0.25, floorUsd: 0.01, isBlocked: isAmazonBlock });
const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const sellers = new Map(); // sellerId -> { name, foundOn: [] }
const stats = { listingPages: 0, products: 0, offerPanels: 0, profiles: 0, leads: 0, skipped: { amazon: 0, noBusinessInfo: 0, country: 0, ratings: 0 } };
let out = 0;
let stop = false;
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { ...stats, ...guard.report() }));

const addSeller = (id, name, found) => {
    if (!sellers.has(id)) sellers.set(id, { name, foundOn: [] });
    if (found && sellers.get(id).foundOn.length < 10) sellers.get(id).foundOn.push(found);
};

for (const s of list(sellerIds)) {
    const id = /seller=([A-Z0-9]{8,20})/.exec(s)?.[1] || (/^[A-Z0-9]{8,20}$/.test(s) ? s : null);
    if (id) addSeller(id, null, null);
}

// ---------- 1. ASINs ----------
const asinQueue = [];
const seenAsin = new Set();
const pushAsin = (a, source) => { if (!seenAsin.has(a.asin)) { seenAsin.add(a.asin); asinQueue.push({ ...a, source }); } };
for (const a of list(asins)) {
    const m = /(?:dp\/|asin=|^)([A-Z0-9]{10})(?:[/?]|$)/.exec(a);
    if (m) pushAsin({ asin: m[1], title: null }, 'input');
}
const listingTargets = [
    ...list(searches).map((q) => ({ label: q, url: (p) => `${BASE}/s?${new URLSearchParams({ k: q, ...(p > 1 ? { page: String(p) } : {}) })}` })),
    ...list(listingUrls).filter((u) => /amazon\.com\//.test(u)).map((u) => ({ label: u, url: (p) => { const x = new URL(u); if (p > 1) x.searchParams.set(/zgbs|bestsellers/i.test(u) ? 'pg' : 'page', String(p)); return x.toString(); } })),
];
for (const t of listingTargets) {
    let got = 0;
    for (let p = 1; p <= pages && got < perSearch && !deadline.pastSoft(); p++) {
        const res = await guard.get(t.url(p), { headers });
        stats.listingPages++;
        if (!res) { log.warning(`No listing page for "${t.label}" (blocked or out of proxy budget).`); break; }
        const items = parseListing(res.body);
        if (!items.length) break;
        for (const it of items.filter((x) => !x.sponsored).concat(items.filter((x) => x.sponsored))) {
            if (got >= perSearch) break;
            pushAsin(it, t.label);
            got++;
        }
    }
    log.info(`"${t.label}": ${got} products queued.`);
}

// ---------- 2. sellers from offer panels ----------
for (const a of asinQueue) {
    if (deadline.pastSoft() || sellers.size >= cap * 2) break;
    const res = await guard.get(`${BASE}/gp/product/ajax/aodAjaxMain/?asin=${a.asin}&pc=dp`, { headers: { ...headers, 'X-Requested-With': 'XMLHttpRequest' } });
    stats.offerPanels++;
    if (!res) continue;
    const { title, offers } = parseOffers(res.body);
    stats.products++;
    for (const o of offers) {
        if (AMAZON_IDS.has(o.sellerId)) continue;
        addSeller(o.sellerId, o.sellerName, { asin: a.asin, productTitle: title || a.title || null, price: o.price, condition: o.condition, fulfilledByAmazon: o.fulfilledByAmazon, foundVia: a.source });
    }
}
log.info(`${sellers.size} sellers found on ${stats.products} products.`);

// ---------- 3. profiles ----------
const ids = [...sellers.keys()];
let next = 0;
async function worker() {
    while (!stop && out < cap && !deadline.pastSoft() && next < ids.length) {
        const id = ids[next++];
        const res = await guard.get(`${BASE}/sp?seller=${id}`, { headers });
        stats.profiles++;
        if (!res) continue;
        const p = parseSellerProfile(res.body, id);
        if (!p) continue;
        if (/amazon\.com services|amazon\.com, inc/i.test(p.businessName || '')) { stats.skipped.amazon++; continue; }
        if (requireBusinessAddress && !(p.businessName && p.businessAddress)) { stats.skipped.noBusinessInfo++; continue; }
        if (countries.length && !countries.includes(p.country || '')) { stats.skipped.country++; continue; }
        if (Number(minRatings12Months) > 0 && (p.ratings12Months ?? 0) < Number(minRatings12Months)) { stats.skipped.ratings++; continue; }
        if (out >= cap) break;
        out++;
        const s = sellers.get(id);
        await Actor.pushData({ ...p, sellerName: p.sellerName || s.name, productsFound: s.foundOn.length, foundOn: s.foundOn, scrapedAt: new Date().toISOString() });
        stats.leads++;
        if (!(await chargeRows(guard, 'seller_lead', PRICE, 1))) stop = true;
    }
}
await Promise.all([worker(), worker(), worker()]);

if (!out) await Actor.pushData({ note: sellers.size ? 'Sellers were found but none had published business details or passed your filters. Not charged.' : 'No third-party sellers found. Not charged. Try another keyword or listing URL.' });
await Actor.setValue('SUMMARY', { ...stats, sellersFound: sellers.size, ...guard.report() });
log.info(`Done: ${out} seller leads. ${JSON.stringify(stats)} ${JSON.stringify(guard.report())}`);
await Actor.exit();
