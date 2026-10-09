// XING Jobs Scraper: jobs from XING (DACH's professional network) for any
// keyword and location, with salary, company, career level, discipline,
// industry, remote option, apply link and the full description.
//
// Strategy
// --------
// The logged-out job search page is backed by XING's public GraphQL endpoint
// (POST https://www.xing.com/graphql/api), field jobSearchByQuery(query,
// limit, offset). It returns VisibleJob objects with every field the job page
// shows, including description (HtmlDescription or TemplateData sections), so
// no per-job page request is needed.
//
// Paging is limit/offset with a hard window: limit + offset <= 1000. When a
// search fills that window and the caller asked for more, it is re-run once
// per career level (6 values), then per employment type inside a full career
// level, and rows are de-duplicated by job id. Filter ids are hashed
// ("FULL_TIME.ef2fe9"); the server rejects bare values, so the known ids are
// listed below.
//
// Some postings are geo-fenced: from IPs outside Europe/US they come back as
// UnauthorizedJob { reason: GEO_FENCED }. From Apify's IPs every job in the
// 2026-10-09 probe was visible. Fenced rows are skipped and counted.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   job ($0.001) one job with all fields and the description
// No start fee. A search with no results is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = 'https://www.xing.com/graphql/api';
const PAGE = 20;
const WINDOW = 1000;

const REMOTE = { FULL_REMOTE: 'FULL_REMOTE.050e26', PARTLY_REMOTE: 'PARTLY_REMOTE.ca71ca', NON_REMOTE: 'NON_REMOTE.3ca273' };
const EMPLOYMENT = {
    FULL_TIME: 'FULL_TIME.ef2fe9', PART_TIME: 'PART_TIME.58889d', CONTRACTOR: 'CONTRACTOR.0ed397', INTERN: 'INTERN.dc571c',
    SEASONAL: 'SEASONAL.e4ab1d', TEMPORARY: 'TEMPORARY.8ff6ad', VOLUNTARY: 'VOLUNTARY.c61099',
};
const CAREER = { STUDENT: '1.795d28', ENTRY: '2.24d1f6', PROFESSIONAL: '3.2ebf16', MANAGER: '4.83b992', EXECUTIVE: '5.6b837d', SENIOR_EXECUTIVE: '6.37d32d' };

const FIELDS = `id url title activatedAt refreshedAt activeUntil paid topJob redirectsToThirdPartyUrl language keywords jobCode remoteOptions
 location { city street zipCode region country { countryCode localizationValue } } locations { city }
 employmentType { localizationValue } careerLevel { localizationValue } discipline { localizationValue } industry { localizationValue }
 companyInfo { companyNameOverride company { id companyName links { public } } }
 salary { __typename ... on SalaryEstimate { currency minimum maximum median } ... on SalaryRange { currency minimum maximum } ... on Salary { currency amount } }
 application { __typename ... on UrlApplication { applyUrl } }
 summaryV2 { content { keyResponsibilities } }`;
const DESCRIPTION = `description { __typename ... on HtmlDescription { content } ... on TemplateData { genericDescription companyDescriptionTitle companyDescriptionContent responsibilityTitle responsibilityContent skillsTitle skillsContent weOfferTitle weOfferContent contactInfoTitle contactInfoContent } }`;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    queries = [],
    location = '',
    radiusKm = null,
    remoteOptions = [],
    employmentTypes = [],
    careerLevels = [],
    includeDescription = true,
    language = 'en',
    maxItemsPerSearch = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perSearch = Math.max(1, Number(maxItemsPerSearch) || 200);
const lang = language === 'de' ? 'de' : 'en';

