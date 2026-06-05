// Brand Reputation Pipeline
//
// Profiles a brand's reputation across independent public review platforms and
// joins them into one decision-ready row per brand.
//
// Stage 1: for each brand, call only the review children the buyer gave a URL
//          for, one URL per call so the whole child dataset belongs to that
//          brand (no fragile sourceUrl matching):
//            scrapemint/google-reviews-intelligence   (Google Maps reviews)
//            scrapemint/yelp-review-intelligence       (Yelp reviews)
//            scrapemint/trustpilot-brand-reputation    (Trustpilot reviews)
//            scrapemint/g2-reviews-scraper             (G2 product reviews)
// Stage 2: normalize every platform to a common shape (overall rating, claimed
//          review count, sampled mean, recent mean, negative share, text).
// Stage 3: synthesize per brand: a volume-weighted reputation score 0-100,
//          the cross-platform rating divergence (the review-gaming tell),
//          a recent-vs-overall trend, and the top recurring complaint and
//          praise themes pulled from the review text.
// Stage 4: tier as deep_profile / profile / single_source and charge.
//
// Nested billing: each review child also bills the buyer per review it pulls
// (review_extracted). The README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_DEEP = 1;

// Declared before the main loop: the loop calls synthesize() -> topTerms(),
// which closes over this set, and a `const` is in the temporal dead zone until
// its own line runs. Keeping it up here avoids a ReferenceError on the first
// brand that actually returns review data.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
    'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'who', 'did', 'its', 'let', 'put', 'say',
    'she', 'too', 'use', 'that', 'this', 'with', 'have', 'from', 'they', 'were', 'been', 'them', 'what', 'when',
    'will', 'your', 'just', 'than', 'then', 'very', 'into', 'over', 'also', 'some', 'more', 'most', 'such',
    'only', 'even', 'much', 'many', 'time', 'like', 'good', 'great', 'really', 'would', 'could', 'their', 'there',
    'about', 'which', 'after', 'before', 'because', 'product', 'service', 'company', 'review', 'reviews', 'star',
    'stars', 'thing', 'things', 'people', 'place', 'used', 'using', 'make', 'made', 'back', 'want', 'need', 'going',
    'got', 'lot', 'way', 'day', 'days', 'pros', 'cons',
]);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    brands = [],
    maxReviewsPerPlatform = 150,
    recentWindowDays = 90,
    proxyConfiguration: proxyInput,
} = input;

const perPlatformCap = Math.max(10, Math.min(2000, Number(maxReviewsPerPlatform) || 150));
const recentDays = Math.max(7, Math.min(730, Number(recentWindowDays) || 90));
const recentCutoff = Date.now() - recentDays * 864e5;

const cleanBrands = (Array.isArray(brands) ? brands : [])
    .map((b) => ({
        name: (b?.name || '').toString().trim(),
        googlePlaceUrl: (b?.googlePlaceUrl || '').toString().trim(),
        googleSearchQuery: (b?.googleSearchQuery || '').toString().trim(),
        yelpUrl: (b?.yelpUrl || '').toString().trim(),
        trustpilotUrl: (b?.trustpilotUrl || '').toString().trim(),
        g2Url: (b?.g2Url || '').toString().trim(),
    }))
    .filter((b) => b.name && (b.googlePlaceUrl || b.googleSearchQuery || b.yelpUrl || b.trustpilotUrl || b.g2Url))
    .slice(0, 25);

if (!cleanBrands.length) {
    log.warning('No usable brands in input. Each brand needs a name and at least one platform URL.');
    await Actor.exit();
}

let deepCharged = 0; let deepFree = 0; let profileCharged = 0; let singleCharged = 0; let emptyBrands = 0;

