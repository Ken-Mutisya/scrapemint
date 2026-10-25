// Parser for Google Images results (google.com/search?udm=2).
//
// Cards carry data-docid, the source page in data-lpage, the title as the
// image alt and the site name in a span. The full-size image URL, its size,
// the thumbnail and the file size are in embedded JS records keyed by the
// same docid:
//   [0,"<docid>",["<thumb>",h,w],["<original>",h,w],null,0,"rgb(..)",null,0,
//    {"2000":[null,"<domain>","105KB"], ... "2003":[null,"<ref>","<page url>","<title>",...]}]
// Verified on a 2026-10-25 page fetched through GOOGLE_SERP (100 images).

import * as cheerio from 'cheerio';

const unesc = (s) => (s == null ? s : s.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\u0027/g, "'").replace(/\\"/g, '"').replace(/\\\//g, '/'));

function records(raw) {
    const map = new Map();
    const re = /\[[01],"([A-Za-z0-9_-]{8,24})",\["(https:[^"]+)",(\d+),(\d+)\],\["(https?:[^"]+)",(\d+),(\d+)\]/g;
    for (const m of raw.matchAll(re)) {
        if (map.has(m[1])) continue;
        const tail = raw.slice(m.index, m.index + 3000);
        const meta = /"2000":\[null,"([^"]*)","([^"]*)"\]/.exec(tail);
        const page = /"2003":\[null,"[^"]*","(https?:[^"]+)","((?:[^"\\]|\\.)*)"/.exec(tail);
        map.set(m[1], {
            thumbnail: unesc(m[2]), thumbnailHeight: +m[3], thumbnailWidth: +m[4],
            imageUrl: unesc(m[5]), height: +m[6], width: +m[7],
            domain: meta?.[1] || null, fileSize: meta?.[2] || null,
            pageUrl: page ? unesc(page[1]) : null, pageTitle: page ? unesc(page[2]) : null,
        });
    }
    return map;
}

export function parseImagesPage(raw) {
    const recs = records(raw);
    const $ = cheerio.load(raw);
    const out = [];
    const seen = new Set();
    $('[data-docid][data-lpage]').each((_, el) => {
        const c = $(el);
        const id = c.attr('data-docid');
        if (seen.has(id)) return;
        seen.add(id);
        const r = recs.get(id) || {};
        const title = c.find('img[alt]').first().attr('alt') || r.pageTitle || null;
        // The site name sits in the twin card (same docid, no data-lpage) after the title.
        const twin = $(`[data-docid="${id}"]`).not('[data-lpage]').first();
        const twinText = twin.text().replace(/\s+/g, ' ').trim();
        const source = title && twinText.startsWith(title) ? twinText.slice(title.length).trim() || null : null;
        out.push({
            position: out.length + 1,
            title,
            imageUrl: r.imageUrl || null,
            width: r.width || null,
            height: r.height || null,
            fileSize: r.fileSize || null,
            thumbnail: r.thumbnail || null,
            source,
            domain: r.domain || null,
            pageUrl: c.attr('data-lpage') || r.pageUrl || null,
            imageId: id,
        });
    });
    return out;
}
