// Luma & Meetup Events Scraper: upcoming events from lu.ma (Luma) and
// meetup.com for any city and keyword, or from Luma calendars and city
// pages and Meetup groups, in one row format: date and time, venue
// and coordinates, online or in person, price, attendee count, organiser,
// hosts with social handles, and the description.
//
// Strategy
// --------
// Luma: the public API at api.lu.ma answers without a key.
//   /url?url={slug}                       resolves a lu.ma slug to a
//                                         discover-place, calendar, category
//                                         or event
//   /discover/get-paginated-events        ?latitude&longitude, or
//                                         ?discover_place_api_id
// category_api_id is accepted but ignored (tested 2026-10-11: cat-ai
// returned the same city feed), so category slugs are refused with a hint.
//   /calendar/get-items?calendar_api_id&period=future
//   /event/get?event_api_id               full description (ProseMirror doc)
// All lists page with pagination_cursor / next_cursor. Luma's keyword search
// needs sign-in, so keywords filter Luma events by title and description.
//
// Meetup: the website's GraphQL endpoint (POST https://www.meetup.com/gql2)
//   eventSearch(filter: {query, lat, lon}, sort, first, after)
//   groupByUrlname(urlname) { events(first, after) }
//   event(id)
// Meetup's search is semantic: "python" also returns Django and data events.
// strictKeywordMatch keeps only events that contain the keyword.
//
// City names become coordinates through Open-Meteo's free geocoding API
// (population-ranked; "Manchester, GB" or "Portland, US" picks a country).
//
// No key, no proxy.
//
// Pay per event
// -------------
//   event ($0.002) one event with every field above
// No start fee. A search with no events is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LUMA = 'https://api.lu.ma';
const MEETUP = 'https://www.meetup.com/gql2';
const MEETUP_EVENT = `id title dateTime endTime description eventType eventUrl status maxTickets howToFindUs
 rsvps { totalCount } feeSettings { amount currency }
 venue { name address city state country lat lon postalCode }
 group { id name urlname city country timezone link stats { memberCounts { all } } }
 featuredEventPhoto { highResUrl }`;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    platforms = ['luma', 'meetup'],
    locations = [],
    keywords = [],
    strictKeywordMatch = false,
    lumaUrls = [],
    meetupGroups = [],
    eventType = 'any',
    daysAhead = null,
    includeDescription = true,
    maxItemsPerSearch = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 100);
const useLuma = list(platforms).map((p) => p.toLowerCase()).includes('luma');
const useMeetup = list(platforms).map((p) => p.toLowerCase()).includes('meetup');
const until = Number(daysAhead) > 0 ? Date.now() + Number(daysAhead) * 86_400_000 : null;

async function getJson(url, opts = {}) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(45_000) });
            const d = await r.json().catch(() => null);
            if (r.ok && d) return d;
            if (r.status === 404) return null;
            last = new Error(`HTTP ${r.status}${d?.message ? `: ${d.message}` : ''}`);
            if (r.status >= 400 && r.status < 429) throw Object.assign(last, { fatal: true });
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

async function meetupGql(query, variables = {}) {
    const d = await getJson(MEETUP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://www.meetup.com', Referer: 'https://www.meetup.com/find/' },
        body: JSON.stringify({ query, variables }),
    });
    if (d?.errors?.length) throw new Error(d.errors[0].message);
    return d?.data || {};
}

