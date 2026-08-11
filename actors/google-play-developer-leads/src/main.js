// Google Play Developer Lead Scraper
//
// Turns Google Play app listings into B2B leads. For each keyword or category you
// pass, it searches the Play store, opens each app's detail page, and extracts the
// developer's public contact email and website plus the app title, developer name,
// category, install band, rating, and monetization flags. One lead per app.
//
// Buyers: app-monetization / SDK vendors, ASO and mobile-marketing agencies, ad
// networks, and dev-service shops that sell to app developers.
//
// Everything is plain public HTTP (no login, no API key). The developer contact
// email is published on the listing, so leads are actionable out of the box.
//
// Pay-per-event:
//   qualified_lead ($0.05): developer email + website + installs at/above the bar.
//   lead ($0.02): a developer email is present.
//   listing ($0.01): app + developer data with no public email.
//   First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import gplay from 'google-play-scraper';

const FREE_TIER_QUALIFIED = 10;
const BASE = 'https://play.google.com';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    categories = [],
    country = 'us',
    language = 'en',
    collection = 'TOP_FREE',
    expandSimilar = false,
    maxApps = 25,
    maxAppsPerQuery = 60,
    minInstalls = 0,
    requireEmail = false,
    qualifiedMinInstalls = 10000,
    concurrency = 10,
    proxyConfiguration: proxyInput,
} = input;

const gl = String(country || 'us').trim().toLowerCase();
const hl = String(language || 'en').trim().toLowerCase();
const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
const cleanCategories = [...new Set((Array.isArray(categories) ? categories : [categories]).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))];
if (cleanKeywords.length === 0 && cleanCategories.length === 0) {
    throw new Error('Provide at least one keyword (e.g. ["invoicing","crm"]) or category (e.g. ["BUSINESS"]).');
}

const appCap = Math.max(1, Math.min(5000, Number(maxApps) || 200));
const perQueryCap = Math.max(1, Math.min(500, Number(maxAppsPerQuery) || 60));
const minInst = Math.max(0, Number(minInstalls) || 0);
const qualMinInst = Math.max(0, Number(qualifiedMinInstalls) || 10000);

const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage A: collect app IDs ----------
// google-play-scraper handles Play's internal batchexecute pagination for search,
// category top-charts (the high-volume lever), and similar-apps expansion.
const appIds = await collectAppIds();
log.info(`Collected ${appIds.length} unique app IDs to scrape.`);
if (appIds.length === 0) {
    log.warning('No apps found for the given keywords/categories.');
    await Actor.exit();
}

