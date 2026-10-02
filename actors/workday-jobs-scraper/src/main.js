// Workday Jobs Scraper: every open job on any company's Workday career site
//
// Strategy
// --------
// Workday career sites (*.myworkdayjobs.com, wdN.myworkdaysite.com) are
// single-page apps backed by a public JSON API the page itself calls:
//   POST /wday/cxs/{tenant}/{site}/jobs         listing, 20 per page
//   GET  /wday/cxs/{tenant}/{site}{externalPath} one posting with description
// Keyless, no browser, no proxy.
//
// The listing stops at 2,000: an offset past it silently wraps to page one,
// and `total` reads 2000 however many jobs the site has. A site at the cap is
// split on its own facets (job family, location, time type), whose values carry
// counts, recursing until every slice is under the cap, and the slices are
// de-duplicated on the posting path.
//
// directory.json (scripts/build-directory.mjs) maps company names to live
// career sites, found in the Common Crawl URL index and checked against the
// jobs endpoint, so a buyer can type "nvidia" instead of finding the URL.
//
// Pay per event
// -------------
//   job_row        ($0.003)  a posting with its full description
//   job_row_basic  ($0.0015) a posting from the listing only (includeDescription off)
// No per-run free allowance: buyers schedule this with onlyNew, and an
// allowance that resets on every poll bills nothing. A run that returns no
// jobs is free.

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseWorkdayUrl } from './workday-url.js';
import { parseSalary, htmlToText, postedDaysAgo } from './parse.js';

const PAGE = 20;
const CAP = 2000;
const DETAIL_CONCURRENCY = 8;
const SITE_CONCURRENCY = 12;
const PAGE_BATCH = 6;

const DIRECTORY = JSON.parse(readFileSync(new URL('./directory.json', import.meta.url), 'utf8'));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [],
    searchAllCompanies = false,
    searchText = '',
    locations = [],
    remoteOnly = false,
    postedWithinDays = 0,
    includeDescription = true,
    strictKeyword = true,
    onlyNew = false,
    maxJobsPerCompany = 1000,
    maxJobs = 5000,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const locQ = listOf(locations).map((s) => s.toLowerCase());
const withinDays = Math.max(0, Number(postedWithinDays) || 0);
const perCompanyCap = Math.max(1, Number(maxJobsPerCompany) || 1000);
const totalCap = Math.max(1, Number(maxJobs) || 5000);
const keyword = String(searchText || '').trim();
// Workday's search is loose: "data engineer" also returns "Regional Operations
// Manager" and "iOS Engineer" (checked 2026-10-01). Strict mode keeps a job only
// when every keyword word is in its title, or in its description when one was
// fetched.
const keywordWords = strictKeyword ? keyword.toLowerCase().split(/\s+/).filter(Boolean) : [];
// Matched at the start of a word: "engineer" finds "Engineering", "data" does
// not find "metadata".
const keywordRes = keywordWords.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
const hasAllWords = (hay) => keywordRes.every((re) => re.test(hay));

// ---------- Resolve the sites to read ----------

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const unresolved = [];
const sites = new Map();
const addSite = (s, label) => {
    const key = `${s.host}|${s.tenant}|${s.site.toLowerCase()}`;
    // A URL input borrows the employer name the directory knows for its tenant.
    const name = s.name || DIRECTORY.find((d) => d.tenant === s.tenant && d.name)?.name;
    if (!sites.has(key)) sites.set(key, { ...s, ...(name ? { name } : {}), label });
};

if (searchAllCompanies) {
    if (!keyword && !withinDays) {
        await failInput('searchAllCompanies reads every career site in the directory, so it needs a keyword (searchText) or postedWithinDays to keep the run bounded.');
    }
    // The busiest site per tenant: the others are mostly internal or campus boards.
    const seenTenant = new Set();
    for (const d of DIRECTORY) {
        if (seenTenant.has(d.tenant) || !d.jobs) continue;
        seenTenant.add(d.tenant);
        addSite(d, d.tenant);
    }
}