// "Manchester", "Manchester, GB", "Portland, US"
const geoCache = new Map();
async function geocode(text) {
    if (geoCache.has(text)) return geoCache.get(text);
    const [name, cc] = text.split(',').map((s) => s.trim());
    const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
    const res = (d?.results || []).filter((r) => !cc || [r.country_code, r.country, r.admin1].some((x) => x && x.toLowerCase() === cc.toLowerCase()));
    const hit = res[0] || null;
    const out = hit ? { lat: hit.latitude, lon: hit.longitude, label: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ') } : null;
    geoCache.set(text, out);
    return out;
}

// ---------- Rows ----------

function proseText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    const inner = (node.content || []).map(proseText).join(node.type === 'doc' || node.type === 'bullet_list' || node.type === 'ordered_list' ? '\n' : '');
    if (node.type === 'paragraph' || /^heading/.test(node.type)) return `${inner}\n`;
    if (node.type === 'list_item') return `- ${inner.trim()}\n`;
    if (node.type === 'hard_break') return '\n';
    return inner;
}
const tidy = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || null;
const lumaType = { offline: 'in person', online: 'online', zoom: 'online', hybrid: 'hybrid' };
const meetupType = { PHYSICAL: 'in person', ONLINE: 'online', HYBRID: 'hybrid' };
const handle = (h, base) => (h ? (h.startsWith('http') ? h : `${base}${h.replace(/^\//, '')}`) : null);

function lumaRow(e, search, detail) {
    const ev = e.event || {};
    const g = ev.geo_address_info || {};
    const t = e.ticket_info || {};
    const cents = t.price?.cents ?? (typeof t.price === 'number' ? t.price : null);
    const maxCents = t.max_price?.cents ?? (typeof t.max_price === 'number' ? t.max_price : null);
    const cal = e.calendar || {};
    return {
        platform: 'luma',
        eventId: ev.api_id,
        url: ev.url ? `https://lu.ma/${ev.url}` : null,
        title: ev.name || null,
        description: detail ? tidy(proseText(detail.description_mirror)) : null,
        startAt: ev.start_at || e.start_at || null,
        endAt: ev.end_at || null,
        timezone: ev.timezone || null,
        eventType: lumaType[ev.location_type] || ev.location_type || null,
        venueName: g.address || null,
        address: g.full_address || g.short_address || null,
        city: g.city || null,
        region: g.region || null,
        country: g.country || null,
        countryCode: g.country_code || null,
        latitude: ev.coordinate?.latitude ?? g.place_coordinate?.latitude ?? null,
        longitude: ev.coordinate?.longitude ?? g.place_coordinate?.longitude ?? null,
        addressHidden: g.mode === 'obfuscated' ? true : g.mode ? false : null,
        isFree: t.is_free ?? null,
        price: cents !== null && cents !== undefined ? cents / 100 : null,
        maxPrice: maxCents !== null && maxCents !== undefined ? maxCents / 100 : null,
        currency: (t.price?.currency || t.currency || '').toUpperCase() || null,
        attendeeCount: e.guest_count ?? null,
        spotsRemaining: t.spots_remaining ?? null,
        isSoldOut: t.is_sold_out ?? null,
        requiresApproval: t.require_approval ?? null,
        registrationStatus: e.registration_availability || null,
        organizerName: cal.name || null,
        organizerUrl: cal.slug ? `https://lu.ma/${cal.slug}` : null,
        organizerMembers: null,
        organizerWebsite: cal.website || null,
        hosts: (e.hosts || []).map((h) => ({
            name: h.name || [h.first_name, h.last_name].filter(Boolean).join(' ') || null,
            username: h.username || null,
            bio: h.bio_short || null,
            website: h.website || null,
            twitter: handle(h.twitter_handle, 'https://x.com/'),
            instagram: handle(h.instagram_handle, 'https://instagram.com/'),
            linkedin: handle(h.linkedin_handle, 'https://www.linkedin.com/'),
            tiktok: handle(h.tiktok_handle, 'https://www.tiktok.com/@'),
            youtube: handle(h.youtube_handle, 'https://www.youtube.com/@'),
        })),
        categories: (detail?.categories || []).map((c) => c.name || c.slug).filter(Boolean),
        imageUrl: ev.cover_url || null,
        search,
        scrapedAt: new Date().toISOString(),
    };
}

