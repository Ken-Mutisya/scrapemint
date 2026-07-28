// Internet Outage Alerts: Connectivity Drops by Country and Network
//
// What it does
// ------------
// When a country, a region or a single network loses connectivity, measurement
// systems watching the internet notice traffic falling away from that network's
// own normal level. This reads those alerts and reports what dropped, by how
// much against its own history, and which independent measurement systems saw
// it.
//
//   alerts   one row per outage: the network or country, the operator, how far
//            traffic fell, and which sources corroborate it
//   summary  one row per country or network over the window: an outage score
//            and how many events it saw
//
// Two things the raw feed will do to you
// --------------------------------------
// More than half the entries are RECOVERIES, not outages: an alert at level
// "normal" means connectivity came back. Listing alerts without separating the
// two reports every restoration as an incident. And the same event is reported
// once per measurement system, so a single outage seen by three of them looks
// like three outages. Events are grouped here, and the number of independent
// sources is the best signal of whether something really happened.
//
// Pay per event
// -------------
//   outage_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 60000;
const API = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';
const GROUP_WINDOW_SECONDS = 1800;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'alerts',
    hoursBack = 24,
    entityType = 'all',
    country = '',
    onlyOutages = true,
    minDropPercent = 0,
    minSources = 1,
    groupEvents = true,
    maxResults = 150,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['alerts', 'summary'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'alerts';
const wantType = ['all', 'country', 'region', 'asn', 'geoasn'].includes(String(entityType).toLowerCase())
    ? String(entityType).toLowerCase() : 'all';
const wantCountries = new Set(asList(country).map((s) => s.toUpperCase()));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 150));
const hours = Math.max(1, Math.min(720, Number(hoursBack) || 24));
const dropFloor = Math.max(0, Number(minDropPercent) || 0);
const sourceFloor = Math.max(1, Number(minSources) || 1);

const until = Math.floor(Date.now() / 1000);
const from = until - hours * 3600;

