// Amazon.com Best Sellers-style list pages (Best Sellers, New Releases,
// Movers & Shakers, Most Wished For, Gift Ideas) and product pages.
//
// A list page holds 50 ranks. All 50 are in the data-client-recs-list JSON
// ([{id: ASIN, metadataMap: {"render.zg.rank": "1",
// "render.zg.bsms.percentageChange": ..., "...twentyFourHourOldSalesRank": ...}}]),
// but only the first ~30 are rendered as cards with title, price, rating,
// review count and image; the rest load as you scroll. Page 2 (?pg=2) holds
// ranks 51-100. Verified on 2026-10-25 pages.

import * as cheerio from 'cheerio';

const txt = (x) => x.text().replace(/\s+/g, ' ').trim();
const num = (s) => { const m = /([\d,]+(?:\.\d+)?)/.exec(s || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };

export function isAmazonBlock(r) {
    if ([202, 429, 503].includes(r.statusCode) || r.statusCode >= 500) return true;
    const head = r.body.slice(0, 20_000);
    return (r.body.length < 6_000 && /api-services-support@amazon|bm-verify|gokuProps|validateCaptcha/i.test(head))
        || /Type the characters you see in this image|\/errors\/validateCaptcha/i.test(head);
}

export function parseListPage(html) {
    const $ = cheerio.load(html);
    const title = $('title').text().replace(/^Amazon\.com\s*/, '').trim();
    const after = (title.split(':').slice(1).join(':') || title).trim();
    const category = after
        .replace(/^The biggest gainers in\s+/i, '').replace(/\s+sales rank over the past 24 hours.*$/i, '')
        .replace(/^(?:Best|Hot New Releases in|The best-selling new (?:&|and) future releases in|The most popular gift ideas in|Most Wished For in|The most wished for items in|Most Gifted in)\s+/i, '')
        .trim() || null;
    let recs = [];
    $('[data-client-recs-list]').each((_, el) => {
        try {
            const j = JSON.parse($(el).attr('data-client-recs-list'));
            if (Array.isArray(j) && j.length > recs.length) recs = j;
        } catch { /* not this one */ }
    });
    const cards = new Map();
    $('[data-asin]').each((_, el) => {
        const c = $(el);
        const asin = c.attr('data-asin');
        if (!/^[A-Z0-9]{10}$/.test(asin || '') || cards.has(asin)) return;
        const rating = /([\d.]+) out of 5/.exec(txt(c.find('.a-icon-alt').first()))?.[1];
        cards.set(asin, {
            title: txt(c.find('[class*="line-clamp"]').first()) || c.find('img').first().attr('alt') || null,
            price: num(txt(c.find('[class*="p13n-sc-price"], .a-color-price').first())),
            priceText: txt(c.find('[class*="p13n-sc-price"], .a-color-price').first()) || null,
            rating: rating ? Number(rating) : null,
            reviews: num(txt(c.find('.a-icon-row .a-size-small, a[href*="product-reviews"] .a-size-small').last())),
            image: c.find('img').first().attr('src') || null,
            percentChangeText: txt(c.find('[class*="zg-percent-change"], .zg-percent-change').first()) || null,
            rankText: txt(c.find('.zg-bdg-text').first()) || null,
        });
    });
    let items = recs.map((r) => {
        const m = r.metadataMap || {};
        return {
            asin: r.id,
            rank: Number(m['render.zg.rank']) || null,
            percentChange: m['render.zg.bsms.percentageChange'] !== '' && m['render.zg.bsms.percentageChange'] != null ? Number(m['render.zg.bsms.percentageChange']) : null,
            salesRank: num(m['render.zg.bsms.currentSalesRank']),
            salesRank24hAgo: num(m['render.zg.bsms.twentyFourHourOldSalesRank']),
            ...(cards.get(r.id) || {}),
        };
    });
    // Some list variants ship no JSON, only cards.
    if (!items.length) items = [...cards.entries()].map(([asin, c]) => ({ asin, rank: num(c.rankText), percentChange: num(c.percentChangeText), salesRank: null, salesRank24hAgo: null, ...c }));
    const subcategories = $('[role="treeitem"] a, [class*="zg-browse-item"] a').map((_, a) => ({ name: txt($(a)), url: new URL($(a).attr('href'), 'https://www.amazon.com').toString().replace(/\/ref=.*$/, '') })).get()
        .filter((s) => s.name && /\/(zgbs|bestsellers|new-releases|movers-and-shakers|most-wished-for|most-gifted)\//.test(s.url));
    // Department-level Movers & Shakers (and some other roots) are carousels of
    // subcategory lists; their "see more" links lead to the ranked lists.
    const listLinks = [...new Set($('a[href]').map((_, a) => $(a).attr('href')).get()
        .filter((h) => /\/(zgbs|bestsellers|new-releases|movers-and-shakers|most-wished-for|most-gifted)\/[a-z-]+\/\d+/.test(h))
        .map((h) => new URL(h, 'https://www.amazon.com').toString().replace(/\/ref=.*$/, '').replace(/[?#].*$/, '')))];
    return { category, items: items.map(({ rankText, percentChangeText, ...x }) => x), subcategories, listLinks };
}

export function parseProductPage(html) {
    const $ = cheerio.load(html);
    const title = txt($('#productTitle').first());
    if (!title) return null;
    const rating = /([\d.]+) out of 5/.exec($('#acrPopover').attr('title') || '')?.[1];
    const priceText = txt($('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .priceToPay .a-offscreen').first()) || null;
    const bsr = txt($('#detailBulletsWrapper_feature_div, #prodDetails').first()).match(/Best Sellers Rank:?\s*#([\d,]+) in ([^(#]+)/);
    return {
        title,
        price: num(priceText),
        priceText,
        rating: rating ? Number(rating) : null,
        reviews: num(txt($('#acrCustomerReviewText').first())),
        image: $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src') || null,
        bestSellersRank: bsr ? Number(bsr[1].replace(/,/g, '')) : null,
        bestSellersRankCategory: bsr ? bsr[2].trim() : null,
    };
}