function meetupRow(n, search) {
    const v = n.venue || {};
    const g = n.group || {};
    const fee = n.feeSettings;
    const online = n.eventType === 'ONLINE';
    return {
        platform: 'meetup',
        eventId: n.id,
        url: n.eventUrl || null,
        title: n.title || null,
        description: includeDescription ? tidy(n.description) : null,
        startAt: n.dateTime || null,
        endAt: n.endTime || null,
        timezone: g.timezone || null,
        eventType: meetupType[n.eventType] || null,
        venueName: online ? null : v.name || null,
        address: online ? null : [v.address, v.city, v.postalCode].filter(Boolean).join(', ') || null,
        city: online ? null : v.city || null,
        region: online ? null : v.state || null,
        country: online ? null : v.country ? v.country.toUpperCase() : null,
        countryCode: online ? null : v.country ? v.country.toUpperCase() : null,
        latitude: online || !v.lat ? null : v.lat,
        longitude: online || !v.lon ? null : v.lon,
        addressHidden: null,
        isFree: fee ? !(fee.amount > 0) : true,
        price: fee?.amount > 0 ? fee.amount : null,
        maxPrice: null,
        currency: fee?.currency || null,
        attendeeCount: n.rsvps?.totalCount ?? null,
        spotsRemaining: n.maxTickets > 0 && n.rsvps ? Math.max(0, n.maxTickets - n.rsvps.totalCount) : null,
        isSoldOut: n.maxTickets > 0 && n.rsvps ? n.rsvps.totalCount >= n.maxTickets : null,
        requiresApproval: null,
        registrationStatus: n.status || null,
        organizerName: g.name || null,
        organizerUrl: g.link || (g.urlname ? `https://www.meetup.com/${g.urlname}/` : null),
        organizerMembers: g.stats?.memberCounts?.all ?? null,
        organizerWebsite: null,
        hosts: [],
        categories: [],
        imageUrl: n.featuredEventPhoto?.highResUrl || null,
        howToFindUs: n.howToFindUs || null,
        search,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- Sources ----------

const KW = list(keywords);

function keep(r) {
    if (eventType !== 'any' && r.eventType && r.eventType !== eventType.replace('_', ' ')) return false;
    if (until && r.startAt && Date.parse(r.startAt) > until) return false;
    if (r.startAt && r.endAt && Date.parse(r.endAt) < Date.now()) return false;
    return true;
}
const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word match, so "AI" does not match "available".
const matches = (r, kw) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(kw)}($|[^\\p{L}\\p{N}])`, 'iu').test(`${r.title || ''} ${r.description || ''} ${r.organizerName || ''}`);

// Luma lists: yields arrays of discover/calendar entries.
async function* lumaList(path) {
    let cursor = null;
    for (let i = 0; i < 200; i++) {
        const d = await getJson(`${LUMA}${path}${path.includes('?') ? '&' : '?'}pagination_limit=50${cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : ''}`);
        yield d?.entries || [];
        if (!d?.has_more || !d.next_cursor) return;
        cursor = d.next_cursor;
        await sleep(250);
    }
}

async function lumaDetail(id) {
    try { return await getJson(`${LUMA}/event/get?event_api_id=${encodeURIComponent(id)}`); } catch { return null; }
}

function lumaSlug(u) {
    const s = String(u).trim();
    const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:lu\.ma|luma\.com)\/([^/?#]+)/i);
    if (m) return m[1];
    return /^[\w-]+$/.test(s) ? s : null;
}

const meetupGroupName = (u) => {
    const s = String(u).trim();
    const m = s.match(/meetup\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/i);
    if (m && !['find', 'topics', 'cities'].includes(m[1])) return { group: m[1], eventId: s.match(/\/events\/(\d+)/)?.[1] || null };
    return /^[\w-]+$/.test(s) ? { group: s, eventId: null } : null;
};

async function buildSearches() {
    const out = [];
    const locs = lines(locations);
    if (useLuma) {
        for (const u of list(lumaUrls)) {
            const slug = lumaSlug(u);
            if (!slug) { out.push({ error: `Not a Luma URL or slug (lu.ma/nyc, lu.ma/genai-sf): ${u}` }); continue; }
            out.push({ kind: 'luma-url', slug, label: `lu.ma/${slug}` });
        }
    }
    if (useMeetup) {
        for (const u of list(meetupGroups)) {
            const g = meetupGroupName(u);
            out.push(g ? { kind: 'meetup-group', ...g, label: g.eventId ? `meetup event ${g.eventId}` : `meetup group ${g.group}` } : { error: `Not a Meetup group URL or name: ${u}` });
        }
    }
    for (const loc of locs) {
        const geo = await geocode(loc).catch(() => null);
        if (!geo) { out.push({ error: `Could not find the place "${loc}". Try "City, CC", e.g. "Manchester, GB".` }); continue; }
        if (useLuma) out.push({ kind: 'luma-geo', geo, label: `Luma near ${geo.label}` });
        if (useMeetup) {
            if (KW.length) for (const kw of KW) out.push({ kind: 'meetup-search', geo, kw, label: `Meetup "${kw}" near ${geo.label}` });
            else out.push({ kind: 'meetup-search', geo, kw: '', label: `Meetup near ${geo.label}` });
        }
    }
    if (!locs.length && KW.length && useMeetup && !out.some((s) => s.kind)) {
        for (const kw of KW) out.push({ kind: 'meetup-search', geo: null, kw, label: `Meetup "${kw}" (online and worldwide)` });
    }
    return out;
}

// Each source yields arrays of finished rows.
async function* rows(s) {
    if (s.kind === 'luma-geo' || s.kind === 'luma-url') {
        let path;
        if (s.kind === 'luma-geo') path = `/discover/get-paginated-events?latitude=${s.geo.lat}&longitude=${s.geo.lon}`;
        else {
            const r = await getJson(`${LUMA}/url?url=${encodeURIComponent(s.slug)}`);
            const kind = r?.kind;
            if (kind === 'discover-place') path = `/discover/get-paginated-events?discover_place_api_id=${r.data.place.api_id}`;
            else if (kind === 'calendar') path = `/calendar/get-items?calendar_api_id=${r.data.calendar.api_id}&period=future`;
            else if (kind === 'category') throw Object.assign(new Error(`lu.ma/${s.slug} is a Luma category. Luma's API does not filter events by category, so use a city with keywords instead (e.g. locations: San Francisco, keywords: ${r.data.category.name || s.slug}).`), { notFound: true });
            else if (kind === 'event') {
                const e = r.data;
                yield [lumaRow(e, s.label, includeDescription ? e : null)];
                return;
            } else throw Object.assign(new Error(`lu.ma/${s.slug} is not a Luma city, calendar or event.`), { notFound: true });
        }
        for await (const entries of lumaList(path)) {
            const batch = entries.map((e) => lumaRow(e, s.label, null));
            if (includeDescription) {
                for (let i = 0; i < batch.length; i += 6) {
                    await Promise.all(batch.slice(i, i + 6).map(async (r) => {
                        const d = await lumaDetail(r.eventId);
                        if (d) { r.description = tidy(proseText(d.description_mirror)); r.categories = (d.categories || []).map((c) => c.name || c.slug).filter(Boolean); }
                    }));
                }
            }
            yield batch;
        }
        return;
    }
    if (s.kind === 'meetup-search') {
        let after = null;
        for (let i = 0; i < 100; i++) {
            const filter = { ...(s.kw ? { query: s.kw } : {}), ...(s.geo ? { lat: s.geo.lat, lon: s.geo.lon } : {}), doConsolidateEvents: true };
            if (eventType === 'online') filter.eventType = 'ONLINE';
            if (eventType === 'in_person') filter.eventType = 'PHYSICAL';
            const d = await meetupGql(`query($filter: EventSearchFilter!, $sort: KeywordSort, $first: Int, $after: String) { eventSearch(filter: $filter, sort: $sort, first: $first, after: $after) { pageInfo { hasNextPage endCursor } edges { node { ${MEETUP_EVENT} } } } }`,
                { filter, sort: { sortField: s.kw ? 'RELEVANCE' : 'DATETIME' }, first: 50, after });
            const conn = d.eventSearch;
            yield (conn?.edges || []).map((e) => meetupRow(e.node, s.label));
            if (!conn?.pageInfo?.hasNextPage) return;
            after = conn.pageInfo.endCursor;
            await sleep(300);
        }
        return;
    }
    if (s.kind === 'meetup-group') {
        if (s.eventId) {
            const d = await meetupGql(`query($id: ID!) { event(id: $id) { ${MEETUP_EVENT} } }`, { id: s.eventId });
            if (!d.event) throw Object.assign(new Error(`No Meetup event ${s.eventId}.`), { notFound: true });
            yield [meetupRow(d.event, s.label)];
            return;
        }
        let after = null;
        for (let i = 0; i < 100; i++) {
            const d = await meetupGql(`query($u: String!, $after: String) { groupByUrlname(urlname: $u) { id events(first: 50, after: $after) { pageInfo { hasNextPage endCursor } edges { node { ${MEETUP_EVENT} } } } } }`, { u: s.group, after });
            if (!d.groupByUrlname) throw Object.assign(new Error(`No Meetup group "${s.group}".`), { notFound: true });
            const conn = d.groupByUrlname.events;
            yield (conn?.edges || []).map((e) => meetupRow(e.node, s.label));
            if (!conn?.pageInfo?.hasNextPage) return;
            after = conn.pageInfo.endCursor;
        }
    }
}

