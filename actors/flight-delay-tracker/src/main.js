// Flight Delay & Cancellation Tracker
// Scrapes FlightAware via PlaywrightCrawler with fingerprint injection and a
// residential proxy. Builds one row per flight returned for each input source.
//
// Two data paths:
//   - Flight number page: parses the embedded `trackpollBootstrap` JSON, which
//     carries scheduled/estimated/actual Unix timestamps, cancelled/diverted
//     flags, aircraft, gates, and the activity log. This is the same data
//     FlightAware's own UI renders, so delays come straight from ASDI/ADS-B.
//   - Route findflight page: parses the `ffinder-results-row` HTML rows.
//     Returns ident, scheduled times, status text. Lower fidelity than the
//     bootstrap, but fine for surfacing flight idents on a route.
//
// FlightAware airport boards are now behind a sign-in wall with Cloudflare
// Turnstile, so this actor does not support airport input. Use flight numbers
// or routes instead.
//
// Free tier: first 20 items per run are free. Charge per item after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 20;

// FlightAware uses ICAO airline codes (3-letter) for flight idents. Most users
// know IATA (2-char) codes, so we translate the common carriers transparently.
const IATA_TO_ICAO = {
    AA: 'AAL', AC: 'ACA', AF: 'AFR', AI: 'AIC', AM: 'AMX', AS: 'ASA',
    AY: 'FIN', AZ: 'ITY', BA: 'BAW', BR: 'EVA', CA: 'CCA', CI: 'CAL',
    CM: 'CMP', CX: 'CPA', CZ: 'CSN', DL: 'DAL', EI: 'EIN', EK: 'UAE',
    ET: 'ETH', EY: 'ETD', F9: 'FFT', FI: 'ICE', FR: 'RYR', GA: 'GIA',
    HA: 'HAL', IB: 'IBE', JL: 'JAL', KE: 'KAL', KL: 'KLM', LA: 'LAN',
    LH: 'DLH', LO: 'LOT', LX: 'SWR', MS: 'MSR', MU: 'CES', NH: 'ANA',
    NK: 'NKS', NZ: 'ANZ', OS: 'AUA', OZ: 'AAR', PR: 'PAL', QF: 'QFA',
    QR: 'QTR', RJ: 'RJA', SA: 'SAA', SK: 'SAS', SQ: 'SIA', SU: 'AFL',
    TG: 'THA', TK: 'THY', TP: 'TAP', UA: 'UAL', VS: 'VIR', WN: 'SWA',
    WS: 'WJA', B6: 'JBU', G4: 'AAY',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    flightNumbers = [],
    routes = [],
    minDelayMinutes = 0,
    includeStatuses = ['scheduled', 'on-time', 'delayed', 'cancelled', 'diverted', 'landed', 'en-route', 'unknown'],
    cancelledOnly = false,
    maxItemsPerSource = 25,
    maxItemsTotal = 100,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const wantStatuses = cancelledOnly
    ? new Set(['cancelled', 'diverted'])
    : new Set(includeStatuses.map((s) => String(s).toLowerCase()));

const idents = cleanList(flightNumbers).map(normalizeIdent);
const rtes = (Array.isArray(routes) ? routes : [])
    .map((r) => ({
        origin: String(r?.origin || '').toUpperCase().trim(),
        destination: String(r?.destination || '').toUpperCase().trim(),
        date: String(r?.date || '').trim(),
    }))
    .filter((r) => r.origin && r.destination);

if (idents.length === 0 && rtes.length === 0) {
    log.warning('No input provided. Add a flight number or route and run again.');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('flight-delay-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-keys')) || [];
    for (const k of prev) seen.add(k);
}

let totalPushed = 0;

