// Shopify Theme & App Detector
//
// Strategy
// --------
// For each store URL we fetch the homepage once and read what Shopify itself
// embeds in every storefront:
//   - `Shopify.theme = {...}`: the theme's custom name, the underlying theme
//     (schema_name, e.g. "Dawn", "Prestige"), its version and theme store id.
//   - `Shopify.shop`, `Shopify.currency`, `Shopify.locale`.
//   - `webPixelsConfigList`: app pixels (type APP) and custom pixels.
// Installed apps are matched by the script hosts and markers each app injects
// (see APPS below). Then `/meta.json` adds the store name, city, country and
// published product count. No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   store_detected ($0.003) per URL confirmed as a Shopify store.
//   Non-Shopify sites, unreachable URLs and invalid inputs are free.
//   The first 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

// [name, category, ...lowercase markers]. A marker is a substring of the HTML.
const APPS = [
    ['Klaviyo', 'email & sms', 'static.klaviyo.com', 'klaviyo.com/onsite'],
    ['Omnisend', 'email & sms', 'omnisnippet', 'omnisend.com'],
    ['Privy', 'popups', 'privy.com/'],
    ['Attentive', 'email & sms', 'attn.tv', 'attentivemobile'],
    ['Postscript', 'email & sms', 'postscript.io'],
    ['SMSBump', 'email & sms', 'smsbump'],
    ['Mailchimp', 'email & sms', 'chimpstatic.com', 'list-manage.com'],
    ['Yotpo', 'reviews', 'yotpo.com', 'staticw2.yotpo'],
    ['Judge.me', 'reviews', 'judge.me', 'judgeme'],
    ['Okendo', 'reviews', 'okendo.io', 'okendo-reviews'],
    ['Loox', 'reviews', 'loox.io'],
    ['Stamped.io', 'reviews', 'stamped.io'],
    ['Junip', 'reviews', 'junip.co'],
    ['REVIEWS.io', 'reviews', 'reviews.io/', 'reviewsio'],
    ['Trustpilot', 'reviews', 'widget.trustpilot.com'],
    ['Fera', 'reviews', 'fera.ai'],
    ['Growave', 'loyalty', 'growave'],
    ['Smile.io', 'loyalty', 'smile.io', 'smile-shopify'],
    ['LoyaltyLion', 'loyalty', 'loyaltylion'],
    ['Rivo', 'loyalty', 'rivo.io'],
    ['Recharge', 'subscriptions', 'rechargecdn', 'rechargepayments', 'rechargeapps'],
    ['Skio', 'subscriptions', 'skio.com'],
    ['Seal Subscriptions', 'subscriptions', 'sealsubscriptions'],
    ['Appstle Subscriptions', 'subscriptions', 'appstle'],
    ['Bold Commerce', 'subscriptions', 'boldapps.net', 'boldcommerce'],
    ['Rebuy', 'upsell', 'rebuyengine'],
    ['ReConvert', 'upsell', 'reconvert'],
    ['Zipify', 'upsell', 'zipify'],
    ['Intelligems', 'a/b testing', 'intelligems'],
    ['VWO', 'a/b testing', 'visualwebsiteoptimizer'],
    ['Convert', 'a/b testing', 'convertexperiments'],
    ['Nosto', 'personalization', 'nosto.com', 'connect.nosto'],
    ['LimeSpot', 'personalization', 'limespot'],
    ['Dynamic Yield', 'personalization', 'dynamicyield'],
    ['Searchanise', 'search', 'searchanise'],
    ['Boost Commerce', 'search', 'boostcommerce', 'bc-sf-filter'],
    ['Algolia', 'search', 'algolia'],
    ['Klevu', 'search', 'klevu'],
    ['Gorgias', 'support', 'gorgias'],
    ['Tidio', 'support', 'tidio'],
    ['Zendesk', 'support', 'zdassets.com'],
    ['Intercom', 'support', 'widget.intercom.io', 'intercomcdn'],
    ['Re:amaze', 'support', 'reamaze'],
    ['Afterpay', 'payments', 'afterpay'],
    ['Klarna', 'payments', 'klarna'],
    ['Affirm', 'payments', 'cdn1.affirm.com', 'affirm.js'],
    ['Sezzle', 'payments', 'sezzle'],
    ['Global-e', 'cross-border', 'global-e.com', 'bglobale'],
    ['Redo', 'returns', 'getredo'],
    ['Route', 'shipping protection', 'routeapp.io', 'route-widget'],
    ['Loop Returns', 'returns', 'loopreturns'],
    ['AfterShip', 'shipping', 'aftership'],
    ['Narvar', 'shipping', 'narvar'],
    ['Triple Whale', 'analytics', 'triplewhale', 'triplepixel'],
    ['Elevar', 'analytics', 'elevar'],
    ['Northbeam', 'analytics', 'northbeam'],
    ['Hotjar', 'analytics', 'hotjar'],
    ['Lucky Orange', 'analytics', 'luckyorange'],
    ['Microsoft Clarity', 'analytics', 'clarity.ms'],
    ['Google Analytics', 'analytics', 'google-analytics.com', 'googletagmanager.com/gtag'],
    ['Google Tag Manager', 'analytics', 'googletagmanager.com/gtm'],
    ['Meta Pixel', 'ads pixel', 'connect.facebook.net', 'fbevents.js'],
    ['TikTok Pixel', 'ads pixel', 'analytics.tiktok.com'],
    ['Pinterest Tag', 'ads pixel', 's.pinimg.com/ct', 'pintrk'],
    ['Snap Pixel', 'ads pixel', 'sc-static.net/scevent'],
    ['PageFly', 'page builder', 'pagefly'],
    ['GemPages', 'page builder', 'gempages'],
    ['Shogun', 'page builder', 'getshogun', 'shogun-frontend'],
    ['Replo', 'page builder', 'replo'],
    ['Weglot', 'translation', 'weglot'],
    ['Langify', 'translation', 'langify'],
    ['Vitals', 'all-in-one', 'vitals.co', 'vitals-app'],
    ['Hextom', 'marketing', 'hextom'],
    ['Justuno', 'popups', 'justuno'],
    ['Wisepops', 'popups', 'wisepops'],
    ['OptiMonk', 'popups', 'optimonk'],
    ['accessiBe', 'accessibility', 'accessibe'],
    ['UserWay', 'accessibility', 'userway'],
    ['Cookiebot', 'consent', 'cookiebot'],
    ['OneTrust', 'consent', 'cookielaw.org', 'onetrust'],
    ['Pandectes', 'consent', 'pandectes'],
    ['Swym Wishlist', 'wishlist', 'swymrelay', 'swym-'],
    ['Wishlist Hero', 'wishlist', 'wishlisthero'],
    ['Tapcart', 'mobile app', 'tapcart'],
    ['Instafeed', 'social', 'instafeed'],
    ['Foursixty', 'social', 'foursixty'],
];

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { urls = [], includeStoreDetails = true, concurrency = 8, maxRows = 1000 } = input;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const conc = Math.max(1, Math.min(20, Number(concurrency) || 8));

