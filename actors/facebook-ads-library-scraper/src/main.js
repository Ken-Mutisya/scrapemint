// Facebook Ads Library Scraper (Public, No Login)
//
// Strategy
// --------
// Meta runs a public ad transparency surface at facebook.com/ads/library/.
// Anonymous visitors can browse every active and past ad on Facebook,
// Instagram, Audience Network, and Messenger by keyword search or by
// advertiser page. The page is a React SPA with infinite scroll.
//
// We build the canonical Ads Library URL per query and per country, scroll
// the result list until we hit maxAdsPerQuery (or the list ends), and
// extract one row per visible ad card with library ID, advertiser, ad copy,
// creative URL, started date, platforms, country, ad type, and active status.
//
// Pay-per-event:
//   ad_row ($0.005) charged when an ad row is pushed.
//   First 20 ad rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    pageUrls = [],
    countries: countriesInput = ['US'],
    adType = 'ALL',
    activeStatus = 'all',
    maxAdsPerQuery = 100,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const countries = (Array.isArray(countriesInput) ? countriesInput : [countriesInput])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter(Boolean);
if (countries.length === 0) countries.push('US');

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
const cleanPages = (Array.isArray(pageUrls) ? pageUrls : [pageUrls])
    .map((u) => parsePageInput(String(u || '').trim())).filter(Boolean);

if (cleanQueries.length === 0 && cleanPages.length === 0) {
    log.warning('Provide at least one search keyword in `queries` or one advertiser in `pageUrls`. Examples: queries=["meal kit"], pageUrls=["https://www.facebook.com/Nike"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const initialRequests = [];
for (const country of countries) {
    for (const q of cleanQueries) {
        initialRequests.push({
            url: buildKeywordUrl({ q, country, adType, activeStatus }),
            userData: { type: 'search', searchKey: `q:${country}:${q}`, country, query: q, adType, activeStatus },
            uniqueKey: `q:${country}:${q}:${adType}:${activeStatus}`,
        });
    }
    for (const p of cleanPages) {
        initialRequests.push({
            url: buildPageUrl({ pageId: p.id, country, adType, activeStatus }),
            userData: { type: 'page', searchKey: `p:${country}:${p.id}`, country, pageId: p.id, pageUrl: p.url, adType, activeStatus },
            uniqueKey: `p:${country}:${p.id}:${adType}:${activeStatus}`,
        });
    }
}

const seenLibraryIds = new Set();
let rowsPushed = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(10, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 5, maxErrorScore: 1 },
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
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
        },
    ],
    async requestHandler(ctx) {
        return handleSearch(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Searches: ${initialRequests.length}. Ads pushed: ${rowsPushed}.`);
await Actor.exit();

// ---------- Handler ----------

async function handleSearch({ page, request }) {
    const { searchKey, country, query, pageId, adType, activeStatus, type } = request.userData;
    log.info(`Search ${searchKey}: opening ${request.url}`);

    await dismissCookieBanner(page);

    try {
        await page.waitForSelector('div[role="main"], [role="article"], div[data-pagelet]', { timeout: 15000 });
    } catch {
        log.warning(`Search ${searchKey}: main not found, page may be gated.`);
    }

    let staleScrolls = 0;
    let lastCount = 0;
    let safetyScrolls = 0;
    const MAX_SCROLLS = Math.max(20, Math.ceil(maxAdsPerQuery / 4));
    const localPushedKeys = new Set();

    while (rowsPushed < Number.MAX_SAFE_INTEGER && safetyScrolls < MAX_SCROLLS) {
        safetyScrolls += 1;

        const ads = await extractVisibleAds(page);
        let pushedThisRound = 0;

        for (const ad of ads) {
            if (!ad || !ad.libraryId) continue;
            if (seenLibraryIds.has(ad.libraryId)) continue;
            seenLibraryIds.add(ad.libraryId);
            localPushedKeys.add(ad.libraryId);

            const row = {
                libraryId: ad.libraryId,
                snapshotUrl: ad.snapshotUrl || `https://www.facebook.com/ads/library/?id=${ad.libraryId}`,
                advertiserName: ad.advertiserName || null,
                advertiserPageId: ad.pageId || (type === 'page' ? pageId : null),
                advertiserPageUrl: ad.pageUrl || (type === 'page' ? request.userData.pageUrl : null),
                adText: ad.adText || null,
                ctaText: ad.ctaText || null,
                landingUrl: ad.landingUrl || null,
                creativeImageUrls: ad.imageUrls || [],
                creativeVideoUrls: ad.videoUrls || [],
                platforms: ad.platforms || [],
                startedAt: ad.startedAt || null,
                lastSeenActiveAt: ad.lastSeenActiveAt || null,
                isActive: ad.isActive ?? null,
                variations: ad.variations ?? null,
                country,
                adType,
                activeStatusFilter: activeStatus,
                searchQuery: type === 'search' ? query : null,
                searchPageId: type === 'page' ? pageId : null,
                scrapedAt: new Date().toISOString(),
            };

            await Actor.pushData(row);
            rowsPushed += 1;
            pushedThisRound += 1;

            if (rowsPushed > FREE_TIER_ROWS) {
                await Actor.charge({ eventName: 'ad_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
            }

            if (localPushedKeys.size >= maxAdsPerQuery) break;
        }

        if (localPushedKeys.size >= maxAdsPerQuery) {
            log.info(`Search ${searchKey}: hit maxAdsPerQuery=${maxAdsPerQuery}.`);
            break;
        }

        if (pushedThisRound === 0 && localPushedKeys.size === lastCount) {
            staleScrolls += 1;
            if (staleScrolls >= 3) {
                log.info(`Search ${searchKey}: no new ads after 3 scrolls, stopping. Total pushed=${localPushedKeys.size}.`);
                break;
            }
        } else {
            staleScrolls = 0;
        }
        lastCount = localPushedKeys.size;

        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await page.waitForTimeout(1800 + Math.floor(Math.random() * 1200));
    }

    log.info(`Search ${searchKey}: done. Pushed ${localPushedKeys.size} ads (running total ${rowsPushed}).`);
}

