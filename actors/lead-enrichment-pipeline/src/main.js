// Lead Enrichment Pipeline
//
// Input: list of company domains.
// For each domain we crawl up to N pages, prioritizing contact / about / team
// / careers paths. We extract emails, phones, social profile URLs, and company
// signals (name, tagline, presence of blog / pricing / careers page). One row
// per domain is written to the default dataset.
//
// Pay-per-event:
//   enriched_lead ($0.03)  charged when at least one email OR two+ socials found
//   basic_crawl   ($0.005) charged when domain crawled but no contacts found
//   First 5 enriched leads per run are free (lets buyers test on a small list).

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ENRICHED_LEADS = 5;

const PRIORITY_PATHS = [
    '/',
    '/contact',
    '/contact-us',
    '/contactus',
    '/about',
    '/about-us',
    '/team',
    '/our-team',
    '/careers',
    '/jobs',
    '/imprint',
    '/legal/contact',
    '/support',
];

const TECH_SIGNAL_PATHS = ['/blog', '/pricing', '/careers'];

const SOCIAL_HOSTS = {
    linkedin: /(?:www\.)?linkedin\.com\/(?:company|in)\/[^/?#\s"']+/i,
    twitter: /(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)[^/?#\s"']+/i,
    instagram: /(?:www\.)?instagram\.com\/(?!p\/|reel\/)[^/?#\s"']+/i,
    facebook: /(?:www\.)?facebook\.com\/(?!sharer|tr|plugins)[^/?#\s"']+/i,
    youtube: /(?:www\.)?youtube\.com\/(?:c|channel|user|@)\/?[^/?#\s"']*/i,
    github: /(?:www\.)?github\.com\/(?!features|pricing|trending)[^/?#\s"']+/i,
    tiktok: /(?:www\.)?tiktok\.com\/@[^/?#\s"']+/i,
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

const EMAIL_BLOCKLIST = [
    /@example\./i,
    /@your[-.]?domain/i,
    /sentry\.io$/i,
    /wixpress\.com$/i,
    /\.png$/i,
    /\.jpg$/i,
    /\.svg$/i,
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    maxPagesPerDomain = 8,
    includeSocialDiscovery = true,
    includeCompanyData = true,
    obeyRobotsTxt = true,
    navigationDelayMs = 1500,
    concurrency = 4,
    proxyConfiguration: proxyInput,
} = input;

if (!Array.isArray(domains) || domains.length === 0) {
    log.warning('No domains provided. Pass `domains` as an array of root domains. Examples: ["acme.com", "https://www.example.io"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const normalizeDomain = (raw) => {
    let s = String(raw).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
    return s;
};

const cleanDomains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
if (cleanDomains.length === 0) {
    log.warning(`Got ${domains.length} entries but none parsed as valid domains. Each entry must look like "acme.com" or a full URL.`);
    await Actor.exit();
}
log.info(`Enriching ${cleanDomains.length} domains.`);

// State per domain. Keyed by normalized root domain.
const state = new Map();
for (const d of cleanDomains) {
    state.set(d, {
        domain: d,
        url_canonical: null,
        company: { name: null, tagline: null, description: null, linkedin_url: null, github_org: null },
        emails: new Map(),
        phones: new Map(),
        socials: { linkedin: null, twitter: null, instagram: null, facebook: null, youtube: null, github: null, tiktok: null },
        tech_signals: { has_blog: false, has_careers_page: false, has_pricing_page: false },
        pages_scanned: 0,
    });
}

const isBlockedEmail = (e) => EMAIL_BLOCKLIST.some((re) => re.test(e));

const extractFromPage = async (page, root) => {
    const s = state.get(root);
    if (!s) return;
    s.pages_scanned += 1;
    if (!s.url_canonical) s.url_canonical = page.url();

    // mailto + visible text emails
    const emailHits = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
            const v = a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
            if (v) out.add(v);
        });
        return Array.from(out);
    });
    for (const e of emailHits) {
        if (!isBlockedEmail(e)) s.emails.set(e.toLowerCase(), { value: e, source_url: page.url(), context: 'mailto' });
    }
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const textEmails = bodyText.match(EMAIL_RE) || [];
    for (const e of textEmails) {
        if (!isBlockedEmail(e) && !s.emails.has(e.toLowerCase())) {
            s.emails.set(e.toLowerCase(), { value: e, source_url: page.url(), context: 'page text' });
        }
    }

    // tel: + text phones
    const telHits = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
            const v = a.getAttribute('href').replace(/^tel:/i, '').trim();
            if (v) out.add(v);
        });
        return Array.from(out);
    });
    for (const p of telHits) s.phones.set(p, { value: p, source_url: page.url(), context: 'tel' });
    const textPhones = (bodyText.match(PHONE_RE) || []).map((p) => p.trim()).filter((p) => p.replace(/\D/g, '').length >= 7);
    for (const p of textPhones.slice(0, 5)) {
        if (!s.phones.has(p)) s.phones.set(p, { value: p, source_url: page.url(), context: 'page text' });
    }

    // socials from anchors
    if (includeSocialDiscovery) {
        const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href));
        for (const [key, re] of Object.entries(SOCIAL_HOSTS)) {
            if (s.socials[key]) continue;
            for (const h of hrefs) {
                if (re.test(h)) { s.socials[key] = h.split('?')[0]; break; }
            }
        }
    }

    // company data on root only
    if (includeCompanyData && new URL(page.url()).pathname === '/') {
        const meta = await page.evaluate(() => {
            const og = (p) => document.querySelector(`meta[property="${p}"]`)?.content || null;
            const name = document.querySelector('meta[property="og:site_name"]')?.content
                || document.title?.split(/[|–]/)[0]?.trim()
                || null;
            return {
                name,
                tagline: og('og:title'),
                description: og('og:description') || document.querySelector('meta[name="description"]')?.content || null,
            };
        });
        s.company.name = meta.name;
        s.company.tagline = meta.tagline;
        s.company.description = meta.description;
        if (s.socials.linkedin) s.company.linkedin_url = s.socials.linkedin;
        if (s.socials.github) s.company.github_org = s.socials.github;
    }

    // tech signals from path
    const path = new URL(page.url()).pathname;
    if (path.startsWith('/blog')) s.tech_signals.has_blog = true;
    if (path.startsWith('/careers') || path.startsWith('/jobs')) s.tech_signals.has_careers_page = true;
    if (path.startsWith('/pricing')) s.tech_signals.has_pricing_page = true;
};

