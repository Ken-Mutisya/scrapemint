// Local Business Lead Pipeline
//
// Stage 1: Cross-join cities x categories into Google Maps queries (plus any
//          raw queries provided), then call scrapemint/google-maps-scraper as
//          a sub-actor to fetch places with phone, address, rating, reviews,
//          and any emails the Maps stage already extracted via website
//          enrichment.
// Stage 2: For each place, run cheap inline enrichment:
//            - root-domain extraction
//            - HTTP HEAD reachability check on the website
//            - DNS MX lookup on the domain
//            - email pattern inference (info@, contact@, hello@) when no
//              emails surfaced from the Maps stage
//            - recent-reviews sentiment count
// Stage 3: Score each row as enriched or basic and charge the correct event.
//          First N enriched_lead per run are free so buyers can validate.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_ENRICHED_LEADS = 5;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    cities = [],
    categories = [],
    searchQueries: rawQueries = [],
    maxPlacesPerQuery = 25,
    maxPlacesTotal = 100,
    minRating = 4.0,
    minReviews = 10,
    requireWebsite = true,
    scrapeReviewsForSentiment = true,
    proxyConfiguration: proxyInput,
} = input;

const queries = [...rawQueries];
for (const city of cities) {
    for (const cat of categories) {
        queries.push(`${cat} in ${city}`);
    }
}
const dedupedQueries = [...new Set(queries.map((q) => String(q).trim()).filter(Boolean))];

if (dedupedQueries.length === 0) {
    log.warning('No queries built. Provide either (cities + categories) or searchQueries.');
    await Actor.exit();
}

log.info(`Running ${dedupedQueries.length} Maps queries with maxPlacesTotal=${maxPlacesTotal}.`);

// enrichFromWebsite is OFF on purpose. The Maps child's per-site enrichment is
// the bottleneck that timed out every public run (~1 place/min on residential,
// so 25+ places never finished inside the hour). We do our own fast parallel
// website enrichment below instead. timeoutSecs caps the child so a slow or
// hung Maps run can never consume the parent's whole hour.
let mapsRun = null;
try {
    mapsRun = await Actor.call(
        'scrapemint/google-maps-scraper',
        {
            searchQueries: dedupedQueries,
            maxPlacesPerQuery,
            maxPlacesTotal,
            scrapeReviews: scrapeReviewsForSentiment,
            maxReviewsPerPlace: scrapeReviewsForSentiment ? 5 : 0,
            scrapeImages: false,
            enrichFromWebsite: false,
            dedupe: true,
            proxyConfiguration: proxyInput,
        },
        { memory: 2048, build: 'latest', timeout: 1500 },
    );
} catch (err) {
    log.warning(`Maps stage call error (continuing if a dataset exists): ${err?.message}`);
}

if (!mapsRun?.defaultDatasetId) {
    log.error('Maps stage returned no dataset. Nothing to enrich.');
    await Actor.exit();
}
if (mapsRun.status && mapsRun.status !== 'SUCCEEDED') {
    log.warning(`Maps stage status ${mapsRun.status}; enriching whatever places it produced.`);
}
log.info(`Maps stage finished. Reading places from dataset ${mapsRun.defaultDatasetId}.`);

const mapsDataset = await Actor.openDataset(mapsRun.defaultDatasetId, { forceCloud: true });
const places = (await mapsDataset.getData()).items ?? [];
log.info(`Got ${places.length} places. Enriching.`);

const extractDomain = (urlOrHost) => {
    if (!urlOrHost) return null;
    try {
        const u = String(urlOrHost).trim();
        const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
        const host = new URL(withProto).hostname.toLowerCase();
        return host.replace(/^www\./, '');
    } catch {
        return null;
    }
};

const SITE_FETCH_TIMEOUT_MS = 6000;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;

// GET the homepage once: confirms reachability AND pulls real contact emails in
// the same request. Replaces the Maps child's slow per-site enrichment.
const fetchSite = async (websiteUrl) => {
    if (!websiteUrl) return { reachable: false, emails: [] };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
        const res = await fetch(websiteUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadEnrich/1.0)' },
        });
        clearTimeout(timer);
        const reachable = res.status < 500;
        let emails = [];
        if (reachable && (res.headers.get('content-type') || '').includes('text')) {
            const html = (await res.text()).slice(0, 300000);
            emails = extractEmailsFromHtml(html);
        }
        return { reachable, emails };
    } catch {
        return { reachable: false, emails: [] };
    }
};

const hasMx = async (domain) => {
    if (!domain) return false;
    try {
        const records = await dns.resolveMx(domain);
        return Array.isArray(records) && records.length > 0;
    } catch {
        return false;
    }
};

