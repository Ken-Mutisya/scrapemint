// Steam Game and Review Intelligence
// Pulls store metadata and the full review stream for any Steam title using
// Steam's own public JSON endpoints. No login, no key, no captcha.
//
// Strategy:
//   1. For each input, extract the numeric appId from the store URL
//      (store.steampowered.com/app/{id}/...) or accept a bare numeric id.
//   2. Fetch store metadata once via the public appdetails endpoint:
//      name, developers, publishers, genres, price, release date, metacritic.
//   3. Page the appreviews endpoint with Steam's opaque cursor. 100 reviews
//      per page. The first page also carries a query_summary block with the
//      review score and positive / negative totals.
//   4. Optionally enrich with a SteamSpy owners band and average playtime.
//   5. Normalize every review to one flat shape and pushData.
//
// Free tier: first 1 review per run is free. After that charge per review.

import { Actor, log } from 'apify';

const FREE_TIER_REVIEWS = 1;
const STORE_BASE = 'https://store.steampowered.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    appUrls,
    maxReviewsPerApp = 500,
    reviewLanguage = 'all',
    reviewType = 'all',
    purchaseType = 'all',
    sortBy = 'recent',
    dayRange = 365,
    includeSteamSpy = false,
    proxyConfiguration: proxyInput,
} = input;

const starts = [];
if (Array.isArray(appUrls)) {
    for (const item of appUrls) {
        const u = typeof item === 'string' ? item : item?.url;
        if (u) starts.push(String(u).trim());
    }
}
if (starts.length === 0) {
    throw new Error('Provide appUrls. Example: https://store.steampowered.com/app/570/Dota_2/ or just 570');
}

// Created for parity with the rest of the portfolio. Steam's public store and
// review endpoints serve datacenter IPs fine, so plain fetch is used below.
await Actor.createProxyConfiguration(proxyInput).catch(() => null);

let totalPushed = 0;

for (const entry of starts) {
    const appId = extractAppId(entry);
    if (!appId) {
        log.warning(`Could not extract a Steam app id from: ${entry}`);
        continue;
    }
    await scrapeApp(appId, entry);
}

log.info(`Run complete. Total reviews pushed: ${totalPushed}.`);
await Actor.exit();

// ---- helpers ----

function extractAppId(value) {
    if (/^\d+$/.test(value)) return value;
    const m = value.match(/\/app\/(\d+)/);
    if (m) return m[1];
    try {
        const u = new URL(value);
        const q = u.searchParams.get('appids') || u.searchParams.get('appid');
        if (q && /^\d+$/.test(q)) return q;
    } catch {}
    return null;
}

