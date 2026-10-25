// Amazon.com page parsers: search/listing pages (ASINs), the all-offers panel
// (sellers of one ASIN) and seller profiles (business name and address).
//
// The offers panel is /gp/product/ajax/aodAjaxMain/?asin=<ASIN>&pc=dp; each
// third-party offer links its seller as /gp/aag/main?seller=<ID>. The seller
// profile /sp?seller=<ID> carries "Detailed Seller Information" (business
// name and address, which US sellers must publish under the INFORM Consumers
// Act) and the 12-month feedback summary. Verified 2026-10-25.

import * as cheerio from 'cheerio';

const txt = (x) => x.text().replace(/\s+/g, ' ').trim();

export function isAmazonBlock(r) {
    if ([202, 429, 503].includes(r.statusCode) || r.statusCode >= 500) return true;
    const head = r.body.slice(0, 20_000);
    return r.body.length < 6_000 && /api-services-support@amazon|bm-verify|gokuProps|Type the characters you see|validateCaptcha/i.test(head)
        || /Type the characters you see in this image|\/errors\/validateCaptcha/i.test(head);
}

/** ASINs from a search, bestseller or category listing page, in page order. */
export function parseListing(html) {
    const $ = cheerio.load(html);
    const out = [];
    const seen = new Set();
    // Search pages mark real results; bestseller and category pages do not.
    const results = $('[data-component-type="s-search-result"][data-asin]');
    (results.length ? results : $('[data-asin]')).each((_, el) => {
        const asin = $(el).attr('data-asin');
        if (!/^[A-Z0-9]{10}$/.test(asin || '') || seen.has(asin)) return;
        seen.add(asin);
        const c = $(el);
        const h2 = c.find('h2').first();
        const title = (h2.attr('aria-label') || '').replace(/^Sponsored Ad - /, '') || txt(h2) || txt(c.find('[class*="line-clamp"]').first()) || null;
        out.push({ asin, title, sponsored: /^Sponsored/.test(h2.attr('aria-label') || '') });
    });
    return out;
}

/** Third-party offers on the all-offers panel. Amazon's own offers have no seller link and are skipped. */
export function parseOffers(html) {
    const $ = cheerio.load(html);
    const title = txt($('#aod-asin-title-text').first()) || null;
    const offers = [];
    $('#aod-pinned-offer, #aod-offer').each((_, el) => {
        const c = $(el);
        const a = c.find('#aod-offer-soldBy a[href*="seller="]').first();
        const href = a.attr('href') || '';
        const sellerId = /[?&]seller=([A-Z0-9]{8,20})/.exec(href)?.[1];
        if (!sellerId) return;
        const rating = txt(c.find('#aod-offer-seller-rating').first());
        offers.push({
            sellerId,
            sellerName: txt(a) || null,
            price: Number(/([\d,]+(?:\.\d{1,2})?)/.exec(txt(c.find('.apex-pricetopay-accessibility-label, .a-price .a-offscreen').first()) || '')?.[1].replace(/,/g, '')) || null,
            condition: txt(c.find('#aod-offer-heading').first()).replace(/^(.*?)\s*\1$/, '$1') || null,
            shipsFrom: txt(c.find('#aod-offer-shipsFrom .a-col-right').first()) || null,
            fulfilledByAmazon: /isAmazonFulfilled=1/.test(href),
            sellerRatingText: rating || null,
        });
    });
    return { title, offers };
}

function splitAddress(lines) {
    const L = lines.filter((l) => !/^DBA\b/i.test(l));
    const out = { street: null, city: null, state: null, postalCode: null, country: null };
    if (!L.length) return out;
    let i = L.length - 1;
    if (/^[A-Z]{2}$/.test(L[i])) out.country = L[i--];
    if (i >= 0 && /^[A-Z0-9][A-Z0-9 -]{2,9}$/i.test(L[i]) && /\d/.test(L[i])) out.postalCode = L[i--];
    if (i >= 1 && /^[A-Z]{2}$/.test(L[i]) && out.country === 'US') out.state = L[i--];
    else if (i >= 1 && L[i].length <= 30 && out.country && out.country !== 'US') out.state = L[i--];
    if (i >= 1) out.city = L[i--];
    out.street = L.slice(0, i + 1).join(', ') || null;
    return out;
}

export function parseSellerProfile(html, sellerId) {
    const $ = cheerio.load(html);
    $('script,style').remove();
    const sellerName = txt($('#seller-name').first()) || null;
    if (!sellerName && !$('#page-section-detail-seller-info').length) return null;
    const box = $('#page-section-detail-seller-info');
    let businessName = null;
    const fields = {};
    const addressLines = [];
    let inAddress = false;
    box.find('.a-row').each((_, row) => {
        const r = $(row);
        const label = txt(r.find('.a-text-bold').first()).replace(/:\s*$/, '');
        if (label) {
            const value = txt(r.find('span').not('.a-text-bold').first()) || null;
            inAddress = /address/i.test(label);
            if (/business name/i.test(label)) businessName = value;
            else if (!inAddress && value) fields[label] = value;
            return;
        }
        if (inAddress && r.hasClass('indent-left')) {
            const v = txt(r);
            if (v) addressLines.push(v);
        }
    });
    const dba = addressLines.find((l) => /^DBA\b/i.test(l))?.replace(/^DBA\s+/i, '') || null;
    const fb = txt($('#seller-info-feedback-summary').first());
    const stars = /([\d.]+) out of 5 stars/.exec(fb)?.[1];
    const pos = /(\d+)% positive/.exec(fb)?.[1];
    const count = /\(([\d,]+) ratings?\)/.exec(fb)?.[1];
    // The expander repeats a truncated preview ("... ") ahead of the full text.
    let about = txt($('#spp-expander-about-seller .a-expander-content, #spp-expander-about-seller').first()) || null;
    const cut = about ? about.indexOf('... ') : -1;
    if (cut > 40 && about.slice(cut + 4).startsWith(about.slice(0, 40))) about = about.slice(cut + 4);
    const addr = splitAddress(addressLines);
    return {
        sellerId,
        sellerName,
        businessName,
        dba,
        businessAddress: addressLines.filter((l) => !/^DBA\b/i.test(l)).join(', ') || null,
        ...addr,
        otherDetails: Object.keys(fields).length ? fields : null,
        rating12Months: stars ? Number(stars) : null,
        positivePct12Months: pos ? Number(pos) : null,
        ratings12Months: count ? Number(count.replace(/,/g, '')) : null,
        aboutSeller: about && about !== sellerName ? about.replace(new RegExp(`^${sellerName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').slice(0, 2000) : null,
        sellerUrl: `https://www.amazon.com/sp?seller=${sellerId}`,
        storefrontUrl: `https://www.amazon.com/s?me=${sellerId}`,
    };
}
