// Mobile App Review Intelligence
// Pulls reviews from iOS App Store (via the App Store web app's reviews API)
// and Google Play Store (via google-play-scraper).
//
// Strategy:
//   1. For each input URL, detect platform by hostname.
//      apps.apple.com  -> iOS (extract numeric id from /id{N})
//      play.google.com -> Android (extract package from ?id=com.foo.bar)
//   2. iOS: loop over requested country storefronts. For each country,
//      page through apps.apple.com/api/apps reviews, 20 per page, newest first.
//   3. Android: call gplay.reviews({appId, country, lang, sort, num}).
//      gplay paginates internally. Also fetch gplay.app() for metadata.
//   4. Normalize to the same shape and pushData.
//
// Free tier: first 2 reviews per run are free. After that charge per review.

import { Actor, log } from 'apify';
import gplay from 'google-play-scraper';

const FREE_TIER_REVIEWS = 2;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    maxReviewsPerApp = 500,
    iosCountries = ['us'],
    androidCountry = 'us',
    androidLanguage = 'en',
    sortBy = 'NEWEST',
    filterByRating = [],
} = input;

// API and AI-agent callers send startUrls / urls / appIds, a single string,
// or bare ids instead of appUrls. Throwing on those failed ~3 of 4 store runs.
const starts = [];
for (const key of ['appUrls', 'startUrls', 'urls', 'appIds', 'appUrl', 'url', 'appId']) {
    const v = input[key];
    for (const item of Array.isArray(v) ? v : (v ? [v] : [])) {
        const u = normalizeAppRef(typeof item === 'string' ? item : item?.url);
        if (u && !starts.includes(u)) starts.push(u);
    }
}
if (starts.length === 0) {
    const msg = 'No app given. Add appUrls, e.g. https://apps.apple.com/us/app/instagram/id389801252';
    log.error(msg);
    await Actor.exit({ statusMessage: msg });
}

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

// Turns a bare iOS id (389801252, id389801252) or Android package
// (com.instagram.android) into a store URL; passes real URLs through.
function normalizeAppRef(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^(apps|itunes|play)\./i.test(s)) return `https://${s}`;
    const ios = s.match(/^(?:id)?(\d{6,})$/i);
    if (ios) return `https://apps.apple.com/us/app/id${ios[1]}`;
    if (/^[a-z][\w]*(\.[\w]+)+$/i.test(s)) return `https://play.google.com/store/apps/details?id=${s}`;
    return s;
}

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
    // Fetch app metadata once via the iTunes Lookup API; the reviews API
    // rows carry no app name or developer.
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

        // Apple's customerreviews RSS feed went empty in Oct 2026. The App Store
        // web app reads reviews through this same-origin proxy of amp-api,
        // which needs no token but answers 429 under bursts, hence the backoff.
        for (let offset = 0; offset < 5000; offset += 20) {
            if (pushedForApp >= maxReviewsPerApp) break;

            const pageUrl = `https://apps.apple.com/api/apps/v1/catalog/${countryCode}/apps/${appId}/reviews`
                + `?l=en-US&offset=${offset}&limit=20&platform=web&additionalPlatforms=appletv,ipad,iphone,mac&sort=recent`;
            log.info(`iOS ${appId} ${countryCode} offset ${offset}`);

            const json = await fetchAppleJson(pageUrl);
            if (!json) {
                log.warning(`iOS ${appId} ${countryCode} offset ${offset}: no data, stopping this storefront.`);
                break;
            }

            const entries = Array.isArray(json.data) ? json.data : [];
            if (entries.length === 0) break;

            const reviews = entries.map((e) => {
                const a = e.attributes ?? {};
                return {
                    reviewId: e.id ?? null,
                    rating: Number(a.rating) || null,
                    title: a.title ?? null,
                    text: a.review ?? null,
                    author: a.userName ?? null,
                    authorUrl: null,
                    appVersion: null,
                    helpfulVotes: 0,
                    helpfulSum: 0,
                    updated: a.date ?? null,
                    language: null,
                    developerResponse: a.developerResponse?.body ?? null,
                    developerResponseDate: a.developerResponse?.modified ?? null,
                };
            });

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
                    await Actor.charge({ eventName: 'review_row' }).catch((err) => {
                        log.warning(`charge failed (continuing): ${err?.message}`);
                    });
                }
            }

            if (!json.next) break;
            await sleep(700);
        }
    }

    log.info(`iOS ${appId}: pushed ${pushedForApp} reviews across ${iosCountries.length} country(ies).`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchAppleJson(url) {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                    'Accept': 'application/json',
                    'Origin': 'https://apps.apple.com',
                },
            });
            if (res.status === 429 || res.status >= 500) {
                await sleep(2000 * 2 ** attempt);
                continue;
            }
            if (!res.ok) {
                log.warning(`Apple reviews HTTP ${res.status}`);
                return null;
            }
            return await res.json();
        } catch (err) {
            log.warning(`Apple reviews fetch failed: ${err?.message}`);
            await sleep(2000 * 2 ** attempt);
        }
    }
    return null;
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
            await Actor.charge({ eventName: 'review_row' }).catch((err) => {
                log.warning(`charge failed (continuing): ${err?.message}`);
            });
        }
    }

    log.info(`Android ${packageName}: pushed ${pushed} reviews.`);
}
