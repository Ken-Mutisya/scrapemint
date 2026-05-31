// LinkedIn Learning Course Scraper (No Login)
//
// Strategy
// --------
// LinkedIn Learning course pages live at /learning/{course-slug}. These are
// public SEO landing pages designed to be indexed by search engines, so the
// course title, description, instructors, skills, rating, and curriculum are
// served to anonymous viewers when requested with a real browser fingerprint
// behind a residential IP. We use Playwright + Apify residential proxy as the
// runtime profile, parse schema.org Course JSON-LD when present, and fall
// back to og:meta plus DOM extraction.
//
// Discovery
// ---------
//   courseUrls       direct course URLs the caller already has
//   instructorNames  discovered via search, verified on the course page
//   keywords         topic search via search engines
//
// Pay-per-event:
//   course_row ($0.02) charged when a course row is pushed.
//   First 3 courses per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_COURSES = 3;

// First path segment values that are NOT course slugs.
const RESERVED_SEGMENTS = new Set([
    'topics', 'instructors', 'paths', 'search', 'me', 'subscription',
    'certificates', 'browse', 'learning-paths', 'login', 'signup', 'unsubscribe',
]);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    courseUrls = [],
    instructorNames = [],
    keywords = [],
    maxCourses = 20,
    includeCurriculum = true,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const directCourseUrls = [];
const seenCourseKeys = new Set();
for (const raw of courseUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = canonicalizeLearningUrl(String(v).trim());
    if (!cleaned) continue;
    const key = learningKey(cleaned);
    if (!key || seenCourseKeys.has(key)) continue;
    seenCourseKeys.add(key);
    directCourseUrls.push({ url: cleaned, key });
}

const instructors = [];
for (const raw of instructorNames) {
    const v = typeof raw === 'string' ? raw : raw?.name || raw?.value || '';
    const trimmed = String(v).trim();
    if (trimmed && !instructors.some((i) => i.toLowerCase() === trimmed.toLowerCase())) instructors.push(trimmed);
}

const keywordList = [];
for (const raw of keywords) {
    const v = typeof raw === 'string' ? raw : raw?.value || '';
    const trimmed = String(v).trim();
    if (trimmed && !keywordList.includes(trimmed)) keywordList.push(trimmed);
}

if (directCourseUrls.length === 0 && instructors.length === 0 && keywordList.length === 0) {
    log.warning('No courseUrls, instructorNames, or keywords provided. Examples: keywords=["prompt engineering"], courseUrls=["https://www.linkedin.com/learning/learning-python"].');
    await Actor.exit();
}

const perSourceCap = Number(maxCourses) > 0 ? Number(maxCourses) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const coursesPushed = new Set();
const sourceCounts = new Map();
[...instructors.map((i) => `instructor:${i}`), ...keywordList.map((k) => `keyword:${k}`)].forEach((key) => sourceCounts.set(key, 0));

const initialRequests = [];

for (const direct of directCourseUrls) {
    initialRequests.push({
        url: direct.url,
        userData: { type: 'course', courseKey: direct.key, source: 'direct' },
        uniqueKey: `course:${direct.key}`,
    });
}

for (const instructor of instructors) {
    initialRequests.push({
        url: buildSearchUrl(`site:linkedin.com/learning/ "${instructor}"`, 0),
        userData: { type: 'search', sourceKey: `instructor:${instructor}`, instructor, page: 0 },
        uniqueKey: `search:instructor:${instructor}:0`,
    });
}

