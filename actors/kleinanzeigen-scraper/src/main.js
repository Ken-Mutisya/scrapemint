// Kleinanzeigen Scraper: ads from any kleinanzeigen.de search, past the
// 1,250-per-search cap, with optional full description and seller profile.
//
// Strategy
// --------
// Search pages are server-rendered HTML. Each ad is an
// <article data-adid data-href> card holding a schema.org ImageObject
// (title, description preview, image) and visible text: photo count,
// "<postcode> <city>", the date ("Heute, 12:34", "Gestern, 08:10" or
// "dd.mm.yyyy"; missing on promoted ads), price ("75 € VB", "Zu verschenken"),
// a struck-through original price, and tags ("Versand möglich",
// "Direkt kaufen", "PRO" + shop name).
//
// URLs are /s-<segments>/<location>/<query>/k0c<category>l<location>r<radius>,
// where segments are filters such as preis:100:500, anbieter:privat,
// anzeige:angebote and seite:N. Pages stop at 50 (25 ads each, 1,250 per
// search), so larger searches are split into preis:<from>:<to> windows
// (halved until each holds 1,250 or fewer). Locations resolve through
// /s-ort-empfehlungen.json.
//
// Ad pages (/s-anzeige/...) add the full description, the attribute list,
// all photos, shipping, state and the seller box (name, private/commercial,
// active since, ads online, badges).
//
// No key, no proxy: search and ad pages answered Apify's IPs 5/5 in the
// 2026-10-09 probe.
//
// Pay per event
// -------------
//   listing        ($0.001)  one ad from search pages
//   listing_detail ($0.0025) one ad with its ad page read
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://www.kleinanzeigen.de';
const PER_PAGE = 25;
const MAX_PAGES = 50;
const CAP = PER_PAGE * MAX_PAGES;
const RADII = [5, 10, 20, 30, 50, 100, 150, 200];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    location = '',
    radiusKm = 20,
    minPrice = null,
    maxPrice = null,
    sellerType = '',
    adType = '',
    includeDetails = false,
    maxItemsPerSearch = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 500);

