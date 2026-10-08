// Eventbrite Events Scraper: events by city, keyword, date, category and
// price, with the organizer's website and social links for lead lists.
//
// Strategy
// --------
// Eventbrite's own search page posts to /api/v3/destination/search/ with a
// CSRF token from the csrftoken cookie, which any page visit sets. No key, no
// login, no proxy (answered Apify's IPs in the 2026-10-08 probe).
//
// Locations are Eventbrite place ids. Free text is turned into the site's
// /d/<slug>/events/ URL; Eventbrite resolves "london" or "tx--austin" itself and
// the page carries "placeId". "online" searches online events.
//
// One search returns at most ~1,000 events (20 pages of 50). Larger result
// sets are split by date range, halving until each part fits, so a whole city
// can be pulled; a single day that is still too big is split by category.
// Rows are deduplicated by event id.
//
// Pay per event
// -------------
//   event_row             ($0.003) one event with venue, price, organizer
//   event_row_description ($0.004) the same with the full description, read
//                                  from the event page
// No start fee. A run with no events is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EB = 'https://www.eventbrite.com';
const CATEGORIES = {
    business: 101, technology: 102, music: 103, film: 104, arts: 105, fashion: 106, health: 107, sports: 108,
    travel: 109, food: 110, charity: 111, government: 112, community: 113, spirituality: 114, family: 115,
    holiday: 116, home: 117, auto: 118, hobbies: 119, school: 120, other: 199,
};
const PAGE_CAP = 950;
const DAY = 86_400_000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    locations = ['New York'],
    keywords = [],
    dateRange = 'future',
    startDate = '',
    endDate = '',
    categories = [],
    price = 'any',
    includeDescription = false,
    maxEvents = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n;]/)).map((s) => String(s).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limit = Math.max(1, Number(maxEvents) || 500);
const locs = list(locations);
const terms = list(keywords);
const cats = list(categories).map((c) => CATEGORIES[c.toLowerCase()] || (/^\d+$/.test(c) ? Number(c) : null)).filter(Boolean);

// ---------- Session ----------

let cookie = '';
let csrf = '';

async function page(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const set = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
    if (set.length) {
        const jar = new Map(cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
        for (const c of set) jar.set(c.split('=')[0], c);
        cookie = [...jar.values()].join('; ');
        csrf = cookie.match(/csrftoken=([^;]+)/)?.[1] || csrf;
    }
    return { status: r.status, url: r.url, text: await r.text() };
}

async function search(body, referer) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            if (!csrf) await page(`${EB}/d/online/events/`);
            const r = await fetch(`${EB}/api/v3/destination/search/`, {
                method: 'POST',
                headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'X-CSRFToken': csrf, Cookie: cookie, Referer: referer || `${EB}/`, Origin: EB },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            if (r.ok) return (await r.json()).events;
            last = new Error(`search HTTP ${r.status}`);
            if (r.status === 403 || r.status === 401) { csrf = ''; cookie = ''; }
        } catch (err) { last = err; }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// "New York, NY" -> ny--new-york; "London, United Kingdom" -> united-kingdom--london; "berlin" -> berlin
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function resolvePlace(text) {
    if (/^online$/i.test(text)) return { online: true, name: 'Online', slug: 'online' };
    if (/^\d+$/.test(text)) return { placeId: text, name: text, slug: null };
    const fromUrl = text.match(/eventbrite\.[a-z.]+\/d\/([^/?#]+)/i)?.[1];
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    const tries = fromUrl ? [fromUrl] : [];
    if (!fromUrl) {
        if (parts.length >= 2) tries.push(`${slug(parts[parts.length - 1])}--${slug(parts[0])}`);
        tries.push(slug(parts[0] || text));
    }
    for (const s of tries) {
        try {
            const p = await page(`${EB}/d/${s}/events/`);
            const placeId = p.text.match(/"placeId":"(\d+)"/)?.[1];
            if (placeId) return { placeId, name: text, slug: p.url.match(/\/d\/([^/]+)/)?.[1] || s };
        } catch (err) { log.debug(`place ${s}: ${err?.message}`); }
    }
    return null;
}

// ---------- Dates ----------

const isoDay = (d) => d.toISOString().slice(0, 10);
const today = new Date(isoDay(new Date()) + 'T00:00:00Z');
const RANGE_KEYWORDS = { today: 'today', tomorrow: 'tomorrow', weekend: 'this_weekend', week: 'this_week', 'next-week': 'next_week', month: 'this_month' };

function baseRange() {
    if (startDate || endDate) {
        const from = new Date((startDate || isoDay(today)).slice(0, 10) + 'T00:00:00Z');
        const to = new Date((endDate || startDate || isoDay(new Date(today.getTime() + 365 * DAY))).slice(0, 10) + 'T00:00:00Z');
        return { from, to };
    }
    return null;
}

function searchBody(placeOrOnline, q, range, pageNo) {
    const ev = { dates: 'current_future', page: pageNo, page_size: 50 };
    if (range?.keyword) ev.dates = range.keyword;
    if (range?.from) ev.date_range = { from: isoDay(range.from), to: isoDay(range.to) };
    if (placeOrOnline.online) ev.online_events_only = true;
    else ev.places = [placeOrOnline.placeId];
    if (q) ev.q = q;
    if (range?.cat) ev.tags = [`EventbriteCategory/${range.cat}`];
    else if (cats.length) ev.tags = cats.map((c) => `EventbriteCategory/${c}`);
    if (price === 'free' || price === 'paid') ev.price = price;
    return {
        event_search: ev,
        'expand.destination_event': ['primary_venue', 'image', 'ticket_availability', 'saves', 'event_sales_status', 'primary_organizer', 'public_collections'],
        browse_surface: 'search',
    };
}

// ---------- Rows ----------

const money = (m) => (m ? { value: m.major_value != null ? Number(m.major_value) : null, currency: m.currency || null, display: m.display || null } : null);

function toRow(e, loc, q) {
    const v = e.primary_venue || null;
    const a = v?.address || {};
    const o = e.primary_organizer || null;
    const t = e.ticket_availability || {};
    const tag = (prefix) => (e.tags || []).filter((x) => x.prefix === prefix).map((x) => x.display_name);
    const start = e.start_date ? `${e.start_date}T${e.start_time || '00:00'}` : null;
    const end = e.end_date ? `${e.end_date}T${e.end_time || '00:00'}` : null;
    return {
        eventId: e.id,
        name: e.name,
        url: e.url,
        summary: e.summary || null,
        start,
        end,
        timezone: e.timezone || null,
        isOnline: !!e.is_online_event,
        isCancelled: !!e.is_cancelled,
        isFree: t.is_free ?? null,
        minPrice: money(t.minimum_ticket_price),
        maxPrice: money(t.maximum_ticket_price),
        soldOut: t.is_sold_out ?? null,
        salesStatus: e.event_sales_status?.sales_status || null,
        urgency: e.urgency_signals?.messages?.length ? e.urgency_signals.messages : [],
        category: tag('EventbriteCategory')[0] || null,
        subcategory: tag('EventbriteSubCategory')[0] || null,
        format: tag('EventbriteFormat')[0] || null,
        tags: (e.tags || []).filter((x) => x.prefix === 'OrganizerTag' || !x.prefix).map((x) => x.display_name),
        venue: v ? {
            name: v.name || null,
            address: a.localized_address_display || null,
            street: a.address_1 || null,
            city: a.city || null,
            region: a.region || null,
            postalCode: a.postal_code || null,
            country: a.country || null,
            latitude: a.latitude != null ? Number(a.latitude) : null,
            longitude: a.longitude != null ? Number(a.longitude) : null,
        } : null,
        organizer: o ? {
            id: o.id,
            name: o.name || null,
            url: o.url || null,
            website: o.website_url || null,
            twitter: o.twitter ? `https://twitter.com/${String(o.twitter).replace(/^@/, '')}` : null,
            facebook: o.facebook ? `https://www.facebook.com/${o.facebook}` : null,
            followers: o.num_followers ?? null,
            summary: o.summary || null,
        } : null,
        imageUrl: e.image?.original?.url || e.image?.url || null,
        isSeries: !!e.series_id,
        publishedAt: e.published || null,
        searchLocation: loc.name,
        searchKeyword: q || null,
    };
}

// The JSON object that starts at text[i], found by matching braces outside strings.
function jsonAt(text, i) {
    if (i < 20 || text[i] !== '{') return null;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
    }
    return null;
}

async function description(url) {
    try {
        const p = await page(url);
        let html = '';
        const obj = jsonAt(p.text, p.text.indexOf('"structuredContent":') + '"structuredContent":'.length);
        if (obj?.modules) html = obj.modules.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        if (!html) {
            const ld = [...p.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
                .map((x) => { try { return JSON.parse(x[1]); } catch { return null; } })
                .find((x) => x && /Event/.test(String(x['@type'])));
            html = ld?.description || '';
        }
        const text = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\n{3,}/g, '\n\n').trim();
        return text || null;
    } catch (err) {
        log.debug(`description ${url}: ${err?.message}`);
        return null;
    }
}

// ---------- Run ----------

let rows = 0;
let described = 0;
let keepGoing = true;
const seen = new Set();
const failures = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function emit(e, loc, q) {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (rows >= limit) { keepGoing = false; return; }
    const row = toRow(e, loc, q);
    if (includeDescription) {
        row.description = await description(row.url);
        if (row.description) described += 1;
    }
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    rows += 1;
    if (!(await charge(row.description ? 'event_row_description' : 'event_row'))) keepGoing = false;
}

// Pages through one search; splits the date range when the search holds more
// than one search can return.
async function crawl(loc, q, range, referer) {
    const first = await search(searchBody(loc, q, range, 1), referer);
    const total = first?.pagination?.object_count ?? 0;
    const canSplit = range?.from && range.to - range.from >= DAY;
    if (total > PAGE_CAP && canSplit && rows + PAGE_CAP < limit) {
        const mid = new Date(range.from.getTime() + Math.floor((range.to - range.from) / DAY / 2) * DAY);
        log.info(`${loc.name}${q ? ` "${q}"` : ''} ${isoDay(range.from)}..${isoDay(range.to)}: ${total >= 10000 ? '10,000+' : total} events, splitting the dates.`);
        await crawl(loc, q, { from: range.from, to: mid }, referer);
        if (keepGoing) await crawl(loc, q, { from: new Date(mid.getTime() + DAY), to: range.to }, referer);
        return;
    }
    // One day can still hold more than a search returns (Manhattan on a
    // Saturday): split that day by category instead.
    if (total > PAGE_CAP && !canSplit && !range?.cat && !cats.length && rows + PAGE_CAP < limit) {
        log.info(`${loc.name}${q ? ` "${q}"` : ''} ${range?.from ? isoDay(range.from) : range?.keyword}: ${total} events, splitting by category.`);
        for (const cat of Object.values(CATEGORIES)) {
            if (!keepGoing) break;
            await crawl(loc, q, { ...range, cat }, referer);
        }
        return;
    }
    let res = first;
    for (let p = 1; keepGoing; p++) {
        if (p > 1) res = await search(searchBody(loc, q, range, p), referer);
        const items = res?.results || [];
        for (const e of items) { if (!keepGoing) break; await emit(e, loc, q); }
        if (!items.length || p >= (res?.pagination?.page_count || 1) || p >= 20) break;
        await sleep(300);
    }
}

if (!locs.length) locs.push('online');
log.info(`Searching ${locs.length} location(s)${terms.length ? ` for ${terms.length} keyword(s)` : ''}.`);

for (const text of locs) {
    if (!keepGoing) break;
    const loc = await resolvePlace(text);
    if (!loc) {
        log.warning(`Location not found on Eventbrite: ${text}`);
        failures.push({ location: text, error: 'Location not found on Eventbrite. Try "City, Country" or an Eventbrite /d/... URL.' });
        continue;
    }
    const referer = `${EB}/d/${loc.slug || 'online'}/events/`;
    let range = baseRange();
    // A whole-future search is split by dates only when it is too big; give it
    // an explicit one-year range so the split has something to halve.
    if (!range && (dateRange === 'future' || !RANGE_KEYWORDS[dateRange])) range = { from: today, to: new Date(today.getTime() + 365 * DAY) };
    if (!range) range = { keyword: RANGE_KEYWORDS[dateRange] };
    for (const q of terms.length ? terms : ['']) {
        if (!keepGoing) break;
        try {
            const before = rows;
            await crawl(loc, q, range, referer);
            log.info(`${loc.name}${q ? ` "${q}"` : ''}: ${rows - before} event(s).`);
        } catch (err) {
            log.warning(`${loc.name} ${q}: ${err?.message}`);
            failures.push({ location: text, keyword: q || null, error: String(err?.message || err) });
        }
    }
}

if (!rows) await Actor.pushData({ rowType: 'note', note: 'No events matched. Not charged.' });
await Actor.setValue('SUMMARY', { events: rows, withDescription: described, failures });
log.info(`Done. ${rows} event(s)${includeDescription ? `, ${described} with description` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
