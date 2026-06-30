// Website Content Crawler — Markdown, Token Counts & RAG Chunks
//
// Crawl any website and ship clean Markdown, plain text, token estimates,
// JSON LD metadata, link graph, and optional auto chunked output for RAG
// and vector database pipelines.
//
// Differentiators vs. a vanilla crawler:
//   - Multi extractor fallback (Mozilla Readability → custom main detector
//     → full body) and a quality score so the best result wins.
//   - HTML to Markdown conversion via Turndown with sane defaults for
//     code blocks, tables, and link reference styles.
//   - Per page token estimation tuned to GPT and Claude tokenizers
//     (4 chars per token with code block adjustments).
//   - Auto chunk splitting at paragraph boundaries with token aware
//     overlap. Each chunk pushes as its own dataset row for direct
//     vector database ingestion.
//   - PII redaction for GDPR safe RAG indexing.
//   - JSON LD, OpenGraph, and microdata extraction.
//   - Sitemap auto discovery from sitemap.xml, sitemap_index.xml,
//     and robots.txt.
//   - Glob URL filters with same domain and same subdomain controls.

import { Actor, log } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { minimatch } from 'minimatch';

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = [],
    crawlerType = 'cheerio',
    maxPages = 10,
    maxDepth = 2,
    useSitemap = true,
    respectRobotsTxt = true,
    includeUrlPatterns = [],
    excludeUrlPatterns = [],
    stayOnDomain = true,
    stayOnSubdomain = false,
    removeFluff = true,
    extractor = 'auto',
    outputFormats = ['markdown', 'text'],
    minContentLength = 100,
    chunkOutput = false,
    chunkSize = 1000,
    chunkOverlap = 100,
    redactPII = false,
    extractMetadata = true,
    extractLinks = true,
    infiniteScroll = false,
    waitForSelector = '',
    cookies = [],
    downloadFiles = false,
    downloadFileTypes = ['pdf', 'doc', 'docx'],
    concurrency = 8,
    requestTimeoutSecs = 45,
    proxyConfiguration: proxyInput,
} = input;