for (const brand of cleanBrands) {
    log.info(`Profiling "${brand.name}".`);
    const platforms = [];

    // ---------- Stage 1 + 2: pull each platform the brand has a URL for ----------
    if (brand.googlePlaceUrl || brand.googleSearchQuery) {
        const googleInput = brand.googlePlaceUrl
            ? { placeUrls: [{ url: brand.googlePlaceUrl }] }
            : { searchQueries: [brand.googleSearchQuery] };
        const rows = await callChild('scrapemint/google-reviews-intelligence', {
            ...googleInput,
            maxReviews: perPlatformCap,
            sortBy: 'NEWEST',
            proxyConfiguration: proxyInput,
        }, 'Google');
        const p = aggregateGoogle(rows);
        if (p) platforms.push(p);
    }

    if (brand.yelpUrl) {
        const rows = await callChild('scrapemint/yelp-review-intelligence', {
            businessUrls: [{ url: brand.yelpUrl }],
            maxReviews: perPlatformCap,
            sortBy: 'NEWEST_FIRST',
            language: 'ALL',
            proxyConfiguration: proxyInput,
        }, 'Yelp');
        const p = aggregateYelp(rows);
        if (p) platforms.push(p);
    }

    if (brand.trustpilotUrl) {
        const rows = await callChild('scrapemint/trustpilot-brand-reputation', {
            businessUrls: [{ url: brand.trustpilotUrl }],
            maxReviews: perPlatformCap,
            sortBy: 'NEWEST_FIRST',
            proxyConfiguration: proxyInput,
        }, 'Trustpilot');
        const p = aggregateTrustpilot(rows);
        if (p) platforms.push(p);
    }

    if (brand.g2Url) {
        const rows = await callChild('scrapemint/g2-reviews-scraper', {
            productUrls: [brand.g2Url],
            includeReviews: true,
            reviewsPerProduct: Math.min(50, perPlatformCap),
            includeFeatures: true,
            proxyConfiguration: proxyInput,
        }, 'G2');
        const p = aggregateG2(rows);
        if (p) platforms.push(p);
    }

    if (!platforms.length) {
        log.warning(`No platform returned data for "${brand.name}". Not charging.`);
        emptyBrands += 1;
        continue;
    }

    // ---------- Stage 3: synthesize the cross-platform profile ----------
    const row = synthesize(brand, platforms);

    const tier = row.tier;
    await Actor.pushData(row);

    if (tier === 'deep_profile') {
        if (deepFree + deepCharged < FREE_TIER_DEEP) deepFree += 1;
        else { await charge('deep_profile'); deepCharged += 1; }
    } else if (tier === 'profile') {
        await charge('profile'); profileCharged += 1;
    } else {
        await charge('single_source'); singleCharged += 1;
    }
}

log.info(
    `Done. deep charged=${deepCharged} free=${deepFree}, profile=${profileCharged}, `
    + `single_source=${singleCharged}, empty(no data)=${emptyBrands}.`,
);
await Actor.exit();

// ---------- platform normalizers ----------
// Common platform shape:
// { platform, sourceUrl, overallRating, claimedReviewCount, sampled,
//   sampledMean, recentMean, recentCount, negativeShare, posTexts[],
//   negTexts[], pros[], cons[] }

function aggregateGoogle(rows) {
    const reviews = rows
        .filter((r) => r && r.reviewId)
        .map((r) => ({
            rating: num(r.rating),
            text: str(r.text),
            date: parseDate(r.publishedAtDate || r.publishedAt || r.date),
        }));
    if (!reviews.length) return null;
    const meta = rows[0] || {};
    return buildPlatform('google', {
        sourceUrl: meta.sourceUrl || null,
        claimedRating: num(meta.businessAggregateRating),
        claimedCount: num(meta.businessReviewCount),
        reviews,
    });
}

function aggregateYelp(rows) {
    const reviews = rows
        .filter((r) => r)
        .map((r) => ({
            rating: num(r.rating),
            text: str(r.reviewText),
            date: parseDate(r.reviewDate),
        }))
        .filter((r) => r.rating !== null || r.text);
    if (!reviews.length) return null;
    const meta = rows[0] || {};
    return buildPlatform('yelp', {
        sourceUrl: meta.sourceUrl || null,
        claimedRating: num(meta.businessRating),
        claimedCount: num(meta.businessReviewCount),
        reviews,
    });
}

