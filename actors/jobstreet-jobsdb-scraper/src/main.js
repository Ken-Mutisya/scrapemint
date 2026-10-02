// JobStreet & JobsDB Jobs Scraper: jobs from JobStreet (Malaysia, Singapore,
// Philippines, Indonesia) and JobsDB (Hong Kong, Thailand), with salary parsed
// in local currency, remote/hybrid flag and full descriptions.
//
// Strategy
// --------
// JobStreet and JobsDB are SEEK's Asian sites and run the same keyless stack
// as seek-jobs-scraper: GET /api/jobsearch/v5/search for listings and the
// GraphQL jobDetails query for the description (each site answered both on
// 2026-10-02). Category, work type and arrangement ids are SEEK's own and
// return the same categories on all six sites.
//
// A query stops at 540 results. A bigger search splits by work type, then
// work arrangement, then category (region names differ by site and are messy,
// so they are not used to split), giving each slice an even share first.
//
// Pay per event
// -------------
//   job_row        ($0.003) a job with its full description
//   job_row_basic  ($0.002) a job from the listing only
// No start fee and no per-run allowance. A run that returns no jobs is free.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { htmlToText } from './html.js';
import { parseAsiaSalary } from './salary.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CAP = 540;

const SITES = {
    MY: { host: 'https://my.jobstreet.com', siteKey: 'MY-Main', locale: 'en-MY', brand: 'jobstreet', dollar: 'USD', all: '' },
    SG: { host: 'https://sg.jobstreet.com', siteKey: 'SG-Main', locale: 'en-SG', brand: 'jobstreet', dollar: 'SGD', all: '' },
    PH: { host: 'https://ph.jobstreet.com', siteKey: 'PH-Main', locale: 'en-PH', brand: 'jobstreet', dollar: 'USD', all: '' },
    ID: { host: 'https://id.jobstreet.com', siteKey: 'ID-Main', locale: 'en-ID', brand: 'jobstreet', dollar: 'USD', all: '' },
    HK: { host: 'https://hk.jobsdb.com', siteKey: 'HK-Main', locale: 'en-HK', brand: 'jobsdb', dollar: 'HKD', all: '' },
    TH: { host: 'https://th.jobsdb.com', siteKey: 'TH-Main', locale: 'en-TH', brand: 'jobsdb', dollar: 'USD', all: '' },
};

// SEEK's own ids, checked 2026-10-02 against the classification each returns
// on all six sites.
const CATEGORIES = {
    1200: 'Accounting', 6251: 'Administration & Office Support', 6304: 'Advertising, Arts & Media', 1203: 'Banking & Financial Services',
    1204: 'Call Centre & Customer Service', 7019: 'CEO & General Management', 6163: 'Community Services & Development', 1206: 'Construction',
    6076: 'Consulting & Strategy', 6263: 'Design & Architecture', 6123: 'Education & Training', 1209: 'Engineering',
    6205: 'Farming, Animals & Conservation', 1210: 'Government & Defence', 1211: 'Healthcare & Medical', 1212: 'Hospitality & Tourism',
    6317: 'Human Resources & Recruitment', 6281: 'Information & Communication Technology', 1214: 'Insurance & Superannuation', 1216: 'Legal',
    6092: 'Manufacturing, Transport & Logistics', 6008: 'Marketing & Communications', 6058: 'Mining, Resources & Energy', 1220: 'Real Estate & Property',
    6043: 'Retail & Consumer Products', 6362: 'Sales', 1223: 'Science & Technology', 6261: 'Self Employment', 6246: 'Sport & Recreation', 1225: 'Trades & Services',
};
const WORK_TYPES = { 'full time': 242, 'part time': 243, 'contract': 244, 'temp': 244, 'casual': 245 };
const ARRANGEMENTS = { 'on-site': 1, onsite: 1, 'on site': 1, hybrid: 2, remote: 3 };
const ARRANGEMENT_NAME = { 1: 'On-site', 2: 'Hybrid', 3: 'Remote' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    country = 'MY',
    location = '',
    categories = [],
    workTypes = [],
    workArrangements = [],
    minSalary = 0,
    maxSalary = 0,
    postedWithinDays = 0,
    sortBy = 'relevance',
    includeDescription = true,
    splitPastCap = true,
    onlyNew = false,
    maxJobsPerSearch = 1000,
    maxJobs = 2000,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const site = SITES[String(country).toUpperCase()] || SITES.MY;
const terms = listOf(searchTerms);
if (!terms.length) terms.push('');
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const catIds = listOf(categories).map((c) => (/^\d+$/.test(c) ? Number(c) : Number(Object.keys(CATEGORIES).find((id) => norm(CATEGORIES[id]).includes(norm(c)))))).filter((id) => {
    if (!CATEGORIES[id]) log.warning(`Unknown category; options: ${Object.values(CATEGORIES).join(', ')}.`);
    return !!CATEGORIES[id];
});
const wtIds = [...new Set(listOf(workTypes).map((w) => WORK_TYPES[w.toLowerCase().replace(/[-/]/g, ' ').replace(/\s+temp$/, '').trim()]).filter(Boolean))];
const arIds = [...new Set(listOf(workArrangements).map((a) => ARRANGEMENTS[a.toLowerCase()]).filter(Boolean))];
const perSearch = Math.max(1, Number(maxJobsPerSearch) || 1000);
const totalCap = Math.max(1, Number(maxJobs) || 2000);

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = 0;
const waiting = [];
async function slot(fn) {
    if (active >= 4) await new Promise((r) => waiting.push(r));
    active += 1;
    try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
}
async function call(url, init = {}) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await slot(() => fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000) }));
            if (r.ok) return await r.json();
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 400 || r.status === 404) throw Object.assign(last, { fatal: true });
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
    throw last;
}

