// Government Bond Yields Worldwide: Yield Curves by Country
//
// What it does
// ------------
// The sovereign yield curve is the price of money in each major economy, and
// every macro trade is priced off the spread between two of them. Each central
// bank or debt office publishes its own curve, in its own format, on its own
// calendar. This reads six of them and returns one comparable table.
//
//   latest    one row per country per maturity at each country's newest
//             published date, with the move since the previous session
//   history   the same rows across a date range
//   spreads   one row per country per date: the 2s10s curve slope, the
//             inversion flag, and the 10 year spread against the US and
//             the euro area measured on the SAME date
//
// Covered: United States, United Kingdom, euro area, Japan, Canada, Australia.
// All keyless, no browser, no proxy.
//
// Distinct from our us-treasury-rates-scraper, which reads one country in
// depth (auctions, bills, TIPS, debt outstanding). This one is cross-country.
//
// Pay per event
// -------------
//   yield_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 30000;
// The Japanese archive file is large, slow, and has been observed to stop
// mid-row. It gets its own budget and is never allowed to hold up a run.
const ARCHIVE_TIMEOUT_MS = 45000;
const SPACING_MS = 300;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'latest',
    countries = ['US', 'GB', 'EA', 'JP', 'CA', 'AU'],
    maturities = [],
    daysBack = 10,
    startDate = '',
    endDate = '',
    includePolicyRate = false,
    includeRealYields = false,
    maxRows = 300,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An empty cell is a missing publication, never a zero. Every source in this
// actor has at least one place where a blank, a dash or a placeholder shows up
// in an otherwise complete row, and Number('') === 0 would print it as a real
// yield of zero percent.
const numOrNull = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '-' || s === '--' || s === 'N/A' || s === 'ND') return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const normDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);

const theMode = ['latest', 'history', 'spreads'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'latest';
const back = Math.max(1, Math.min(3650, Number(daysBack) || 10));
const to = normDay(endDate) || isoDay(new Date());
const from = normDay(startDate) || isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - back * 86400000));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 300));

// Country aliases so a buyer can type either the code or the name.
const COUNTRY_ALIASES = {
    US: 'US', USA: 'US', 'UNITED STATES': 'US', AMERICA: 'US', TREASURY: 'US', TREASURIES: 'US',
    GB: 'GB', UK: 'GB', 'UNITED KINGDOM': 'GB', BRITAIN: 'GB', GILTS: 'GB', ENGLAND: 'GB',
    EA: 'EA', EU: 'EA', 'EURO AREA': 'EA', EUROZONE: 'EA', EUR: 'EA', GERMANY: 'EA', BUND: 'EA',
    JP: 'JP', JAPAN: 'JP', JGB: 'JP',
    CA: 'CA', CANADA: 'CA', CAN: 'CA',
    AU: 'AU', AUSTRALIA: 'AU', AUS: 'AU',
};

const COUNTRY_META = {
    US: {
        name: 'United States',
        curveType: 'par yield',
        sourceName: 'US Department of the Treasury',
        sourceUrl: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    },
    GB: {
        name: 'United Kingdom',
        curveType: 'nominal par yield',
        sourceName: 'Bank of England (IADB)',
        sourceUrl: 'https://www.bankofengland.co.uk/boeapps/database',
    },
    EA: {
        name: 'Euro area',
        curveType: 'zero coupon spot rate, AAA-rated euro area central government bonds',
        sourceName: 'European Central Bank Data Portal',
        sourceUrl: 'https://data.ecb.europa.eu/data/datasets/YC',
    },
    JP: {
        name: 'Japan',
        curveType: 'compound yield',
        sourceName: 'Japan Ministry of Finance',
        sourceUrl: 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/',
    },
    CA: {
        name: 'Canada',
        curveType: 'benchmark bond yield',
        sourceName: 'Bank of Canada (Valet)',
        sourceUrl: 'https://www.bankofcanada.ca/valet/',
    },
    AU: {
        name: 'Australia',
        curveType: 'interpolated bond yield',
        sourceName: 'Reserve Bank of Australia (table F2)',
        sourceUrl: 'https://www.rba.gov.au/statistics/tables/',
    },
};

