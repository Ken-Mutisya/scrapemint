// Indeed Jobs Scraper Pro
//
// Scrape Indeed jobs from keywords, search URLs, direct job IDs, and company
// pages. Each row ships parsed salary, skills, seniority tier, remote/hybrid
// signal, Easy Apply flag, sponsored flag, and optional company enrichment.
//
// Strategy
// --------
// 1. Build initial requests from keywords x locations + direct URLs + jobIds
//    + company pages. Each becomes a typed request.
// 2. Listing handler reads window._initialData (or mosaic-data script) and
//    pulls every job card. Pagination follows the next-page link until cap.
// 3. Job detail handler reads the same _initialData on viewjob pages to
//    extract description, applyLink, employer signals.
// 4. Company enrichment fires once per distinct company page.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const COUNTRY_HOST = {
    US: 'www.indeed.com',
    GB: 'uk.indeed.com',
    CA: 'ca.indeed.com',
    AU: 'au.indeed.com',
    IE: 'ie.indeed.com',
    DE: 'de.indeed.com',
    FR: 'fr.indeed.com',
    IT: 'it.indeed.com',
    ES: 'es.indeed.com',
    NL: 'nl.indeed.com',
    BE: 'be.indeed.com',
    IN: 'in.indeed.com',
    JP: 'jp.indeed.com',
    SG: 'sg.indeed.com',
    BR: 'br.indeed.com',
    MX: 'mx.indeed.com',
    ZA: 'za.indeed.com',
    AE: 'ae.indeed.com',
};
const HOST_TO_COUNTRY = Object.fromEntries(Object.entries(COUNTRY_HOST).map(([k, v]) => [v, k]));

