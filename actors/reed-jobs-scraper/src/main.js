// Reed Jobs Scraper: UK job listings from reed.co.uk for any keyword and
// location, with salary, company, job type, remote or hybrid, posting and
// expiry dates, and optionally the full description, skills and postcode.
//
// Strategy
// --------
// reed.co.uk is a Next.js site. Every search page carries its results in
// __NEXT_DATA__ (props.pageProps.searchResults.jobs, 25 per page, plus up to 2
// promoted jobs) together with the total count and the criteria the server
// applied. Paging is ?pageno=N; past the last page Reed answers 404.
//
// Filters are plain query parameters and the server echoes them back in
// pageProps.criteria: perm/contract/temp/partTime/fullTime=true,
// dateCreatedOffSet, salaryFrom/salaryTo, proximity (miles), workingOption
// (remote/hybrid/onSite), direct (employers only), agency, graduate,
// hideTrainingJobs. There is no sort parameter: results come in Reed's order.
//
// The job page (/jobs/{slug}/{id}) carries consolidatedJobDetails.jobDetails
// with the HTML description, skills, postcode, region, contract type, the
// salary converted to per annum, and the recruiter's reference.
//
// Codes in search rows, mapped from job pages on 2026-10-11:
//   salaryType 1 per hour, 2 per day, 5 per annum (others left null)
//   jobType 1 Permanent, 2 Contract, 4 Temporary (others left null)
//   salaryDescription bit flags 1 OTE, 2 inc benefits, 4 pro-rata,
//   16 negotiable, 64 competitive
//
// No key, no proxy.
//
// Pay per event
// -------------
//   job        ($0.001) one job from the search page
//   job_detail ($0.002) the same job plus its job page; charged instead of job
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = 'https://www.reed.co.uk';
const PAGE = 25;
const SALARY_PERIOD = { 1: 'per hour', 2: 'per day', 5: 'per annum' };
const JOB_TYPE = { 1: 'Permanent', 2: 'Contract', 4: 'Temporary' };
const SALARY_FLAGS = [[1, 'OTE'], [2, 'inc benefits'], [4, 'pro-rata'], [16, 'negotiable'], [64, 'competitive']];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    location = '',
    distanceMiles = null,
    jobTypes = [],
    workingOption = '',
    postedWithin = 'anytime',
    salaryFrom = null,
    salaryTo = null,
    employerType = 'any',
    graduateOnly = false,
    hideTrainingJobs = false,
    includeDetails = false,
    maxItemsPerSearch = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 200);