const wantCountries = (() => {
    const raw = asList(countries);
    const out = [];
    const unknown = [];
    for (const r of raw) {
        const code = COUNTRY_ALIASES[r.toUpperCase()];
        if (code) { if (!out.includes(code)) out.push(code); } else unknown.push(r);
    }
    return { codes: out.length ? out : Object.keys(COUNTRY_META), unknown };
})();

const wantMaturities = new Set(asList(maturities).map((s) => s.toUpperCase().replace(/\s+/g, '')));
const matchesMaturity = (label) => !wantMaturities.size || wantMaturities.has(String(label).toUpperCase());

// Maturity labels are normalised to a common vocabulary (3M, 2Y, 10Y) and to a
// number of years, so that a US 10 year and a Japanese 10 year sort and
// compare as the same point on the curve.
const yearsOf = (label) => {
    const s = String(label).toUpperCase();
    const m = /^(\d+(?:\.\d+)?)(M|Y)$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'M' ? round(n / 12, 4) : n;
};

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'yield_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

async function fetchText(url, { attempt = 0, timeout = FETCH_TIMEOUT_MS, accept = '*/*' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { accept, 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return { ok: false, status: res.status, body: null };
        return { ok: true, status: res.status, body: await res.text() };
    } catch (err) {
        if (attempt < 2) {
            await sleep(800 * (attempt + 1));
            return fetchText(url, { attempt: attempt + 1, timeout, accept });
        }
        log.warning(`fetch failed: ${url.slice(0, 120)} (${err?.message})`);
        return { ok: false, status: 0, body: null, error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// Each fetcher returns { rows, error } where a row is
// { countryCode, date, maturityLabel, yieldPercent, kind }.
// kind: nominal | real | policy_rate. Real yields are inflation linked and are
// never mixed into a nominal curve or a spread.

// ---------------------------------------------------------------- United States
const US_FIELDS = {
    BC_1MONTH: '1M', BC_1_5MONTH: '1.5M', BC_2MONTH: '2M', BC_3MONTH: '3M',
    BC_4MONTH: '4M', BC_6MONTH: '6M', BC_1YEAR: '1Y', BC_2YEAR: '2Y',
    BC_3YEAR: '3Y', BC_5YEAR: '5Y', BC_7YEAR: '7Y', BC_10YEAR: '10Y',
    BC_20YEAR: '20Y', BC_30YEAR: '30Y',
};

async function fetchUS(fromDay, toDay) {
    const rows = [];
    const start = new Date(`${fromDay}T00:00:00Z`);
    const end = new Date(`${toDay}T00:00:00Z`);
    // The feed is served a month or a year at a time, and a request takes
    // about ten seconds either way. A single month is the cheaper payload for
    // a short window, but pulling years month by month would spend the whole
    // run budget on one country, so anything longer than a month asks for
    // whole years instead.
    const months = [];
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end && months.length < 600) {
        months.push(`${cur.getUTCFullYear()}${pad(cur.getUTCMonth() + 1)}`);
        cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    const params = months.length > 2
        ? [...new Set(months.map((m) => m.slice(0, 4)))].map((y) => `field_tdr_date_value=${y}`)
        : months.map((m) => `field_tdr_date_value_month=${m}`);

    let lastError = null;
    for (const param of params) {
        if (pastDeadline()) break;
        const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml'
            + `?data=daily_treasury_yield_curve&${param}`;
        const res = await fetchText(url, { accept: 'application/atom+xml' });
        if (!res.ok || !res.body) { lastError = res.error || `HTTP ${res.status}`; continue; }
        // The feed is an Atom document; one entry per publication day.
        for (const entry of res.body.split('<entry>').slice(1)) {
            const dateMatch = /<d:NEW_DATE[^>]*>([^<]+)</.exec(entry);
            if (!dateMatch) continue;
            const date = dateMatch[1].slice(0, 10);
            if (date < fromDay || date > toDay) continue;
            for (const [field, label] of Object.entries(US_FIELDS)) {
                const m = new RegExp(`<d:${field}[^>]*>([^<]*)<`).exec(entry);
                const value = m ? numOrNull(m[1]) : null;
                if (value == null) continue;
                rows.push({ countryCode: 'US', date, maturityLabel: label, yieldPercent: value, kind: 'nominal' });
            }
        }
        await sleep(SPACING_MS);
    }
    return { rows, error: rows.length ? null : lastError };
}

// -------------------------------------------------------------- United Kingdom
// Par yields are published at three points only (5, 10 and 20 years); there is
// no 2 year gilt series in this database, so the UK curve slope is reported
// where it can be computed and left null where it cannot.
const GB_SERIES = {
    IUDSNPY: { label: '5Y', kind: 'nominal' },
    IUDMNPY: { label: '10Y', kind: 'nominal' },
    IUDLNPY: { label: '20Y', kind: 'nominal' },
    IUDBEDR: { label: 'policy', kind: 'policy_rate' },
};

const GB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const gbDate = (iso) => {
    const [y, m, d] = iso.split('-');
    return `${d}/${GB_MONTHS[Number(m) - 1]}/${y}`;
};

async function fetchGB(fromDay, toDay) {
    const codes = Object.keys(GB_SERIES).join(',');
    const url = 'https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes'
        + `&Datefrom=${encodeURIComponent(gbDate(fromDay))}&Dateto=${encodeURIComponent(gbDate(toDay))}`
        + `&SeriesCodes=${codes}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
    const res = await fetchText(url, { accept: 'text/csv' });
    if (!res.ok || !res.body || !/^DATE/i.test(res.body.trim())) {
        return { rows: [], error: res.error || `unexpected response (HTTP ${res.status})` };
    }
    const lines = res.body.trim().split(/\r?\n/);
    const header = lines[0].split(',').map((s) => s.trim());
    const rows = [];
    for (const line of lines.slice(1)) {
        const cells = line.split(',');
        const date = parseGbDay(cells[0]);
        if (!date) continue;
        for (let i = 1; i < header.length; i += 1) {
            const meta = GB_SERIES[header[i]];
            if (!meta) continue;
            // The newest row typically carries Bank Rate with every yield cell
            // still empty: the policy rate is known intraday, the curve is
            // published the following morning.
            const value = numOrNull(cells[i]);
            if (value == null) continue;
            rows.push({ countryCode: 'GB', date, maturityLabel: meta.label, yieldPercent: value, kind: meta.kind });
        }
    }
    return { rows, error: rows.length ? null : 'no gilt observations in range' };
}

function parseGbDay(s) {
    const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const month = GB_MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (month < 0) return null;
    return `${m[3]}-${pad(month + 1)}-${pad(Number(m[1]))}`;
}

// ------------------------------------------------------------------- Euro area
const EA_KEYS = {
    SR_3M: '3M', SR_6M: '6M', SR_1Y: '1Y', SR_2Y: '2Y', SR_3Y: '3Y', SR_5Y: '5Y',
    SR_7Y: '7Y', SR_10Y: '10Y', SR_15Y: '15Y', SR_20Y: '20Y', SR_30Y: '30Y',
};

async function fetchEA(fromDay, toDay) {
    const keys = Object.keys(EA_KEYS).join('+');
    const url = `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.${keys}`
        + `?startPeriod=${fromDay}&endPeriod=${toDay}&format=jsondata`;
    const res = await fetchText(url, { accept: 'application/json' });
    if (!res.ok || !res.body) return { rows: [], error: res.error || `HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(res.body); }
    catch { return { rows: [], error: 'response was not JSON' }; }

    const seriesDims = data?.structure?.dimensions?.series || [];
    const obsDims = data?.structure?.dimensions?.observation || [];
    const dataTypeDim = seriesDims.findIndex((d) => d.id === 'DATA_TYPE_FM');
    const periods = (obsDims.find((d) => d.id === 'TIME_PERIOD')?.values || []).map((v) => v.id);
    const series = data?.dataSets?.[0]?.series || {};
    if (dataTypeDim < 0 || !periods.length) return { rows: [], error: 'unexpected response shape' };

    // A series key such as "0:0:0:0:0:0:3" is a list of POSITIONS into the
    // dimension value lists, and the values come back sorted by the source,
    // not in the order the maturities were requested. Reading them in request
    // order silently labels the 2 year number as a 10 year yield.
    const maturityValues = (seriesDims[dataTypeDim]?.values || []).map((v) => v.id);
    const rows = [];
    for (const [key, payload] of Object.entries(series)) {
        const idx = Number(key.split(':')[dataTypeDim]);
        const label = EA_KEYS[maturityValues[idx]];
        if (!label) continue;
        for (const [obsIdx, obsValue] of Object.entries(payload.observations || {})) {
            const date = periods[Number(obsIdx)];
            const value = numOrNull(Array.isArray(obsValue) ? obsValue[0] : obsValue);
            if (!date || value == null) continue;
            rows.push({ countryCode: 'EA', date, maturityLabel: label, yieldPercent: value, kind: 'nominal' });
        }
    }
    return { rows, error: rows.length ? null : 'no euro area observations in range' };
}

// ----------------------------------------------------------------------- Japan
const JP_ARCHIVE = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv';
const JP_CURRENT = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv';

function parseJpCsv(body) {
    const rows = [];
    const lines = String(body || '').split(/\r?\n/);
    let header = null;
    for (const line of lines) {
        const cells = line.split(',');
        if (/^Date$/i.test(String(cells[0]).trim())) { header = cells.map((s) => s.trim()); continue; }
        if (!header) continue;
        // Dates are unpadded and slash separated: 2026/7/1.
        const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(cells[0]).trim());
        if (!m) continue;
        const date = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
        for (let i = 1; i < header.length; i += 1) {
            const label = header[i];
            if (!/^\d+Y$/i.test(label)) continue;
            // Maturities the ministry did not price that day carry a dash.
            const value = numOrNull(cells[i]);
            if (value == null) continue;
            rows.push({ countryCode: 'JP', date, maturityLabel: label.toUpperCase(), yieldPercent: value, kind: 'nominal' });
        }
    }
    return rows;
}

async function fetchJP(fromDay, toDay) {
    const res = await fetchText(JP_CURRENT, { accept: 'text/csv' });
    let rows = res.ok && res.body ? parseJpCsv(res.body) : [];
    let archiveNote = null;

    // The current file holds this month only. Anything older needs the
    // archive, which is slow and has been observed to stop mid-row, so it is
    // best effort: whatever parses is used, and the gap is reported rather
    // than silently returned as a short series.
    const needArchive = rows.length === 0 || fromDay < (rows.map((r) => r.date).sort()[0] || '9999');
    if (needArchive && !pastDeadline()) {
        const arch = await fetchText(JP_ARCHIVE, { accept: 'text/csv', timeout: ARCHIVE_TIMEOUT_MS, attempt: 1 });
        if (arch.ok && arch.body) {
            const archRows = parseJpCsv(arch.body);
            const seen = new Set(rows.map((r) => `${r.date}|${r.maturityLabel}`));
            for (const r of archRows) {
                if (!seen.has(`${r.date}|${r.maturityLabel}`)) rows.push(r);
            }
            const oldest = archRows.length ? archRows.map((r) => r.date).sort()[0] : null;
            const newestArchive = archRows.length ? archRows.map((r) => r.date).sort().pop() : null;
            archiveNote = `archive covers ${oldest} to ${newestArchive}`;
        } else {
            archiveNote = 'the ministry archive file did not load in time; only the current month is covered';
        }
    }
    const inRange = rows.filter((r) => r.date >= fromDay && r.date <= toDay);
    return {
        rows: inRange,
        error: inRange.length ? null : (archiveNote || 'no Japanese observations in range'),
        info: archiveNote,
    };
}

// ---------------------------------------------------------------------- Canada
// RRB is a real return (inflation linked) bond and LONG has no fixed maturity.
// Both sit in the same published group as the nominal benchmarks.
const CA_SERIES = {
    'BD.CDN.2YR.DQ.YLD': { label: '2Y', kind: 'nominal' },
    'BD.CDN.3YR.DQ.YLD': { label: '3Y', kind: 'nominal' },
    'BD.CDN.5YR.DQ.YLD': { label: '5Y', kind: 'nominal' },
    'BD.CDN.7YR.DQ.YLD': { label: '7Y', kind: 'nominal' },
    'BD.CDN.10YR.DQ.YLD': { label: '10Y', kind: 'nominal' },
    'BD.CDN.LONG.DQ.YLD': { label: 'LONG', kind: 'nominal' },
    'BD.CDN.RRB.DQ.YLD': { label: 'REAL', kind: 'real' },
};

async function fetchCA(fromDay, toDay) {
    const url = 'https://www.bankofcanada.ca/valet/observations/group/bond_yields_benchmark/json'
        + `?start_date=${fromDay}&end_date=${toDay}`;
    const res = await fetchText(url, { accept: 'application/json' });
    if (!res.ok || !res.body) return { rows: [], error: res.error || `HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(res.body); }
    catch { return { rows: [], error: 'response was not JSON' }; }
    const rows = [];
    for (const obs of data?.observations || []) {
        const date = normDay(obs.d);
        if (!date) continue;
        for (const [code, meta] of Object.entries(CA_SERIES)) {
            const value = numOrNull(obs[code]?.v);
            if (value == null) continue;
            rows.push({ countryCode: 'CA', date, maturityLabel: meta.label, yieldPercent: value, kind: meta.kind });
        }
    }
    return { rows, error: rows.length ? null : 'no Canadian observations in range' };
}

// ------------------------------------------------------------------- Australia
const AU_SERIES = {
    FCMYGBAG2D: { label: '2Y', kind: 'nominal' },
    FCMYGBAG3D: { label: '3Y', kind: 'nominal' },
    FCMYGBAG5D: { label: '5Y', kind: 'nominal' },
    FCMYGBAG10D: { label: '10Y', kind: 'nominal' },
    FCMYGBAGID: { label: 'REAL', kind: 'real' },
};

async function fetchAU(fromDay, toDay) {
    const res = await fetchText('https://www.rba.gov.au/statistics/tables/csv/f2-data.csv', { accept: 'text/csv' });
    if (!res.ok || !res.body) return { rows: [], error: res.error || `HTTP ${res.status}` };
    // The file opens with a byte order mark and a block of metadata rows. The
    // data section starts after the row labelled "Series ID", which is also
    // the row that names the columns.
    const lines = res.body.replace(/^﻿/, '').split(/\r?\n/);
    const idIdx = lines.findIndex((l) => /^Series ID,/i.test(l.trim()));
    if (idIdx < 0) return { rows: [], error: 'could not find the series identifier row' };
    const header = lines[idIdx].split(',').map((s) => s.trim());
    const rows = [];
    for (const line of lines.slice(idIdx + 1)) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        const date = parseAuDay(cells[0]);
        if (!date || date < fromDay || date > toDay) continue;
        for (let i = 1; i < header.length; i += 1) {
            const meta = AU_SERIES[header[i]];
            if (!meta) continue;
            const value = numOrNull(cells[i]);
            if (value == null) continue;
            rows.push({ countryCode: 'AU', date, maturityLabel: meta.label, yieldPercent: value, kind: meta.kind });
        }
    }
    return { rows, error: rows.length ? null : 'no Australian observations in range' };
}

function parseAuDay(s) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const month = GB_MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (month < 0) return null;
    return `${m[3]}-${pad(month + 1)}-${pad(Number(m[1]))}`;
}

const FETCHERS = { US: fetchUS, GB: fetchGB, EA: fetchEA, JP: fetchJP, CA: fetchCA, AU: fetchAU };

// ------------------------------------------------------------------------ run
log.info(`Bond yields ${theMode} | ${wantCountries.codes.join(',')} | ${from} to ${to}`);
if (wantCountries.unknown.length) {
    await note({
        unknownCountries: wantCountries.unknown,
        note: `not a covered country: ${wantCountries.unknown.join(', ')}; covered codes are US, GB, EA, JP, CA, AU; not charged`,
    });
}

const collected = new Map();   // countryCode -> rows
const problems = [];
// The spread columns are the whole point of spreads mode, so the two
// reference curves are always fetched even when they were not asked for.
// They are used for comparison only and never billed as rows of their own.
const REFERENCE_CODES = ['US', 'EA'];
const fetchCodes = theMode === 'spreads'
    ? [...new Set([...wantCountries.codes, ...REFERENCE_CODES])]
    : wantCountries.codes;
const referenceOnly = new Set(fetchCodes.filter((c) => !wantCountries.codes.includes(c)));

for (const code of fetchCodes) {
    if (pastDeadline()) { problems.push({ code, error: 'run deadline reached before this country was fetched' }); continue; }
    const started = Date.now();
    let result;
    try { result = await FETCHERS[code](from, to); }
    catch (err) { result = { rows: [], error: err?.message || 'fetch threw' }; }
    const rows = (result.rows || []).filter((r) => {
        if (r.kind === 'policy_rate' && !includePolicyRate) return false;
        if (r.kind === 'real' && !includeRealYields) return false;
        return true;
    });
    collected.set(code, rows);
    log.info(`${code}: ${rows.length} observation(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`
        + `${result.error ? ` (${result.error})` : ''}`);
    if (!rows.length) problems.push({ code, error: result.error || 'no observations returned' });
    await sleep(SPACING_MS);
}

// A previous close per country and maturity, so every row can carry the move.
function seriesIndex(rows) {
    const byKey = new Map();
    for (const r of rows) {
        const key = `${r.countryCode}|${r.maturityLabel}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(r);
    }
    for (const list of byKey.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    return byKey;
}

const allRows = [...collected.values()].flat();
const index = seriesIndex(allRows);
const changeFor = (row) => {
    const list = index.get(`${row.countryCode}|${row.maturityLabel}`) || [];
    const pos = list.findIndex((r) => r.date === row.date);
    if (pos <= 0) return { changeBp: null, previousDate: null, previousYield: null };
    const prev = list[pos - 1];
    return {
        changeBp: round((row.yieldPercent - prev.yieldPercent) * 100, 1),
        previousDate: prev.date,
        previousYield: prev.yieldPercent,
    };
};

const todayIso = isoDay(new Date());
// How far behind today a country's newest figure is. Australia's table runs
// several business days late, so a "latest" curve is not the same age in every
// country and a buyer comparing them should be able to see that.
const lagDays = (date) => Math.max(0, Math.round(
    (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000,
));

const shapeRow = (row, latestDate) => {
    const meta = COUNTRY_META[row.countryCode];
    const change = changeFor(row);
    return {
        mode: theMode,
        country: meta.name,
        countryCode: row.countryCode,
        date: row.date,
        maturityLabel: row.maturityLabel,
        maturityYears: yearsOf(row.maturityLabel),
        yieldPercent: round(row.yieldPercent, 4),
        kind: row.kind,
        curveType: row.kind === 'policy_rate' ? 'central bank policy rate' : meta.curveType,
        changeFromPreviousBasisPoints: change.changeBp,
        previousDate: change.previousDate,
        previousYieldPercent: change.previousYield != null ? round(change.previousYield, 4) : null,
        isLatestAvailable: row.date === latestDate,
        publicationLagDays: lagDays(row.date),
        sourceName: meta.sourceName,
        sourceUrl: meta.sourceUrl,
        scrapedAt: new Date().toISOString(),
    };
};

const sortKey = (r) => [r.date, r.countryCode, String(yearsOf(r.maturityLabel) ?? 99).padStart(8, '0')].join('|');

if (theMode === 'latest' || theMode === 'history') {
    const out = [];
    for (const [code, rows] of collected) {
        if (!rows.length) continue;
        // The newest published date is the newest date with an actual YIELD on
        // it. The Bank of England posts Bank Rate for today while today's gilt
        // cells are still empty, so ranking on every row would make the latest
        // curve one policy rate and nothing else.
        const yieldDates = rows.filter((r) => r.kind !== 'policy_rate').map((r) => r.date);
        const latestDate = (yieldDates.length ? yieldDates : rows.map((r) => r.date)).sort().pop();
        const wanted = theMode === 'latest' ? rows.filter((r) => r.date === latestDate) : rows;
        for (const r of wanted) {
            if (!matchesMaturity(r.maturityLabel)) continue;
            out.push(shapeRow(r, latestDate));
        }
        if (theMode === 'latest') {
            log.info(`${code}: latest published ${latestDate}`);
        }
    }
    out.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    for (const row of out) {
        if (emitted >= rowCap || pastDeadline()) break;
        await push(row);
    }
    if (!out.length && wantMaturities.size) {
        await note({
            requestedMaturities: [...wantMaturities],
            note: 'no rows matched the requested maturities; each country publishes its own set of points, for example the United Kingdom has no 2 year series and Japan has no maturity under 1 year; not charged',
        });
    }
} else {
    // spreads: cross-country comparison, joined on an identical date.
    const byCountryDate = new Map();
    for (const r of allRows) {
        if (r.kind !== 'nominal') continue;
        const key = `${r.countryCode}|${r.date}`;
        if (!byCountryDate.has(key)) byCountryDate.set(key, {});
        byCountryDate.get(key)[r.maturityLabel] = r.yieldPercent;
    }
    const tenYear = new Map();  // date -> { code -> yield }
    for (const [key, points] of byCountryDate) {
        const [code, date] = key.split('|');
        if (points['10Y'] == null) continue;
        if (!tenYear.has(date)) tenYear.set(date, {});
        tenYear.get(date)[code] = points['10Y'];
    }

    const rows = [];
    for (const [key, points] of byCountryDate) {
        const [code, date] = key.split('|');
        if (referenceOnly.has(code)) continue;
        const meta = COUNTRY_META[code];
        const y2 = points['2Y'] ?? null;
        const y10 = points['10Y'] ?? null;
        // A date where a country published nothing at the points reported here
        // would be a row of empty columns, so it is skipped rather than billed.
        if ([y2, y10, points['5Y'], points['20Y'], points['30Y']].every((v) => v == null)) continue;
        const peers = tenYear.get(date) || {};
        // Publication calendars differ: national holidays do not line up, and
        // Australia's table runs several days behind. Measuring a spread
        // between two different dates invents a move that never happened, so
        // a peer that did not publish on this date gives a null and a reason.
        const usTen = peers.US ?? null;
        const eaTen = peers.EA ?? null;
        const prevTen = y10 != null
            ? changeFor({ countryCode: code, maturityLabel: '10Y', date, yieldPercent: y10 })
            : { changeBp: null };
        rows.push({
            mode: 'spreads',
            country: meta.name,
            countryCode: code,
            date,
            yield2YPercent: y2 != null ? round(y2, 4) : null,
            yield5YPercent: points['5Y'] != null ? round(points['5Y'], 4) : null,
            yield10YPercent: y10 != null ? round(y10, 4) : null,
            // The gilt curve's long end is published at 20 years, not 30.
            yield20YPercent: points['20Y'] != null ? round(points['20Y'], 4) : null,
            yield30YPercent: points['30Y'] != null ? round(points['30Y'], 4) : null,
            publicationLagDays: lagDays(date),
            change10YBasisPoints: prevTen.changeBp,
            slope2s10sBasisPoints: y2 != null && y10 != null ? round((y10 - y2) * 100, 1) : null,
            curveInverted: y2 != null && y10 != null ? y10 < y2 : null,
            spreadVsUnitedStates10YBasisPoints: code !== 'US' && y10 != null && usTen != null
                ? round((y10 - usTen) * 100, 1) : null,
            spreadVsEuroArea10YBasisPoints: code !== 'EA' && y10 != null && eaTen != null
                ? round((y10 - eaTen) * 100, 1) : null,
            // True only when every peer needed for the spreads above actually
            // published on this date. A spread against a neighbouring session
            // is not a spread, so the field says which peers were missing
            // instead of quietly reaching for the nearest date.
            comparedWithSameDate: (code === 'US' || usTen != null) && (code === 'EA' || eaTen != null),
            missingPeers: [
                usTen == null && code !== 'US' ? 'US' : null,
                eaTen == null && code !== 'EA' ? 'EA' : null,
            ].filter(Boolean),
            slopeUnavailableReason: y2 != null || y10 == null ? null
                : 'no 2 year series is published for this country',
            curveType: meta.curveType,
            sourceName: meta.sourceName,
            sourceUrl: meta.sourceUrl,
            scrapedAt: new Date().toISOString(),
        });
    }
    rows.sort((a, b) => `${b.date}|${b.countryCode}`.localeCompare(`${a.date}|${a.countryCode}`));
    for (const row of rows) {
        if (emitted >= rowCap || pastDeadline()) break;
        await push(row);
    }
}

for (const p of problems) {
    if (emitted >= rowCap) break;
    const name = COUNTRY_META[p.code]?.name || p.code;
    await note({
        countryCode: p.code,
        country: COUNTRY_META[p.code]?.name || null,
        note: referenceOnly.has(p.code)
            ? `${name} is used as a reference curve for the cross country spreads and returned nothing (${p.error}), so those spreads are null; not charged`
            : `${name}: ${p.error}; not charged`,
    });
}

if (!emitted && !notePushed) {
    await note({
        note: 'no rows returned; widen the date range, clear the maturity filter, or pick different countries; not charged',
    });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