async function getJson(path, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API}/${path}`, { signal: controller.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
        const text = await res.text();
        if (!text.trimStart().startsWith('{')) return null;
        const json = JSON.parse(text);
        if (json.error) { log.warning(`source error: ${clean(json.error)}`); return null; }
        return json;
    } catch (err) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); return getJson(path, attempt + 1); }
        log.warning(`request failed: ${path.slice(0, 100)} (${err?.message})`);
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
        try { await Actor.charge({ eventName: 'outage_row' }); }
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

// What each measurement system actually watches, so a buyer can weigh the
// evidence rather than treating every source as the same kind of proof.
const SOURCES = {
    bgp: 'global routing table visibility',
    'ping-slash24': 'active probing of address blocks',
    'merit-nt': 'traffic to unused address space',
    gtr: 'reported traffic to a large service provider',
};

// An alert at level "normal" is connectivity RETURNING. Treating it as an
// outage reports every restoration as an incident, and more than half of the
// feed is recoveries.
const kindOf = (level) => (String(level).toLowerCase() === 'normal' ? 'recovery' : 'outage');

log.info(`Internet outages ${theMode} | last ${hours}h${wantCountries.size ? ` | ${[...wantCountries].join(', ')}` : ''}`);

if (theMode === 'summary') {
    const type = wantType === 'all' ? 'country' : wantType;
    const json = await getJson(`outages/summary?from=${from}&until=${until}&entityType=${type}&limit=${Math.min(cap, 300)}`);
    const list = json?.data || [];
    if (!list.length) {
        await flushRow({ type: 'note', found: false, note: 'no outage summary was returned for that window; try a longer period; not charged' }, false);
    } else {
        const rows = list.map((e) => {
            const scores = e.scores || {};
            const perSource = Object.entries(scores)
                .filter(([k]) => k !== 'overall')
                .map(([k, v]) => ({ source: k.replace('.median', ''), score: round(v, 2) }));
            return {
                mode: 'summary',
                entityType: clean(e.entity?.type),
                entityCode: clean(e.entity?.code),
                entityName: clean(e.entity?.name),
                organisation: clean(e.entity?.attrs?.org),
                events: e.event_cnt ?? null,
                // The overall score combines the measurement systems; it is
                // comparable between entities but has no unit of its own.
                outageScore: round(scores.overall, 2),
                scoresBySource: perSource,
                windowHours: hours,
                source: 'IODA, Georgia Tech',
                scrapedAt: new Date().toISOString(),
            };
        }).filter((r) => !wantCountries.size || wantCountries.has(String(r.entityCode).toUpperCase()))
            .sort((a, b) => (b.outageScore ?? 0) - (a.outageScore ?? 0));
        for (const row of rows) { if (!(await push(row))) break; }
    }
} else {
    const json = await getJson(`outages/alerts?from=${from}&until=${until}&limit=1000`);
    const alerts = json?.data?.alerts || json?.data || [];
    log.info(`${alerts.length} alert(s) in the window`);

    const shaped = alerts.map((a) => {
        const value = Number(a.value);
        const history = Number(a.historyValue);
        // How far below its own normal level the traffic fell. Computed
        // against the entity's own history, not an absolute threshold, which
        // is what makes a small network's outage comparable to a large one's.
        const dropPercent = Number.isFinite(value) && Number.isFinite(history) && history > 0
            ? round(((history - value) / history) * 100, 1) : null;
        return {
            time: Number.isFinite(Number(a.time)) ? new Date(Number(a.time) * 1000).toISOString() : null,
            timeUnix: Number(a.time) || null,
            entityType: clean(a.entity?.type),
            entityCode: clean(a.entity?.code),
            entityName: clean(a.entity?.name),
            organisation: clean(a.entity?.attrs?.org),
            addressesAffected: Number(a.entity?.attrs?.ip_count) || null,
            countryCode: clean(a.entity?.attrs?.country_code) || (a.entity?.type === 'country' ? clean(a.entity?.code) : null),
            level: clean(a.level),
            eventKind: kindOf(a.level),
            datasource: clean(a.datasource),
            datasourceMeaning: SOURCES[a.datasource] ?? null,
            currentValue: Number.isFinite(value) ? value : null,
            historicalValue: Number.isFinite(history) ? history : null,
            dropPercent,
            method: clean(a.method),
        };
    });

    let rows;
    if (groupEvents) {
        // The same outage is reported once per measurement system. Grouping by
        // entity, kind and a half hour window turns three reports of one event
        // into one event corroborated by three sources.
        const groups = new Map();
        for (const a of shaped) {
            const bucket = a.timeUnix ? Math.floor(a.timeUnix / GROUP_WINDOW_SECONDS) : 'na';
            const key = `${a.entityType}|${a.entityCode}|${a.eventKind}|${bucket}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(a);
        }
        rows = [...groups.values()].map((g) => {
            const first = g[0];
            const drops = g.map((x) => x.dropPercent).filter((v) => v != null);
            return {
                ...first,
                datasource: undefined,
                datasourceMeaning: undefined,
                reportedBySources: [...new Set(g.map((x) => x.datasource).filter(Boolean))],
                sourceCount: new Set(g.map((x) => x.datasource).filter(Boolean)).size,
                largestDropPercent: drops.length ? Math.max(...drops) : null,
                dropPercent: drops.length ? round(drops.reduce((x, y) => x + y, 0) / drops.length, 1) : null,
                firstSeen: g.reduce((m, x) => (!m || (x.time && x.time < m) ? x.time : m), null),
            };
        });
    } else {
        rows = shaped.map((r) => ({ ...r, sourceCount: 1, reportedBySources: [r.datasource].filter(Boolean) }));
    }

    rows = rows.filter((r) => {
        if (onlyOutages && r.eventKind !== 'outage') return false;
        if (wantType !== 'all' && r.entityType !== wantType) return false;
        if (wantCountries.size) {
            const code = String(r.countryCode || r.entityCode || '').toUpperCase();
            if (!wantCountries.has(code)) return false;
        }
        if (dropFloor && (r.dropPercent == null || r.dropPercent < dropFloor)) return false;
        if (sourceFloor > 1 && (r.sourceCount ?? 1) < sourceFloor) return false;
        return true;
    });

    rows.sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0)
        || (b.dropPercent ?? -1) - (a.dropPercent ?? -1)
        || String(b.time).localeCompare(String(a.time)));

    for (const row of rows) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        if (!(await push({ mode: 'alerts', ...row, windowHours: hours, source: 'IODA, Georgia Tech', scrapedAt: new Date().toISOString() }))) break;
    }

    if (!emitted) {
        const outages = shaped.filter((r) => r.eventKind === 'outage').length;
        await flushRow({
            type: 'note', found: false, alertsInWindow: alerts.length, outagesInWindow: outages,
            note: alerts.length
                ? 'alerts were returned but none matched the filters; lower minDropPercent or minSources, widen the country filter, or turn off onlyOutages to include recoveries; not charged'
                : 'no alerts at all in that window, which usually means the internet was quiet rather than that something failed; try a longer period; not charged',
        }, false);
    }
}

if (!emitted && !notePushed) {
    await flushRow({ type: 'note', found: false, note: 'nothing returned; not charged' }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
