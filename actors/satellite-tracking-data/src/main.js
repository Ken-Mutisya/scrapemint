// Satellite Tracking Data: Orbits, Constellations and Launches
//
// What it does
// ------------
// What is in orbit right now, and what each object is actually doing up
// there. The public catalogue publishes raw orbital elements, which are
// precise and unreadable; this turns them into the numbers people ask for:
// how high, how fast, how long an orbit takes, and what kind of orbit it is.
//
//   satellites     one row per object with its orbit worked out
//   constellations one row per group: how many objects, typical altitude
//                  and inclination, and the launch window they span
//
// The computed layer
// ------------------
// The source gives mean motion, eccentricity and inclination. From those this
// derives the semi-major axis, apogee and perigee altitude, orbital period,
// orbit class, launch year from the international designator, and the age of
// the elements themselves, because a position computed from month old
// elements is not a position anyone should rely on.
//
// Pay per event
// -------------
//   satellite_row ($0.003) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 90000;
const SPACING_MS = 1500;
const API = 'https://celestrak.org/NORAD/elements/gp.php';
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';

// Physical constants for the orbit maths.
const MU = 398600.4418; // Earth's gravitational parameter, km^3/s^2
const EARTH_RADIUS_KM = 6378.137;
const GEO_ALTITUDE_KM = 35786;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'satellites',
    group = 'last-30-days',
    names = [],
    noradIds = [],
    orbitClass = 'all',
    minAltitudeKm = 0,
    maxAltitudeKm = 0,
    launchedSince = 0,
    maxElementAgeDays = 0,
    maxResults = 150,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Groups the catalogue publishes, with the ones people actually ask for
// first. Any other group name the source knows also works.
const GROUPS = new Set([
    'last-30-days', 'stations', 'active', 'geo', 'starlink', 'oneweb', 'kuiper',
    'gps-ops', 'galileo', 'glo-ops', 'beidou', 'iridium-NEXT', 'weather', 'noaa',
    'goes', 'resource', 'science', 'cubesat', 'planet', 'spire', 'amateur',
    'visual', 'military', 'radar', 'engineering', 'education', 'gorizont', 'intelsat', 'ses',
]);

const theMode = ['satellites', 'constellations'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'satellites';
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 150));
const wantNames = asList(names).map((s) => s.toUpperCase());
const wantIds = new Set(asList(noradIds).map((s) => Number(String(s).replace(/\D/g, ''))).filter(Boolean));
const wantClass = ['all', 'leo', 'meo', 'geo', 'heo'].includes(String(orbitClass).toLowerCase())
    ? String(orbitClass).toLowerCase() : 'all';
