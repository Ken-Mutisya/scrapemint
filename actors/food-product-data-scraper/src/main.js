// Food Product Data Scraper: Barcode & Name Lookup
//
// Strategy
// --------
// Open Food Facts (world.openfoodfacts.org), keyless JSON, verified reachable
// from Apify DC IPs. Barcode mode hits /api/v2/product/{code} (one GET per
// barcode, exact). Search mode hits the classic cgi/search.pl JSON endpoint
// (one GET per query, best matches by popularity). Both take a fields param
// so responses stay small.
//
// Open Food Facts asks for an identifying user agent and caps product reads
// at ~100/min and searches at ~10/min per IP: barcode jobs run in a small
// pool with spacing, search jobs run serialized with 6.5s between calls.
//
// Pay per event
// -------------
//   product_found per matched product row. Barcodes and searches that match
//   nothing are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product';
const SEARCH_URL = 'https://world.openfoodfacts.org/cgi/search.pl';
const FIELDS = 'code,product_name,generic_name,brands,quantity,serving_size,categories_tags,labels_tags,countries_tags,ingredients_text,allergens_tags,additives_tags,nutriscore_grade,nova_group,ecoscore_grade,nutriments,image_front_url,stores';
const UA = 'scrapemint-food-product-data-scraper/0.1 (+https://apify.com; kennedymutisya@icloud.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const POOL_SIZE = 3;
const SEARCH_SPACING_MS = 6500;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { barcodes = [], searches = [], maxResultsPerQuery = 3, maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);

// GTIN mod-10 check digit (EAN-8, UPC-A, EAN-13): catches mistyped and
// mis-scanned numbers before they burn an API call.
function gtinChecksumOk(clean) {
    const digits = clean.split('').map(Number);
    const check = digits.pop();
    let sum = 0;
    digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
}

const barcodeJobs = [];
const searchJobs = [];
const seen = new Set();
for (const raw of asTokens(barcodes)) {
    const clean = raw.replace(/[\s-]/g, '');
    if (!/^\d{8}$|^\d{12,13}$/.test(clean)) {
        barcodeJobs.push({ input: raw, error: 'not a valid EAN-8, UPC-A or EAN-13 barcode' });
        continue;
    }
    if (!gtinChecksumOk(clean)) {
        barcodeJobs.push({ input: raw, error: 'not a valid barcode (check digit failed — probably a typo or bad scan)' });
        continue;
    }
    if (seen.has(`b:${clean}`)) continue;
    seen.add(`b:${clean}`);
    barcodeJobs.push({ input: raw, barcode: clean });
}
for (const q of asTokens(searches)) {
    const key = `q:${q.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    searchJobs.push({ input: q });
}

const perQuery = Math.max(1, Math.min(50, Number(maxResultsPerQuery) || 3));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (barcodeJobs.length === 0 && searchJobs.length === 0) {
    log.warning('No barcodes or searches given. Paste at least one barcode or a search like "oat milk".');
    await Actor.exit();
}

async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            const json = await res.json().catch(() => null);
            return { status: res.status, json };
        } catch (err) {
            if (attempt === 3) return { status: 0, json: null, error: err?.message };
            await sleep(attempt * 5000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { status: 0, json: null };
}

let rowsPushed = 0;
let chargeableRows = 0;
let found = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'product_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// "en:hazelnut-spreads" -> "hazelnut spreads"; keeps any-language tags readable.
const cleanTags = (tags, capN) => [...new Set((tags || []).map((t) => String(t).replace(/^[a-z]{2,3}:/, '').replace(/-/g, ' ')))].slice(0, capN);
const grade = (g) => (g && g !== 'unknown' && g !== 'not-applicable' ? String(g).toUpperCase() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toRow(job, mode, p) {
    const n = p.nutriments || {};
    return {
        input: job.input,
        mode,
        barcode: p.code || job.barcode || null,
        name: p.product_name || p.generic_name || null,
        brands: p.brands || null,
        quantity: p.quantity || null,
        servingSize: p.serving_size || null,
        categories: cleanTags(p.categories_tags, 8),
        labels: cleanTags(p.labels_tags, 8),
        countries: cleanTags(p.countries_tags, 8),
        stores: p.stores || null,
        ingredients: p.ingredients_text || null,
        allergens: cleanTags(p.allergens_tags, 10),
        additives: cleanTags(p.additives_tags, 10),
        nutriScore: grade(p.nutriscore_grade),
        novaGroup: p.nova_group ?? null,
        ecoScore: grade(p.ecoscore_grade),
        nutritionPer100g: {
            energyKcal: num(n['energy-kcal_100g']),
            fat: num(n.fat_100g),
            saturatedFat: num(n['saturated-fat_100g']),
            carbohydrates: num(n.carbohydrates_100g),
            sugars: num(n.sugars_100g),
            fiber: num(n.fiber_100g),
            proteins: num(n.proteins_100g),
            salt: num(n.salt_100g),
        },
        imageUrl: p.image_front_url || null,
        productUrl: p.code ? `https://world.openfoodfacts.org/product/${p.code}` : null,
    };
}

