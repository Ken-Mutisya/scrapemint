// Google Hotels Scraper: hotels and prices from Google Hotels for any city or
// hotel and any dates: nightly and total price with and without taxes, the
// "cheaper than usual" price insight, star class, rating and review
// breakdown, amenities, location, and optionally every booking site's price
// (Booking.com, Expedia, Agoda, the hotel's own site...) with links.
//
// Strategy
// --------
// google.com/travel/search?q=<query>&ts=<state> and
// google.com/travel/hotels/entity/<id>/prices?ts=<state> are server-rendered:
// the data sits in AF_initDataCallback blocks (ds:0 on search, ds:1 on a
// hotel page). <state> is a base64url protobuf that carries guests, dates,
// nights and currency:
//   1: 1
//   2: { 1: {1: 3} per adult, 2: 0 }
//   3: { 2: { 2: { 1: {1:y 2:m 3:d}, 2: {1:y 2:m 3:d}, 3: nights }, 6: {2: 0} } }
//   5: { 1: { 7: "USD" }, 3: "" }
// (decoded from a Google link and checked byte-for-byte; built here.)
//
// A search page returns about 20 organic hotels (entries keyed 397419284) and
// has no URL paging (more results load over an RPC). Wider coverage comes
// from query variants Google understands ("4 star hotels in X", "hostels in
// X", "hotels with pool in X"...), de-duplicated by hotel id. A hotel page
// lists 15-30 booking offers at [0][6][2][21], each with per-night and
// whole-stay prices before and after taxes and a click-out link whose target
// is the pcurl parameter.
//
// No key, no proxy: search and hotel pages answered Apify's IPs on every
// request in the 2026-10-09 probes.
//
// Pay per event
// -------------
//   hotel        ($0.002) one hotel for one set of dates, from search
//   hotel_offers ($0.004) the same with its hotel page read: every booking
//                         site's price and link, address, phone, website
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://www.google.com';

const VARIANTS = [
    'hotels in %', '4 star hotels in %', '3 star hotels in %', '5 star hotels in %', 'cheap hotels in %', 'luxury hotels in %',
    '2 star hotels in %', 'boutique hotels in %', 'hostels in %', 'hotels in % city center', 'family hotels in %', 'hotels with pool in %',
    'business hotels in %', 'apartment hotels in %', 'hotels near airport %', 'pet friendly hotels in %', 'hotels with free breakfast in %',
    'hotels with parking in %', 'romantic hotels in %', 'best hotels in %', 'resorts in %', 'motels in %', 'bed and breakfast in %',
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    locations = [],
    queries = [],
    hotels = [],
    checkIn = '',
    checkInDates = [],
    nights = 1,
    adults = 2,
    currency = 'USD',
    maxHotelsPerLocation = 50,
    includeBookingOffers = false,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cur = String(currency || 'USD').trim().toUpperCase().slice(0, 3);
const stay = Math.max(1, Math.min(30, Number(nights) || 1));
const guests = Math.max(1, Math.min(10, Number(adults) || 2));
const perLocation = Math.max(1, Number(maxHotelsPerLocation) || 50);

// ---------- ts state ----------

function varint(n) {
    const out = [];
    do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
    return out;
}
const fld = (f, w, v) => (w === 0 ? [...varint((f << 3) | 0), ...varint(v)] : [...varint((f << 3) | 2), ...varint(v.length), ...v]);
const date = ([y, m, d]) => [...fld(1, 0, y), ...fld(2, 0, m), ...fld(3, 0, d)];

function tsState(ci, co, nAdults, currencyCode) {
    const n = Math.round((Date.UTC(...co.map((x, i) => (i === 1 ? x - 1 : x))) - Date.UTC(...ci.map((x, i) => (i === 1 ? x - 1 : x)))) / 86400000);
    const people = [...Array.from({ length: nAdults }, () => fld(1, 2, fld(1, 0, 3))).flat(), ...fld(2, 0, 0)];
    const dates = fld(2, 2, [...fld(2, 2, [...fld(1, 2, date(ci)), ...fld(2, 2, date(co)), ...fld(3, 0, n)]), ...fld(6, 2, fld(2, 0, 0))]);
    const body = [...fld(1, 0, 1), ...fld(2, 2, people), ...fld(3, 2, dates), ...fld(5, 2, [...fld(1, 2, fld(7, 2, [...Buffer.from(currencyCode)])), ...fld(3, 2, [])])];
    return Buffer.from(body).toString('base64url');
}

// ---------- Dates ----------

const iso = (d) => d.toISOString().slice(0, 10);
const parts = (s) => s.split('-').map(Number);
function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); }

