// Shopify App Store Developer Lead Scraper
//
// Turns the Shopify App Store into B2B leads. For each keyword it name-matches the
// App Store sitemap (all ~22k app handles), then opens each app page and extracts
// the developer's public support email, developer name and partner page, company
// website, app name, rating, review count, and pricing. One lead per app.
//
// Buyers: tool/SDK vendors and agencies that sell to Shopify app developers, app
// review and ASO services, and marketplaces.
//
// Discovery is the keyless App Store sitemap; detail pages are fetched with a
// proxied CheerioCrawler. The support email is published on the listing.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const FREE_TIER_QUALIFIED = 10;
const BASE = 'https://apps.shopify.com';
const SITEMAP = 'https://apps.shopify.com/sitemap_apps_en.xml';
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    maxLeads = 25,
    maxPerKeyword = 80,
    minReviews = 0,
    qualifiedMinReviews = 10,
    requireEmail = false,
    concurrency = 8,
    proxyConfiguration: proxyInput,
} = input;

const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean))];
if (cleanKeywords.length === 0) throw new Error('Provide at least one keyword, e.g. ["email","upsell","reviews","wholesale"].');

const leadCap = Math.max(1, Math.min(5000, Number(maxLeads) || 200));
const perKwCap = Math.max(1, Math.min(500, Number(maxPerKeyword) || 80));
const minRev = Math.max(0, Number(minReviews) || 0);
const qualRev = Math.max(0, Number(qualifiedMinReviews) || 10);

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: discover app handles via the sitemap ----------
log.info('Loading Shopify App Store sitemap...');
const handles = await loadHandles();
if (!handles) { log.error('Could not load the app sitemap. Exiting.'); await Actor.exit(); }
log.info(`Sitemap has ${handles.length} app handles.`);

const picked = [];
const seen = new Set();
for (const kw of cleanKeywords) {
    const matches = handles.filter((h) => h.includes(kw));
    matches.sort((a, b) => rankHandle(a, kw) - rankHandle(b, kw) || a.length - b.length);
    let added = 0;
    for (const h of matches) {
        if (added >= perKwCap || picked.length >= leadCap) break;
        if (seen.has(h)) continue;
        seen.add(h); picked.push(h); added += 1;
    }
    log.info(`"${kw}": ${matches.length} handle matches, took ${added} (total ${picked.length}).`);
    if (picked.length >= leadCap) break;
}
if (picked.length === 0) { log.warning('No app handles matched the keywords.'); await Actor.exit(); }

// ---------- Stage 2: scrape each app page (proxied) ----------
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 8)),
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 3,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [async ({ request }) => {
        request.headers = {
            ...request.headers,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        };
    }],
    async requestHandler({ body, request }) {
        const lead = parseApp(body.toString(), request.userData.handle);
        if (!lead.name) return;
        if (minRev > 0 && (lead.reviewCount || 0) < minRev) return;
        if (requireEmail && !lead.supportEmail) return;

        const tier = (lead.supportEmail && (lead.reviewCount || 0) >= qualRev) ? 'qualified_lead'
            : ((lead.supportEmail || lead.website) ? 'lead' : 'listing');
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
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(picked.map((h) => ({
    url: `${BASE}/${h}`,
    userData: { handle: h },
    uniqueKey: `app:${h}`,
})));
await crawler.run();

log.info(`Done. qualified_lead charged=${qualifiedCharged} free=${qualifiedFree}, lead=${leadCount}, listing=${listingCount}. Apps=${picked.length}.`);
await Actor.exit();

// ---------- Stage 1 helper ----------

async function loadHandles() {
    try {
        const res = await fetch(SITEMAP, { headers: { 'User-Agent': 'scrapemint-shopify-leads/1.0' } });
        if (!res.ok) return null;
        const xml = await res.text();
        const handles = [...xml.matchAll(/<loc>https:\/\/apps\.shopify\.com\/([a-z0-9][a-z0-9-]{2,80})<\/loc>/g)]
            .map((m) => m[1])
            .filter((h) => !/^(partners|categories|collections|stories|sitemap)/.test(h));
        return [...new Set(handles)];
    } catch (e) { log.warning(`sitemap fetch failed: ${e?.message}`); return null; }
}

// ---------- parsing ----------

function parseApp(html, handle) {
    let name = decodeEntities((html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1]);
    if (name) name = name.replace(/\s*\|\s*Shopify App Store\s*$/i, '').split(' - ')[0].trim();

    const supportEmail = pickEmail((html.match(/data-developer-support-email="([^"]+)"/i) || [])[1]);

    // Developer name + partner page: /partners/<slug>">Name<
    const devM = html.match(/href="(https:\/\/apps\.shopify\.com\/partners\/[a-z0-9-]+)"[^>]*>\s*([^<]{2,60})</i);
    const partnerUrl = devM ? devM[1] : null;
    const developerName = devM ? clean(decodeEntities(devM[2])) : null;

    // Company website: domain of the privacy policy (or first external resource link).
    const website = companySite(html);

    const ratingRaw = (html.match(/"ratingValue"[:\s"]*([0-9.]+)/i) || [])[1]
        || (html.match(/aria-label="([0-9.]+) out of 5 stars/i) || [])[1];
    const rating = ratingRaw ? Math.round(parseFloat(ratingRaw) * 10) / 10 : null;
    const reviewCount = numOrNull((html.match(/"reviewCount"[:\s"]*([0-9,]+)/i) || [])[1]
        || (html.match(/([0-9,]{1,9})\s*(?:reviews|Reviews)/) || [])[1]);

    const pricing = (html.match(/data-test-id="pricing-plan-pill"[^>]*>\s*([^<]{2,40})/i) || [])[1]?.trim()
        || (/Free to install/i.test(html) ? 'Free to install' : (/Free plan available/i.test(html) ? 'Free plan available' : (/>\s*Free\s*</.test(html) ? 'Free' : null)));

    return {
        name,
        handle,
        url: `${BASE}/${handle}`,
        developerName,
        partnerUrl,
        supportEmail,
        website,
        rating,
        reviewCount,
        pricing,
    };
}

function companySite(html) {
    // Privacy policy link domain is the most reliable company-site signal.
    const priv = html.match(/href="(https?:\/\/[^"]+)"[^>]*>\s*Privacy policy/i);
    let url = priv ? priv[1] : null;
    if (!url) {
        const ext = html.match(/href="(https?:\/\/(?!apps\.shopify\.com|www\.shopify\.com|help\.shopify\.com|cdn\.shopify\.com)[^"]+)"[^>]*>\s*(?:App documentation|Tutorial|FAQ)/i);
        url = ext ? ext[1] : null;
    }
    if (!url) return null;
    try {
        const host = new URL(url).hostname.replace(/^www\./, '').replace(/^(help|support|docs|academy|developers)\./, '');
        return `https://${host}`;
    } catch { return null; }
}

function rankHandle(h, kw) {
    if (h === kw) return 0;
    if (h.startsWith(`${kw}-`) || h.startsWith(kw)) return 1;
    return 2;
}

function pickEmail(s) {
    if (!s) return null;
    const e = decodeEntities(String(s)).toLowerCase().trim();
    if (!EMAIL_SHAPE.test(e)) return null;
    if (/noreply|no-reply|\.invalid$|@example\./i.test(e)) return null;
    return e;
}

function numOrNull(v) {
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function decodeEntities(s) {
    if (!s) return s;
    return String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 120) || null : null; }

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
