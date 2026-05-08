// LinkedIn Profile Scraper (No Cookies)
//
// Strategy
// --------
// LinkedIn renders public profile pages anonymously at /in/{slug}. The HTML is
// served with the public-facing fact block intact: top card (name, headline,
// location), about block, experience section, education section, and a
// featured/skills cluster. We pull the page with Playwright behind a
// residential proxy, parse JSON-LD plus DOM selectors plus meta tags, and ship
// a single normalized row per profile.
//
// Pay-per-event:
//   profile ($0.02) charged when a profile row is pushed.
//   First 3 profiles per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_PROFILES = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    profileUrls = [],
    includeExperience = true,
    includeEducation = true,
    includeSkills = true,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const profiles = [];
for (const raw of profileUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseProfileUrl(String(v).trim());
    if (parsed && !profiles.some((p) => p.key === parsed.key)) profiles.push(parsed);
}

if (profiles.length === 0) {
    log.warning('No valid LinkedIn profile URLs provided. Examples: https://www.linkedin.com/in/williamhgates, https://www.linkedin.com/in/satyanadella');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const profileByKey = new Map(profiles.map((p) => [p.key, p]));
const pushed = new Set();

const initialRequests = profiles.map((p) => ({
    url: p.canonicalUrl,
    userData: { profileKey: p.key },
    uniqueKey: `profile:${p.key}`,
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
    async requestHandler({ page, request, session }) {
        const profile = profileByKey.get(request.userData.profileKey);
        if (!profile) return;

        try {
            await page.waitForSelector(
                'main, .top-card-layout, .profile-topcard, h1',
                { timeout: 12000 },
            );
        } catch {}

        const data = await extractProfileData(page);

        // Auth wall detection. LinkedIn serves a "Join LinkedIn" interstitial
        // to some IPs / session fingerprints. The h1 reads "Join LinkedIn" and
        // the page lacks the topcard. Throw to force a session-rotated retry
        // rather than ship junk rows.
        const looksGated = !data.name
            || /^Join LinkedIn$/i.test(data.name)
            || /^Sign Up\s*\|\s*LinkedIn$/i.test(data.name)
            || (!data.headline && !data.summary && data.experience.length === 0);
        if (looksGated) {
            session?.markBad();
            throw new Error(`Auth wall or empty profile for ${profile.slug}. Retrying with new session.`);
        }

        const merged = normalize(profile, data);

        if (!includeExperience) merged.experience = [];
        if (!includeEducation) merged.education = [];
        if (!includeSkills) merged.skills = [];

        pushed.add(profile.key);
        await Actor.pushData(merged);
        if (pushed.size > FREE_TIER_PROFILES) {
            Actor.charge({ eventName: 'profile' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
        }
        log.info(`Pushed ${profile.slug}: name=${merged.name || '?'}, headline=${merged.headline ? merged.headline.slice(0, 60) : '?'}.`);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Profiles requested: ${profiles.length}. Profiles pushed: ${pushed.size}.`);
await Actor.exit();

// ---------- Extraction ----------

async function extractProfileData(page) {
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
                else if (parsed) {
                    if (parsed['@graph'] && Array.isArray(parsed['@graph'])) {
                        ldJson.push(...parsed['@graph']);
                    } else {
                        ldJson.push(parsed);
                    }
                }
            } catch {}
        });

        const personLd = ldJson.find((x) => {
            const t = x?.['@type'];
            if (!t) return false;
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => /Person/i.test(tt));
        }) || null;

        const ogTitle = meta('og:title') || '';
        const titleTag = text(sel('title'));
        // LinkedIn title pattern: "Name - Headline | LinkedIn"
        const titleParts = titleTag.replace(/\s*\|\s*LinkedIn\s*$/i, '').split(' - ');

        const name = text(sel('h1, .top-card-layout__title, .profile-topcard-person-entity__name'))
            || (personLd && personLd.name)
            || ogTitle.split(' - ')[0]
            || titleParts[0]
            || null;

        const headline = text(sel('.top-card-layout__headline, .profile-topcard__summary, h2.top-card-layout__headline'))
            || (personLd && personLd.jobTitle)
            || (titleParts.length > 1 ? titleParts.slice(1).join(' - ').trim() : null)
            || meta('og:description')?.split(' · ')[0]
            || null;

        const location = text(sel('.top-card__subline-item, .profile-topcard__location-data, .top-card-layout__first-subline span:not([class*="follower"])'))
            || (personLd && personLd.address && [personLd.address.addressLocality, personLd.address.addressRegion, personLd.address.addressCountry].filter(Boolean).join(', '))
            || null;

        const summary = text(sel('.core-section-container__content.break-words, .profile-section--about p, section[data-section="summary"] p, .summary p'))
            || meta('og:description')
            || (personLd && personLd.description)
            || null;

        const photoUrl = sel('.top-card-layout__entity-image, .profile-topcard-person-entity__image img, img.profile-photo-edit__preview')?.src
            || meta('og:image')
            || (personLd && (personLd.image?.url || personLd.image))
            || null;

        const followerText = text(sel('.top-card-layout__first-subline span, .profile-topcard-person-entity__connections, .top-card__subline-item--bullet'));
        const connectionsText = text(sel('.top-card__subline-item:nth-of-type(2), .profile-topcard-person-entity__connections-count'));

        // Experience section. LinkedIn renders public experience in a list of
        // .profile-section-card or li.experience-item items.
        const experience = all('section.experience-section li, .experience__list li, [data-section="experience"] li, .profile-section-card.experience-item').map((el) => {
            const title = text(sel('h3, .profile-section-card__title, [class*="experience-item__title"]', el));
            const company = text(sel('.profile-section-card__subtitle, h4, [class*="experience-item__subtitle"]', el));
            const dates = text(sel('.date-range, .experience-item__duration, [class*="date-range"]', el));
            const loc = text(sel('.experience-item__location, .profile-section-card__meta, [class*="experience-item__location"]', el));
            const desc = text(sel('.show-more-less-text, p.experience-item__description', el));
            return {
                title: title || null,
                company: company || null,
                dateRange: dates || null,
                location: loc || null,
                description: desc || null,
            };
        }).filter((e) => e.title || e.company);

        // Education
        const education = all('section.education__list li, .education-section li, [data-section="education"] li, .profile-section-card.education__list-item').map((el) => {
            const school = text(sel('h3, .profile-section-card__title, [class*="education__item--school"]', el));
            const degree = text(sel('h4, .profile-section-card__subtitle, [class*="education__item--degree"]', el));
            const field = text(sel('.education__item--field, [class*="education__item--degree-info"]', el));
            const dates = text(sel('.date-range, .education__item--duration, [class*="date-range"]', el));
            return {
                school: school || null,
                degree: degree || null,
                field: field || null,
                dateRange: dates || null,
            };
        }).filter((e) => e.school);

        // Skills (top public skills are surfaced as plain pills/chips)
        const skills = all('section.skills li, [data-section="skills"] li, .profile-section-card.skill-list-item').map((el) => {
            return text(sel('h3, .profile-section-card__title, .skill-pill__skill-name', el)) || text(el);
        }).filter(Boolean).slice(0, 50);

        // Current job inference: first experience row with no end date or
        // dateRange ending in "Present", else first row.
        let currentTitle = null;
        let currentCompany = null;
        if (experience.length > 0) {
            const current = experience.find((e) => /present/i.test(e.dateRange || '')) || experience[0];
            currentTitle = current.title;
            currentCompany = current.company;
        }
        if (!currentTitle && headline) {
            // Fall back to splitting headline like "Title at Company"
            const m = headline.match(/^(.*?)\s+(?:at|@|·)\s+(.+)$/i);
            if (m) {
                currentTitle = currentTitle || m[1].trim();
                currentCompany = currentCompany || m[2].trim();
            }
        }

        return {
            name,
            headline,
            location,
            summary,
            photoUrl,
            followerText,
            connectionsText,
            currentTitle,
            currentCompany,
            experience,
            education,
            skills,
        };
    });
}

function normalize(profile, data) {
    return {
        slug: profile.slug,
        url: profile.canonicalUrl,
        name: data.name || profile.slug,
        headline: data.headline || null,
        location: data.location || null,
        currentTitle: data.currentTitle || null,
        currentCompany: data.currentCompany || null,
        summary: data.summary || null,
        photoUrl: data.photoUrl || null,
        followerCount: parseCount(data.followerText, /follower/),
        connectionCount: parseCount(data.connectionsText, /connection/),
        experience: Array.isArray(data.experience) ? data.experience : [],
        education: Array.isArray(data.education) ? data.education : [],
        skills: Array.isArray(data.skills) ? data.skills : [],
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- URL helpers ----------

function parseProfileUrl(raw) {
    if (!raw) return null;
    let candidate = raw;
    if (!/^https?:/i.test(candidate)) {
        // Accept bare slugs like "williamhgates" or "/in/williamhgates"
        const slugOnly = candidate.replace(/^\/+/, '').replace(/^in\//i, '');
        candidate = `https://www.linkedin.com/in/${slugOnly}`;
    }
    let u;
    try { u = new URL(candidate); } catch { return null; }
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)linkedin\.com$/.test(host)) return null;

    const path = u.pathname.replace(/\/+$/, '');
    const m = path.match(/^\/in\/([^/]+)/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    const canonicalUrl = `https://www.linkedin.com/in/${slug}`;
    return {
        slug,
        key: `in:${slug}`,
        canonicalUrl,
    };
}

// ---------- Parsing helpers ----------

function parseCount(text, kindRe) {
    if (!text) return null;
    const t = text.toLowerCase().replace(/,/g, '');
    if (!kindRe.test(t)) return null;
    const m = t.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
