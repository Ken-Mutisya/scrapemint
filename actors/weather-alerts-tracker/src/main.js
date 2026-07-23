// US Weather Alerts & Warnings Tracker
//
// Strategy
// --------
// One official keyless feed: the National Weather Service active-alerts API
// (api.weather.gov/alerts/active). Every live watch, warning, and advisory in
// the US and its marine zones — tornado, flood, winter storm, heat, hurricane,
// air quality and more — with severity, urgency, certainty, affected area,
// onset/expiry times, and the full headline / description / instruction text.
//
// The NWS API rejects two things that shape this actor:
//   1. Requests without a User-Agent header get 403 — we always send one.
//   2. You may pass only ONE geographic selector. `area` (state/marine codes),
//      `point` (lat,lon) and `zone` cannot be combined in a single query, so we
//      apply a precedence: point > zones > states > nationwide, and warn when
//      the caller supplied more than one.
// severity / urgency / event filters DO combine with the geographic selector.
//
// With `dedupe` on and a schedule, every run returns only alerts not seen
// before — a live new-alerts feed for logistics, insurance, agriculture,
// utilities, and event operations.
//
// Pay per event
// -------------
//   alert_row ($0.003) charged per alert row pushed. Quiet windows (no active
//   alerts matching the filter) cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const UA = 'WeatherAlertsTracker/1.0 (+https://apify.com/scrapemint/weather-alerts-tracker)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    states = [],
    point = '',
    zones = [],
    events = [],
    severity = [],
    urgency = [],
    certainty = [],
    status = 'actual',
    maxRows = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const iso = (v) => {
    if (v == null || v === '') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
// Title-case a caller value against a known enum so "severe" matches "Severe".
const canon = (v, allowed) => {
    const low = String(v || '').trim().toLowerCase();
    return allowed.find((a) => a.toLowerCase() === low) || null;
};
const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const URGENCY = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
const CERTAINTY = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'];

const stateList = asList(states).map((s) => s.toUpperCase());
const zoneList = asList(zones).map((z) => z.toUpperCase());
const eventList = asList(events); // exact NWS event names, case-insensitive compared below
const sevList = asList(severity).map((s) => canon(s, SEVERITY)).filter(Boolean);
const urgList = asList(urgency).map((s) => canon(s, URGENCY)).filter(Boolean);
const certList = asList(certainty).map((s) => canon(s, CERTAINTY)).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 50));

// Only one geographic selector is allowed by the API. Pick by precedence.
const pointTrimmed = String(point || '').trim();
const selectors = [pointTrimmed && 'point', zoneList.length && 'zones', stateList.length && 'states'].filter(Boolean);
if (selectors.length > 1) {
    log.warning(`Only one location filter is used per query. Using "${selectors[0]}" and ignoring: ${selectors.slice(1).join(', ')}.`);
}

const params = new URLSearchParams();
params.set('status', String(status || 'actual').toLowerCase());
// NOTE: /alerts/active returns the full active set in one response and does NOT
// accept a `limit` param (400 if sent). We cap client-side via maxRows instead.
if (pointTrimmed) {
    const m = pointTrimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) {
        log.warning(`Point must be "latitude,longitude" e.g. "39.7,-104.9". Got "${pointTrimmed}". Ignoring point.`);
    } else {
        params.set('point', `${m[1]},${m[2]}`);
    }
}
if (!params.has('point')) {
    if (zoneList.length) params.set('zone', zoneList.join(','));
    else if (stateList.length) params.set('area', stateList.join(','));
}
// event / severity / urgency / certainty combine with the geographic selector.
for (const s of sevList) params.append('severity', s);
for (const u of urgList) params.append('urgency', u);
for (const c of certList) params.append('certainty', c);
// event names are matched client-side (the API's event param wants exact strings).
const wantEvents = eventList.map((e) => e.toLowerCase());

const seenStore = dedupe ? await Actor.openKeyValueStore('alerts-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-alerts')) || []) seen.add(String(k));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/geo+json' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 120)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'alert_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// Two-letter state codes from the SAME/UGC geocodes so callers can filter by state downstream.
const statesFromProps = (pr) => {
    const codes = new Set();
    for (const ugc of pr?.geocode?.UGC || []) {
        const s = String(ugc).slice(0, 2);
        if (/^[A-Z]{2}$/.test(s)) codes.add(s);
    }
    return [...codes];
};

const loc = pointTrimmed ? `point ${pointTrimmed}`
    : zoneList.length ? `zones ${zoneList.join(', ')}`
        : stateList.length ? `states ${stateList.join(', ')}`
            : 'nationwide';
log.info(`NWS active alerts: ${loc}${sevList.length ? `, severity ${sevList.join('/')}` : ''}${urgList.length ? `, urgency ${urgList.join('/')}` : ''}${wantEvents.length ? `, events ~ ${eventList.join(', ')}` : ''}. Cap ${cap} rows.`);

const url = `https://api.weather.gov/alerts/active?${params.toString()}`;
let emitted = 0;
let scanned = 0;

const d = await getJson(url);
// Active alerts come back newest-first from NWS; keep that order and cap client-side.
for (const f of d?.features || []) {
    if (emitted >= cap) break;
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const pr = f.properties || {};
    scanned += 1;
    // client-side exact event filter (case-insensitive)
    if (wantEvents.length && !wantEvents.includes(String(pr.event || '').toLowerCase())) continue;
    const id = clean(pr.id) || clean(f.id);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const nwsHeadline = Array.isArray(pr.parameters?.NWSheadline) ? clean(pr.parameters.NWSheadline[0]) : null;
    await flushRow({
        id,
        event: clean(pr.event),
        severity: clean(pr.severity),
        certainty: clean(pr.certainty),
        urgency: clean(pr.urgency),
        status: clean(pr.status),
        messageType: clean(pr.messageType),
        category: clean(pr.category),
        area: clean(pr.areaDesc),
        states: statesFromProps(pr),
        headline: clean(pr.headline),
        nwsHeadline,
        description: clean(pr.description),
        instruction: clean(pr.instruction),
        response: clean(pr.response),
        sent: iso(pr.sent),
        effective: iso(pr.effective),
        onset: iso(pr.onset),
        expires: iso(pr.expires),
        ends: iso(pr.ends),
        senderName: clean(pr.senderName),
        url: clean(f.id) || clean(pr['@id']),
        scrapedAt: new Date().toISOString(),
    });
    emitted += 1;
}

if (seenStore && emitted > 0) {
    await seenStore.setValue('seen-alerts', [...seen].slice(-200000));
}

log.info(`Done. ${emitted} alert row(s) pushed, ${scanned} scanned (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
