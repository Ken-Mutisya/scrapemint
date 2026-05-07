// LinkedIn Pulse Articles Scraper (No Cookies)
//
// Strategy
// --------
// LinkedIn Pulse articles live at /pulse/{slug}-{author-handle}-{code}. The
// canonical surface is gated to anonymous viewers via login wall HTML, but
// the public pulse archive index pages and the search engine indexed pulse
// pages still expose the full article body when requested with a real
// browser fingerprint behind a residential IP. We use Playwright + Apify
// residential proxy as the runtime profile, parse JSON-LD Article schema
// when present, and fall back to og:meta plus DOM extraction for the body.
//
// Discovery
// ---------
//   articleUrls   direct Pulse URLs the caller already has
//   profileUrls   author profiles, expanded into Pulse URLs via search
//   keywords      topic search via search engines
//
// Pay-per-event:
//   article_row ($0.02) charged when an article row is pushed.
//   First 3 articles per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ARTICLES = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    articleUrls = [],
    profileUrls = [],
    keywords = [],
    maxArticles = 20,
    includeBody = true,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const directArticleUrls = [];
const seenArticleKeys = new Set();
for (const raw of articleUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = canonicalizePulseUrl(String(v).trim());
    if (!cleaned) continue;
    const key = pulseKey(cleaned);
    if (!key || seenArticleKeys.has(key)) continue;
    seenArticleKeys.add(key);
    directArticleUrls.push({ url: cleaned, key, source: 'direct' });
}

const profiles = [];
for (const raw of profileUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const parsed = parseProfileUrl(String(v).trim());
    if (parsed && !profiles.some((p) => p.handle === parsed.handle)) profiles.push(parsed);
}

const keywordList = [];
for (const raw of keywords) {
    const v = typeof raw === 'string' ? raw : raw?.value || '';
    const trimmed = String(v).trim();
    if (trimmed && !keywordList.includes(trimmed)) keywordList.push(trimmed);
}

if (directArticleUrls.length === 0 && profiles.length === 0 && keywordList.length === 0) {
    log.warning('No articleUrls, profileUrls, or keywords provided. Examples: profileUrls=["https://www.linkedin.com/in/satyanadella/"], keywords=["AI strategy"].');
    await Actor.exit();
}

const perSourceCap = Number(maxArticles) > 0 ? Number(maxArticles) : Infinity;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const articlesPushed = new Set();
const sourceCounts = new Map();
[...profiles.map((p) => `profile:${p.handle}`), ...keywordList.map((k) => `keyword:${k}`)].forEach((key) => sourceCounts.set(key, 0));

const initialRequests = [];

for (const direct of directArticleUrls) {
    initialRequests.push({
        url: direct.url,
        userData: { type: 'article', articleKey: direct.key, source: 'direct' },
        uniqueKey: `article:${direct.key}`,
    });
}

for (const profile of profiles) {
    initialRequests.push({
        url: buildSearchUrl(`site:linkedin.com/pulse/ "${profile.handle}"`, 0),
        userData: { type: 'search', sourceKey: `profile:${profile.handle}`, profileHandle: profile.handle, page: 0 },
        uniqueKey: `search:profile:${profile.handle}:0`,
    });
}

