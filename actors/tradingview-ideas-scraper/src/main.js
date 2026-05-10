// TradingView Ideas Scraper (No Login)
//
// Strategy
// --------
// TradingView renders idea pages publicly at:
//   /symbols/<SYMBOL>/ideas/page-<N>/    (per symbol)
//   /ideas/<category>/page-<N>/          (per category, e.g. forex, crypto)
//   /ideas/?stream=<tag>                 (per tag, fallback)
// Each idea card carries a stable `/chart/<chartId>/<slug>/` link that
// survives most React reflows. Each public author page exposes followers,
// total ideas published, and a TradingView reputation score.
//
// We accept symbols, categories, and tags as inputs. For each source we
// paginate the ideas grid up to maxIdeasPerSource. When includeAuthorIntel
// is on we fetch each unique author profile once to enrich every idea row
// from that author.
//
// Pay-per-event:
//   idea_row ($0.004) charged when an idea row is pushed.
//   First 25 idea rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 25;
const BASE = 'https://www.tradingview.com';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    categories = [],
    tags = [],
    direction = 'all',
    maxIdeasPerSource = 60,
    includeAuthorIntel = true,
    concurrency = 5,
    proxyConfiguration: proxyInput,
} = input;

const cleanSymbols = (Array.isArray(symbols) ? symbols : [symbols])
    .map((s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9!.:_\-]/g, '')).filter(Boolean);
const cleanCategories = (Array.isArray(categories) ? categories : [categories])
    .map((c) => String(c || '').trim().toLowerCase()).filter(Boolean);
const cleanTags = (Array.isArray(tags) ? tags : [tags])
    .map((t) => String(t || '').trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);

const directionFilter = String(direction || 'all').toLowerCase();

