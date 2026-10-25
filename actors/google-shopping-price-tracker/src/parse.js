// Parser for Google Shopping result pages (google.com/search?udm=28).
//
// Each product card carries data-iid / data-oid / data-pid. Visible fields
// come from the card; brand, image and Google's product cluster id come from
// a base64 protobuf blob in the embedded JS keyed by the same ids
// ("<iid>","<gid>","<oid>","<pid>","<blob>"). Merchant URLs are not on the
// results page (Google opens them in a panel), so rows carry the ids instead.
// Class names were stable across every page sampled on 2026-10-25.

import * as cheerio from 'cheerio';

export function parsePrice(t) {
    if (!t) return null;
    const m = /([\d][\d,]*(?:\.\d+)?)/.exec(t.replace(/\s/g, ''));
    return m ? Number(m[1].replace(/,/g, '')) : null;
}

const currencyOf = (t) => (/£/.test(t) ? 'GBP' : /€/.test(t) ? 'EUR' : /A\$|AU\$/.test(t) ? 'AUD' : /C\$|CA\$/.test(t) ? 'CAD' : /₹/.test(t) ? 'INR' : /\$/.test(t) ? 'USD' : null);

function count(t) {
    const m = /([\d.]+)\s*([KkMm])?/.exec(t || '');
    if (!m) return null;
    return Math.round(Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
}

function blobInfo(raw, iid) {
    const i = raw.indexOf(`["${iid}","`);
    if (i < 0) return {};
    const m = /^\["\d+","[^"]*","\d*","\d*","([A-Za-z0-9+/_=-]{40,})"/.exec(raw.slice(i, i + 8000));
    if (!m) return {};
    let b;
    try {
        const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
        b = Buffer.from(s.slice(0, Math.floor(s.length / 4) * 4), 'base64').toString('latin1');
    } catch { return {}; }
    const strings = [...b.matchAll(/[\x20-\x7e]{3,}/g)].map((x) => x[0]);
    const cluster = /PROD_PC_(\d+)|PC_(\d+)/.exec(b);
    const image = strings.find((s) => /^https:\/\/encrypted-tbn\d\.gstatic\.com\/shopping/.test(s)) || null;
    // The brand is the short string right after the title field.
    const brand = strings.length > 1 && strings[1].length < 40 && !/Reviews|^\d/.test(strings[1]) ? strings[1].replace(/"\S*$/, '').trim() || null : null;
    return { productClusterId: cluster ? cluster[1] || cluster[2] : null, image, brand };
}

export function parseShoppingPage(raw) {
    const $ = cheerio.load(raw);
    $('script,style,svg').remove();
    const rows = [];
    $('[data-oid][data-pid]').each((i, el) => {
        const c = $(el);
        const t = (sel) => c.find(sel).first().text().replace(/\s+/g, ' ').trim() || null;
        const title = t('.gkQHve') || c.find('img[alt]').first().attr('alt')?.replace(/\.\s*$/, '') || null;
        const priceText = t('.lmQWe');
        if (!title || !priceText) return;
        const wasText = t('.DoCHT');
        const price = parsePrice(priceText);
        const was = wasText ? parsePrice(wasText) : null;
        const iid = c.attr('data-iid') || null;
        const info = iid ? blobInfo(raw, iid) : {};
        const ratingText = t('.yi40Hd');
        rows.push({
            position: rows.length + 1,
            title,
            price,
            priceText,
            // On multi-store cards the second figure can be another store's price; only a higher one is a was-price.
            originalPrice: was && price && was > price ? was : null,
            discountText: t('.NkyFue'),
            currency: currencyOf(priceText),
            merchant: t('.WJMUdc'),
            moreMerchants: !!t('.Ludoze'),
            delivery: t('.ybnj7e'),
            returns: t('.l9Ycjb'),
            rating: ratingText ? Number(ratingText) : null,
            reviews: count(t('.RDApEe')),
            brand: info.brand && title.toLowerCase().includes(info.brand.toLowerCase()) ? info.brand : null,
            image: info.image ?? null,
            productClusterId: info.productClusterId ?? null,
            offerId: c.attr('data-oid') || null,
            productId: c.attr('data-pid') || null,
            itemId: iid,
        });
    });
    return rows;
}

export function shoppingHealth(raw, rows) {
    return { cards: (raw.match(/data-oid="/g) || []).length, parsed: rows.length };
}
