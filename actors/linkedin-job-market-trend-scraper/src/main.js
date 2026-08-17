// LinkedIn Job Market Trend Scraper
//
// Strategy (cookieless, validated 2026-05-18)
// -------------------------------------------
//   The public jobs search page returns HTTP 200 without a login and carries
//   the total result count in:
//     <span class="results-context-header__job-count">249,000+</span>
//   plus ~60 rendered role cards we sample for a seniority / function split.
//
//   One row per keyword x location x filter query. With trackDeltas on, the
//   prior count per query is kept in a key value store, so a scheduled run
//   reports the change versus last run. The trend is the whole product.
//
// Free tier: first 1 query per run is free. After that charge per query.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const FREE_TIER_QUERIES = 1;
const HISTORY_STORE = 'linkedin-jobmarket-history';

const FUNCTION_RULES = [
    ['engineering', /\b(engineer|developer|programmer|sre|devops|architect|software|backend|frontend|full.?stack|machine learning|data scientist|infrastructure|platform)\b/],
    ['data', /\b(data analyst|data engineer|analytics|business intelligence|bi )\b/],
    ['product', /\b(product manager|product owner|product lead|head of product)\b/],
    ['design', /\b(designer|ux|ui |product design|brand design)\b/],
    ['sales', /\b(sales|account executive|account manager|business development|bdr|sdr|revenue|partnerships)\b/],
    ['marketing', /\b(marketing|growth|demand gen|content|seo|brand|communications)\b/],
    ['customer', /\b(customer success|customer support|customer experience|support engineer|technical support)\b/],
    ['operations', /\b(operations|program manager|project manager|chief of staff|strategy)\b/],
    ['finance', /\b(finance|accountant|accounting|controller|fp&a|treasury|audit)\b/],
    ['people', /\b(recruiter|talent|people ops|human resources|hr |sourcer)\b/],
    ['healthcare', /\b(nurse|rn |physician|clinical|therapist|pharmacist|medical|caregiver)\b/],
    ['legal', /\b(legal|counsel|compliance|paralegal|attorney)\b/],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    locations = [],
    experienceLevel = '',
    jobType = '',
    remoteFilter = '',
    postedSince = '',
    includeBreakdown = true,
    trackDeltas = true,
    proxyConfiguration: proxyInput,
} = input;

const cleanList = (arr) =>
    Array.isArray(arr)
        ? arr.map((v) => (typeof v === 'string' ? v : v?.value || '')).map((v) => v.trim()).filter(Boolean)
        : [];

const kwList = cleanList(keywords);
const locList = cleanList(locations);
if (kwList.length === 0) {
    log.warning('No keywords provided. Example: ["data engineer","product manager"]');
    await Actor.exit();
}
if (locList.length === 0) locList.push('');

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const history = trackDeltas ? await Actor.openKeyValueStore(HISTORY_STORE) : null;

const filterSuffix = mapFilters();

const queries = [];
for (const kw of kwList) {
    for (const loc of locList) {
        queries.push({ keyword: kw, location: loc });
    }
}

