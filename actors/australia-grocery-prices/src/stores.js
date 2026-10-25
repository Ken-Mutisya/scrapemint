// Woolworths and Coles search readers, and the cross-store matcher.
//
// Woolworths: GET woolworths.com.au/apis/ui/Search/products?searchTerm=&
// pageNumber=&pageSize=36 returns JSON (Products[].Products[] tiles) with
// price, was-price, cup price, specials, stock, barcode and category.
// Coles: GET coles.com.au/search/products?q=&page= is a Next.js page; the
// results (48 per page) are in __NEXT_DATA__ props.pageProps.searchResults.
// Both answered Apify datacenter IPs on 2026-10-25 (Coles serves its data
// even when the Incapsula script is on the page).

const WW = 'https://www.woolworths.com.au';
const CO = 'https://www.coles.com.au';
export const PAGE_SIZE = { woolworths: 36, coles: 48 };

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function wwUrl(term, page) {
    return `${WW}/apis/ui/Search/products?${new URLSearchParams({ searchTerm: term, pageNumber: String(page), pageSize: String(PAGE_SIZE.woolworths), sortType: 'TraderRelevance' })}`;
}

export function colesUrl(term, page) {
    return `${CO}/search/products?${new URLSearchParams({ q: term, ...(page > 1 ? { page: String(page) } : {}) })}`;
}

export function parseWoolworths(body) {
    let d;
    try { d = JSON.parse(body); } catch { return null; }
    if (!d || !Array.isArray(d.Products)) return null;
    const rows = [];
    for (const g of d.Products) {
        for (const p of g.Products || []) {
            if (!p?.Stockcode) continue;
            const price = num(p.Price);
            const was = num(p.WasPrice);
            const promo = p.CentreTag?.TagContentText || p.CentreTag?.TagContent || null;
            rows.push({
                store: 'woolworths',
                productId: String(p.Stockcode),
                name: p.DisplayName || p.Name,
                brand: p.Brand || null,
                size: p.PackageSize || null,
                price,
                wasPrice: was && price != null && was > price ? was : null,
                onSpecial: !!(p.IsOnSpecial || p.IsHalfPrice || (was && price != null && was > price)),
                savings: num(p.SavingsAmount) || (was && price != null && was > price ? +(was - price).toFixed(2) : null),
                promotion: typeof promo === 'string' ? promo.replace(/\s+/g, ' ').trim() || null : null,
                unitPrice: num(p.CupPrice),
                unitMeasure: p.CupMeasure || null,
                unitPriceText: p.CupString || null,
                inStock: p.IsInStock ?? p.IsAvailable ?? null,
                barcode: p.Barcode || null,
                category: p.AdditionalAttributes?.sapcategoryname || p.AdditionalAttributes?.piescategorynamesjson || null,
                image: p.LargeImageFile || p.MediumImageFile || null,
                url: `${WW}/shop/productdetails/${p.Stockcode}/${p.UrlFriendlyName || slug(p.Name)}`,
            });
        }
    }
    return { rows, total: num(d.SearchResultsCount) };
}

export function parseColes(body) {
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(body);
    if (!m) return null;
    let nd;
    try { nd = JSON.parse(m[1]); } catch { return null; }
    const sr = nd?.props?.pageProps?.searchResults;
    if (!sr || !Array.isArray(sr.results)) return null;
    const rows = [];
    for (const r of sr.results) {
        if (r?._type !== 'PRODUCT' || !r.id) continue;
        const pr = r.pricing || {};
        const price = num(pr.now);
        const was = num(pr.was);
        const name = [r.brand, r.name, r.size].filter(Boolean).join(' ');
        rows.push({
            store: 'coles',
            productId: String(r.id),
            name,
            brand: r.brand || null,
            size: r.size || null,
            price,
            wasPrice: was && price != null && was > price ? was : null,
            onSpecial: !!(pr.promotionType || pr.onlineSpecial || (was && price != null && was > price)),
            savings: was && price != null && was > price ? +(was - price).toFixed(2) : null,
            promotion: pr.offerDescription || pr.multiBuyPromotion?.reward || pr.promotionType || null,
            unitPrice: num(pr.unit?.price),
            unitMeasure: pr.unit?.ofMeasureQuantity && pr.unit?.ofMeasureUnits ? `${pr.unit.ofMeasureQuantity}${pr.unit.ofMeasureUnits.toUpperCase()}` : null,
            unitPriceText: pr.comparable || null,
            inStock: r.availability ?? null,
            barcode: null,
            category: r.onlineHeirs?.[0]?.category || r.merchandiseHeir?.category || null,
            image: r.imageUris?.[0]?.uri ? `https://productimages.coles.com.au/productimages${r.imageUris[0].uri}` : null,
            url: `${CO}/product/${slug(name)}-${r.id}`,
        });
    }
    return { rows, total: num(sr.noOfResults) };
}

// ---------- matching ----------
const HOUSE = /^(woolworths|coles|macro|community co|essentials|simply|nature'?s kitchen|gold|select|homebrand|smart buy)$/i;
const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'pack', 'each', 'ea']);

export function normSize(s) {
    if (!s) return null;
    const t = String(s).toLowerCase().replace(/\s+/g, '');
    const m = /^(\d+(?:\.\d+)?)(x\d+)?(ml|l|g|kg|pack|pk|each|ea)?$/.exec(t.replace(/^(\d+)x(\d+(?:\.\d+)?)(ml|l|g|kg)$/, '$2x$1$3'));
    if (!m) return t;
    let n = Number(m[1]);
    let u = m[3] || '';
    if (u === 'l') { n *= 1000; u = 'ml'; }
    if (u === 'kg') { n *= 1000; u = 'g'; }
    if (u === 'pk') u = 'pack';
    return `${n}${m[2] || ''}${u}`;
}

const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+(\.\d+)?(ml|l|g|kg|pk)?$/.test(w)));

function jaccard(a, b) {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter || 1);
}

/** Pair each Woolworths product with its best Coles match: same pack size, not a house brand, >= 0.8 word overlap. */
export function matchStores(ww, coles) {
    const byId = new Map();
    const cIdx = coles.filter((c) => c.brand && !HOUSE.test(c.brand.trim())).map((c) => ({ c, size: normSize(c.size), tok: tokens(`${c.brand} ${c.name}`) }));
    for (const w of ww) {
        if (!w.brand || HOUSE.test(w.brand.trim())) continue;
        const size = normSize(w.size);
        const tok = tokens(`${w.brand} ${w.name}`);
        let best = null;
        for (const x of cIdx) {
            if (!size || x.size !== size) continue;
            const s = jaccard(tok, x.tok);
            if (s >= 0.8 && (!best || s > best.s)) best = { ...x, s };
        }
        if (best) {
            byId.set(`woolworths:${w.productId}`, { other: best.c, score: best.s });
            const prev = byId.get(`coles:${best.c.productId}`);
            if (!prev || prev.score < best.s) byId.set(`coles:${best.c.productId}`, { other: w, score: best.s });
        }
    }
    return byId;
}
