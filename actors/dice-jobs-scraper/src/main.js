// Dice Jobs Scraper: tech jobs from any Dice search, with salary parsed and,
// optionally, the full description and skills.
//
// Strategy
// --------
// dice.com reads search results from job-search-api.svc.dhigroupinc.com with
// a public site key (the same one its own pages send). The website's query
// parameters (q, location, radius, filters.postedDate, filters.employmentType,
// filters.workplaceTypes, filters.easyApply...) pass straight through, so a
// search URL copied from the browser works as input. Pages hold up to 200
// jobs; the API stops at 10,000 per search (page * pageSize), answering 429
// past that.
//
// Job pages carry a schema.org JobPosting (full description, ZIP, expiry,
// salary) and the skills list in the Next.js flight data.
//
// No key of our own, no proxy: the API and job pages answered Apify's IPs 5/5
// in the 2026-10-09 probe.
//
// Pay per event
// -------------
//   job        ($0.001) one job from search results
//   job_detail ($0.002) one job with its full description and skills
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = 'https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search';
const SITE_KEY = '1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8';
const CAP = 10_000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    location = '',
    radius = 30,
    postedWithin = '',
    employmentTypes = [],
    workplaceTypes = [],
    employerType = '',
    easyApplyOnly = false,
    sponsorshipOnly = false,
    includeDetails = false,
    maxItemsPerSearch = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.min(CAP, Math.max(1, Number(maxItemsPerSearch) || 500));

async function fetchRetry(url, opts, parse) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(45_000) });
            if (r.ok) return await parse(r);
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 400 || r.status === 404) break;
        } catch (err) { last = err; }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// ---------- Searches ----------

const PASS = new Set(['q', 'location', 'latitude', 'longitude', 'radius', 'radiusUnit', 'countryCode2', 'locationPrecision', 'adminDistrictCode', 'includeRemote']);

// https://www.dice.com/jobs?q=python&location=Austin,%20TX,%20USA&radius=30&filters.postedDate=ONE
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/(^|\.)dice\.com$/.test(url.hostname)) return null;
    const params = {};
    for (const [k, v] of url.searchParams) {
        if (k === 'countryCode') params.countryCode2 = v;
        else if (PASS.has(k) || k.startsWith('filters.')) params[k] = v;
    }
    return { params, label: u };
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        const s = parseSearchUrl(u);
        out.push(s || { error: `Not a Dice search URL: ${u}` });
    }
    const base = { countryCode2: 'US' };
    if (location) Object.assign(base, { location: String(location), radius: String(radius || 30), radiusUnit: 'mi' });
    if (postedWithin) base['filters.postedDate'] = postedWithin;
    if (employmentTypes.length) base['filters.employmentType'] = employmentTypes.join('|');
    if (workplaceTypes.length) base['filters.workplaceTypes'] = workplaceTypes.join('|');
    if (employerType) base['filters.employerType'] = employerType;
    if (easyApplyOnly) base['filters.easyApply'] = 'true';
    if (sponsorshipOnly) base['filters.willingToSponsor'] = 'true';
    for (const q of list(queries)) out.push({ params: { q, ...base }, label: `"${q}"${location ? ` near ${location}` : ''}` });
    return out;
}

// ---------- Rows ----------

// "USD 197,300.00 - 225,100.00 per year", "$60 - $70/hr", "Depends on Experience"
const NO_SALARY = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null };
function parseSalary(s) {
    if (!s) return NO_SALARY;
    const nums = [...String(s).replace(/,/g, '').matchAll(/(\d+(?:\.\d+)?)\s*([kK])?/g)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1)).filter((n) => n > 0);
    if (!nums.length) return NO_SALARY;
    const t = s.toLowerCase();
    const [lo, hi] = [Math.min(nums[0], nums[1] ?? nums[0]), Math.max(nums[0], nums[1] ?? nums[0])];
    // Unlabelled ranges ("$60 - $70", "90000 - 110000") are hourly or yearly by size.
    const period = /hour|hr\b|\/hr|hourly/.test(t) ? 'hour' : /year|annual|yr\b|\/yr|annum/.test(t) ? 'year' : /month/.test(t) ? 'month' : /week/.test(t) ? 'week' : /day|daily/.test(t) ? 'day'
        : hi < 300 ? 'hour' : hi >= 15_000 ? 'year' : null;
    const currency = s.match(/\b([A-Z]{3})\b/)?.[1] || (s.includes('$') ? 'USD' : null);
    return { salaryMin: lo, salaryMax: hi, salaryCurrency: currency, salaryPeriod: period };
}