for (const raw of listOf(companies)) {
    const fromUrl = /^https?:\/\//i.test(raw) ? parseWorkdayUrl(raw) : null;
    if (fromUrl) { addSite(fromUrl, raw); continue; }
    if (/^https?:\/\//i.test(raw)) { unresolved.push({ input: raw, reason: 'not a Workday career-site URL (expected *.myworkdayjobs.com or wdN.myworkdaysite.com)' }); continue; }
    const q = norm(raw);
    const exact = DIRECTORY.filter((d) => norm(d.tenant) === q);
    // Workday tenant ids are often not the company name (Bank of America is
    // "ghr"), so the employer name the directory recorded is matched too.
    const byName = DIRECTORY.filter((d) => d.name && norm(String(d.name).replace(/^\d+\s+/, '')).startsWith(q));
    const loose = exact.length ? exact : byName.length ? byName : DIRECTORY.filter((d) => norm(d.tenant).startsWith(q) || norm(d.site).includes(q));
    if (!loose.length) { unresolved.push({ input: raw, reason: 'not in the directory; pass the career-site URL instead' }); continue; }
    // Directory is sorted busiest site first within a tenant.
    // The busiest matching site, so a name shared by a tenant's campus or
    // internal board resolves to its main public one.
    const best = loose.slice().sort((x, y) => (y.jobs || 0) - (x.jobs || 0))[0];
    addSite(best, raw);
}

if (!sites.size) {
    await failInput(unresolved.length
        ? `No Workday career site resolved: ${unresolved.map((u) => `${u.input} (${u.reason})`).join('; ')}.`
        : 'Add at least one company name or Workday career-site URL, or turn on searchAllCompanies with a keyword.');
}
for (const u of unresolved) log.warning(`Skipped ${u.input}: ${u.reason}.`);
log.info(`Reading ${sites.size} Workday career site(s)${keyword ? ` for "${keyword}"` : ''}${withinDays ? `, posted within ${withinDays} day(s)` : ''}.`);

// ---------- Only-new state ----------

const filterKey = createHash('sha1').update(JSON.stringify({ s: [...sites.keys()].sort(), keyword, locQ, remoteOnly, withinDays })).digest('hex').slice(0, 12);
const store = onlyNew ? await Actor.openKeyValueStore('workday-jobs-scraper-state') : null;
const stateName = `SEEN_${filterKey}`;
const seen = new Set(store ? ((await store.getValue(stateName)) || []) : []);
const firstRun = onlyNew && seen.size === 0;

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Many tenants share a Workday cluster (wd1, wd5, ...), and the cluster rate
// limits: a searchAllCompanies run on the platform took HTTP 429 on 33 wd1
// sites at once (2026-10-01). Requests are capped per cluster, and a 429 backs
// off for Retry-After or an exponential delay before trying again.
const CLUSTER_CONCURRENCY = 6;
const clusters = new Map();
const clusterOf = (url) => {
    const host = new URL(url).hostname;
    return host.match(/(wd\d+)\.myworkday(?:jobs|site)\.com$/)?.[1] || host;
};
async function withCluster(url, fn) {
    const key = clusterOf(url);
    let c = clusters.get(key);
    if (!c) { c = { active: 0, waiting: [] }; clusters.set(key, c); }
    if (c.active >= CLUSTER_CONCURRENCY) await new Promise((r) => c.waiting.push(r));
    c.active += 1;
    try { return await fn(); } finally {
        c.active -= 1;
        c.waiting.shift()?.();
    }
}

async function call(url, body) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        let wait = 1000 * 2 ** attempt + Math.random() * 500;
        try {
            const res = await withCluster(url, () => fetch(url, {
                method: body ? 'POST' : 'GET',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(30_000),
            }));
            if (res.ok) return await res.json();
            if (res.status === 404 || res.status === 400 || res.status === 422) {
                const e = new Error(`HTTP ${res.status}`); e.fatal = true; throw e;
            }
            if (res.status === 429) {
                const ra = Number(res.headers.get('retry-after'));
                wait = Math.max(wait, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 3000 * 2 ** attempt);
            }
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            if (err.fatal) throw err;
            lastErr = err;
        }
        await sleep(Math.min(wait, 60_000));
    }
    throw lastErr;
}

const jobsUrl = (s) => `https://${s.host}/wday/cxs/${s.tenant}/${s.site}/jobs`;

// ---------- Listing, with the 2,000 split ----------

// Facets can nest (locationMainGroup holds locationHierarchy1/2); flatten them.
function flattenFacets(facets, out = []) {
    for (const f of facets || []) {
        if (f.facetParameter && Array.isArray(f.values) && f.values.length && f.values.every((v) => v.id)) {
            out.push({ param: f.facetParameter, values: f.values.filter((v) => (v.count ?? 1) > 0) });
        }
        if (Array.isArray(f.values)) flattenFacets(f.values.filter((v) => v.facetParameter), out);
    }
    return out;
}