function normalize(s) {
    let d = String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').split('@').pop().split(':')[0].replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

const raw = (Array.isArray(urls) ? urls : String(urls || '').split(/[\n,]/)).map((s) => (typeof s === 'object' && s ? s.url : s)).map((s) => String(s || '').trim()).filter(Boolean);
const seen = new Set();
const targets = [];
const invalid = [];
for (const r of raw) {
    const d = normalize(r);
    if (!d) { invalid.push(r); continue; }
    if (seen.has(d)) continue;
    seen.add(d);
    targets.push({ input: r, host: d });
    if (targets.length >= cap) break;
}
if (!targets.length) {
    await Actor.pushData({ note: 'No valid store URLs in input. Example: allbirds.com' });
    await Actor.exit();
}
log.info(`Checking ${targets.length} URLs (${invalid.length} invalid).`);

// One retry with backoff when the site rate-limits us (429) or is briefly unavailable (503).
async function get(url, { json = false } = {}) {
    const r = await getOnce(url, { json });
    if (r.status !== 429 && r.status !== 503) return r;
    const wait = Math.min(15, Number(r.headers?.get('retry-after')) || 0) * 1000 || 3000 + Math.random() * 3000;
    await new Promise((res) => setTimeout(res, wait));
    return getOnce(url, { json });
}

async function getOnce(url, { json = false } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: ctrl.signal,
            headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.subarray(0, MAX_HTML_BYTES).toString('utf8');
        return { status: res.status, url: res.url, headers: res.headers, text };
    } catch (err) {
        return { status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
    } finally { clearTimeout(t); }
}

// Pull a JSON object that follows `marker` in the HTML, balancing braces.
function jsonAfter(html, marker) {
    const i = html.indexOf(marker);
    if (i < 0) return null;
    const start = html.indexOf('{', i + marker.length);
    if (start < 0 || start - i > marker.length + 5) return null;
    let depth = 0; let inStr = false; let esc = false;
    for (let j = start; j < Math.min(html.length, start + 20000); j++) {
        const c = html[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; } } }
    }
    return null;
}