// ---------- Search, with the 540 split ----------

function searchUrl(f, page, pageSize) {
    const p = new URLSearchParams({ siteKey: site.siteKey, locale: site.locale, page: String(page), pageSize: String(pageSize) });
    if (f.where) p.set('where', f.where);
    if (f.keywords) p.set('keywords', f.keywords);
    if (f.classification) p.set('classification', String(f.classification));
    if (f.worktype) p.set('worktype', String(f.worktype));
    if (f.workarrangement) p.set('workarrangement', String(f.workarrangement));
    if (Number(minSalary) > 0 || Number(maxSalary) > 0) {
        p.set('salaryrange', `${Number(minSalary) || 0}-${Number(maxSalary) > 0 ? Number(maxSalary) : ''}`);
        p.set('salarytype', 'annual');
    }
    if (Number(postedWithinDays) > 0) p.set('daterange', String(Math.min(31, Number(postedWithinDays))));
    if (sortBy === 'date') p.set('sortmode', 'ListedDate');
    return `${site.host}/api/jobsearch/v5/search?${p}`;
}

// Read one slice that fits under the cap: 100 per page for 500, then the last
// 40 at 20 per page (offsets 500 and 520).
async function readSlice(f, total, found, budget) {
    const pages = [];
    for (let page = 1; page <= 5 && (page - 1) * 100 < total; page++) pages.push([page, 100]);
    if (total > 500) pages.push([26, 20], [27, 20]);
    for (const [page, size] of pages) {
        if (found.size >= budget) return;
        const j = await call(searchUrl(f, page, size));
        for (const job of j.data || []) if (!found.has(String(job.id))) found.set(String(job.id), job);
        if (!(j.data || []).length) return;
    }
}

async function collect(f, found, budget, splitsLeft) {
    if (found.size >= budget) return;
    const first = await call(searchUrl(f, 1, 100));
    const total = Number(first.totalCount) || 0;
    // Split only when the buyer wants more than one query can return: a
    // split reads slices in a fixed order, so for a small run it would trade
    // Seek's best matches for whatever slice comes first.
    if (total > CAP && budget > CAP && splitPastCap && splitsLeft.length) {
        const [dim, ...rest] = splitsLeft;
        const values = dim === 'worktype' ? [242, 243, 244, 245] : dim === 'workarrangement' ? [1, 2, 3] : Object.keys(CATEGORIES).map(Number);
        // First pass gives each slice an even share, so a run capped below the
        // full total spreads across states and work types instead of filling
        // from the first one (a 2,000-job nurse run came back 1,997 NSW). A
        // second pass tops up from slices with more than their share.
        const share = Math.ceil((budget - found.size) / values.length);
        for (const v of values) {
            if (found.size >= budget) return;
            await collect({ ...f, [dim]: v }, found, Math.min(budget, found.size + share), rest);
        }
        for (const v of values) {
            if (found.size >= budget) return;
            await collect({ ...f, [dim]: v }, found, budget, rest);
        }
        return;
    }
    for (const job of first.data || []) if (!found.has(String(job.id))) found.set(String(job.id), job);
    if (total > 100) await readSlice(f, Math.min(total, CAP), found, budget);
}

// ---------- Description ----------

