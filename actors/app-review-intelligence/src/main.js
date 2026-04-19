// Mobile App Review Intelligence
// Pulls reviews from iOS App Store (via Apple's public customer reviews RSS
// JSON feed) and Google Play Store (via google-play-scraper).
//
// Strategy:
//   1. For each input URL, detect platform by hostname.
//      apps.apple.com  -> iOS (extract numeric id from /id{N})
//      play.google.com -> Android (extract package from ?id=com.foo.bar)
//   2. iOS: loop over requested country storefronts. For each country,
//      page 1..10 of the RSS JSON feed. Feed entries[0] is the app
//      metadata block, entries[1..] are reviews.
//   3. Android: call gplay.reviews({appId, country, lang, sort, num}).
//      gplay paginates internally. Also fetch gplay.app() for metadata.
//   4. Normalize to the same shape and pushData.
//
// Free tier: first 100 reviews per run are free. After that charge per review.

import { Actor, log } from 'apify';
import gplay from 'google-play-scraper';

const FREE_TIER_REVIEWS = 100;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    appUrls,
    maxReviewsPerApp = 500,
    iosCountries = ['us'],
    androidCountry = 'us',
    androidLanguage = 'en',
    sortBy = 'NEWEST',
    filterByRating = [],
    proxyConfiguration: proxyInput,
} = input;

const starts = [];
if (Array.isArray(appUrls)) {
    for (const item of appUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) starts.push(u);
    }
}
if (starts.length === 0) {
    throw new Error('Provide appUrls. Example: https://apps.apple.com/us/app/instagram/id389801252');
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const validRatings = new Set(
    (Array.isArray(filterByRating) ? filterByRating : [])
        .map((r) => String(r).trim())
        .filter((r) => /^[1-5]$/.test(r)),
);

let totalPushed = 0;

for (const url of starts) {
    const platform = detectPlatform(url);
    if (!platform) {
        log.warning(`Unrecognized URL: ${url}`);
        continue;
    }

    if (platform === 'ios') {
        const appId = extractIosId(url);
        if (!appId) {
            log.warning(`Could not extract iOS id from ${url}`);
            continue;
        }
        await scrapeIos(appId, url);
    } else {
        const packageName = extractAndroidPackage(url);
        if (!packageName) {
            log.warning(`Could not extract Android package from ${url}`);
            continue;
        }
        await scrapeAndroid(packageName, url);
    }
}

log.info(`Run complete. Total reviews pushed: ${totalPushed}.`);
await Actor.exit();

// ---- helpers ----

function detectPlatform(url) {
    try {
        const host = new URL(url).hostname;
        if (host.includes('apps.apple.com') || host.includes('itunes.apple.com')) return 'ios';
        if (host.includes('play.google.com')) return 'android';
    } catch {}
    return null;
}

function extractIosId(url) {
    const m = url.match(/\/id(\d+)/);
    return m ? m[1] : null;
}

function extractAndroidPackage(url) {
    try {
        const u = new URL(url);
        return u.searchParams.get('id');
    } catch {
        return null;
    }
}

async function scrapeIos(appId, sourceUrl) {
    // Fetch app metadata once via iTunes Lookup API. The RSS feed's entry[0]
    // block is inconsistent across regions, so an explicit lookup is safer.
    let meta = null;
    try {
        const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}`;
        const res = await fetch(lookupUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.ok) {
            const data = await res.json();
            const r = Array.isArray(data?.results) ? data.results[0] : null;
            if (r) {
                meta = {
                    appName: r.trackName ?? null,
                    developer: r.artistName ?? null,
                    category: r.primaryGenreName ?? null,
                    price: r.price ?? null,
                    currency: r.currency ?? null,
                    contentRating: r.contentAdvisoryRating ?? null,
                };
            }
        }
    } catch (err) {
        log.warning(`iOS lookup failed for ${appId}: ${err?.message}`);
    }

    let pushedForApp = 0;

    for (const country of iosCountries) {
        if (pushedForApp >= maxReviewsPerApp) break;
        const countryCode = String(country).trim().toLowerCase() || 'us';

        for (let pageNum = 1; pageNum <= 10; pageNum++) {
            if (pushedForApp >= maxReviewsPerApp) break;

            const feedUrl = `https://itunes.apple.com/${countryCode}/rss/customerreviews/id=${appId}/sortBy=mostRecent/page=${pageNum}/json`;
            log.info(`iOS ${appId} ${countryCode} page ${pageNum}: ${feedUrl}`);

            let json;
            try {
                const res = await fetch(feedUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                        'Accept': 'application/json',
                    },
                });
                if (!res.ok) {
                    log.warning(`iOS feed ${countryCode} page ${pageNum} HTTP ${res.status}`);
                    break;
                }
                json = await res.json();
            } catch (err) {
                log.warning(`iOS feed ${countryCode} page ${pageNum} failed: ${err?.message}`);
                break;
            }

            const entries = json?.feed?.entry;
            if (!Array.isArray(entries) || entries.length === 0) break;

            // On page 1 Apple sometimes prepends an app metadata entry (has
            // im:name) before the actual reviews. Skip it when present.
            let startIdx = 0;
            if (pageNum === 1 && entries[0]?.['im:name'] && !entries[0]?.['im:rating']) {
                startIdx = 1;
            }

            const reviews = entries.slice(startIdx).map((e) => ({
                reviewId: e.id?.label ?? null,
                rating: Number(e['im:rating']?.label) || null,
                title: e.title?.label ?? null,
                text: e.content?.label ?? null,
                author: e.author?.name?.label ?? null,
                authorUrl: e.author?.uri?.label ?? null,
                appVersion: e['im:version']?.label ?? null,
                helpfulVotes: Number(e['im:voteCount']?.label) || 0,
                helpfulSum: Number(e['im:voteSum']?.label) || 0,
                updated: e.updated?.label ?? null,
                language: null,
                developerResponse: null,
                developerResponseDate: null,
            }));

            for (const r of reviews) {
                if (pushedForApp >= maxReviewsPerApp) break;
                if (validRatings.size > 0 && !validRatings.has(String(r.rating))) continue;

                await Actor.pushData({
                    ...r,
                    platform: 'ios',
                    appId,
                    appName: meta?.appName ?? null,
                    developer: meta?.developer ?? null,
                    appCategory: meta?.category ?? null,
                    country: countryCode,
                    sourceUrl,
                    scrapedAt: new Date().toISOString(),
                });
                pushedForApp++;
                totalPushed++;

                if (totalPushed > FREE_TIER_REVIEWS) {
                    await Actor.charge({ eventName: 'review_extracted' }).catch((err) => {
                        log.warning(`charge failed (continuing): ${err?.message}`);
                    });
                }
            }

            if (reviews.length < 40) break;
            // Small pause to stay polite to Apple's RSS endpoint.
            await new Promise((r) => setTimeout(r, 600));
        }
    }

    log.info(`iOS ${appId}: pushed ${pushedForApp} reviews across ${iosCountries.length} country(ies).`);
}