// ---------- Stage B: scrape each detail page (proxied) for the developer email ----------
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(30, Number(concurrency) || 10)),
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 3,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...request.headers,
                'Accept-Language': `${hl}-${gl.toUpperCase()},${hl};q=0.9`,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            };
        },
    ],
    async requestHandler(ctx) {
        return handleDetail(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(appIds.map((id) => ({
    url: `${BASE}/store/apps/details?id=${id}&hl=${hl}&gl=${gl}`,
    userData: { type: 'detail', appId: id },
    uniqueKey: `detail:${id}`,
})));
await crawler.run();

log.info(`Done. qualified_lead charged=${qualifiedCharged} free=${qualifiedFree}, lead=${leadCount}, listing=${listingCount}. Apps scraped=${appIds.length}.`);
await Actor.exit();

// ---------- Stage A helper ----------

async function collectAppIds() {
    const ids = new Set();
    const add = (arr) => {
        for (const a of arr || []) {
            if (ids.size >= appCap) break;
            if (a?.appId) ids.add(a.appId);
        }
    };

    for (const kw of cleanKeywords) {
        if (ids.size >= appCap) break;
        try {
            add(await gplay.search({ term: kw, num: perQueryCap, country: gl, lang: hl }));
            log.info(`search "${kw}": running total ${ids.size} apps.`);
        } catch (e) { log.warning(`search "${kw}" failed: ${e?.message}`); }
    }

    // Category top-charts are the volume lever: up to ~250 apps per category.
    for (const cat of cleanCategories) {
        if (ids.size >= appCap) break;
        try {
            add(await gplay.list({ category: cat, collection, num: Math.min(250, perQueryCap), country: gl, lang: hl }));
            log.info(`category "${cat}" (${collection}): running total ${ids.size} apps.`);
        } catch (e) { log.warning(`list "${cat}" failed: ${e?.message}`); }
    }

    // Optional: widen the net with apps similar to the seeds collected so far.
    if (expandSimilar && ids.size < appCap) {
        const seeds = [...ids].slice(0, 15);
        for (const id of seeds) {
            if (ids.size >= appCap) break;
            try { add(await gplay.similar({ appId: id, num: 30, country: gl, lang: hl })); }
            catch (e) { log.debug(`similar(${id}) failed: ${e?.message}`); }
        }
        log.info(`After similar expansion: ${ids.size} apps.`);
    }

    return [...ids].slice(0, appCap);
}

// ---------- Stage B handler ----------

async function handleDetail({ body, request }) {
    const html = body.toString();
    const appId = request.userData.appId;
    const lead = parseApp(html, appId);
    if (!lead.title) { log.debug(`No title parsed for ${appId}; skipping.`); return; }

    if (minInst > 0 && (lead.installsNumeric == null || lead.installsNumeric < minInst)) return;
    if (requireEmail && !lead.developerEmail) return;

    const tier = (lead.developerEmail && lead.developerWebsite && (lead.installsNumeric || 0) >= qualMinInst)
        ? 'qualified_lead'
        : (lead.developerEmail ? 'lead' : 'listing');

    const row = { ...lead, tier, scrapedAt: new Date().toISOString() };
    await Actor.pushData(row);

    if (tier === 'qualified_lead') {
        if (qualifiedFree + qualifiedCharged < FREE_TIER_QUALIFIED) qualifiedFree += 1;
        else { await charge('qualified_lead'); qualifiedCharged += 1; }
    } else if (tier === 'lead') {
        await charge('lead'); leadCount += 1;
    } else {
        await charge('listing'); listingCount += 1;
    }
}

// ---------- Parsing ----------

function parseApp(html, appId) {
    const title = clean(decodeEntities((html.match(/<meta property="og:title" content="([^"]*)"/i) || [])[1]))
        ?.replace(/\s*-\s*Apps on Google Play\s*$/i, '')?.trim() || null;

    // Developer link is either dev?id=<number> (verified developers) or
    // developer?id=<name> (e.g. HubSpot). Handle both and pull the link text.
    const devM = html.match(/\/store\/apps\/(dev|developer)\?id=([^"]+)"[^>]*>(?:<[^>]*>)*([^<>]{2,80})</);
    let devId = null; let developerName = null; let developerUrl = null;
    if (devM) {
        devId = decodeEntities(devM[2]);
        developerName = clean(decodeEntities(devM[3]));
        developerUrl = `${BASE}/store/apps/${devM[1]}?id=${devM[2]}&hl=${hl}&gl=${gl}`;
    }

    // Developer contact email: the listing's mailto link.
    const developerEmail = decodeEntities((html.match(/mailto:([^"?]+)/i) || [])[1])?.toLowerCase() || null;

    // Developer website: the "Website ... will open" contact link.
    let developerWebsite = decodeEntities((html.match(/aria-label="Website\s+(https?:\/\/[^"]+?)\s+will open/i) || [])[1]) || null;
    if (developerWebsite) developerWebsite = developerWebsite.split(/[?#]/)[0]; // drop utm tracking

    const ratingRaw = (html.match(/aria-label="Rated\s+([0-9.]+)\s+stars/i) || [])[1]
        || (html.match(/"ratingValue"[:\s"]+([0-9.]+)/i) || [])[1];
    const rating = ratingRaw ? Math.round(parseFloat(ratingRaw) * 10) / 10 : null;

    const installsText = (html.match(/>([0-9][0-9.,]*[KMB]?\+?)<\/div><div[^>]*>\s*Downloads/i) || [])[1] || null;
    const installsNumeric = parseInstalls(installsText);

    // The app's own category chip carries an aria-label + jsname="hSRGPd"; other
    // /category/ links on the page are nav chrome (FAMILY, etc.).
    const category = (html.match(/\/store\/apps\/category\/([A-Z_]+)"\s+aria-label="[^"]*"\s+jsname="hSRGPd"/) || [])[1] || null;

    const containsAds = /Contains ads/i.test(html);
    const inAppPurchases = /In-app purchases/i.test(html);

    return {
        appId,
        title,
        url: `${BASE}/store/apps/details?id=${appId}`,
        developerName,
        developerId: devId,
        developerUrl,
        developerEmail,
        developerWebsite,
        category,
        rating,
        installs: installsText,
        installsNumeric,
        containsAds,
        inAppPurchases,
    };
}

function parseInstalls(s) {
    if (!s) return null;
    const m = String(s).replace(/[,+\s]/g, '').match(/^([0-9.]+)([KMB]?)$/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = m[2].toUpperCase();
    if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
    return Math.round(n);
}

function decodeEntities(s) {
    if (!s) return s;
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#0?39;/g, "'");
}

function clean(s) {
    if (!s) return s;
    return String(s).replace(/\s+/g, ' ').trim() || null;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

// Buyer-selected RESIDENTIAL or SERP proxy groups bill the developer under
// pay-per-event pricing, and this data source works from datacenter IPs, so
// those groups are stripped (buyer-supplied proxyUrls pass through untouched).
function sanitizeProxyInput(p) {
    if (!p || typeof p !== 'object') return p;
    const out = { ...p };
    if (Array.isArray(out.apifyProxyGroups)) {
        const kept = out.apifyProxyGroups.filter((g) => !/RESIDENTIAL|SERP/i.test(String(g)));
        if (kept.length !== out.apifyProxyGroups.length) {
            log.warning('Ignoring RESIDENTIAL/SERP proxy groups: this source works from datacenter IPs and premium groups only raise run costs.');
        }
        if (kept.length) out.apifyProxyGroups = kept;
        else delete out.apifyProxyGroups;
    }
    return out;
}