async function getPage(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
            if (r.status === 404 || r.status === 410) return null;
            const html = await r.text();
            const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (r.ok && m) {
                const pp = JSON.parse(m[1])?.props?.pageProps;
                if (pp?.notFoundReason) return null;
                if (pp) return pp;
            }
            last = new Error(`HTTP ${r.status}${m ? '' : ', no page data'}`);
        } catch (err) {
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// ---------- Searches ----------

const JOB_TYPE_PARAM = { PERMANENT: 'perm', PERM: 'perm', CONTRACT: 'contract', TEMPORARY: 'temp', TEMP: 'temp', PART_TIME: 'partTime', PARTTIME: 'partTime', FULL_TIME: 'fullTime', FULLTIME: 'fullTime' };
const WORKING = { REMOTE: 'remote', HYBRID: 'hybrid', ON_SITE: 'onSite', ONSITE: 'onSite', OFFICE: 'onSite' };
const POSTED = { ANYTIME: 'anytime', TODAY: 'today', LAST_3_DAYS: 'lastthreedays', LASTTHREEDAYS: 'lastthreedays', LAST_WEEK: 'lastweek', LASTWEEK: 'lastweek', LAST_2_WEEKS: 'lasttwoweeks', LASTTWOWEEKS: 'lasttwoweeks' };
const key = (v) => String(v || '').toUpperCase().replace(/[\s/-]+/g, '_');

function filterParams() {
    const p = new URLSearchParams();
    for (const t of list(jobTypes)) {
        const name = JOB_TYPE_PARAM[key(t)];
        if (name) p.set(name, 'true');
        else log.warning(`Unknown job type "${t}" ignored. Use: permanent, contract, temporary, part_time, full_time`);
    }
    if (workingOption) {
        const w = WORKING[key(workingOption)];
        if (w) p.set('workingOption', w);
        else log.warning(`Unknown working option "${workingOption}" ignored. Use: remote, hybrid, on_site`);
    }
    const posted = POSTED[key(postedWithin)] || (Object.values(POSTED).includes(postedWithin) ? postedWithin : null);
    if (posted && posted !== 'anytime') p.set('dateCreatedOffSet', posted);
    if (Number(salaryFrom) > 0) p.set('salaryFrom', String(Math.round(salaryFrom)));
    if (Number(salaryTo) > 0) p.set('salaryTo', String(Math.round(salaryTo)));
    if (employerType === 'direct') p.set('direct', 'true');
    if (employerType === 'agency') p.set('agency', 'true');
    if (graduateOnly) p.set('graduate', 'true');
    if (hideTrainingJobs) p.set('hideTrainingJobs', 'true');
    if (Number(distanceMiles) >= 0 && distanceMiles !== null && distanceMiles !== '' && location) p.set('proximity', String(distanceMiles));
    return p;
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        let url;
        try { url = new URL(u); } catch { url = null; }
        if (!url || !/(^|\.)reed\.co\.uk$/.test(url.hostname) || !url.pathname.startsWith('/jobs')) {
            out.push({ error: `Not a Reed job search URL (reed.co.uk/jobs/...): ${u}` });
            continue;
        }
        url.searchParams.delete('pageno');
        out.push({ url: url.toString(), label: u });
    }
    const fp = filterParams();
    const kws = list(queries);
    if (!kws.length && location && !out.length) kws.push('');
    for (const kw of kws) {
        const p = new URLSearchParams(fp);
        if (kw) p.set('keywords', kw);
        if (location) p.set('location', location);
        out.push({ url: `${BASE}/jobs?${p}`, label: `${kw ? `"${kw}"` : 'all jobs'}${location ? ` in ${location}` : ''}` });
    }
    return out;
}

const withPage = (u, n) => {
    const url = new URL(u);
    if (n > 1) url.searchParams.set('pageno', String(n));
    return url.toString();
};

// ---------- Rows ----------