// Seek's GraphQL rejects a declared variable the query does not use (400), so
// only jobId is declared.
const DETAIL_QUERY = 'query jobDetails($jobId: ID!) { jobDetails(id: $jobId, tracking: {channel: "WEB", sessionId: "apify", jobDetailsViewedCorrelationId: "apify"}) { job { id content(platform: WEB) } } }';
async function description(id) {
    const j = await call(`${site.host}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'seek-request-brand': site.brand, 'seek-request-country': site.siteKey.slice(0, 2), Origin: site.host },
        body: JSON.stringify({ operationName: 'jobDetails', variables: { jobId: String(id) }, query: DETAIL_QUERY }),
    });
    const html = j?.data?.jobDetails?.job?.content;
    return html ? htmlToText(html) : null;
}

// ---------- Row ----------

function row(job, term) {
    const loc = job.locations?.[0] || {};
    const cls = job.classifications?.[0] || {};
    const listed = job.listingDate ? new Date(job.listingDate) : null;
    const arrangementId = Number(job.workArrangements?.data?.[0]?.id) || null;
    return {
        jobId: String(job.id),
        url: `${site.host}/job/${job.id}`,
        applyUrl: `${site.host}/job/${job.id}/apply`,
        title: job.title,
        company: job.companyName || job.advertiser?.description || null,
        advertiserId: job.advertiser?.id || null,
        location: loc.label || null,
        locations: (job.locations || []).map((l) => l.label).filter(Boolean),
        country: loc.countryCode || String(country).toUpperCase(),
        salaryText: job.salaryLabel || null,
        ...parseAsiaSalary(job.salaryLabel, site.dollar),
        workType: job.workTypes?.[0] || null,
        workArrangement: job.workArrangements?.displayText || (arrangementId ? ARRANGEMENT_NAME[arrangementId] : null),
        remote: /remote/i.test(job.workArrangements?.displayText || ''),
        category: cls.classification?.description || null,
        subcategory: cls.subclassification?.description || null,
        listedAt: listed ? listed.toISOString() : null,
        postedDaysAgo: listed ? Math.max(0, Math.floor((Date.now() - listed.getTime()) / 86400000)) : null,
        teaser: job.teaser || null,
        bulletPoints: job.bulletPoints?.length ? job.bulletPoints : null,
        isFeatured: job.isFeatured === true,
        logo: job.branding?.serpLogoUrl || null,
        description: null,
        searchTerm: term || null,
    };
}

// ---------- Run ----------

const store = onlyNew ? await Actor.openKeyValueStore('jobstreet-jobsdb-scraper-state') : null;
const stateName = `SEEN_${createHash('sha1').update(JSON.stringify({ terms, country, location, catIds, wtIds, arIds, minSalary, maxSalary, postedWithinDays })).digest('hex').slice(0, 12)}`;
const seen = new Set(store ? ((await store.getValue(stateName)) || []) : []);
const firstRun = onlyNew && seen.size === 0;
const returned = [];
let pushed = 0;
let stop = false;
const stats = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

// One filter set per combination the buyer asked for; Seek takes one value
// per filter, so several categories or work types are separate queries.
const combos = [];
for (const term of terms) {
    for (const c of catIds.length ? catIds : [null]) {
        for (const w of wtIds.length ? wtIds : [null]) {
            for (const a of arIds.length ? arIds : [null]) combos.push({ term, f: { keywords: term, where: location || '', classification: c, worktype: w, workarrangement: a } });
        }
    }
}

for (const { term, f } of combos) {
    if (stop || pushed >= totalCap) break;
    const st = { search: [term || '(all jobs)', String(country).toUpperCase(), f.where || null, f.classification && CATEGORIES[f.classification], f.worktype && `worktype ${f.worktype}`, f.workarrangement && ARRANGEMENT_NAME[f.workarrangement]].filter(Boolean).join(' · '), found: 0, returned: 0 };
    stats.push(st);
    try {
        const splits = ['worktype', 'workarrangement', 'classification'].filter((d) => !f[d]);
        const found = new Map();
        await collect(f, found, Math.min(perSearch, totalCap - pushed) + seen.size, splits);
        st.found = found.size;
        const jobs = [...found.values()].filter((j) => !seen.has(String(j.id)));
        if (sortBy === 'date') jobs.sort((a, b) => String(b.listingDate).localeCompare(String(a.listingDate)));
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
            while (i < jobs.length && !stop) {
                const job = jobs[i++];
                if (st.returned >= perSearch || pushed >= totalCap) { stop = pushed >= totalCap; return; }
                if (seen.has(String(job.id))) continue;
                seen.add(String(job.id));
                st.returned += 1;
                pushed += 1;
                const r = row(job, term);
                if (includeDescription) {
                    try { r.description = await description(job.id); } catch (err) { log.debug(`description ${job.id}: ${err?.message}`); }
                }
                if (!includeDescription) delete r.description;
                else if (r.description === undefined) r.description = null;
                await Actor.pushData({ ...r, scrapedAt: new Date().toISOString() });
                returned.push(String(job.id));
                await charge(includeDescription && r.description ? 'job_row' : 'job_row_basic');
            }
        }));
        log.info(`${st.search}: ${st.found} found, ${st.returned} returned.`);
    } catch (err) {
        st.error = String(err?.message || err);
        log.warning(`${st.search}: ${st.error}`);
    }
}

if (store) {
    const prior = (await store.getValue(stateName)) || [];
    await store.setValue(stateName, [...new Set([...prior, ...returned])].slice(-100000));
}
if (!pushed && (!onlyNew || firstRun)) {
    await Actor.pushData({ rowType: 'note', note: `No JobStreet or JobsDB jobs matched${onlyNew ? ' that earlier runs had not already returned' : ''}. Loosen the filters. Not charged.` });
}
await Actor.setValue('SUMMARY', { jobs: pushed, searches: stats });
log.info(`Done. ${pushed} job(s).`);
await Actor.exit();