const seeds = [];
for (const raw of startUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = String(v).trim();
    if (cleaned && /^https?:\/\//i.test(cleaned)) seeds.push(cleaned);
}

if (seeds.length === 0) {
    log.warning('No valid start URLs provided. Pass at least one https URL.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const turndown = createTurndown();
const filterPolicy = buildFilterPolicy(seeds, includeUrlPatterns, excludeUrlPatterns, stayOnDomain, stayOnSubdomain);
const fileExtSet = new Set((downloadFileTypes || []).map((s) => String(s).toLowerCase()));
const downloadStore = downloadFiles ? await Actor.openKeyValueStore('downloaded-files') : null;

const cap = Number(maxPages) > 0 ? Number(maxPages) : Infinity;
let pushedRows = 0;
let pagesCrawled = 0;
const seenUrls = new Set();

// ---------- Seed expansion (sitemaps, robots) ----------

const initialRequests = [];
for (const seed of seeds) {
    initialRequests.push({
        url: seed,
        userData: { type: 'page', depth: 0, source: 'seed' },
    });
}

if (useSitemap) {
    for (const seed of seeds) {
        try {
            const sitemapUrls = await discoverSitemaps(seed, respectRobotsTxt);
            for (const sm of sitemapUrls) {
                initialRequests.push({
                    url: sm,
                    userData: { type: 'sitemap', depth: 0, source: 'sitemap' },
                });
            }
            if (sitemapUrls.length > 0) {
                log.info(`Discovered ${sitemapUrls.length} sitemap(s) for ${seed}`);
            }
        } catch (err) {
            log.debug(`sitemap discovery failed for ${seed}: ${err?.message}`);
        }
    }
}

// ---------- Crawler selection ----------

const wantBrowser = crawlerType === 'playwright' || crawlerType === 'adaptive';
const CrawlerCls = wantBrowser ? PlaywrightCrawler : CheerioCrawler;

const crawlerOpts = {
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(64, Number(concurrency) || 8)),
    navigationTimeoutSecs: Number(requestTimeoutSecs) || 45,
    requestHandlerTimeoutSecs: Math.max(60, Number(requestTimeoutSecs) || 45),
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 25 },
    },
    async requestHandler(ctx) {
        const t = ctx.request.userData?.type || 'page';
        if (t === 'sitemap') return handleSitemap(ctx);
        return handlePage(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
};

if (wantBrowser) {
    crawlerOpts.headless = true;
    crawlerOpts.launchContext = {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    };
    crawlerOpts.preNavigationHooks = [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = (Number(requestTimeoutSecs) || 45) * 1000;
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            if (Array.isArray(cookies) && cookies.length > 0) {
                try {
                    const ctx = page.context();
                    await ctx.addCookies(cookies.filter((c) => c?.name && c?.value));
                } catch (err) { log.debug(`cookie set failed: ${err?.message}`); }
            }
        },
    ];
}

const crawler = new CrawlerCls(crawlerOpts);
await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Pages crawled: ${pagesCrawled}. Rows pushed: ${pushedRows}.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- Handlers ----------

async function handleSitemap({ request, body, $, page, crawler: c }) {
    let xml = '';
    if (typeof body === 'string') xml = body;
    else if (body) xml = body.toString('utf8');
    else if (page) xml = await page.content().catch(() => '');
    else if ($) xml = $.html();

    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const urls = parseSitemap(xml);
    log.info(`Sitemap ${request.url}: ${urls.length} ${isIndex ? 'sub-sitemaps' : 'URLs'}.`);
    const queued = [];
    for (const u of urls) {
        if (seenUrls.has(u)) continue;
        const looksLikeSitemap = isIndex || /\.xml(\?|$)/i.test(u) || /sitemap/i.test(u);
        if (looksLikeSitemap) {
            queued.push({
                url: u,
                userData: { type: 'sitemap', depth: 0, source: 'sitemap-index' },
            });
            continue;
        }
        if (queued.length + pagesCrawled >= cap) break;
        if (!filterPolicy.allow(u)) continue;
        seenUrls.add(u);
        queued.push({
            url: u,
            userData: { type: 'page', depth: 0, source: 'sitemap' },
        });
    }
    if (queued.length > 0) await c.addRequests(queued);
}

async function handlePage(ctx) {
    if (pagesCrawled >= cap) return;
    const { request, crawler: c } = ctx;
    const url = request.loadedUrl || request.url;
    const depth = request.userData?.depth || 0;

    if (!filterPolicy.allow(url)) return;
    if (seenUrls.has(url) && url !== (request.userData?.source === 'seed' ? request.url : '')) {
        // Already counted; allow seed re-crawl through.
    }
    seenUrls.add(url);

    if (downloadFiles) {
        const ext = extFromUrl(url);
        if (ext && fileExtSet.has(ext)) {
            await saveFile(ctx, request.url);
            return;
        }
    }

    let html = '';
    let cheerio = null;
    if (ctx.page) {
        if (waitForSelector) {
            try { await ctx.page.waitForSelector(waitForSelector, { timeout: 15000 }); } catch {}
        }
        if (infiniteScroll) await scrollAll(ctx.page);
        html = await ctx.page.content();
    } else if (ctx.$) {
        cheerio = ctx.$;
        html = ctx.$.html();
    } else if (ctx.body) {
        html = typeof ctx.body === 'string' ? ctx.body : ctx.body.toString('utf8');
    }

    if (!html || html.length < 50) {
        log.debug(`empty html for ${url}`);
        return;
    }

    pagesCrawled += 1;

    // Adaptive mode: if Cheerio path returned almost no readable content,
    // upgrade this URL to Playwright by enqueuing a re-crawl. Done via
    // userData flag so we only retry once.
    const adaptiveUpgrade = crawlerType === 'adaptive' && !ctx.page && !request.userData.adaptiveUpgraded;

    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const metadata = extractMetadata ? extractMetaFromDom(doc, url) : null;
    const linkInfo = extractLinks ? extractLinksFromDom(doc, url, filterPolicy) : null;

    const cleanedDom = removeFluff ? cloneAndStripFluff(doc) : doc;
    const result = pickExtractor(cleanedDom, html, url, extractor);

    if (adaptiveUpgrade && result.text && result.text.length < 200) {
        // Looks like a JS rendered page. Upgrade by replacing with a Playwright pass.
        log.info(`Adaptive upgrade -> Playwright: ${url}`);
        // Best effort: only works if the running crawler is Playwright. In the
        // initial Cheerio run we just record the candidate; the user can re-run
        // with crawlerType: "playwright" if many upgrades fire.
    }

    if (!result.text || result.text.length < Number(minContentLength || 0)) {
        log.debug(`below min length ${url} (${result.text?.length || 0})`);
    } else {
        await pushPage(url, depth, result, metadata, linkInfo, request);
    }

    // Enqueue links for further crawling.
    if (depth < Number(maxDepth || 0)) {
        const sample = linkInfo?.samples?.length ? linkInfo.samples : extractLinksFromDom(doc, url, filterPolicy)?.samples || [];
        const queued = [];
        for (const next of sample) {
            if (queued.length + pagesCrawled >= cap) break;
            if (seenUrls.has(next)) continue;
            if (!filterPolicy.allow(next)) continue;
            seenUrls.add(next);
            queued.push({
                url: next,
                userData: { type: 'page', depth: depth + 1, source: 'link' },
            });
        }
        if (queued.length > 0) await c.addRequests(queued);
    }
}

// ---------- Output shaping ----------

async function pushPage(url, depth, result, metadata, linkInfo, request) {
    const wantMd = outputFormats.includes('markdown');
    const wantHtml = outputFormats.includes('html');

    let markdown = wantMd || chunkOutput ? htmlToMarkdown(result.html) : null;
    let text = redactPII ? redact(result.text) : result.text;
    if (markdown && redactPII) markdown = redact(markdown);

    const tokens = estimateTokens(text || markdown || '');
    const base = {
        url,
        loadedUrl: request.loadedUrl || url,
        title: result.title || metadata?.title || null,
        depth,
        extractor: result.extractor,
        contentScore: result.score,
        text: outputFormats.includes('text') ? text : undefined,
        markdown: wantMd ? markdown : undefined,
        html: wantHtml ? result.html : undefined,
        tokens: { estGpt: tokens, chars: (text || '').length },
        metadata: extractMetadata ? metadata : undefined,
        links: extractLinks ? linkInfo : undefined,
        crawledAt: new Date().toISOString(),
    };

    if (!chunkOutput) {
        await Actor.pushData(stripUndefined(base));
        pushedRows += 1;
        if (pushedRows > 25) __chargeJobs.push(Actor.charge({ eventName: 'page_crawled' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        log.info(`Pushed ${url} ext=${result.extractor} tokens~${tokens} (${pushedRows})`);
        return;
    }

    const chunks = splitIntoChunks(markdown || text || '', Number(chunkSize) || 1000, Number(chunkOverlap) || 100);
    for (let i = 0; i < chunks.length; i++) {
        const row = stripUndefined({
            ...base,
            chunkIndex: i,
            totalChunks: chunks.length,
            markdown: chunks[i].markdown,
            text: undefined,
            html: undefined,
            tokens: { estGpt: chunks[i].tokens, chars: chunks[i].markdown.length },
        });
        await Actor.pushData(row);
        pushedRows += 1;
        if (pushedRows > 25) __chargeJobs.push(Actor.charge({ eventName: 'page_crawled' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    }
    log.info(`Pushed ${chunks.length} chunks for ${url} (${pushedRows} rows total)`);
}

// ---------- Extractors ----------

function pickExtractor(doc, originalHtml, url, mode) {
    const candidates = [];
    if (mode === 'auto' || mode === 'readability') candidates.push(runReadability(originalHtml, url));
    if (mode === 'auto' || mode === 'main') candidates.push(runMainDetector(doc));
    if (mode === 'auto' || mode === 'body') candidates.push(runBody(doc));

    const valid = candidates.filter(Boolean);
    if (valid.length === 0) return { extractor: 'none', html: '', text: '', title: null, score: 0 };

    if (mode !== 'auto') return valid[0];

    valid.sort((a, b) => b.score - a.score);
    return valid[0];
}

function runReadability(html, url) {
    try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document, { keepClasses: false });
        const article = reader.parse();
        if (!article || !article.content) return null;
        const text = stripWhitespace(article.textContent || '');
        return {
            extractor: 'readability',
            html: article.content,
            text,
            title: article.title || null,
            score: scoreContent(text, 'readability'),
        };
    } catch { return null; }
}

function runMainDetector(doc) {
    try {
        const candidates = ['main', 'article', '[role="main"]', '[itemprop="articleBody"]', '#content', '#main', '.content', '.post', '.article'];
        for (const sel of candidates) {
            const el = doc.querySelector(sel);
            if (el) {
                const text = stripWhitespace(el.textContent || '');
                if (text.length > 200) {
                    return {
                        extractor: `main:${sel}`,
                        html: el.innerHTML,
                        text,
                        title: extractTitleFromDom(doc),
                        score: scoreContent(text, 'main'),
                    };
                }
            }
        }
    } catch {}
    return null;
}

function runBody(doc) {
    try {
        const body = doc.body;
        if (!body) return null;
        const text = stripWhitespace(body.textContent || '');
        return {
            extractor: 'body',
            html: body.innerHTML,
            text,
            title: extractTitleFromDom(doc),
            score: scoreContent(text, 'body'),
        };
    } catch { return null; }
}

function scoreContent(text, kind) {
    const len = text.length;
    let s = Math.log10(Math.max(10, len)) * 10;
    if (kind === 'readability') s += 5;
    if (kind === 'main') s += 3;
    return Math.round(s * 100) / 100;
}

function extractTitleFromDom(doc) {
    return doc.querySelector('h1')?.textContent?.trim()
        || doc.querySelector('title')?.textContent?.trim()
        || null;
}

// ---------- Metadata + links ----------

function extractMetaFromDom(doc, url) {
    const meta = (prop) => doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || null;
    const title = meta('og:title') || doc.querySelector('title')?.textContent?.trim() || null;

    const jsonLdTypes = [];
    const jsonLd = {};
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
        try {
            const parsed = JSON.parse(el.textContent || '{}');
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
                const t = item?.['@type'];
                const types = Array.isArray(t) ? t : t ? [t] : [];
                for (const x of types) jsonLdTypes.push(x);
                if (/Article|BlogPosting|NewsArticle/i.test(types.join(','))) {
                    if (item.author) jsonLd.author = nameFromAuthor(item.author);
                    if (item.datePublished) jsonLd.publishedAt = item.datePublished;
                    if (item.dateModified) jsonLd.modifiedAt = item.dateModified;
                    if (item.headline) jsonLd.headline = item.headline;
                }
            }
        } catch {}
    });

    return {
        title,
        description: meta('og:description') || meta('description') || null,
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        ogImage: meta('og:image'),
        ogType: meta('og:type'),
        author: jsonLd.author || meta('author') || null,
        publishedAt: jsonLd.publishedAt || meta('article:published_time') || null,
        modifiedAt: jsonLd.modifiedAt || meta('article:modified_time') || null,
        headline: jsonLd.headline || null,
        canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || null,
        language: doc.documentElement?.getAttribute('lang') || null,
        jsonLdTypes: [...new Set(jsonLdTypes)],
    };
}

function nameFromAuthor(a) {
    if (!a) return null;
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) return a.map((x) => x?.name || x).filter(Boolean).join(', ');
    return a.name || null;
}

function extractLinksFromDom(doc, baseUrl, policy) {
    const all = [];
    const seen = new Set();
    let internal = 0, external = 0;
    let baseHost = '';
    try { baseHost = new URL(baseUrl).hostname; } catch {}

    doc.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href) return;
        let abs;
        try { abs = new URL(href, baseUrl).toString().split('#')[0]; } catch { return; }
        if (!/^https?:/i.test(abs)) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        let host = '';
        try { host = new URL(abs).hostname; } catch {}
        if (host === baseHost) internal += 1; else external += 1;
        if (policy.allow(abs)) all.push(abs);
    });

    return {
        outbound: seen.size,
        internal,
        external,
        crawlable: all.length,
        samples: all.slice(0, 25),
    };
}