async function scrapeAndroid(packageName, sourceUrl) {
    // Fetch app metadata once so each review row carries appName + developer.
    let appInfo = null;
    try {
        appInfo = await gplay.app({ appId: packageName, country: androidCountry, lang: androidLanguage });
    } catch (err) {
        log.warning(`gplay.app failed for ${packageName}: ${err?.message}`);
    }

    const sortMap = {
        NEWEST: gplay.sort.NEWEST,
        MOST_RELEVANT: gplay.sort.HELPFULNESS,
        RATING: gplay.sort.RATING,
    };

    let result;
    try {
        result = await gplay.reviews({
            appId: packageName,
            country: androidCountry,
            lang: androidLanguage,
            sort: sortMap[sortBy] ?? gplay.sort.NEWEST,
            num: maxReviewsPerApp,
            paginate: false,
        });
    } catch (err) {
        log.error(`gplay.reviews failed for ${packageName}: ${err?.message}`);
        return;
    }

    const reviews = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
    log.info(`Android ${packageName}: ${reviews.length} reviews returned.`);

    let pushed = 0;
    for (const r of reviews) {
        if (pushed >= maxReviewsPerApp) break;
        const rating = Number(r.score) || null;
        if (validRatings.size > 0 && !validRatings.has(String(rating))) continue;

        await Actor.pushData({
            platform: 'android',
            reviewId: r.id ?? null,
            rating,
            title: r.title ?? null,
            text: r.text ?? null,
            author: r.userName ?? null,
            authorUrl: r.userImage ?? null,
            appVersion: r.version ?? null,
            helpfulVotes: Number(r.thumbsUp) || 0,
            helpfulSum: Number(r.thumbsUp) || 0,
            updated: r.date ? new Date(r.date).toISOString() : null,
            language: androidLanguage,
            developerResponse: r.replyText ?? null,
            developerResponseDate: r.replyDate ? new Date(r.replyDate).toISOString() : null,
            appId: packageName,
            appName: appInfo?.title ?? null,
            developer: appInfo?.developer ?? null,
            appCategory: appInfo?.genre ?? null,
            country: androidCountry,
            sourceUrl,
            scrapedAt: new Date().toISOString(),
        });
        pushed++;
        totalPushed++;

        if (totalPushed > FREE_TIER_REVIEWS) {
            await Actor.charge({ eventName: 'review_extracted' }).catch((err) => {
                log.warning(`charge failed (continuing): ${err?.message}`);
            });
        }
    }

    log.info(`Android ${packageName}: pushed ${pushed} reviews.`);
}
