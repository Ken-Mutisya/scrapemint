// SaaS Outage Monitor: incidents across 134 vendor status pages
//
// Strategy
// --------
// Every vendor publishes its incidents on a public status page. Most run on
// Atlassian Statuspage (or a provider serving the same API), whose
// /api/v2/incidents.json lists the latest 50 incidents with impact, affected
// components and every update. Slack, Google Cloud and AWS run their own
// feeds, read by small adapters below. All of it is plain JSON: no browser,
// no proxy, no key, one request per vendor.
//
// Built to be scheduled. Incidents are normalised to one shape and compared
// with the previous run's state (a named key-value store in the buyer's own
// account), so each run returns only what changed:
//   new        an incident not seen before (on the first run: anything still
//              open, plus anything started inside lookbackHours)
//   escalated  an open incident whose impact rose to major or critical
//   resolved   an incident seen open earlier that is now resolved
// Set onlyChanges=false to get every incident in the window instead, for
// outage history and vendor reliability analysis.
//
// Pay per event
// -------------
//   incident_row        ($0.005) a new minor or no-impact incident
//   major_incident_row  ($0.02)  a new or escalated major or critical incident
//   resolution_row      ($0.005) an incident resolved since the last run
// No per-run free allowance: this is a poller, and a quiet run costs nothing.

import { Actor, log } from 'apify';
import { VENDORS, ALIASES } from './vendors.js';

const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 20;
const IMPACT_RANK = { none: 0, minor: 1, major: 2, critical: 3 };
const STATE_KEY = 'INCIDENT_STATE';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    vendors = [],
    categories = [],
    customStatusPages = [],
    minImpact = 'minor',
    lookbackHours = 24,
    onlyChanges = true,
    includeUpdateText = true,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- Which vendors ----------

const byKey = new Map(VENDORS.map((v) => [v.key, v]));
const picked = new Map();
const unknown = [];
for (const raw of listOf(vendors)) {
    const q = raw.toLowerCase();
    const key = ALIASES[q] || slug(raw);
    const v = byKey.get(key) || VENDORS.find((x) => x.name.toLowerCase() === q);
    if (v) picked.set(v.key, v); else unknown.push(raw);
}
const catList = listOf(categories).map((c) => slug(c));
if (catList.length) for (const v of VENDORS) if (catList.includes(v.category)) picked.set(v.key, v);
for (const raw of listOf(customStatusPages)) {
    let host;
    try { host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { unknown.push(raw); continue; }
    const key = `custom-${slug(host)}`;
    picked.set(key, { key, name: host, category: 'custom', kind: 'statuspage', host });
}
if (!listOf(vendors).length && !catList.length && !listOf(customStatusPages).length) for (const v of VENDORS) picked.set(v.key, v);
if (unknown.length) log.warning(`Not recognised, ignored: ${unknown.join(', ')}. Paste the vendor's status page URL into customStatusPages instead.`);
const targets = [...picked.values()];
if (!targets.length) {
    const cats = [...new Set(VENDORS.map((v) => v.category))].sort();
    await Actor.pushData({
        rowType: 'note',
        note: `No vendor matched. Categories: ${cats.join(', ')}. Vendors: ${VENDORS.map((v) => v.name).sort().join(', ')}. `
            + 'Any Statuspage-powered page can be added through customStatusPages. Not charged.',
    });
    await Actor.exit();
}

const minRank = IMPACT_RANK[minImpact] ?? 1;
const windowStart = Date.now() - Math.max(1, Number(lookbackHours) || 24) * 3600 * 1000;
log.info(`Checking ${targets.length} vendor(s). Impact ${minImpact} and above, window ${lookbackHours}h, ${onlyChanges ? 'changes since last run' : 'every incident in the window'}.`);

// ---------- Fetching ----------

async function get(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScrapemintOutageMonitor/1.0)', Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // AWS serves its feed as UTF-16 with a byte-order mark.
    const text = buf[0] === 0xfe && buf[1] === 0xff ? swapUtf16(buf)
        : buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return JSON.parse(text.replace(/^﻿/, ''));
}

function swapUtf16(buf) {
    const b = Buffer.from(buf);
    b.swap16();
    return b.toString('utf16le');
}