// Build start URLs: priority paths per domain
const startRequests = [];
for (const d of cleanDomains) {
    for (const p of PRIORITY_PATHS) {
        startRequests.push({ url: `https://${d}${p}`, userData: { root: d, kind: 'priority' } });
    }
    for (const p of TECH_SIGNAL_PATHS) {
        startRequests.push({ url: `https://${d}${p}`, userData: { root: d, kind: 'tech-signal' } });
    }
}

// Wall-clock budget: exit cleanly with partial results before the platform
// hard-kills the run (TIMED-OUT = a failed buyer first-run and a maintenance
// flag). Deadline derives from the run's ACTUAL timeout via ACTOR_TIMEOUT_AT.
const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 4)),
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 1,
    respectRobotsTxtFile: !!obeyRobotsTxt,
    launchContext: { launchOptions: { headless: true } },
    async requestHandler({ page, request }) {
        if (Date.now() > SOFT_DEADLINE_AT) {
            log.warning('Run-time budget reached; stopping with results so far.');
            crawler.stop();
            return;
        }
        const root = request.userData.root;
        const s = state.get(root);
        if (!s) return;
        if (s.pages_scanned >= maxPagesPerDomain) return;
        try {
            await extractFromPage(page, root);
        } catch (err) {
            log.warning(`extract failed for ${request.url}: ${err.message}`);
        }
        if (navigationDelayMs > 0) await page.waitForTimeout(Number(navigationDelayMs));
    },
    failedRequestHandler({ request, error }) {
        log.debug(`failed ${request.url}: ${error?.message || error}`);
    },
});

await crawler.run(startRequests);

// Finalize per domain: write rows, charge
const dataset = await Actor.openDataset();
let enrichedCount = 0;
let basicCount = 0;
for (const s of state.values()) {
    const emails = Array.from(s.emails.values());
    const phones = Array.from(s.phones.values());
    const socialsCount = Object.values(s.socials).filter(Boolean).length;
    const reachable = s.pages_scanned > 0;
    if (!reachable) continue;
    const row = {
        domain: s.domain,
        url_canonical: s.url_canonical,
        company: s.company,
        emails,
        phones,
        socials: s.socials,
        tech_signals: s.tech_signals,
        pages_scanned: s.pages_scanned,
        scraped_at: new Date().toISOString(),
    };
    await dataset.pushData(row);

    if (emails.length >= 1 || socialsCount >= 2) {
        enrichedCount += 1;
        if (enrichedCount > FREE_TIER_ENRICHED_LEADS) {
            await Actor.charge({ eventName: 'enriched_lead' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
        }
    } else {
        basicCount += 1;
        await Actor.charge({ eventName: 'basic_crawl' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

log.info(`Done. Enriched: ${enrichedCount}, basic: ${basicCount}, unreachable: ${cleanDomains.length - enrichedCount - basicCount}.`);
await Actor.exit();
