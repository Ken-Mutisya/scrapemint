// LinkedIn Company Profile Scraper (No Cookies)
//
// Strategy
// --------
// LinkedIn's authenticated /voyager/ API requires a session cookie. Two surfaces
// expose company facts without one:
//   1. /company/{handle}/about/   the public about page, served to anonymous
//      visitors with a join-wall but with the structured fact block intact in
//      the static HTML and JSON-LD payloads.
//   2. /company/{handle}/         the landing page, useful as a fallback for
//      logo, banner, follower count, and tagline when the about page is
//      gated.
//
// We hit the about page first, fall back to landing, parse JSON-LD plus
// dt/dd pairs plus meta tags, and ship a single normalized row per company.
//
// Pay-per-event:
//   company_profile ($0.02) charged when a company row is pushed.
//   First 3 company profiles per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_COMPANIES = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyUrls = [],
    includeLocations = true,
    includeSpecialties = true,
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
const aboutDone = new Set();

const initialRequests = companies.map((c) => ({
    url: `${c.baseUrl}about/`,
    userData: { type: 'about', companyKey: c.key },
    uniqueKey: `about:${c.key}`,
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
        if (t === 'about') return handleAbout(ctx);
        if (t === 'landing') return handleLanding(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Companies requested: ${companies.length}. Companies pushed: ${aboutDone.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleAbout({ page, request, crawler: c }) {
    const company = companyByKey.get(request.userData.companyKey);
    if (!company) return;

    try {
        await page.waitForSelector(
            'main, .org-page-details, .org-about-module, .top-card-layout, h1',
            { timeout: 12000 },
        );
    } catch {}

    const data = await extractCompanyData(page);
    const merged = normalize(company, data);

    const hasFacts = merged.industry || merged.headquarters || merged.companySize
        || merged.specialties.length > 0 || merged.website || merged.founded;

    if (!hasFacts) {
        log.info(`About page empty for ${company.key}, falling back to landing.`);
        await c.addRequests([{
            url: company.baseUrl,
            userData: { type: 'landing', companyKey: company.key },
            uniqueKey: `landing:${company.key}`,
        }]);
        return;
    }

    if (!includeLocations) merged.locations = [];
    if (!includeSpecialties) merged.specialties = [];

    aboutDone.add(company.key);
    await Actor.pushData(merged);
    if (aboutDone.size > FREE_TIER_COMPANIES) {
        Actor.charge({ eventName: 'company_profile' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed ${company.key}: industry=${merged.industry || '?'}, hq=${merged.headquarters || '?'}, size=${merged.companySize || '?'}.`);
}

async function handleLanding({ page, request }) {
    const company = companyByKey.get(request.userData.companyKey);
    if (!company) return;
    if (aboutDone.has(company.key)) return;

    try {
        await page.waitForSelector('main, .top-card-layout, h1', { timeout: 12000 });
    } catch {}

    const data = await extractCompanyData(page);
    const merged = normalize(company, data);
    if (!includeLocations) merged.locations = [];
    if (!includeSpecialties) merged.specialties = [];

    aboutDone.add(company.key);
    await Actor.pushData(merged);
    if (aboutDone.size > FREE_TIER_COMPANIES) {
        Actor.charge({ eventName: 'company_profile' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed ${company.key} from landing fallback.`);
}

// ---------- Extraction ----------

async function extractCompanyData(page) {
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

        // dt/dd pairs are how the about page renders structured facts.
        const factPairs = {};
        all('section dt, .org-page-details dt, dl dt').forEach((dt) => {
            const key = text(dt).toLowerCase().replace(/[:.\s]+$/, '');
            const dd = dt.nextElementSibling;
            if (!key || !dd) return;
            const value = text(dd);
            if (!value) return;
            factPairs[key] = value;
        });

        const name = text(sel('h1, .org-top-card-summary__title, .top-card-layout__title'))
            || meta('og:title')
            || (orgLd && (orgLd.name || orgLd.legalName))
            || null;

        const tagline = text(sel('.org-top-card-summary__tagline, .top-card-layout__headline, .org-top-card-summary__headline'))
            || (orgLd && orgLd.slogan)
            || null;

        const description = text(sel('.org-about-us-organization-description__text, .org-about-module__description, [data-test-id="about-us__description"], .break-words.white-space-pre-wrap'))
            || meta('og:description')
            || (orgLd && orgLd.description)
            || null;

        const logoUrl = sel('.org-top-card-primary-content__logo img, .top-card-layout__entity-image, img.lazy-image')?.src
            || meta('og:image')
            || (orgLd && (orgLd.logo?.url || orgLd.logo))
            || null;

        const bannerUrl = sel('.org-top-card-primary-content__hero img, .cover-img__image, .top-card-layout__cover-image img')?.src
            || null;

        const followerText = text(sel('.org-top-card-summary-info-list__info-item, .top-card-layout__first-subline, .org-top-card__primary-content [data-test-id="followers"]'))
            || text(sel('.org-page-details__definition-text'));

        const employeesText = text(sel('a[href*="/people/"], a[data-test-id="employees-on-linkedin"]'));

        const websiteUrl = (sel('a[data-test-id="about-us__website"]')?.href)
            || factPairs.website
            || (orgLd && (orgLd.url || orgLd.sameAs?.[0]))
            || null;

        const industry = factPairs.industry
            || factPairs.industries
            || (orgLd && orgLd.industry)
            || null;

        const companySize = factPairs['company size']
            || factPairs['company size on linkedin']
            || factPairs.size
            || (orgLd && orgLd.numberOfEmployees && (orgLd.numberOfEmployees.value || orgLd.numberOfEmployees))
            || null;

        const headquarters = factPairs.headquarters
            || (orgLd && orgLd.address && [orgLd.address.addressLocality, orgLd.address.addressRegion, orgLd.address.addressCountry].filter(Boolean).join(', '))
            || null;

        const founded = factPairs.founded || (orgLd && orgLd.foundingDate) || null;
        const orgType = factPairs.type || (orgLd && orgLd.legalType) || null;

        const specialtiesRaw = factPairs.specialties || (orgLd && orgLd.knowsAbout) || null;
        const specialties = Array.isArray(specialtiesRaw)
            ? specialtiesRaw
            : (typeof specialtiesRaw === 'string' ? specialtiesRaw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []);

        const stockSymbol = factPairs['stock symbol'] || (orgLd && orgLd.tickerSymbol) || null;

        const locations = all('.org-locations__list li, .org-locations-module__locations li, [data-test-id="location-card"]').map((el) => {
            const lines = text(el).split(/\s{2,}|\n+/).map((s) => s.trim()).filter(Boolean);
            return {
                line1: lines[0] || null,
                line2: lines[1] || null,
                country: lines[lines.length - 1] || null,
                raw: text(el),
            };
        });

        return {
            name,
            tagline,
            description,
            logoUrl,
            bannerUrl,
            followerText,
            employeesText,
            websiteUrl,
            industry,
            companySize,
            headquarters,
            founded,
            orgType,
            specialties,
            stockSymbol,
            locations,
        };
    });
}

function normalize(company, data) {
    return {
        handle: company.handle,
        kind: company.kind,
        url: company.canonicalUrl,
        name: data.name || company.handle,
        tagline: data.tagline || null,
        description: data.description || null,
        logoUrl: data.logoUrl || null,
        bannerUrl: data.bannerUrl || null,
        industry: data.industry || null,
        companySize: data.companySize || null,
        employeeCount: parseEmployeeCount(data.employeesText),
        followerCount: parseFollowerCount(data.followerText),
        headquarters: data.headquarters || null,
        founded: data.founded || null,
        type: data.orgType || null,
        website: cleanUrl(data.websiteUrl),
        stockSymbol: data.stockSymbol || null,
        specialties: Array.isArray(data.specialties) ? data.specialties : [],
        locations: Array.isArray(data.locations) ? data.locations : [],
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

function cleanUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        return u.toString();
    } catch { return href; }
}

// ---------- Parsing helpers ----------

function parseFollowerCount(text) {
    if (!text) return null;
    const m = text.toLowerCase().replace(/,/g, '').match(/([\d.]+)\s*([kmb])?\s*follower/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}

function parseEmployeeCount(text) {
    if (!text) return null;
    const m = text.toLowerCase().replace(/,/g, '').match(/([\d.]+)\s*([kmb])?\s*employee/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