function aggregateTrustpilot(rows) {
    const reviews = rows
        .filter((r) => r)
        .map((r) => ({
            rating: num(r.rating),
            text: [str(r.title), str(r.text)].filter(Boolean).join('. '),
            date: parseDate(r.publishedDate || r.experiencedDate),
        }))
        .filter((r) => r.rating !== null || r.text);
    if (!reviews.length) return null;
    const meta = rows[0] || {};
    return buildPlatform('trustpilot', {
        sourceUrl: meta.sourceUrl || null,
        claimedRating: num(meta.businessOverallStars),
        claimedCount: num(meta.businessTotalReviews),
        reviews,
    });
}

function aggregateG2(rows) {
    // G2 child pushes one aggregate row per product.
    const product = rows.find((r) => r && (r.rating !== undefined || Array.isArray(r.reviews))) || rows[0];
    if (!product) return null;
    const reviews = (Array.isArray(product.reviews) ? product.reviews : []).map((r) => ({
        rating: num(r.rating),
        text: [str(r.title), str(r.pros), str(r.cons)].filter(Boolean).join('. '),
        date: parseDate(r.date),
    }));
    const p = buildPlatform('g2', {
        sourceUrl: product.url || product.reviewsUrl || null,
        claimedRating: num(product.rating),
        claimedCount: num(product.reviewCount),
        reviews,
    });
    if (!p && product.rating == null) return null;
    // Fold G2's pre-aggregated pros/cons in even when per-review text is thin.
    const base = p || buildEmptyPlatform('g2', {
        sourceUrl: product.url || product.reviewsUrl || null,
        claimedRating: num(product.rating),
        claimedCount: num(product.reviewCount),
    });
    base.pros.push(...(Array.isArray(product.topPros) ? product.topPros.map(str) : []).filter(Boolean));
    base.cons.push(...(Array.isArray(product.topCons) ? product.topCons.map(str) : []).filter(Boolean));
    return base;
}

function buildEmptyPlatform(platform, { sourceUrl, claimedRating, claimedCount }) {
    return {
        platform,
        sourceUrl: sourceUrl || null,
        overallRating: claimedRating ?? null,
        claimedReviewCount: claimedCount ?? null,
        sampled: 0,
        sampledMean: null,
        recentMean: null,
        recentCount: 0,
        negativeShare: null,
        posTexts: [],
        negTexts: [],
        pros: [],
        cons: [],
    };
}

function buildPlatform(platform, { sourceUrl, claimedRating, claimedCount, reviews }) {
    const rated = reviews.filter((r) => r.rating !== null && Number.isFinite(r.rating));
    if (!rated.length && !reviews.some((r) => r.text)) return null;

    const sampledMean = rated.length ? mean(rated.map((r) => r.rating)) : null;
    const recent = rated.filter((r) => r.date && r.date >= recentCutoff);
    const recentMean = recent.length ? mean(recent.map((r) => r.rating)) : null;
    const negativeShare = rated.length
        ? rated.filter((r) => r.rating <= 2).length / rated.length
        : null;

    const posTexts = reviews.filter((r) => (r.rating ?? 0) >= 4 && r.text).map((r) => r.text);
    const negTexts = reviews.filter((r) => r.rating !== null && r.rating <= 2 && r.text).map((r) => r.text);

    return {
        platform,
        sourceUrl: sourceUrl || null,
        overallRating: claimedRating ?? (sampledMean !== null ? round1(sampledMean) : null),
        claimedReviewCount: claimedCount ?? null,
        sampled: reviews.length,
        sampledMean: sampledMean !== null ? round2(sampledMean) : null,
        recentMean: recentMean !== null ? round2(recentMean) : null,
        recentCount: recent.length,
        negativeShare: negativeShare !== null ? round2(negativeShare) : null,
        posTexts,
        negTexts,
        pros: [],
        cons: [],
    };
}

// ---------- synthesis ----------