const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&pound;/g, '£').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const toText = (h) => decode(String(h || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/ul|\/ol)[^>]*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const num = (v) => (v === null || v === undefined || v === '' || Number(v) === 0 ? null : Number(v));

function row(j, search, promoted) {
    const d = j.jobDetail || {};
    const flags = SALARY_FLAGS.filter(([bit]) => (Number(d.salaryDescription) || 0) & bit).map(([, name]) => name);
    return {
        jobId: d.jobId,
        url: `${BASE}${j.url}`,
        title: d.jobTitle || null,
        companyName: (d.ouName || j.profileName || '').trim() || null,
        companyReedUrl: j.ouUrl ? `${BASE}${j.ouUrl}` : null,
        companyLogoUrl: j.logoImage ? `https://resources.reed.co.uk/profileimages/logos/thumbs/${j.logoImage}` : null,
        location: d.displayLocationName || null,
        county: d.countyLocation || null,
        workingOption: d.workingOption || null,
        jobType: JOB_TYPE[d.jobType] || null,
        isFullTime: d.isFullTime ?? null,
        isPartTime: d.isPartTime ?? null,
        salaryFrom: num(d.salaryFrom),
        salaryTo: num(d.salaryTo),
        salaryCurrency: num(d.salaryFrom) || num(d.salaryTo) ? 'GBP' : null,
        salaryPeriod: num(d.salaryFrom) || num(d.salaryTo) ? SALARY_PERIOD[d.salaryType] || null : null,
        salaryNotes: flags,
        postedAt: d.displayDate || d.dateCreated || null,
        createdAt: d.dateCreated || null,
        updatedAt: d.dateUpdated || null,
        expiresAt: d.expiryDate || null,
        category: d.taxonomyLevel1 || null,
        occupation: d.taxonomyLevel2 || null,
        isEasyApply: d.isEasyApply ?? null,
        externalApplyUrl: d.externalUrl || null,
        isPromoted: Boolean(promoted || d.isPromoted),
        isTrainingJob: d.isTrainingJob ?? null,
        ukOnly: d.eligibleUkOnly ?? null,
        snippet: d.jobDescriptionSnippet ? decode(d.jobDescriptionSnippet) : null,
        search,
        scrapedAt: new Date().toISOString(),
    };
}

function addDetails(r, det) {
    const s = det.jobSalary || {};
    const loc = det.jobLocation || {};
    const owner = det.jobOwner || {};
    Object.assign(r, {
        descriptionText: toText(det.description) || null,
        descriptionHtml: det.description || null,
        skills: (det.jobSkills || []).map((x) => x.name).filter(Boolean),
        salaryText: s.displaySalary || null,
        salaryPeriod: s.type?.name || r.salaryPeriod,
        salaryFromPerAnnum: num(s.fromPerAnnum),
        salaryToPerAnnum: num(s.toPerAnnum),
        contractType: det.jobContractType?.name || r.jobType,
        sector: det.jobSector?.name || null,
        parentSector: det.jobSector?.parentName || null,
        town: loc.townName || null,
        region: loc.regionName || null,
        postcode: loc.postCode || null,
        country: loc.countryName || null,
        isRemote: loc.isRemoteJob ?? null,
        locationType: loc.inferredJobLocationType || r.workingOption,
        recruiterType: det.isAgency ? 'agency' : det.isEmployer ? 'employer' : null,
        recruiterReference: owner.reference || null,
        isGraduate: det.isGraduate ?? null,
    });
    return r;
}

// ---------- Run ----------

let jobs = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];
const seen = new Set();

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function detailsFor(r) {
    try {
        const pp = await getPage(r.url);
        const det = pp?.consolidatedJobDetails?.jobDetails;
        if (det) return addDetails(r, det);
        r.detailError = 'Job page not found (expired or removed).';
    } catch (err) {
        r.detailError = String(err?.message || err);
    }
    return r;
}

const searches = buildSearches();
if (!searches.length) searches.push({ url: `${BASE}/jobs?keywords=software+developer&location=london`, label: '"software developer" in london' });

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let total = null;
    try {
        for (let page = 1; keepGoing && count < perSearch; page++) {
            const pp = await getPage(withPage(s.url, page));
            const sr = pp?.searchResults;
            if (!sr) break;
            total ??= sr.count ?? null;
            if (page === 1) log.info(`${s.label}: ${total ?? '?'} job(s) on Reed.`);
            const batch = [...(page === 1 ? (sr.promotedJobs || []).map((j) => [j, true]) : []), ...(sr.jobs || []).map((j) => [j, false])];
            const rows = [];
            for (const [j, promoted] of batch) {
                const id = j?.jobDetail?.jobId;
                if (!id || seen.has(id) || rows.length + count >= perSearch) continue;
                seen.add(id);
                rows.push(row(j, s.label, promoted));
            }
            if (includeDetails) {
                for (let i = 0; i < rows.length; i += 5) await Promise.all(rows.slice(i, i + 5).map(detailsFor));
            }
            for (const r of rows) {
                await Actor.pushData(r);
                jobs += 1;
                count += 1;
                if (!(await charge(includeDetails && !r.detailError ? 'job_detail' : 'job'))) { keepGoing = false; break; }
            }
            if ((sr.jobs || []).length < PAGE) break;
            await sleep(300);
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${count} job(s) saved.`);
    perSearchCounts.push({ search: s.label, jobsOnReed: total, jobsSaved: count });
}

if (!jobs) await Actor.pushData({ rowType: 'note', note: 'No jobs matched. Not charged.' });
await Actor.setValue('SUMMARY', { jobs, searches: perSearchCounts, failures });
log.info(`Done. ${jobs} job(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
