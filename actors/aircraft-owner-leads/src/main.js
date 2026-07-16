// Aircraft Owner Leads: FAA Registration Lookup
//
// Strategy
// --------
// Stream the FAA's daily releasable aircraft registry zip (public, keyless)
// and turn it into owner lead rows without ever holding the 73MB archive in
// memory: fflate's streaming Unzip reads ACFTREF.txt (aircraft make/model
// reference) and ENGINE.txt (engine reference) fully — they are small and
// come before MASTER.txt in the archive — then filters MASTER.txt line by
// line. Two modes: look up specific N-numbers, or pull filtered owner lists
// by state, manufacturer, year, and registrant type. Once the row cap is
// hit the download is aborted, so a default run reads only a few MB.
//
// Pay per event
// -------------
//   aircraft_row ($0.01) charged per owner row pushed. Tail numbers not in
//   the registry produce free note rows. First 2 rows per run are free.

import { Actor, log } from 'apify';
import { Unzip, UnzipInflate } from 'fflate';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const REGISTRY_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';
// registry.faa.gov sits behind Akamai and 403s non-browser user agents.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    nNumbers = [],
    states = [],
    manufacturer,
    yearMin,
    yearMax,
    registrantTypes = [],
    maxRows = 25,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
// The registry stores N-numbers WITHOUT the leading N.
const wantedTails = new Set(asList(nNumbers).map((n) => n.toUpperCase().replace(/^N/, '').replace(/[^A-Z0-9]/g, '')).filter(Boolean));
const lookupMode = wantedTails.size > 0;
const wantedStates = new Set(asList(states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)));
const mfrNeedle = String(manufacturer || '').trim().toUpperCase() || null;
const yMin = Number.isFinite(Number(yearMin)) && yearMin != null ? Number(yearMin) : null;
const yMax = Number.isFinite(Number(yearMax)) && yearMax != null ? Number(yearMax) : null;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 25));

const REGISTRANT_TYPES = {
    1: 'Individual', 2: 'Partnership', 3: 'Corporation', 4: 'Co-owned',
    5: 'Government', 7: 'LLC', 8: 'Non-citizen corporation', 9: 'Non-citizen co-owned',
};
const REGISTRANT_KEYS = {
    individual: '1', partnership: '2', corporation: '3', coowned: '4',
    government: '5', llc: '7', noncitizencorporation: '8', noncitizencoowned: '9',
};
const wantedRegTypes = new Set(asList(registrantTypes)
    .map((t) => REGISTRANT_KEYS[t.toLowerCase().replace(/[^a-z]/g, '')]).filter(Boolean));
const AIRCRAFT_TYPES = {
    1: 'Glider', 2: 'Balloon', 3: 'Blimp/Dirigible', 4: 'Fixed wing single engine',
    5: 'Fixed wing multi engine', 6: 'Rotorcraft', 7: 'Weight-shift-control',
    8: 'Powered parachute', 9: 'Gyroplane', H: 'Hybrid lift', O: 'Other',
};
const ENGINE_TYPES = {
    0: 'None', 1: 'Reciprocating', 2: 'Turbo-prop', 3: 'Turbo-shaft', 4: 'Turbo-jet',
    5: 'Turbo-fan', 6: 'Ramjet', 7: '2 Cycle', 8: '4 Cycle', 9: 'Unknown', 10: 'Electric', 11: 'Rotary',
};

if (!lookupMode && !wantedStates.size && !mfrNeedle && yMin == null && yMax == null && !wantedRegTypes.size) {
    log.warning('No tail numbers and no filters given. Provide nNumbers, or at least one of states / manufacturer / year range / registrantTypes.');
    await Actor.exit();
}

