// Parser for Google's local finder (google.com/search?tbm=lcl), the list
// behind the map pack.
//
// Each business is a .VkpGBb card whose .rllt__details block has one line
// per field:
//   L0 name
//   L1 "4.9(3.2K) · Plumber"            rating, review count, category
//   L2 "7+ years in business · Cedar Park, TX"
//   L3 "Open · Closes 2 PM · (512) 775-1234"
//   L4 a review snippet in quotes (optional)
// The Directions link holds the full street address and Google's place
// ids (".../maps/dir//<Name>,+<address>/data=...!1s0x<fid>:0x<cid>").
// Verified on a 2026-10-25 page fetched through GOOGLE_SERP (20 results).

import * as cheerio from 'cheerio';

const PHONE = /(\+?\(?\d[\d\s().-]{7,}\d)/;

function count(t) {
    const m = /([\d.]+)\s*([KkMm])?/.exec(t || '');
    if (!m) return null;
    return Math.round(Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
}

function fromDirections(href, name) {
    if (!href) return {};
    let path;
    try { path = decodeURIComponent(href.replace(/\+/g, ' ')); } catch { path = href; }
    const m = /\/maps\/dir\/\/([^/]+)\/data=([^?]*)/.exec(path);
    if (!m) return {};
    let place = m[1].trim();
    if (name && place.toLowerCase().startsWith(name.toLowerCase())) place = place.slice(name.length).replace(/^,\s*/, '');
    const ids = /!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i.exec(m[2]);
    let cid = null;
    try { cid = ids ? BigInt(ids[2]).toString() : null; } catch { cid = null; }
    return { address: place || null, placeId: ids ? `${ids[1]}:${ids[2]}` : null, cid };
}

export function parseLocalPage(raw) {
    const $ = cheerio.load(raw);
    $('script,style,svg').remove();
    const out = [];
    $('.VkpGBb').each((_, el) => {
        const c = $(el);
        const lines = c.find('.rllt__details').first().children().map((__, x) => $(x).text().replace(/\s+/g, ' ').trim()).get();
        const name = lines[0] || c.find('[role="heading"]').first().text().trim();
        if (!name) return;
        const l1 = (lines[1] || '').split(' · ');
        const rating = /^([\d.]+)/.exec(l1[0] || '')?.[1];
        const reviews = /\(([^)]+)\)/.exec(l1[0] || '')?.[1];
        const hasRating = !!rating;
        const category = (hasRating ? l1.slice(1) : l1).find((x) => x && !/^\$+$|^[$€£]{1,4}$/.test(x)) || null;
        const priceLevel = l1.find((x) => /^[$€£]{1,4}$/.test(x)) || null;
        const l2 = (lines[2] || '').split(' · ');
        const years = l2.find((x) => /years? in business/i.test(x)) || null;
        const area = l2.filter((x) => x !== years).join(' · ') || null;
        const l3 = (lines[3] || '').split(' · ');
        const phone = l3.map((x) => PHONE.exec(x)?.[1]).find(Boolean) || null;
        const hours = l3.filter((x) => !PHONE.test(x)).join(' · ') || null;
        const snippet = lines.slice(4).find((x) => /^["“]/.test(x))?.replace(/^["“]|["”]$/g, '') || null;
        const dir = fromDirections(c.find('a[href^="/maps/dir"]').first().attr('href'), name);
        const sponsored = /\bSponsored\b|\bAd\b ·/.test(c.text().slice(0, 60));
        out.push({
            position: out.length + 1,
            name,
            rating: rating ? Number(rating) : null,
            reviews: reviews ? count(reviews) : null,
            category,
            priceLevel,
            yearsInBusiness: years,
            area,
            address: dir.address || null,
            phone,
            hours,
            reviewSnippet: snippet,
            hasWebsite: c.find('a').filter((__, a) => /Website/.test($(a).text())).length > 0,
            sponsored,
            cid: dir.cid || null,
            placeId: dir.placeId || null,
            mapsUrl: dir.cid ? `https://maps.google.com/?cid=${dir.cid}` : null,
        });
    });
    return out;
}