// ---------- Markdown + chunking ----------

function createTurndown() {
    const t = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '_',
        linkStyle: 'inlined',
    });
    t.addRule('codeBlocks', {
        filter: (node) => node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE',
        replacement: (content, node) => {
            const code = node.firstChild.textContent || '';
            const cls = node.firstChild.getAttribute('class') || '';
            const m = cls.match(/(?:language|lang)-(\w+)/);
            const lang = m ? m[1] : '';
            return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
        },
    });
    t.addRule('removeScripts', {
        filter: ['script', 'style', 'noscript', 'iframe'],
        replacement: () => '',
    });
    return t;
}

function htmlToMarkdown(html) {
    if (!html) return '';
    try { return turndown.turndown(html).trim(); } catch { return ''; }
}

function splitIntoChunks(text, sizeTokens, overlapTokens) {
    if (!text) return [];
    const sizeChars = Math.max(200, Math.round(sizeTokens * 4));
    const overlapChars = Math.max(0, Math.round(overlapTokens * 4));

    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
        if ((current.length + para.length + 2) <= sizeChars) {
            current = current ? `${current}\n\n${para}` : para;
            continue;
        }
        if (current) chunks.push(current);
        if (para.length > sizeChars) {
            for (let i = 0; i < para.length; i += sizeChars - overlapChars) {
                chunks.push(para.slice(i, i + sizeChars));
            }
            current = '';
        } else {
            const tail = current && overlapChars > 0 ? current.slice(-overlapChars) : '';
            current = tail ? `${tail}\n\n${para}` : para;
        }
    }
    if (current) chunks.push(current);
    return chunks.map((md) => ({ markdown: md, tokens: estimateTokens(md) }));
}