log.info(`Looking up ${barcodeJobs.length} barcode(s) and ${searchJobs.length} search(es) (${perQuery} match(es) per search)...`);

let stopped = false;

async function lookupBarcode(code) {
    const url = `${PRODUCT_URL}/${code}?fields=${encodeURIComponent(FIELDS)}`;
    return fetchJson(url);
}

let barcodeCursor = 0;
async function barcodeWorker() {
    while (!stopped) {
        const i = barcodeCursor++;
        if (i >= barcodeJobs.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const job = barcodeJobs[i];

        if (job.error) {
            await flushRow({ input: job.input, mode: 'barcode', found: false, note: job.error }, false);
            continue;
        }

        let { status, json, error } = await lookupBarcode(job.barcode);
        // US products scanned as 12-digit UPC-A are often catalogued under the
        // 13-digit form with a leading zero; retry once before giving up.
        if (status === 404 && job.barcode.length === 12) {
            ({ status, json, error } = await lookupBarcode(`0${job.barcode}`));
        }

        if (status !== 200 && status !== 404) {
            await flushRow({ input: job.input, mode: 'barcode', found: false, note: `could not look up (${error || `HTTP ${status}`}); not charged, try again later` }, false);
            log.warning(`${job.input}: HTTP ${status} ${error || ''}`);
            continue;
        }
        const product = json?.status === 1 ? json.product : null;
        if (!product) {
            await flushRow({ input: job.input, mode: 'barcode', found: false, note: 'no product found for this barcode' }, false);
            continue;
        }
        found += 1;
        await flushRow({ ...toRow(job, 'barcode', product), found: true }, true);
        await sleep(200);
    }
}

async function searchWorker() {
    for (let i = 0; i < searchJobs.length; i += 1) {
        if (stopped || rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        if (i > 0) await sleep(SEARCH_SPACING_MS);
        const job = searchJobs[i];

        const url = `${SEARCH_URL}?search_terms=${encodeURIComponent(job.input)}&search_simple=1&action=process&json=1&page_size=${perQuery}&fields=${encodeURIComponent(FIELDS)}`;
        const { status, json, error } = await fetchJson(url);

        if (status !== 200 || !json) {
            await flushRow({ input: job.input, mode: 'search', found: false, note: `could not search (${error || `HTTP ${status}`}); not charged, try again later` }, false);
            log.warning(`${job.input}: HTTP ${status} ${error || ''}`);
            continue;
        }
        const products = (json.products || []).filter((p) => p && p.code);
        if (products.length === 0) {
            await flushRow({ input: job.input, mode: 'search', found: false, note: 'no products found' }, false);
            continue;
        }
        for (const p of products) {
            if (rowsPushed >= cap) { stopped = true; break; }
            if (seen.has(`b:${p.code}`)) continue;
            seen.add(`b:${p.code}`);
            found += 1;
            await flushRow({ ...toRow(job, 'search', p), found: true }, true);
        }
    }
}

await Promise.all([
    ...Array.from({ length: Math.min(POOL_SIZE, barcodeJobs.length) }, barcodeWorker),
    searchWorker(),
]);

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} product(s) found `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; not-found and bad input are free).`);
await Actor.exit();