for (const keyword of keywordList) {
    initialRequests.push({
        url: buildSearchUrl(`site:linkedin.com/pulse/ ${keyword}`, 0),
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
        if (t === 'article') return handleArticle(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Direct: ${directArticleUrls.length}. Profiles: ${profiles.length}. Keywords: ${keywordList.length}. Articles pushed: ${articlesPushed.size}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const { sourceKey, profileHandle, keyword, page: pageIndex } = request.userData;
    const have = sourceCounts.get(sourceKey) || 0;
    if (have >= perSourceCap) return;

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/pulse\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    const remaining = perSourceCap - have;

    for (const raw of links) {
        if (queued >= remaining) break;
        const cleaned = canonicalizePulseUrl(unwrapUrl(raw));
        if (!cleaned) continue;
        const key = pulseKey(cleaned);
        if (!key || seenArticleKeys.has(key)) continue;
        if (profileHandle && !pulseUrlMatchesHandle(cleaned, profileHandle)) continue;

        seenArticleKeys.add(key);
        queued += 1;

        await c.addRequests([{
            url: cleaned,
            userData: { type: 'article', articleKey: key, source: profileHandle ? 'profile' : 'keyword', sourceKey },
            uniqueKey: `article:${key}`,
        }]);
    }

    log.info(`Search page ${pageIndex} for ${sourceKey}: ${links.length} raw links, ${queued} new articles queued.`);

    const nextPage = (pageIndex || 0) + 1;
    if (queued > 0 && nextPage < 6 && have + queued < perSourceCap) {
        const baseQuery = profileHandle ? `site:linkedin.com/pulse/ "${profileHandle}"` : `site:linkedin.com/pulse/ ${keyword}`;
        await c.addRequests([{
            url: buildSearchUrl(baseQuery, nextPage),
            userData: { ...request.userData, page: nextPage },
            uniqueKey: `search:${sourceKey}:${nextPage}`,
        }]);
    }
}

async function handleArticle({ page, request }) {
    const { articleKey, source, sourceKey } = request.userData;
    if (articlesPushed.has(articleKey)) return;

    try {
        await page.waitForSelector(
            'article, main, .reader-article-content, [data-test-id="reader-content"], h1, script[type="application/ld+json"]',
            { timeout: 12000 },
        );
    } catch {}

    const data = await extractArticleData(page);

    const looksGated = !data.title
        || /^(top content on linkedin|sign in|join now)/i.test(data.title)
        || (!data.bodyText && !data.publishedAt);
    if (looksGated) {
        log.warning(`Article ${articleKey} appears gated (title="${(data.title || '').slice(0, 40)}"). Skipping.`);
        return;
    }

    const row = normalize(articleKey, request.url, data, source, sourceKey);
    if (!includeBody) {
        row.bodyText = null;
        row.bodyHtml = null;
    }

    articlesPushed.add(articleKey);
    if (sourceKey) sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);

    await Actor.pushData(row);
    if (articlesPushed.size > FREE_TIER_ARTICLES) {
        Actor.charge({ eventName: 'article_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    log.info(`Pushed article ${articleKey}: title="${(row.title || '').slice(0, 60)}", author=${row.author?.name || '?'}, words=${row.wordCount || 0}.`);
}

// ---------- Extraction ----------

async function extractArticleData(page) {
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

        const articleLd = ldJson.find((x) => {
            const t = x?.['@type'];
            if (!t) return false;
            const types = Array.isArray(t) ? t : [t];
            return types.some((tt) => /Article|NewsArticle|BlogPosting/i.test(tt));
        }) || null;

        // Title strategy: og:title is the cleanest source on Pulse (designed
        // for sharing). h1 inside the article header is next. JSON-LD headline
        // on Pulse often contains the article intro paragraph rather than the
        // title, so it ranks last.
        const stripLinkedInSuffix = (s) => s ? s.replace(/\s*[|]\s*linkedin\s*$/i, '').trim() : null;
        const ogTitle = stripLinkedInSuffix(meta('og:title'));
        const headerTitle = text(sel(
            'article header h1, .reader-article-header h1, [data-test-id="reader-article-title"], h1.article-title, .article-title h1, header h1',
        ));
        const looksGenericOg = !ogTitle || /^(top content on linkedin|sign in|join now|linkedin)$/i.test(ogTitle);
        const title = (looksGenericOg ? null : ogTitle)
            || headerTitle
            || (articleLd && (articleLd.headline || articleLd.name))
            || null;

        const subtitle = text(sel('.reader-article-header__subtitle, h2.reader-article-header, .article-subtitle'))
            || null;

        const bodyEl = sel('.reader-article-content, [data-test-id="reader-content"], .article-content, article .body, article');
        let bodyText = (articleLd && articleLd.articleBody)
            || text(bodyEl)
            || text(sel('main'))
            || null;

        // Strip the rendered article header (title + "Report this article" +
        // duplicated author + "Published <date>" + "+ Follow") from bodyText
        // so the body starts at the actual content. The "+ Follow" CTA only
        // appears once near the top, so anchoring on it is reliable when it
        // shows up within the first ~400 characters.
        if (bodyText) {
            if (title) {
                const titleEsc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const titlePattern = new RegExp(`^\\s*${titleEsc}\\s*(?:report this article\\s*)?`, 'i');
                bodyText = bodyText.replace(titlePattern, '');
            }
            const followIdx = bodyText.search(/\+\s*follow\s+/i);
            if (followIdx >= 0 && followIdx < 400) {
                bodyText = bodyText.slice(followIdx).replace(/^\+\s*follow\s+/i, '');
            }
            bodyText = bodyText.trim();
        }

        const bodyHtml = bodyEl?.innerHTML || null;

        const publishedAt = (articleLd && (articleLd.datePublished || articleLd.dateCreated))
            || meta('article:published_time')
            || sel('time')?.getAttribute('datetime')
            || null;
        const updatedAt = (articleLd && articleLd.dateModified)
            || meta('article:modified_time')
            || null;

        let author = null;
        if (articleLd && articleLd.author) {
            const a = Array.isArray(articleLd.author) ? articleLd.author[0] : articleLd.author;
            author = {
                name: a?.name || null,
                profileUrl: a?.url || null,
                headline: a?.jobTitle || a?.description || null,
            };
        }
        if (!author) {
            const a = sel('.reader-author-info a, .reader-author, .author-block a');
            if (a) author = { name: text(a), profileUrl: a.href || null, headline: null };
        }

        const coverImage = (articleLd && (articleLd.image?.url || (Array.isArray(articleLd.image) ? articleLd.image[0] : articleLd.image)))
            || meta('og:image')
            || sel('.reader-article-image img, article img')?.src
            || null;

        const tags = articleLd && articleLd.keywords
            ? (Array.isArray(articleLd.keywords) ? articleLd.keywords : String(articleLd.keywords).split(/[,;]+/).map((s) => s.trim()).filter(Boolean))
            : all('.reader-article-tags a, .topic-tag, [data-test-id="topic-tag"]').map((a) => text(a)).filter(Boolean);

        const reactionsText = text(sel('.social-counts-reactions__count, .social-details-social-counts__reactions-count'));
        const commentsText = text(sel('.social-counts-comments, .social-details-social-counts__comments'));

        return {
            title,
            subtitle,
            bodyText,
            bodyHtml,
            publishedAt,
            updatedAt,
            author,
            coverImage,
            tags,
            reactionsText,
            commentsText,
        };
    });
}

function normalize(articleKey, url, data, source, sourceKey) {
    const wordCount = data.bodyText ? data.bodyText.split(/\s+/).filter(Boolean).length : 0;
    const readingMinutes = wordCount ? Math.max(1, Math.round(wordCount / 230)) : null;

    return {
        key: articleKey,
        url: canonicalizePulseUrl(url) || url,
        discoveredVia: { kind: source, value: sourceKey || null },
        title: data.title || null,
        subtitle: data.subtitle || null,
        author: data.author || null,
        publishedAt: data.publishedAt || null,
        updatedAt: data.updatedAt || null,
        bodyText: data.bodyText || null,
        bodyHtml: data.bodyHtml || null,
        wordCount,
        readingMinutes,
        coverImage: data.coverImage || null,
        tags: Array.isArray(data.tags) ? data.tags : [],
        engagement: {
            reactions: parseCount(data.reactionsText),
            comments: parseCount(data.commentsText),
        },
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

function canonicalizePulseUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href.startsWith('http') ? href : `https://${href}`);
        if (!/(^|\.)linkedin\.com$/.test(u.hostname.replace(/^www\./, '').toLowerCase())) return null;
        if (!/^\/pulse\//i.test(u.pathname)) return null;
        const cleanedPath = u.pathname.replace(/\/+$/, '');
        return `https://www.linkedin.com${cleanedPath}/`;
    } catch { return null; }
}

function pulseKey(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/pulse\/(.+?)\/?$/i);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

function parseProfileUrl(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/.test(u.hostname.replace(/^www\./, '').toLowerCase())) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)/i);
    if (!m) return null;
    return { handle: decodeURIComponent(m[1]).toLowerCase(), url: `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}/` };
}

function pulseUrlMatchesHandle(url, handle) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/^\/pulse\/(.+?)\/?$/i);
        if (!m) return false;
        return m[1].toLowerCase().includes(handle.toLowerCase());
    } catch { return false; }
}

// ---------- Parsing helpers ----------

function parseCount(text) {
    if (!text) return null;
    const t = text.replace(/,/g, '').toLowerCase().trim();
    const m = t.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}
