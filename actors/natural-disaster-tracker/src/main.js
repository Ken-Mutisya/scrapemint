// Natural Disaster & Earthquake Tracker
//
// Strategy
// --------
// Two official keyless feeds, normalized into one row shape:
//   - USGS FDSN event API for earthquakes (every quake worldwide, precise
//     magnitude/time filters, tsunami flag, PAGER alert level)
//   - GDACS (UN/EC Global Disaster Alert and Coordination System) for
//     cyclones, floods, volcanoes, droughts, and wildfires with Green/
//     Orange/Red alert levels and severity text
// GDACS also lists earthquakes, but those are SKIPPED to avoid double
// counting: USGS is the earthquake source of record here. With `dedupe` on
// and a schedule, every run returns only events not seen before — a live
// new-disasters feed for risk monitoring.
//
// Pay per event
// -------------
//   disaster_row ($0.005) charged per event row pushed. Quiet windows cost
//   nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const UA = 'NaturalDisasterTracker/1.0 (+https://apify.com/scrapemint/natural-disaster-tracker)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    eventTypes = [],
    minMagnitude = 4.5,
    minAlertLevel = 'green',
    sinceHours = 48,
    includeOngoing = true,
    countries = [],
    maxRows = 50,
    dedupe = false,
} = input;

const TYPES = {
    earthquake: { label: 'Earthquake', gdacs: null }, // USGS only
    cyclone: { label: 'Tropical cyclone', gdacs: 'TC' },
    flood: { label: 'Flood', gdacs: 'FL' },
    volcano: { label: 'Volcanic eruption', gdacs: 'VO' },
    drought: { label: 'Drought', gdacs: 'DR' },
    wildfire: { label: 'Wildfire', gdacs: 'WF' },
};
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const requested = asList(eventTypes).map((t) => t.toLowerCase().replace(/[^a-z]/g, ''));
const typeKeys = requested.length ? requested.filter((t) => TYPES[t]) : Object.keys(TYPES);
const unknown = requested.filter((t) => !TYPES[t]);
if (unknown.length) log.warning(`Unknown event types skipped: ${unknown.join(', ')}. Supported: ${Object.keys(TYPES).join(', ')}.`);
const minMag = Math.max(0, Math.min(9, Number(minMagnitude) ?? 4.5));
const ALERT_RANK = { green: 0, orange: 1, red: 2 };
const minAlert = ALERT_RANK[String(minAlertLevel).toLowerCase()] ?? 0;
const hours = Math.max(1, Math.min(720, Number(sinceHours) || 48));
const sinceMs = Date.now() - hours * 3600000;
const wantedCountries = asList(countries).map((c) => c.toLowerCase());
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 50));

if (!typeKeys.length) {
    log.warning(`No supported event types selected. Supported: ${Object.keys(TYPES).join(', ')}.`);
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('disasters-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-events')) || []) seen.add(String(k));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const iso = (v) => {
    if (v == null) return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const countryOk = (c) => !wantedCountries.length
    || wantedCountries.some((w) => String(c || '').toLowerCase().includes(w));

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'disaster_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Tracking ${typeKeys.join(', ')} | window ${hours}h${typeKeys.includes('earthquake') ? `, min magnitude ${minMag}` : ''}${minAlert ? `, alert >= ${String(minAlertLevel).toLowerCase()}` : ''}${wantedCountries.length ? `, countries ~ ${wantedCountries.join(', ')}` : ''}. Cap ${cap} rows.`);

const rows = [];

// --- USGS earthquakes -------------------------------------------------------
if (typeKeys.includes('earthquake')) {
    const p = new URLSearchParams({
        format: 'geojson',
        starttime: new Date(sinceMs).toISOString(),
        minmagnitude: String(minMag),
        orderby: 'time',
        limit: '2000',
    });
    const d = await getJson(`https://earthquake.usgs.gov/fdsnws/event/1/query?${p.toString()}`);
    for (const f of d?.features || []) {
        const pr = f.properties || {};
        const [lon, lat, depth] = f.geometry?.coordinates || [];
        // PAGER alert (green/yellow/orange/red) exists only for reviewed big quakes.
        const alert = clean(pr.alert);
        if (minAlert > 0 && (ALERT_RANK[alert] ?? -1) < minAlert) continue;
        if (!countryOk(pr.place)) continue;
        rows.push({
            id: `usgs:${f.id}`,
            source: 'USGS',
            eventType: TYPES.earthquake.label,
            title: clean(pr.title),
            alertLevel: alert,
            magnitude: pr.mag ?? null,
            severityText: null,
            country: clean(pr.place),
            latitude: lat ?? null,
            longitude: lon ?? null,
            depthKm: depth ?? null,
            tsunamiWarning: pr.tsunami === 1,
            startedAt: iso(pr.time),
            updatedAt: iso(pr.updated),
            url: clean(pr.url),
        });
    }
    log.info(`USGS: ${rows.length} earthquake(s) in window.`);
}

// --- GDACS other disaster types ---------------------------------------------
const gdacsCodes = typeKeys.map((t) => TYPES[t].gdacs).filter(Boolean);
if (gdacsCodes.length) {
    const d = await getJson(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=${gdacsCodes.join(';')}`);
    const before = rows.length;
    const codeToLabel = Object.fromEntries(Object.values(TYPES).filter((t) => t.gdacs).map((t) => [t.gdacs, t.label]));
    for (const f of d?.features || []) {
        const pr = f.properties || {};
        if (!codeToLabel[pr.eventtype]) continue;
        const alert = clean(pr.alertlevel)?.toLowerCase() || null;
        if ((ALERT_RANK[alert] ?? 0) < minAlert) continue;
        const started = Date.parse(pr.fromdate || '');
        if (!includeOngoing && !(Number.isFinite(started) && started >= sinceMs)) continue;
        if (!countryOk(`${pr.country || ''} ${pr.affectedcountries || ''}`)) continue;
        const [lon, lat] = f.geometry?.coordinates || [];
        rows.push({
            id: `gdacs:${pr.eventtype}:${pr.eventid}`,
            source: 'GDACS',
            eventType: codeToLabel[pr.eventtype],
            title: clean(pr.name) || clean(pr.eventname),
            alertLevel: alert,
            magnitude: null,
            severityText: clean(pr.severitydata?.severitytext),
            country: clean(pr.country),
            latitude: lat ?? null,
            longitude: lon ?? null,
            depthKm: null,
            tsunamiWarning: false,
            startedAt: iso(pr.fromdate),
            updatedAt: iso(pr.datemodified),
            url: clean(pr.url?.report) || clean(typeof pr.url === 'string' ? pr.url : null),
        });
    }
    log.info(`GDACS: ${rows.length - before} event(s) after filters.`);
}

// Newest first, dedupe across runs, cap.
rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
let emitted = 0;
for (const row of rows) {
    if (emitted >= cap) break;
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    await flushRow({ ...row, scrapedAt: new Date().toISOString() });
    emitted += 1;
}

if (seenStore && emitted > 0) {
    await seenStore.setValue('seen-events', [...seen].slice(-200000));
}

log.info(`Done. ${emitted} event row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