const stripHtml = (s) => (s ? String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : null);
const iso = (t) => { if (t === null || t === undefined || t === '') return null; const d = typeof t === 'number' || /^\d+$/.test(String(t)) ? new Date(Number(t) * 1000) : new Date(t); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// ---------- Adapters: each returns incidents in one shape ----------

async function fromStatuspage(v) {
    const j = await get(`https://${v.host}/api/v2/incidents.json`);
    return (j.incidents || []).map((i) => {
        const upd = (i.incident_updates || [])[0];
        return {
            incidentId: i.id,
            title: i.name,
            status: i.status,
            impact: IMPACT_RANK[i.impact] !== undefined ? i.impact : 'none',
            resolved: i.status === 'resolved' || i.status === 'postmortem' || Boolean(i.resolved_at),
            startedAt: iso(i.started_at || i.created_at),
            resolvedAt: iso(i.resolved_at),
            updatedAt: iso(i.updated_at),
            components: (i.components || []).map((c) => c.name),
            regions: [],
            latestUpdate: stripHtml(upd?.body),
            url: i.shortlink || `https://${v.host}/incidents/${i.id}`,
        };
    });
}

async function fromSlack() {
    const [cur, hist] = await Promise.all([
        get('https://slack-status.com/api/v2.0.0/current'),
        get('https://slack-status.com/api/v2.0.0/history').catch(() => []),
    ]);
    const all = new Map();
    for (const i of [...(Array.isArray(hist) ? hist : []), ...(cur.active_incidents || [])]) all.set(i.id, i);
    return [...all.values()].map((i) => {
        const notes = i.notes || [];
        const last = notes[notes.length - 1];
        const resolved = i.status === 'resolved' || i.status === 'ok';
        return {
            incidentId: String(i.id),
            title: i.title,
            status: i.status,
            impact: i.type === 'outage' ? 'major' : i.type === 'incident' ? 'minor' : 'none',
            resolved,
            startedAt: iso(i.date_created),
            resolvedAt: resolved ? iso(i.date_updated) : null,
            updatedAt: iso(i.date_updated),
            components: i.services || [],
            regions: [],
            latestUpdate: stripHtml(last?.body),
            url: i.url,
        };
    });
}

async function fromGcp() {
    const list = await get('https://status.cloud.google.com/incidents.json');
    return list.slice(0, 100).map((i) => ({
        incidentId: i.id,
        title: stripHtml(i.external_desc),
        status: i.end ? 'resolved' : 'ongoing',
        impact: i.severity === 'high' ? 'major' : i.severity === 'medium' ? 'minor' : 'none',
        resolved: Boolean(i.end),
        startedAt: iso(i.begin),
        resolvedAt: iso(i.end),
        updatedAt: iso(i.modified),
        components: (i.affected_products || []).map((p) => p.title),
        regions: [...(i.currently_affected_locations || []), ...(i.previously_affected_locations || [])].map((l) => l.id),
        latestUpdate: stripHtml(i.most_recent_update?.text),
        url: `https://status.cloud.google.com/${i.uri}`,
    }));
}

// AWS lists only events still on its dashboard, with a numeric status per
// log entry (0 resolved, 1 informational, 2 degraded, 3 disrupted). An event
// that drops off the feed is reported resolved by the state diff.
async function fromAws() {
    const list = await get('https://health.aws.amazon.com/public/currentevents');
    return (Array.isArray(list) ? list : []).map((e) => {
        const logs = e.event_log || [];
        const last = logs[logs.length - 1];
        const s = Number(last?.status ?? e.status);
        return {
            incidentId: e.arn || `${e.service}-${e.date}`,
            title: `${e.service_name || e.service}: ${last?.summary || e.summary || 'service event'}`,
            status: s === 0 ? 'resolved' : s === 3 ? 'disrupted' : s === 2 ? 'degraded' : 'informational',
            impact: s === 3 ? 'major' : s === 2 ? 'minor' : 'none',
            resolved: s === 0,
            startedAt: iso(e.date),
            resolvedAt: s === 0 ? iso(last?.timestamp) : null,
            updatedAt: iso(last?.timestamp ?? e.date),
            components: [e.service_name || e.service].filter(Boolean),
            regions: [e.region_name].filter(Boolean),
            latestUpdate: stripHtml(last?.message),
            url: 'https://health.aws.amazon.com/health/status',
        };
    });
}

const ADAPTERS = { statuspage: fromStatuspage, slack: fromSlack, gcp: fromGcp, aws: fromAws };

// ---------- Run ----------

const store = await Actor.openKeyValueStore('saas-outage-monitor-state');
const prior = (onlyChanges && (await store.getValue(STATE_KEY))) || null;
const firstRun = onlyChanges && !prior;
const state = { ...(prior || {}) };
// Vendors with a baseline. One added later (or unreadable until now) starts
// with a baseline of its own, so its backlog is not billed as new incidents.
const knownVendors = new Set((onlyChanges && (await store.getValue('VENDORS_SEEN'))) || []);
const seenVendors = new Set();
const failed = [];
const rows = [];

async function checkVendor(v) {
    let incidents;
    try {
        incidents = await ADAPTERS[v.kind](v);
    } catch (err) {
        failed.push(`${v.name} (${err?.message})`);
        return;
    }
    seenVendors.add(v.key);
    const liveIds = new Set();
    for (const inc of incidents) {
        const key = `${v.key}:${inc.incidentId}`;
        liveIds.add(key);
        const was = state[key];
        state[key] = { open: !inc.resolved, impact: inc.impact, vendor: v.key, lastSeen: Date.now() };
        const inWindow = inc.startedAt && Date.parse(inc.startedAt) >= windowStart;
        const bigEnough = IMPACT_RANK[inc.impact] >= minRank;
        if (!onlyChanges) {
            if ((inWindow || !inc.resolved) && bigEnough) rows.push(shape(v, inc, 'incident'));
            continue;
        }
        if (!was) {
            if (!bigEnough) continue;
            // Once a vendor has a baseline anything unseen is new. Before that,
            // skip the long tail of old resolved incidents the feed still lists.
            const baseline = knownVendors.has(v.key);
            if (baseline || !inc.resolved || inWindow) rows.push(shape(v, inc, 'new'));
        } else if (was.open && inc.resolved) {
            if (IMPACT_RANK[was.impact] >= minRank || bigEnough) rows.push(shape(v, inc, 'resolved'));
        } else if (was.open && !inc.resolved && IMPACT_RANK[inc.impact] >= 2 && IMPACT_RANK[inc.impact] > IMPACT_RANK[was.impact]) {
            rows.push(shape(v, inc, 'escalated'));
        }
    }
    // AWS drops an event from its feed when it ends; that disappearance is the resolution.
    if (v.kind === 'aws' && onlyChanges) {
        for (const [key, s] of Object.entries(state)) {
            if (s.vendor !== v.key || liveIds.has(key) || !s.open) continue;
            state[key] = { ...s, open: false };
            if (IMPACT_RANK[s.impact] >= minRank) {
                rows.push(shape(v, {
                    incidentId: key.slice(v.key.length + 1), title: 'AWS event no longer listed on the Health Dashboard',
                    status: 'resolved', impact: s.impact, resolved: true, startedAt: null, resolvedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(), components: [], regions: [], latestUpdate: null,
                    url: 'https://health.aws.amazon.com/health/status',
                }, 'resolved'));
            }
        }
    }
}

function shape(v, inc, changeType) {
    const durationMinutes = inc.startedAt && inc.resolvedAt
        ? Math.max(0, Math.round((Date.parse(inc.resolvedAt) - Date.parse(inc.startedAt)) / 60000)) : null;
    return {
        vendor: v.name,
        vendorKey: v.key,
        category: v.category,
        changeType,
        incidentId: inc.incidentId,
        title: inc.title,
        impact: inc.impact,
        status: inc.status,
        isResolved: inc.resolved,
        startedAt: inc.startedAt,
        resolvedAt: inc.resolvedAt,
        durationMinutes,
        lastUpdatedAt: inc.updatedAt,
        affectedComponents: inc.components,
        affectedRegions: inc.regions,
        latestUpdate: includeUpdateText ? (inc.latestUpdate ? inc.latestUpdate.slice(0, 1500) : null) : undefined,
        url: inc.url,
        statusPage: `https://${v.host}/`,
        checkedAt: new Date().toISOString(),
    };
}

let cursor = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) await checkVendor(targets[cursor++]);
}));

