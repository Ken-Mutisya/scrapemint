// TradingView Ideas Scraper (No Login)
//
// Strategy
// --------
// TradingView ships every public ideas page with a server-side init-data
// payload at <script type="application/prs.init-data+json">...</script>.
// That payload includes a fully populated `items` array (up to 24 per
// page) with idea id, title, description, chart_url, symbol, user,
// likes_count, comments_count, views_count, is_education, image, and
// timestamps. We skip browser rendering and parse the init-data directly,
// which is faster, cheaper, and resilient against TradingView's React UI
// changes (the old DOM-based selectors broke when TradingView moved
// in-page idea anchors to /v/<shortid>/ shortlinks).
//
// Discovery
// ---------
//   symbols     -> /symbols/<SYMBOL>/ideas/page-<N>/
//   categories  -> /ideas/<category>/page-<N>/
//   tags        -> /ideas/?stream=<tag>&page=<N>
//
// Author intel
// ------------
// Author profile pages /u/<handle>/ also embed init-data with a
// `ssrData.statistics.{followers, following, charts_total, scripts_total}`
// block. One fetch per unique author hydrates every idea from that author.
//
// Pay-per-event:
//   idea_row ($0.004) charged when an idea row is pushed.
//   First 25 idea rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

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
    .map((s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9!.:_-]/g, '')).filter(Boolean);
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
const authorIntelCache = new Map();
const pendingIdeasByAuthor = new Map();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(15, Number(concurrency) || 5)),
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 3,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...(request.headers || {}),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            };
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

for (const [author, pending] of pendingIdeasByAuthor.entries()) {
    for (const { row } of pending) flushRow(row);
    pendingIdeasByAuthor.delete(author);
}

log.info(`Run complete. Sources: ${initialRequests.length}. Ideas pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleIdeasGrid({ body, request, crawler: c }) {
    const { sourceKey, sourceType, page: pageNum } = request.userData;
    log.info(`Ideas ${sourceKey} page ${pageNum}: ${request.url}`);

    const html = body.toString('utf8');
    const items = extractItemsFromInitData(html);

    if (!items || items.length === 0) {
        log.warning(`Ideas ${sourceKey} page ${pageNum}: no items in init-data.`);
        return;
    }

    let pushedThisPage = 0;
    for (const item of items) {
        if (!item?.id) continue;
        const ideaId = String(item.id);
        if (seenIdeaIds.has(ideaId)) continue;
        if ((sourcePushed.get(sourceKey) || 0) >= maxIdeasPerSource) break;

        const row = mapItem(item, request.userData);
        if (directionFilter !== 'all' && row.direction !== directionFilter) continue;

        seenIdeaIds.add(ideaId);
        await routeRow(row, c);
        sourcePushed.set(sourceKey, (sourcePushed.get(sourceKey) || 0) + 1);
        pushedThisPage += 1;
    }

    log.info(`Ideas ${sourceKey} page ${pageNum}: collected ${pushedThisPage} new (source total ${sourcePushed.get(sourceKey) || 0}).`);

    const fullPage = items.length >= 20;
    if ((sourcePushed.get(sourceKey) || 0) < maxIdeasPerSource && pushedThisPage > 0 && fullPage) {
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

async function handleAuthorIntel({ body, request }) {
    const { author } = request.userData;
    const html = body.toString('utf8');
    const intel = extractAuthorIntel(html);
    authorIntelCache.set(author, intel);

    const pending = pendingIdeasByAuthor.get(author) || [];
    pendingIdeasByAuthor.delete(author);
    for (const { row } of pending) {
        Object.assign(row, projectAuthorIntel(intel));
        flushRow(row);
    }
    log.info(`Author ${author}: followers=${intel.followers ?? '?'}, ideas=${intel.ideasPublished ?? '?'}. Drained ${pending.length} ideas.`);
}

// ---------- Routing ----------

async function routeRow(row, c) {
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
        await c.addRequests([{
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

function mapItem(item, ctx) {
    const text = `${item.name || ''}\n${item.description || ''}`;
    let dir = null;
    if (item.is_education) dir = 'education';
    else if (/\bShort\b/i.test(text) && !/\bLong\b/i.test(text)) dir = 'short';
    else if (/\bLong\b/i.test(text) && !/\bShort\b/i.test(text)) dir = 'long';
    else if (/\bLong\b/i.test(item.name || '')) dir = 'long';
    else if (/\bShort\b/i.test(item.name || '')) dir = 'short';

    const interval = item.symbol?.interval;
    const timeframe = mapInterval(interval);

    return {
        ideaId: String(item.id),
        url: item.chart_url || null,
        title: item.name || null,
        description: item.description || null,
        symbol: item.symbol?.short_name || item.symbol?.name || null,
        symbolExchange: item.symbol?.exchange || null,
        direction: dir,
        timeframe,
        imageUrl: item.image?.big || (item.image_url ? `https://s3.tradingview.com/o/${item.image_url}_big.png` : null),
        author: item.user?.username || null,
        authorUrl: item.user?.username ? `${BASE}/u/${item.user.username}/` : null,
        authorIsPro: !!item.user?.is_pro,
        authorPlan: item.user?.pro_plan || null,
        authorFollowers: null,
        authorIdeasPublished: null,
        authorReputation: typeof item.reputation === 'number' ? item.reputation : null,
        likes: typeof item.likes_count === 'number' ? item.likes_count : null,
        comments: typeof item.comments_count === 'number' ? item.comments_count : null,
        views: typeof item.views_count === 'number' ? item.views_count : null,
        publishedAt: item.created_at || null,
        updatedAt: item.updated_at || null,
        tags: [],
        isEditorsPick: !!item.is_picked,
        isHot: !!item.is_hot,
        isVideo: !!item.is_video,
        isEducation: !!item.is_education,
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

function extractItemsFromInitData(html) {
    const scripts = extractInitDataScripts(html);
    for (const c of scripts) {
        let data;
        try { data = JSON.parse(c); } catch { continue; }
        const items = findItemsArray(data);
        if (items && items.length > 0) return items;
    }
    return [];
}

function findItemsArray(obj, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(obj)) {
        for (const x of obj) {
            const r = findItemsArray(x, depth + 1);
            if (r) return r;
        }
    } else if (obj && typeof obj === 'object') {
        if (Array.isArray(obj.items) && obj.items.length > 0 && obj.items[0] && typeof obj.items[0] === 'object' && 'chart_url' in obj.items[0]) {
            return obj.items;
        }
        for (const k of Object.keys(obj)) {
            const r = findItemsArray(obj[k], depth + 1);
            if (r) return r;
        }
    }
    return null;
}