const initialRequests = [];
for (const ident of idents) {
    initialRequests.push({
        url: `https://flightaware.com/live/flight/${encodeURIComponent(ident)}`,
        userData: { type: 'flight', ident },
        uniqueKey: `flight:${ident}`,
    });
}
for (const r of rtes) {
    const params = new URLSearchParams({
        origin: toIcaoIfUs(r.origin),
        destination: toIcaoIfUs(r.destination),
    });
    if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        params.set('date', r.date.replace(/-/g, ''));
    }
    initialRequests.push({
        url: `https://flightaware.com/live/findflight?${params.toString()}`,
        userData: { type: 'route', origin: r.origin, destination: r.destination, date: r.date || null },
        uniqueKey: `route:${r.origin}:${r.destination}:${r.date || ''}`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    maxRequestRetries: 2,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 25, sessionOptions: { maxUsageCount: 20 } },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                operatingSystems: ['macos', 'windows'],
                locales: ['en-US'],
            },
        },
    },
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ page, request }) {
        if (totalPushed >= maxItemsTotal) {
            log.info(`Total cap reached (${totalPushed}/${maxItemsTotal}), skipping ${request.url}`);
            return;
        }

        await page.setViewportSize({ width: 1440, height: 1800 });
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        await page.waitForTimeout(800);

        if (await isBlocked(page)) {
            throw new Error(`Blocked by FlightAware: ${page.url()}`);
        }

        const { type } = request.userData;
        if (type === 'flight') return handleFlight(page, request);
        if (type === 'route') return handleRoute(page, request);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && totalPushed > 0) {
    await seenStore.setValue('seen-keys', [...seen]);
}

log.info(`Run complete. Pushed ${totalPushed} flight rows.`);
await Actor.exit();

// ---------- handlers ----------

async function handleFlight(page, request) {
    const { ident } = request.userData;
    const bootstrap = await readBootstrap(page);
    if (!bootstrap) {
        log.warning(`No trackpollBootstrap found for ${ident}. Page may be unsupported.`);
        return;
    }

    const flights = bootstrap.flights || {};
    const keys = Object.keys(flights);
    if (keys.length === 0 || keys.every((k) => k.startsWith('INVALID-'))) {
        log.warning(`Flight not found: ${ident}. Try the ICAO airline code (UAL1, BAW112, AFR22).`);
        return;
    }

    const rows = [];
    for (const key of keys) {
        if (key.startsWith('INVALID-')) continue;
        const wrap = flights[key];
        const log_ = wrap?.activityLog?.flights;
        if (!Array.isArray(log_)) continue;
        for (const f of log_) {
            const row = mapBootstrapFlight(f, ident);
            if (row) rows.push(row);
        }
    }

    log.info(`Flight ${ident}: ${rows.length} rows from bootstrap`);
    await pushRows(rows, request, ident);
}

async function handleRoute(page, request) {
    const { origin, destination, date } = request.userData;
    const rows = await page.evaluate(() => {
        const out = [];
        const trs = document.querySelectorAll('tr.ffinder-results-row');
        for (const tr of trs) {
            const url = tr.getAttribute('url') || tr.querySelector('a[href*="/live/flight/"]')?.getAttribute('href') || null;
            const airlineEl = tr.querySelector('.ffinder-results-airline span');
            const identEl = tr.querySelector('.ffinder-results-ident a, .ffinder-results-ident');
            const aircraftEl = tr.querySelector('.ffinder-results-aircraft');
            const statusEl = tr.querySelector('.ffinder-results-status');
            const depEl = tr.querySelector('.ffinder-results-schedule-departure');
            const arrEl = tr.querySelector('.ffinder-results-schedule-arrival');
            const tx = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
            const ident = tx(identEl);
            if (!ident) continue;
            out.push({
                ident,
                airline: tx(airlineEl) || null,
                aircraft: tx(aircraftEl) || null,
                statusText: tx(statusEl) || null,
                scheduledDeparture: tx(depEl) || null,
                scheduledArrival: tx(arrEl) || null,
                detailPath: url,
            });
        }
        return out;
    });

    const mapped = rows.map((r) => {
        const status = normalizeStatusText(r.statusText);
        const departureDelayMin = parseDelayFromStatus(r.statusText);
        return {
            ident: r.ident,
            origin,
            destination,
            route: `${origin}-${destination}`,
            scheduledDate: date,
            scheduledDeparture: r.scheduledDeparture,
            actualDeparture: null,
            scheduledArrival: r.scheduledArrival,
            actualArrival: null,
            departureDelayMin,
            arrivalDelayMin: null,
            status,
            statusText: r.statusText,
            cancelReason: status === 'cancelled' ? extractCancelReason(r.statusText) : null,
            airline: r.airline,
            aircraft: r.aircraft,
            duration: null,
            detailUrl: r.detailPath ? `https://flightaware.com${r.detailPath}` : null,
        };
    });

    log.info(`Route ${origin}->${destination} ${date || ''}: ${mapped.length} rows`);
    await pushRows(mapped, request, `${origin}-${destination}-${date || 'any'}`);
}

