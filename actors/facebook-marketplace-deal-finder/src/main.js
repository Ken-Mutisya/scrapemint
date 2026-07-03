// Facebook Marketplace Deal Finder
// Scrapes public Marketplace search via PlaywrightCrawler. Requires the
// caller to paste their own Facebook session cookies (c_user, xs, datr at
// minimum) because Marketplace blocks anonymous traffic.
//
// Approach:
//   - Inject cookies into the browser context.
//   - Navigate to https://www.facebook.com/marketplace/<city>/search?query=<kw>.
//   - Listen on `response` for /api/graphql/ payloads. Marketplace search
//     responses contain a tree of listing nodes with `listing_price` and
//     `marketplace_listing_title` fields. Walk the tree, collect each node
//     once, normalize to a flat row.
//   - Scroll the page to trigger lazy-loaded GraphQL batches.
//
// Free tier: first 30 listings per run are free. Charge per listing after.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ITEMS = 10;

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    cities = [],
    minPrice = 0,
    maxPrice = 0,
    daysListed = 0,
    condition = 'any',
    maxItemsPerSearch = 25,
    maxItemsTotal = 100,
    scrollPasses = 3,
    dedupe = true,
    fbCookies = [],
    proxyConfiguration: proxyInput,
} = input;

const kws = cleanList(keywords);
const cts = cleanList(cities).map((c) => c.toLowerCase().replace(/[^a-z0-9-]/g, ''));
const wantCondition = String(condition || 'any').toLowerCase();

if (kws.length === 0) {
    log.warning('No keywords provided. Add at least one search keyword and run again.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}
const finalCities = cts.length > 0 ? cts : ['sanfrancisco'];

const cookies = (Array.isArray(fbCookies) ? fbCookies : [])
    .filter((c) => c && c.name && c.value)
    .map((c) => ({
        name: String(c.name),
        value: String(c.value),
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'Lax',
    }));

if (cookies.length === 0) {
    log.warning('No Facebook cookies provided. Marketplace search returns 400 to anonymous traffic. Paste your c_user, xs, and datr cookies in fbCookies and run again.');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const seenStore = dedupe ? await Actor.openKeyValueStore('fb-marketplace-seen') : null;
const seen = new Set();
if (seenStore) {
    const prev = (await seenStore.getValue('seen-ids')) || [];
    for (const k of prev) seen.add(k);
}

let totalPushed = 0;

const initialRequests = [];
for (const city of finalCities) {
    for (const kw of kws) {
        initialRequests.push({
            url: `https://www.facebook.com/marketplace/${encodeURIComponent(city)}/search?query=${encodeURIComponent(kw)}`,
            userData: { type: 'search', city, keyword: kw, perSearchCount: 0 },
            uniqueKey: `search:${city}:${kw}`,
        });
    }
}

const cutoffMs = daysListed > 0 ? Date.now() - daysListed * 86400 * 1000 : 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 2,
    retryOnBlocked: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 25, sessionOptions: { maxUsageCount: 20 } },
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 120 }],
                devices: ['desktop'],
                operatingSystems: ['macos', 'windows'],
                locales: ['en-US'],
            },
        },
    },
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    preNavigationHooks: [
        async ({ page }) => {
            // Inject the caller's Facebook session cookies before nav.
            try {
                await page.context().addCookies(cookies);
            } catch (err) {
                log.warning(`Failed to set Facebook cookies: ${err?.message}`);
            }
        },
    ],
    async requestHandler({ page, request }) {
        if (totalPushed >= maxItemsTotal) {
            log.info(`Total cap reached (${totalPushed}/${maxItemsTotal}), skipping ${request.url}`);
            return;
        }

        const sourceLabel = `${request.userData.city}:${request.userData.keyword}`;
        const collected = new Set();

        const onResponse = async (resp) => {
            try {
                const url = resp.url();
                if (!/\/api\/graphql/i.test(url)) return;
                const ct = resp.headers()['content-type'] || '';
                if (!/json|javascript/i.test(ct)) return;
                const text = await resp.text().catch(() => '');
                // FB returns multi-document streams: one JSON per line.
                for (const chunk of text.split(/\r?\n/)) {
                    const trimmed = chunk.trim();
                    if (!trimmed.startsWith('{')) continue;
                    let json;
                    try { json = JSON.parse(trimmed); } catch { continue; }
                    const listings = extractListings(json);
                    for (const l of listings) {
                        if (!l.id || collected.has(l.id)) continue;
                        collected.add(l.id);
                        if (totalPushed >= maxItemsTotal) break;
                        if (request.userData.perSearchCount >= maxItemsPerSearch) break;
                        await maybePushListing(l, request, sourceLabel);
                    }
                }
            } catch (err) {
                log.debug(`response handler error: ${err?.message}`);
            }
        };

        page.on('response', onResponse);

        try {
            await page.setViewportSize({ width: 1440, height: 1800 });
            await page.waitForLoadState('domcontentloaded');

            if (await isLoginRedirect(page)) {
                throw new Error('Facebook returned login wall — cookies likely expired or invalid.');
            }

            await dismissConsent(page);
            // First hydration burst.
            await page.waitForTimeout(3000);

            const passes = Math.max(0, Math.min(30, Number(scrollPasses) || 0));
            for (let i = 0; i < passes; i++) {
                if (totalPushed >= maxItemsTotal) break;
                if (request.userData.perSearchCount >= maxItemsPerSearch) break;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(2200);
            }

            // Final settle so trailing GraphQL responses still arrive.
            await page.waitForTimeout(1500);

            log.info(`Done ${sourceLabel}: ${request.userData.perSearchCount} listings (${totalPushed}/${maxItemsTotal} total)`);
        } finally {
            page.off('response', onResponse);
        }
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

if (seenStore && totalPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen]);
}