async function listSite(s, budget) {
    const found = new Map();
    const truncated = { value: false };

    async function walk(applied, depth) {
        if (found.size >= budget) return;
        const first = await call(jobsUrl(s), { limit: PAGE, offset: 0, searchText: keyword, appliedFacets: applied });
        const total = Number(first.total) || 0;
        if (total >= CAP) {
            const used = new Set(Object.keys(applied));
            const options = flattenFacets(first.facets).filter((f) => !used.has(f.param));
            // Prefer a facet whose every value fits under the cap; among those,
            // the one covering the most jobs (a facet a job may lack loses it).
            const score = (f) => f.values.reduce((a, v) => a + (v.count || 0), 0);
            const fits = options.filter((f) => f.values.every((v) => (v.count || 0) < CAP)).sort((a, b) => score(b) - score(a));
            const pick = fits[0] || options.sort((a, b) => Math.max(...a.values.map((v) => v.count || 0)) - Math.max(...b.values.map((v) => v.count || 0)))[0];
            if (pick && depth < 4) {
                // Three slices at a time, each paging in batches of PAGE_BATCH.
                const queue = [...pick.values];
                await Promise.all(Array.from({ length: 3 }, async () => {
                    while (queue.length && found.size < budget) {
                        const v = queue.shift();
                        await walk({ ...applied, [pick.param]: [v.id] }, depth + 1);
                    }
                }));
                return;
            }
            truncated.value = true;
        }
        const add = (p) => { if (p?.externalPath && !found.has(p.externalPath)) found.set(p.externalPath, p); };
        (first.jobPostings || []).forEach(add);
        const last = Math.min(total, CAP);
        // Pages in batches: one at a time, a 2,648-job site took 330 s.
        for (let offset = PAGE; offset < last && found.size < budget; offset += PAGE * PAGE_BATCH) {
            const offsets = [];
            for (let o = offset; o < Math.min(last, offset + PAGE * PAGE_BATCH); o += PAGE) offsets.push(o);
            const pages = await Promise.all(offsets.map((o) => call(jobsUrl(s), { limit: PAGE, offset: o, searchText: keyword, appliedFacets: applied })));
            const posts = pages.flatMap((pg) => pg.jobPostings || []);
            if (!posts.length) break;
            posts.forEach(add);
            // With no keyword Workday lists newest first, so once a whole batch
            // is older than the window later pages are older still. A keyword
            // search is ordered by relevance (checked 2026-10-01: a "Today" job
            // sits behind pages of 30+ day ones), so it reads to the end.
            if (withinDays && !keyword && posts.every((p) => (postedDaysAgo(p.postedOn) ?? 0) > withinDays)) break;
        }
    }

    await walk({}, 0);
    return { postings: [...found.values()], truncated: truncated.value };
}

// ---------- Filters and rows ----------

function keepListing(p) {
    if (keywordWords.length && !includeDescription && !hasAllWords(String(p.title || '').toLowerCase())) return false;
    if (withinDays) {
        const age = postedDaysAgo(p.postedOn);
        if (age != null && age > withinDays) return false;
    }
    if (locQ.length && !locQ.some((q) => String(p.locationsText || '').toLowerCase().includes(q))) {
        // "2 Locations" hides the list until the detail call; decide there.
        if (!/^\d+ locations?$/i.test(String(p.locationsText || '').trim()) || !includeDescription) return false;
    }
    return true;
}

const companyName = (s, org) => {
    // hiringOrganization often reads "2100 NVIDIA USA": an internal entity code first.
    // and "ADUS-Adobe Inc." an entity prefix.
    const n = String(org?.name || '').replace(/^\d+\s+/, '').replace(/^[A-Z0-9]{2,6}-(?=[A-Z])/, '').trim();
    return n || s.name || s.tenant.charAt(0).toUpperCase() + s.tenant.slice(1);
};

function buildRow(s, p, detail) {
    const info = detail?.jobPostingInfo || {};
    const locs = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
    const location = info.location || p.locationsText || null;
    const allText = `${p.title} ${locs.join(' ')} ${p.locationsText || ''} ${info.remoteType || ''}`;
    const description = info.jobDescription ? htmlToText(info.jobDescription) : null;
    const age = postedDaysAgo(info.postedOn || p.postedOn);
    const url = info.externalUrl || `https://${s.host}/${s.site}${p.externalPath}`;
    return {
        company: detail ? companyName(s, detail.hiringOrganization) : companyName(s, null),
        title: info.title || p.title,
        jobReqId: info.jobReqId || (p.bulletFields || [])[0] || null,
        location,
        additionalLocations: (info.additionalLocations || []).length ? info.additionalLocations : null,
        country: info.country?.descriptor || info.jobRequisitionLocation?.country?.descriptor || null,
        countryCode: info.jobRequisitionLocation?.country?.alpha2Code || null,
        remote: /\bremote\b/i.test(allText) || /remote/i.test(String(info.remoteType || '')),
        remoteType: info.remoteType || null,
        timeType: info.timeType || null,
        postedOn: info.postedOn || p.postedOn || null,
        postedDaysAgo: age,
        startDate: info.startDate || null,
        ...(detail ? parseSalary(description) : {}),
        description: includeDescription ? description : undefined,
        url,
        applyUrl: `${url.replace(/\/$/, '')}/apply`,
        hiringEntity: detail?.hiringOrganization?.name || null,
        workdayTenant: s.tenant,
        workdaySite: s.site,
        careerSiteUrl: `https://${s.host}/${s.site}`,
        scrapedAt: new Date().toISOString(),
    };
}

