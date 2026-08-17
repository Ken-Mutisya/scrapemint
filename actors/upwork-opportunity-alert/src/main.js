// Freelance Lead Radar: Upwork Opportunity Filtering and Alert Engine
// Apify actor that extracts filtered Upwork job posts (budget, client country,
// payment verification, spend history, proposals, skills).
//
// Auth model: buyer pastes their own Upwork session cookies as input. No shared
// account, no login flow. Accepts either a Cookie Editor JSON array or a full
// Playwright storageState object.
//
// Extraction model: fetches the /nx/find-work/best-matches and
// /nx/find-work/most-recent pages via got-scraping (Chrome TLS fingerprint
// defeats Cloudflare), then parses the embedded window.__NUXT__ SSR state to
// read the full job feed (30 jobs for best-matches, 10 for most-recent),
// including structured client and budget data. No browser, no Turnstile
// interaction, no cheerio tile scraping.

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import vm from 'node:vm';

const FEED_ROUTES = {
    BEST_MATCHES: { path: '/nx/find-work/best-matches', stateKey: 'feedBestMatch', label: 'best-matches' },
    MOST_RECENT: { path: '/nx/find-work/most-recent', stateKey: 'feedMostRecent', label: 'most-recent' },
};

const POSTED_WITHIN_HOURS = {
    HOUR_24: 24,
    DAY_7: 168,
    DAY_30: 720,
    ANY: null,
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    sessionCookies = '',
    feed = 'BOTH',
    keywords = '',
    jobType = 'ALL',
    experienceLevel = 'ALL',
    hourlyRateMin = 0,
    fixedBudgetMin = 0,
    postedWithin = 'DAY_7',
    paymentVerifiedOnly = false,
    minClientSpent = 0,
    clientCountries = '',
    maxJobs = 100,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

if (!sessionCookies || String(sessionCookies).trim() === '') {
    throw new Error('sessionCookies is required. Export your Upwork cookies with the Cookie Editor extension and paste the JSON array here.');
}

function parseCookies(raw) {
    let parsed;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
        throw new Error(`sessionCookies is not valid JSON: ${err.message}`);
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
    throw new Error('sessionCookies must be a JSON array or a storageState object with a cookies array.');
}

function buildCookieHeader(cookieList) {
    return cookieList
        .filter((c) => {
            const d = (c.domain || '').replace(/^\./, '');
            return /upwork\.com$/.test(d);
        })
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
}

function assertAuthCookies(cookieList) {
    const names = new Set(cookieList.map((c) => c.name));
    const must = ['master_access_token', 'oauth2_global_js_token', 'XSRF-TOKEN'];
    const missing = must.filter((n) => !names.has(n));
    if (missing.length) {
        throw new Error(
            `Cookie set is missing auth tokens: ${missing.join(', ')}. `
            + 'Re-export cookies from a logged in Upwork session.',
        );
    }
}

function extractNuxt(html) {
    const m = html.match(/window\.__NUXT__\s*=\s*/);
    if (!m) return null;
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    if (end <= start) return null;
    const payload = html.slice(start, end);
    const ctx = { window: {} };
    vm.createContext(ctx);
    try {
        vm.runInContext(`window.__NUXT__ = ${payload}`, ctx, { timeout: 2000 });
    } catch (err) {
        log.warning(`Failed to parse NUXT payload: ${err.message}`);
        return null;
    }
    return ctx.window.__NUXT__;
}

function normalizeJob(raw, feedLabel) {
    const ciphertext = raw.ciphertext || '';
    const url = ciphertext ? `https://www.upwork.com/jobs/${ciphertext.replace(/^~/, '')}` : null;
    const hourly = raw.hourlyBudget;
    const fixed = raw.amount;
    const isHourly = raw.type === 2 || !!hourly;
    return {
        uid: raw.uid,
        title: raw.title,
        url,
        description: raw.description,
        jobType: isHourly ? 'Hourly' : 'Fixed',
        hourlyBudgetMin: hourly?.min ?? null,
        hourlyBudgetMax: hourly?.max ?? null,
        fixedAmount: fixed?.amount ?? null,
        currency: fixed?.currencyCode || 'USD',
        duration: raw.durationLabel || raw.duration || null,
        engagement: raw.engagement || null,
        tier: raw.tier || raw.tierText || null,
        proposalsTier: raw.proposalsTier || null,
        freelancersToHire: raw.freelancersToHire ?? null,
        connectPrice: raw.connectPrice ?? null,
        skills: Array.isArray(raw.skills) ? raw.skills.map((s) => s.prefLabel).filter(Boolean) : [],
        publishedOn: raw.publishedOn || null,
        createdOn: raw.createdOn || null,
        renewedOn: raw.renewedOn || null,
        enterpriseJob: !!raw.enterpriseJob,
        premium: !!raw.premium,
        client: {
            country: raw.client?.location?.country || null,
            city: raw.client?.location?.city || null,
            state: raw.client?.location?.state || null,
            region: raw.client?.location?.worldRegion || null,
            timezone: raw.client?.location?.countryTimezone || null,
            totalHires: raw.client?.totalHires ?? null,
            totalSpent: raw.client?.totalSpent ?? null,
            totalReviews: raw.client?.totalReviews ?? null,
            totalFeedback: raw.client?.totalFeedback ?? null,
            paymentVerified: raw.client?.paymentVerificationStatus === 1,
            topClient: !!raw.client?.topClient,
            lastRecruitingActivity: raw.client?.lastRecruitingActivity || null,
        },
        feed: feedLabel,
    };
}

function buildFilterer() {
    const kwList = String(keywords || '')
        .split(/[\s,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

    const countries = String(clientCountries || '')
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

    const windowHours = POSTED_WITHIN_HOURS[postedWithin] ?? null;
    const now = Date.now();

    return (job) => {
        if (jobType === 'HOURLY' && job.jobType !== 'Hourly') return false;
        if (jobType === 'FIXED' && job.jobType !== 'Fixed') return false;

        if (experienceLevel !== 'ALL') {
            const wanted = experienceLevel.charAt(0) + experienceLevel.slice(1).toLowerCase();
            const map = { ENTRY: 'Entry', INTERMEDIATE: 'Intermediate', EXPERT: 'Expert' };
            if (job.tier !== map[experienceLevel] && job.tier !== wanted) return false;
        }

        if (hourlyRateMin > 0 && job.jobType === 'Hourly') {
            const max = job.hourlyBudgetMax ?? job.hourlyBudgetMin ?? 0;
            if (max < hourlyRateMin) return false;
        }

        if (fixedBudgetMin > 0 && job.jobType === 'Fixed') {
            if ((job.fixedAmount || 0) < fixedBudgetMin) return false;
        }

        if (paymentVerifiedOnly && !job.client.paymentVerified) return false;

        if (minClientSpent > 0 && (job.client.totalSpent || 0) < minClientSpent) return false;

        if (countries.length && !countries.includes(job.client.country)) return false;

        if (windowHours !== null && job.publishedOn) {
            const ageH = (now - Date.parse(job.publishedOn)) / 36e5;
            if (ageH > windowHours) return false;
        }

        if (kwList.length) {
            const hay = `${job.title || ''} ${job.description || ''} ${(job.skills || []).join(' ')}`.toLowerCase();
            if (!kwList.some((kw) => hay.includes(kw))) return false;
        }

        return true;
    };
}

const cookies = parseCookies(sessionCookies);
assertAuthCookies(cookies);
const cookieHeader = buildCookieHeader(cookies);
if (!cookieHeader) {
    throw new Error('No upwork.com cookies found after filtering. Re-export cookies from the Upwork tab.');
}
log.info(`Loaded ${cookies.length} cookies (${cookieHeader.split('; ').length} for upwork.com).`);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
if (proxyUrl) log.info(`Using proxy: ${proxyUrl.replace(/\/\/[^@]+@/, '//***@')}`);

const routes = feed === 'BOTH'
    ? [FEED_ROUTES.BEST_MATCHES, FEED_ROUTES.MOST_RECENT]
    : [FEED_ROUTES[feed]].filter(Boolean);

if (routes.length === 0) {
    throw new Error(`Unknown feed: ${feed}. Use BEST_MATCHES, MOST_RECENT, or BOTH.`);
}

const store = await Actor.openKeyValueStore();
const seenState = (dedupe && (await store.getValue('SEEN_UIDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const passes = buildFilterer();

async function fetchFeed(route) {
    const url = `https://www.upwork.com${route.path}`;
    const res = await gotScraping({
        url,
        headers: { cookie: cookieHeader },
        proxyUrl,
        followRedirect: false,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
    });
    if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || '';
        if (/login|security|signup/i.test(loc)) {
            throw new Error(`Cookies did not authenticate — ${route.label} redirected to ${loc}. Re-export cookies from a logged in Upwork session.`);
        }
    }
    if (res.statusCode === 403) {
        await Actor.setValue(`DEBUG_${route.label}_403`, res.body, { contentType: 'text/html' });
        throw new Error(`${route.label} returned 403 (Cloudflare block). Try a residential proxy.`);
    }
    if (res.statusCode !== 200) {
        throw new Error(`${route.label} returned HTTP ${res.statusCode}`);
    }
    const nuxt = extractNuxt(res.body);
    if (!nuxt) {
        await Actor.setValue(`DEBUG_${route.label}_HTML`, res.body, { contentType: 'text/html' });
        throw new Error(`${route.label}: failed to extract NUXT state. Page HTML saved as DEBUG_${route.label}_HTML.`);
    }
    const jobs = nuxt.state?.[route.stateKey]?.jobs || [];
    return jobs;
}

let pushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

for (const [idx, route] of routes.entries()) {
    if (pushed >= maxJobs) break;
    if (idx > 0) {
        const waitMs = 3000 + Math.floor(Math.random() * 3000);
        log.info(`Waiting ${waitMs}ms before next feed...`);
        await new Promise((r) => setTimeout(r, waitMs));
    }
    log.info(`Fetching ${route.label}...`);
    let rawJobs;
    try {
        rawJobs = await fetchFeed(route);
    } catch (err) {
        log.warning(`${route.label} fetch failed: ${err.message}`);
        continue;
    }
    log.info(`${route.label}: ${rawJobs.length} raw jobs in SSR state.`);
    totalSeen += rawJobs.length;

    for (const raw of rawJobs) {
        if (pushed >= maxJobs) break;
        if (!raw?.uid) continue;
        if (dedupe && seen.has(raw.uid)) {
            deduped += 1;
            continue;
        }
        const job = normalizeJob(raw, route.label);
        if (!passes(job)) {
            filteredOut += 1;
            continue;
        }
        job.scrapedAt = new Date().toISOString();
        await Actor.pushData(job);
        newSeen.add(raw.uid);
        pushed += 1;
        if (pushed > 1) __chargeJobs.push(Actor.charge({ eventName: 'opportunity_match' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    }
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-10_000);
    await store.setValue('SEEN_UIDS', trimmed);
}

log.info(`Done. Pushed ${pushed} jobs. (seen=${totalSeen}, filtered=${filteredOut}, deduped=${deduped}, max=${maxJobs})`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();
