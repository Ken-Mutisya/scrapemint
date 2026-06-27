// Glassdoor Company & Salary Scraper (No Login)
//
// Strategy
// --------
// Glassdoor exposes three public surfaces per company without auth:
//   * Overview page: rating, CEO approval, recommend rate, HQ, size, industry,
//     founded year, revenue, ratings breakdown.
//   * Salaries page: salary ranges per job title (low / median / high) with
//     anonymized sample sizes.
//   * Reviews page: most recent review snippets (title, rating, pros, cons,
//     position, location, date).
// We hit Overview first for identity + ratings, then optionally fetch Salaries
// and Reviews. We prefer parsing the embedded __NEXT_DATA__ JSON when present,
// and fall back to defensive DOM selectors. One row per company.
//
// Pay-per-event:
//   company_intel ($0.03) charged when a company row is pushed.
//   First 3 company rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_COMPANIES = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyUrls = [],
    includeSalaries = true,
    includeReviews = true,
    salariesPerCompany = 25,
    reviewsPerCompany = 10,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

const companies = [];
for (const raw of companyUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseGlassdoorUrl(String(v).trim());
    if (parsed && !companies.some((c) => c.employerId === parsed.employerId)) companies.push(parsed);
}

if (companies.length === 0) {
    log.warning('No valid Glassdoor company URLs provided. Examples: https://www.glassdoor.com/Overview/Working-at-OpenAI-EI_IE5390716.11,17.htm, https://www.glassdoor.com/Reviews/Stripe-Reviews-E671932.htm');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const companyById = new Map(companies.map((c) => [c.employerId, c]));
const partials = new Map();
const stages = new Map(); // employerId -> { overview: bool, salaries: bool, reviews: bool, pushed: bool }
const pushed = new Set();

for (const c of companies) {
    stages.set(c.employerId, {
        overview: false,
        salaries: !includeSalaries,
        reviews: !includeReviews,
        pushed: false,
    });
}

const initialRequests = companies.map((c) => ({
    url: c.overviewUrl,
    userData: { type: 'overview', employerId: c.employerId },
    uniqueKey: `overview:${c.employerId}`,
}));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(12, Number(concurrency) || 4)),
    headless: true,
    navigationTimeoutSecs: 50,
    requestHandlerTimeoutSecs: 100,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 50000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'overview') return handleOverview(ctx);
        if (t === 'salaries') return handleSalaries(ctx);
        if (t === 'reviews') return handleReviews(ctx);
    },
    async failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
        // Even on failure, advance stage so we still push what we have.
        const id = request.userData?.employerId;
        const t = request.userData?.type;
        if (id && t) {
            const s = stages.get(id);
            if (s && !s[t]) {
                s[t] = true;
                await tryFlush(id);
            }
        }
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Companies requested: ${companies.length}. Companies pushed: ${pushed.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleOverview({ page, request, crawler: c }) {
    const company = companyById.get(request.userData.employerId);
    if (!company) return;

    await dismissModals(page);

    try {
        await page.waitForSelector('main, [data-test="employer-overview"], h1, [data-test="company-name"]', { timeout: 12000 });
    } catch {}

    const data = await extractOverview(page);
    const partial = partials.get(company.employerId) ?? blankRow(company);
    Object.assign(partial, normalizeOverview(data));
    partials.set(company.employerId, partial);

    const s = stages.get(company.employerId);
    s.overview = true;

    if (includeSalaries && !s.salaries) {
        await c.addRequests([{
            url: company.salariesUrl,
            userData: { type: 'salaries', employerId: company.employerId },
            uniqueKey: `salaries:${company.employerId}`,
        }]);
    }
    if (includeReviews && !s.reviews) {
        await c.addRequests([{
            url: company.reviewsUrl,
            userData: { type: 'reviews', employerId: company.employerId },
            uniqueKey: `reviews:${company.employerId}`,
        }]);
    }

    await tryFlush(company.employerId);
}

async function handleSalaries({ page, request }) {
    const company = companyById.get(request.userData.employerId);
    if (!company) return;
    await dismissModals(page);

    try {
        await page.waitForSelector('main, [data-test="salary-list"], h1', { timeout: 12000 });
    } catch {}

    const salaries = await extractSalaries(page, salariesPerCompany);
    const partial = partials.get(company.employerId) ?? blankRow(company);
    partial.salaries = salaries;
    partials.set(company.employerId, partial);

    const s = stages.get(company.employerId);
    s.salaries = true;
    await tryFlush(company.employerId);
}

async function handleReviews({ page, request }) {
    const company = companyById.get(request.userData.employerId);
    if (!company) return;
    await dismissModals(page);

    try {
        await page.waitForSelector('main, [data-test="reviewList"], h1', { timeout: 12000 });
    } catch {}

    const reviews = await extractReviews(page, reviewsPerCompany);
    const partial = partials.get(company.employerId) ?? blankRow(company);
    partial.reviews = reviews;
    partials.set(company.employerId, partial);

    const s = stages.get(company.employerId);
    s.reviews = true;
    await tryFlush(company.employerId);
}

// ---------- Flush ----------

// pushData and charge must be awaited so a fast actor exit cannot drop the
// buffered write/charge (see forexfactory feed-path bug, 2026-06-27).
async function tryFlush(employerId) {
    const s = stages.get(employerId);
    if (!s || s.pushed) return;
    if (!s.overview) return;
    if (includeSalaries && !s.salaries) return;
    if (includeReviews && !s.reviews) return;

    const row = partials.get(employerId);
    if (!row) return;

    if (!includeSalaries) row.salaries = [];
    if (!includeReviews) row.reviews = [];
    row.scrapedAt = new Date().toISOString();

    s.pushed = true;
    pushed.add(employerId);

    await Actor.pushData(row);
    if (pushed.size > FREE_TIER_COMPANIES) {
        try {
            await Actor.charge({ eventName: 'company_intel' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
    log.info(`Pushed ${employerId} ${row.companyName ?? ''}: rating=${row.rating ?? '?'}, salaries=${row.salaries.length}, reviews=${row.reviews.length}.`);
}

// ---------- Extraction ----------

async function dismissModals(page) {
    try {
        await page.evaluate(() => {
            const close = document.querySelector('[data-test="modal-close"], [aria-label="Close"], button.modal_closeIcon');
            if (close) close.click();
        });
    } catch {}
}

async function extractOverview(page) {
    return page.evaluate(() => {
        const sel = (s) => document.querySelector(s);
        const all = (s) => [...document.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        let nextData = null;
        const nd = sel('script#__NEXT_DATA__');
        if (nd) {
            try { nextData = JSON.parse(nd.textContent || 'null'); } catch {}
        }

        const employer = findEmployer(nextData);

        const name = employer?.shortName || employer?.name
            || text(sel('[data-test="employer-name"], h1[data-test="company-name"], h1'))
            || meta('og:title')
            || null;

        const ratingNum = numeric(employer?.ratings?.overallRating)
            ?? numeric(text(sel('[data-test="rating-headline-avg-ratings"], [data-test="rating"], .rating-headline')));

        const ceoApproval = pct(employer?.ceo?.pctApproval ?? employer?.ratings?.ceoRating)
            ?? pct(text(sel('[data-test="ceo-approval"]')));

        const recommend = pct(employer?.ratings?.recommendToFriendRating)
            ?? pct(text(sel('[data-test="recommend-to-friend"]')));

        const breakdown = {
            workLifeBalance: numeric(employer?.ratings?.workLifeBalanceRating),
            compensationAndBenefits: numeric(employer?.ratings?.compensationAndBenefitsRating),
            cultureAndValues: numeric(employer?.ratings?.cultureAndValuesRating),
            seniorManagement: numeric(employer?.ratings?.seniorManagementRating),
            careerOpportunities: numeric(employer?.ratings?.careerOpportunitiesRating),
            diversityAndInclusion: numeric(employer?.ratings?.diversityAndInclusionRating),
        };

        const headquarters = employer?.headquarters || employer?.primaryLocation?.locationName
            || readDef('Headquarters');
        const size = employer?.size || employer?.sizeCategory || readDef('Size');
        const industry = employer?.primaryIndustry?.industryName || employer?.industry?.industryName
            || readDef('Industry');
        const founded = numeric(employer?.yearFounded) || numeric(readDef('Founded'));
        const revenue = employer?.revenue || readDef('Revenue');
        const type = employer?.type || readDef('Type');
        const website = employer?.website || readDef('Website');

        const ceoName = employer?.ceo?.name || null;

        return {
            name,
            ratingNum,
            ceoApproval,
            recommend,
            breakdown,
            headquarters,
            size,
            industry,
            founded,
            revenue,
            type,
            website,
            ceoName,
        };

        function readDef(label) {
            // Definition lists / labelled rows on the overview page.
            const dts = all('dt, .infoEntity__title, [data-test^="employer-"], li, div');
            for (const dt of dts) {
                const t = (dt.textContent || '').trim();
                if (!t) continue;
                if (new RegExp(`^${label}\\b`, 'i').test(t)) {
                    const dd = dt.nextElementSibling || dt.querySelector(':scope > *:last-child');
                    const v = dd && dd !== dt ? (dd.textContent || '').trim() : t.replace(new RegExp(`^${label}\\b\\s*[:\\-]?\\s*`, 'i'), '').trim();
                    if (v && v !== label) return v;
                }
            }
            return null;
        }

        function findEmployer(root) {
            if (!root) return null;
            const queue = [root];
            const seen = new Set();
            while (queue.length) {
                const node = queue.shift();
                if (!node || typeof node !== 'object' || seen.has(node)) continue;
                seen.add(node);
                if ((node.shortName || node.name) && (node.ratings || node.id || node.employerId)) {
                    if (!('exposure' in node) && !('articleBody' in node)) return node;
                }
                for (const k of Object.keys(node)) {
                    const v = node[k];
                    if (v && typeof v === 'object') queue.push(v);
                }
            }
            return null;
        }

        function numeric(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
            return Number.isFinite(n) ? n : null;
        }
        function pct(v) {
            if (v === null || v === undefined || v === '') return null;
            const m = String(v).match(/(\d{1,3})\s*%?/);
            if (!m) return null;
            const n = parseInt(m[1], 10);
            return n >= 0 && n <= 100 ? n : null;
        }
    });
}

async function extractSalaries(page, max) {
    return page.evaluate((max) => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const nd = sel('script#__NEXT_DATA__');
        let nextData = null;
        if (nd) { try { nextData = JSON.parse(nd.textContent || 'null'); } catch {} }

        const fromJson = collectSalariesFromJson(nextData);
        if (fromJson.length) return fromJson.slice(0, max);

        // DOM fallback: salary list rows.
        const rows = all('[data-test="salary-list"] [data-test^="salary-row"], [data-test="salary-row"], .salaryRow, li.salaryRow');
        const out = [];
        for (const row of rows) {
            const title = text(sel('[data-test="job-title"], a[data-test="job-title"], h3, .jobTitle', row));
            if (!title) continue;
            const range = text(sel('[data-test="pay-range"], [data-test="salary-range"], .salaryRange', row));
            const median = text(sel('[data-test="median-base-pay"], .salaryMedian, .median', row));
            const sample = text(sel('[data-test="salary-count"], .salaryCount', row));
            const parsed = parseRange(range);
            const med = parsedNumber(median);
            out.push({
                title,
                low: parsed.low,
                median: med ?? parsed.mid ?? null,
                high: parsed.high,
                currency: parsed.currency || 'USD',
                period: parsed.period || 'year',
                sampleSize: parseSample(sample),
            });
            if (out.length >= max) break;
        }
        return out;

        function collectSalariesFromJson(root) {
            if (!root) return [];
            const items = [];
            const queue = [root];
            const seen = new Set();
            while (queue.length) {
                const node = queue.shift();
                if (!node || typeof node !== 'object' || seen.has(node)) continue;
                seen.add(node);
                if (Array.isArray(node)) { for (const v of node) queue.push(v); continue; }

                const looksLikeSalary = (node.payPeriod || node.basePay || node.medianBasePay || node.payPercentile50 || node.salaryRange)
                    && (node.jobTitle || node.jobTitleText || (node.jobTitle && node.jobTitle.text));
                if (looksLikeSalary) {
                    const title = node.jobTitle?.text || node.jobTitle || node.jobTitleText || null;
                    const low = num(node.basePay?.p10 ?? node.payPercentile10 ?? node.salaryRange?.low);
                    const median = num(node.basePay?.p50 ?? node.medianBasePay ?? node.payPercentile50 ?? node.salaryRange?.median);
                    const high = num(node.basePay?.p90 ?? node.payPercentile90 ?? node.salaryRange?.high);
                    const currency = node.currency?.code || node.basePay?.currency || 'USD';
                    const period = node.payPeriod || 'year';
                    const sampleSize = num(node.count ?? node.sampleSize);
                    if (title) items.push({ title, low, median, high, currency, period, sampleSize });
                }
                for (const k of Object.keys(node)) {
                    const v = node[k];
                    if (v && typeof v === 'object') queue.push(v);
                }
            }
            // Dedupe by title.
            const seenTitle = new Set();
            return items.filter(i => {
                const k = i.title.toLowerCase();
                if (seenTitle.has(k)) return false;
                seenTitle.add(k);
                return true;
            });
        }

        function num(v) {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
            return Number.isFinite(n) ? n : null;
        }
        function parsedNumber(t) {
            if (!t) return null;
            const m = t.match(/([\d,.]+)\s*([kKmM]?)/);
            if (!m) return null;
            let n = parseFloat(m[1].replace(/,/g, ''));
            if (!Number.isFinite(n)) return null;
            if (m[2] === 'k' || m[2] === 'K') n *= 1000;
            if (m[2] === 'm' || m[2] === 'M') n *= 1000000;
            return Math.round(n);
        }
        function parseRange(t) {
            if (!t) return { low: null, mid: null, high: null, currency: 'USD', period: 'year' };
            const currency = /€/.test(t) ? 'EUR' : /£/.test(t) ? 'GBP' : 'USD';
            const period = /\/\s*hr|hour/i.test(t) ? 'hour' : /\/\s*mo|month/i.test(t) ? 'month' : 'year';
            const nums = [...t.matchAll(/([\d,.]+)\s*([kKmM]?)/g)].map(m => {
                let n = parseFloat(m[1].replace(/,/g, ''));
                if (m[2] === 'k' || m[2] === 'K') n *= 1000;
                if (m[2] === 'm' || m[2] === 'M') n *= 1000000;
                return Number.isFinite(n) ? Math.round(n) : null;
            }).filter(Boolean);
            if (nums.length >= 2) return { low: nums[0], mid: null, high: nums[1], currency, period };
            if (nums.length === 1) return { low: null, mid: nums[0], high: null, currency, period };
            return { low: null, mid: null, high: null, currency, period };
        }
        function parseSample(t) {
            if (!t) return null;
            const m = t.replace(/,/g, '').match(/(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        }
    }, max);
}

async function extractReviews(page, max) {
    return page.evaluate((max) => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const nd = sel('script#__NEXT_DATA__');
        let nextData = null;
        if (nd) { try { nextData = JSON.parse(nd.textContent || 'null'); } catch {} }

        const fromJson = collectReviewsFromJson(nextData);
        if (fromJson.length) return fromJson.slice(0, max);

        const cards = all('[data-test="reviewList"] li, [data-test="employer-review"], li.empReview, article[data-test="reviewSnapshot"]');
        const out = [];
        for (const card of cards) {
            const title = text(sel('[data-test="review-summary"] a, [data-test="review-summary"], h2, h3', card));
            const rating = num(text(sel('[data-test="review-rating"], .rating, [aria-label*="rating" i]', card))
                || (sel('[aria-label*="of 5" i]', card)?.getAttribute('aria-label')));
            const pros = text(sel('[data-test="pros"] span, [data-test="pros"], .pros', card));
            const cons = text(sel('[data-test="cons"] span, [data-test="cons"], .cons', card));
            const position = text(sel('[data-test="reviewer-job-title"], .author-info, .common__EiReviewDetailsStyle__newUiJobLine', card));
            const location = text(sel('[data-test="reviewer-location"]', card));
            const date = text(sel('time, [data-test="review-date"]', card));
            if (!title && !pros && !cons) continue;
            out.push({ title, rating, pros, cons, position, location, date });
            if (out.length >= max) break;
        }
        return out;

        function collectReviewsFromJson(root) {
            if (!root) return [];
            const items = [];
            const queue = [root];
            const seen = new Set();
            while (queue.length) {
                const node = queue.shift();
                if (!node || typeof node !== 'object' || seen.has(node)) continue;
                seen.add(node);
                if (Array.isArray(node)) { for (const v of node) queue.push(v); continue; }
                const looksLikeReview = (node.summary || node.advice || node.pros || node.cons)
                    && (node.ratingOverall !== undefined || node.overallRating !== undefined || node.ratingCeo !== undefined);
                if (looksLikeReview) {
                    items.push({
                        title: node.summary || null,
                        rating: num(node.ratingOverall ?? node.overallRating),
                        pros: node.pros || null,
                        cons: node.cons || null,
                        position: node.jobTitle?.text || node.jobTitle || null,
                        location: node.location?.name || node.location || null,
                        date: node.reviewDateTime || node.dateTime || null,
                    });
                }
                for (const k of Object.keys(node)) {
                    const v = node[k];
                    if (v && typeof v === 'object') queue.push(v);
                }
            }
            return items;
        }

        function num(v) {
            if (v === null || v === undefined || v === '') return null;
            const m = String(v).match(/([\d.]+)/);
            if (!m) return null;
            const n = parseFloat(m[1]);
            return Number.isFinite(n) ? n : null;
        }
    }, max);
}

// ---------- Normalization ----------

function blankRow(company) {
    return {
        employerId: company.employerId,
        url: company.canonicalUrl,
        overviewUrl: company.overviewUrl,
        salariesUrl: company.salariesUrl,
        reviewsUrl: company.reviewsUrl,
        slug: company.slug,
        companyName: null,
        rating: null,
        ceoApprovalPct: null,
        recommendPct: null,
        ratingsBreakdown: {
            workLifeBalance: null,
            compensationAndBenefits: null,
            cultureAndValues: null,
            seniorManagement: null,
            careerOpportunities: null,
            diversityAndInclusion: null,
        },
        headquarters: null,
        size: null,
        industry: null,
        founded: null,
        revenue: null,
        type: null,
        website: null,
        ceoName: null,
        salaries: [],
        reviews: [],
        scrapedAt: null,
    };
}

function normalizeOverview(d) {
    return {
        companyName: d.name || null,
        rating: d.ratingNum ?? null,
        ceoApprovalPct: d.ceoApproval ?? null,
        recommendPct: d.recommend ?? null,
        ratingsBreakdown: d.breakdown || {},
        headquarters: d.headquarters || null,
        size: d.size || null,
        industry: d.industry || null,
        founded: d.founded || null,
        revenue: d.revenue || null,
        type: d.type || null,
        website: d.website || null,
        ceoName: d.ceoName || null,
    };
}

// ---------- URL helpers ----------

function parseGlassdoorUrl(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)glassdoor\.[a-z.]+$/.test(host)) return null;

    const path = u.pathname;
    // Match the employer ID from any of:
    //   /Overview/...EI_IE{ID}.{a},{b}.htm
    //   /Reviews/{Slug}-Reviews-E{ID}.htm
    //   /Salary/{Slug}-Salaries-E{ID}.htm
    //   /Salaries/{Slug}-E{ID}.htm
    let id = null;
    let m;
    if ((m = path.match(/EI_IE(\d+)/i))) id = m[1];
    else if ((m = path.match(/-E(\d+)(?=\.htm|\?|$)/i))) id = m[1];
    if (!id) return null;

    // Slug: take the company segment from the path if available.
    let slug = null;
    if ((m = path.match(/\/Reviews\/([^/]+)-Reviews-E\d+/i))) slug = m[1];
    else if ((m = path.match(/\/Salary\/([^/]+)-Salaries-E\d+/i))) slug = m[1];
    else if ((m = path.match(/\/Overview\/Working-at-([^/]+)-EI_IE\d+/i))) slug = m[1];
    if (!slug) slug = `Employer-${id}`;

    const base = `${u.protocol}//${host}`;
    const overviewUrl = path.match(/\/Overview\//i)
        ? `${base}${path}`
        : `${base}/Overview/Working-at-${slug}-EI_IE${id}.0,${slug.length}.htm`;
    const reviewsUrl = `${base}/Reviews/${slug}-Reviews-E${id}.htm`;
    const salariesUrl = `${base}/Salary/${slug}-Salaries-E${id}.htm`;

    return {
        employerId: id,
        slug,
        canonicalUrl: overviewUrl,
        overviewUrl,
        reviewsUrl,
        salariesUrl,
    };
}