async function get(url, as = 'text') {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html', 'Accept-Language': 'de-DE,de;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(45_000) });
            // Past the last page the site redirects; treat as end of results.
            if (r.status >= 300 && r.status < 400) return null;
            if (r.status === 404 || r.status === 410) return null;
            if (r.ok) return as === 'json' ? await r.json() : await r.text();
            last = new Error(`HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

const decode = (s) => String(s || '').replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = (h) => decode(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const slug = (s) => String(s).trim().toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

// ---------- Searches ----------

// A search is { segs: [...filter segments], tail: 'berlin/fahrrad/k0l3331r10' }.
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/(^|\.)kleinanzeigen\.de$/.test(url.hostname) || !url.pathname.startsWith('/s-')) return null;
    const parts = url.pathname.slice(3).split('/').filter(Boolean);
    const segs = [];
    const rest = [];
    for (const p of parts) {
        if (/^seite:\d+$/.test(p)) continue;
        if (/^[a-z_]+:[^/]*$/.test(p) && !rest.length) segs.push(p); else rest.push(p);
    }
    if (!rest.length || !/^k0/.test(rest[rest.length - 1])) return null;
    return { segs, tail: rest.join('/'), label: u };
}

async function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) out.push(parseSearchUrl(u) || { error: `Not a Kleinanzeigen search URL (…/s-…/k0…): ${u}` });
    const qs = list(queries);
    if (!qs.length) return out;
    const segs = [];
    if (adType) segs.push(`anzeige:${adType}`);
    if (sellerType) segs.push(`anbieter:${sellerType}`);
    if ((minPrice != null && minPrice !== '') || (maxPrice != null && maxPrice !== '')) segs.push(`preis:${minPrice ?? ''}:${maxPrice ?? ''}`);
    let loc = null;
    if (location) {
        const sugg = await get(`${SITE}/s-ort-empfehlungen.json?query=${encodeURIComponent(location)}`, 'json').catch(() => null);
        const hit = Object.entries(sugg || {}).find(([k]) => k !== '_0');
        if (hit) {
            const radius = RADII.find((r) => r >= Number(radiusKm || 20)) || 200;
            loc = { id: hit[0].slice(1), name: hit[1], radius };
        } else out.push({ error: `Unknown location on Kleinanzeigen: ${location}` });
    }
    if (location && !loc) return out;
    for (const q of qs) {
        const tail = loc ? `${slug(loc.name.split(' - ')[0])}/${slug(q)}/k0l${loc.id}r${loc.radius}` : `${slug(q)}/k0`;
        out.push({ segs, tail, label: `"${q}"${loc ? ` in ${loc.name} +${loc.radius} km` : ''}` });
    }
    return out;
}

function pageUrl(s, page = 1, price = null) {
    const segs = s.segs.filter((x) => !(price && x.startsWith('preis:')));
    if (price) segs.push(`preis:${price[0]}:${price[1]}`);
    if (page > 1) segs.push(`seite:${page}`);
    return `${SITE}/s-${[...segs, s.tail].join('/')}`;
}

const resultCount = (html) => {
    const m = text(html).match(/von ([\d.]+) Ergebniss?e?n?/);
    return m ? Number(m[1].replace(/\./g, '')) : (/data-adid="/.test(html) ? null : 0);
};

// Price windows of 1,250 or fewer.
async function priceWindows(s) {
    const own = s.segs.find((x) => x.startsWith('preis:'))?.split(':') || [];
    const lo0 = own[1] ? Number(own[1]) : 0;
    const hi0 = own[2] ? Number(own[2]) : 10_000_000;
    const count = async (a, b) => resultCount((await get(pageUrl(s, 1, [a, b]))) || '') ?? CAP;
    const out = [];
    const stack = [[lo0, hi0, await count(lo0, hi0)]];
    while (stack.length) {
        const [a, b, n] = stack.pop();
        if (!n) continue;
        if (n <= CAP || b <= a) { out.push([a, b, n]); continue; }
        const mid = Math.floor((a + b) / 2);
        const [nLo, nHi] = await Promise.all([count(a, mid), count(mid + 1, b)]);
        stack.push([mid + 1, b, nHi], [a, mid, nLo]);
    }
    return out;
}

async function* searchAds(s) {
    const firstHtml = await get(pageUrl(s));
    if (firstHtml == null) throw new Error('Search page not found');
    const total = resultCount(firstHtml) ?? 0;
    log.info(`${s.label}: ${total} ad(s).`);
    if (!total) return;
    const windows = total > CAP && perSearch > CAP ? await priceWindows(s) : [null];
    if (windows.length > 1) log.info(`${s.label}: split into ${windows.length} price windows.`);
    // Windows are read round-robin (page 1 of each, then page 2...), so a
    // capped run gets the newest ads across all prices, not just the cheapest.
    // The consumer stops pulling once it has enough (after de-duplication).
    let active = windows.map((w) => ({ price: w ? [w[0], w[1]] : null, done: false }));
    for (let page = 1; page <= MAX_PAGES && active.length; page++) {
        for (const w of active) {
            const html = !w.price && page === 1 ? firstHtml : await get(pageUrl(s, page, w.price));
            if (!html) { w.done = true; continue; }
            const cards = parseCards(html);
            for (const c of cards) yield c;
            if (cards.length < PER_PAGE - 2 || !html.includes(`seite:${page + 1}`)) w.done = true;
            await sleep(300);
        }
        active = active.filter((w) => !w.done);
    }
}

// ---------- Cards ----------

function berlinDate(offsetDays = 0) {
    const d = new Date(Date.now() - offsetDays * 86400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function parseDate(s) {
    let m = s.match(/^(Heute|Gestern), (\d{2}):(\d{2})$/);
    if (m) return `${berlinDate(m[1] === 'Gestern' ? 1 : 0)}T${m[2]}:${m[3]}`;
    m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parsePrice(s) {
    if (!s) return { price: null, priceType: null };
    if (/verschenken/i.test(s)) return { price: 0, priceType: 'free' };
    const n = s.match(/([\d.]+(?:,\d+)?)\s*€/);
    const price = n ? Number(n[1].replace(/\./g, '').replace(',', '.')) : null;
    return { price, priceType: /VB/.test(s) ? (price == null ? 'negotiable (no price)' : 'negotiable') : price != null ? 'fixed' : null };
}

function parseCards(html) {
    const out = [];
    const re = /<article[^>]*data-adid="(\d+)"[^>]*data-href="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
    let m;
    while ((m = re.exec(html))) {
        const [, adId, href, body] = m;
        let ld = {};
        const j = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (j) { try { ld = JSON.parse(j[1]); } catch { ld = {}; } }
        const clean = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
        const bits = clean.split(/<[^>]+>/).map((x) => decode(x).trim()).filter(Boolean);
        const title = (ld.title || '').trim();
        let imageCount = null; let zip = null; let city = null; let dateText = null;
        const prices = []; let shipping = false; let buyNow = false; let pro = false; let shop = null;
        for (let i = 0; i < bits.length; i++) {
            const b = bits[i];
            if (imageCount == null && i === 0 && /^\d+$/.test(b)) imageCount = Number(b);
            else if (!zip && /^\d{5} /.test(b)) { zip = b.slice(0, 5); city = b.slice(6).trim(); }
            else if (!dateText && /^(Heute|Gestern), \d{2}:\d{2}$|^\d{2}\.\d{2}\.\d{4}$/.test(b)) dateText = b;
            else if (/€|verschenken|^VB$/i.test(b) && b.length < 40) prices.push(b);
            else if (/^Versand möglich$/i.test(b)) shipping = true;
            else if (/^Direkt kaufen$/i.test(b)) buyNow = true;
            else if (b === 'PRO') { pro = true; shop = bits[i + 1] && !/€/.test(bits[i + 1]) ? bits[i + 1] : null; }
        }
        const p = parsePrice(prices[0]);
        const orig = prices[1] ? parsePrice(prices[1]).price : null;
        out.push({
            adId,
            url: new URL(href, SITE).href,
            title: title || null,
            price: p.price,
            priceText: prices[0] || null,
            priceType: p.priceType,
            originalPrice: orig,
            zip,
            city,
            postedAt: dateText ? parseDate(dateText) : null,
            postedAtText: dateText,
            descriptionPreview: (ld.description || '').trim() || null,
            imageUrl: ld.contentUrl ? ld.contentUrl.replace(/rule=\$_\d+\.(AUTO|JPG)/, 'rule=$_59.AUTO') : null,
            imageCount,
            shippingAvailable: shipping,
            directBuy: buyNow,
            isProSeller: pro,
            proShopName: shop,
            categoryId: href.match(/\/\d+-(\d+)-\d+$/)?.[1] || null,
        });
    }
    return out;
}

// ---------- Ad page ----------

async function details(url) {
    const t = await get(url);
    if (!t) return { detailError: 'Ad no longer available' };
    const attributes = {};
    for (const m of t.matchAll(/<li class="addetailslist--detail">\s*([^<]+?)\s*<span class="addetailslist--detail--value"\s*>([\s\S]*?)<\/span>/g)) attributes[text(m[1])] = text(m[2]);
    const features = [...t.matchAll(/<li class="checktag">([\s\S]*?)<\/li>/g)].map((m) => text(m[1])).filter(Boolean);
    const desc = t.match(/<p id="viewad-description-text"[^>]*>([\s\S]*?)<\/p>/)?.[1];
    const locality = text(t.match(/id="viewad-locality"[^>]*>([\s\S]*?)<\/span>/)?.[1]);
    const seller = t.match(/id="viewad-contact"[\s\S]*?id="viewad-ad-id-box"/)?.[0] || '';
    const details = [...seller.matchAll(/class="userprofile-vip-details-text">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]));
    const conf = (k) => t.match(new RegExp(`${k}:\\s*'?([^',\\n]*)'?,`))?.[1]?.trim() || null;
    const images = [...new Set([...t.matchAll(/data-imgsrc="([^"]+)"/g)].map((m) => m[1].replace(/rule=\$_\d+\.(AUTO|JPG)/, 'rule=$_59.AUTO')))];
    const shippingText = text(t.match(/<span class="boxedarticle--details--shipping">([\s\S]*?)<\/span>/)?.[1]) || (/Nur Abholung/.test(t) ? 'Nur Abholung' : null);
    return {
        description: desc ? text(desc) : null,
        attributes,
        features,
        images,
        shipping: shippingText,
        state: locality.match(/^\d{5} ([^-]+?) - /)?.[1]?.trim() || null,
        priceTypeCode: conf('adPriceType'),
        isCommercialSeller: conf('isCommercialUser') === 'true',
        sellerName: text(seller.match(/class="[^"]*userprofile-vip"[^>]*>([\s\S]*?)<\/span>\s*<\/span>|class="[^"]*userprofile-vip"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.slice(1).find(Boolean)) || null,
        sellerId: seller.match(/s-bestandsliste\.html\?userId=(\d+)/)?.[1] || null,
        sellerType: details.find((d) => /Nutzer|Anbieter|Händler/i.test(d)) || null,
        sellerActiveSince: details.find((d) => /^Aktiv seit/.test(d))?.replace(/^Aktiv seit\s*/, '') || null,
        sellerAdsOnline: Number(text(seller).match(/(\d+) Anzeigen online/)?.[1]) || null,
        sellerBadges: [...seller.matchAll(/class="userbadge-tag"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1])).filter(Boolean),
        categoryName: conf('category'),
    };
}

// ---------- Run ----------

let ads = 0;
let detailed = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function pool(rows, fn, width = 4) {
    const out = new Array(rows.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, rows.length) }, async () => {
        while (i < rows.length) { const k = i++; out[k] = await fn(rows[k]); }
    }));
    return out;
}

