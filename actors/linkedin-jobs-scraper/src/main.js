// LinkedIn Hiring Tracker & Salary Intelligence
//
// Two-stage scraper against LinkedIn's unauth /jobs-guest/ endpoints:
//   1. Listing: /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=&location=&start=
//      Returns HTML fragment with ~25 job cards per page. Each card carries a
//      urn:li:jobPosting:{id} identifier and basic fields.
//   2. Detail: /jobs-guest/jobs/api/jobPosting/{id}
//      Returns the full job detail HTML with description, criteria, applicants.
//
// Per row we enrich with computed signals that LinkedIn does not expose:
//   - salary range, currency, and period parsed from the description
//   - tech stack keywords (120+ terms across languages, frameworks, cloud, data, ML)
//   - seniority tier from title (intern, entry, mid, senior, staff, lead, manager, director, vp, c-suite)
//   - remote type from title/description/criteria
//   - experience years (minimum) parsed from description

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const TECH_STACK_TERMS = [
    // languages
    'python', 'javascript', 'typescript', 'golang', 'rust', 'java', 'kotlin', 'swift',
    'c++', 'c#', 'ruby', 'php', 'scala', 'matlab', 'perl', 'elixir', 'haskell', 'dart', 'sql',
    // web / frameworks
    'react', 'vue.js', 'angular', 'svelte', 'next.js', 'nuxt', 'remix', 'astro',
    'django', 'flask', 'fastapi', 'express.js', 'nestjs', 'rails', 'laravel', 'spring boot',
    'node.js', 'nodejs', 'graphql', 'grpc', 'websocket',
    'bun', 'deno', 'vite', 'webpack',
    // cloud / infra
    'aws', 'gcp', 'azure', 'kubernetes', 'k8s', 'docker', 'terraform', 'pulumi', 'ansible',
    'helm', 'istio', 'linkerd', 'cloudflare', 'vercel', 'netlify', 'heroku', 'digitalocean',
    'lambda', 's3', 'ec2', 'rds', 'dynamodb', 'cloudfront', 'eks', 'ecs',
    'bigquery', 'cloud run', 'gke', 'firestore',
    // data
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'opensearch',
    'snowflake', 'databricks', 'redshift', 'clickhouse', 'cassandra',
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
    // frontend styling
    'tailwind',
];

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    locations = [],
    experienceLevel = '',
    jobType = '',
    remoteFilter = '',
    postedSince = '',
    maxResults = 100,
    parseSalary = true,
    extractTechStack = true,
    classifySeniority = true,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

const cleanList = (arr) =>
    Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.value || '')).map((v) => v.trim()).filter(Boolean)
        : [];

const kwList = cleanList(keywords);
const locList = cleanList(locations);

if (kwList.length === 0) {
    log.warning('No keywords provided, defaulting to "software engineer"');
    kwList.push('software engineer');
}
if (locList.length === 0) locList.push('');

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('linkedin-jobs-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-ids')) || [];
    for (const id of prev) seen.add(id);
}

let itemsPushed = 0;