function stays() {
    const raw = [...list(checkInDates), ...(checkIn ? [checkIn] : [])].map((s) => s.slice(0, 10)).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    const today = iso(new Date());
    const out = [...new Set(raw)].filter((s) => s >= today);
    if (raw.length && !out.length) log.warning('All check-in dates are in the past; using 14 days from today.');
    if (!out.length) out.push(addDays(today, 14));
    return out.sort().map((ci) => ({ checkIn: ci, checkOut: addDays(ci, stay), ts: tsState(parts(ci), parts(addDays(ci, stay)), guests, cur) }));
}

// ---------- Fetch and parse ----------

async function get(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(45_000) });
            const t = await r.text();
            if (r.ok && t.includes('AF_initDataCallback')) return t;
            if (r.status === 404) return null;
            last = new Error(r.ok ? 'No data on the page (consent or captcha page)' : `HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(2000 * 2 ** attempt);
    }
    throw last;
}

function block(html, key) {
    const i = html.indexOf(`AF_initDataCallback({key: '${key}'`);
    if (i < 0) return null;
    const e = html.indexOf('</script>', i);
    const s = html.slice(i, e);
    const j = s.slice(s.indexOf('data:') + 5, s.lastIndexOf(', sideChannel'));
    try { return JSON.parse(j); } catch { return null; }
}

const round2 = (x) => Math.round(x * 100) / 100;
const at = (o, ...path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

// "Amenities for <name>[, a 4-star hotel.]: Breakfast ($), Free Wi-Fi, ..." spans on search cards.
function amenityMap(html) {
    const map = new Map();
    for (const m of html.matchAll(/>Amenities for ([^<]*?)<\/span>/g)) {
        const t = decode(m[1]);
        const k = t.lastIndexOf(': ');
        if (k < 0) continue;
        const name = t.slice(0, k).replace(/, an? [^,]*?\.$/, '').trim();
        map.set(name, t.slice(k + 2).split(',').map((x) => x.trim()).filter(Boolean));
    }
    return map;
}

function searchHotels(html) {
    const d = block(html, 'ds:0');
    const rows = at(d, 0, 0, 0, 1) || [];
    const amen = amenityMap(html);
    const out = [];
    for (const r of rows) {
        const h = Array.isArray(r) && r[1] && typeof r[1] === 'object' ? r[1]['397419284']?.[0] : null;
        if (h && h[1]) out.push(hotelFields(h, amen.get(h[1]) || null));
    }
    const count = rows.map((r) => (Array.isArray(r) && r[1] ? r[1]['416343588'] : null)).find(Boolean);
    // ds:0[1] echoes the query; when it names one hotel, [1][2][5] is that hotel's id.
    const matchedId = typeof at(d, 1, 2, 5) === 'string' ? at(d, 1, 2, 5) : null;
    return { hotels: out, totalResults: count?.[0] ?? null, place: count?.[2] ?? null, matchedId };
}

// Fields shared by search entries and the hotel page's own entry.
function hotelFields(h, amenities) {
    const p = at(h, 6, 2) || [];
    const loc = h[2] || [];
    const rating = at(h, 7, 0);
    const hist = at(h, 7, 1, 0) || [];
    const id = h[20] || null;
    const night = p[1] || [];
    const total = p[9] || [];
    const tax = p[44] || [];
    const nightsN = at(p, 8, 2) || null;
    const insight = at(p, 7, 3, 3, 0) || null;
    return {
        hotelId: id,
        name: h[1],
        url: id ? `${SITE}/travel/hotels/entity/${id}` : null,
        hotelClass: at(h, 3, 1) ?? null,
        hotelClassText: at(h, 3, 0) ?? null,
        propertyType: (at(loc, 31, 0, 0, 0) || '').replace(/^gcid:/, '').replace(/_/g, ' ') || null,
        rating: rating?.[0] ?? null,
        reviewCount: rating?.[1] ?? null,
        ratingBreakdown: hist.length ? Object.fromEntries(hist.map(([stars, , n]) => [`${stars}star`, n])) : null,
        reviewTopics: (at(h, 7, 9) || []).map((t) => ({ topic: t[6] || t[4], mentions: t[2] ?? null, positive: t[7] ?? null, negative: t[8] ?? null })).filter((t) => t.topic),
        // Google's displayed nightly price includes taxes in some markets and not
        // in others; the stay totals split them, so per-night comes from those.
        pricePerNight: tax[3] != null && nightsN ? Math.round(tax[3] / nightsN) : (night[4] ?? null),
        pricePerNightBeforeTaxes: tax[0] != null && nightsN ? Math.round(tax[0] / nightsN) : null,
        priceTotal: tax[3] != null ? round2(tax[3]) : null,
        priceTotalBeforeTaxes: tax[0] != null ? round2(tax[0]) : null,
        taxesTotal: tax[1] != null ? round2(tax[1]) : null,
        priceText: night[0] || null,
        priceTotalText: total[1] || total[0] || null,
        currency: p[15] || null,
        priceInsight: insight,
        nightsPriced: nightsN,
        latitude: at(loc, 0, 0) ?? null,
        longitude: at(loc, 0, 1) ?? null,
        countryCode: loc[36] || null,
        checkInTime: at(loc, 17, 0) || null,
        checkOutTime: at(loc, 17, 1) || null,
        website: at(loc, 29, 2) || null,
        nearby: (loc[19] || []).flatMap((x) => (at(x, 1, 2) || []).map((p2) => ({ place: p2[0], ...Object.fromEntries((p2[2] || []).map(([mode, t]) => [{ 0: 'drive', 2: 'walk', 3: 'transit' }[mode] || `mode${mode}`, t])) }))).filter((x) => typeof x.place === 'string'),
        amenities,
        description: at(h, 11, 0) || null,
        thumbnail: at(h, 12, 0) || null,
        googleMapsPlaceId: h[9] || null,
    };
}

function hotelPage(html) {
    const d = block(html, 'ds:1');
    const e = at(d, 0);
    if (!e || !e[1]) return null;
    const amen = amenityMap(html);
    const base = hotelFields(e, amen.get(e[1]) || null);
    const loc = e[2] || [];
    const p = at(e, 6, 2) || [];
    const offers = [];
    const seen = new Set();
    for (const o of [...(p[22] || []), ...(p[21] || [])]) {
        const head = o?.[0];
        const pr = o?.[12];
        if (!head || !pr) continue;
        const night = pr[4] || [];
        const tot = pr[5] || [];
        const key = `${head[0]}|${night[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let link = null;
        try { link = head[2] ? new URL(head[2], SITE).searchParams.get('pcurl') : null; } catch { link = null; }
        offers.push({
            site: head[0],
            isOfficialSite: head[5] === 1,
            // One value = the price as Google shows it for this market; two =
            // before and after taxes.
            pricePerNight: night[3] != null ? Math.round(night[3]) : night[2] != null ? Math.round(night[2]) : null,
            pricePerNightBeforeTaxes: night[3] != null && night[2] != null ? Math.round(night[2]) : null,
            priceTotal: tot[3] != null ? round2(tot[3]) : tot[2] != null ? round2(tot[2]) : null,
            priceTotalBeforeTaxes: tot[3] != null && tot[2] != null ? round2(tot[2]) : null,
            bookingUrl: link,
        });
    }
    offers.sort((a, b) => (a.priceTotal ?? 1e12) - (b.priceTotal ?? 1e12));
    const longDesc = at(e, 11, 1, 0);
    return {
        ...base,
        address: at(loc, 1, 0, 0, 0) || null,
        phone: at(loc, 2, 0) || null,
        area: (loc[21] || []).map((x) => x[1]).filter(Boolean),
        description: base.description,
        longDescription: typeof longDesc === 'string' ? longDesc : null,
        offerCount: offers.length,
        cheapestSite: offers[0]?.site || null,
        offers,
    };
}

// ---------- Run ----------

let charged = 0;
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

async function emit(row, withOffers) {
    await Actor.pushData(row);
    charged += 1;
    if (!(await charge(withOffers ? 'hotel_offers' : 'hotel'))) keepGoing = false;
}

async function pool(items, fn, width = 4) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

const dateList = stays();
const scrapedAt = new Date().toISOString();
const stayInfo = (s) => ({ checkIn: s.checkIn, checkOut: s.checkOut, nights: stay, adults: guests });

async function withOffers(rows, s) {
    if (!includeBookingOffers) return rows.map((r) => ({ row: r, offers: false }));
    return pool(rows, async (r) => {
        if (!r.hotelId) return { row: r, offers: false };
        try {
            const page = hotelPage(await get(`${SITE}/travel/hotels/entity/${r.hotelId}/prices?hl=en&ts=${s.ts}`) || '');
            if (!page) return { row: { ...r, offersError: 'Hotel page had no data' }, offers: false };
            return { row: { ...r, ...page, amenities: r.amenities || page.amenities }, offers: true };
        } catch (err) { return { row: { ...r, offersError: String(err?.message || err) }, offers: false }; }
    });
}

// 1) Cities and free-text searches.
const searchJobs = [
    ...list(locations).map((l) => ({ label: l, variants: VARIANTS.map((v) => v.replace('%', l)) })),
    ...list(queries).map((q) => ({ label: q, variants: [q] })),
];

for (const job of searchJobs) {
    if (!keepGoing) break;
    for (const s of dateList) {
        if (!keepGoing) break;
        const seen = new Set();
        let count = 0;
        let dry = 0;
        let total = null;
        for (const q of job.variants) {
            if (!keepGoing || count >= perLocation || dry >= 4) break;
            let found;
            try {
                found = searchHotels(await get(`${SITE}/travel/search?q=${encodeURIComponent(q)}&hl=en&ts=${s.ts}`) || '');
            } catch (err) {
                log.warning(`"${q}": ${err?.message}`);
                failures.push({ search: q, checkIn: s.checkIn, error: String(err?.message || err) });
                dry += 1;
                continue;
            }
            total = total ?? found.totalResults;
            const fresh = found.hotels.filter((h) => h.hotelId && !seen.has(h.hotelId)).slice(0, perLocation - count);
            fresh.forEach((h) => seen.add(h.hotelId));
            dry = fresh.length < 2 ? dry + 1 : 0;
            const rows = await withOffers(fresh.map((h) => ({ ...h, ...stayInfo(s), search: job.label, searchQuery: q, scrapedAt })), s);
            for (const { row, offers } of rows) {
                if (!keepGoing) break;
                await emit(row, offers);
                count += 1;
            }
            await sleep(500);
        }
        log.info(`${job.label} ${s.checkIn}: ${count} hotel(s)${total ? ` of about ${total.toLocaleString('en-US')} on Google` : ''}.`);
        perSearchCounts.push({ search: job.label, checkIn: s.checkIn, hotels: count, googleTotal: total });
    }
}

// 2) Specific hotels, by Google Hotels link or by name.
const hotelInputs = list(hotels);
const resolved = new Map();
for (const h of hotelInputs) {
    if (!keepGoing) break;
    let id = h.match(/\/entity\/([A-Za-z0-9_-]{10,})/)?.[1] || null;
    let name = id ? null : h;
    for (const s of dateList) {
        if (!keepGoing) break;
        try {
            if (!id) {
                const found = searchHotels(await get(`${SITE}/travel/search?q=${encodeURIComponent(name)}&hl=en&ts=${s.ts}`) || '');
                if (found.matchedId) { id = found.matchedId; resolved.set(h, id); }
            }
            if (!id) {
                const found = searchHotels(await get(`${SITE}/travel/search?q=${encodeURIComponent(name)}&hl=en&ts=${s.ts}`) || '');
                const words = name.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
                const best = found.hotels.map((x) => ({ x, score: words.filter((w) => x.name.toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score)[0];
                if (!best || !best.score) throw new Error(`No hotel matching "${name}" on Google Hotels`);
                id = best.x.hotelId;
                resolved.set(h, best.x.name);
            }
            const page = hotelPage(await get(`${SITE}/travel/hotels/entity/${id}/prices?hl=en&ts=${s.ts}`) || '');
            if (!page) throw new Error('Hotel page had no data');
            const row = { ...page, ...stayInfo(s), search: h, scrapedAt };
            if (!includeBookingOffers) { delete row.offers; delete row.offerCount; delete row.cheapestSite; }
            await emit(row, includeBookingOffers);
            perSearchCounts.push({ search: h, checkIn: s.checkIn, hotels: 1, matched: page.name });
        } catch (err) {
            log.warning(`${h} ${s.checkIn}: ${err?.message}`);
            failures.push({ hotel: h, checkIn: s.checkIn, error: String(err?.message || err) });
            await Actor.pushData({ rowType: 'error', search: h, checkIn: s.checkIn, error: `${String(err?.message || err)}. Not charged.` });
            if (!id) break;
        }
        await sleep(400);
    }
}

if (!searchJobs.length && !hotelInputs.length) {
    await Actor.pushData({ rowType: 'error', error: 'Add a city in Locations, a search in Queries, or a hotel link or name in Hotels. Not charged.' });
}
if (!charged) await Actor.pushData({ rowType: 'note', note: 'No hotels returned. Not charged.' });
await Actor.setValue('SUMMARY', { rows: charged, dates: dateList.map((s) => s.checkIn), currency: cur, searches: perSearchCounts, failures });
log.info(`Done. ${charged} row(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
