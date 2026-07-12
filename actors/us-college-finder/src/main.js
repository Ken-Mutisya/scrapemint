// US College Finder: Filter Schools by Admission Barriers & State
//
// Strategy
// --------
// The US Department of Education publishes College Scorecard, the official
// institution-level dataset covering every Title IV college and university
// (~6,600 rows). It is offered as a keyless ZIP on a stable S3/CloudFront
// bucket, so no API key, browser or proxy is needed.
//
// The file changes about once a year, but downloading (23 MB) and parsing
// (220 MB uncompressed) it on every run would burn compute for no new data.
// So we cache a small pre-parsed copy in a named key-value store, keyed by
// the source file's ETag/Last-Modified. A run re-downloads only when the
// department actually republishes; otherwise it loads the slim cache
// instantly and just filters.
//
// What is NOT here, and why
// -------------------------
// Term start dates (Summer I/II, Fall) and "high-school transcript required"
// are not present in any national dataset. Scorecard omits the IPEDS
// transcript fields entirely and carries no academic calendar. Rather than
// fabricate them, each row links to the school's official site and net-price
// calculator so the exact calendar and document requirements can be read at
// the source. Open-admissions and online-only flags are the honest,
// data-backed proxies for "can I start soon with low barriers".
//
// Pay per event
// -------------
//   institution_row per pushed institution. First 2 rows per run are free.

import { Actor, log } from 'apify';
import { unzipSync } from 'fflate';

const DATA_URL = 'https://ed-public-download.scorecard.network/downloads/Most-Recent-Cohorts-Institution.zip';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 7000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const CACHE_STORE = 'us-college-scorecard-cache';
const CACHE_DATA_KEY = 'institutions';
const CACHE_META_KEY = 'source-meta';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // fall back to cache for 30 days if ETag is unavailable

// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

// Columns we pull out of the ~2,989-column file, by header name.
const WANT = [
    'UNITID', 'OPEID6', 'INSTNM', 'CITY', 'STABBR', 'ZIP', 'INSTURL', 'NPCURL',
    'CONTROL', 'ICLEVEL', 'OPENADMP', 'DISTANCEONLY', 'ADM_RATE', 'UGDS', 'ADMCON7',
];

const CONTROL_LABEL = { 1: 'Public', 2: 'Private nonprofit', 3: 'Private for-profit' };
const CONTROL_TOKEN_TO_LABEL = { 'public': 'Public', 'private-nonprofit': 'Private nonprofit', 'private-forprofit': 'Private for-profit' };
const LEVEL_LABEL = { 1: '4-year', 2: '2-year', 3: 'Less-than-2-year' };
const LEVEL_TOKEN_TO_LABEL = { '4-year': '4-year', '2-year': '2-year', 'less-than-2-year': 'Less-than-2-year' };
// ADMCON7 = admission test scores requirement.
const TEST_LABEL = { 1: 'required', 2: 'recommended', 3: 'not required', 5: 'considered but not required' };
const TEST_NOT_REQUIRED = new Set(['not required', 'considered but not required']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    states = [],
    levels = [],
    controls = [],
    openAdmissionOnly = false,
    onlineOnly = false,
    testNotRequired = false,
    maxAdmissionRate = null,
    keyword = '',
    sortBy = 'name',
    maxRows = 200,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);

const stateSet = new Set(asTokens(states).map((s) => s.toUpperCase()));
const levelLabels = new Set(asTokens(levels).map((t) => LEVEL_TOKEN_TO_LABEL[t]).filter(Boolean));
const controlLabels = new Set(asTokens(controls).map((t) => CONTROL_TOKEN_TO_LABEL[t]).filter(Boolean));
const kw = String(keyword || '').trim().toLowerCase();
const maxRate = (maxAdmissionRate === null || maxAdmissionRate === '') ? null : Number(maxAdmissionRate);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'institution_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// Incremental, quote-aware CSV reader that only materializes the columns we
// want, so we never build ~3,000 strings per row. Feed chunks via push(),
// finish with end(); onRow receives a plain object keyed by WANT names.
function makeReader(wantNames, onRow) {
    const wantSet = new Set(wantNames);
    let header = null;
    let idxToName = null;
    let colIndex = 0;
    let field = '';
    let capture = true;
    let inQuotes = false;
    let afterQuote = false;
    let rec = {};
    let headerRow = [];

    function fieldEnd() {
        if (!header) headerRow.push(field);
        else if (capture) rec[idxToName.get(colIndex)] = field;
        colIndex += 1;
        field = '';
        capture = header ? idxToName.has(colIndex) : true;
    }
    function rowEnd() {
        fieldEnd();
        if (!header) {
            header = headerRow;
            idxToName = new Map();
            header.forEach((name, i) => { if (wantSet.has(name)) idxToName.set(i, name); });
        } else if (rec && rec.INSTNM) {
            onRow(rec);
        }
        colIndex = 0;
        rec = {};
        capture = header ? idxToName.has(0) : true;
    }

    return {
        push(chunk) {
            for (let i = 0; i < chunk.length; i++) {
                const c = chunk[i];
                if (afterQuote) {
                    afterQuote = false;
                    if (c === '"') { if (capture) field += '"'; continue; }
                    inQuotes = false;
                }
                if (inQuotes) {
                    if (c === '"') afterQuote = true;
                    else if (capture) field += c;
                    continue;
                }
                if (c === '"') inQuotes = true;
                else if (c === ',') fieldEnd();
                else if (c === '\n') rowEnd();
                else if (c === '\r') { /* skip */ }
                else if (capture) field += c;
            }
        },
        end() {
            if (field.length || colIndex > 0 || headerRow.length) rowEnd();
        },
    };
}