const initialRequests = [];
for (const kw of kwList) {
    for (const loc of locList) {
        initialRequests.push({
            url: buildListingUrl(kw, loc, 0),
            userData: {
                type: 'listing',
                keyword: kw,
                location: loc,
                start: 0,
            },
            uniqueKey: `listing:${kw}:${loc}:0`,
        });
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    maxConcurrency: 2,
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
    async requestHandler({ $, request, crawler: c }) {
        if (itemsPushed >= maxResults) return;
        if (request.userData.type === 'listing') {
            await handleListing($, request, c);
        } else if (request.userData.type === 'detail') {
            await handleDetail($, request);
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed after retries: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && itemsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen]);
}

log.info(`Run complete. Pushed ${itemsPushed} jobs.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ----- URL builders -----

function buildListingUrl(keywords, location, start) {
    const qs = new URLSearchParams();
    qs.set('keywords', keywords);
    if (location) qs.set('location', location);
    qs.set('start', String(start));

    const f = mapFilters();
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);

    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs.toString()}`;
}

function buildDetailUrl(jobId) {
    return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
}

function mapFilters() {
    const out = {};
    if (experienceLevel) {
        out.f_E = { internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' }[experienceLevel];
    }
    if (jobType) {
        out.f_JT = { 'full-time': 'F', 'part-time': 'P', contract: 'C', temporary: 'T', volunteer: 'V', internship: 'I', other: 'O' }[jobType];
    }
    if (remoteFilter) {
        out.f_WT = { onsite: '1', remote: '2', hybrid: '3' }[remoteFilter];
    }
    if (postedSince) {
        out.f_TPR = { '1d': 'r86400', '1w': 'r604800', '1m': 'r2592000' }[postedSince];
    }
    return out;
}

// ----- handlers -----

async function handleListing($, request, crawler) {
    const cards = $('li, div').filter((_, el) => {
        const urn = $(el).find('[data-entity-urn^="urn:li:jobPosting:"]').addBack('[data-entity-urn^="urn:li:jobPosting:"]');
        return urn.length > 0;
    });
    const ids = [];
    $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
        const urn = $(el).attr('data-entity-urn') || '';
        const id = urn.replace('urn:li:jobPosting:', '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    });

    if (ids.length === 0) {
        log.info(`Listing returned 0 jobs: ${request.url}`);
        return;
    }

    log.info(`Listing page start=${request.userData.start}: ${ids.length} jobs for "${request.userData.keyword}" @ ${request.userData.location || 'anywhere'}`);

    const toEnqueue = [];
    for (const id of ids) {
        if (itemsPushed + toEnqueue.length >= maxResults) break;
        if (dedupe && seen.has(id)) continue;
        toEnqueue.push({
            url: buildDetailUrl(id),
            userData: {
                type: 'detail',
                jobId: id,
                keyword: request.userData.keyword,
                location: request.userData.location,
            },
            uniqueKey: `detail:${id}`,
        });
    }

    if (toEnqueue.length > 0) {
        await crawler.addRequests(toEnqueue);
    }

    const nextStart = request.userData.start + ids.length;
    if (ids.length >= 10 && nextStart < maxResults && itemsPushed < maxResults) {
        await crawler.addRequests([{
            url: buildListingUrl(request.userData.keyword, request.userData.location, nextStart),
            userData: {
                type: 'listing',
                keyword: request.userData.keyword,
                location: request.userData.location,
                start: nextStart,
            },
            uniqueKey: `listing:${request.userData.keyword}:${request.userData.location}:${nextStart}`,
        }]);
    }
}

async function handleDetail($, request) {
    if (itemsPushed >= maxResults) return;
    const id = request.userData.jobId;
    if (dedupe && seen.has(id)) return;

    const row = parseJobDetail($, id, request);
    if (!row) {
        log.warning(`Failed to parse job ${id}`);
        return;
    }

    await Actor.pushData(row);
    seen.add(id);
    itemsPushed += 1;
    if (itemsPushed > 10) __chargeJobs.push(Actor.charge({ eventName: 'job_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    log.info(`Pushed ${id}: ${row.title} @ ${row.company} (${itemsPushed}/${maxResults})`);
}

// ----- parser -----

function parseJobDetail($, id, request) {
    const title = clean($('h2.topcard__title, h1.topcard__title, .top-card-layout__title').first().text());
    const company = clean($('a.topcard__org-name-link, .topcard__org-name-link, .top-card-layout__second-subline a').first().text());
    const companyUrl = $('a.topcard__org-name-link, .top-card-layout__second-subline a').first().attr('href') || null;
    const location = clean($('.topcard__flavor--bullet, span.topcard__flavor.topcard__flavor--bullet').first().text());
    const postedAgo = clean($('.posted-time-ago__text, .topcard__flavor--metadata').first().text());
    const applicantsText = clean($('.num-applicants__caption, .num-applicants__figure').first().text());

    const descriptionHtml = $('.description__text, .show-more-less-html__markup').first().html() || '';
    const description = clean($('.description__text, .show-more-less-html__markup').first().text());

    if (!title && !description) return null;

    const criteria = {};
    $('.description__job-criteria-item, .job-criteria__item').each((_, el) => {
        const label = clean($(el).find('.description__job-criteria-subheader, .job-criteria__subheader, h3').first().text()).toLowerCase();
        const value = clean($(el).find('.description__job-criteria-text, .job-criteria__text, span').first().text());
        if (label && value) criteria[label] = value;
    });

    const applyUrl = $('a[data-tracking-control-name*="public_jobs_apply"], a.apply-button').first().attr('href') || null;

    const row = {
        id,
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        title: title || null,
        company: company || null,
        companyUrl: companyUrl ? normalizeLinkedInUrl(companyUrl) : null,
        location: location || null,
        remote: remoteFromText(title, description, criteria),
        postedAgo: postedAgo || null,
        postedAt: parsePostedAt(postedAgo),
        applicants: parseApplicants(applicantsText),
        seniorityLevel: criteria['seniority level'] || null,
        employmentType: criteria['employment type'] || null,
        jobFunction: criteria['job function'] || null,
        industries: criteria['industries'] || null,
        description: description.slice(0, 12000),
        descriptionLength: description.length,
        applyUrl,
        source: { keyword: request.userData.keyword, location: request.userData.location },
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
    if (extractTechStack) row.techStack = extractTechStackFromText(description);

    row.experienceYearsMin = parseExperienceYears(description);

    return row;
}

// ----- utilities -----

function clean(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').trim();
}

function normalizeLinkedInUrl(href) {
    if (!href) return null;
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return `https://www.linkedin.com${href}`;
    return href.split('?')[0];
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
    const haystack = text;

    const currencyMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
    const codeMap = { USD: 'USD', EUR: 'EUR', GBP: 'GBP', CAD: 'CAD', AUD: 'AUD', INR: 'INR', CHF: 'CHF' };

    // Match NUMBER [k|m]? SEPARATOR [CURRENCY]? NUMBER [k|m]? — find all candidates.
    // Separators: dash, en-dash, em-dash, "to", "and go up to", "up to".
    const sep = '(?:[-–—]|(?:\\s+(?:to|and(?:\\s+go\\s+up\\s+to)?|up\\s+to)\\s+))';
    const symPattern = new RegExp(`(\\$|€|£|₹)([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*${sep}\\s*(?:\\$|€|£|₹)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)`, 'g');
    const codePattern = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*${sep}\\s*([\\d,]+(?:\\.\\d+)?)\\s*([kKmM]?)\\s*(USD|EUR|GBP|CAD|AUD|INR|CHF)`, 'g');

    const candidates = [];
    const pushCandidate = (m, currency, minStr, minMul, maxStr, maxMul) => {
        const min = Math.round(toNum(minStr) * minMul);
        const max = Math.round(toNum(maxStr) * maxMul);
        if (!min || !max || max < min) return;
        const start = Math.max(0, m.index - 200);
        const end = Math.min(haystack.length, m.index + m[0].length + 120);
        const ctx = haystack.slice(start, end).toLowerCase();
        if (!/salar|compensat|base pay|pay range|hourly|wage|per year|per annum|per hour|\/year|\/hr|\/hour|annual|base (salary|pay|compensation)/.test(ctx)) return;
        const period = detectPeriodInContext(ctx);
        if (!plausibleSalary(min, max, period)) return;
        candidates.push({ min, max, currency, period, score: scoreSalaryContext(ctx) });
    };

    let m;
    while ((m = symPattern.exec(haystack)) !== null) {
        const currency = currencyMap[m[1]] || null;
        pushCandidate(m, currency, m[2], scaleMul(m[3]), m[4], scaleMul(m[5]));
    }
    while ((m = codePattern.exec(haystack)) !== null) {
        const currency = codeMap[m[5].toUpperCase()];
        pushCandidate(m, currency, m[1], scaleMul(m[2]), m[3], scaleMul(m[4]));
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score || b.max - a.max);
    const best = candidates[0];
    return { min: best.min, max: best.max, currency: best.currency, period: best.period };
}

function detectPeriodInContext(ctx) {
    if (/per hour|\/hr|\/hour|hourly/.test(ctx)) return 'hourly';
    if (/per day|day rate/.test(ctx)) return 'daily';
    if (/per week|weekly/.test(ctx)) return 'weekly';
    if (/per month|monthly/.test(ctx)) return 'monthly';
    return 'annual';
}

function scoreSalaryContext(ctx) {
    let s = 0;
    if (/salary range|base salary|annual salary|salary is|salary for this/.test(ctx)) s += 6;
    if (/base pay range|pay range for this|compensation range/.test(ctx)) s += 5;
    if (/total compensation|total comp|base pay|compensation/.test(ctx)) s += 3;
    if (/\bstipend\b/.test(ctx)) s -= 5;
    if (/\bgift card\b|\bsign.on bonus\b/.test(ctx)) s -= 4;
    if (/\b401k\b|\bretirement\b/.test(ctx)) s -= 3;
    if (/\bequity\b(?!\s+package)/.test(ctx)) s -= 1;
    return s;
}

function scaleMul(suffix) {
    if (!suffix) return 1;
    const c = suffix.toLowerCase();
    if (c === 'k') return 1000;
    if (c === 'm') return 1000000;
    return 1;
}

function toNum(s) {
    return parseFloat(String(s).replace(/,/g, ''));
}

function detectPeriod(text) {
    const t = text.toLowerCase();
    if (/\bper hour\b|\b\/hr\b|\b\/hour\b|hourly/.test(t)) return 'hourly';
    if (/\bper day\b|\bdaily\b|\bday rate\b/.test(t)) return 'daily';
    if (/\bper week\b|\bweekly\b/.test(t)) return 'weekly';
    if (/\bper month\b|\bmonthly\b/.test(t)) return 'monthly';
    return 'annual';
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

function extractTechStackFromText(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const found = new Set();
    for (const term of TECH_STACK_TERMS) {
        const escaped = term.replace(/[.+*?^$(){}|[\]\\]/g, (c) => `\\${c}`);
        const startBoundary = /^[a-z0-9]/.test(term) ? '(?<=^|[^a-z0-9#+])' : '';
        const endBoundary = /[a-z0-9]$/.test(term) ? '(?=[^a-z0-9]|$)' : '';
        const re = new RegExp(startBoundary + escaped + endBoundary, 'i');
        if (re.test(lower)) {
            const normalized =
                term === 'nodejs' ? 'node.js' :
                term === 'golang' ? 'go' :
                term === 'k8s' ? 'kubernetes' :
                term === 'postgres' ? 'postgresql' :
                term === 'vue.js' ? 'vue' :
                term === 'express.js' ? 'express' :
                term;
            found.add(normalized);
        }
    }
    return [...found].sort();
}