async function fetchJson(url, label) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            log.warning(`${label} HTTP ${res.status}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        log.warning(`${label} failed: ${err?.message}`);
        return null;
    }
}

async function fetchAppMeta(appId) {
    const url = `${STORE_BASE}/api/appdetails?appids=${appId}&cc=us&l=english`;
    const json = await fetchJson(url, `appdetails ${appId}`);
    const block = json?.[appId];
    if (!block?.success || !block?.data) return null;
    const d = block.data;
    return {
        appName: d.name ?? null,
        type: d.type ?? null,
        developer: Array.isArray(d.developers) ? d.developers.join(', ') : null,
        publisher: Array.isArray(d.publishers) ? d.publishers.join(', ') : null,
        genres: Array.isArray(d.genres) ? d.genres.map((g) => g.description).join(', ') : null,
        isFree: d.is_free ?? null,
        price: d.is_free ? 'Free' : (d.price_overview?.final_formatted ?? null),
        releaseDate: d.release_date?.date ?? null,
        comingSoon: d.release_date?.coming_soon ?? null,
        metacritic: d.metacritic?.score ?? null,
        requiredAge: d.required_age ?? null,
    };
}

async function fetchSteamSpy(appId) {
    const url = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;
    const json = await fetchJson(url, `steamspy ${appId}`);
    if (!json || json.appid === undefined) return null;
    return {
        ownersEstimate: json.owners ?? null,
        averagePlaytimeForeverMin: Number(json.average_forever) || null,
        medianPlaytimeForeverMin: Number(json.median_forever) || null,
        ccu: Number(json.ccu) || null,
    };
}

async function scrapeApp(appId, sourceUrl) {
    const meta = await fetchAppMeta(appId);
    let steamSpy = null;
    if (includeSteamSpy) {
        steamSpy = await fetchSteamSpy(appId);
        await sleep(1100); // SteamSpy asks for at most 1 request per second.
    }

    let cursor = '*';
    let seenCursors = new Set();
    let pushedForApp = 0;
    let summary = null;

    while (pushedForApp < maxReviewsPerApp) {
        const params = new URLSearchParams({
            json: '1',
            num_per_page: '100',
            filter: sortBy,
            language: reviewLanguage,
            review_type: reviewType,
            purchase_type: purchaseType,
            cursor,
        });
        if (sortBy === 'all') params.set('day_range', String(dayRange));

        const url = `${STORE_BASE}/appreviews/${appId}?${params.toString()}`;
        const json = await fetchJson(url, `appreviews ${appId}`);
        if (!json || json.success !== 1) break;

        if (!summary && json.query_summary) {
            summary = {
                reviewScore: json.query_summary.review_score ?? null,
                reviewScoreDesc: json.query_summary.review_score_desc ?? null,
                totalPositive: json.query_summary.total_positive ?? null,
                totalNegative: json.query_summary.total_negative ?? null,
                totalReviews: json.query_summary.total_reviews ?? null,
            };
        }

        const reviews = Array.isArray(json.reviews) ? json.reviews : [];
        if (reviews.length === 0) break;

        for (const r of reviews) {
            if (pushedForApp >= maxReviewsPerApp) break;
            const a = r.author ?? {};
            await Actor.pushData({
                platform: 'steam',
                appId,
                appName: meta?.appName ?? null,
                appType: meta?.type ?? null,
                developer: meta?.developer ?? null,
                publisher: meta?.publisher ?? null,
                genres: meta?.genres ?? null,
                isFree: meta?.isFree ?? null,
                price: meta?.price ?? null,
                releaseDate: meta?.releaseDate ?? null,
                metacritic: meta?.metacritic ?? null,
                appReviewScore: summary?.reviewScore ?? null,
                appReviewScoreDesc: summary?.reviewScoreDesc ?? null,
                appTotalPositive: summary?.totalPositive ?? null,
                appTotalNegative: summary?.totalNegative ?? null,
                appTotalReviews: summary?.totalReviews ?? null,
                ownersEstimate: steamSpy?.ownersEstimate ?? null,
                averagePlaytimeForeverMin: steamSpy?.averagePlaytimeForeverMin ?? null,
                concurrentPlayers: steamSpy?.ccu ?? null,
                reviewId: r.recommendationid ?? null,
                votedUp: r.voted_up ?? null,
                sentiment: r.voted_up === true ? 'positive' : (r.voted_up === false ? 'negative' : null),
                text: r.review ?? null,
                language: r.language ?? null,
                votesUp: Number(r.votes_up) || 0,
                votesFunny: Number(r.votes_funny) || 0,
                weightedVoteScore: r.weighted_vote_score != null ? Number(r.weighted_vote_score) : null,
                commentCount: Number(r.comment_count) || 0,
                steamPurchase: r.steam_purchase ?? null,
                receivedForFree: r.received_for_free ?? null,
                writtenDuringEarlyAccess: r.written_during_early_access ?? null,
                refunded: r.refunded ?? null,
                primarilySteamDeck: r.primarily_steam_deck ?? null,
                authorSteamId: a.steamid ?? null,
                authorName: a.personaname ?? null,
                authorProfileUrl: a.profile_url ?? null,
                authorNumGamesOwned: Number(a.num_games_owned) || null,
                authorNumReviews: Number(a.num_reviews) || null,
                playtimeForeverMin: Number(a.playtime_forever) || null,
                playtimeAtReviewMin: Number(a.playtime_at_review) || null,
                playtimeLastTwoWeeksMin: Number(a.playtime_last_two_weeks) || null,
                createdAt: r.timestamp_created ? new Date(r.timestamp_created * 1000).toISOString() : null,
                updatedAt: r.timestamp_updated ? new Date(r.timestamp_updated * 1000).toISOString() : null,
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

        const next = json.cursor;
        if (!next || seenCursors.has(next)) break; // Steam repeats the last cursor at the end.
        seenCursors.add(next);
        cursor = next;
        await sleep(500); // Stay polite to Steam's review endpoint.
    }

    log.info(`Steam ${appId} (${meta?.appName ?? 'unknown'}): pushed ${pushedForApp} reviews.`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