function normUrl(u) {
    const s = String(u || '').trim();
    if (!s || s.toUpperCase() === 'NULL') return null;
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
function numOrNull(v) {
    const s = String(v || '').trim();
    if (!s || s.toUpperCase() === 'NULL') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function toRecord(r) {
    const openAdmissions = r.OPENADMP === '1' ? true : (r.OPENADMP === '2' ? false : null);
    const online = r.DISTANCEONLY === '1' ? true : (r.DISTANCEONLY === '0' ? false : null);
    return {
        name: r.INSTNM,
        city: r.CITY || null,
        state: (r.STABBR || '').toUpperCase() || null,
        zip: r.ZIP || null,
        level: LEVEL_LABEL[r.ICLEVEL] || null,
        control: CONTROL_LABEL[r.CONTROL] || null,
        openAdmissions,
        onlineOnly: online,
        admissionRate: numOrNull(r.ADM_RATE),
        testScoresRequired: TEST_LABEL[r.ADMCON7] || null,
        undergradSize: numOrNull(r.UGDS),
        website: normUrl(r.INSTURL),
        netPriceCalculator: normUrl(r.NPCURL),
        scorecardUrl: r.UNITID ? `https://collegescorecard.ed.gov/school/?${r.UNITID}` : null,
        unitId: r.UNITID || null,
        opeId: r.OPEID6 || null,
    };
}

function passesFilters(rec) {
    if (stateSet.size && !stateSet.has(rec.state)) return false;
    if (levelLabels.size && !levelLabels.has(rec.level)) return false;
    if (controlLabels.size && !controlLabels.has(rec.control)) return false;
    if (openAdmissionOnly && rec.openAdmissions !== true) return false;
    if (onlineOnly && rec.onlineOnly !== true) return false;
    if (testNotRequired && !TEST_NOT_REQUIRED.has(rec.testScoresRequired)) return false;
    if (maxRate !== null && Number.isFinite(maxRate)) {
        if (rec.admissionRate === null || rec.admissionRate > maxRate) return false;
    }
    if (kw && !String(rec.name || '').toLowerCase().includes(kw)) return false;
    return true;
}

// Fetch the source file's identity (ETag / Last-Modified) without downloading it.
async function fetchSourceTag() {
    try {
        const res = await fetch(DATA_URL, {
            method: 'HEAD',
            headers: { 'user-agent': 'scrapemint-us-college-finder/0.1 (+https://apify.com)' },
        });
        if (!res.ok) return null;
        return res.headers.get('etag') || res.headers.get('last-modified') || null;
    } catch {
        return null;
    }
}

async function downloadAndParse() {
    log.info('Downloading College Scorecard institution file (~23 MB)…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let zipBuf;
    try {
        const res = await fetch(DATA_URL, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-us-college-finder/0.1 (+https://apify.com)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching Scorecard data`);
        zipBuf = new Uint8Array(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
    log.info(`Downloaded ${(zipBuf.length / 1e6).toFixed(1)} MB. Decompressing…`);

    const files = unzipSync(zipBuf);
    zipBuf = null;
    const csvName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.csv'));
    if (!csvName) throw new Error('No CSV found inside Scorecard ZIP');
    const bytes = files[csvName];
    delete files[csvName];
    log.info(`Parsing ${csvName} (${(bytes.length / 1e6).toFixed(0)} MB uncompressed)…`);

    const all = [];
    const reader = makeReader(WANT, (raw) => { all.push(toRecord(raw)); });
    const decoder = new TextDecoder('utf-8');
    const CHUNK = 1 << 20; // 1 MB
    for (let off = 0; off < bytes.length; off += CHUNK) {
        reader.push(decoder.decode(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)), { stream: true }));
    }
    reader.push(decoder.decode());
    reader.end();
    return all;
}

// Load all institutions, from cache when the source has not changed.
async function loadInstitutions() {
    const store = await Actor.openKeyValueStore(CACHE_STORE);
    const sourceTag = await fetchSourceTag();
    const meta = (await store.getValue(CACHE_META_KEY)) || {};
    const fresh = sourceTag
        ? meta.tag === sourceTag
        : (meta.fetchedAt && (Date.now() - meta.fetchedAt) < CACHE_MAX_AGE_MS);

    if (fresh) {
        const cached = await store.getValue(CACHE_DATA_KEY);
        if (Array.isArray(cached) && cached.length) {
            log.info(`Loaded ${cached.length} institutions from cache (source unchanged).`);
            return cached;
        }
    }

    const all = await downloadAndParse();
    await store.setValue(CACHE_DATA_KEY, all);
    await store.setValue(CACHE_META_KEY, { tag: sourceTag, fetchedAt: Date.now() });
    return all;
}

const institutions = await loadInstitutions();
const matches = institutions.filter(passesFilters);
log.info(`Scanned ${institutions.length} institutions; ${matches.length} match the filters.`);

const collator = new Intl.Collator('en');
if (sortBy === 'admissionRate') {
    matches.sort((a, b) => (a.admissionRate ?? Infinity) - (b.admissionRate ?? Infinity) || collator.compare(a.name, b.name));
} else if (sortBy === 'size') {
    matches.sort((a, b) => (b.undergradSize ?? -1) - (a.undergradSize ?? -1) || collator.compare(a.name, b.name));
} else {
    matches.sort((a, b) => collator.compare(String(a.state), String(b.state)) || collator.compare(a.name, b.name));
}

for (const rec of matches) {
    if (rowsPushed >= cap) break;
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
    await flushRow(rec);
}

log.info(`Done. ${rowsPushed} institution(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