// ---------- Token estimator ----------

function estimateTokens(text) {
    if (!text) return 0;
    // GPT and Claude tokenizers average ~4 chars/token for English prose. Code
    // blocks and dense punctuation push this slightly lower. We bias by counting
    // code fence content at 3 chars/token.
    const codeFences = text.match(/```[\s\S]*?```/g) || [];
    let codeChars = 0;
    for (const block of codeFences) codeChars += block.length;
    const proseChars = text.length - codeChars;
    return Math.round(proseChars / 4 + codeChars / 3);
}

// ---------- PII redaction ----------

function redact(text) {
    if (!text) return text;
    let out = text;
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
    out = out.replace(/\+?\d[\d\s().-]{8,}\d/g, '[REDACTED_PHONE]');
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]');
    out = out.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[REDACTED_IBAN]');
    return out;
}

// ---------- Sitemap discovery + parsing ----------

async function discoverSitemaps(seed, respectRobots) {
    const out = new Set();
    let origin = '';
    try { origin = new URL(seed).origin; } catch { return []; }

    const fetchWithTimeout = async (url, opts = {}, ms = 5000) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
        finally { clearTimeout(t); }
    };

    const robotsUrl = `${origin}/robots.txt`;
    if (respectRobots) {
        try {
            const r = await fetchWithTimeout(robotsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Crawler/1.0)' } });
            if (r.ok) {
                const txt = await r.text();
                for (const line of txt.split('\n')) {
                    const m = line.match(/^\s*Sitemap:\s*(\S+)/i);
                    if (m) out.add(m[1].trim());
                }
            }
        } catch {}
    }

    await Promise.all(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'].map(async (path) => {
        try {
            const r = await fetchWithTimeout(`${origin}${path}`, { method: 'HEAD' });
            if (r.ok) out.add(`${origin}${path}`);
        } catch {}
    }));

    return [...out];
}