const searches = await buildSearches();
if (!searches.length) searches.push({ segs: [], tail: 'fahrrad/k0', label: '"fahrrad"' });
const seen = new Set();

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let batch = [];
    const flush = async () => {
        const extras = includeDetails ? await pool(batch, async (row) => {
            try { return await details(row.url); } catch (err) { return { detailError: String(err?.message || err) }; }
        }) : batch.map(() => ({}));
        for (let k = 0; k < batch.length && keepGoing; k++) {
            const extra = extras[k];
            const withDetail = includeDetails && !extra.detailError;
            await Actor.pushData({ ...batch[k], ...extra, search: s.label, scrapedAt: new Date().toISOString() });
            ads += 1;
            count += 1;
            if (withDetail) detailed += 1;
            if (!(await charge(withDetail ? 'listing_detail' : 'listing'))) keepGoing = false;
        }
        batch = [];
    };
    try {
        for await (const row of searchAds(s)) {
            if (!keepGoing) break;
            if (seen.has(row.adId)) continue;
            seen.add(row.adId);
            batch.push(row);
            if (count + batch.length >= perSearch) break;
            if (batch.length >= (includeDetails ? 20 : 100)) await flush();
        }
        if (keepGoing && batch.length) await flush();
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    perSearchCounts.push({ search: s.label, ads: count });
}

if (!ads) await Actor.pushData({ rowType: 'note', note: 'No ads matched. Not charged.' });
await Actor.setValue('SUMMARY', { ads, withDetails: detailed, searches: perSearchCounts, failures });
log.info(`Done. ${ads} ad(s)${includeDetails ? `, ${detailed} with details` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
