// Welcome to the Jungle Jobs Scraper: jobs from any WTTJ search, past the
// 1,000-result cap, with optional full description and apply link.
//
// Strategy
// --------
// welcometothejungle.com searches jobs in Algolia with a public search-only
// key, published at /api/env (PUBLIC_ALGOLIA_APPLICATION_ID and
// PUBLIC_ALGOLIA_API_KEY_CLIENT; read at start so a rotated key is picked up).
// The key only answers with the site as Referer. Indexes:
//   wttj_jobs_production_en                    relevance
//   wttj_jobs_production_en_published_at_desc  newest first
// The site's refinementList[<attribute>][] URL parameters are Algolia facet
// filters, so a search URL copied from the browser works as input.
//
// Algolia returns at most 1,000 hits per query. Larger searches are split into
// published_at_timestamp windows (halved until each holds 1,000 or fewer) and
// read newest first.
//
// Job details come from api.welcometothejungle.com/api/v1/organizations/
// <org>/jobs/<slug>: full description, profile, recruitment process, skills,
// tools, office address, start date, apply URL.
//
// No key of our own, no proxy (2026-10-09 probe from Apify IPs).
//
// Pay per event
// -------------
//   job        ($0.002) one job from the search index
//   job_detail ($0.003) one job with its full description and apply link
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://www.welcometothejungle.com';
const CAP = 1000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    countries = [],
    cities = [],
    contractTypes = [],
    remote = [],
    languages = [],
    postedWithinDays = null,
    includeDetails = false,
    maxItemsPerSearch = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 1000);

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

// ---------- Algolia ----------

const algolia = { app: 'CSEKHVMS53', key: '4bd8f6215d0cc52b26430765769e65a0' };
try {
    const env = await fetchRetry(`${SITE}/api/env`, { headers: { 'User-Agent': UA } }, (r) => r.text());
    algolia.app = env.match(/"PUBLIC_ALGOLIA_APPLICATION_ID":"([^"]+)"/)?.[1] || algolia.app;
    algolia.key = env.match(/"PUBLIC_ALGOLIA_API_KEY_CLIENT":"([^"]+)"/)?.[1] || algolia.key;
} catch (err) { log.debug(`env: ${err?.message}`); }

async function query(index, params) {
    return fetchRetry(`https://${algolia.app}-dsn.algolia.net/1/indexes/${index}/query`, {
        method: 'POST',
        headers: { 'x-algolia-api-key': algolia.key, 'x-algolia-application-id': algolia.app, 'content-type': 'application/json', Referer: `${SITE}/`, Origin: SITE, 'User-Agent': UA },
        body: JSON.stringify(params),
    }, (r) => r.json());
}

// ---------- Searches ----------

// https://www.welcometothejungle.com/en/jobs?query=python&refinementList[offices.country_code][]=FR&refinementList[contract_type][]=full_time
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/welcometothejungle\.com$/.test(url.hostname)) return null;
    const facets = {};
    let q = '';
    let around = null;
    for (const [k, v] of url.searchParams) {
        const m = k.match(/^refinementList\[([^\]]+)\]/);
        if (m) (facets[m[1]] ||= []).push(v);
        else if (k === 'query') q = v;
        else if (k === 'aroundLatLng') around = { ...(around || {}), aroundLatLng: v };
        else if (k === 'aroundRadius') around = { ...(around || {}), aroundRadius: Number(v) || undefined };
    }
    return { q, facets, extra: around || {}, label: u };
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) out.push(parseSearchUrl(u) || { error: `Not a Welcome to the Jungle search URL: ${u}` });
    const facets = {};
    if (list(countries).length) facets['offices.country_code'] = list(countries).map((c) => c.toUpperCase());
    if (list(cities).length) facets['offices.city'] = list(cities);
    if (contractTypes.length) facets.contract_type = contractTypes;
    if (remote.length) facets.remote = remote;
    if (list(languages).length) facets.language = list(languages).map((l) => l.toLowerCase());
    const qs = list(queries);
    const desc = Object.entries(facets).map(([k, v]) => `${k.replace('offices.', '')}=${v.join('|')}`).join(' ');
    if (qs.length) for (const q of qs) out.push({ q, facets, extra: {}, label: `"${q}"${desc ? ` ${desc}` : ''}` });
    else if (Object.keys(facets).length) out.push({ q: '', facets, extra: {}, label: desc });
    return out;
}

const facetFilters = (facets) => Object.entries(facets).map(([k, vals]) => vals.map((v) => `${k}:${v}`));

// Time windows of 1,000 hits or fewer, newest first.
async function windows(s, from, to) {
    const base = { query: s.q, facetFilters: facetFilters(s.facets), ...s.extra, hitsPerPage: 0 };
    const count = async (a, b) => (await query('wttj_jobs_production_en', { ...base, numericFilters: [`published_at_timestamp>=${a}`, `published_at_timestamp<=${b}`] }))?.nbHits ?? 0;
    const out = [];
    const stack = [[from, to, await count(from, to)]];
    while (stack.length) {
        const [a, b, n] = stack.pop();
        if (!n) continue;
        if (n <= CAP || b - a < 60) { out.push([a, b, n]); continue; }
        const mid = Math.floor((a + b) / 2);
        const [nNew, nOld] = await Promise.all([count(mid + 1, b), count(a, mid)]);
        // Push older first so the newer half is processed first.
        stack.push([a, mid, nOld], [mid + 1, b, nNew]);
    }
    return out;
}