// Newest first, the order an alert channel wants.
rows.sort((a, b) => Date.parse(b.lastUpdatedAt || 0) - Date.parse(a.lastUpdatedAt || 0));

let charged = 0;
for (const row of rows) {
    await Actor.pushData(row);
    const event = row.changeType === 'resolved' ? 'resolution_row'
        : IMPACT_RANK[row.impact] >= 2 ? 'major_incident_row' : 'incident_row';
    try {
        const r = await Actor.charge({ eventName: event });
        charged += 1;
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
}

if (onlyChanges) {
    // Keep state bounded: drop resolved incidents not seen for 30 days.
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [k, s] of Object.entries(state)) if (!s.open && s.lastSeen < cutoff) delete state[k];
    await store.setValue(STATE_KEY, state);
    await store.setValue('VENDORS_SEEN', [...new Set([...knownVendors, ...seenVendors])]);
}

// A first run with nothing to report looks broken to someone trying the
// actor. Say why, free. Scheduled quiet runs stay empty so alerts do not fire.
if (!rows.length && (firstRun || !onlyChanges)) {
    await Actor.pushData({
        rowType: 'note',
        note: `No incident at ${minImpact} impact or above across ${seenVendors.size} vendor(s) in the last ${lookbackHours}h. `
            + `${onlyChanges ? 'Baseline saved: scheduled runs will now report new, escalated and resolved incidents as they happen. ' : ''}`
            + 'Lower minImpact or widen lookbackHours to see more. Not charged.',
    });
}

const open = Object.values(state).filter((s) => s.open).length;
await Actor.setValue('SUMMARY', {
    vendorsChecked: seenVendors.size, vendorsFailed: failed, rows: rows.length, charged,
    openIncidentsTracked: onlyChanges ? open : null, firstRun,
});
if (failed.length) log.warning(`Could not read ${failed.length} status page(s): ${failed.slice(0, 10).join('; ')}`);
log.info(`Done. ${seenVendors.size}/${targets.length} vendor(s) read, ${rows.length} row(s), ${charged} charged.${onlyChanges ? ` ${open} open incident(s) tracked.` : ''}`);
await Actor.exit();
