// H-1B Salary Data
// Base salaries US employers filed with the Department of Labor to sponsor H-1B
// workers: employer, job title, base pay, work location and the filing dates.
// Unlike self-reported salary sites these are legally filed figures.
//
// Source (keyless HTML, robots.txt allows all):
//   https://h1bdata.info/index.php?em={employer}&job={title}&city={city}&year={YYYY}
//
// Free tier: the first 2 rows of every run are free, then each salary row is charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HOST = 'https://h1bdata.info/index.php';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; ScrapemintH1BSalaryData/1.0; +https://apify.com/scrapemint)',
    Accept: 'text/html,application/xhtml+xml',
};
const REQ_SLEEP_MS = 400; // one small site, stay polite
const MAX_YEAR_LOOKBACK = 6;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    employers = [],
    jobTitle = '',
    city = '',
    years = [],
    includeSummary = true,
    sortBy = 'salary',
    maxRows = 200,
} = input;

const employerList = (Array.isArray(employers) ? employers : [])
    .map((e) => String(e).trim())
    .filter(Boolean);
const titleQuery = String(jobTitle || '').trim();
const cityQuery = String(city || '').trim();

if (!employerList.length && !titleQuery && !cityQuery) {
    log.warning('Nothing to search. Set at least one of "employers", "jobTitle" or "city".');
    await Actor.exit();
}

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const rowCap = Math.max(1, Number(maxRows) || 200);
let pushed = 0;
// Cached by URL so year auto-resolution does not re-fetch the year it just
// probed. Declared here, not beside fetchRows, because year resolution runs at
// top level before a const further down the file would be initialised.
const rowCache = new Map();

const yearList = await resolveYears();
if (!yearList.length) {
    log.warning('No year with data found. Set "years" explicitly, e.g. [2024, 2025].');
    await Actor.exit();
}
log.info(`Years: ${yearList.join(', ')} | employers: ${employerList.length || 'any'} | title: ${titleQuery || 'any'} | city: ${cityQuery || 'any'}`);

// One query per employer per year. With no employer list the title/city query
// runs once per year on its own.
const queries = [];
for (const year of yearList) {
    if (employerList.length) {
        for (const em of employerList) queries.push({ em, year });
    } else {
        queries.push({ em: '', year });
    }
}

const collected = [];
for (const q of queries) {
    if (done()) break;
    const rows = await fetchRows(q.em, titleQuery, cityQuery, q.year);
    if (rows === null) {
        log.warning(`Fetch failed for employer="${q.em || 'any'}" year=${q.year}; skipping.`);
        continue;
    }
    log.info(`employer="${q.em || 'any'}" year=${q.year}: ${rows.length} row(s).`);
    collected.push(...rows);
    await sleep(REQ_SLEEP_MS);
}

// Non-unique sort keys (employer, title) would make equal rows swap order run to
// run, so every comparison falls through to a stable tiebreak.
if (String(sortBy) === 'salary') {
    collected.sort((a, b) => salaryDesc(a, b)
        || String(a.employer).localeCompare(String(b.employer))
        || String(a.jobTitle).localeCompare(String(b.jobTitle))
        || String(a.submitDate).localeCompare(String(b.submitDate)));
} else {
    collected.sort((a, b) => String(b.submitDate || '').localeCompare(String(a.submitDate || ''))
        || String(a.employer).localeCompare(String(b.employer))
        || salaryDesc(a, b));
}

const emitted = collected.slice(0, rowCap);

// The summary describes EVERY filing matched, not the page of rows that survived
// maxRows. Building it from the capped slice would report the median of the
// highest paid handful as if it were the median of the whole search.
if (includeSummary && collected.length) {
    await pushRow(buildSummary(collected));
}
for (const r of emitted) {
    if (done()) break;
    await pushRow(r);
}

log.info(`Done. Pushed ${pushed} row(s) from ${collected.length} matched filing(s).`);
await Actor.exit();

// ---------- fetching ----------

async function fetchRows(em, job, cityArg, year) {
    const url = `${HOST}?em=${encodeURIComponent(em)}&job=${encodeURIComponent(job)}`
        + `&city=${encodeURIComponent(cityArg)}&year=${encodeURIComponent(year)}`;
    if (rowCache.has(url)) return rowCache.get(url);
    const html = await fetchText(url);
    const rows = html === null ? null : parseTable(html, year, url);
    rowCache.set(url, rows);
    return rows;
}