let pushed = 0;

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
    async requestHandler(ctx) {
        return handleQuery(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed after retries: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(queries.map((q) => ({
    url: buildSearchUrl(q.keyword, q.location),
    userData: { type: 'query', ...q },
    uniqueKey: `q:${q.keyword}|${q.location}|${filterSuffix}`,
})));

await crawler.run();

log.info(`Run complete. Queries pushed: ${pushed}/${queries.length}.`);
await Actor.exit();

// ---------- handler ----------

async function handleQuery({ $, request }) {
    const { keyword, location } = request.userData;

    const countText = clean($('.results-context-header__job-count').first().text());
    const parsed = parseApproxCount(countText);

    // LinkedIn occasionally serves a degraded variant that reports "1,000+"
    // instead of the true count (observed transiently in testing while other
    // queries in the same run returned real numbers). Force a retry on a
    // fresh session; only accept the floor after retries are exhausted.
    const looksDegraded = parsed.count === 1000 && parsed.approximate;
    if (looksDegraded && request.retryCount < 4) {
        throw new Error(`Degraded "1,000+" count for "${keyword}" @ ${location || 'Worldwide'}, retrying on a fresh session.`);
    }
    const countSuspectDegraded = looksDegraded;

    let bySeniority = null;
    let byFunction = null;
    let sampleSize = 0;
    if (includeBreakdown) {
        bySeniority = {};
        byFunction = {};
        $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
            const card = $(el);
            const root = card.closest('li, div.base-card, div.job-search-card');
            const scope = root.length ? root : card;
            const title = clean(scope.find('.base-search-card__title, h3').first().text());
            if (!title) return;
            sampleSize += 1;
            const sen = seniorityFromTitle(title) || 'unknown';
            bySeniority[sen] = (bySeniority[sen] || 0) + 1;
            const fn = functionFromTitle(title);
            byFunction[fn] = (byFunction[fn] || 0) + 1;
        });
    }

    const queryKey = `q_${hash(`${keyword}|${location}|${filterSuffix}`)}`;
    let previousTotal = null;
    let previousScrapedAt = null;
    let delta = null;
    let deltaPct = null;
    if (history && parsed.count != null) {
        const prev = await history.getValue(queryKey);
        if (prev && typeof prev.count === 'number') {
            previousTotal = prev.count;
            previousScrapedAt = prev.scrapedAt || null;
            delta = parsed.count - prev.count;
            deltaPct = prev.count > 0 ? Math.round((delta / prev.count) * 1000) / 10 : null;
        }
        await history.setValue(queryKey, { count: parsed.count, scrapedAt: new Date().toISOString() });
    }

    await Actor.pushData({
        keyword,
        location: location || 'Worldwide',
        filters: {
            experienceLevel: experienceLevel || null,
            jobType: jobType || null,
            remoteFilter: remoteFilter || null,
            postedSince: postedSince || null,
        },
        searchUrl: request.url,
        totalJobs: parsed.count,
        totalJobsText: countText || null,
        isApproximate: parsed.approximate,
        countSuspectDegraded,
        previousTotal,
        previousScrapedAt,
        delta,
        deltaPct,
        trend: delta == null ? 'baseline' : delta > 0 ? 'growing' : delta < 0 ? 'cooling' : 'flat',
        sampleSize,
        bySeniority,
        byFunction,
        scrapedAt: new Date().toISOString(),
    });

    pushed += 1;
    if (pushed > FREE_TIER_QUERIES) {
        await Actor.charge({ eventName: 'query_tracked' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
    log.info(`Pushed "${keyword}" @ ${location || 'Worldwide'}: ${parsed.count ?? '?'} jobs (trend ${delta == null ? 'baseline' : delta}).`);
}

// ---------- helpers ----------

function buildSearchUrl(keyword, location) {
    const qs = new URLSearchParams();
    qs.set('keywords', keyword);
    if (location) qs.set('location', location);
    for (const [k, v] of Object.entries(mapFiltersObj())) if (v) qs.set(k, v);
    return `https://www.linkedin.com/jobs/search?${qs.toString()}`;
}

function mapFiltersObj() {
    const out = {};
    if (experienceLevel) out.f_E = { internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' }[experienceLevel];
    if (jobType) out.f_JT = { 'full-time': 'F', 'part-time': 'P', contract: 'C', temporary: 'T', internship: 'I' }[jobType];
    if (remoteFilter) out.f_WT = { onsite: '1', remote: '2', hybrid: '3' }[remoteFilter];
    if (postedSince) out.f_TPR = { '1d': 'r86400', '1w': 'r604800', '1m': 'r2592000' }[postedSince];
    return out;
}

function mapFilters() {
    return Object.entries(mapFiltersObj()).map(([k, v]) => `${k}=${v}`).join('&');
}

function parseApproxCount(text) {
    if (!text) return { count: null, approximate: false };
    const approximate = /\+/.test(text);
    const digits = text.replace(/[^\d]/g, '');
    if (!digits) return { count: null, approximate };
    return { count: parseInt(digits, 10), approximate };
}

function clean(s) {
    return s ? s.replace(/\s+/g, ' ').trim() : '';
}

function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
}

function functionFromTitle(title) {
    if (!title) return 'other';
    const t = ` ${title.toLowerCase()} `;
    for (const [name, re] of FUNCTION_RULES) if (re.test(t)) return name;
    return 'other';
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
