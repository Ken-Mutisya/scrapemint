// Ryanair Cheapest Fares: One-Way, Round-Trip & Price Calendar
//
// Strategy
// --------
// Read cheapest live fares from Ryanair (Europe's largest low-cost carrier)
// through its keyless public fare-finder API. Three modes:
//   1. oneWay        -> /farfnd/v4/oneWayFares  (cheapest one-way fares from
//      an origin, optionally to specific destinations, across a date window;
//      leave destinations empty to explore where you can fly cheapest)
//   2. roundTrip     -> /farfnd/v4/roundTripFares (adds a return window and
//      a trip-duration filter; price is the round-trip total)
//   3. cheapestPerDay-> /farfnd/3/oneWayFares/{origin}/{dest}/cheapestPerDay
//      (a price calendar: the cheapest fare on each day of a month)
//
// Prices come as {value, currencyCode}. One flat row per fare (or per day in
// calendar mode) with route, dates, flight number, price, and a booking link.
//
// Pay per event
// -------------
//   fare_row ($0.008) charged per fare row pushed. Empty searches and bad
//   inputs produce free note rows. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const API = 'https://services-api.ryanair.com';
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 300;
const PAGE_LIMIT = 16; // Ryanair fare-finder page size
const MAX_PAGES = 40;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'oneWay',
    origin = '',
    destinations = [],
    departFrom = '',
    departTo = '',
    returnFrom = '',
    returnTo = '',
    tripDurationFrom = 2,
    tripDurationTo = 7,
    month = '',
    currency = 'EUR',
    maxPrice = 0,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const iata = (v) => String(v || '').trim().toUpperCase();
const originIata = iata(origin);
const destList = asList(destinations).map(iata).filter((d) => /^[A-Z]{3}$/.test(d));
const cur = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
const priceCap = Math.max(0, Number(maxPrice) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const modeNorm = ['oneway', 'roundtrip', 'cheapestperday'].includes(String(mode).toLowerCase().replace(/[^a-z]/g, ''))
    ? String(mode).toLowerCase().replace(/[^a-z]/g, '') : 'oneway';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retried = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (res.status === 429 || res.status === 503) {
            if (!retried) {
                log.warning(`HTTP ${res.status}; backing off 8s...`);
                await sleep(8000);
                return getJson(url, true);
            }
            return null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 110)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const isoDate = (d) => d.toISOString().slice(0, 10);

// Date-window defaults: today .. today+30d for the outbound leg.
function defaultWindow() {
    const now = new Date();
    const from = isoDate(now);
    const to = isoDate(new Date(now.getTime() + 30 * 86400000));
    return { from, to };
}
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());

function bookingUrl(o, d, dateOut, dateIn) {
    const base = `https://www.ryanair.com/gb/en/trip/flights/select?adults=1&teens=0&children=0&infants=0&originIata=${o}&destinationIata=${d}`;
    const out = `&dateOut=${String(dateOut).slice(0, 10)}`;
    if (dateIn) return `${base}${out}&dateIn=${String(dateIn).slice(0, 10)}&isReturn=true`;
    return `${base}${out}&isReturn=false`;
}

let rowsPushed = 0;
// The fare finder pages with limit/offset and does not guarantee a stable order
// between requests, so a fare served on one page can be served again on the
// next. That shipped as duplicate rows that were pushed AND charged: a DUB one
// way run on 2026-08-09 billed 40 rows for 19 distinct fares, with FR313 to ARN
// appearing three times, and maxRows filled with copies instead of more fares.
// The key is the whole row minus scrapedAt, which is the only field that
// differs between two emissions of the same fare. Two genuinely different fares
// always differ somewhere else (flight number, date or price), so this can only
// drop a true repeat. Note rows are never chargeable and are never deduped.
const emittedKeys = new Set();
let duplicatesSkipped = 0;
async function flushRow(row, chargeable = true) {
    if (chargeable) {
        const { scrapedAt, ...key } = row;
        const k = JSON.stringify(key);
        if (emittedKeys.has(k)) { duplicatesSkipped += 1; return false; }
        emittedKeys.add(k);
    }
    await Actor.pushData(row);
    if (!chargeable) return true;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'fare_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
    return true;
}

