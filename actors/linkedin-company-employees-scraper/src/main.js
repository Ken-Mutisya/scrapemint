// LinkedIn Company Employees Scraper (No Cookies)
//
// Strategy
// --------
// LinkedIn's authenticated /voyager/ API requires a session cookie. The public
// /company/{handle}/people/ surface is the only people-facing page served to
// anonymous visitors. It carries:
//   * total headcount link ("See all N employees on LinkedIn")
//   * insight cards distributing employees by location, role, skill, school
//   * a small set of featured employee cards (count varies per company)
// We hit the people page first, fall back to landing/about for headcount when
// the people surface is gated, parse the distribution lists and any visible
// employee cards, and ship a single normalized row per company.
//
// Pay-per-event:
//   company_people ($0.02) charged when a company row is pushed.
//   First 3 company rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_COMPANIES = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyUrls = [],
    includeInsights = true,
    includeFeaturedEmployees = true,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const companies = [];
for (const raw of companyUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseCompanyUrl(String(v).trim());
    if (parsed && !companies.some((c) => c.key === parsed.key)) companies.push(parsed);
}

if (companies.length === 0) {
    log.warning('No valid LinkedIn company URLs provided. Examples: https://www.linkedin.com/company/microsoft/, https://www.linkedin.com/company/openai/');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const companyByKey = new Map(companies.map((c) => [c.key, c]));
const peopleDone = new Set();
const partials = new Map();

const initialRequests = companies.map((c) => ({
    url: `${c.baseUrl}people/`,
    userData: { type: 'people', companyKey: c.key },
    uniqueKey: `people:${c.key}`,
}));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 6)),
    headless: true,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 8, maxErrorScore: 1 },
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
            gotoOptions.timeout = 45000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'people') return handlePeople(ctx);
        if (t === 'landing') return handleLanding(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Companies requested: ${companies.length}. Companies pushed: ${peopleDone.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handlePeople({ page, request, crawler: c }) {
    const company = companyByKey.get(request.userData.companyKey);
    if (!company) return;

    try {
        await page.waitForSelector(
            'main, .org-people, .org-people-profiles-module, .top-card-layout, h1',
            { timeout: 12000 },
        );
    } catch {}

    const data = await extractPeopleData(page);
    const merged = normalize(company, data);

    const hasSignal = merged.totalEmployees !== null
        || merged.featuredEmployees.length > 0
        || merged.insights.locations.length > 0
        || merged.insights.jobFunctions.length > 0
        || merged.insights.skills.length > 0
        || merged.insights.schools.length > 0;

    if (!hasSignal) {
        log.info(`People page empty for ${company.key}, falling back to landing.`);
        partials.set(company.key, merged);
        await c.addRequests([{
            url: company.baseUrl,
            userData: { type: 'landing', companyKey: company.key },
            uniqueKey: `landing:${company.key}`,
        }]);
        return;
    }

    if (!includeInsights) merged.insights = emptyInsights();
    if (!includeFeaturedEmployees) merged.featuredEmployees = [];

    peopleDone.add(company.key);
    await Actor.pushData(merged);
    if (peopleDone.size > FREE_TIER_COMPANIES) {
        Actor.charge({ eventName: 'company_people' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed ${company.key}: total=${merged.totalEmployees ?? '?'}, featured=${merged.featuredEmployees.length}, locations=${merged.insights.locations.length}.`);
}

async function handleLanding({ page, request }) {
    const company = companyByKey.get(request.userData.companyKey);
    if (!company) return;
    if (peopleDone.has(company.key)) return;

    try {
        await page.waitForSelector('main, .top-card-layout, h1', { timeout: 12000 });
    } catch {}

    const landing = await extractLandingFallback(page);
    const partial = partials.get(company.key) ?? normalize(company, emptyExtract());

    if (landing.totalEmployees !== null) partial.totalEmployees = landing.totalEmployees;
    if (!partial.companyName && landing.name) partial.companyName = landing.name;

    if (!includeInsights) partial.insights = emptyInsights();
    if (!includeFeaturedEmployees) partial.featuredEmployees = [];

    peopleDone.add(company.key);
    await Actor.pushData(partial);
    if (peopleDone.size > FREE_TIER_COMPANIES) {
        Actor.charge({ eventName: 'company_people' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed ${company.key} from landing fallback.`);
}

// ---------- Extraction ----------

async function extractPeopleData(page) {
    return page.evaluate(() => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        const ldJson = [];
        all('script[type="application/ld+json"]').forEach((s) => {
            try {
                const parsed = JSON.parse(s.textContent || 'null');
                if (Array.isArray(parsed)) ldJson.push(...parsed);
                else if (parsed) ldJson.push(parsed);
            } catch {}
        });

        const orgLd = ldJson.find((x) => {
            const t = x?.['@type'];
            if (!t) return false;
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => /Organization|Corporation|EducationalOrganization/i.test(tt));
        }) || ldJson[0] || null;

        const name = text(sel('h1, .org-top-card-summary__title, .top-card-layout__title'))
            || meta('og:title')
            || (orgLd && (orgLd.name || orgLd.legalName))
            || null;

        const totalText = text(sel('a[href*="/people/"], a[data-test-id="employees-on-linkedin"], .org-top-card-summary-info-list__info-item'))
            || all('a').map((a) => text(a)).find((s) => /employee/i.test(s) && /\d/.test(s))
            || '';

        // Insight cards. Public surface usually exposes 4 lists: where they live,
        // what they do, what they're skilled at, where they studied. Selectors are
        // defensive because LinkedIn rotates DOM.
        const insightCards = all('section, .org-people-bar-graph-module, .insight-cards__card, [data-test-id="insight-card"]');
        const captured = { locations: [], jobFunctions: [], skills: [], schools: [] };

        for (const card of insightCards) {
            const heading = text(sel('h2, h3, h4, .insight-cards__title', card)).toLowerCase();
            if (!heading) continue;

            const items = all('li, .org-people-bar-graph-element, .insight-cards__row', card)
                .map((li) => {
                    const labelEl = sel('a, span:not([class*="count"])', li) || li;
                    const label = text(labelEl).replace(/\s*\d[\d,]*\s*$/, '').trim();
                    const countMatch = text(li).match(/(\d[\d,]*)\s*$/);
                    const count = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null;
                    return label ? { label, count } : null;
                })
                .filter(Boolean)
                .slice(0, 50);

            if (!items.length) continue;

            if (/where.*live|location|country|city/i.test(heading)) captured.locations = items;
            else if (/what.*do|function|role|job/i.test(heading)) captured.jobFunctions = items;
            else if (/skill/i.test(heading)) captured.skills = items;
            else if (/stud|school|education|university/i.test(heading)) captured.schools = items;
        }

        // Featured / public employee cards. Anonymous visitors typically see a few
        // employee profile cards on the people page header strip.
        const featured = all('.org-people-profile-card, .org-people-profiles-module__profile-list li, [data-test-id="profile-card"], a[href*="/in/"]')
            .map((el) => {
                const link = el.tagName === 'A' ? el : sel('a[href*="/in/"]', el);
                const href = link?.getAttribute('href') || null;
                if (!href || !/\/in\//.test(href)) return null;
                const profileUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
                const name = text(sel('.org-people-profile-card__profile-title, .artdeco-entity-lockup__title, h3, .profile-card__name', el))
                    || text(link).split('\n')[0]
                    || null;
                const title = text(sel('.org-people-profile-card__profile-position, .artdeco-entity-lockup__subtitle, .profile-card__title', el)) || null;
                const location = text(sel('.org-people-profile-card__profile-location, .artdeco-entity-lockup__caption, .profile-card__location', el)) || null;
                const photo = sel('img', el)?.getAttribute('src') || null;
                return { name, title, location, profileUrl, photoUrl: photo };
            })
            .filter((e) => e && e.profileUrl && e.name);

        // Dedupe featured by profileUrl.
        const seen = new Set();
        const featuredEmployees = [];
        for (const f of featured) {
            const key = f.profileUrl.split('?')[0];
            if (seen.has(key)) continue;
            seen.add(key);
            featuredEmployees.push(f);
        }

        return {
            companyName: name,
            totalText,
            insights: captured,
            featuredEmployees,
        };
    });
}

async function extractLandingFallback(page) {
    return page.evaluate(() => {
        const sel = (s) => document.querySelector(s);
        const all = (s) => [...document.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        const name = text(sel('h1, .org-top-card-summary__title, .top-card-layout__title'))
            || meta('og:title')
            || null;

        const employeesText = text(sel('a[href*="/people/"], a[data-test-id="employees-on-linkedin"]'))
            || all('a').map((a) => text(a)).find((s) => /employee/i.test(s) && /\d/.test(s))
            || '';

        return {
            name,
            totalEmployees: parseTotalCount(employeesText),
        };

        function parseTotalCount(t) {
            if (!t) return null;
            const m = t.toLowerCase().replace(/,/g, '').match(/([\d.]+)\s*([kmb])?\s*employee/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (Number.isNaN(n)) return null;
            if (m[2] === 'k') n *= 1000;
            else if (m[2] === 'm') n *= 1000000;
            else if (m[2] === 'b') n *= 1000000000;
            return Math.round(n);
        }
    });
}

function emptyExtract() {
    return {
        companyName: null,
        totalText: '',
        insights: { locations: [], jobFunctions: [], skills: [], schools: [] },
        featuredEmployees: [],
    };
}

function emptyInsights() {
    return { locations: [], jobFunctions: [], skills: [], schools: [] };
}

function normalize(company, data) {
    return {
        handle: company.handle,
        kind: company.kind,
        url: `${company.baseUrl}people/`,
        companyUrl: company.canonicalUrl,
        companyName: data.companyName || company.handle,
        totalEmployees: parseTotalCount(data.totalText),
        insights: {
            locations: Array.isArray(data.insights?.locations) ? data.insights.locations : [],
            jobFunctions: Array.isArray(data.insights?.jobFunctions) ? data.insights.jobFunctions : [],
            skills: Array.isArray(data.insights?.skills) ? data.insights.skills : [],
            schools: Array.isArray(data.insights?.schools) ? data.insights.schools : [],
        },
        featuredEmployees: Array.isArray(data.featuredEmployees) ? data.featuredEmployees : [],
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- URL helpers ----------

function parseCompanyUrl(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)linkedin\.com$/.test(host)) return null;

    const path = u.pathname.replace(/\/+$/, '');
    const m = path.match(/^\/(company|school|showcase)\/([^/]+)/i);
    if (!m) return null;
    const kindPath = m[1].toLowerCase();
    const handle = decodeURIComponent(m[2]).toLowerCase();
    const kind = kindPath === 'company' ? 'company' : kindPath;
    const baseUrl = `https://www.linkedin.com/${kindPath}/${handle}/`;
    return {
        kind,
        handle,
        key: `${kindPath}:${handle}`,
        baseUrl,
        canonicalUrl: baseUrl,
    };
}

// ---------- Parsing helpers ----------

function parseTotalCount(t) {
    if (!t) return null;
    const m = t.toLowerCase().replace(/,/g, '').match(/([\d.]+)\s*([kmb])?\s*employee/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