// ---------- Run ----------

let events = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];
const seen = new Set();

async function charge() {
    try {
        const res = await Actor.charge({ eventName: 'event' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = await buildSearches();
if (!searches.length) {
    const geo = await geocode('New York, US').catch(() => null);
    if (geo && useLuma) searches.push({ kind: 'luma-geo', geo, label: `Luma near ${geo.label}` });
    if (geo && useMeetup) searches.push({ kind: 'meetup-search', geo, kw: '', label: `Meetup near ${geo.label}` });
}

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    // Luma keywords filter client-side; Meetup searches carry their own keyword.
    const kws = s.kind === 'meetup-search' ? (s.kw && strictKeywordMatch ? [s.kw] : []) : s.kind === 'meetup-group' ? [] : KW;
    let count = 0;
    let scanned = 0;
    try {
        for await (const batch of rows(s)) {
            for (const r of batch) {
                if (!keepGoing || count >= perSearch) break;
                scanned += 1;
                const key = `${r.platform}:${r.eventId}`;
                if (!r.eventId || seen.has(key) || !keep(r)) continue;
                if (kws.length && !kws.some((k) => matches(r, k))) continue;
                seen.add(key);
                if (!includeDescription) r.description = null;
                await Actor.pushData(r);
                events += 1;
                count += 1;
                if (!(await charge())) keepGoing = false;
            }
            if (!keepGoing || count >= perSearch) break;
            // Luma feeds are not keyword searches; stop scanning a city after
            // 1,000 events when keywords match too few of them.
            if (kws.length && scanned >= 1000) break;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
        if (err.notFound) await Actor.pushData({ rowType: 'error', error: `${err.message} Not charged.` });
    }
    log.info(`${s.label}: ${count} event(s)${kws.length ? ` matching ${kws.join(' / ')} of ${scanned} scanned` : ''}.`);
    perSearchCounts.push({ search: s.label, events: count, scanned });
}

if (!events) await Actor.pushData({ rowType: 'note', note: 'No events found. Not charged.' });
await Actor.setValue('SUMMARY', { events, searches: perSearchCounts, failures });
log.info(`Done. ${events} event(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