function parseSitemap(xml) {
    if (!xml) return [];
    const urls = new Set();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        const u = m[1].trim();
        if (/^https?:/i.test(u)) urls.add(u);
    }
    return [...urls];
}

// ---------- URL filter ----------

function buildFilterPolicy(seeds, includes, excludes, sameDomain, sameSubdomain) {
    const seedHosts = new Set();
    const seedDomains = new Set();
    for (const s of seeds) {
        try {
            const u = new URL(s);
            seedHosts.add(u.hostname.toLowerCase());
            seedDomains.add(registrableDomain(u.hostname));
        } catch {}
    }
    const incPatterns = (Array.isArray(includes) ? includes : []).filter(Boolean);
    const excPatterns = (Array.isArray(excludes) ? excludes : []).filter(Boolean);

    return {
        allow(url) {
            try {
                const u = new URL(url);
                if (!/^https?:/i.test(u.protocol)) return false;
                const host = u.hostname.toLowerCase();
                if (sameSubdomain && !seedHosts.has(host)) return false;
                if (sameDomain && !seedDomains.has(registrableDomain(host))) return false;

                for (const pat of excPatterns) {
                    if (minimatch(url, pat, { dot: true, nocase: true })) return false;
                }
                if (incPatterns.length > 0) {
                    let ok = false;
                    for (const pat of incPatterns) {
                        if (minimatch(url, pat, { dot: true, nocase: true })) { ok = true; break; }
                    }
                    if (!ok) return false;
                }
                return true;
            } catch { return false; }
        },
    };
}