async function* searchJobs(s) {
    const now = Math.floor(Date.now() / 1000) + 3600;
    const from = postedWithinDays ? now - 3600 - Number(postedWithinDays) * 86400 : 0;
    const base = { query: s.q, facetFilters: facetFilters(s.facets), ...s.extra };
    const first = await query('wttj_jobs_production_en', { ...base, hitsPerPage: 0, numericFilters: [`published_at_timestamp>=${from}`] });
    const total = first?.nbHits ?? 0;
    log.info(`${s.label || 'all jobs'}: ${total} job(s).`);
    if (!total) return;
    const ranges = total <= CAP || perSearch <= CAP ? [[from, now, total]] : await windows(s, from, now);
    let n = 0;
    // Every window holds 1,000 hits or fewer, so one query reads it whole.
    for (const [a, b] of ranges) {
        const hitsPerPage = Math.min(CAP, perSearch - n);
        const d = await query('wttj_jobs_production_en_published_at_desc', { ...base, numericFilters: [`published_at_timestamp>=${a}`, `published_at_timestamp<=${b}`], hitsPerPage, page: 0, attributesToHighlight: [], attributesToSnippet: [] });
        for (const h of d?.hits || []) {
            if (n >= perSearch) return;
            n += 1;
            yield toRow(h);
        }
        if (n >= perSearch) return;
    }
}

// ---------- Rows ----------

const PERIOD = { yearly: 'year', monthly: 'month', daily: 'day', hourly: 'hour', weekly: 'week' };

function toRow(h) {
    const o = h.organization || {};
    const off = (h.offices || [])[0] || {};
    const geo = (h._geoloc || [])[0] || {};
    const p = h.new_profession || {};
    return {
        jobId: h.reference || h.objectID,
        title: h.name,
        url: o.slug && h.slug ? `${SITE}/en/companies/${o.slug}/jobs/${h.slug}` : null,
        companyName: o.name || null,
        companyUrl: o.slug ? `${SITE}/en/companies/${o.slug}` : null,
        companySlug: o.slug || null,
        companySize: o.nb_employees ?? null,
        companyFoundedYear: o.creation_year ?? null,
        companySummary: o.summary || null,
        companyLabels: o.labels || [],
        companyLogo: o.logo?.url || null,
        sectors: (h.sectors || []).map((x) => x.name).filter(Boolean),
        sectorGroups: [...new Set((h.sectors || []).map((x) => x.parent_name).filter(Boolean))],
        profession: p.pivot_name || null,
        professionCategory: p.category_name || null,
        professionSubcategory: p.sub_category_name || null,
        city: off.city || null,
        state: off.state || null,
        country: off.country || null,
        countryCode: off.country_code || null,
        latitude: geo.lat ?? null,
        longitude: geo.lng ?? null,
        offices: (h.offices || []).map((x) => [x.city, x.state, x.country].filter(Boolean).join(', ')).filter(Boolean),
        contractType: h.contract_type || null,
        contractDurationMinMonths: h.contract_duration_minimum ?? null,
        contractDurationMaxMonths: h.contract_duration_maximum ?? null,
        remote: h.remote || null,
        experienceMinYears: h.experience_level_minimum ?? null,
        educationLevel: h.education_level || null,
        salaryMin: h.salary_minimum ?? null,
        salaryMax: h.salary_maximum ?? null,
        salaryCurrency: h.salary_currency || null,
        salaryPeriod: PERIOD[h.salary_period] || h.salary_period || null,
        salaryYearlyMin: h.salary_yearly_minimum ?? null,
        language: h.language || null,
        publishedAt: h.published_at || null,
        summary: h.summary || null,
        keyMissions: h.key_missions || [],
        requirements: (h.profile || '').trim() || null,
        benefits: (h.benefits || []).map((b) => (typeof b === 'string' ? b : b?.name || b?.reference)).filter(Boolean),
    };
}

const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;| /g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function details(row) {
    const d = await fetchRetry(`https://api.welcometothejungle.com/api/v1/organizations/${row.companySlug}/jobs/${row.url.split('/jobs/')[1]}`,
        { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${SITE}/`, Origin: SITE } }, (r) => r.json());
    const j = d?.job || {};
    // Skills and tools come as strings, {name} or per-language {en, fr, ...}.
    const names = (a) => [...new Set((a || []).map((x) => (typeof x === 'string' ? x : x?.name || x?.value || x?.en || x?.fr || Object.values(x || {})[0])).filter((x) => typeof x === 'string' && x))];
    return {
        description: strip(j.description) || null,
        requirementsFull: strip(j.profile) || null,
        recruitmentProcess: strip(j.recruitment_process) || null,
        skills: names(j.skills),
        tools: names(j.tools),
        address: j.office?.address || null,
        startDate: j.start_date || null,
        updatedAt: j.updated_at || null,
        applyUrl: j.apply_url || null,
        ats: j.ats || null,
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

async function pool(rows, fn, width = 5) {
    const out = new Array(rows.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(width, rows.length) }, async () => {
        while (i < rows.length) { const k = i++; out[k] = await fn(rows[k]); }
    }));
    return out;
}

const searches = buildSearches();
if (!searches.length) searches.push({ q: 'data engineer', facets: {}, extra: {}, label: '"data engineer"' });
const seen = new Set();

for (const s of searches) {
    if (!keepGoing) break;
    if (s.error) {
        log.warning(s.error);
        failures.push({ error: s.error });
        await Actor.pushData({ rowType: 'error', error: `${s.error} Not charged.` });
        continue;
    }
    let count = 0;
    let batch = [];
    const flush = async () => {
        const extras = includeDetails ? await pool(batch, async (row) => {
            if (!row.url || !row.companySlug) return {};
            try { return await details(row); } catch (err) { return { detailError: String(err?.message || err) }; }
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
    try {
        for await (const row of searchJobs(s)) {
            if (!keepGoing) break;
            if (seen.has(row.jobId)) continue;
            seen.add(row.jobId);
            batch.push(row);
            if (batch.length >= 50) await flush();
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