async function gql(variables) {
    const query = `query JobSearch($q: JobSearchQueryInput!, $limit: Int, $offset: Int) { jobSearchByQuery(query: $q, limit: $limit, offset: $offset, consumer: "loggedout.web.jobs.conv_search_results.center", returnAggregations: false, searchMode: SEMANTIC) { collection { jobDetail { __typename ... on UnauthorizedJob { id reason } ... on VisibleJob { ${FIELDS} ${includeDescription ? DESCRIPTION : ''} } } } } }`;
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(API, {
                method: 'POST',
                headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': lang, Origin: 'https://www.xing.com', Referer: 'https://www.xing.com/jobs/search' },
                body: JSON.stringify({ operationName: 'JobSearch', variables, query }),
                signal: AbortSignal.timeout(45_000),
            });
            const d = await r.json().catch(() => null);
            if (d?.data?.jobSearchByQuery) return d.data.jobSearchByQuery.collection || [];
            const msg = d?.errors?.[0]?.message || `HTTP ${r.status}`;
            // Validation errors will not fix themselves on retry.
            if (d?.errors && r.status < 500 && !/timeout|unavailable/i.test(msg)) throw Object.assign(new Error(msg), { fatal: true });
            last = new Error(msg);
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// ---------- Searches ----------

const ALIAS = {
    REMOTE: 'FULL_REMOTE', FULLY_REMOTE: 'FULL_REMOTE', HYBRID: 'PARTLY_REMOTE', ONSITE: 'NON_REMOTE', ON_SITE: 'NON_REMOTE', OFFICE: 'NON_REMOTE',
    FULLTIME: 'FULL_TIME', PARTTIME: 'PART_TIME', FREELANCE: 'CONTRACTOR', SELF_EMPLOYED: 'CONTRACTOR', INTERNSHIP: 'INTERN', STUDENT_JOB: 'INTERN', TEMP: 'TEMPORARY', VOLUNTEER: 'VOLUNTARY',
    INTERN_STUDENT: 'STUDENT', ENTRY_LEVEL: 'ENTRY', JUNIOR: 'ENTRY', EXPERIENCED: 'PROFESSIONAL', MID: 'PROFESSIONAL', SENIOR: 'PROFESSIONAL', MANAGER_SUPERVISOR: 'MANAGER', VP: 'EXECUTIVE', C_LEVEL: 'SENIOR_EXECUTIVE',
};
const pick = (vals, map, label) => {
    const out = [];
    for (const v of list(vals)) {
        let k = String(v).toUpperCase().replace(/[\s/-]+/g, '_');
        if (!map[k] && ALIAS[k] && map[ALIAS[k]]) k = ALIAS[k];
        if (map[k]) out.push(map[k]);
        else if (Object.values(map).includes(v)) out.push(v);
        else log.warning(`Unknown ${label} "${v}" ignored. Use: ${Object.keys(map).join(', ')}`);
    }
    return out;
};

function buildFilter(remote, employment, career) {
    const f = {};
    if (remote.length) f.remoteOption = { id: remote };
    if (employment.length) f.employmentType = { id: employment };
    if (career.length) f.careerLevel = { id: career };
    return Object.keys(f).length ? f : undefined;
}

// https://www.xing.com/jobs/search?keywords=...&location=...&radius=...
function parseSearchUrl(u) {
    let url;
    try { url = new URL(u); } catch { return null; }
    if (!/(^|\.)xing\.com$/.test(url.hostname) || !url.pathname.startsWith('/jobs/search')) return null;
    const p = url.searchParams;
    const q = { keywords: p.get('keywords') || '' };
    if (p.get('location')) q.location = { text: p.get('location'), ...(p.get('radius') ? { radius: Number(p.get('radius')) } : {}) };
    const remote = p.getAll('remoteOption').flatMap((x) => x.split(','));
    const employment = p.getAll('employmentType').flatMap((x) => x.split(','));
    const career = p.getAll('careerLevel').flatMap((x) => x.split(','));
    return { q, remote, employment, career, label: u };
}

function buildSearches() {
    const out = [];
    for (const u of list(searchUrls)) {
        const s = parseSearchUrl(u);
        out.push(s || { error: `Not a XING job search URL (xing.com/jobs/search?...): ${u}` });
    }
    const remote = pick(remoteOptions, REMOTE, 'remote option');
    const employment = pick(employmentTypes, EMPLOYMENT, 'employment type');
    const career = pick(careerLevels, CAREER, 'career level');
    for (const kw of list(queries)) {
        const q = { keywords: kw };
        if (location) q.location = { text: location, ...(radiusKm ? { radius: Number(radiusKm) } : {}) };
        out.push({ q, remote, employment, career, label: `"${kw}"${location ? ` in ${location}${radiusKm ? ` +${radiusKm} km` : ''}` : ''}` });
    }
    if (!out.length && location) out.push({ q: { keywords: '', location: { text: location, ...(radiusKm ? { radius: Number(radiusKm) } : {}) } }, remote, employment, career, label: `all jobs in ${location}` });
    return out;
}

// All jobs of one filter combination, up to the 1,000 window.
async function* window(s, filter, stats) {
    for (let offset = 0; offset < WINDOW; offset += PAGE) {
        const coll = await gql({ q: { ...s.q, ...(filter ? { filter } : {}) }, limit: Math.min(PAGE, WINDOW - offset), offset });
        for (const c of coll) {
            const j = c.jobDetail;
            if (j?.__typename === 'VisibleJob') yield j;
            else stats.hidden += 1;
        }
        if (coll.length < PAGE) return;
        stats.full = offset + PAGE >= WINDOW;
        await sleep(250);
    }
}

async function* searchJobs(s, stats) {
    const base = buildFilter(s.remote, s.employment, s.career);
    let n = 0;
    for await (const j of window(s, base, stats)) { n += 1; yield j; }
    if (!stats.full || perSearch <= n) return;
    // The search has more than 1,000 jobs: walk it again per career level, and
    // per employment type inside any level that also fills the window.
    const careers = s.career.length ? s.career : Object.values(CAREER);
    log.info(`${s.label}: over 1,000 jobs, splitting by career level.`);
    for (const c of careers) {
        const st = { hidden: 0, full: false };
        for await (const j of window(s, buildFilter(s.remote, s.employment, [c]), st)) yield j;
        stats.hidden += st.hidden;
        if (!st.full || s.employment.length) continue;
        for (const e of Object.values(EMPLOYMENT)) {
            const st2 = { hidden: 0, full: false };
            for await (const j of window(s, buildFilter(s.remote, [e], [c]), st2)) yield j;
            stats.hidden += st2.hidden;
        }
    }
}

// ---------- Rows ----------

const decode = (s) => String(s || '').replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&shy;|­/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const toText = (h) => decode(String(h || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/ul|\/header|\/article)[^>]*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function description(d) {
    if (!d) return { descriptionText: null, descriptionHtml: null };
    if (d.__typename === 'HtmlDescription') return { descriptionText: toText(d.content) || null, descriptionHtml: d.content || null };
    if (d.__typename === 'TemplateData') {
        const parts = [
            [null, d.genericDescription], [d.companyDescriptionTitle, d.companyDescriptionContent], [d.responsibilityTitle, d.responsibilityContent],
            [d.skillsTitle, d.skillsContent], [d.weOfferTitle, d.weOfferContent], [d.contactInfoTitle, d.contactInfoContent],
        ].filter(([, c]) => c);
        const html = parts.map(([t, c]) => `${t ? `<h3>${t}</h3>` : ''}${c}`).join('\n');
        return { descriptionText: toText(html) || null, descriptionHtml: html || null };
    }
    return { descriptionText: null, descriptionHtml: null };
}

function row(j, search) {
    const sal = j.salary || {};
    const company = j.companyInfo?.company;
    return {
        jobId: j.id?.split('.')[0] || null,
        url: j.url,
        title: j.title,
        companyName: j.companyInfo?.companyNameOverride || company?.companyName || null,
        companyXingUrl: company?.links?.public || null,
        companyId: company?.id?.split('.')[0] || null,
        city: j.location?.city || null,
        region: j.location?.region || null,
        zipCode: j.location?.zipCode || null,
        street: j.location?.street || null,
        countryCode: j.location?.country?.countryCode || null,
        country: j.location?.country?.localizationValue || null,
        otherLocations: (j.locations || []).map((l) => l.city).filter((c) => c && c !== j.location?.city),
        remoteOptions: j.remoteOptions || [],
        employmentType: j.employmentType?.localizationValue || null,
        careerLevel: j.careerLevel?.localizationValue || null,
        discipline: j.discipline?.localizationValue || null,
        industry: j.industry?.localizationValue || null,
        salaryMin: sal.minimum ?? sal.amount ?? null,
        salaryMax: sal.maximum ?? sal.amount ?? null,
        salaryMedian: sal.median ?? null,
        salaryCurrency: sal.currency || null,
        salaryType: sal.__typename === 'SalaryEstimate' ? 'XING estimate' : sal.__typename === 'SalaryRange' ? 'range from employer' : sal.__typename === 'Salary' ? 'fixed from employer' : null,
        postedAt: j.activatedAt || null,
        refreshedAt: j.refreshedAt || null,
        expiresAt: j.activeUntil || null,
        applyUrl: j.application?.applyUrl || null,
        applyOnXing: j.application ? j.application.__typename !== 'UrlApplication' : null,
        redirectsToExternalSite: j.redirectsToThirdPartyUrl ?? null,
        keyResponsibilities: j.summaryV2?.content?.keyResponsibilities || [],
        keywords: j.keywords || [],
        language: j.language || null,
        isPaid: j.paid ?? null,
        isTopJob: j.topJob ?? null,
        jobCode: j.jobCode || null,
        ...(includeDescription ? description(j.description) : {}),
        search,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- Run ----------

let jobs = 0;
let keepGoing = true;
const failures = [];
const perSearchCounts = [];

async function charge() {
    try {
        const r = await Actor.charge({ eventName: 'job' });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const searches = buildSearches();
if (!searches.length) searches.push({ q: { keywords: 'engineer', location: { text: 'Berlin' } }, remote: [], employment: [], career: [], label: '"engineer" in Berlin' });
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
    const stats = { hidden: 0, full: false };
    try {
        for await (const j of searchJobs(s, stats)) {
            if (!keepGoing || count >= perSearch) break;
            const id = j.id?.split('.')[0];
            if (seen.has(id)) continue;
            seen.add(id);
            await Actor.pushData(row(j, s.label));
            jobs += 1;
            count += 1;
            if (!(await charge())) keepGoing = false;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ search: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${count} job(s)${stats.hidden ? `, ${stats.hidden} hidden by XING for this region` : ''}.`);
    perSearchCounts.push({ search: s.label, jobs: count, hiddenByXing: stats.hidden });
}

if (!jobs) await Actor.pushData({ rowType: 'note', note: 'No jobs matched. Not charged.' });
await Actor.setValue('SUMMARY', { jobs, searches: perSearchCounts, failures });
log.info(`Done. ${jobs} job(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