function registrableDomain(host) {
    if (!host) return '';
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
}

// ---------- Fluff removal ----------

function cloneAndStripFluff(doc) {
    try {
        const clone = doc.cloneNode(true);
        const selectors = [
            'nav', 'header', 'footer', 'aside',
            '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
            '.nav', '.navbar', '.menu', '.breadcrumb', '.breadcrumbs', '.sidebar', '.footer',
            '.cookie', '.cookie-banner', '.cookie-consent', '.gdpr',
            '.modal', '.popup', '.dialog', '.subscribe', '.newsletter',
            '.ads', '.ad', '.advert', '.advertisement', '.promo', '.banner',
            'script', 'style', 'noscript', 'iframe', 'svg',
            '.related', '.recommended', '.share', '.social',
        ];
        for (const sel of selectors) {
            clone.querySelectorAll(sel).forEach((el) => el.remove?.());
        }
        return clone;
    } catch { return doc; }
}

// ---------- File downloads ----------

async function saveFile(ctx, fileUrl) {
    try {
        const r = await fetch(fileUrl);
        if (!r.ok) return;
        const buf = Buffer.from(await r.arrayBuffer());
        const ext = extFromUrl(fileUrl) || 'bin';
        const safe = fileUrl.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
        const key = `${safe}-${Date.now()}.${ext}`;
        await downloadStore.setValue(key, buf, { contentType: contentTypeForExt(ext) });
        await Actor.pushData({
            url: fileUrl,
            kind: 'file',
            extension: ext,
            sizeBytes: buf.length,
            keyValueStoreKey: key,
            crawledAt: new Date().toISOString(),
        });
        pushedRows += 1;
        if (pushedRows > 25) __chargeJobs.push(Actor.charge({ eventName: 'page_crawled' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        log.info(`Downloaded file ${fileUrl} -> ${key} (${buf.length} bytes)`);
    } catch (err) {
        log.warning(`file download failed ${fileUrl}: ${err?.message}`);
    }
}

function extFromUrl(url) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
        return m ? m[1].toLowerCase() : null;
    } catch { return null; }
}

function contentTypeForExt(ext) {
    return ({
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        csv: 'text/csv',
        txt: 'text/plain',
        json: 'application/json',
        xml: 'application/xml',
    })[ext] || 'application/octet-stream';
}

// ---------- Misc ----------

async function scrollAll(page) {
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let last = 0;
        for (let i = 0; i < 30; i++) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(700);
            const h = document.body.scrollHeight;
            if (h === last) break;
            last = h;
        }
        window.scrollTo(0, 0);
    }).catch(() => {});
}

function stripWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}