function extractAuthorIntel(html) {
    const scripts = extractInitDataScripts(html);
    for (const c of scripts) {
        let data;
        try { data = JSON.parse(c); } catch { continue; }
        const stats = findAuthorStats(data);
        if (stats) {
            return {
                followers: typeof stats.followers === 'number' ? stats.followers : null,
                ideasPublished: typeof stats.charts_total === 'number' ? stats.charts_total : null,
                reputation: null,
            };
        }
    }
    return { followers: null, ideasPublished: null, reputation: null };
}

function findAuthorStats(obj, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(obj)) {
        for (const x of obj) {
            const r = findAuthorStats(x, depth + 1);
            if (r) return r;
        }
    } else if (obj && typeof obj === 'object') {
        if (obj.statistics && typeof obj.statistics === 'object' && ('followers' in obj.statistics || 'charts_total' in obj.statistics)) {
            return obj.statistics;
        }
        for (const k of Object.keys(obj)) {
            const r = findAuthorStats(obj[k], depth + 1);
            if (r) return r;
        }
    }
    return null;
}

function extractInitDataScripts(html) {
    const out = [];
    const re = /<script[^>]*type="application\/prs\.init-data\+json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        out.push(m[1].trim());
    }
    return out;
}

function mapInterval(iv) {
    if (iv === undefined || iv === null) return null;
    const s = String(iv);
    if (s === '1') return '1m';
    if (s === '3') return '3m';
    if (s === '5') return '5m';
    if (s === '15') return '15m';
    if (s === '30') return '30m';
    if (s === '60') return '1H';
    if (s === '120') return '2H';
    if (s === '180') return '3H';
    if (s === '240') return '4H';
    if (s === '360') return '6H';
    if (s === '720') return '12H';
    if (s === '1D' || s === 'D') return '1D';
    if (s === '1W' || s === 'W') return '1W';
    if (s === '1M' || s === 'M') return '1M';
    return s;
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