for (const keyword of keywordList) {
    initialRequests.push({
        url: buildSearchUrl(`site:linkedin.com/learning/ ${keyword}`, 0),
        userData: { type: 'search', sourceKey: `keyword:${keyword}`, keyword, page: 0 },
        uniqueKey: `search:keyword:${keyword}:0`,
    });
}

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
                'Referer': 'https://www.google.com/',
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'course') return handleCourse(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Direct: ${directCourseUrls.length}. Instructors: ${instructors.length}. Keywords: ${keywordList.length}. Courses pushed: ${coursesPushed.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const { sourceKey, instructor, keyword, page: pageIndex } = request.userData;
    const have = sourceCounts.get(sourceKey) || 0;
    if (have >= perSourceCap) return;

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/learning\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    const remaining = perSourceCap - have;

    for (const raw of links) {
        if (queued >= remaining) break;
        const cleaned = canonicalizeLearningUrl(unwrapUrl(raw));
        if (!cleaned) continue;
        const key = learningKey(cleaned);
        if (!key || seenCourseKeys.has(key)) continue;

        seenCourseKeys.add(key);
        queued += 1;

        await c.addRequests([{
            url: cleaned,
            userData: {
                type: 'course',
                courseKey: key,
                source: instructor ? 'instructor' : 'keyword',
                sourceKey,
                requireInstructor: instructor || null,
            },
            uniqueKey: `course:${key}`,
        }]);
    }

    log.info(`Search page ${pageIndex} for ${sourceKey}: ${links.length} raw links, ${queued} new courses queued.`);

    const nextPage = (pageIndex || 0) + 1;
    if (queued > 0 && nextPage < 6 && have + queued < perSourceCap) {
        const baseQuery = instructor ? `site:linkedin.com/learning/ "${instructor}"` : `site:linkedin.com/learning/ ${keyword}`;
        await c.addRequests([{
            url: buildSearchUrl(baseQuery, nextPage),
            userData: { ...request.userData, page: nextPage },
            uniqueKey: `search:${sourceKey}:${nextPage}`,
        }]);
    }
}

async function handleCourse({ page, request }) {
    const { courseKey, source, sourceKey, requireInstructor } = request.userData;
    if (coursesPushed.has(courseKey)) return;

    try {
        await page.waitForSelector(
            'main, h1, [data-test-id="course-title"], script[type="application/ld+json"]',
            { timeout: 12000 },
        );
    } catch {}

    const data = await extractCourseData(page);

    const looksGated = !data.title
        || /^(sign in|join now|join linkedin|page not found)/i.test(data.title)
        || (!data.description && !data.instructors?.length && !data.releasedAt);
    if (looksGated) {
        log.warning(`Course ${courseKey} appears gated (title="${(data.title || '').slice(0, 40)}"). Skipping.`);
        return;
    }

    if (requireInstructor) {
        const want = requireInstructor.toLowerCase();
        const match = (data.instructors || []).some((i) => (i.name || '').toLowerCase().includes(want));
        if (!match) {
            log.info(`Course ${courseKey} does not list instructor "${requireInstructor}". Skipping.`);
            return;
        }
    }

    const row = normalize(courseKey, request.url, data, source, sourceKey);
    if (!includeCurriculum) row.curriculum = null;

    coursesPushed.add(courseKey);
    if (sourceKey) sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);

    await Actor.pushData(row);
    if (coursesPushed.size > FREE_TIER_COURSES) {
        Actor.charge({ eventName: 'course_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed course ${courseKey}: title="${(row.title || '').slice(0, 60)}", instructor=${row.instructors?.[0]?.name || '?'}, level=${row.level || '?'}.`);
}

// ---------- Extraction ----------

async function extractCourseData(page) {
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
                else if (parsed && Array.isArray(parsed['@graph'])) ldJson.push(...parsed['@graph']);
                else if (parsed) ldJson.push(parsed);
            } catch {}
        });

        const typeMatches = (x, re) => {
            const t = x?.['@type'];
            if (!t) return false;
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => re.test(String(tt)));
        };
        const courseLd = ldJson.find((x) => typeMatches(x, /Course/i)) || null;
        const videoLd = ldJson.find((x) => typeMatches(x, /VideoObject/i)) || null;

        const stripSuffix = (s) => s ? s.replace(/\s*[|]\s*(linkedin learning|linkedin)\s*$/i, '').trim() : null;
        const ogTitle = stripSuffix(meta('og:title'));
        const headerTitle = text(sel('main h1, [data-test-id="course-title"], h1'));
        const looksGenericOg = !ogTitle || /^(sign in|join now|linkedin learning|linkedin)$/i.test(ogTitle);
        const title = (looksGenericOg ? null : ogTitle)
            || headerTitle
            || (courseLd && (courseLd.name || courseLd.headline))
            || null;

        const description = (courseLd && courseLd.description)
            || meta('og:description')
            || meta('description')
            || text(sel('[data-test-id="course-description"], .course-description'))
            || null;

        // Instructors: JSON-LD Course.author/instructor first, DOM fallback.
        const instructors = [];
        const pushInstructor = (a) => {
            if (!a) return;
            const name = typeof a === 'string' ? a : a.name;
            if (!name) return;
            if (instructors.some((x) => x.name === name)) return;
            instructors.push({
                name,
                profileUrl: (typeof a === 'object' && (a.url || a.sameAs)) || null,
                headline: (typeof a === 'object' && (a.jobTitle || a.description)) || null,
            });
        };
        if (courseLd) {
            const raw = courseLd.author || courseLd.instructor || (courseLd.provider && courseLd.provider.author);
            if (Array.isArray(raw)) raw.forEach(pushInstructor);
            else pushInstructor(raw);
        }
        if (!instructors.length) {
            all('[data-test-id="instructor-name"], .instructor-name, a[href*="/learning/instructors/"]')
                .forEach((el) => pushInstructor(text(el)));
        }

        const skills = courseLd && courseLd.teaches
            ? (Array.isArray(courseLd.teaches) ? courseLd.teaches : String(courseLd.teaches).split(/[,;]+/))
                .map((s) => (typeof s === 'string' ? s : s?.name || '')).map((s) => s.trim()).filter(Boolean)
            : all('[data-test-id="skill-tag"], .skills-list li, .skill-tag').map((el) => text(el)).filter(Boolean);

        const about = courseLd && courseLd.about
            ? (Array.isArray(courseLd.about) ? courseLd.about : [courseLd.about])
                .map((s) => (typeof s === 'string' ? s : s?.name || '')).map((s) => s.trim()).filter(Boolean)
            : [];

        const level = (courseLd && (courseLd.educationalLevel
            || (courseLd.coursePrerequisites && courseLd.coursePrerequisites.educationalLevel)))
            || text(sel('[data-test-id="course-level"], .course-level')) || null;

        const durationIso = (courseLd && (courseLd.timeRequired
            || (courseLd.hasCourseInstance && courseLd.hasCourseInstance.courseWorkload)))
            || (videoLd && videoLd.duration) || null;
        const durationText = text(sel('[data-test-id="course-duration"], .course-duration')) || null;

        const releasedAt = (courseLd && (courseLd.datePublished || courseLd.dateCreated))
            || (videoLd && videoLd.uploadDate)
            || meta('article:published_time') || null;
        const updatedAt = (courseLd && courseLd.dateModified)
            || meta('article:modified_time') || null;

        let rating = null;
        const agg = (courseLd && courseLd.aggregateRating) || (videoLd && videoLd.aggregateRating);
        if (agg) {
            rating = {
                value: agg.ratingValue != null ? Number(agg.ratingValue) : null,
                count: agg.ratingCount != null ? Number(agg.ratingCount)
                    : (agg.reviewCount != null ? Number(agg.reviewCount) : null),
            };
        }

        let learnersText = null;
        const ic = courseLd && courseLd.interactionStatistic;
        if (ic) {
            const arr = Array.isArray(ic) ? ic : [ic];
            const watch = arr.find((s) => /Watch|View/i.test(JSON.stringify(s?.interactionType || '')));
            if (watch && watch.userInteractionCount != null) learnersText = String(watch.userInteractionCount);
        }
        if (!learnersText) learnersText = text(sel('[data-test-id="learner-count"], .learner-count')) || null;

        const language = (courseLd && courseLd.inLanguage)
            || meta('og:locale') || document.documentElement.lang || null;

        const thumbnail = (courseLd && (courseLd.image?.url || (Array.isArray(courseLd.image) ? courseLd.image[0] : courseLd.image)))
            || meta('og:image')
            || sel('main img')?.src || null;

        // Curriculum: JSON-LD hasPart / syllabusSections, DOM fallback.
        const curriculum = [];
        const parts = (courseLd && (courseLd.hasPart || courseLd.syllabusSections)) || null;
        if (Array.isArray(parts)) {
            parts.forEach((p) => {
                const sectionName = typeof p === 'string' ? p : (p?.name || null);
                if (!sectionName) return;
                const lessons = [];
                const sub = p && (p.hasPart || p.itemListElement);
                if (Array.isArray(sub)) {
                    sub.forEach((l) => {
                        const ln = typeof l === 'string' ? l : (l?.name || l?.item?.name || null);
                        if (ln) lessons.push({ title: ln, durationText: (l && (l.timeRequired || l.duration)) || null });
                    });
                }
                curriculum.push({ section: sectionName, lessons });
            });
        }
        if (!curriculum.length) {
            all('[data-test-id="toc-section"], .toc-section, section.contents').forEach((secEl) => {
                const sectionName = text(sel('h2, h3, .toc-section-title', secEl));
                if (!sectionName) return;
                const lessons = all('li, .toc-item', secEl).map((li) => ({
                    title: text(sel('.toc-item-title', li) || li),
                    durationText: text(sel('.toc-item-duration, time', li)) || null,
                })).filter((x) => x.title);
                curriculum.push({ section: sectionName, lessons });
            });
        }

        const relatedCourses = all('a[href*="/learning/"]')
            .map((a) => a.href)
            .filter((h) => /\/learning\/[^/?#]+\/?($|[?#])/i.test(h))
            .slice(0, 40);

        return {
            title,
            description,
            instructors,
            skills,
            about,
            level,
            durationIso,
            durationText,
            releasedAt,
            updatedAt,
            rating,
            learnersText,
            language,
            thumbnail,
            curriculum,
            relatedCourses,
        };
    });
}