// ---- Row builders ------------------------------------------------------
function legFields(leg, prefix) {
    const dep = leg.departureAirport || {};
    const arr = leg.arrivalAirport || {};
    return {
        [`${prefix}Origin`]: dep.iataCode || null,
        [`${prefix}OriginName`]: clean(dep.name),
        [`${prefix}OriginCountry`]: clean(dep.countryName),
        [`${prefix}Destination`]: arr.iataCode || null,
        [`${prefix}DestinationName`]: clean(arr.name),
        [`${prefix}DestinationCountry`]: clean(arr.countryName),
        [`${prefix}DepartureDate`]: clean(leg.departureDate),
        [`${prefix}ArrivalDate`]: clean(leg.arrivalDate),
        [`${prefix}FlightNumber`]: clean(leg.flightNumber),
    };
}

function oneWayRow(f) {
    const o = f.outbound || {};
    const price = o.price || f.summary?.price || {};
    const dep = o.departureAirport || {};
    const arr = o.arrivalAirport || {};
    return {
        type: 'oneWay',
        origin: dep.iataCode || null,
        originName: clean(dep.name),
        originCountry: clean(dep.countryName),
        destination: arr.iataCode || null,
        destinationName: clean(arr.name),
        destinationCountry: clean(arr.countryName),
        departureDate: clean(o.departureDate),
        arrivalDate: clean(o.arrivalDate),
        flightNumber: clean(o.flightNumber),
        price: num(price.value),
        currency: price.currencyCode || cur,
        newRoute: !!(f.summary?.newRoute),
        bookingUrl: dep.iataCode && arr.iataCode ? bookingUrl(dep.iataCode, arr.iataCode, o.departureDate) : null,
        scrapedAt: new Date().toISOString(),
    };
}

function roundTripRow(f) {
    const o = f.outbound || {};
    const i = f.inbound || {};
    const total = f.summary?.price || {};
    return {
        type: 'roundTrip',
        origin: o.departureAirport?.iataCode || null,
        destination: o.arrivalAirport?.iataCode || null,
        destinationName: clean(o.arrivalAirport?.name),
        destinationCountry: clean(o.arrivalAirport?.countryName),
        ...legFields(o, 'outbound'),
        ...legFields(i, 'inbound'),
        outboundPrice: num(o.price?.value),
        inboundPrice: num(i.price?.value),
        totalPrice: num(total.value),
        currency: total.currencyCode || cur,
        tripDurationDays: num(f.summary?.tripDurationDays),
        newRoute: !!(f.summary?.newRoute),
        bookingUrl: o.departureAirport?.iataCode && o.arrivalAirport?.iataCode
            ? bookingUrl(o.departureAirport.iataCode, o.arrivalAirport.iataCode, o.departureDate, i.departureDate) : null,
        scrapedAt: new Date().toISOString(),
    };
}

// ---- Modes -------------------------------------------------------------
function priceOk(v) { return !priceCap || (v != null && v <= priceCap); }

async function runFares(path, rowFn, extraParams) {
    const win = defaultWindow();
    const df = validDate(departFrom) ? departFrom.trim() : win.from;
    const dt = validDate(departTo) ? departTo.trim() : win.to;
    let offset = 0;
    let emitted = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        if (pastDeadline() || rowsPushed >= cap) break;
        const p = new URLSearchParams({
            departureAirportIataCode: originIata,
            outboundDepartureDateFrom: df,
            outboundDepartureDateTo: dt,
            currency: cur,
            limit: String(PAGE_LIMIT),
            offset: String(offset),
            ...extraParams,
        });
        if (destList.length) p.set('arrivalAirportIataCodes', destList.join(','));
        if (priceCap) p.set('priceValueTo', String(priceCap));
        await sleep(REQUEST_GAP_MS);
        const d = await getJson(`${API}${path}?${p.toString()}`);
        const fares = d?.fares || [];
        if (!fares.length) break;
        let newThisPage = 0;
        let repeatsThisPage = 0;
        for (const f of fares) {
            if (rowsPushed >= cap) break;
            const row = rowFn(f);
            const pv = row.totalPrice ?? row.price;
            if (!priceOk(pv)) continue;
            if (await flushRow(row)) { emitted += 1; newThisPage += 1; }
            else repeatsThisPage += 1;
        }
        // The fare finder ignores `offset`: it answers every page with the same
        // first `limit` fares, and `size` stays at the page size so the last
        // page check below never fires. A DUB one way run therefore walked all
        // 40 pages and saw 624 repeats of the same 16 fares. A page that was
        // entirely repeats means paging is not advancing, so stop and save the
        // remaining requests. A page emptied by the price filter is a different
        // thing and must not stop the walk.
        if (newThisPage === 0 && repeatsThisPage > 0) break;
        const size = num(d?.size) ?? fares.length;
        if (size < PAGE_LIMIT) break; // last page
        offset += PAGE_LIMIT;
    }
    return emitted;
}

