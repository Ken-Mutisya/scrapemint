// Layoff Tracker: WARN Act layoff and closure notices from state labor agencies
//
// Strategy
// --------
// Under the federal WARN Act, an employer planning a plant closing or mass
// layoff must give written notice, usually 60 days ahead, and the state labor
// agency publishes it. There is no national feed: each state publishes in its
// own format (a spreadsheet, an open-data API, a CSV, a Google Sheet, an HTML
// table, a paged database). states.js has one reader per state, all returning
// the same notice shape.
//
// Official, public and keyless: no browser, no proxy. A state that fails on a
// run is reported in the summary and the others still return.
//
// Built for schedules: notices already returned are remembered (per filter
// set, in a named store in the buyer's account), so each run returns only
// new ones.
//
// Pay per event
// -------------
//   warn_notice        ($0.01) a layoff or closure notice
//   major_warn_notice  ($0.03) one affecting 100 or more workers, or a closure
// No per-run free allowance (a poller); a run with no new notices is free.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { STATES } from './states.js';

const MAJOR_WORKERS = 100;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    states = [],
    lookbackDays = 30,
    minEmployees = 0,
    companies = [],
    noticeTypes = [],
    onlyNew = true,
    maxNotices = 500,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const wantStates = listOf(states).map((s) => s.toUpperCase()).filter((s) => STATES[s] || log.warning(`State ${s} is not covered; ignored.`));
const pick = wantStates.length ? wantStates : Object.keys(STATES);
const days = Math.max(1, Math.min(3650, Number(lookbackDays) || 30));
const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const coQ = listOf(companies).map((c) => c.toLowerCase());
const typeQ = new Set(listOf(noticeTypes).map((t) => t.toLowerCase()));
const cap = Math.max(1, Number(maxNotices) || 500);

log.info(`Reading ${pick.map((s) => STATES[s].name).join(', ')} for notices since ${sinceIso}.`);

const results = await Promise.all(pick.map(async (code) => {
    const st = STATES[code];
    try {
        const notices = await st.read(sinceIso);
        return { code, notices };
    } catch (err) {
        log.warning(`${st.name}: ${err?.message}`);
        return { code, error: String(err?.message || err) };
    }
}));

const filterKey = createHash('sha1').update(JSON.stringify({ pick, minEmployees, coQ, typeQ: [...typeQ] })).digest('hex').slice(0, 12);
const store = await Actor.openKeyValueStore('layoff-warn-tracker-state');
const stateName = `SEEN_${filterKey}`;
const seen = new Set((onlyNew && (await store.getValue(stateName))) || []);
const firstRun = onlyNew && seen.size === 0;

const all = [];
const perState = {};
for (const r of results) {
    perState[r.code] = r.error ? { error: r.error } : { notices: 0 };
    for (const n of r.notices || []) {
        // The window runs on when the state received or published the notice,
        // not the date on the letter: California processes some notices weeks
        // after their notice date, and a scheduled run must still see them.
        const when = n.receivedDate || n.noticeDate;
        if (!when || when < sinceIso || !n.company) continue;
        if (minEmployees && (n.employees ?? 0) < minEmployees) continue;
        if (coQ.length && !coQ.some((q) => n.company.toLowerCase().includes(q))) continue;
        if (typeQ.size && !typeQ.has(String(n.type || '').toLowerCase())) continue;
        const key = `${r.code}|${n.company.toLowerCase()}|${when}|${(n.city || n.county || n.address || '').toLowerCase()}|${n.employees ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key); // also collapses a notice a state lists twice
        perState[r.code].notices += 1;
        all.push({ key, state: r.code, n });
    }
}

// Newest first across all states.
all.sort((a, b) => String(b.n.receivedDate || b.n.noticeDate).localeCompare(String(a.n.receivedDate || a.n.noticeDate)));

let pushed = 0;
let charged = 0;
let major = 0;
const returned = [];
for (const { key, state, n } of all) {
    if (pushed >= cap) break;
    const isMajor = (n.employees ?? 0) >= MAJOR_WORKERS || n.type === 'Closure';
    const reasons = [];
    if ((n.employees ?? 0) >= MAJOR_WORKERS) reasons.push(`${n.employees} workers`);
    if (n.type === 'Closure') reasons.push('closure');
    await Actor.pushData({
        company: n.company,
        state,
        stateName: STATES[state].name,
        city: n.city,
        county: n.county,
        address: n.address,
        employeesAffected: n.employees,
        noticeType: n.type,
        permanent: n.permanent,
        noticeTypeAsFiled: n.rawType,
        noticeDate: n.noticeDate,
        receivedDate: n.receivedDate,
        layoffDate: n.effectiveDate,
        daysUntilLayoff: n.effectiveDate ? Math.round((Date.parse(n.effectiveDate) - Date.now()) / 86400000) : null,
        industry: n.industry,
        reason: n.reason,
        major: isMajor,
        majorReasons: reasons,
        noticeUrl: n.noticeUrl,
        source: n.source,
        scrapedAt: new Date().toISOString(),
    });
    pushed += 1;
    if (isMajor) major += 1;
    returned.push(key);
    try {
        const r = await Actor.charge({ eventName: isMajor ? 'major_warn_notice' : 'warn_notice' });
        charged += 1;
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
}

// Only notices actually returned are remembered, so any cut off by maxNotices
// or the cost limit come back on the next run.
if (onlyNew) {
    const prior = (await store.getValue(stateName)) || [];
    await store.setValue(stateName, [...new Set([...prior, ...returned])].slice(-50000));
}

const failed = Object.entries(perState).filter(([, v]) => v.error).map(([k, v]) => `${STATES[k].name}: ${v.error}`);
if (!pushed && (firstRun || !onlyNew)) {
    await Actor.pushData({
        rowType: 'note',
        note: `No WARN notices matched since ${sinceIso} in ${pick.map((s) => STATES[s].name).join(', ')}. `
            + `${failed.length ? `Could not read: ${failed.join('; ')}. ` : ''}Widen lookbackDays or loosen the filters. Not charged.`,
    });
}

await Actor.setValue('SUMMARY', { since: sinceIso, perState, notices: pushed, major, charged, failedStates: failed });
log.info(`Done. ${pushed} notice(s) (${major} major), ${charged} charged. Per state: ${Object.entries(perState).map(([k, v]) => `${k} ${v.error ? 'FAILED' : v.notices}`).join(', ')}.`);
await Actor.exit();