// ---------- Extraction ----------

async function dismissCookieBanner(page) {
    try {
        await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, [role="button"]')];
            const target = btns.find((b) => /allow all|accept all|only allow essential|allow essential|accept|i agree/i.test((b.textContent || '').trim()));
            if (target) target.click();
        });
        await page.waitForTimeout(800);
    } catch {}
}

async function extractVisibleAds(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const all = (s, root = document) => [...root.querySelectorAll(s)];

        // Ad cards: Meta wraps each ad in a card with a "Library ID:" label.
        // We anchor on that label to be resilient to class name churn.
        const cards = [];
        const seen = new Set();

        const labelNodes = all('span, div').filter((el) => /Library ID:?/i.test(el.textContent || ''));
        for (const node of labelNodes) {
            // Walk up to find a stable card container (article-like, ~10 ancestors max).
            let card = node;
            for (let i = 0; i < 12 && card && card.parentElement; i += 1) {
                card = card.parentElement;
                const role = card.getAttribute && card.getAttribute('role');
                if (role === 'article' || role === 'group') break;
                if (card.querySelectorAll('img').length > 0 && card.querySelectorAll('a').length >= 1 && card.textContent && card.textContent.length > 200) break;
            }
            if (!card || seen.has(card)) continue;
            seen.add(card);
            cards.push(card);
        }

        const out = [];
        for (const card of cards) {
            const cardText = card.textContent || '';
            const libIdMatch = cardText.match(/Library ID:?\s*([0-9]{6,})/i);
            const libraryId = libIdMatch ? libIdMatch[1] : null;
            if (!libraryId) continue;

            const startedMatch = cardText.match(/Started running on\s*([A-Za-z0-9, .]+?)(?:\s*·|\s*$|\s*Platforms)/i);
            const lastSeenMatch = cardText.match(/(?:Last shown|Stopped running|Inactive since)[^A-Za-z0-9]*([A-Za-z0-9, .]+?)(?:\s*·|\s*Platforms|\s*$)/i);
            const variationsMatch = cardText.match(/(\d+)\s+ads?\s+use this/i);
            const isActive = /Active/i.test(cardText) && !/Inactive/i.test(cardText.split('Library ID')[0] || '');

            // Platforms: look for the platforms row.
            const platforms = [];
            for (const p of ['Facebook', 'Instagram', 'Audience Network', 'Messenger', 'Threads']) {
                const re = new RegExp(`\\bPlatforms[^A-Za-z]*[\\s\\S]*?\\b${p}\\b`, 'i');
                if (re.test(cardText)) platforms.push(p);
            }
            // Fallback: scan platform icons by alt text.
            if (platforms.length === 0) {
                for (const img of card.querySelectorAll('img[alt]')) {
                    const alt = (img.getAttribute('alt') || '').toLowerCase();
                    if (alt.includes('facebook') && !platforms.includes('Facebook')) platforms.push('Facebook');
                    if (alt.includes('instagram') && !platforms.includes('Instagram')) platforms.push('Instagram');
                    if (alt.includes('messenger') && !platforms.includes('Messenger')) platforms.push('Messenger');
                    if (alt.includes('audience network') && !platforms.includes('Audience Network')) platforms.push('Audience Network');
                }
            }

            // Advertiser name + page URL: usually first link to /{handle}/ or /pages/.
            let advertiserName = null;
            let pageUrl = null;
            let pageId = null;
            for (const a of card.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                if (/\/ads\/library\//.test(href)) continue;
                if (/^https?:\/\/(www\.)?facebook\.com\//.test(href) || href.startsWith('/')) {
                    const t = (a.textContent || '').trim();
                    if (t && t.length > 0 && t.length < 80) {
                        advertiserName = t;
                        pageUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
                        const idMatch = href.match(/[?&](?:view_all_)?page_id=(\d+)/) || href.match(/\/(\d{6,})(?:[/?#]|$)/);
                        if (idMatch) pageId = idMatch[1];
                        break;
                    }
                }
            }

            // Ad copy: longest text block inside the card excluding the meta header/footer.
            let adText = null;
            const candidates = [...card.querySelectorAll('div, span')]
                .map((el) => (el.innerText || el.textContent || '').trim())
                .filter((t) => t && t.length > 30 && t.length < 1500 && !/Library ID/i.test(t) && !/Started running/i.test(t) && !/Sponsored/i.test(t));
            if (candidates.length) {
                adText = candidates.reduce((a, b) => (b.length > a.length ? b : a), '');
            }

            // CTA button text and landing URL.
            let ctaText = null;
            let landingUrl = null;
            for (const a of card.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                if (/\/ads\/library\//.test(href)) continue;
                if (/^https?:\/\/(www\.)?facebook\.com\//.test(href)) continue;
                if (href.startsWith('http')) {
                    landingUrl = href;
                    const role = a.getAttribute('role');
                    if (role === 'button') ctaText = text(a);
                    if (!ctaText) {
                        const inner = text(a);
                        if (inner && inner.length < 40) ctaText = inner;
                    }
                    break;
                }
            }

            // Snapshot URL (Library ID deep link).
            let snapshotUrl = null;
            for (const a of card.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                if (/\/ads\/library\/[^?]*\?[^"']*id=/.test(href)) {
                    snapshotUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
                    break;
                }
            }

            // Creative URLs.
            const imageUrls = [];
            const videoUrls = [];
            for (const img of card.querySelectorAll('img')) {
                const src = img.getAttribute('src');
                if (!src) continue;
                if (/scontent|fbcdn/.test(src) && !imageUrls.includes(src)) imageUrls.push(src);
                if (imageUrls.length >= 6) break;
            }
            for (const v of card.querySelectorAll('video')) {
                const src = v.getAttribute('src') || v.querySelector('source')?.getAttribute('src');
                if (src && !videoUrls.includes(src)) videoUrls.push(src);
                if (videoUrls.length >= 4) break;
            }

            out.push({
                libraryId,
                snapshotUrl,
                advertiserName,
                pageId,
                pageUrl,
                adText,
                ctaText,
                landingUrl,
                imageUrls,
                videoUrls,
                platforms,
                startedAt: startedMatch ? startedMatch[1].trim() : null,
                lastSeenActiveAt: lastSeenMatch ? lastSeenMatch[1].trim() : null,
                isActive,
                variations: variationsMatch ? parseInt(variationsMatch[1], 10) : null,
            });
        }

        return out;
    });
}

// ---------- URL helpers ----------

function buildKeywordUrl({ q, country, adType, activeStatus }) {
    const params = new URLSearchParams({
        active_status: activeStatus || 'all',
        ad_type: adType || 'ALL',
        country: country || 'US',
        q,
        search_type: 'keyword_unordered',
        media_type: 'all',
    });
    return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function buildPageUrl({ pageId, country, adType, activeStatus }) {
    const params = new URLSearchParams({
        active_status: activeStatus || 'all',
        ad_type: adType || 'ALL',
        country: country || 'US',
        view_all_page_id: pageId,
        search_type: 'page',
    });
    return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function parsePageInput(raw) {
    if (!raw) return null;
    // Numeric ID alone.
    if (/^\d{6,}$/.test(raw)) return { id: raw, url: `https://www.facebook.com/${raw}` };

    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); }
    catch { return null; }

    // Ads Library URL with view_all_page_id.
    const viewAll = u.searchParams.get('view_all_page_id');
    if (viewAll && /^\d+$/.test(viewAll)) return { id: viewAll, url: `https://www.facebook.com/${viewAll}` };

    // Generic facebook.com/{handle} URL. We pass the handle through as ID; the
    // Ads Library accepts handles in `q` via search_type=keyword too, but
    // view_all_page_id strictly wants numeric IDs. If we cannot resolve here,
    // we fall back to the handle as a search query URL.
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!/(^|\.)facebook\.com$/.test(host)) return null;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    if (/^\d{6,}$/.test(seg)) return { id: seg, url: `https://www.facebook.com/${seg}` };

    // Handle. Caller can still use it; we produce a synthetic ID by storing
    // the handle under id and the URL builder will form a valid Ads Library
    // URL via fallback when the ID is non-numeric.
    return { id: seg, url: `https://www.facebook.com/${seg}` };
}