function toRow(j) {
    const loc = j.jobLocation || {};
    return {
        jobId: j.guid || j.id,
        title: j.title,
        companyName: j.companyName || null,
        url: j.detailsPageUrl || null,
        companyUrl: j.companyPageUrl || null,
        companyLogo: j.companyLogoUrl || null,
        location: loc.displayName || null,
        city: loc.city || null,
        state: loc.region || loc.state || null,
        country: loc.country || null,
        isRemote: j.isRemote ?? (j.workFromHomeAvailability ? j.workFromHomeAvailability === 'TRUE' : null),
        employmentType: j.employmentType || null,
        employerType: j.employerType || null,
        salary: j.salary || null,
        ...parseSalary(j.salary),
        easyApply: j.easyApply ?? null,
        willingToSponsor: j.willingToSponsor ?? null,
        postedAt: j.postedDate || null,
        firstActiveAt: j.firstActiveDate || null,
        updatedAt: j.modifiedDate || null,
        summary: j.summary || null,
        diceId: j.id,
    };
}

async function* searchJobs(s) {
    const pageSize = Math.min(200, perSearch);
    let n = 0;
    for (let page = 1; n < perSearch && page * pageSize <= CAP; page++) {
        const url = `${API}?${new URLSearchParams({ ...s.params, page: String(page), pageSize: String(pageSize), language: 'en' })}`;
        const d = await fetchRetry(url, { headers: { 'x-api-key': SITE_KEY, 'User-Agent': UA, Accept: 'application/json', Origin: 'https://www.dice.com', Referer: 'https://www.dice.com/' } }, (r) => r.json());
        if (page === 1) log.info(`${s.label}: ${d?.meta?.totalResults ?? 0} job(s).`);
        const items = d?.data || [];
        for (const j of items) {
            if (n >= perSearch) return;
            n += 1;
            yield toRow(j);
        }
        if (items.length < pageSize || page >= (d?.meta?.pageCount || 0)) return;
        await sleep(300);
    }
}

// ---------- Job page ----------

const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function details(url) {
    const t = await fetchRetry(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' }, (r) => r.text());
    let posting = null;
    for (const m of t.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
        try { const d = JSON.parse(m[1]); if (d?.['@type'] === 'JobPosting') { posting = d; break; } } catch { /* next */ }
    }
    // Skills sit in the flight data as an escaped {"skills":[...]} prop.
    const flight = [...t.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g)].map((m) => m[1]).join('');
    let skills = null;
    const sm = flight.match(/\\"skills\\":\[(.*?)\]/);
    if (sm) { try { skills = JSON.parse(`[${sm[1].replace(/\\"/g, '"')}]`); } catch { skills = null; } }
    const addr = posting?.jobLocation?.address || (Array.isArray(posting?.jobLocation) ? posting.jobLocation[0]?.address : null) || {};
    return {
        description: posting ? strip(posting.description) : null,
        skills,
        postalCode: addr.postalCode || null,
        validThrough: posting?.validThrough || null,
        employmentTypeCode: posting?.employmentType || null,
        companyProfileUrl: posting?.hiringOrganization?.sameAs || null,
    };
}

// ---------- Run ----------

let jobs = 0;
let detailed = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

// Detail pages are fetched a few at a time; rows keep search order.
async function pool(rows, fn, width = 5) {
    const out = new Array(rows.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, rows.length) }, async () => {
        while (i < rows.length) { const k = i++; out[k] = await fn(rows[k]); }
    }));
    return out;
}

const searches = buildSearches();
if (!searches.length) searches.push({ params: { q: 'python developer', countryCode2: 'US' }, label: '"python developer"' });
const seenGlobal = new Set();

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    try {
        let batch = [];
        const flush = async () => {
            const extras = includeDetails ? await pool(batch, async (row) => {
                if (!row.url) return {};
                try { return await details(row.url); } catch (err) { return { detailError: String(err?.message || err) }; }
            }) : batch.map(() => ({}));
            for (let k = 0; k < batch.length && keepGoing; k++) {
                const extra = extras[k];
                const withDetail = includeDetails && !extra.detailError && extra.description != null;
                await Actor.pushData({ ...batch[k], ...extra, search: s.label, scrapedAt: new Date().toISOString() });
                jobs += 1;
                count += 1;
                if (withDetail) detailed += 1;
                if (!(await charge(withDetail ? 'job_detail' : 'job'))) keepGoing = false;
            }
            batch = [];
        };
        for await (const row of searchJobs(s)) {
            if (!keepGoing) break;
            if (seenGlobal.has(row.jobId)) continue;
            seenGlobal.add(row.jobId);
            batch.push(row);
            if (batch.length >= 25) await flush();
        }
        if (keepGoing && batch.length) await flush();
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    perSearchCounts.push({ search: s.label, jobs: count });
}

if (!jobs) await Actor.pushData({ rowType: 'note', note: 'No jobs matched. Not charged.' });
await Actor.setValue('SUMMARY', { jobs, withDetails: detailed, searches: perSearchCounts, failures });
log.info(`Done. ${jobs} job(s)${includeDetails ? `, ${detailed} with details` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