async function runCheapestPerDay() {
    if (destList.length !== 1) {
        await flushRow({ note: 'cheapestPerDay mode needs exactly one destination (a single arrival IATA code).' }, false);
        return 0;
    }
    const dest = destList[0];
    const m = /^\d{4}-\d{2}$/.test(String(month).trim())
        ? `${month.trim()}-01`
        : (validDate(departFrom) ? `${departFrom.trim().slice(0, 7)}-01` : `${defaultWindow().from.slice(0, 7)}-01`);
    const p = new URLSearchParams({ outboundMonthOfDate: m, currency: cur });
    await sleep(REQUEST_GAP_MS);
    const d = await getJson(`${API}/farfnd/3/oneWayFares/${originIata}/${dest}/cheapestPerDay?${p.toString()}`);
    const fares = d?.outbound?.fares || [];
    let emitted = 0;
    for (const day of fares) {
        if (rowsPushed >= cap) break;
        const pv = num(day.price?.value);
        if (day.soldOut || day.unavailable || pv == null) continue; // only real, available fares
        if (!priceOk(pv)) continue;
        if (await flushRow({
            type: 'cheapestPerDay',
            origin: originIata,
            destination: dest,
            day: clean(day.day),
            departureDate: clean(day.departureDate),
            arrivalDate: clean(day.arrivalDate),
            price: pv,
            currency: day.price?.currencyCode || cur,
            bookingUrl: bookingUrl(originIata, dest, day.day),
            scrapedAt: new Date().toISOString(),
        })) emitted += 1;
    }
    return emitted;
}

// ---- Run ---------------------------------------------------------------
if (!/^[A-Z]{3}$/.test(originIata)) {
    await flushRow({ note: 'Provide a valid 3-letter origin airport IATA code, e.g. DUB, STN, BER.' }, false);
    log.info('No valid origin; exiting.');
    await Actor.exit();
}

log.info(`Ryanair ${modeNorm} from ${originIata}${destList.length ? ` to ${destList.join(',')}` : ' (explore all destinations)'}, ${cur}${priceCap ? `, max ${priceCap}` : ''}. Cap ${cap} rows.`);

let emitted = 0;
if (modeNorm === 'roundtrip') {
    const win = defaultWindow();
    const durTo = Math.max(1, Number(tripDurationTo) || 7);
    // Default the inbound window to the whole outbound window extended by the
    // max trip length, so short round trips across the range are all found
    // (a return window that starts only where the outbound window ends yields
    // almost no valid combinations).
    const rf = validDate(returnFrom) ? returnFrom.trim() : (validDate(departFrom) ? departFrom.trim() : win.from);
    const outTo = validDate(departTo) ? departTo.trim() : win.to;
    const rt = validDate(returnTo) ? returnTo.trim() : isoDate(new Date(Date.parse(outTo) + durTo * 86400000));
    emitted = await runFares('/farfnd/v4/roundTripFares', roundTripRow, {
        inboundDepartureDateFrom: rf,
        inboundDepartureDateTo: rt,
        durationFrom: String(Math.max(1, Number(tripDurationFrom) || 2)),
        durationTo: String(Math.max(1, Number(tripDurationTo) || 7)),
    });
} else if (modeNorm === 'cheapestperday') {
    emitted = await runCheapestPerDay();
} else {
    emitted = await runFares('/farfnd/v4/oneWayFares', oneWayRow, {});
}

if (emitted === 0 && rowsPushed === 0) {
    await flushRow({
        note: `No fares found from ${originIata}${destList.length ? ` to ${destList.join(',')}` : ''}${priceCap ? ` under ${priceCap} ${cur}` : ''}. Try a wider date window, different destinations, or drop the price cap.`,
    }, false);
}

log.info(`Done. ${emitted} fare row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable)`
    + `${duplicatesSkipped ? `, ${duplicatesSkipped} duplicate fare(s) from the API skipped and not charged` : ''}.`);
await Actor.exit();