if (cleanSymbols.length === 0 && cleanCategories.length === 0 && cleanTags.length === 0) {
    log.warning('Provide at least one symbol, category, or tag. Examples: symbols=["EURUSD"], categories=["forex"], tags=["trend-analysis"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const initialRequests = [];
for (const sym of cleanSymbols) {
    initialRequests.push({
        url: buildSymbolUrl(sym, 1),
        userData: { type: 'ideas_grid', sourceType: 'symbol', sourceKey: `symbol:${sym}`, symbol: sym, page: 1 },
        uniqueKey: `ideas:symbol:${sym}:1`,
    });
}
for (const cat of cleanCategories) {
    initialRequests.push({
        url: buildCategoryUrl(cat, 1),
        userData: { type: 'ideas_grid', sourceType: 'category', sourceKey: `cat:${cat}`, category: cat, page: 1 },
        uniqueKey: `ideas:cat:${cat}:1`,
    });
}
for (const tag of cleanTags) {
    initialRequests.push({
        url: buildTagUrl(tag, 1),
        userData: { type: 'ideas_grid', sourceType: 'tag', sourceKey: `tag:${tag}`, tag, page: 1 },
        uniqueKey: `ideas:tag:${tag}:1`,
    });
}

const seenIdeaIds = new Set();
const sourcePushed = new Map();
let totalRowsPushed = 0;
const authorIntelCache = new Map(); // author -> intel | 'pending'
const pendingIdeasByAuthor = new Map(); // author -> [{ row }]

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(15, Number(concurrency) || 5)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
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
            gotoOptions.timeout = 60000;
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'ideas_grid') return handleIdeasGrid(ctx);
        if (t === 'author_intel') return handleAuthorIntel(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

// Drain ideas whose author intel never resolved.
for (const [author, pending] of pendingIdeasByAuthor.entries()) {
    for (const { row } of pending) flushRow(row);
    pendingIdeasByAuthor.delete(author);
}

log.info(`Run complete. Sources: ${initialRequests.length}. Ideas pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleIdeasGrid({ page, request, crawler: c }) {
    await dismissBanners(page);
    const { sourceKey, sourceType, page: pageNum } = request.userData;
    log.info(`Ideas ${sourceKey} page ${pageNum}: ${request.url}`);

    try {
        await page.waitForSelector('article, .tv-widget-idea, a[href*="/chart/"]', { timeout: 12000 });
    } catch {
        log.warning(`Ideas ${sourceKey}: no idea cards found, page may be gated.`);
    }

    // Lazy load: scroll a few times to materialize cards.
    await autoScroll(page, 4);

    const cards = await extractIdeaCards(page);
    let pushedThisPage = 0;

    for (const card of cards) {
        if (!card.ideaId || seenIdeaIds.has(card.ideaId)) continue;
        if ((sourcePushed.get(sourceKey) || 0) >= maxIdeasPerSource) break;
        if (directionFilter !== 'all' && card.direction !== directionFilter) continue;

        seenIdeaIds.add(card.ideaId);
        const row = buildRow(card, request.userData);
        await routeRow(row, c);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisPage += 1;
    }

    log.info(`Ideas ${sourceKey} page ${pageNum}: collected ${pushedThisPage} new (source total ${sourcePushed.get(sourceKey) || 0}).`);

    if ((sourcePushed.get(sourceKey) || 0) < maxIdeasPerSource && pushedThisPage > 0) {
        const next = pageNum + 1;
        let nextUrl;
        if (sourceType === 'symbol') nextUrl = buildSymbolUrl(request.userData.symbol, next);
        else if (sourceType === 'category') nextUrl = buildCategoryUrl(request.userData.category, next);
        else nextUrl = buildTagUrl(request.userData.tag, next);

        await c.addRequests([{
            url: nextUrl,
            userData: { ...request.userData, page: next },
            uniqueKey: `ideas:${sourceKey}:${next}`,
        }]);
    }
}

async function handleAuthorIntel({ page, request }) {
    await dismissBanners(page);
    const { author } = request.userData;

    try {
        await page.waitForSelector('main, h1, [class*="profile"], [class*="username"]', { timeout: 10000 });
    } catch {}

    const intel = await extractAuthorIntel(page);
    authorIntelCache.set(author, intel);

    const pending = pendingIdeasByAuthor.get(author) || [];
    pendingIdeasByAuthor.delete(author);
    for (const { row } of pending) {
        Object.assign(row, projectAuthorIntel(intel));
        flushRow(row);
    }
    log.info(`Author ${author}: followers=${intel.followers ?? '?'}, ideas=${intel.ideasPublished ?? '?'}, rep=${intel.reputation ?? '?'}. Drained ${pending.length} ideas.`);
}

// ---------- Routing ----------

async function routeRow(row, crawler) {
    if (!includeAuthorIntel || !row.author) {
        flushRow(row);
        return;
    }
    const cached = authorIntelCache.get(row.author);
    if (cached && cached !== 'pending') {
        Object.assign(row, projectAuthorIntel(cached));
        flushRow(row);
        return;
    }

    if (!pendingIdeasByAuthor.has(row.author)) pendingIdeasByAuthor.set(row.author, []);
    pendingIdeasByAuthor.get(row.author).push({ row });

    if (!cached) {
        authorIntelCache.set(row.author, 'pending');
        await crawler.addRequests([{
            url: `${BASE}/u/${encodeURIComponent(row.author)}/`,
            userData: { type: 'author_intel', author: row.author },
            uniqueKey: `author_intel:${row.author}`,
        }]);
    }
}

function flushRow(row) {
    row.scrapedAt = new Date().toISOString();
    Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        Actor.charge({ eventName: 'idea_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

function buildRow(card, ctx) {
    return {
        ideaId: card.ideaId,
        url: card.url,
        title: card.title || null,
        description: card.description || null,
        symbol: card.symbol || null,
        direction: card.direction || null,
        timeframe: card.timeframe || null,
        imageUrl: card.imageUrl || null,
        author: card.author || null,
        authorUrl: card.author ? `${BASE}/u/${card.author}/` : null,
        authorFollowers: null,
        authorIdeasPublished: null,
        authorReputation: null,
        likes: card.likes ?? null,
        comments: card.comments ?? null,
        views: card.views ?? null,
        publishedAt: card.publishedAt || null,
        tags: card.tags || [],
        isEditorsPick: !!card.isEditorsPick,
        sourceType: ctx.sourceType,
        sourceKey: ctx.sourceKey,
        scrapedAt: null,
    };
}

function projectAuthorIntel(intel) {
    return {
        authorFollowers: intel.followers ?? null,
        authorIdeasPublished: intel.ideasPublished ?? null,
        authorReputation: intel.reputation ?? null,
    };
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const sel = [
                'button[aria-label*="accept" i]',
                'button[aria-label*="agree" i]',
                'button[name="accept"]',
                '[class*="cookie"] button',
                '[data-name="close"]',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el) { el.click(); break; }
            }
        });
        await page.waitForTimeout(400);
    } catch {}
}

async function autoScroll(page, rounds = 3) {
    for (let i = 0; i < rounds; i += 1) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await page.waitForTimeout(900);
    }
}

async function extractIdeaCards(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const seen = new Set();
        const out = [];

        const cardRoots = new Set();
        // Anchor on chart links and walk to the card root.
        for (const a of document.querySelectorAll('a[href*="/chart/"]')) {
            const card = a.closest('article')
                || a.closest('[class*="card"]')
                || a.closest('[class*="idea"]')
                || a.closest('div');
            if (card) cardRoots.add(card);
        }
        // Also any explicit article roots.
        for (const el of document.querySelectorAll('article')) cardRoots.add(el);

        for (const card of cardRoots) {
            const chartLink = card.querySelector('a[href*="/chart/"]');
            if (!chartLink) continue;
            const href = chartLink.getAttribute('href') || '';
            const m = href.match(/\/chart\/[^/]+\/([A-Za-z0-9]+)-/) || href.match(/\/chart\/([A-Za-z0-9]+)\//);
            if (!m) continue;
            const ideaId = m[1];
            if (seen.has(ideaId)) continue;
            seen.add(ideaId);

            const url = href.startsWith('http') ? href.split('?')[0] : `https://www.tradingview.com${href.split('?')[0]}`;
            const title = (chartLink.getAttribute('title') || '').trim() || text(card.querySelector('h3, h2, [class*="title"]'));

            const cardText = card.textContent || '';

            // Symbol: link to /symbols/<SYM>/
            let symbol = null;
            const symLink = card.querySelector('a[href*="/symbols/"]');
            if (symLink) {
                const sm = symLink.getAttribute('href').match(/\/symbols\/([^/?#]+)/i);
                if (sm) symbol = decodeURIComponent(sm[1]).toUpperCase();
            }

            // Direction: explicit Long/Short/Education badge.
            let dir = null;
            if (/\bLong\b/i.test(cardText) && !/\bEducation\b/i.test(cardText)) dir = 'long';
            if (/\bShort\b/i.test(cardText) && !/\bLong\b/i.test(cardText)) dir = dir || 'short';
            if (/\bEducation\b/i.test(cardText)) dir = dir || 'education';
            // Prefer dedicated direction badge if present.
            const dirBadge = card.querySelector('[class*="direction"], [class*="long"], [class*="short"]');
            if (dirBadge) {
                const t = (dirBadge.textContent || '').toLowerCase();
                if (t.includes('long')) dir = 'long';
                else if (t.includes('short')) dir = 'short';
                else if (t.includes('education')) dir = 'education';
            }

            // Timeframe: e.g. "1D", "4H", "15m" rendered as a small badge.
            let timeframe = null;
            const tfMatch = cardText.match(/\b(\d{1,3}(?:[smhDWMy]|min|H|D|W|M))\b/);
            if (tfMatch) timeframe = tfMatch[1];

            // Image (chart snapshot).
            const img = card.querySelector('img[src*="snapshots"], picture img, img');
            const imageUrl = img?.getAttribute('src') || img?.getAttribute('data-src') || null;

            // Author: link to /u/<handle>/
            let author = null;
            const userLink = card.querySelector('a[href*="/u/"]');
            if (userLink) {
                const um = userLink.getAttribute('href').match(/\/u\/([^/?#]+)/i);
                if (um) author = decodeURIComponent(um[1]);
            }

            // Engagement counts.
            const likes = parseCountByLabel(cardText, /([\d,kKmM.]+)\s*(?:likes?|boosts?)/);
            const comments = parseCountByLabel(cardText, /([\d,kKmM.]+)\s*(?:comments?|replies?)/);
            const views = parseCountByLabel(cardText, /([\d,kKmM.]+)\s*views?/);

            // Published date: TradingView shows relative ("3 hours ago") or absolute.
            let publishedAt = null;
            const timeEl = card.querySelector('time, [datetime]');
            if (timeEl) {
                publishedAt = timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || null;
            }
            if (!publishedAt) {
                const rel = cardText.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);
                if (rel) {
                    const n = parseInt(rel[1], 10);
                    const unit = rel[2].toLowerCase();
                    const ms = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[unit];
                    if (ms) publishedAt = new Date(Date.now() - n * ms).toISOString();
                }
            }

            // Description snippet: first paragraph-ish text.
            const descEl = card.querySelector('p, [class*="description"], [class*="paragraph"]');
            const description = (descEl ? text(descEl) : '').slice(0, 600) || null;

            // Tags: TradingView renders tag chips as anchors with /ideas/?stream=<tag> or class names.
            const tags = [];
            for (const tagA of card.querySelectorAll('a[href*="/ideas/"][href*="stream="], a[class*="tag"]')) {
                const tHref = tagA.getAttribute('href') || '';
                const sm = tHref.match(/[?&]stream=([^&]+)/);
                const tagText = sm ? decodeURIComponent(sm[1]) : (tagA.textContent || '').trim();
                if (tagText && tagText.length < 40 && !tags.includes(tagText)) tags.push(tagText.toLowerCase());
            }

            const isEditorsPick = /editor'?s\s*pick/i.test(cardText);

            out.push({
                ideaId,
                url,
                title,
                description,
                symbol,
                direction: dir,
                timeframe,
                imageUrl,
                author,
                likes,
                comments,
                views,
                publishedAt,
                tags,
                isEditorsPick,
            });
        }

        return out;

        function parseCountByLabel(t, re) {
            const m = String(t).match(re);
            if (!m) return null;
            return parseCountToken(m[1]);
        }
        function parseCountToken(s) {
            if (!s) return null;
            const t = String(s).toLowerCase().replace(/,/g, '');
            const m = t.match(/^([\d.]+)\s*([kmb])?/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            if (m[2] === 'k') n *= 1000;
            else if (m[2] === 'm') n *= 1000000;
            else if (m[2] === 'b') n *= 1000000000;
            return Math.round(n);
        }
    });
}

async function extractAuthorIntel(page) {
    return page.evaluate(() => {
        const body = document.body?.textContent || '';

        let followers = null;
        const fm = body.match(/([\d,kKmM.]+)\s+Followers?/);
        if (fm) followers = parseCountToken(fm[1]);

        let ideasPublished = null;
        const im = body.match(/([\d,kKmM.]+)\s+Ideas?\s+published/i)
            || body.match(/Ideas?\s*[:\-]?\s*([\d,kKmM.]+)/);
        if (im) ideasPublished = parseCountToken(im[1]);

        let reputation = null;
        const rm = body.match(/Reputation[^\d]*([\d,]+)/i);
        if (rm) reputation = parseCountToken(rm[1]);

        return { followers, ideasPublished, reputation };

        function parseCountToken(s) {
            if (!s) return null;
            const t = String(s).toLowerCase().replace(/,/g, '');
            const m = t.match(/^([\d.]+)\s*([kmb])?/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            if (m[2] === 'k') n *= 1000;
            else if (m[2] === 'm') n *= 1000000;
            else if (m[2] === 'b') n *= 1000000000;
            return Math.round(n);
        }
    });
}

// ---------- URL helpers ----------

function buildSymbolUrl(symbol, page) {
    const seg = page > 1 ? `page-${page}/` : '';
    return `${BASE}/symbols/${encodeURIComponent(symbol)}/ideas/${seg}`;
}

function buildCategoryUrl(cat, page) {
    const seg = page > 1 ? `page-${page}/` : '';
    return `${BASE}/ideas/${encodeURIComponent(cat)}/${seg}`;
}

function buildTagUrl(tag, page) {
    const params = new URLSearchParams({ stream: tag });
    if (page > 1) params.set('page', String(page));
    return `${BASE}/ideas/?${params.toString()}`;
}
