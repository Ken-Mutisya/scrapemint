// Flight Price Tracker
// Scrapes Google Flights via PlaywrightCrawler with fingerprint injection
// and residential proxy. Builds a row per fare returned for a route and date.
//
// Free tier: first 50 items per run are free. Charge per item after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 50;

await Actor.init();

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;
let pageFetches = 0;

const input = (await Actor.getInput()) ?? {};
const {
    routes = [],
    departureDates = [],
    returnDates = [],
    departDaysAhead = 30,
    dateWindowDays = 7,
    tripType = 'one_way',
    cabinClass = 'economy',
    passengers = 1,
    maxStops = 2,
    maxPriceUsd = 0,
    minPriceUsd = 0,
    preferredAirlines = [],
    excludeAirlines = [],
    maxItemsPerRoute = 20,
    maxItemsTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const routeList = toArray(routes).map(parseRoute).filter(Boolean);
const prefSet = new Set(toArray(preferredAirlines).map((a) => String(a).toUpperCase()));
const excludeSet = new Set(toArray(excludeAirlines).map((a) => String(a).toUpperCase()));

const store = await Actor.openKeyValueStore();
const seenState = (dedupe && (await store.getValue('SEEN_FARES'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

try {
    if (routeList.length === 0) {
        log.error('Provide at least one route like JFK-LHR.');
    } else {
        const dateSet = buildDateList();
        if (dateSet.length === 0) {
            log.error('No departure dates built. Set departureDates or use departDaysAhead + dateWindowDays.');
        } else {
            const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

            const requests = [];
            for (const r of routeList) {
                for (let i = 0; i < dateSet.length; i++) {
                    const depart = dateSet[i];
                    const ret = tripType === 'round_trip' ? (toArray(returnDates)[i] || addDays(depart, 7)) : null;
                    requests.push({
                        url: buildFlightsUrl(r, depart, ret, cabinClass, passengers),
                        userData: { route: r, depart, ret },
                        uniqueKey: `${r.from}-${r.to}:${depart}:${ret || 'ow'}`,
                    });
                }
            }

            const crawler = new PlaywrightCrawler({
                proxyConfiguration,
                maxConcurrency: 1,
                maxRequestRetries: 2,
                retryOnBlocked: true,
                useSessionPool: true,
                sessionPoolOptions: { maxPoolSize: 15 },
                navigationTimeoutSecs: 45,
                requestHandlerTimeoutSecs: 90,
                browserPoolOptions: {
                    useFingerprints: true,
                    fingerprintOptions: {
                        fingerprintGeneratorOptions: {
                            browsers: [{ name: 'chrome', minVersion: 120 }],
                            devices: ['desktop'],
                            operatingSystems: ['macos', 'windows'],
                            locales: ['en-US', 'en'],
                        },
                    },
                },
                preNavigationHooks: [
                    async ({ page }) => {
                        await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
                    },
                ],
                requestHandler: async ({ page, request, session }) => {
                    pageFetches += 1;
                    await page.waitForLoadState('domcontentloaded', { timeout: 25_000 }).catch(() => {});

                    const title = (await page.title().catch(() => '')) || '';
                    const url = page.url();
                    log.info(`page title="${title}" url=${url}`);

                    if (/sorry|unusual traffic|captcha|before you continue/i.test(title) || /\/sorry\/|consent\.google\./i.test(url)) {
                        log.warning(`Blocked / consent page detected for ${request.url}. Marking session bad and skipping retries.`);
                        if (session && typeof session.retire === 'function') session.retire();
                        request.noRetry = true;
                        return;
                    }

                    await page.waitForSelector('[role="main"], [aria-label*="flight" i]', { timeout: 20_000 }).catch(() => {});
                    await page.waitForTimeout(4000);

                    const flights = await extractFlights(page);
                    const { route, depart, ret } = request.userData;
                    log.info(`${route.from}-${route.to} depart=${depart} ret=${ret || 'ow'} -> ${flights.length} flights`);

                    if (totalPushed >= maxItemsTotal) return;

                    let pushedThis = 0;
                    for (const f of flights) {
                        if (pushedThis >= maxItemsPerRoute) break;
                        if (totalPushed >= maxItemsTotal) break;
                        const row = shapeRow(f, route, depart, ret, request.url);
                        if (await pushRow(row)) pushedThis += 1;
                    }
                },
                failedRequestHandler: async ({ request, error }) => {
                    log.warning(`failed ${request.url}: ${error?.message}`);
                },
            });

            await crawler.run(requests);
        }
    }

    if (dedupe) {
        const trimmed = [...newSeen].slice(-50_000);
        await store.setValue('SEEN_FARES', trimmed);
    }
} catch (err) {
    log.exception(err, 'Unhandled error during run');
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped} pageFetches=${pageFetches}`);
await Actor.exit();

function parseRoute(raw) {
    if (!raw) return null;
    if (typeof raw === 'object' && raw.from && raw.to) {
        return { from: String(raw.from).toUpperCase().slice(0, 3), to: String(raw.to).toUpperCase().slice(0, 3) };
    }
    const s = String(raw).trim().toUpperCase();
    const m = s.match(/^([A-Z]{3})[\s\-_>]+([A-Z]{3})$/);
    if (!m) return null;
    return { from: m[1], to: m[2] };
}

function buildDateList() {
    const explicit = toArray(departureDates).map((d) => String(d).trim()).filter(Boolean);
    if (explicit.length) return explicit;
    const out = [];
    for (let i = 0; i < dateWindowDays; i++) {
        out.push(addDays(todayIso(), departDaysAhead + i));
    }
    return out;
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function buildFlightsUrl(route, depart, ret, cabin, pax) {
    const cabinPhrase = cabin === 'economy' ? '' : ` ${cabin.replace('_', ' ')}`;
    const paxPhrase = pax > 1 ? ` ${pax} adults` : '';
    const returnPart = ret ? ` returning ${ret}` : ' one way';
    const q = `flights from ${route.from} to ${route.to} on ${depart}${returnPart}${cabinPhrase}${paxPhrase}`;
    return `https://www.google.com/travel/flights?hl=en&curr=USD&q=${encodeURIComponent(q)}`;
}

async function extractFlights(page) {
    return page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[aria-label^="From "]'));
        const results = [];
        const seen = new Set();

        for (const el of nodes) {
            const al = el.getAttribute('aria-label') || '';
            if (!/flight with/i.test(al)) continue;

            const priceMatch = al.match(/From\s+([\d,]+)\s+([A-Za-z ]+?)\s+dollars?/i)
                || al.match(/From\s+([\d,]+)\s+([A-Za-z ]+)/);
            if (!priceMatch) continue;
            const price = Number(priceMatch[1].replace(/,/g, ''));
            const currency = /US/i.test(priceMatch[2]) ? 'USD'
                : /Canadian/i.test(priceMatch[2]) ? 'CAD'
                : /Euro/i.test(priceMatch[2]) ? 'EUR'
                : /British|pound/i.test(priceMatch[2]) ? 'GBP'
                : 'USD';

            let stops;
            if (/nonstop flight/i.test(al)) stops = 0;
            else {
                const sm = al.match(/(\d+)\s+stops?\s+flight/i);
                stops = sm ? Number(sm[1]) : null;
            }

            const airlineMatch = al.match(/flight with\s+([^.]+?)\./i);
            const airline = airlineMatch ? airlineMatch[1].trim() : null;

            const departMatch = al.match(/Leaves\s+(.+?)\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
            const arriveMatch = al.match(/arrives\s+at\s+(.+?)\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
            const durMatch = al.match(/Total duration\s+(\d+)\s*hr(?:\s*(\d+)\s*min)?/i)
                || al.match(/Total duration\s+(\d+)\s*hour(?:s)?(?:\s*(\d+)\s*minute(?:s)?)?/i)
                || al.match(/Total duration\s+(\d+)\s*min/i);
            let durationMinutes = null;
            if (durMatch) {
                if (/hr|hour/i.test(durMatch[0])) durationMinutes = Number(durMatch[1]) * 60 + Number(durMatch[2] || 0);
                else durationMinutes = Number(durMatch[1]);
            }

            const layovers = [];
            const layRe = /Layover[^.]*?is\s+a\s+(\d+)\s*hr(?:\s*(\d+)\s*min)?\s+layover\s+at\s+([^.]+?)\s+in\s+([^.]+?)\./gi;
            let lm;
            while ((lm = layRe.exec(al)) !== null) {
                layovers.push({
                    minutes: Number(lm[1]) * 60 + Number(lm[2] || 0),
                    airport: lm[3].trim(),
                    city: lm[4].trim(),
                });
            }

            const key = `${price}|${airline}|${departMatch?.[2] || ''}|${arriveMatch?.[2] || ''}|${durationMinutes}|${stops}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
                price,
                currency,
                airline,
                durationMinutes,
                stops,
                departAirport: departMatch ? departMatch[1].trim() : null,
                departTime: departMatch ? departMatch[2].trim() : null,
                arriveAirport: arriveMatch ? arriveMatch[1].trim() : null,
                arriveTime: arriveMatch ? arriveMatch[2].trim() : null,
                layovers,
            });
        }
        return results;
    });
}

function shapeRow(f, route, depart, ret, sourceUrl) {
    totalSeen += 1;

    const airlineCode = airlineNameToCode(f.airline);
    const flags = [];
    if (f.stops === 0) flags.push('nonstop');
    if (f.price != null && f.price < 200) flags.push('cheap');
    if (f.price != null && f.price > 2000) flags.push('premium_fare');
    if (cabinClass !== 'economy') flags.push(`cabin_${cabinClass}`);
    if (f.durationMinutes != null && f.durationMinutes < 180) flags.push('short_haul');
    if (f.durationMinutes != null && f.durationMinutes > 600) flags.push('long_haul');

    const dedupeKey = [
        route.from,
        route.to,
        depart,
        ret || 'ow',
        cabinClass,
        airlineCode || (f.airline || '').toLowerCase(),
        f.price,
        f.durationMinutes,
        f.stops,
    ].join('|');

    return {
        source: 'google_flights',
        origin: route.from,
        destination: route.to,
        departureDate: depart,
        returnDate: ret || null,
        tripType,
        cabinClass,
        passengers,
        airline: f.airline,
        airlineCode,
        stops: f.stops,
        durationMinutes: f.durationMinutes,
        durationLabel: f.durationMinutes != null ? formatDuration(f.durationMinutes) : null,
        priceTotal: f.price,
        pricePerPax: f.price != null && passengers > 0 ? Math.round(f.price / passengers) : null,
        priceCurrency: f.currency || 'USD',
        departAirport: f.departAirport || null,
        departTime: f.departTime,
        arriveAirport: f.arriveAirport || null,
        arriveTime: f.arriveTime,
        layovers: f.layovers || [],
        stopCities: (f.layovers || []).map((l) => l.city),
        flags,
        sourceUrl,
        dedupeKey,
        scrapedAt: new Date().toISOString(),
    };
}

async function pushRow(row) {
    if (row.priceTotal == null) { filteredOut += 1; return false; }
    if (maxStops != null && row.stops != null && row.stops > maxStops) { filteredOut += 1; return false; }
    if (maxPriceUsd > 0 && row.priceTotal > maxPriceUsd) { filteredOut += 1; return false; }
    if (minPriceUsd > 0 && row.priceTotal < minPriceUsd) { filteredOut += 1; return false; }
    if (prefSet.size > 0) {
        const code = (row.airlineCode || '').toUpperCase();
        const name = (row.airline || '').toUpperCase();
        const hit = prefSet.has(code) || [...prefSet].some((p) => name.includes(p));
        if (!hit) { filteredOut += 1; return false; }
    }
    if (excludeSet.size > 0) {
        const code = (row.airlineCode || '').toUpperCase();
        const name = (row.airline || '').toUpperCase();
        const hit = excludeSet.has(code) || [...excludeSet].some((p) => name.includes(p));
        if (hit) { filteredOut += 1; return false; }
    }

    if (dedupe && seen.has(row.dedupeKey)) { deduped += 1; return false; }

    await Actor.pushData(row);
    totalPushed += 1;
    newSeen.add(row.dedupeKey);
    maybeCharge();
    return true;
}

function airlineNameToCode(name) {
    if (!name) return null;
    const map = {
        'delta': 'DL',
        'united': 'UA',
        'american': 'AA',
        'jetblue': 'B6',
        'southwest': 'WN',
        'alaska': 'AS',
        'spirit': 'NK',
        'frontier': 'F9',
        'hawaiian': 'HA',
        'british airways': 'BA',
        'virgin atlantic': 'VS',
        'air france': 'AF',
        'klm': 'KL',
        'lufthansa': 'LH',
        'swiss': 'LX',
        'iberia': 'IB',
        'ryanair': 'FR',
        'easyjet': 'U2',
        'turkish': 'TK',
        'emirates': 'EK',
        'qatar': 'QR',
        'etihad': 'EY',
        'singapore': 'SQ',
        'cathay': 'CX',
        'japan airlines': 'JL',
        'ana': 'NH',
        'korean': 'KE',
        'asiana': 'OZ',
        'air canada': 'AC',
        'aeromexico': 'AM',
        'copa': 'CM',
        'latam': 'LA',
        'qantas': 'QF',
        'air new zealand': 'NZ',
    };
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
        if (lower.includes(k)) return v;
    }
    return null;
}

function formatDuration(mins) {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function toArray(v) {
    return Array.isArray(v) ? v : [];
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'item_extracted' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}
