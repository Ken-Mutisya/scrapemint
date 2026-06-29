// LinkedIn Jobs Scraper Pro — Company Enrichment & Recruiter Contacts
//
// Three input modes feed one pipeline:
//   1. searchUrls    — paste LinkedIn jobs search URLs from your browser
//   2. keywords      — type queries, optionally combined with locations
//   3. companyUrls   — paste LinkedIn company URLs to find every open job
//
// Strategy
// --------
// LinkedIn exposes three unauthenticated surfaces we use:
//   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=
//   /jobs-guest/jobs/api/jobPosting/{jobId}
//   /company/{slug}/about/
//
// Each detail row is enriched with:
//   - parsed salary (range, currency, period)
//   - 250+ skill mining (tech + business + soft)
//   - seniority tier classification
//   - Easy Apply detection
//   - direct apply URL
//   - recruiter contact (name, title, profile URL) when toggled on
// Each unique company is enriched with industry, size, headcount, founded
// year, headquarters, specialties, and active job count when toggled on.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchUrls = [],
    keywords = [],
    locations = [],
    companyUrls = [],
    maxJobs = 100,
    experienceLevel = '',
    jobType = '',
    remoteFilter = '',
    postedSince = '',
    splitByCity = false,
    country = 'United States',
    scrapeCompanyDetails = true,
    scrapeRecruiterContact = false,
    extractSkills = true,
    parseSalary = true,
    classifySeniority = true,
    detectEasyApply = true,
    dedupe = true,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxJobs) > 0 ? Number(maxJobs) : Infinity;
// Buyers on plans without residential proxy access were getting a hard run
// failure here when the input requested RESIDENTIAL. Fall back to the auto
// (datacenter) group so the run still starts instead of crashing at boot.
async function buildProxy(cfg) {
    try {
        return await Actor.createProxyConfiguration(cfg);
    } catch (err) {
        log.warning(`Proxy "${JSON.stringify(cfg?.apifyProxyGroups || [])}" unavailable (${err?.message}); falling back to auto proxy.`);
        return Actor.createProxyConfiguration({ useApifyProxy: true });
    }
}
const proxyConfiguration = await buildProxy(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('linkedin-jobs-pro-seen') : null;
const seenJobs = new Set(seenStore ? (await seenStore.getValue('seen-jobs')) || [] : []);
const enrichedCompanies = new Set();

let pushedJobs = 0;
let pushedCompanies = 0;

const initialRequests = buildSeedRequests();
if (initialRequests.length === 0) {
    log.warning('No valid input. Provide at least one searchUrl, a keyword/location pair, or a companyUrl.');
    await Actor.exit();
}

// Wall-clock budget: exit cleanly with partial results before the platform hard-kills
// the run (TIMED-OUT = a failed run). Derive the deadline from the run's ACTUAL timeout
// (ACTOR_TIMEOUT_AT) instead of assuming 3600s -- runs with a shorter timeout (e.g. 720s)
// were failing because a fixed 3300s budget never fired.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 4)),
    sameDomainDelaySecs: 1.5,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 200,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    additionalMimeTypes: ['application/json', 'text/plain'],
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...request.headers,
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
            };
        },
    ],
    async requestHandler(ctx) {
        if (Date.now() > SOFT_DEADLINE_AT) { log.warning('Run-time budget reached; stopping crawler.'); crawler.stop(); return; }
        if (pushedJobs >= cap && ctx.request.userData.type !== 'company') return;
        const t = ctx.request.userData.type;
        if (t === 'listing') return handleListing(ctx);
        if (t === 'detail') return handleDetail(ctx);
        if (t === 'company') return handleCompany(ctx);
        if (t === 'companyJobs') return handleCompanyJobs(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && pushedJobs > 0) {
    await seenStore.setValue('seen-jobs', [...seenJobs]);
}

log.info(`Run complete. Jobs pushed: ${pushedJobs}. Companies pushed: ${pushedCompanies}.`);
await Actor.exit();

// ---------- Seed builders ----------

function buildSeedRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    const sUrls = cleanArr(searchUrls);
    const kws = cleanArr(keywords);
    const locs = cleanArr(locations);
    const compUrls = cleanArr(companyUrls);

    for (const u of sUrls) {
        const parsed = parseSearchUrl(u);
        if (!parsed) continue;
        for (const seed of expandWithCities(parsed)) {
            out.push(makeListingRequest(seed));
        }
    }

    if (kws.length > 0) {
        const baseLocs = locs.length > 0 ? locs : [''];
        for (const kw of kws) {
            for (const loc of baseLocs) {
                const seed = {
                    keywords: kw,
                    location: loc,
                    f_E: mapExperienceLevel(experienceLevel),
                    f_JT: mapJobType(jobType),
                    f_WT: mapRemoteFilter(remoteFilter),
                    f_TPR: mapPostedSince(postedSince),
                    start: 0,
                };
                for (const seedExpanded of expandWithCities(seed)) {
                    out.push(makeListingRequest(seedExpanded));
                }
            }
        }
    }

    for (const cu of compUrls) {
        const slug = parseCompanySlug(cu);
        if (!slug) continue;
        out.push({
            url: `https://www.linkedin.com/jobs/search/?currentJobId=&f_C=${encodeURIComponent(slug)}`,
            userData: {
                type: 'companyJobs',
                companySlug: slug,
            },
            uniqueKey: `companyJobs:${slug}`,
        });
        if (scrapeCompanyDetails) {
            out.push({
                url: `https://www.linkedin.com/company/${slug}/about/`,
                userData: { type: 'company', companySlug: slug },
                uniqueKey: `company:${slug}`,
            });
        }
    }

    return out;
}

