// Woolworths & Coles Grocery Prices: Australian supermarket products by
// search, from both chains in one run, with the same branded product matched
// across stores so each row says where it is cheaper.
//
// Strategy
// --------
// Woolworths' own search JSON API and Coles' search page data (see
// stores.js). Requests go direct first, then through Apify datacenter
// proxies, then Australian residential as a last resort.
//
// Cost control
// ------------
// Direct and datacenter cost nothing per byte. Residential ($8/GB, ~15 KB
// per product) is only reached after a tier is blocked three times in a row,
// and its spend is capped at 25% of what the run has charged (proxy-guard).
// No proxy input is exposed.
//
// Pay per event
// -------------
//   product ($0.0015) one product row returned

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { PAGE_SIZE, wwUrl, colesUrl, parseWoolworths, parseColes, matchStores } from './stores.js';

const PRICE = 0.0015;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searches = ['milk'],
    stores = ['woolworths', 'coles'],
    maxProductsPerSearch = 50,
    onlySpecials = false,
    compareStores = true,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const terms = list(searches);
const which = list(stores).map((s) => s.toLowerCase()).filter((s) => s === 'woolworths' || s === 'coles');
const perStore = Math.max(1, Math.min(1000, Number(maxProductsPerSearch) || 50));

if (!terms.length || !which.length) {
    await Actor.pushData({ note: 'Add at least one search and pick Woolworths, Coles or both. Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({
    tiers: ['direct', 'datacenter', 'residential'],
    country: 'AU',
    share: 0.25,
    floorUsd: 0.01,
    isBlocked: (r) => {
        if (r.statusCode !== 200) return true;
        if (r.url.includes('woolworths.com.au')) return !/^\s*\{/.test(r.body) || !r.body.includes('"Products"');
        return !r.body.includes('__NEXT_DATA__') || !r.body.includes('"searchResults"');
    },
});
let out = 0;
let stop = false;
const perSearch = [];
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { products: out, ...guard.report(), searches: perSearch }));

async function readStore(store, term) {
    const rows = [];
    let total = null;
    const parse = store === 'woolworths' ? parseWoolworths : parseColes;
    const headers = store === 'woolworths'
        ? { Accept: 'application/json, text/plain, */*', Referer: 'https://www.woolworths.com.au/shop/search/products' }
        : { Accept: '*/*' };
    for (let page = 1; rows.length < perStore && !deadline.pastSoft(); page++) {
        const url = store === 'woolworths' ? wwUrl(term, page) : colesUrl(term, page);
        const res = await guard.get(url, { headers, locale: 'en-AU', session: `${store}${page % 5}` });
        if (!res) { log.warning(`${store}: no page ${page} for "${term}" (blocked or out of proxy budget).`); break; }
        const parsed = parse(res.body);
        if (!parsed) { log.warning(`${store}: page ${page} for "${term}" could not be read.`); break; }
        total ??= parsed.total;
        const before = rows.length;
        for (const r of parsed.rows) if (!rows.some((x) => x.productId === r.productId)) rows.push(r);
        if (rows.length === before || parsed.rows.length < PAGE_SIZE[store] / 2 || (total != null && page * PAGE_SIZE[store] >= total)) break;
    }
    return { rows: rows.slice(0, perStore), total };
}

for (const term of terms) {
    if (stop || deadline.pastSoft()) break;
    const got = {};
    for (const s of which) got[s] = await readStore(s, term);
    const all = which.flatMap((s) => got[s].rows);
    const matches = compareStores && which.length === 2 ? matchStores(got.woolworths.rows, got.coles.rows) : new Map();
    const rows = all
        .filter((r) => !onlySpecials || r.onSpecial)
        .map((r) => {
            const m = matches.get(`${r.store}:${r.productId}`);
            const row = { search: term, ...r };
            if (compareStores && which.length === 2) {
                row.otherStore = m ? { store: m.other.store, productId: m.other.productId, name: m.other.name, price: m.other.price, onSpecial: m.other.onSpecial, url: m.other.url } : null;
                row.cheaperAt = m && r.price != null && m.other.price != null ? (r.price < m.other.price ? r.store : r.price > m.other.price ? m.other.store : 'same price') : null;
                row.priceDifference = m && r.price != null && m.other.price != null ? +Math.abs(r.price - m.other.price).toFixed(2) : null;
            }
            row.scrapedAt = new Date().toISOString();
            return row;
        });
    if (rows.length) {
        await Actor.pushData(rows);
        out += rows.length;
        if (!(await chargeRows(guard, 'product', PRICE, rows.length))) stop = true;
    }
    const pairs = [...matches.keys()].filter((k) => k.startsWith('woolworths:')).length;
    perSearch.push({ search: term, ...Object.fromEntries(which.map((s) => [s, { read: got[s].rows.length, totalAtStore: got[s].total }])), returned: rows.length, matchedPairs: pairs });
    log.info(`"${term}": ${which.map((s) => `${s} ${got[s].rows.length}`).join(', ')}; ${rows.length} returned, ${pairs} matched across stores.`);
}

if (!out) await Actor.pushData({ note: 'No products found. Not charged. Try a broader search or turn off "only specials".' });
await Actor.setValue('SUMMARY', { products: out, ...guard.report(), searches: perSearch });
log.info(`Done: ${out} products. ${JSON.stringify(guard.report())}`);
await Actor.exit();