const altFloor = Math.max(0, Number(minAltitudeKm) || 0);
const altCeiling = Math.max(0, Number(maxAltitudeKm) || 0);
const sinceYear = Number(launchedSince) || 0;
const maxAge = Math.max(0, Number(maxElementAgeDays) || 0);

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
        const text = await res.text();
        // A query that matches nothing returns the words "No GP data found"
        // as plain text with a 200 status, not an empty array.
        if (!text.trimStart().startsWith('[') && !text.trimStart().startsWith('{')) {
            return { empty: true, message: clean(text.slice(0, 120)) };
        }
        const json = JSON.parse(text);
        return { records: Array.isArray(json) ? json : [json] };
    } catch (err) {
        if (attempt < 2) { await sleep(2000 * (attempt + 1)); return getJson(url, attempt + 1); }
        log.warning(`request failed: ${url.slice(0, 110)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'satellite_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const push = async (row) => {
    if (emitted >= cap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

// Mean motion is revolutions per DAY. Converting it to radians per second is
// the step everything else depends on: get it wrong and every altitude in the
// output is wrong by a factor nobody will notice until they use it.
function orbitOf(meanMotionRevPerDay, eccentricity) {
    const n = Number(meanMotionRevPerDay);
    const e = Number(eccentricity);
    if (!Number.isFinite(n) || n <= 0) return {};
    const nRadPerSec = (n * 2 * Math.PI) / 86400;
    const semiMajorAxisKm = (MU / (nRadPerSec ** 2)) ** (1 / 3);
    const ecc = Number.isFinite(e) ? e : 0;
    const apogeeKm = semiMajorAxisKm * (1 + ecc) - EARTH_RADIUS_KM;
    const perigeeKm = semiMajorAxisKm * (1 - ecc) - EARTH_RADIUS_KM;
    const periodMinutes = 1440 / n;
    const meanAltitude = (apogeeKm + perigeeKm) / 2;
    let orbitType = 'unknown';
    if (ecc > 0.25) orbitType = 'highly elliptical';
    else if (meanAltitude < 2000) orbitType = 'low earth';
    else if (Math.abs(meanAltitude - GEO_ALTITUDE_KM) < 500) orbitType = 'geostationary';
    else if (meanAltitude < 35786) orbitType = 'medium earth';
    else orbitType = 'high earth';
    return {
        semiMajorAxisKm: round(semiMajorAxisKm, 2),
        apogeeAltitudeKm: round(apogeeKm, 1),
        perigeeAltitudeKm: round(perigeeKm, 1),
        meanAltitudeKm: round(meanAltitude, 1),
        orbitalPeriodMinutes: round(periodMinutes, 2),
        orbitsPerDay: round(n, 4),
        orbitType,
    };
}

// "1998-067A" -> launched 1998, the 67th launch of that year.
function launchOf(objectId) {
    const m = String(objectId ?? '').match(/^(\d{4})-(\d{3})([A-Z]*)$/);
    if (!m) return {};
    return { launchYear: Number(m[1]), launchNumberOfYear: Number(m[2]), launchPiece: m[3] || null };
}

const classify = (t) => {
    if (t === 'low earth') return 'leo';
    if (t === 'medium earth') return 'meo';
    if (t === 'geostationary') return 'geo';
    if (t === 'highly elliptical') return 'heo';
    return 'other';
};

// Inclination tells you what the orbit is for, and these bands are the ones
// operators actually name.
function inclinationClass(deg) {
    const i = Number(deg);
    if (!Number.isFinite(i)) return null;
    if (i < 10) return 'equatorial';
    if (i > 96 && i < 102) return 'sun synchronous';
    if (i >= 80 && i <= 100) return 'polar';
    if (i > 100) return 'retrograde';
    return 'inclined';
}

const requestedGroup = clean(group) || 'last-30-days';
const urls = [];
if (wantIds.size) {
    for (const id of wantIds) urls.push({ label: `catalog ${id}`, url: `${API}?CATNR=${id}&FORMAT=json` });
} else if (wantNames.length && !GROUPS.has(requestedGroup)) {
    for (const n of wantNames) urls.push({ label: `name ${n}`, url: `${API}?NAME=${encodeURIComponent(n)}&FORMAT=json` });
} else {
    urls.push({ label: `group ${requestedGroup}`, url: `${API}?GROUP=${encodeURIComponent(requestedGroup)}&FORMAT=json` });
}

log.info(`Satellite ${theMode} | ${urls.map((u) => u.label).join(', ')}`);

const objects = [];
for (const { label, url } of urls) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
    const res = await getJson(url);
    await sleep(SPACING_MS);
    if (!res) {
        await flushRow({ type: 'note', found: false, requested: label, note: 'the catalogue could not be reached; try again shortly; not charged' }, false);
        continue;
    }
    if (res.empty || !res.records?.length) {
        await flushRow({
            type: 'note', found: false, requested: label, sourceMessage: res.message ?? null,
            note: 'nothing matched; check the group name or catalogue number, for example group starlink, geo, gps-ops or last-30-days; not charged',
        }, false);
        continue;
    }
    objects.push(...res.records);
}
log.info(`${objects.length} object(s) returned`);

const now = Date.now();
let rows = objects.map((o) => {
    const orbit = orbitOf(o.MEAN_MOTION, o.ECCENTRICITY);
    const launch = launchOf(o.OBJECT_ID);
    const epoch = o.EPOCH ? Date.parse(`${o.EPOCH}Z`) : null;
    // Elements age. A position propagated from month old elements can be out
    // by many kilometres, so the age is on every row rather than implied.
    const elementAgeDays = Number.isFinite(epoch) ? round((now - epoch) / 86400000, 2) : null;
    const name = clean(o.OBJECT_NAME);
    return {
        name,
        noradCatalogId: o.NORAD_CAT_ID ?? null,
        internationalDesignator: clean(o.OBJECT_ID),
        ...launch,
        yearsInOrbit: launch.launchYear ? round(new Date().getUTCFullYear() - launch.launchYear, 0) : null,
        // The leading word of the name is how constellations are recognised.
        constellation: name ? name.split(/[\s-]/)[0].toUpperCase() : null,
        ...orbit,
        inclinationDegrees: round(Number(o.INCLINATION), 4),
        inclinationClass: inclinationClass(o.INCLINATION),
        eccentricity: Number(o.ECCENTRICITY) ?? null,
        rightAscensionDegrees: round(Number(o.RA_OF_ASC_NODE), 4),
        argumentOfPerigeeDegrees: round(Number(o.ARG_OF_PERICENTER), 4),
        meanAnomalyDegrees: round(Number(o.MEAN_ANOMALY), 4),
        revolutionAtEpoch: o.REV_AT_EPOCH ?? null,
        // Drag term: larger means more atmospheric drag and a shorter life.
        dragTerm: Number(o.BSTAR) ?? null,
        classification: o.CLASSIFICATION_TYPE === 'U' ? 'unclassified' : clean(o.CLASSIFICATION_TYPE),
        elementEpoch: o.EPOCH ? new Date(epoch).toISOString() : null,
        elementAgeDays,
        elementsStale: elementAgeDays == null ? null : elementAgeDays > 30,
        source: 'CelesTrak',
        scrapedAt: new Date().toISOString(),
    };
});

rows = rows.filter((r) => {
    if (wantIds.size && !wantIds.has(Number(r.noradCatalogId))) return false;
    if (wantNames.length && !wantNames.some((n) => String(r.name || '').toUpperCase().includes(n))) return false;
    if (wantClass !== 'all' && classify(r.orbitType) !== wantClass) return false;
    if (altFloor && (r.meanAltitudeKm == null || r.meanAltitudeKm < altFloor)) return false;
    if (altCeiling && (r.meanAltitudeKm == null || r.meanAltitudeKm > altCeiling)) return false;
    if (sinceYear && (r.launchYear == null || r.launchYear < sinceYear)) return false;
    if (maxAge && (r.elementAgeDays == null || r.elementAgeDays > maxAge)) return false;
    return true;
});

if (theMode === 'constellations') {
    const byName = new Map();
    for (const r of rows) {
        const key = r.constellation || 'unknown';
        if (!byName.has(key)) byName.set(key, { objects: 0, alts: [], incs: [], years: [], periods: [], stale: 0, types: new Map() });
        const c = byName.get(key);
        c.objects += 1;
        if (r.meanAltitudeKm != null) c.alts.push(r.meanAltitudeKm);
        if (r.inclinationDegrees != null) c.incs.push(r.inclinationDegrees);
        if (r.launchYear != null) c.years.push(r.launchYear);
        if (r.orbitalPeriodMinutes != null) c.periods.push(r.orbitalPeriodMinutes);
        if (r.elementsStale) c.stale += 1;
        c.types.set(r.orbitType, (c.types.get(r.orbitType) || 0) + 1);
    }
    const avg = (a) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 1) : null);
    const out = [...byName.entries()].map(([name, c]) => ({
        mode: 'constellations',
        constellation: name,
        objects: c.objects,
        averageAltitudeKm: avg(c.alts),
        lowestAltitudeKm: c.alts.length ? round(Math.min(...c.alts), 1) : null,
        highestAltitudeKm: c.alts.length ? round(Math.max(...c.alts), 1) : null,
        averageInclinationDegrees: avg(c.incs),
        averagePeriodMinutes: avg(c.periods),
        dominantOrbitType: [...c.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        firstLaunchYear: c.years.length ? Math.min(...c.years) : null,
        latestLaunchYear: c.years.length ? Math.max(...c.years) : null,
        objectsWithStaleElements: c.stale,
        group: requestedGroup,
        source: 'CelesTrak',
        scrapedAt: new Date().toISOString(),
    })).sort((a, b) => b.objects - a.objects);
    for (const row of out) { if (!(await push(row))) break; }
} else {
    rows.sort((a, b) => (b.launchYear ?? 0) - (a.launchYear ?? 0) || (a.meanAltitudeKm ?? 0) - (b.meanAltitudeKm ?? 0));
    for (const row of rows) { if (!(await push({ mode: 'satellites', ...row })) ) break; }
}

if (!emitted && !notePushed) {
    await flushRow({
        type: 'note', found: false, objectsReturned: objects.length,
        note: objects.length
            ? 'objects were returned but every one was removed by the filters; widen the altitude range, orbit class or launch year; not charged'
            : 'nothing matched that query; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