function normalize(courseKey, url, data, source, sourceKey) {
    const durationSeconds = parseIsoDuration(data.durationIso) ?? parseDurationText(data.durationText);
    const durationMinutes = durationSeconds != null ? Math.round(durationSeconds / 60) : null;

    let relatedSlugs = [];
    if (Array.isArray(data.relatedCourses)) {
        const seen = new Set();
        for (const href of data.relatedCourses) {
            const k = learningKey(canonicalizeLearningUrl(href) || '');
            if (k && k !== courseKey && !seen.has(k)) {
                seen.add(k);
                relatedSlugs.push(k);
            }
        }
        relatedSlugs = relatedSlugs.slice(0, 20);
    }

    return {
        key: courseKey,
        url: canonicalizeLearningUrl(url) || url,
        discoveredVia: { kind: source, value: sourceKey || null },
        title: data.title || null,
        description: data.description || null,
        instructors: Array.isArray(data.instructors) ? data.instructors : [],
        skills: Array.isArray(data.skills) ? data.skills : [],
        topics: Array.isArray(data.about) ? data.about : [],
        level: data.level || null,
        durationSeconds,
        durationMinutes,
        releasedAt: data.releasedAt || null,
        updatedAt: data.updatedAt || null,
        rating: data.rating || null,
        learnersCount: parseCount(data.learnersText),
        language: data.language || null,
        thumbnail: data.thumbnail || null,
        curriculum: Array.isArray(data.curriculum) ? data.curriculum : [],
        relatedCourses: relatedSlugs,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- URL helpers ----------

function buildSearchUrl(query, pageIndex) {
    const offset = pageIndex * 20;
    const params = new URLSearchParams({ q: query, source: 'web' });
    if (offset > 0) params.set('offset', String(offset));
    return `https://search.brave.com/search?${params.toString()}`;
}

function unwrapUrl(href) {
    if (!href) return href;
    let url = href;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (/bing\.com$/.test(host)) {
            const real = u.searchParams.get('u') || u.searchParams.get('r');
            if (real) {
                if (real.startsWith('a1')) {
                    try { url = Buffer.from(real.slice(2), 'base64').toString('utf8'); }
                    catch { url = real; }
                } else url = real;
            }
        } else if (/google\.com$/.test(host) && u.pathname.startsWith('/url')) {
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) url = real;
        } else if (/duckduckgo\.com$/.test(host) && u.pathname === '/l/') {
            const real = u.searchParams.get('uddg');
            if (real) url = decodeURIComponent(real);
        }
    } catch {}

    try {
        const u = new URL(url);
        if (/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
            if (u.pathname.startsWith('/login') || u.pathname.startsWith('/signup') || u.pathname.startsWith('/uas/')) {
                const inner = u.searchParams.get('session_redirect') || u.searchParams.get('redirect');
                if (inner) url = decodeURIComponent(inner);
            }
        }
    } catch {}

    return url;
}

function canonicalizeLearningUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href.startsWith('http') ? href : `https://${href}`);
        if (!/(^|\.)linkedin\.com$/.test(u.hostname.replace(/^www\./, '').toLowerCase())) return null;
        const m = u.pathname.match(/^\/learning\/([^/?#]+)/i);
        if (!m) return null;
        const slug = decodeURIComponent(m[1]).toLowerCase();
        if (RESERVED_SEGMENTS.has(slug)) return null;
        return `https://www.linkedin.com/learning/${slug}`;
    } catch { return null; }
}

function learningKey(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/learning\/([^/?#]+)/i);
        if (!m) return null;
        const slug = decodeURIComponent(m[1]).toLowerCase();
        return RESERVED_SEGMENTS.has(slug) ? null : slug;
    } catch { return null; }
}

// ---------- Parsing helpers ----------

function parseIsoDuration(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
    if (!m) return null;
    const [, d, h, min, s] = m;
    const total = (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(min || 0) * 60) + Number(s || 0);
    return total > 0 ? total : null;
}

function parseDurationText(t) {
    if (!t) return null;
    const lower = t.toLowerCase();
    let total = 0;
    const h = lower.match(/(\d+)\s*h/);
    const m = lower.match(/(\d+)\s*m/);
    if (h) total += Number(h[1]) * 3600;
    if (m) total += Number(m[1]) * 60;
    return total > 0 ? total : null;
}

function parseCount(text) {
    if (!text) return null;
    const t = String(text).replace(/,/g, '').toLowerCase().trim();
    const m = t.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
