// Vinted Scraper: second-hand listings from any Vinted country site for a
// search term or catalog URL, with price, Vinted fee and total, brand, size,
// condition, favourites, photos and the seller id; optionally the full
// description, colour, material, category, upload time and the seller's
// name, review count and rating from each item page.
//
// Strategy
// --------
// Vinted's JSON API (/api/v2/catalog/items) answers 403 without a session,
// but the catalog page is server-rendered with a React Server Components
// payload (one self.__next_f.push([1,"..."]) string). Inside it,
// "items":{"items":[...]} holds every card with price, serviceFee,
// totalItemPrice, favouriteCount, photos, user and itemBox (firstLine is the
// brand, secondLine "size · condition"), and "pagination" holds
// total_entries and total_pages.
//
// A search shows at most 960 items (10 pages of 96) and then reports
// total_entries: 960 exactly. When a band reports 960 and the caller wants
// more, it is split by price (price_from / price_to) and each half searched
// again, down to bands of 1 unit of currency. Rows are de-duplicated by id.
//
// Item pages carry JSON-LD (description, category, colour) and, in the RSC
// payload, an attributes plugin ({"code":"upload_date","data":{"title",
// "value"}}) and the seller block (name, feedback_count,
// feedback_reputation 0-1, business).
//
// No key, no proxy.
//
// Pay per event
// -------------
//   item        ($0.0008) one listing from the catalog page
//   item_detail ($0.002)  the same listing plus its item page; charged
//                         instead of item
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PER_PAGE = 96;
const CAP = 960;
const DOMAINS = {
    uk: 'www.vinted.co.uk', gb: 'www.vinted.co.uk', fr: 'www.vinted.fr', de: 'www.vinted.de', es: 'www.vinted.es', it: 'www.vinted.it',
    nl: 'www.vinted.nl', be: 'www.vinted.be', at: 'www.vinted.at', pl: 'www.vinted.pl', pt: 'www.vinted.pt', lt: 'www.vinted.lt',
    cz: 'www.vinted.cz', sk: 'www.vinted.sk', hu: 'www.vinted.hu', ro: 'www.vinted.ro', se: 'www.vinted.se', dk: 'www.vinted.dk',
    fi: 'www.vinted.fi', gr: 'www.vinted.gr', hr: 'www.vinted.hr', ie: 'www.vinted.ie', lu: 'www.vinted.lu', us: 'www.vinted.com',
};
const SORT = { relevance: 'relevance', newest: 'newest_first', price_asc: 'price_low_to_high', price_desc: 'price_high_to_low' };
// Card labels in the accessibility string, per site language.
const LABELS = {
    brand: ['Brand', 'Marke', 'Marque', 'Marca', 'Merk', 'Marka', 'Značka', 'Márka', 'Brändi', 'Mærke', 'Märke', 'Prekės ženklas'],
    condition: ['Condition', 'Zustand', 'État', 'Estado', 'Condizioni', 'Staat', 'Stan', 'Stav', 'Állapot', 'Kunto', 'Stand', 'Skick', 'Būklė', 'Stare'],
    size: ['Size', 'Größe', 'Taille', 'Talla', 'Taglia', 'Maat', 'Rozmiar', 'Velikost', 'Veľkosť', 'Méret', 'Koko', 'Størrelse', 'Storlek', 'Dydis', 'Mărime', 'Tamanho'],
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    country = 'uk',
    sortBy = 'relevance',
    minPrice = null,
    maxPrice = null,
    includeDetails = false,
    maxItemsPerSearch = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 200);

async function getHtml(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
            if (r.status === 404 || r.status === 410) return null;
            if (r.ok) return await r.text();
            last = new Error(`HTTP ${r.status}`);
        } catch (err) {
            last = err;
        }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

// All self.__next_f.push([1,"..."]) chunks, decoded and joined.
function rscPayload(html) {
    return [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
}

// The JSON value that starts at s[i] (object or array), skipping strings.
function sliceJson(s, i) {
    let depth = 0;
    for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (c === '"') { k++; while (k < s.length && s[k] !== '"') { if (s[k] === '\\') k++; k++; } continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(i, k + 1)); }
    }
    return null;
}