const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const isoDate = (v) => {
    const s = String(v || '').trim();
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

// --- reference maps built from ACFTREF.txt / ENGINE.txt -------------------
const acftRef = new Map(); // MFR MDL CODE -> { mfr, model, seats }
const engRef = new Map(); // ENG MFR MDL -> { mfr, model }

function loadRefFile(name, text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const header = (lines[0] || '').split(',').map((h) => h.trim().toUpperCase());
    const idx = (col) => header.indexOf(col);
    if (name === 'ACFTREF') {
        const [code, mfr, model, seats] = [idx('CODE'), idx('MFR'), idx('MODEL'), idx('NO-SEATS')];
        for (let i = 1; i < lines.length; i++) {
            const f = lines[i].split(',');
            if (f.length < 3) continue;
            acftRef.set(f[code].trim(), { mfr: clean(f[mfr]), model: clean(f[model]), seats: seats >= 0 ? Number(f[seats]) || null : null });
        }
    } else {
        const [code, mfr, model] = [idx('CODE'), idx('MFR'), idx('MODEL')];
        for (let i = 1; i < lines.length; i++) {
            const f = lines[i].split(',');
            if (f.length < 3) continue;
            engRef.set(f[code].trim(), { mfr: clean(f[mfr]), model: clean(f[model]) });
        }
    }
}

// --- MASTER.txt row handling ----------------------------------------------
let masterHeader = null;
let col = {};
const matched = []; // raw field arrays, enriched after streaming ends
const foundTails = new Set();

function handleMasterLine(line) {
    if (!line.trim()) return;
    if (!masterHeader) {
        masterHeader = line.split(',').map((h) => h.trim().toUpperCase());
        col = Object.fromEntries(masterHeader.map((h, i) => [h, i]));
        return;
    }
    if (matched.length >= cap) return;
    const f = line.split(',');
    const tail = (f[col['N-NUMBER']] || '').trim();
    if (!tail) return;
    if (lookupMode) {
        if (!wantedTails.has(tail)) return;
        foundTails.add(tail);
    } else {
        const name = (f[col.NAME] || '').trim();
        if (!name) return;
        if (wantedStates.size && !wantedStates.has((f[col.STATE] || '').trim())) return;
        if (wantedRegTypes.size && !wantedRegTypes.has((f[col['TYPE REGISTRANT']] || '').trim())) return;
        const year = Number((f[col['YEAR MFR']] || '').trim()) || null;
        if (yMin != null && (year == null || year < yMin)) return;
        if (yMax != null && (year == null || year > yMax)) return;
        if (mfrNeedle) {
            const ref = acftRef.get((f[col['MFR MDL CODE']] || '').trim());
            if (!ref?.mfr || !ref.mfr.toUpperCase().includes(mfrNeedle)) return;
        }
    }
    matched.push(f);
}

// --- stream the zip --------------------------------------------------------
log.info(lookupMode
    ? `Looking up ${wantedTails.size} tail number(s) in the FAA registry...`
    : `Scanning the FAA registry${wantedStates.size ? ` for states ${[...wantedStates].join(', ')}` : ''}${mfrNeedle ? `, manufacturer ~ ${mfrNeedle}` : ''}${yMin != null || yMax != null ? `, years ${yMin ?? '...'}-${yMax ?? '...'}` : ''}. Cap ${cap} rows.`);

const res = await fetch(REGISTRY_URL, { headers: { 'User-Agent': UA } });
if (!res.ok || !res.body) throw new Error(`FAA registry download failed: HTTP ${res.status}`);

let refsDone = 0;
let masterFinished = false;
const uz = new Unzip();
uz.register(UnzipInflate);
uz.onfile = (file) => {
    const name = file.name.toUpperCase();
    if (name === 'ACFTREF.TXT' || name === 'ENGINE.TXT') {
        const chunks = [];
        file.ondata = (err, chunk, final) => {
            if (err) { log.warning(`${file.name}: ${err.message}`); return; }
            chunks.push(chunk);
            if (final) {
                loadRefFile(name.startsWith('ACFTREF') ? 'ACFTREF' : 'ENGINE', Buffer.concat(chunks).toString('utf8'));
                refsDone += 1;
            }
        };
        file.start();
    } else if (name === 'MASTER.TXT') {
        // ACFTREF/ENGINE precede MASTER in the FAA archive; the mfr filter
        // depends on that. Loudly degrade rather than silently mismatch.
        if (mfrNeedle && !acftRef.size) log.error('MASTER.txt arrived before ACFTREF.txt; manufacturer filter cannot match. FAA changed the archive layout — report this.');
        let carry = '';
        file.ondata = (err, chunk, final) => {
            if (err) { log.warning(`${file.name}: ${err.message}`); return; }
            const text = carry + Buffer.from(chunk).toString('utf8');
            const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
            carry = final ? '' : lines.pop();
            for (const line of lines) handleMasterLine(line);
            if (final) { if (carry) handleMasterLine(carry); masterFinished = true; }
        };
        file.start();
    }
};

const reader = res.body.getReader();
while (true) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching run timeout; stopping the scan early.'); break; }
    // References loaded and cap reached (or all tails found): stop downloading.
    if (refsDone >= 2 && (matched.length >= cap || (lookupMode && foundTails.size >= wantedTails.size)) ) break;
    if (masterFinished) break;
    const { done, value } = await reader.read();
    if (done) { try { uz.push(new Uint8Array(0), true); } catch { /* already done */ } break; }
    try { uz.push(value, false); } catch (err) { log.warning(`unzip: ${err?.message}`); break; }
}
try { await reader.cancel(); } catch { /* ignore */ }

// --- emit rows --------------------------------------------------------------
let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'aircraft_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

for (const f of matched.slice(0, cap)) {
    const g = (name) => clean(f[col[name]]);
    const ref = acftRef.get(g('MFR MDL CODE') || '') || {};
    const eng = engRef.get(g('ENG MFR MDL') || '') || {};
    await flushRow({
        nNumber: `N${g('N-NUMBER')}`,
        serialNumber: g('SERIAL NUMBER'),
        ownerName: g('NAME'),
        ownerType: REGISTRANT_TYPES[g('TYPE REGISTRANT')] || null,
        street: g('STREET'),
        street2: g('STREET2'),
        city: g('CITY'),
        state: g('STATE'),
        zip: g('ZIP CODE'),
        country: g('COUNTRY'),
        aircraftManufacturer: ref.mfr || null,
        aircraftModel: ref.model || null,
        seats: ref.seats ?? null,
        aircraftType: AIRCRAFT_TYPES[g('TYPE AIRCRAFT')] || null,
        yearManufactured: Number(g('YEAR MFR')) || null,
        engineManufacturer: eng.mfr || null,
        engineModel: eng.model || null,
        engineType: ENGINE_TYPES[g('TYPE ENGINE')] || null,
        airworthinessDate: isoDate(g('AIR WORTH DATE')),
        certIssueDate: isoDate(g('CERT ISSUE DATE')),
        lastActionDate: isoDate(g('LAST ACTION DATE')),
        expirationDate: isoDate(g('EXPIRATION DATE')),
        registrationStatus: g('STATUS CODE'),
        modeSHex: g('MODE S CODE HEX'),
        scrapedAt: new Date().toISOString(),
    });
}

if (lookupMode) {
    for (const tail of wantedTails) {
        if (!foundTails.has(tail)) {
            await flushRow({ nNumber: `N${tail}`, note: 'Not found in the FAA registry (deregistered, reserved, or never assigned).' }, false);
        }
    }
}

log.info(`Done. ${rowsPushed} owner row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