// The response is one plain table. Cells are read positionally because the
// header row is the only labelling the page carries.
function parseTable(html, year, sourceUrl) {
    const out = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
        const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map((c) => stripTags(c[1]));
        if (cells.length < 6) continue;
        const [employer, title, salary, location, submit, start] = cells;
        if (!employer || /^employer$/i.test(employer)) continue; // header row
        const { city: cityName, state } = splitLocation(location);
        out.push({
            employer,
            jobTitle: title || null,
            // parseSalary returns null, never 0, when the cell is blank or not a
            // number: a salary of 0 would read as a real filed wage.
            baseSalary: parseSalary(salary),
            baseSalaryRaw: salary || null,
            location: location || null,
            city: cityName,
            state,
            submitDate: toIso(submit),
            startDate: toIso(start),
            filingYear: Number(year),
            sourceUrl,
        });
    }
    return out;
}

async function fetchText(url) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.status === 429 || res.status >= 500) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return await res.text();
        } catch (err) {
            if (attempt === 2) {
                log.warning(`fetch failed ${url}: ${err?.message}`);
                return null;
            }
            await sleep(1000 * (attempt + 1));
        }
    }
    return null;
}

// The site accepts only a concrete year. `year=All` and an empty year both
// silently return just the newest year rather than the full history, so asking
// for everything has to be done by looping years explicitly.
async function resolveYears() {
    const given = (Array.isArray(years) ? years : [])
        .map((y) => String(y).trim())
        .filter((y) => /^\d{4}$/.test(y));
    if (given.length) return given;

    // Disclosure lags, so the current year is often empty. Walk back to the
    // newest year that actually returns filings for this query.
    const probeEmployer = employerList[0] || '';
    const thisYear = new Date().getUTCFullYear();
    for (let i = 0; i < MAX_YEAR_LOOKBACK; i += 1) {
        const year = String(thisYear - i);
        const rows = await fetchRows(probeEmployer, titleQuery, cityQuery, year);
        if (rows && rows.length) return [year];
        await sleep(REQ_SLEEP_MS);
    }
    return [];
}

// ---------- output ----------

function buildSummary(rows) {
    const salaries = rows.map((r) => r.baseSalary).filter((v) => typeof v === 'number' && Number.isFinite(v));
    salaries.sort((a, b) => a - b);
    // Every statistic stays null when nothing parsed, so an empty sample cannot
    // publish as a confident zero.
    const has = salaries.length > 0;
    return {
        type: 'summary',
        employers: employerList.length ? employerList : null,
        jobTitle: titleQuery || null,
        city: cityQuery || null,
        years: yearList,
        filingsMatched: rows.length,
        salaryRowsReturned: Math.min(rows.length, rowCap),
        salariesParsed: salaries.length,
        minSalary: has ? salaries[0] : null,
        p25Salary: percentile(salaries, 0.25),
        medianSalary: percentile(salaries, 0.5),
        p75Salary: percentile(salaries, 0.75),
        maxSalary: has ? salaries[salaries.length - 1] : null,
    };
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

async function pushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName: 'salary_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 100 === 0) log.info(`Pushed ${pushed} rows...`);
}

function done() {
    if (pushed >= rowCap + (includeSummary ? 1 : 0)) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        return true;
    }
    return false;
}

// ---------- parsing helpers ----------

function stripTags(s) {
    return String(s)
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

// "99,424" -> 99424. Returns null for blanks and for anything that is not a
// number, so a missing wage never becomes 0.
function parseSalary(s) {
    if (!s) return null;
    const digits = String(s).replace(/[^0-9.]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// "NEW YORK, NY" -> { city: "NEW YORK", state: "NY" }
function splitLocation(loc) {
    if (!loc) return { city: null, state: null };
    const m = String(loc).match(/^(.*),\s*([A-Z]{2})$/);
    if (!m) return { city: String(loc).trim() || null, state: null };
    return { city: m[1].trim() || null, state: m[2] };
}

// "06/03/2025" -> "2025-06-03". Returns null on anything else rather than
// inventing a date.
function toIso(s) {
    const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[1]}-${m[2]}`;
}

// Highest salary first, with unparseable wages always sinking to the bottom
// rather than riding the sort direction to the top.
function salaryDesc(a, b) {
    const av = typeof a.baseSalary === 'number' && Number.isFinite(a.baseSalary) ? a.baseSalary : null;
    const bv = typeof b.baseSalary === 'number' && Number.isFinite(b.baseSalary) ? b.baseSalary : null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