function pixels(html) {
    const i = html.indexOf('webPixelsConfigList');
    if (i < 0) return { app: null, custom: null };
    const seg = html.slice(i, i + 60000);
    const end = seg.indexOf('}]');
    const s = end > 0 ? seg.slice(0, end) : seg;
    return { app: (s.match(/"type":"APP"/g) || []).length, custom: (s.match(/"type":"CUSTOM"/g) || []).length };
}

const decode = (s) => (s == null ? s : String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));

async function inspect(t) {
    const home = await get(`https://${t.host}/`);
    const base = { input: t.input, url: home.url || `https://${t.host}/`, domain: t.host };
    if (!home.status || home.status >= 400) {
        return { row: { ...base, isShopify: null, httpStatus: home.status || null, error: home.error || `HTTP ${home.status}`, checkedAt: new Date().toISOString() }, ok: false };
    }
    const html = home.text;
    const lower = html.toLowerCase();
    const isShopify = lower.includes('cdn.shopify.com') || lower.includes('shopify.theme') || !!home.headers.get('x-shopid') || !!home.headers.get('x-shopify-stage');
    if (!isShopify) {
        return { row: { ...base, isShopify: false, httpStatus: home.status, note: 'Not a Shopify store. Not charged.', checkedAt: new Date().toISOString() }, ok: false };
    }
    const theme = jsonAfter(html, 'Shopify.theme =') || jsonAfter(html, 'Shopify.theme=');
    const shop = html.match(/Shopify\.shop\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const currency = jsonAfter(html, 'Shopify.currency =')?.active ?? null;
    const locale = html.match(/Shopify\.locale\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const country = html.match(/Shopify\.country\s*=\s*"([^"]+)"/)?.[1] ?? null;
    const shopId = Number(html.match(/"shopId":\s*"?(\d+)/)?.[1]) || null;
    const apps = [];
    for (const [name, category, ...markers] of APPS) {
        if (markers.some((m) => lower.includes(m))) apps.push({ name, category });
    }
    const px = pixels(html);
    let meta = null;
    if (includeStoreDetails) {
        const m = await get(`https://${t.host}/meta.json`, { json: true });
        if (m.status === 200) { try { meta = JSON.parse(m.text); } catch { meta = null; } }
    }
    const themeStoreId = theme?.theme_store_id ?? null;
    return {
        ok: true,
        row: {
            ...base,
            isShopify: true,
            storeName: decode(meta?.name) ?? null,
            myshopifyDomain: meta?.myshopify_domain ?? shop,
            shopId: meta?.id ?? shopId,
            themeName: theme?.schema_name ?? null,
            themeVersion: theme?.schema_version ?? null,
            themeCustomName: theme?.name ?? null,
            themeStoreId,
            isThemeStoreTheme: theme ? themeStoreId != null : null,
            themeStoreUrl: themeStoreId != null ? `https://themes.shopify.com/themes?theme_store_id=${themeStoreId}` : null,
            apps,
            appCount: apps.length,
            appNames: apps.map((a) => a.name).join(', '),
            appPixelCount: px.app,
            customPixelCount: px.custom,
            currency: meta?.currency ?? currency,
            locale,
            country: meta?.country ?? country,
            province: meta?.province ?? null,
            city: meta?.city ?? null,
            publishedProductCount: meta?.published_products_count ?? null,
            publishedCollectionCount: meta?.published_collections_count ?? null,
            description: decode(meta?.description)?.slice(0, 500) ?? null,
            httpStatus: home.status,
            checkedAt: new Date().toISOString(),
        },
    };
}

let chargeable = 0;
const stats = { urls: targets.length, shopify: 0, notShopify: 0, failed: 0, invalid: invalid.length };
const themeCounts = {};
const appCounts = {};
let idx = 0;
async function worker() {
    while (idx < targets.length) {
        if (pastDeadline()) return;
        const t = targets[idx++];
        const { row, ok } = await inspect(t);
        await Actor.pushData(row);
        if (row.isShopify === true) {
            stats.shopify += 1;
            if (row.themeName) themeCounts[row.themeName] = (themeCounts[row.themeName] || 0) + 1;
            for (const a of row.apps) appCounts[a.name] = (appCounts[a.name] || 0) + 1;
        } else if (row.isShopify === false) stats.notShopify += 1; else stats.failed += 1;
        if (ok) {
            chargeable += 1;
            if (chargeable > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'store_detected' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    }
}
await Promise.all(Array.from({ length: conc }, worker));
if (pastDeadline()) log.warning('Approaching run timeout; stopped early with results so far.');

for (const s of invalid.slice(0, 50)) await Actor.pushData({ input: s, note: 'Not a valid URL or domain. Not charged.' });
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, stores]) => ({ name, stores }));
await Actor.setValue('SUMMARY', { ...stats, topThemes: top(themeCounts), topApps: top(appCounts) });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