log.info(`Run complete. Pushed ${totalPushed} Marketplace listings.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- push pipeline ----------

async function maybePushListing(l, request, sourceLabel) {
    if (totalPushed >= maxItemsTotal) return;
    if (request.userData.perSearchCount >= maxItemsPerSearch) return;

    if (Number.isFinite(l.price)) {
        if (minPrice > 0 && l.price < minPrice) return;
        if (maxPrice > 0 && l.price > maxPrice) return;
    }

    if (wantCondition !== 'any' && l.condition && l.condition !== wantCondition) return;

    if (cutoffMs > 0 && l.postedAt) {
        const ts = Date.parse(l.postedAt);
        if (Number.isFinite(ts) && ts < cutoffMs) return;
    }

    const dedupeKey = l.id;
    if (dedupe && seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const out = {
        ...l,
        city: request.userData.city,
        search: request.userData.keyword,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(out);
    totalPushed += 1;
    request.userData.perSearchCount += 1;
    maybeCharge();
}

// ---------- GraphQL response walker ----------

function extractListings(node, out = [], visited = new WeakSet()) {
    if (!node || typeof node !== 'object') return out;
    if (visited.has(node)) return out;
    visited.add(node);

    if (Array.isArray(node)) {
        for (const x of node) extractListings(x, out, visited);
        return out;
    }

    // Marketplace listing nodes carry a price and a title together. Look for
    // any object that has both, plus an id we can use as the unique key.
    const hasPrice = node.listing_price && typeof node.listing_price === 'object';
    const hasTitle = typeof node.marketplace_listing_title === 'string';
    if (hasPrice && hasTitle) {
        const row = mapListing(node);
        if (row && row.id) out.push(row);
    }

    for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') extractListings(v, out, visited);
    }
    return out;
}

function mapListing(n) {
    const id = n.id || n.story_key || n.story_fbid || n.legacy_storefront_listing_id || null;
    if (!id) return null;

    const lp = n.listing_price || {};
    const slp = n.strikethrough_price || null;
    const seller = n.marketplace_listing_seller || n.seller || {};
    const loc = n.location || n.marketplace_listing_location || {};
    const reach = n.reach_estimate || {};

    const photos = Array.isArray(n.listing_photos) ? n.listing_photos : [];
    const imageUrls = [];
    for (const p of photos) {
        const u = p?.image?.uri || p?.image?.url;
        if (u) imageUrls.push(u);
    }
    const primary = n.primary_listing_photo?.image?.uri || imageUrls[0] || null;

    const createdSec = Number(n.creation_time) || null;
    const postedAt = createdSec ? new Date(createdSec * 1000).toISOString() : null;
    const postedDaysAgo = createdSec ? Math.floor((Date.now() / 1000 - createdSec) / 86400) : null;

    const distanceMiles = numOrNull(reach?.estimated_distance_in_miles ?? n.estimated_distance_in_miles);

    const condRaw = String(n.marketplace_listing_condition || n.condition || '').toLowerCase();
    const condition = normalizeCondition(condRaw);

    const delivery = Array.isArray(n.delivery_types) ? n.delivery_types.map((d) => String(d).toLowerCase()) : [];
    const isShipping = delivery.includes('shipping') || !!n.is_shipping_available;

    return {
        id: String(id),
        url: `https://www.facebook.com/marketplace/item/${id}/`,
        title: n.marketplace_listing_title || null,
        price: numOrNull(lp.amount),
        currency: lp.currency || 'USD',
        formattedPrice: lp.formatted_amount || null,
        originalPrice: slp ? numOrNull(slp.amount) : null,
        isMarkedDown: !!slp,
        condition,
        category: n.marketplace_listing_category_name || n.category_name || null,
        location: loc.reverse_geocode_detailed?.city
            ? `${loc.reverse_geocode_detailed.city}${loc.reverse_geocode_detailed.state ? ', ' + loc.reverse_geocode_detailed.state : ''}`
            : (loc.formatted_address || loc.text || null),
        distanceMiles,
        postedAt,
        postedDaysAgo,
        seller: {
            id: seller.id || null,
            name: seller.name || null,
            profileUrl: seller.id ? `https://www.facebook.com/${seller.id}` : null,
        },
        primaryImageUrl: primary,
        imageUrls,
        isShippingAvailable: isShipping,
        deliveryTypes: delivery,
    };
}