function keepRow(row) {
    if (remoteOnly && !row.remote) return false;
    if (keywordWords.length && !hasAllWords(String(row.title || '').toLowerCase())
        && !(row.description && hasAllWords(row.description.toLowerCase()))) return false;
    if (locQ.length) {
        const hay = [row.location, ...(row.additionalLocations || []), row.country].join(' ').toLowerCase();
        if (!locQ.some((q) => hay.includes(q)) && !(locQ.includes('remote') && row.remote)) return false;
    }
    if (withinDays && row.postedDaysAgo != null && row.postedDaysAgo > withinDays) return false;
    return true;
}

// ---------- Run ----------

let pushed = 0;
let charged = 0;
let stopAll = false;
const returned = [];
const perSite = [];

async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length && !stopAll) { const it = items[i++]; await fn(it); }
    }));
}

async function emit(s, p, detail) {
    if (stopAll || pushed >= totalCap) { stopAll = true; return false; }
    const row = buildRow(s, p, detail);
    if (!keepRow(row)) return false;
    const key = `${s.tenant}|${row.jobReqId || p.externalPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!includeDescription) delete row.description;
    // Counted before the await: emits run concurrently, and counting after
    // let a run overshoot maxJobs by the number in flight.
    pushed += 1;
    await Actor.pushData(row);
    returned.push(key);
    try {
        const r = await Actor.charge({ eventName: detail ? 'job_row' : 'job_row_basic' });
        charged += 1;
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stopAll = true; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    return true;
}

await pool([...sites.values()], SITE_CONCURRENCY, async (s) => {
    const stat = { company: s.label, careerSiteUrl: `https://${s.host}/${s.site}`, listed: 0, returned: 0 };
    perSite.push(stat);
    try {
        const { postings, truncated } = await listSite(s, perCompanyCap * 3);
        stat.listed = postings.length;
        if (truncated) stat.note = 'over 2,000 jobs with no facet to split on; first 2,000 read';
        const keep = postings.filter((p) => keepListing(p) && !seen.has(`${s.tenant}|${(p.bulletFields || [])[0] || p.externalPath}`));
        let n = 0;
        if (!includeDescription) {
            for (const p of keep) {
                if (n >= perCompanyCap || stopAll) break;
                if (await emit(s, p, null)) n += 1;
            }
        } else {
            await pool(keep, DETAIL_CONCURRENCY, async (p) => {
                // Reserve the slot before the detail call: checking after it let
                // a 50-job cap return 53 (run 2V6NE9rXZOzjiIbAM).
                if (n >= perCompanyCap) return;
                n += 1;
                let detail = null;
                try { detail = await call(`https://${s.host}/wday/cxs/${s.tenant}/${s.site}${p.externalPath}`); } catch (err) {
                    log.debug(`detail ${p.externalPath}: ${err?.message}`);
                }
                // A posting whose detail call failed is still a real opening;
                // return it from the listing and bill it as basic.
                if (!(await emit(s, p, detail?.jobPostingInfo ? detail : null))) n -= 1;
            });
        }
        stat.returned = n;
        log.info(`${s.tenant}/${s.site}: ${postings.length} listed, ${n} returned.`);
    } catch (err) {
        stat.error = String(err?.message || err);
        log.warning(`${s.tenant}/${s.site}: ${stat.error}`);
    }
});

if (store) {
    const prior = (await store.getValue(stateName)) || [];
    await store.setValue(stateName, [...new Set([...prior, ...returned])].slice(-100000));
}

const failed = perSite.filter((x) => x.error);
// A scheduled onlyNew run with nothing new returns an empty dataset, not a
// note on every poll.
if (!pushed && (!onlyNew || firstRun || failed.length)) {
    await Actor.pushData({
        rowType: 'note',
        note: `No jobs matched across ${sites.size} career site(s)${onlyNew ? ' that earlier runs had not already returned' : ''}. `
            + `${failed.length ? `Could not read: ${failed.map((f) => `${f.company} (${f.error})`).join('; ')}. ` : ''}`
            + `${unresolved.length ? `Not resolved: ${unresolved.map((u) => u.input).join(', ')}. ` : ''}Loosen the filters. Not charged.`,
    });
}

await Actor.setValue('SUMMARY', { sites: perSite, unresolved, jobs: pushed, charged });
log.info(`Done. ${pushed} job(s) from ${sites.size} site(s), ${charged} charged${failed.length ? `, ${failed.length} site(s) failed` : ''}.`);
await Actor.exit();

async function failInput(msg) {
    log.error(msg);
    await Actor.pushData({ rowType: 'note', note: `${msg} Not charged.` });
    await Actor.exit();
}