async function catalogPage(url) {
    const html = await getHtml(url);
    if (!html) return { items: [], total: 0, pages: 0 };
    const s = rscPayload(html);
    const key = '"items":{"items":';
    const i = s.indexOf(key);
    if (i < 0) {
        if (/catalog/i.test(html) && !/captcha|challenge/i.test(html.slice(0, 5000))) return { items: [], total: 0, pages: 0 };
        throw new Error('Vinted returned a page without listings (blocked or changed).');
    }
    const items = sliceJson(s, i + key.length) || [];
    const p = s.indexOf('"pagination":');
    const pg = p >= 0 ? sliceJson(s, p + '"pagination":'.length) : null;
    return { items, total: pg?.total_entries ?? null, pages: pg?.total_pages ?? null };
}

// ---------- Searches ----------

function buildSearches(qs = list(queries)) {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)vinted\.[a-z.]+$/.test(url.hostname) || !url.pathname.startsWith('/catalog')) {
            out.push({ error: `Not a Vinted catalog URL (vinted.xx/catalog?search_text=...): ${u}` });
            continue;
        }
        url.searchParams.delete('page');
        out.push({ url, label: u });
    }
    const host = DOMAINS[String(country).toLowerCase()] || DOMAINS.uk;
    for (const q of qs) {
        const url = new URL(`https://${host}/catalog`);
        url.searchParams.set('search_text', q);
        if (SORT[sortBy] && sortBy !== 'relevance') url.searchParams.set('order', SORT[sortBy]);
        if (Number(minPrice) > 0) url.searchParams.set('price_from', String(minPrice));
        if (Number(maxPrice) > 0) url.searchParams.set('price_to', String(maxPrice));
        out.push({ url, label: `"${q}" on ${host.replace('www.', '')}` });
    }
    return out;
}

// Pages of one price band; yields arrays of raw items.
async function* band(base, from, to, stats) {
    const url = new URL(base);
    if (from !== null) url.searchParams.set('price_from', String(from)); else url.searchParams.delete('price_from');
    if (to !== null) url.searchParams.set('price_to', String(to)); else url.searchParams.delete('price_to');
    for (let page = 1; page <= CAP / PER_PAGE; page++) {
        if (page > 1) url.searchParams.set('page', String(page));
        const r = await catalogPage(url.toString());
        if (page === 1) { stats.total = r.total; stats.pages = r.pages; }
        yield r.items;
        if (r.items.length < PER_PAGE || (r.pages && page >= r.pages)) return;
        await sleep(500);
    }
}

// Whole search: the base band, then price halves of any band that hit 960.
async function* search(s, stats, need) {
    const base = s.url;
    const lo0 = Number(base.searchParams.get('price_from')) || 0;
    const hi0 = Number(base.searchParams.get('price_to')) || null;
    const queue = [[base.searchParams.get('price_from') ? lo0 : null, hi0]];
    let first = true;
    while (queue.length && need() > 0) {
        const [from, to] = queue.shift();
        const st = {};
        // Peek at page 1 first: if the band is capped and more is wanted,
        // split it instead of reading 10 pages that will be read again.
        const it = band(base, from, to, st);
        const firstPage = await it.next();
        const capped = st.total === CAP;
        const lo = from ?? 0;
        const hi = to ?? (lo < 50 ? 100 : lo * 4);
        if (capped && need() > PER_PAGE && hi - lo > 1 && !(first && need() <= CAP)) {
            const mid = Math.round(((lo + hi) / 2) * 100) / 100;
            queue.push([lo === 0 && from === null ? null : lo, mid], [mid, to]);
            if (first) log.info(`${s.label}: over ${CAP} results, splitting by price.`);
            first = false;
            continue;
        }
        if (first) stats.total = st.total;
        first = false;
        if (!firstPage.done) yield firstPage.value;
        for await (const items of it) yield items;
    }
}

// ---------- Rows ----------

const num = (m) => (m && m.amount !== undefined && m.amount !== null && m.amount !== '' ? Number(m.amount) : null);
function fromLabel(label, keys) {
    for (const k of keys) {
        const m = String(label || '').match(new RegExp(`(?:^|, )${k}: ([^,]+)`));
        if (m) return m[1].trim();
    }
    return null;
}