const TOP_CITIES_BY_COUNTRY = {
    US: ['New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ', 'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'San Jose, CA', 'Austin, TX', 'Seattle, WA', 'Boston, MA', 'Atlanta, GA', 'Denver, CO'],
    GB: ['London', 'Manchester', 'Birmingham', 'Glasgow', 'Edinburgh', 'Leeds', 'Bristol', 'Liverpool', 'Sheffield', 'Cardiff'],
    CA: ['Toronto, ON', 'Montreal, QC', 'Vancouver, BC', 'Calgary, AB', 'Ottawa, ON', 'Edmonton, AB'],
    DE: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart', 'Düsseldorf'],
    AU: ['Sydney NSW', 'Melbourne VIC', 'Brisbane QLD', 'Perth WA', 'Adelaide SA'],
    IN: ['Bengaluru, Karnataka', 'Mumbai, Maharashtra', 'Delhi', 'Hyderabad, Telangana', 'Chennai, Tamil Nadu', 'Pune, Maharashtra', 'Gurgaon, Haryana'],
};

const TECH_SKILLS = [
    'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'go', 'golang', 'rust', 'c++', 'c#', 'csharp', 'php', 'ruby', 'scala', 'elixir', 'dart',
    'react', 'react.js', 'vue', 'vue.js', 'angular', 'next.js', 'nuxt', 'svelte', 'remix', 'astro', 'flutter', 'react native', 'ios', 'android',
    'node.js', 'deno', 'bun', 'express', 'fastapi', 'django', 'flask', 'rails', 'spring', 'spring boot', 'laravel', 'symfony',
    'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'ansible', 'jenkins', 'github actions', 'gitlab ci', 'circleci',
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'cassandra', 'dynamodb', 'snowflake', 'bigquery', 'redshift', 'clickhouse', 'elasticsearch',
    'kafka', 'rabbitmq', 'graphql', 'rest', 'grpc', 'websocket',
    'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy', 'spark', 'hadoop', 'airflow', 'dbt',
    'figma', 'sketch', 'photoshop', 'illustrator', 'after effects', 'premiere',
    'salesforce', 'hubspot', 'marketo', 'mailchimp', 'pardot', 'zendesk', 'jira', 'confluence', 'slack', 'asana', 'notion',
    'sql', 'tableau', 'power bi', 'looker', 'metabase', 'superset', 'domo',
    'seo', 'sem', 'google ads', 'meta ads', 'tiktok ads', 'paid media',
    'project management', 'product management', 'agile', 'scrum', 'kanban', 'okrs',
    'b2b', 'b2c', 'saas', 'fintech', 'healthtech', 'edtech',
];

const SENIORITY_PATTERNS = [
    { label: 'c_level', regex: /\b(ceo|cfo|cto|cmo|coo|chief\s+\w+\s+officer)\b/i },
    { label: 'vp', regex: /\b(vp|vice\s+president|svp|evp)\b/i },
    { label: 'director', regex: /\bdirector\b/i },
    { label: 'head', regex: /\bhead\s+of\b/i },
    { label: 'principal', regex: /\bprincipal\b/i },
    { label: 'staff', regex: /\bstaff\b/i },
    { label: 'lead', regex: /\b(lead|leader|tech\s+lead|team\s+lead)\b/i },
    { label: 'manager', regex: /\b(manager|management|engineering\s+manager|product\s+manager)\b/i },
    { label: 'senior', regex: /\b(senior|sr\.|sr )\b/i },
    { label: 'mid', regex: /\b(mid[-\s]?level|intermediate)\b/i },
    { label: 'entry', regex: /\b(junior|jr\.|jr |entry[-\s]?level|associate)\b/i },
    { label: 'intern', regex: /\b(intern|internship|co[-\s]?op)\b/i },
];

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    locations = [],
    country = 'US',
    searchUrls = [],
    jobIds = [],
    companyUrls = [],

    maxJobs = 25,
    datePosted = 'any',
    jobType = 'any',
    experienceLevel = 'any',
    remoteFilter = 'any',
    minSalary = 0,
    radius = 25,
    splitByCity = false,

    scrapeCompanyDetails = false,
    extractSkills = true,
    parseSalary = true,
    classifySeniority = true,
    detectEasyApply = true,
    detectRemoteHybrid = true,
    followApplyRedirect = false,
    // Defaults to false. This is a search tool, not a monitor: a buyer who
    // repeats a query wants the full result set again, and the dedupe key is an
    // immutable id, so `true` suppressed each item permanently after its first
    // appearance. Verified 2026-08-11 by re-running each actor on its own
    // prefill against a warm store. Set it to true deliberately to poll for
    // new items only, accepting that a run finding nothing new returns no rows.

    dedupe = false,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

// Pin the residential exit node to the Indeed host country. A US job board hit
// from a random global residential IP is exactly the mismatch Cloudflare scores
// against; geo-matching the exit drops the challenge rate on deep pages (/cmp/).
const proxyOpts = proxyInput ? { ...proxyInput } : { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
if (proxyOpts.useApifyProxy !== false
    && Array.isArray(proxyOpts.apifyProxyGroups)
    && proxyOpts.apifyProxyGroups.includes('RESIDENTIAL')
    && !proxyOpts.apifyProxyCountry
    && /^[A-Z]{2}$/.test(country)) {
    proxyOpts.apifyProxyCountry = country;
}
const proxyConfiguration = await Actor.createProxyConfiguration(proxyOpts);
const seenStore = dedupe ? await Actor.openKeyValueStore('indeed-jobs-seen') : null;
const seenJobIds = new Set(seenStore ? (await seenStore.getValue('seen-job-ids')) || [] : []);
const seenCompanies = new Set();
const cap = Number(maxJobs) > 0 ? Number(maxJobs) : Infinity;
let pushedRows = 0;

const initial = buildInitialRequests();
if (initial.length === 0) {
    log.warning('No valid input. Provide keywords + locations, searchUrls, jobIds, or companyUrls.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

// Wall-clock budget: exit cleanly with partial results before the 3600s platform
// timeout (anti-bot throttling can otherwise run a big query set to a TIMED-OUT).
const RUN_START = Date.now();
const MAX_RUN_MS = 3300 * 1000;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 3)),
    headless: true,
    // Real Indeed pages load in ~5s; only antibot-challenged requests run long.
    // Keep these tight so a blocked /cmp/ page fails fast (was 60/150/3, which
    // let each blocked request burn up to ~10 min and stall dependent pipelines).
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 45,
    maxRequestRetries: 1,
    retryOnBlocked: false,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 80,
        sessionOptions: { maxUsageCount: 20 },
        blockedStatusCodes: [],
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                operatingSystems: ['macos', 'windows', 'linux'],
                locales: ['en-US'],
            },
        },
    },
    preNavigationHooks: [
        async ({ page, session, request }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 90000;

            // Job and company pages are reached by following a link mid-crawl, so
            // they should carry a same-origin referer. Sending Sec-Fetch-Site:none
            // (a typed/address-bar visit) for a deep /cmp/ page is itself a tell.
            const reqType = request.userData?.type;
            const host = request.userData?.host || COUNTRY_HOST[country] || COUNTRY_HOST.US;
            const linkedNav = reqType === 'company' || reqType === 'job';
            const referer = request.userData?.originatingStartUrl || `https://${host}/`;
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': linkedNav ? 'same-origin' : 'none',
                'Sec-Fetch-User': '?1',
                ...(linkedNav ? { 'Referer': referer } : {}),
            });

            // Company pages are the most aggressively protected; stagger them with a
            // short random delay so a burst of /cmp/ hits doesn't trip rate scoring.
            if (reqType === 'company') {
                await page.waitForTimeout(700 + Math.floor(Math.random() * 1600));
            }

            // Session warmup: hit homepage once per session to set Cloudflare cookies.
            if (session && !session.userData?.warmed) {
                try {
                    await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
                    await passCloudflareIfPresent(page);
                    session.userData = { ...session.userData, warmed: true };
                } catch {}
            }
        },
    ],
    async requestHandler(ctx) {
        if (Date.now() - RUN_START > MAX_RUN_MS) { log.warning('Run-time budget reached; finishing with partial results.'); return; }
        const t = ctx.request.userData?.type;
        if (t === 'listing') return handleListing(ctx);
        if (t === 'job') return handleJob(ctx);
        if (t === 'company') return handleCompany(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initial);
await crawler.run();

if (seenStore && pushedRows > 0) await seenStore.setValue('seen-job-ids', [...seenJobIds]);

log.info(`Run complete. Jobs pushed: ${pushedRows}.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Seed builders ----------

function buildInitialRequests() {
    const out = [];
    const cleanArr = (arr) => Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.url || v?.value || '')).map((v) => String(v).trim()).filter(Boolean)
        : [];

    const kws = cleanArr(keywords);
    let locs = cleanArr(locations);
    const directSearchUrls = cleanArr(searchUrls);
    const directJobIds = cleanArr(jobIds);
    const directCompanyUrls = cleanArr(companyUrls);

    if (splitByCity && (locs.length === 0)) {
        const cities = TOP_CITIES_BY_COUNTRY[country] || [];
        locs = cities;
    }
    if (locs.length === 0) locs = [''];

    for (const kw of kws) {
        for (const loc of locs) {
            out.push(makeListingRequest({ keyword: kw, location: loc }));
        }
    }

    for (const url of directSearchUrls) {
        const parsed = parseIndeedUrl(url);
        if (parsed?.kind === 'listing') {
            out.push({
                url,
                userData: { type: 'listing', searchUrl: url, host: parsed.host, sourceKey: `listing:${url}` },
                uniqueKey: `listing:${url}`,
            });
        } else if (parsed?.kind === 'job') {
            out.push(makeJobRequest(parsed.jk, parsed.host, url));
        } else if (parsed?.kind === 'company') {
            out.push(makeCompanyRequest(parsed.companySlug, parsed.host, url));
        }
    }

    for (const id of directJobIds) {
        const cleaned = String(id).trim().split('?')[0];
        if (/^[a-f0-9]{12,20}$/i.test(cleaned)) {
            out.push(makeJobRequest(cleaned, COUNTRY_HOST[country] || COUNTRY_HOST.US, null));
        }
    }

    for (const url of directCompanyUrls) {
        const parsed = parseIndeedUrl(url);
        if (parsed?.kind === 'company') {
            out.push(makeCompanyRequest(parsed.companySlug, parsed.host, url));
        }
    }

    return out;
}

function makeListingRequest({ keyword, location }) {
    const host = COUNTRY_HOST[country] || COUNTRY_HOST.US;
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (location) params.set('l', location);
    if (datePosted && datePosted !== 'any') params.set('fromage', datePosted);
    if (jobType && jobType !== 'any') params.set('jt', jobType);
    if (experienceLevel && experienceLevel !== 'any') params.set('explvl', experienceLevel);
    if (remoteFilter === 'remote') params.set('remotejob', '1');
    if (Number(minSalary) > 0) params.set('salary', String(Math.floor(minSalary)));
    if (Number(radius) >= 0) params.set('radius', String(Math.floor(radius)));

    const url = `https://${host}/jobs?${params.toString()}`;
    const sourceKey = `listing:${keyword}:${location}`;
    return {
        url,
        userData: { type: 'listing', keyword, location, host, sourceKey, page: 0 },
        uniqueKey: sourceKey,
    };
}

function makeJobRequest(jk, host, originatingUrl) {
    return {
        url: `https://${host}/viewjob?jk=${jk}`,
        userData: { type: 'job', jk, host, originatingStartUrl: originatingUrl || null },
        uniqueKey: `job:${host}:${jk}`,
    };
}

function makeCompanyRequest(companySlug, host, originatingUrl) {
    return {
        url: `https://${host}/cmp/${companySlug}`,
        userData: { type: 'company', companySlug, host, originatingStartUrl: originatingUrl || null },
        uniqueKey: `company:${host}:${companySlug}`,
    };
}

function parseIndeedUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        const fullHost = host.startsWith('uk.') || host.startsWith('ca.') || host.startsWith('au.') || host.startsWith('de.') || host.startsWith('fr.') || host.startsWith('it.') || host.startsWith('es.') || host.startsWith('nl.') || host.startsWith('be.') || host.startsWith('in.') || host.startsWith('jp.') || host.startsWith('sg.') || host.startsWith('br.') || host.startsWith('mx.') || host.startsWith('za.') || host.startsWith('ae.') || host.startsWith('ie.')
            ? host
            : (host === 'indeed.com' ? 'www.indeed.com' : host);
        if (!Object.values(COUNTRY_HOST).includes(fullHost)) return null;

        const path = u.pathname;
        if (path === '/viewjob' || path === '/viewjob/') {
            const jk = u.searchParams.get('jk');
            if (jk) return { kind: 'job', jk, host: fullHost };
        }
        let m = path.match(/^\/cmp\/([^/]+)/);
        if (m) return { kind: 'company', companySlug: m[1], host: fullHost };
        if (path === '/jobs' || path === '/jobs/') return { kind: 'listing', host: fullHost };
        if (path === '/q-' || /^\/q-/.test(path) || /^\/jobs-in-/.test(path)) return { kind: 'listing', host: fullHost };
        return null;
    } catch { return null; }
}