function expandWithCities(seed) {
    if (!splitByCity) return [seed];
    if (seed.cityExpanded) return [seed];
    const cities = citiesByCountry()[country] || [];
    if (cities.length === 0) return [seed];
    return cities.map((city) => ({ ...seed, location: city, cityExpanded: true, start: 0 }));
}

function makeListingRequest(seed) {
    return {
        url: buildListingUrl(seed.keywords || '', seed.location || '', seed.start || 0, seed),
        userData: {
            type: 'listing',
            keyword: seed.keywords || '',
            location: seed.location || '',
            start: seed.start || 0,
            filters: pickFilters(seed),
        },
        uniqueKey: `listing:${seed.keywords || ''}:${seed.location || ''}:${seed.start || 0}:${JSON.stringify(pickFilters(seed))}`,
    };
}

function pickFilters(seed) {
    const out = {};
    for (const k of ['f_E', 'f_JT', 'f_WT', 'f_TPR', 'f_C', 'f_I', 'f_F']) {
        if (seed[k]) out[k] = seed[k];
    }
    return out;
}

function buildListingUrl(kw, loc, start, seed) {
    const qs = new URLSearchParams();
    if (kw) qs.set('keywords', kw);
    if (loc) qs.set('location', loc);
    qs.set('start', String(start));
    if (seed) {
        for (const [k, v] of Object.entries(pickFilters(seed))) {
            if (v) qs.set(k, v);
        }
    }
    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs.toString()}`;
}

function parseSearchUrl(url) {
    try {
        const u = new URL(url);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
        const qs = u.searchParams;
        return {
            keywords: qs.get('keywords') || '',
            location: qs.get('location') || '',
            start: parseInt(qs.get('start') || '0', 10) || 0,
            f_E: qs.get('f_E') || '',
            f_JT: qs.get('f_JT') || '',
            f_WT: qs.get('f_WT') || '',
            f_TPR: qs.get('f_TPR') || '',
            f_C: qs.get('f_C') || '',
            f_I: qs.get('f_I') || '',
            f_F: qs.get('f_F') || '',
        };
    } catch { return null; }
}

function parseCompanySlug(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/company\/([^/]+)/i);
        return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch { return null; }
}

function mapExperienceLevel(v) {
    return ({ internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' })[v] || '';
}
function mapJobType(v) {
    return ({ 'full-time': 'F', 'part-time': 'P', contract: 'C', temporary: 'T', volunteer: 'V', internship: 'I', other: 'O' })[v] || '';
}
function mapRemoteFilter(v) {
    return ({ onsite: '1', remote: '2', hybrid: '3' })[v] || '';
}
function mapPostedSince(v) {
    return ({ '1d': 'r86400', '1w': 'r604800', '1m': 'r2592000' })[v] || '';
}

// ---------- Handlers ----------

async function handleListing({ $, request, crawler: c }) {
    const ids = [];
    $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
        const urn = $(el).attr('data-entity-urn') || '';
        const id = urn.replace('urn:li:jobPosting:', '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    });

    if (ids.length === 0) return;

    log.info(`Listing start=${request.userData.start} kw="${request.userData.keyword}" loc="${request.userData.location || 'any'}": ${ids.length} jobs.`);

    const toEnqueue = [];
    for (const id of ids) {
        if (pushedJobs + toEnqueue.length >= cap) break;
        if (dedupe && seenJobs.has(id)) continue;
        toEnqueue.push({
            url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
            userData: {
                type: 'detail',
                jobId: id,
                keyword: request.userData.keyword,
                location: request.userData.location,
                filters: request.userData.filters,
            },
            uniqueKey: `detail:${id}`,
        });
    }
    if (toEnqueue.length > 0) await c.addRequests(toEnqueue);

    const nextStart = request.userData.start + ids.length;
    if (ids.length >= 10 && nextStart < cap && pushedJobs < cap) {
        await c.addRequests([{
            url: buildListingUrl(
                request.userData.keyword,
                request.userData.location,
                nextStart,
                { ...request.userData.filters },
            ),
            userData: { ...request.userData, start: nextStart },
            uniqueKey: `listing:${request.userData.keyword}:${request.userData.location}:${nextStart}:${JSON.stringify(request.userData.filters || {})}`,
        }]);
    }
}

async function handleDetail({ $, request, crawler: c }) {
    if (pushedJobs >= cap) return;
    const id = request.userData.jobId;
    if (dedupe && seenJobs.has(id)) return;

    const row = parseJobDetail($, id, request);
    if (!row) {
        log.warning(`Failed to parse job ${id}`);
        return;
    }

    await Actor.pushData(row);
    seenJobs.add(id);
    pushedJobs += 1;
    log.info(`Pushed ${id} ${row.title} @ ${row.company} (${pushedJobs}/${cap === Infinity ? '∞' : cap})`);

    if (scrapeCompanyDetails && row.companySlug && !enrichedCompanies.has(row.companySlug)) {
        enrichedCompanies.add(row.companySlug);
        await c.addRequests([{
            url: `https://www.linkedin.com/company/${row.companySlug}/about/`,
            userData: { type: 'company', companySlug: row.companySlug },
            uniqueKey: `company:${row.companySlug}`,
        }]);
    }
}