function normalizeCondition(raw) {
    if (!raw) return null;
    if (/like.*new/.test(raw) || raw === 'used_like_new') return 'used_like_new';
    if (/good/.test(raw) || raw === 'used_good') return 'used_good';
    if (/fair/.test(raw) || raw === 'used_fair') return 'used_fair';
    if (/^new$/.test(raw)) return 'new';
    if (raw.startsWith('used')) return 'used_good';
    return raw;
}

function numOrNull(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ---------- input cleanup ----------

function cleanList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map((v) => (typeof v === 'string' ? v : v?.value || v?.url || ''))
        .map((v) => String(v).trim())
        .filter(Boolean);
}

// ---------- page helpers ----------

async function dismissConsent(page) {
    const selectors = [
        'div[role="dialog"] button:has-text("Allow all cookies")',
        'div[role="dialog"] button:has-text("Accept")',
        'button[data-cookiebanner="accept_button"]',
        'button:has-text("Allow all cookies")',
        'button[aria-label="Close"]',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(400);
                break;
            }
        } catch {}
    }
}

async function isLoginRedirect(page) {
    const url = page.url();
    if (/\/login|\/checkpoint|\/recover/i.test(url)) return true;
    const title = await page.title().catch(() => '');
    if (/log in to facebook|facebook – log in/i.test(title)) return true;
    return false;
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        __chargeJobs.push(Actor.charge({ eventName: 'deal_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }));
    }
}
