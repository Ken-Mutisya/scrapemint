// Parser for a Google results page: the AI Overview block, its cited sources
// and the organic results.
//
// The AI Overview sits in the <section> holding a <strong>AI Overview</strong>
// label. Its cited sources are not plain links (anchors are /goto
// redirects); each one is in an HTML comment shaped like
//   <!--TgQPHd|||[["<uuid>",null,null,0,"<favicon>","<site name>",2,"<url>",...]]-->
// Organic result links are /goto redirects as well, so the domain comes from
// each result's <cite> breadcrumb ("https://www.zoho.com › crm › ...").
// Structure verified on 2026-10-25 pages fetched through GOOGLE_SERP.

import * as cheerio from 'cheerio';

const Q = '(?:&quot;|")';
const CITE_RE = new RegExp(`\\[\\[${Q}[0-9a-f-]{36}${Q},null,null,\\d+,${Q}[^\\]]*?${Q},${Q}(.*?)${Q},\\d+,${Q}(https?:\\/\\/.*?)${Q}`, 'g');
const unesc = (s) => s.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/');

const SITE_DOMAINS = { Reddit: 'reddit.com', Quora: 'quora.com', YouTube: 'youtube.com', LinkedIn: 'linkedin.com', Facebook: 'facebook.com', Medium: 'medium.com', TikTok: 'tiktok.com', Instagram: 'instagram.com', 'Stack Overflow': 'stackoverflow.com' };

export function domainOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

export function parseSerp(raw) {
    const $ = cheerio.load(raw);
    const label = $('strong').filter((_, e) => $(e).text().trim() === 'AI Overview').first();
    const sec = label.length ? label.closest('section') : null;
    let status = 'none';
    let text = null;
    let citations = [];
    let linkedEntities = [];
    const unavailable = /AI Overview is not available for this search|Can(?:'|’)t generate an AI overview right now/i;
    if (sec && sec.length) {
        const html = $.html(sec);
        const clone = sec.clone();
        clone.find('script,style,svg,button,[role="button"]').remove();
        // The source cards sit in a right-hand column; their snippets are not part of the answer.
        clone.find('[data-container-id="rhs-col"]').remove();
        clone.find('br').replaceWith('\n');
        clone.find('div,li,p,h1,h2,h3,h4,ul,ol').each((_, e) => { $(e).append(' \n'); });
        text = clone.text().replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n+/g, '\n')
            .replace(/^[\s\S]{0,40}?AI Mode replied:\s*/, '').replace(/^\W*AI Overview\s*/, '')
            .replace(/Go to product viewer dialog for this item\.\s*/g, '')
            .replace(/\s*(Show all|Show less|Show more|AI responses may include mistakes\.?.*)$/g, '')
            .trim() || null;
        if (unavailable.test(text || '')) { status = 'unavailable'; text = null; }
        else if (text) status = 'shown';
        const seen = new Set();
        for (const m of html.matchAll(CITE_RE)) {
            const url = unesc(m[2]);
            if (seen.has(url)) continue;
            seen.add(url);
            citations.push({ position: citations.length + 1, source: unesc(m[1]), url, domain: domainOf(url) });
        }
        linkedEntities = [...new Set(sec.find('a').map((_, a) => $(a).text().replace(/\s+/g, ' ').trim()).get()
            .filter((t) => t && t.length < 60 && !/·|related results|Show all/i.test(t)))];
        if (status !== 'shown') { citations = []; linkedEntities = []; }
    } else if (unavailable.test(raw)) {
        status = 'unavailable';
    }

    const organic = [];
    $('#rso h3, #search h3').each((_, h) => {
        const a = $(h).closest('a');
        if (!a.length) return;
        if (sec && sec.length && $(h).closest('section').is(sec)) return;
        const block = $(h).closest('[data-hveid]').length ? $(h).closest('[data-hveid]') : a.parent();
        const cites = block.find('cite').map((__, c) => $(c).text().trim()).get();
        const display = cites.find((c) => /^https?:\/\//.test(c)) || null;
        const host = display ? domainOf(display.split(' ')[0]) : null;
        const title = $(h).text().replace(/\s+/g, ' ').trim();
        if (!title || organic.some((o) => o.title === title && o.domain === host)) return;
        // Forum and social results ("Reddit · r/CRM", "340+ comments") carry a site name instead of a URL.
        const site = host ? null : /\b(Reddit|Quora|YouTube|LinkedIn|Facebook|Medium|TikTok|Instagram|Stack Overflow)\b/.exec(a.text() + ' ' + block.text())?.[1];
        const fallback = site ? SITE_DOMAINS[site] : null;
        organic.push({ position: organic.length + 1, title, domain: host || fallback || null, displayUrl: display });
    });

    return { status, text, citations, linkedEntities, organic };
}

/** Count case-insensitive whole-word mentions and where each brand first appears. */
export function brandMentions(text, brands) {
    const out = [];
    const lower = text || '';
    for (const b of brands) {
        const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'giu');
        const hits = [...lower.matchAll(re)];
        out.push({ brand: b, mentioned: hits.length > 0, mentions: hits.length, firstIndex: hits.length ? hits[0].index : null });
    }
    const ranked = out.filter((x) => x.mentioned).sort((a, b) => a.firstIndex - b.firstIndex);
    ranked.forEach((x, i) => { x.rank = i + 1; });
    return out.map(({ firstIndex, ...x }) => ({ ...x, rank: x.rank ?? null }));
}