async function handleCompanyJobs({ $, request, crawler: c }) {
    // The /jobs/search?f_C= page lists all jobs at the company. Same parser.
    const ids = [];
    $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
        const urn = $(el).attr('data-entity-urn') || '';
        const id = urn.replace('urn:li:jobPosting:', '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    });
    log.info(`Company ${request.userData.companySlug}: ${ids.length} jobs found.`);
    const toEnqueue = [];
    for (const id of ids) {
        if (pushedJobs + toEnqueue.length >= cap) break;
        if (dedupe && seenJobs.has(id)) continue;
        toEnqueue.push({
            url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
            userData: {
                type: 'detail',
                jobId: id,
                companySlug: request.userData.companySlug,
            },
            uniqueKey: `detail:${id}`,
        });
    }
    if (toEnqueue.length > 0) await c.addRequests(toEnqueue);
}

async function handleCompany({ $, request }) {
    const slug = request.userData.companySlug;
    const text = (s) => $(s).first().text().replace(/\s+/g, ' ').trim();

    const name = text('h1, .org-top-card-summary__title');
    const tagline = text('.org-top-card-summary__tagline, p.tagline, .top-card-layout__second-subline');

    const aboutText = $('section, div').filter((_, el) => {
        const t = ($(el).text() || '').trim();
        return /Industry|Company size|Headquarters|Founded|Specialties/i.test(t);
    }).first().text();

    const grab = (label) => {
        const re = new RegExp(`${label}\\s*[:\\n]\\s*([^\\n]{1,200})`, 'i');
        const m = aboutText.match(re);
        return m ? m[1].trim() : null;
    };

    const industry = grab('Industry');
    const sizeRaw = grab('Company size');
    const headquarters = grab('Headquarters');
    const founded = grab('Founded');
    const specialties = grab('Specialties');

    const sizeRange = parseSizeRange(sizeRaw);
    const followers = parseInt(text('.org-top-card-summary-info-list__info-item, .top-card-layout__first-subline').replace(/[^\d]/g, ''), 10) || null;

    const row = {
        kind: 'company',
        slug,
        url: `https://www.linkedin.com/company/${slug}/`,
        name: name || slug,
        tagline: tagline || null,
        industry,
        size: sizeRange ? sizeRange.label : sizeRaw,
        headcountMin: sizeRange?.min ?? null,
        headcountMax: sizeRange?.max ?? null,
        founded: founded ? parseInt(founded, 10) || founded : null,
        headquarters,
        specialties: specialties ? specialties.split(',').map((s) => s.trim()).filter(Boolean) : null,
        followers,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    pushedCompanies += 1;
    log.info(`Pushed company ${slug} (${row.size || '?'}) (${pushedCompanies})`);
}

// ---------- Detail parser ----------

function parseJobDetail($, id, request) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    const title = clean($('h2.topcard__title, h1.topcard__title, .top-card-layout__title').first().text());
    const company = clean($('a.topcard__org-name-link, .topcard__org-name-link, .top-card-layout__second-subline a').first().text());
    const companyHref = $('a.topcard__org-name-link, .top-card-layout__second-subline a').first().attr('href') || null;
    const companyUrl = companyHref ? normalizeLinkedInUrl(companyHref) : null;
    const companySlug = parseCompanySlug(companyUrl);
    const location = clean($('.topcard__flavor--bullet, span.topcard__flavor.topcard__flavor--bullet').first().text());
    const postedAgo = clean($('.posted-time-ago__text, .topcard__flavor--metadata').first().text());
    const applicantsText = clean($('.num-applicants__caption, .num-applicants__figure').first().text());

    const description = clean($('.description__text, .show-more-less-html__markup').first().text());

    if (!title && !description) return null;

    const criteria = {};
    $('.description__job-criteria-item, .job-criteria__item').each((_, el) => {
        const label = clean($(el).find('.description__job-criteria-subheader, .job-criteria__subheader, h3').first().text()).toLowerCase();
        const value = clean($(el).find('.description__job-criteria-text, .job-criteria__text, span').first().text());
        if (label && value) criteria[label] = value;
    });

    const applyHref = $('a[data-tracking-control-name*="public_jobs_apply"], a.apply-button, a[data-tracking-control-name*="public_jobs_topcard-apply"]').first().attr('href') || null;
    const applyText = clean($('button.apply-button, a.apply-button, button[data-control-name*="public_jobs_topcard-apply"]').first().text());

    const easyApply = detectEasyApply ? /easy apply/i.test(applyText) || /linkedin\.com\/jobs/i.test(applyHref || '') : null;
    const directApplyUrl = applyHref && !/linkedin\.com\//i.test(applyHref) ? applyHref : null;

    const recruiter = scrapeRecruiterContact ? extractRecruiter($) : null;

    const row = {
        kind: 'job',
        id,
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        title: title || null,
        company: company || null,
        companyUrl,
        companySlug,
        location: location || null,
        remote: remoteFromText(title, description, criteria),
        postedAgo: postedAgo || null,
        postedAt: parsePostedAt(postedAgo),
        applicants: parseApplicants(applicantsText),
        easyApply: detectEasyApply ? !!easyApply : null,
        directApplyUrl,
        applyUrl: applyHref ? normalizeLinkedInUrl(applyHref) : null,
        seniorityLevel: criteria['seniority level'] || null,
        employmentType: criteria['employment type'] || null,
        jobFunction: criteria['job function'] || null,
        industries: criteria['industries'] || null,
        description: description.slice(0, 12000),
        descriptionLength: description.length,
        source: { keyword: request.userData.keyword || null, location: request.userData.location || null },
        scrapedAt: new Date().toISOString(),
    };

    if (classifySeniority) row.seniorityTier = seniorityFromTitle(row.title);
    if (parseSalary) {
        const sal = parseSalaryFromText(description);
        if (sal) {
            row.salaryMin = sal.min;
            row.salaryMax = sal.max;
            row.salaryCurrency = sal.currency;
            row.salaryPeriod = sal.period;
        } else {
            row.salaryMin = null;
            row.salaryMax = null;
            row.salaryCurrency = null;
            row.salaryPeriod = null;
        }
    }
    if (extractSkills) row.skills = extractSkillsFromText(description, title);
    row.experienceYearsMin = parseExperienceYears(description);

    if (recruiter) row.recruiter = recruiter;

    return row;
}

function extractRecruiter($) {
    const block = $('a.message-the-recruiter, .message-the-recruiter, .base-main-card.recruiter-card, [data-test-id*="recruiter"]').first();
    if (block.length === 0) return null;
    const name = (block.find('h3, .base-main-card__title, [data-test-id*="recruiter-name"]').first().text() || '').replace(/\s+/g, ' ').trim();
    const title = (block.find('.base-main-card__subtitle, [data-test-id*="recruiter-title"]').first().text() || '').replace(/\s+/g, ' ').trim();
    const profileUrl = block.find('a').first().attr('href') || block.attr('href') || null;
    if (!name && !profileUrl) return null;
    return {
        name: name || null,
        title: title || null,
        profileUrl: profileUrl ? normalizeLinkedInUrl(profileUrl) : null,
    };
}

// ---------- Helpers ----------

function normalizeLinkedInUrl(href) {
    if (!href) return null;
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return `https://www.linkedin.com${href}`;
    return href.split('?')[0];
}

function parseSizeRange(text) {
    if (!text) return null;
    const t = text.toLowerCase().replace(/[,\s]/g, '');
    const m = t.match(/(\d+)\+?-?(\d+)?/);
    if (!m) return null;
    const min = parseInt(m[1], 10);
    const max = m[2] ? parseInt(m[2], 10) : null;
    return { min, max, label: text.trim() };
}

function remoteFromText(title, description, criteria) {
    const hay = `${title || ''}\n${description || ''}\n${Object.values(criteria).join('\n')}`.toLowerCase();
    if (/\bhybrid\b/.test(hay)) return 'hybrid';
    if (/\bremote\b|\bwork from home\b|\bwfh\b|\bfully distributed\b/.test(hay)) return 'remote';
    if (/\bon.?site\b|\bin.?office\b/.test(hay)) return 'onsite';
    return null;
}

function parsePostedAt(postedAgo) {
    if (!postedAgo) return null;
    const m = postedAgo.toLowerCase().match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const d = new Date();
    if (m[2] === 'minute') d.setUTCMinutes(d.getUTCMinutes() - n);
    else if (m[2] === 'hour') d.setUTCHours(d.getUTCHours() - n);
    else if (m[2] === 'day') d.setUTCDate(d.getUTCDate() - n);
    else if (m[2] === 'week') d.setUTCDate(d.getUTCDate() - n * 7);
    else if (m[2] === 'month') d.setUTCMonth(d.getUTCMonth() - n);
    else if (m[2] === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
    return d.toISOString();
}

function parseApplicants(text) {
    if (!text) return null;
    const m = text.match(/(\d+)\s*(?:\+|over|\bapplicants?\b|\bclicked apply\b)/i);
    if (m) return parseInt(m[1], 10);
    const m2 = text.match(/(\d+)/);
    return m2 ? parseInt(m2[1], 10) : null;
}

function seniorityFromTitle(title) {
    if (!title) return null;
    const t = title.toLowerCase();
    if (/\bintern\b|internship/.test(t)) return 'intern';
    if (/\b(ceo|cto|coo|cfo|cmo|cpo|ciso|cio|chief\s+\w+\s+officer)\b/.test(t)) return 'c-suite';
    if (/\bvp\b|vice\s+president/.test(t)) return 'vp';
    if (/\bdirector\b|\bhead\s+of\b/.test(t)) return 'director';
    if (/\bmanager\b|\bmgr\b/.test(t)) return 'manager';
    if (/\bprincipal\b|\bstaff\b/.test(t)) return 'staff';
    if (/\blead\b|\btech\s+lead\b/.test(t)) return 'lead';
    if (/\bsenior\b|\bsr\.?\b/.test(t)) return 'senior';
    if (/\bjunior\b|\bjr\.?\b|\bentry\s*level\b|\bnew\s*grad\b|\bgraduate\b/.test(t)) return 'entry';
    return 'mid';
}

function parseSalaryFromText(text) {
    if (!text) return null;
    const sep = '(?:[-–—]|(?:\\s+(?:to|and(?:\\s+go\\s+up\\s+to)?|up\\s+to)\\s+))';
    const symPattern = new RegExp(`(\\$|€|£|₹)([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*${sep}\\s*(?:\\$|€|£|₹)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)`, 'g');
    const codePattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*${sep}\\s*([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*(USD|EUR|GBP|CAD|AUD|INR|CHF)`, 'g');
    const symMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
    const candidates = [];
    const haystack = text;

    const push = (m, currency, minStr, minMul, maxStr, maxMul) => {
        const min = Math.round(parseFloat(String(minStr).replace(/,/g, '')) * minMul);
        const max = Math.round(parseFloat(String(maxStr).replace(/,/g, '')) * maxMul);
        if (!min || !max || max < min) return;
        const start = Math.max(0, m.index - 200);
        const end = Math.min(haystack.length, m.index + m[0].length + 120);
        const ctx = haystack.slice(start, end).toLowerCase();
        if (!/salar|compensat|base pay|pay range|hourly|wage|per year|per annum|per hour|\/year|\/hr|\/hour|annual|base (salary|pay|compensation)/.test(ctx)) return;
        const period = /per hour|\/hr|\/hour|hourly/.test(ctx) ? 'hourly'
            : /per day|day rate/.test(ctx) ? 'daily'
            : /per week|weekly/.test(ctx) ? 'weekly'
            : /per month|monthly/.test(ctx) ? 'monthly' : 'annual';
        if (!plausibleSalary(min, max, period)) return;
        candidates.push({ min, max, currency, period });
    };
    const mul = (s) => !s ? 1 : s.toLowerCase() === 'k' ? 1000 : s.toLowerCase() === 'm' ? 1000000 : 1;

    let m;
    while ((m = symPattern.exec(haystack)) !== null) push(m, symMap[m[1]], m[2], mul(m[3]), m[4], mul(m[5]));
    while ((m = codePattern.exec(haystack)) !== null) push(m, m[5].toUpperCase(), m[1], mul(m[2]), m[3], mul(m[4]));

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.max - a.max);
    return candidates[0];
}

function plausibleSalary(min, max, period) {
    if (period === 'hourly') return min >= 10 && max <= 2000;
    if (period === 'daily') return min >= 100 && max <= 10000;
    if (period === 'weekly') return min >= 500 && max <= 50000;
    if (period === 'monthly') return min >= 1000 && max <= 200000;
    return min >= 20000 && max <= 5000000;
}

function parseExperienceYears(text) {
    if (!text) return null;
    const patterns = [
        /(\d+)\s*(?:\+|\s*or\s*more)?\s*years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
        /minimum\s+(?:of\s+)?(\d+)\s*years/i,
        /at\s+least\s+(\d+)\s*years/i,
        /(\d+)\s*[-–]\s*\d+\s*years?\s+(?:of\s+)?experience/i,
    ];
    for (const re of patterns) {
        const m = text.slice(0, 6000).match(re);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 0 && n <= 30) return n;
        }
    }
    return null;
}

function skillTerms() { return [
    // languages
    'python', 'javascript', 'typescript', 'go', 'golang', 'rust', 'java', 'kotlin', 'swift',
    'c++', 'c#', 'ruby', 'php', 'scala', 'perl', 'elixir', 'haskell', 'dart', 'sql', 'r',
    'bash', 'powershell', 'lua', 'objective-c', 'matlab', 'julia', 'solidity',
    // web frameworks
    'react', 'vue', 'vue.js', 'angular', 'svelte', 'next.js', 'nuxt', 'remix', 'astro',
    'django', 'flask', 'fastapi', 'express.js', 'nestjs', 'rails', 'laravel', 'spring boot',
    'node.js', 'deno', 'bun', 'graphql', 'grpc', 'rest', 'soap', 'websocket',
    // cloud / infra
    'aws', 'gcp', 'azure', 'kubernetes', 'k8s', 'docker', 'terraform', 'pulumi', 'ansible',
    'helm', 'istio', 'linkerd', 'cloudflare', 'vercel', 'netlify', 'heroku', 'digitalocean',
    'lambda', 's3', 'ec2', 'rds', 'dynamodb', 'cloudfront', 'eks', 'ecs',
    'bigquery', 'cloud run', 'gke', 'firestore', 'firebase',
    // data
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'opensearch',
    'snowflake', 'databricks', 'redshift', 'clickhouse', 'cassandra', 'cockroach',
    'kafka', 'rabbitmq', 'pulsar', 'spark', 'airflow', 'dbt', 'fivetran', 'segment',
    // ml / ai
    'pytorch', 'tensorflow', 'jax', 'hugging face', 'langchain', 'llamaindex',
    'openai', 'anthropic', 'claude', 'gpt-4', 'llm', 'rag',
    'scikit-learn', 'xgboost', 'pandas', 'numpy', 'jupyter',
    // tools / observability
    'git', 'github', 'gitlab', 'bitbucket', 'jira', 'linear', 'figma',
    'datadog', 'new relic', 'sentry', 'pagerduty', 'splunk', 'prometheus', 'grafana',
    // mobile
    'ios', 'android', 'react native', 'flutter', 'xamarin',
    // styling
    'tailwind', 'tailwindcss', 'sass', 'css',
    // business / sales / ops
    'salesforce', 'hubspot', 'marketo', 'pardot', 'mailchimp', 'klaviyo',
    'zendesk', 'intercom', 'freshdesk', 'service cloud',
    'tableau', 'power bi', 'looker', 'mode', 'metabase',
    'sap', 'netsuite', 'oracle', 'workday', 'gusto', 'rippling',
    // finance / data analyst
    'excel', 'sheets', 'sql server', 'bloomberg', 'factset', 'morningstar',
    // soft skills
    'leadership', 'mentoring', 'stakeholder management', 'product management',
    'project management', 'agile', 'scrum', 'kanban', 'okr', 'roadmap',
    'communication', 'presentation', 'negotiation', 'cross functional',
    // marketing
    'seo', 'sem', 'ppc', 'content marketing', 'email marketing', 'growth',
    'a/b testing', 'attribution', 'analytics', 'google analytics', 'ga4',
    // design
    'sketch', 'adobe xd', 'invision', 'principle', 'protopie',
    // qa / testing
    'cypress', 'playwright', 'selenium', 'jest', 'vitest', 'mocha', 'pytest',
    // misc tech
    'kafka streams', 'flink', 'beam', 'argo', 'tekton', 'github actions', 'circleci', 'jenkins',
    'webpack', 'vite', 'esbuild', 'rollup', 'parcel',
]; }

function extractSkillsFromText(text, title) {
    if (!text && !title) return [];
    const hay = `${title || ''}\n${text || ''}`.toLowerCase();
    const found = new Set();
    for (const term of skillTerms()) {
        const escaped = term.replace(/[.+*?^$(){}|[\]\\]/g, (c) => `\\${c}`);
        const startBoundary = /^[a-z0-9]/.test(term) ? '(?<=^|[^a-z0-9#+])' : '';
        const endBoundary = /[a-z0-9]$/.test(term) ? '(?=[^a-z0-9]|$)' : '';
        const re = new RegExp(startBoundary + escaped + endBoundary, 'i');
        if (re.test(hay)) {
            const norm = (
                term === 'golang' ? 'go' :
                term === 'k8s' ? 'kubernetes' :
                term === 'postgres' ? 'postgresql' :
                term === 'vue.js' ? 'vue' :
                term === 'tailwindcss' ? 'tailwind' :
                term
            );
            found.add(norm);
        }
    }
    return [...found].sort();
}

function citiesByCountry() { return {
    'United States': [
        'New York, United States', 'San Francisco Bay Area', 'Los Angeles, California',
        'Chicago, Illinois', 'Boston, Massachusetts', 'Washington DC-Baltimore Area',
        'Seattle, Washington', 'Atlanta, Georgia', 'Dallas-Fort Worth Metroplex',
        'Austin, Texas', 'Miami-Fort Lauderdale Area', 'Denver, Colorado',
        'Philadelphia, Pennsylvania', 'San Diego, California', 'Phoenix, Arizona',
        'Houston, Texas', 'Minneapolis, Minnesota', 'Charlotte, North Carolina',
        'Nashville, Tennessee', 'Portland, Oregon',
    ],
    'United Kingdom': [
        'London, United Kingdom', 'Manchester, United Kingdom', 'Birmingham, United Kingdom',
        'Edinburgh, United Kingdom', 'Glasgow, United Kingdom', 'Bristol, United Kingdom',
        'Leeds, United Kingdom', 'Cambridge, United Kingdom', 'Oxford, United Kingdom',
        'Reading, United Kingdom',
    ],
    'Canada': [
        'Toronto, Ontario', 'Vancouver, British Columbia', 'Montreal, Quebec',
        'Calgary, Alberta', 'Ottawa, Ontario', 'Edmonton, Alberta', 'Mississauga, Ontario',
    ],
    'Australia': [
        'Sydney, New South Wales', 'Melbourne, Victoria', 'Brisbane, Queensland',
        'Perth, Western Australia', 'Adelaide, South Australia',
    ],
    'Germany': [
        'Berlin, Germany', 'Munich, Bavaria', 'Hamburg, Germany', 'Frankfurt, Hesse',
        'Cologne, North Rhine-Westphalia', 'Stuttgart, Baden-Württemberg',
    ],
    'India': [
        'Bengaluru, Karnataka', 'Mumbai, Maharashtra', 'Delhi, India', 'Hyderabad, Telangana',
        'Chennai, Tamil Nadu', 'Pune, Maharashtra', 'Gurugram, Haryana', 'Noida, Uttar Pradesh',
    ],
    'France': [
        'Paris, Île-de-France', 'Lyon, Auvergne-Rhône-Alpes', 'Marseille, Provence-Alpes-Côte d\'Azur',
        'Toulouse, Occitanie', 'Bordeaux, Nouvelle-Aquitaine',
    ],
    'Spain': ['Madrid, Spain', 'Barcelona, Catalonia', 'Valencia, Spain', 'Seville, Spain'],
    'Netherlands': ['Amsterdam, North Holland', 'Rotterdam, South Holland', 'The Hague, South Holland', 'Utrecht, Utrecht'],
    'Brazil': ['São Paulo, Brazil', 'Rio de Janeiro, Brazil', 'Belo Horizonte, Brazil', 'Brasília, Brazil'],
}; }