function synthesize(brand, platforms) {
    const rated = platforms.filter((p) => p.overallRating !== null && Number.isFinite(p.overallRating));

    // Volume-weighted reputation score 0-100. Weight by sqrt of the platform's
    // claimed review count (falls back to sampled) so a high-volume platform
    // counts more without letting one giant platform erase the others.
    let scoreNum = 0; let scoreDen = 0;
    let recentNum = 0; let overallNum = 0; let trendDen = 0;
    for (const p of rated) {
        const vol = Math.max(1, p.claimedReviewCount ?? p.sampled ?? 1);
        const w = Math.sqrt(Math.min(vol, 10000));
        scoreNum += (p.overallRating / 5) * 100 * w;
        scoreDen += w;
        if (p.recentMean !== null) {
            recentNum += p.recentMean * w;
            overallNum += p.overallRating * w;
            trendDen += w;
        }
    }
    const reputationScore = scoreDen ? Math.round(scoreNum / scoreDen) : null;

    // Cross-platform rating divergence: the spread between the best and worst
    // platform rating. A wide spread with real volume on both ends is the
    // classic review-gaming / channel-mismatch tell.
    let ratingDivergence = null; let divergenceFlag = false;
    if (rated.length >= 2) {
        const ratings = rated.map((p) => p.overallRating);
        ratingDivergence = round2(Math.max(...ratings) - Math.min(...ratings));
        divergenceFlag = ratingDivergence >= 0.8;
    }

    // Recent trend: volume-weighted recent mean vs overall.
    let recentDirection = 'unknown';
    let recentDelta = null;
    if (trendDen) {
        recentDelta = round2(recentNum / trendDen - overallNum / trendDen);
        recentDirection = recentDelta >= 0.15 ? 'improving' : recentDelta <= -0.15 ? 'declining' : 'stable';
    }

    // Themes from the pooled review text + G2's pre-aggregated pros/cons.
    const allNeg = platforms.flatMap((p) => [...p.negTexts, ...p.cons]);
    const allPos = platforms.flatMap((p) => [...p.posTexts, ...p.pros]);
    const complaints = topTerms(allNeg, 8);
    const praise = topTerms(allPos, 8);

    const platformsCovered = platforms.length;
    const tier = platformsCovered >= 3 ? 'deep_profile' : platformsCovered === 2 ? 'profile' : 'single_source';

    return {
        brand: brand.name,
        reputationScore,
        tier,
        platformsCovered,
        platformsList: platforms.map((p) => p.platform),
        ratingDivergence,
        divergenceFlag,
        recentTrend: { direction: recentDirection, delta: recentDelta },
        themes: { complaints, praise },
        platforms: platforms.map((p) => ({
            platform: p.platform,
            sourceUrl: p.sourceUrl,
            overallRating: p.overallRating,
            claimedReviewCount: p.claimedReviewCount,
            reviewsSampled: p.sampled,
            sampledMean: p.sampledMean,
            recentMean: p.recentMean,
            recentReviews: p.recentCount,
            negativeShare: p.negativeShare,
        })),
        scoredAt: new Date().toISOString(),
    };
}

// ---------- text -> themes ---------- (STOPWORDS is declared near the top)

function topTerms(texts, limit) {
    const counts = new Map();
    for (const t of texts) {
        const words = String(t || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
        const seen = new Set();
        for (let i = 0; i < words.length; i += 1) {
            const w = words[i];
            if (!seen.has(w)) { counts.set(w, (counts.get(w) || 0) + 1); seen.add(w); }
            // bigram for two-word themes (e.g. "customer support")
            if (i + 1 < words.length) {
                const bg = `${w} ${words[i + 1]}`;
                if (!seen.has(bg)) { counts.set(bg, (counts.get(bg) || 0) + 1); seen.add(bg); }
            }
        }
    }
    return [...counts.entries()]
        .filter(([term, c]) => c >= 2 || term.includes(' '))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([term, count]) => ({ term, count }));
}

// ---------- low-level helpers ----------

async function callChild(actorName, runInput, label) {
    try {
        const run = await Actor.call(actorName, runInput, { memory: 1024, build: 'latest' });
        if (!run?.defaultDatasetId) {
            log.warning(`${label} returned no dataset. Continuing.`);
            return [];
        }
        const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
        const items = (await ds.getData()).items ?? [];
        log.info(`${label}: ${items.length} rows.`);
        return items;
    } catch (err) {
        log.warning(`${label} stage failed (continuing without it): ${err?.message}`);
        return [];
    }
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
}

function parseDate(v) {
    if (!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}

function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