const countNegativeReviews = (reviews) => {
    if (!Array.isArray(reviews)) return null;
    return reviews.slice(0, 5).filter((r) => typeof r?.rating === 'number' && r.rating <= 3).length;
};

const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

const inferContactEmails = (domain, existing) => {
    const set = new Set();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        if (typeof e !== 'string') continue;
        if (PACKAGE_VERSION.test(e)) continue;
        if (!EMAIL_SHAPE.test(e)) continue;
        set.add(e.toLowerCase());
    }
    if (domain) {
        for (const local of ['info', 'contact', 'hello']) set.add(`${local}@${domain}`);
    }
    return [...set];
};

// Pull real emails from page HTML: mailto: links first, then loose matches,
// filtering out asset filenames, package versions, and common false positives.
const extractEmailsFromHtml = (html) => {
    if (!html) return [];
    const set = new Set();
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
        const e = decodeURIComponent(m[1]).toLowerCase().trim();
        if (EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e)) set.add(e);
    }
    for (const m of html.matchAll(EMAIL_RE)) {
        const e = m[0].toLowerCase();
        if (!EMAIL_SHAPE.test(e) || PACKAGE_VERSION.test(e)) continue;
        if (/\.(png|jpe?g|gif|svg|webp|css|js|json|woff2?)$/i.test(e)) continue;
        if (/@(?:sentry|wixpress|example|email)\./i.test(e)) continue;
        set.add(e);
    }
    return [...set];
};

// Run an async mapper over items with a bounded number of workers, preserving
// input order in the result. Keeps website enrichment fast without flooding.
const mapWithConcurrency = async (items, limit, fn) => {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
};

let enrichedCharged = 0;
let basicCharged = 0;
let enrichedFree = 0;

// Stage 2: enrich every place in parallel (bounded). The slow parts (site GET,
// MX lookup) run concurrently here instead of one place at a time.
const enrichPlace = async (p) => {
    const website = p.website || p.websiteUrl || null;
    const domain = extractDomain(website);

    const { reachable: websiteReachable, emails: scrapedEmails } = website
        ? await fetchSite(website)
        : { reachable: false, emails: [] };
    const mxFound = websiteReachable ? await hasMx(domain) : false;
    const recentNegativeReviewCount = countNegativeReviews(p.reviews);

    const rating = typeof p.rating === 'number' ? p.rating : null;
    const reviewCount = typeof p.reviewCount === 'number' ? p.reviewCount : (typeof p.reviewsCount === 'number' ? p.reviewsCount : null);
    const phone = p.phone || p.phoneNumber || null;

    const passesRating = rating != null && rating >= minRating;
    const passesReviews = reviewCount != null && reviewCount >= minReviews;
    const passesWebsite = !requireWebsite || (websiteReachable && mxFound);
    const passesPhone = Boolean(phone);

    const qualityTier = (passesRating && passesReviews && passesWebsite && passesPhone) ? 'enriched' : 'basic';

    // Real emails scraped from the site, plus existing Maps emails and inferred
    // role addresses. scrapedEmails are the verified ones worth surfacing.
    const scrapedClean = scrapedEmails.filter((e) => EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e));
    const likelyContactEmails = inferContactEmails(domain, [
        ...(Array.isArray(p.emails) ? p.emails : []),
        ...scrapedClean,
    ]);

    return {
        name: p.name || p.title || null,
        category: p.category || p.categoryName || null,
        address: p.address || null,
        phone,
        rating,
        reviewCount,
        recentNegativeReviewCount,
        website,
        websiteReachable,
        domain,
        mxFound,
        scrapedEmails: scrapedClean,
        likelyContactEmails,
        latitude: p.latitude ?? p.location?.lat ?? null,
        longitude: p.longitude ?? p.location?.lng ?? null,
        placeId: p.placeId || p.place_id || null,
        mapsUrl: p.url || p.mapsUrl || null,
        qualityTier,
        sourceQuery: p.searchQuery || p.query || null,
    };
};

const rows = await mapWithConcurrency(places, 10, enrichPlace);

// Stage 3: push and charge sequentially so the free-tier accounting stays exact.
for (const row of rows) {
    await Actor.pushData(row);

    if (row.qualityTier === 'enriched') {
        if (enrichedCharged + enrichedFree < FREE_TIER_ENRICHED_LEADS) {
            enrichedFree++;
        } else {
            await Actor.charge({ eventName: 'enriched_lead' });
            enrichedCharged++;
        }
    } else {
        await Actor.charge({ eventName: 'basic_lead' });
        basicCharged++;
    }
}

log.info(`Done. enriched_charged=${enrichedCharged} enriched_free=${enrichedFree} basic=${basicCharged} total_rows=${rows.length}`);

await Actor.exit();