// ---------- Listing handler ----------

async function handleListing({ page, request, crawler: c }) {
    if (pushedRows >= cap) return;

    await page.waitForLoadState('domcontentloaded');
    await dismissModals(page);
    await passCloudflareIfPresent(page);

    // Wait for either job cards OR a clear "no results" page. If neither shows up
    // within 18 seconds, only then declare it a challenge and rotate session.
    const ok = await Promise.race([
        page.waitForSelector('a[data-jk], div.job_seen_beacon, div[data-testid="slider_item"], li[data-testid="result"]', { timeout: 18000 }).then(() => true).catch(() => false),
        page.waitForSelector('[data-testid="no-jobs-message"], [class*="jobs-not-found"]', { timeout: 18000 }).then(() => 'empty').catch(() => null),
    ]);
    if (!ok) {
        if (await looksLikeChallenge(page)) {
            log.warning(`Cloudflare on ${request.url}, rotating session.`);
            request.session?.markBad();
            throw new Error('Indeed challenge');
        }
    }
    if (ok === 'empty') {
        log.info(`No jobs found for "${request.userData.keyword || request.url}".`);
        return;
    }

    const jobsOnPage = await page.evaluate(() => {
        const out = new Map();
        const initial = window._initialData || window.mosaic?.serverData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel
            || (() => { try { return JSON.parse(document.querySelector('script#mosaic-data')?.textContent || '{}'); } catch { return null; } })();

        const text = (n) => {
            if (!n) return '';
            const clone = n.cloneNode(true);
            clone.querySelectorAll('style, script, noscript').forEach((el) => el.remove());
            const out = (clone.textContent || '').replace(/\s+/g, ' ').trim();
            if (out.startsWith('.css') || out.startsWith('.') && /\{[a-z-]+\s*:/i.test(out)) return '';
            return out;
        };
        const links = document.querySelectorAll('a[data-jk]');
        links.forEach((a) => {
            const jk = a.getAttribute('data-jk');
            if (!jk || out.has(jk)) return;
            const card = a.closest('div.job_seen_beacon, li[data-testid="result"], div[data-testid="slider_item"]') || a;
            const title = text(card.querySelector('h2 a span, h2 a, [data-testid="jobTitle"]'));
            const company = text(card.querySelector('[data-testid="company-name"], span.companyName'));
            const location = text(card.querySelector('[data-testid="text-location"], div.companyLocation'));
            const salaryEstimate = text(card.querySelector('div.metadata.salary-snippet-container, [class*="salary-snippet"]'));
            const snippet = text(card.querySelector('div.job-snippet, [class*="jobMetaDataGroup"] li, .underShelfFooter'));
            const sponsored = !!card.querySelector('span.sponsoredJob, [data-testid="sponsoredJob"]') || /sponsored/i.test(text(card.querySelector('span.companyOverlink, [data-testid="company-meta"]')));
            const postedAgo = text(card.querySelector('span.date, [data-testid="myJobsStateDate"]'));
            const easyApply = !!card.querySelector('[data-testid="indeedApplyBadge"], svg[aria-label*="Easy Apply" i]');
            out.set(jk, { jk, title, company, location, salaryEstimate, snippet, sponsored, postedAgo, easyApply });
        });
        return [...out.values()];
    }).catch(() => []);

    log.info(`Listing ${request.userData.keyword || request.url} @ ${request.userData.location || ''}: ${jobsOnPage.length} cards.`);

    const remaining = cap - pushedRows;
    const toQueue = [];
    for (const card of jobsOnPage) {
        if (toQueue.length >= remaining) break;
        if (dedupe && seenJobIds.has(card.jk)) continue;
        toQueue.push(makeJobRequestWithCard(card, request.userData.host, request.userData.keyword, request.userData.location));
    }
    if (toQueue.length > 0) await c.addRequests(toQueue);

    // Pagination
    const nextHref = await page.evaluate(() => {
        const el = document.querySelector('a[data-testid="pagination-page-next"], a[aria-label="Next Page"], a[aria-label="Next"]');
        return el?.href || null;
    }).catch(() => null);
    if (nextHref && pushedRows + toQueue.length < cap) {
        await c.addRequests([{
            url: nextHref,
            userData: { ...request.userData, page: (request.userData.page || 0) + 1 },
            uniqueKey: `listing:next:${nextHref}`,
        }]);
    }
}

function makeJobRequestWithCard(cardData, host, keyword, location) {
    return {
        url: `https://${host}/viewjob?jk=${cardData.jk}`,
        userData: {
            type: 'job',
            jk: cardData.jk,
            host,
            keyword,
            location,
            card: cardData,
        },
        uniqueKey: `job:${host}:${cardData.jk}`,
    };
}

// ---------- Job detail handler ----------

async function handleJob({ page, request, crawler: c }) {
    const jk = request.userData.jk;
    if (dedupe && seenJobIds.has(jk)) return;
    if (pushedRows >= cap) return;

    await page.waitForLoadState('domcontentloaded');
    await dismissModals(page);
    await passCloudflareIfPresent(page);

    if (await looksLikeChallenge(page)) {
        log.warning(`Challenge on viewjob ${jk}, rotating.`);
        request.session?.markBad();
        throw new Error('Indeed challenge');
    }

    try { await page.waitForSelector('h1[data-testid="jobsearch-JobInfoHeader-title"], h1.jobsearch-JobInfoHeader-title, [data-testid="jobTitle"]', { timeout: 12000 }); } catch {}

    const job = await page.evaluate(() => {
        const text = (n) => {
            if (!n) return '';
            const clone = n.cloneNode(true);
            clone.querySelectorAll('style, script, noscript').forEach((el) => el.remove());
            const out = (clone.textContent || '').replace(/\s+/g, ' ').trim();
            if (out.startsWith('.css') || out.startsWith('.') && /\{[a-z-]+\s*:/i.test(out)) return '';
            return out;
        };
        const initial = window._initialData || (() => {
            try { return JSON.parse(document.querySelector('script#mosaic-data')?.textContent || '{}'); } catch { return null; }
        })();
        const wrapper = initial?.jobInfoWrapperModel?.jobInfoModel || initial?.hostQueryExecutionResult?.data?.jobData?.results?.[0]?.job || null;

        const title = text(document.querySelector('h1[data-testid="jobsearch-JobInfoHeader-title"], h1.jobsearch-JobInfoHeader-title, h1.jobsearch-JobInfoHeader-title-container'));
        const company = text(document.querySelector('[data-testid="inlineHeader-companyName"] a, div[data-testid="inlineHeader-companyName"] span, .jobsearch-CompanyInfoContainer a'));
        const companyHref = (document.querySelector('[data-testid="inlineHeader-companyName"] a, .jobsearch-CompanyInfoContainer a'))?.getAttribute('href') || null;
        const location = text(document.querySelector('[data-testid="job-location"], [data-testid="inlineHeader-companyLocation"], .jobsearch-JobInfoHeader-subtitle div'));
        const salaryText = text(document.querySelector('[data-testid="jobsearch-OtherJobDetailsContainer"] [data-testid="jobsearch-JobMetadataHeader-item"], [data-testid="job-salary"], #salaryInfoAndJobType, .jobsearch-JobMetadataHeader-itemWithIcon'));
        const employmentTypeText = text(document.querySelector('[data-testid="job-type"], [data-testid="empType_jobType"]'));
        const description = text(document.querySelector('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]'));
        const postedDateText = text(document.querySelector('[data-testid="jobsearch-RecruiterPipeline-RecruiterCard"] + div, span.jobsearch-HiringInsights-entry--text, .jobsearch-HiringInsights-entry--bullet'));
        const easyApply = !!document.querySelector('button#indeedApplyButton, button[data-testid*="indeedApplyButton"], [data-indeed-apply-jk]');
        const externalApplyUrl = (document.querySelector('a[data-testid="applyButtonLinkContainer"] a, a[id="applyButtonLinkContainer"]'))?.getAttribute('href') || null;
        const benefitsText = text(document.querySelector('[data-testid="benefits-test"]'));
        const ratingText = text(document.querySelector('[data-testid="inlineHeader-companyRating"], [data-testid="ratingNumber"]'));
        const reviewCountText = text(document.querySelector('[data-testid="inlineHeader-companyReviewCount"], a[href*="reviews"]'));

        return {
            title,
            company,
            companyHref,
            location,
            salaryText,
            employmentTypeText,
            description,
            postedDateText,
            easyApply,
            externalApplyUrl,
            benefitsText,
            ratingText,
            reviewCountText,
            wrapperPresent: !!wrapper,
        };
    });

    if (!job.title) {
        log.warning(`No title on ${request.url}, skipping.`);
        return;
    }

    const card = request.userData.card || {};
    const salary = parseSalary ? parseSalaryText(job.salaryText || card.salaryEstimate || '', request.userData.host) : null;
    const skills = extractSkills ? detectSkills(job.description) : [];
    const seniority = classifySeniority ? classifySeniorityLabel(job.title) : null;
    const workMode = detectRemoteHybrid ? detectWorkMode(job.location, job.description) : null;
    const postedDate = parseRelativeDate(job.postedDateText || card.postedAgo || '');
    const employmentType = parseEmploymentType(job.employmentTypeText || job.salaryText || card.snippet || '');

    let resolvedApplyUrl = null;
    if (followApplyRedirect && job.externalApplyUrl) {
        resolvedApplyUrl = await resolveApplyRedirect(page, job.externalApplyUrl);
    }

    const row = {
        jobId: jk,
        url: `https://${request.userData.host}/viewjob?jk=${jk}`,
        country: HOST_TO_COUNTRY[request.userData.host] || country,
        title: job.title,
        company: {
            name: job.company || card.company || null,
            indeedUrl: job.companyHref ? new URL(job.companyHref, `https://${request.userData.host}`).toString() : null,
            slug: extractCompanySlug(job.companyHref),
            ratingStars: parseFloatSafe(job.ratingText),
            reviewCount: parseFlexibleNumber(job.reviewCountText),
        },
        location: {
            text: job.location || card.location || null,
            workMode,
        },
        employment: {
            type: employmentType,
            seniority,
        },
        compensation: salary,
        flags: {
            sponsored: !!card.sponsored,
            easyApply: detectEasyApply ? (job.easyApply || !!card.easyApply) : null,
            urgentlyHiring: /urgently hiring/i.test(job.description) || /urgently hiring/i.test(card.snippet || ''),
        },
        applyLink: {
            external: job.externalApplyUrl || null,
            resolved: resolvedApplyUrl,
        },
        skills,
        benefitsText: job.benefitsText || null,
        description: job.description || null,
        descriptionLength: (job.description || '').length,
        postedDateText: job.postedDateText || card.postedAgo || null,
        postedDate,
        searchContext: {
            keyword: request.userData.keyword || null,
            location: request.userData.location || null,
        },
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    seenJobIds.add(jk);
    pushedRows += 1;
    if (pushedRows > 10) __chargeJobs.push(Actor.charge({ eventName: 'job_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));

    if (scrapeCompanyDetails && row.company.slug && !seenCompanies.has(row.company.slug)) {
        seenCompanies.add(row.company.slug);
        await c.addRequests([makeCompanyRequest(row.company.slug, request.userData.host, row.company.indeedUrl)]);
    }

    log.info(`Pushed ${jk} ${row.title.slice(0, 55)} @ ${row.company.name || '?'} (${pushedRows})`);
}

// ---------- Company handler ----------

async function handleCompany({ page, request }) {
    await page.waitForLoadState('domcontentloaded');
    await dismissModals(page);

    // Give the Cloudflare interstitial its 5-10s to auto-resolve BEFORE judging
    // the page. Checking first (as this handler used to) treated every transient
    // "Just a moment" as a hard block, which is most of the /cmp/ challenge rate.
    await passCloudflareIfPresent(page);

    if (await looksLikeChallenge(page)) {
        request.session?.markBad();
        throw new Error('Indeed challenge');
    }

    try { await page.waitForSelector('div[data-testid="company-snippet"], h1[data-testid="company-page-name"]', { timeout: 12000 }); } catch {}

    const data = await page.evaluate(() => {
        const text = (n) => {
            if (!n) return '';
            const clone = n.cloneNode(true);
            clone.querySelectorAll('style, script, noscript').forEach((el) => el.remove());
            const out = (clone.textContent || '').replace(/\s+/g, ' ').trim();
            if (out.startsWith('.css') || out.startsWith('.') && /\{[a-z-]+\s*:/i.test(out)) return '';
            return out;
        };
        const detailVal = (label) => {
            const rows = document.querySelectorAll('[data-testid="company-summary"] li, .css-jybh7s, [data-testid="companyInfo"] li');
            for (const r of rows) {
                if (new RegExp(label, 'i').test(text(r))) {
                    const valEl = r.querySelector('[data-testid$="-value"], div + div, dd');
                    return text(valEl) || text(r).replace(new RegExp(`^${label}[:\\s]*`, 'i'), '');
                }
            }
            return null;
        };
        return {
            name: text(document.querySelector('h1[data-testid="company-page-name"], h1.css-jbq5xl')),
            ratingText: text(document.querySelector('[data-testid="rating-number"], [data-testid="reviewCard-rating"], .css-1a4u1d8')),
            reviewCountText: text(document.querySelector('[data-testid="reviewCount"], a[href*="reviews"]')),
            websiteUrl: (document.querySelector('a[data-testid="companyWebsiteLink"], a[data-testid$="websiteLink"]'))?.getAttribute('href') || null,
            industry: detailVal('industry'),
            size: detailVal('size|employees'),
            founded: detailVal('founded'),
            revenue: detailVal('revenue'),
            headquarters: detailVal('headquarters'),
            description: text(document.querySelector('[data-testid="companyAboutSection"], [data-testid="aboutSection"]')),
        };
    });

    const row = {
        kind: 'company',
        slug: request.userData.companySlug,
        country: HOST_TO_COUNTRY[request.userData.host] || country,
        url: request.url,
        name: data.name || null,
        rating: parseFloatSafe(data.ratingText),
        reviewCount: parseFlexibleNumber(data.reviewCountText),
        website: data.websiteUrl,
        industry: data.industry,
        size: data.size,
        foundedYear: parseFoundedYear(data.founded),
        revenue: data.revenue,
        headquarters: data.headquarters,
        description: data.description,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    log.info(`Pushed company ${row.slug} | ${row.rating ?? '?'}★ (${row.reviewCount ?? '?'} reviews)`);
}

// ---------- Parsers ----------

function parseSalaryText(text, host) {
    if (!text) return null;
    const original = text.trim();

    const currency = (() => {
        if (/\$/.test(text)) return 'USD';
        if (/£/.test(text)) return 'GBP';
        if (/€/.test(text)) return 'EUR';
        if (/¥/.test(text)) return 'JPY';
        if (/\bC\$/.test(text)) return 'CAD';
        if (/\bA\$/.test(text)) return 'AUD';
        if (/\bR\$/.test(text)) return 'BRL';
        if (/\bMX\$/.test(text)) return 'MXN';
        if (/\bR\s/.test(text) && (host || '').includes('za')) return 'ZAR';
        if (/AED|د\.إ/.test(text)) return 'AED';
        if (/\bSGD/.test(text)) return 'SGD';
        if (/\bHKD/.test(text)) return 'HKD';
        if (/\bINR|₹/.test(text)) return 'INR';
        return ({
            'www.indeed.com': 'USD', 'uk.indeed.com': 'GBP', 'ca.indeed.com': 'CAD', 'au.indeed.com': 'AUD',
            'ie.indeed.com': 'EUR', 'de.indeed.com': 'EUR', 'fr.indeed.com': 'EUR', 'it.indeed.com': 'EUR',
            'es.indeed.com': 'EUR', 'nl.indeed.com': 'EUR', 'be.indeed.com': 'EUR', 'in.indeed.com': 'INR',
            'jp.indeed.com': 'JPY', 'sg.indeed.com': 'SGD', 'br.indeed.com': 'BRL', 'mx.indeed.com': 'MXN',
            'za.indeed.com': 'ZAR', 'ae.indeed.com': 'AED',
        })[host] || 'USD';
    })();

    const period = (() => {
        if (/per\s+hour|hourly|\/hr|\/hour|an hour/i.test(text)) return 'hour';
        if (/per\s+day|daily|\/day/i.test(text)) return 'day';
        if (/per\s+week|weekly|\/week/i.test(text)) return 'week';
        if (/per\s+month|monthly|\/month/i.test(text)) return 'month';
        if (/per\s+year|yearly|annual|annually|\/yr|\/year|a year/i.test(text)) return 'year';
        const n = parseFlexibleNumber(text);
        if (n != null && n < 200) return 'hour';
        if (n != null && n < 5000) return 'month';
        return 'year';
    })();

    const matches = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*(K|k|m|M)?/g)];
    const nums = matches.map((m) => {
        let n = parseFloat(m[1].replace(/,/g, ''));
        const suf = (m[2] || '').toUpperCase();
        if (suf === 'K') n *= 1000;
        else if (suf === 'M') n *= 1000000;
        return n;
    }).filter((n) => Number.isFinite(n) && n > 0);

    const min = nums.length > 0 ? Math.min(...nums) : null;
    const max = nums.length > 1 ? Math.max(...nums) : null;

    const annualEstimate = (() => {
        const n = max ?? min;
        if (n == null) return null;
        if (period === 'hour') return Math.round(n * 2080);
        if (period === 'day') return Math.round(n * 250);
        if (period === 'week') return Math.round(n * 52);
        if (period === 'month') return Math.round(n * 12);
        return Math.round(n);
    })();

    const isEstimated = /Indeed est|est\.?\s*by Indeed|estimated/i.test(text);

    return {
        rawText: original,
        currency,
        period,
        min,
        max,
        annualEstimate,
        isEstimated,
        isListed: !isEstimated,
    };
}

function detectSkills(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const found = new Set();
    for (const skill of TECH_SKILLS) {
        const pattern = skill.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${pattern}\\b`, 'i').test(lower)) found.add(skill);
    }
    return [...found].slice(0, 50);
}

function classifySeniorityLabel(title) {
    if (!title) return null;
    for (const p of SENIORITY_PATTERNS) {
        if (p.regex.test(title)) return p.label;
    }
    return null;
}

function detectWorkMode(location, description) {
    const text = `${location || ''} ${description || ''}`.toLowerCase();
    if (/(fully\s+remote|100%\s+remote|work\s+from\s+home|remote\s+only|wfh|telecommute)/i.test(text)) return 'remote';
    if (/\bremote\b/.test(text) && /\bhybrid\b/.test(text)) return 'hybrid';
    if (/\bhybrid\b/.test(text)) return 'hybrid';
    if (/\bremote\b/.test(text)) return 'remote';
    if (/(on[-\s]?site|in[-\s]?office|in[-\s]?person)/i.test(text)) return 'onsite';
    return null;
}

function parseRelativeDate(text) {
    if (!text) return null;
    const m = text.toLowerCase().match(/(\d+)\s*\+?\s*(minute|hour|day|week|month)s?\s*ago/);
    if (m) {
        const n = parseInt(m[1], 10);
        const unit = m[2];
        const ms = ({ minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_628_000_000 })[unit];
        return new Date(Date.now() - n * ms).toISOString();
    }
    if (/just\s+posted|today|posted today/i.test(text)) return new Date().toISOString();
    if (/yesterday/i.test(text)) return new Date(Date.now() - 86_400_000).toISOString();
    return null;
}

function parseEmploymentType(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/full[-\s]?time/i.test(t)) return 'fulltime';
    if (/part[-\s]?time/i.test(t)) return 'parttime';
    if (/contract/i.test(t)) return 'contract';
    if (/temporary|temp\b/i.test(t)) return 'temporary';
    if (/internship|intern\b/i.test(t)) return 'internship';
    if (/permanent/i.test(t)) return 'fulltime';
    return null;
}

function parseFlexibleNumber(text) {
    if (!text) return null;
    const m = String(text).replace(/[ ,]/g, ' ').match(/([\d.]+)\s*([KMB]?)/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') n *= 1000;
    else if (suf === 'M') n *= 1000000;
    else if (suf === 'B') n *= 1000000000;
    return Number.isFinite(n) ? Math.round(n) : null;
}

function parseFloatSafe(text) {
    if (!text) return null;
    const m = String(text).match(/(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function parseFoundedYear(text) {
    if (!text) return null;
    const m = String(text).match(/(19|20)\d{2}/);
    return m ? parseInt(m[0], 10) : null;
}

function extractCompanySlug(href) {
    if (!href) return null;
    try {
        const u = new URL(href, 'https://www.indeed.com');
        const m = u.pathname.match(/^\/cmp\/([^/?]+)/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ---------- Browser helpers ----------

async function dismissModals(page) {
    try {
        await page.evaluate(() => {
            ['[aria-label="close"]', '#popover-x', 'button.gnav-Modal-trigger', 'button[aria-label*="lose" i]'].forEach((sel) => {
                document.querySelector(sel)?.click?.();
            });
        });
    } catch {}
}

async function looksLikeChallenge(page) {
    try {
        const html = await page.content();
        if (!/Cloudflare|Just a moment|hcaptcha|recaptcha|cf-error-details|please verify you are a human/i.test(html)) return false;
        // If the page also contains real content, the challenge already cleared.
        // Company (/cmp/) pages never carry job markers, so they need their own
        // tells here or a resolved company page reads as a permanent block.
        return !/data-jk=|jobsearch-JobInfoHeader|mosaic-provider-jobcards|company-page-name|company-snippet|companyAboutSection|data-testid="company-summary"/i.test(html);
    } catch { return false; }
}

// Cloudflare interstitials are <title>Just a moment...</title> with a JS challenge
// that resolves in 5-10 seconds. We give the page that long to settle before
// declaring it blocked.
async function passCloudflareIfPresent(page) {
    try {
        const isChallenge = await page.evaluate(() => {
            const t = (document.title || '').toLowerCase();
            return t.includes('just a moment') || t.includes('attention required') || !!document.querySelector('#challenge-running, #cf-please-wait');
        });
        if (!isChallenge) return;
        for (let i = 0; i < 5; i += 1) {
            await page.waitForTimeout(2500);
            const stillChallenge = await page.evaluate(() => {
                const t = (document.title || '').toLowerCase();
                return t.includes('just a moment') || t.includes('attention required');
            }).catch(() => false);
            if (!stillChallenge) return;
        }
    } catch {}
}

async function resolveApplyRedirect(page, applyUrl) {
    try {
        const final = await page.evaluate(async (u) => {
            const r = await fetch(u, { method: 'GET', redirect: 'follow' });
            return r.url || u;
        }, applyUrl);
        return final;
    } catch { return null; }
}
