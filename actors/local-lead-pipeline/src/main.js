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

const mapsRun = await Actor.call(
    'scrapemint/google-maps-scraper',
    {
        searchQueries: dedupedQueries,
        maxPlacesPerQuery,
        maxPlacesTotal,
        scrapeReviews: scrapeReviewsForSentiment,
        maxReviewsPerPlace: scrapeReviewsForSentiment ? 5 : 0,
        scrapeImages: false,
        enrichFromWebsite: true,
        dedupe: true,
        proxyConfiguration: proxyInput,
    },
    { memory: 2048, build: 'latest' },
);

if (!mapsRun?.defaultDatasetId) {
    log.error('Maps stage returned no dataset. Aborting.');
    await Actor.exit();
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

const headReachable = async (websiteUrl) => {
    if (!websiteUrl) return false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(websiteUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        clearTimeout(timeout);
        return res.status < 500;
    } catch {
        return false;
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

let enrichedCharged = 0;
let basicCharged = 0;
let enrichedFree = 0;

for (const p of places) {
    const website = p.website || p.websiteUrl || null;
    const domain = extractDomain(website);

    const websiteReachable = website ? await headReachable(website) : false;
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

    const row = {
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
        likelyContactEmails: inferContactEmails(domain, p.emails),
        latitude: p.latitude ?? p.location?.lat ?? null,
        longitude: p.longitude ?? p.location?.lng ?? null,
        placeId: p.placeId || p.place_id || null,
        mapsUrl: p.url || p.mapsUrl || null,
        qualityTier,
        sourceQuery: p.searchQuery || p.query || null,
    };

    await Actor.pushData(row);

    if (qualityTier === 'enriched') {
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

log.info(`Done. enriched_charged=${enrichedCharged} enriched_free=${enrichedFree} basic=${basicCharged} total_rows=${places.length}`);

await Actor.exit();