async function pushRows(rows, request, sourceLabel) {
    const cap = Math.min(maxItemsPerSource, maxItemsTotal - totalPushed);
    let count = 0;
    for (const r of rows) {
        if (count >= cap) break;
        if (totalPushed >= maxItemsTotal) break;

        if (!wantStatuses.has(r.status)) continue;
        if (Number.isFinite(r.departureDelayMin) && r.departureDelayMin < minDelayMinutes) continue;
        if (!Number.isFinite(r.departureDelayMin) && minDelayMinutes > 0 && r.status !== 'cancelled' && r.status !== 'diverted') continue;

        const dedupeKey = `${r.ident || 'unknown'}|${r.scheduledDeparture || r.scheduledDate || ''}|${r.origin || ''}|${r.destination || ''}`;
        if (dedupe && seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const out = {
            ...r,
            sourceType: request.userData.type,
            source: sourceLabel,
            url: request.loadedUrl || request.url,
            scrapedAt: new Date().toISOString(),
        };
        await Actor.pushData(out);
        totalPushed += 1;
        count += 1;
        maybeCharge();
    }
    if (count > 0) {
        log.info(`Pushed ${count} rows for ${sourceLabel} (${totalPushed}/${maxItemsTotal} total)`);
    }
}

// ---------- bootstrap parser ----------

async function readBootstrap(page) {
    return page.evaluate(() => {
        for (const s of document.querySelectorAll('script')) {
            const text = s.textContent || '';
            const m = text.match(/trackpollBootstrap\s*=\s*(\{[\s\S]*?\});/);
            if (m) {
                try { return JSON.parse(m[1]); } catch { return null; }
            }
        }
        return null;
    });
}

function mapBootstrapFlight(f, queryIdent) {
    if (!f) return null;
    const ident = f.displayIdent || queryIdent || null;
    const origin = f.origin || {};
    const destination = f.destination || {};

    const gateOut = f.gateDepartureTimes || {};
    const gateIn = f.gateArrivalTimes || {};
    const takeoff = f.takeoffTimes || {};
    const landing = f.landingTimes || {};

    const schedDepUnix = gateOut.scheduled || takeoff.scheduled || null;
    const actualDepUnix = gateOut.actual || takeoff.actual || gateOut.estimated || takeoff.estimated || null;
    const schedArrUnix = gateIn.scheduled || landing.scheduled || null;
    const actualArrUnix = gateIn.actual || landing.actual || gateIn.estimated || landing.estimated || null;

    const cancelled = !!f.cancelled;
    const diverted = !!f.diverted;
    const hasActualDep = gateOut.actual || takeoff.actual;
    const hasActualArr = gateIn.actual || landing.actual;

    let status = 'unknown';
    if (cancelled) status = 'cancelled';
    else if (diverted) status = 'diverted';
    else if (hasActualArr) status = 'landed';
    else if (hasActualDep) status = 'en-route';
    else if (schedDepUnix) status = 'scheduled';

    const departureDelaySec = (actualDepUnix && schedDepUnix) ? actualDepUnix - schedDepUnix : null;
    const arrivalDelaySec = (actualArrUnix && schedArrUnix) ? actualArrUnix - schedArrUnix : null;
    const departureDelayMin = departureDelaySec != null ? Math.round(departureDelaySec / 60) : null;
    const arrivalDelayMin = arrivalDelaySec != null ? Math.round(arrivalDelaySec / 60) : null;

    if (status === 'scheduled' && departureDelayMin && departureDelayMin >= 15) status = 'delayed';
    if (status === 'landed' && (arrivalDelayMin || 0) > 15) status = 'delayed';
    if ((status === 'en-route' || status === 'landed' || status === 'scheduled') && Math.abs(departureDelayMin || 0) <= 15 && (arrivalDelayMin == null || Math.abs(arrivalDelayMin) <= 15)) {
        status = status === 'scheduled' ? 'scheduled' : status === 'landed' ? 'landed' : 'en-route';
    }
    if (!cancelled && !diverted && hasActualArr && (arrivalDelayMin || 0) <= 15 && (arrivalDelayMin || 0) >= -60) {
        if (status === 'landed' && (arrivalDelayMin || 0) > 15) status = 'delayed';
        else if (status === 'landed') status = 'landed';
    }

    return {
        ident,
        origin: origin.iata || origin.icao || null,
        originIcao: origin.icao || null,
        originName: origin.friendlyName || null,
        originLocation: origin.friendlyLocation || null,
        originGate: origin.gate || null,
        originTerminal: origin.terminal || null,
        destination: destination.iata || destination.icao || null,
        destinationIcao: destination.icao || null,
        destinationName: destination.friendlyName || null,
        destinationLocation: destination.friendlyLocation || null,
        destinationGate: destination.gate || null,
        destinationTerminal: destination.terminal || null,
        route: (origin.iata && destination.iata) ? `${origin.iata}-${destination.iata}` : null,
        scheduledDate: schedDepUnix ? new Date(schedDepUnix * 1000).toISOString().slice(0, 10) : null,
        scheduledDeparture: unixToIso(schedDepUnix),
        actualDeparture: unixToIso(actualDepUnix),
        scheduledArrival: unixToIso(schedArrUnix),
        actualArrival: unixToIso(actualArrUnix),
        departureDelayMin,
        arrivalDelayMin,
        status,
        statusText: f.flightStatus || null,
        cancelReason: cancelled ? (f.cancellationReason || null) : null,
        aircraft: f.aircraftType || null,
        aircraftName: f.aircraftTypeFriendly || null,
        aircraftTail: f.aircraft?.tail || null,
        duration: f.flightPlan?.ete ? formatDuration(Math.round(f.flightPlan.ete / 60)) : null,
        distanceMiles: f.flightPlan?.directDistance || null,
        flightId: f.flightId || null,
        permaLink: f.permaLink ? `https://flightaware.com${f.permaLink}` : null,
    };
}

function unixToIso(s) {
    if (!s) return null;
    return new Date(s * 1000).toISOString();
}

function formatDuration(mins) {
    if (!Number.isFinite(mins)) return null;
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------- text-based status helpers (route mode) ----------

function normalizeStatusText(raw) {
    if (!raw) return 'unknown';
    const s = raw.toLowerCase();
    if (/cancel/.test(s)) return 'cancelled';
    if (/divert/.test(s)) return 'diverted';
    if (/landed|arrived/.test(s)) return 'landed';
    if (/en route|en-route|in flight|airborne/.test(s)) return 'en-route';
    if (/scheduled/.test(s)) return 'scheduled';
    if (/delayed|late/.test(s)) return 'delayed';
    if (/on time|early/.test(s)) return 'on-time';
    return 'unknown';
}

function parseDelayFromStatus(raw) {
    if (!raw) return null;
    const s = raw.toLowerCase();
    let mins = 0;
    let matched = false;
    const hr = s.match(/(\d+)\s*(?:hr|hour)/);
    if (hr) { mins += parseInt(hr[1], 10) * 60; matched = true; }
    const mn = s.match(/(\d+)\s*min/);
    if (mn) { mins += parseInt(mn[1], 10); matched = true; }
    if (!matched) return null;
    if (/early/.test(s)) return -mins;
    if (/late|delay/.test(s)) return mins;
    return null;
}

function extractCancelReason(raw) {
    if (!raw) return null;
    const m = raw.match(/cancel(?:led|ed)?[\s:-]*(.+)/i);
    return m && m[1] ? m[1].trim() : null;
}

// ---------- input normalization ----------

function cleanList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map((v) => (typeof v === 'string' ? v : v?.value || v?.url || ''))
        .map((v) => String(v).trim())
        .filter(Boolean);
}

function normalizeIdent(raw) {
    let v = String(raw).toUpperCase().replace(/\s+/g, '').trim();
    if (!v) return v;
    const m = v.match(/^([A-Z]{2})(\d+[A-Z]?)$/);
    if (m && IATA_TO_ICAO[m[1]]) {
        return IATA_TO_ICAO[m[1]] + m[2];
    }
    return v;
}

function toIcaoIfUs(code) {
    const c = code.toUpperCase().replace(/\s+/g, '');
    if (c.length === 3 && /^[A-Z]{3}$/.test(c)) return `K${c}`;
    return c;
}

async function dismissConsent(page) {
    const selectors = [
        'button:has-text("Accept")',
        'button:has-text("I Accept")',
        'button:has-text("Agree")',
        '#onetrust-accept-btn-handler',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(400);
                break;
            }
        } catch {}
    }
}

async function isBlocked(page) {
    const url = page.url();
    if (/captcha|challenge|access denied|just a moment|signin/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/captcha|access denied|just a moment|blocked|sign in/i.test(title)) return true;
    return false;
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'flight_status' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}