function row(x, host, search) {
    const p = x.productItem || x;
    const box = p.itemBox || {};
    const parts = String(box.secondLine || '').split(' · ').map((t) => t.trim()).filter(Boolean);
    const condition = fromLabel(box.accessibilityLabel, LABELS.condition) || (parts.length ? parts[parts.length - 1] : null);
    const size = fromLabel(box.accessibilityLabel, LABELS.size) || (parts.length > 1 ? parts.slice(0, -1).join(' · ') : null);
    const price = num(p.priceWithDiscount) ?? num(p.price);
    return {
        itemId: p.id,
        url: p.url ? `https://${host}${p.url.split('?')[0]}` : null,
        title: p.title || null,
        brand: fromLabel(box.accessibilityLabel, LABELS.brand) || box.firstLine || null,
        size,
        condition,
        price,
        originalPrice: p.priceWithDiscount ? num(p.price) : null,
        buyerFee: num(p.serviceFee),
        totalPrice: num(p.totalItemPrice),
        currency: p.price?.currencyCode || null,
        favourites: p.favouriteCount ?? null,
        isPromoted: p.isPromoted ?? null,
        sellerId: p.user?.id ?? x.catalogTracking?.ownerId ?? null,
        sellerIsBusiness: p.user?.isBusiness ?? null,
        imageUrl: p.photos?.[0]?.url || p.thumbnailUrl || null,
        imageUrls: (p.photos || []).map((ph) => ph.url).filter(Boolean),
        site: host.replace('www.', ''),
        search,
        scrapedAt: new Date().toISOString(),
    };
}

async function addDetails(r) {
    try {
        const html = await getHtml(r.url);
        if (!html) { r.detailError = 'Item no longer available.'; return r; }
        const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).find((x) => x?.['@type'] === 'Product') || {};
        const s = rscPayload(html);
        const attrs = {};
        for (const m of s.matchAll(/\{"code":"([a-z_]+)","data":\{"title":"((?:[^"\\]|\\.)*)","value":"((?:[^"\\]|\\.)*)"/g)) attrs[m[1]] = JSON.parse(`"${m[3]}"`);
        let seller = null;
        const si = s.indexOf('"feedback_reputation"');
        if (si > 0) {
            const start = s.lastIndexOf('{"badges"', si);
            const obj = start >= 0 ? sliceJson(s, start) : null;
            if (obj?.name) seller = obj;
        }
        Object.assign(r, {
            description: ld.description || null,
            category: ld.category || null,
            color: attrs.color || ld.color || null,
            material: attrs.material || null,
            uploaded: attrs.upload_date || null,
            sellerName: seller?.name || null,
            sellerUrl: r.sellerId ? `${new URL(r.url).origin}/member/${r.sellerId}` : null,
            sellerReviews: seller?.feedback_count ?? null,
            sellerRating: seller && seller.feedback_count ? Math.round(seller.feedback_reputation * 50) / 10 : null,
            itemAttributes: attrs,
        });
    } catch (err) {
        r.detailError = String(err?.message || err);
    }
    return r;
}

// ---------- Run ----------

let items = 0;
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
if (!searches.length) searches.push(...buildSearches(['nike jacket']));

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    const host = s.url.hostname;
    const seen = new Set();
    let count = 0;
    const stats = {};
    try {
        for await (const batch of search(s, stats, () => (keepGoing ? perSearch - count : 0))) {
            const rows = [];
            for (const x of batch) {
                const id = x?.productItem?.id ?? x?.id;
                if (!id || seen.has(id) || count + rows.length >= perSearch) continue;
                seen.add(id);
                rows.push(row(x, host, s.label));
            }
            if (includeDetails) for (let i = 0; i < rows.length; i += 4) { await Promise.all(rows.slice(i, i + 4).map(addDetails)); await sleep(300); }
            for (const r of rows) {
                await Actor.pushData(r);
                items += 1;
                count += 1;
                if (!(await charge(includeDetails && !r.detailError ? 'item_detail' : 'item'))) { keepGoing = false; break; }
            }
            if (!keepGoing || count >= perSearch) break;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
        const refused = /HTTP (403|429)/.test(String(err?.message));
        await Actor.pushData({ rowType: 'error', search: s.label, error: refused ? "Vinted refused this run's server (HTTP 403), which happens to a small share of runs. Run it again. Not charged." : `${err?.message}. Not charged.` });
    }
    log.info(`${s.label}: ${count} item(s).`);
    perSearchCounts.push({ search: s.label, items: count });
}

if (!items && !failures.length) await Actor.pushData({ rowType: 'note', note: 'No items found. Not charged.' });
await Actor.setValue('SUMMARY', { items, searches: perSearchCounts, failures });
log.info(`Done. ${items} item(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
