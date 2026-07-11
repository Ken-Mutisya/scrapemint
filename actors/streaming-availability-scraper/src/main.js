// Streaming Availability Scraper: Where to Watch by Country
//
// Strategy
// --------
// JustWatch's public GraphQL endpoint (keyless): search each title once to
// resolve its JustWatch node id and metadata, then query that node's offers
// per requested country so every row refers to the same title. One row per
// title x country with normalized offers (service, stream/rent/buy, price,
// qualities, deep link) plus per-type service summaries. A row with zero
// offers is a real answer: the title is not watchable in that country.
//
// Pay per event
// -------------
//   title_country_row ($0.005) per pushed title x country row.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 150;
const GRAPHQL_URL = 'https://apis.justwatch.com/graphql';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    titles = [],
    countries = ['US'],
    resultsPerTitle = 1,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const titleList = asList(titles);
const countryList = [...new Set(asList(countries).map((c) => c.toUpperCase()))];
const perTitle = Math.max(1, Math.min(5, Number(resultsPerTitle) || 1));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

if (!titleList.length) {
    log.error('Provide at least one title in "titles", e.g. ["Breaking Bad", "Inception"].');
    await Actor.exit();
}
if (!countryList.length) {
    log.error('Provide at least one ISO country code in "countries", e.g. ["US", "GB", "DE"].');
    await Actor.exit();
}
log.info(`${titleList.length} title search(es) x ${countryList.length} country(ies), ${perTitle} match(es) per title, cap ${cap} row(s).`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(GRAPHQL_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            },
            body: JSON.stringify({ query, variables }),
        });
        if (!res.ok) {
            log.warning(`GraphQL HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (data.errors?.length) {
            log.warning(`GraphQL error: ${data.errors[0]?.message}`);
            return null;
        }
        return data.data;
    } catch (err) {
        log.warning(`GraphQL request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const CONTENT_FIELDS = `title originalReleaseYear fullPath posterUrl
    externalIds { imdbId tmdbId } genres { shortName }`;

const SEARCH_QUERY = `query($country: Country!, $q: String!, $first: Int!) {
    popularTitles(country: $country, first: $first, filter: { searchQuery: $q }) {
        edges { node {
            id objectType
            ... on Movie { content(country: $country, language: "en") { ${CONTENT_FIELDS} } }
            ... on Show { content(country: $country, language: "en") { ${CONTENT_FIELDS} } }
        } }
    }
}`;

const OFFERS_FRAGMENT = `offers(country: $country, platform: WEB) {
    monetizationType presentationType retailPriceValue currency standardWebURL
    package { clearName packageId }
}`;

const OFFERS_QUERY = `query($id: ID!, $country: Country!) {
    node(id: $id) {
        id
        ... on Movie { ${OFFERS_FRAGMENT} }
        ... on Show { ${OFFERS_FRAGMENT} }
    }
}`;

function normalizeOffers(rawOffers) {
    // JustWatch repeats one service offer per quality tier (SD/HD/4K);
    // collapse to one entry per service + monetization type.
    const byKey = new Map();
    for (const o of rawOffers || []) {
        const key = `${o.package?.packageId}:${o.monetizationType}`;
        const quality = String(o.presentationType || '').replace(/^_/, '') || null;
        const prev = byKey.get(key);
        if (prev) {
            if (quality && !prev.qualities.includes(quality)) prev.qualities.push(quality);
            if (prev.priceAmount == null && o.retailPriceValue != null) {
                prev.priceAmount = o.retailPriceValue;
                prev.priceCurrency = o.currency || prev.priceCurrency;
            }
        } else {
            byKey.set(key, {
                service: o.package?.clearName || null,
                monetizationType: o.monetizationType || null,
                priceAmount: o.retailPriceValue ?? null,
                priceCurrency: o.currency || null,
                qualities: quality ? [quality] : [],
                url: o.standardWebURL || null,
            });
        }
    }
    return [...byKey.values()];
}

const servicesOf = (offers, types) => [...new Set(
    offers.filter((o) => types.includes(o.monetizationType)).map((o) => o.service).filter(Boolean),
)];

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'title_country_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- resolve searches to title nodes (searched in the first country) ---
const searchCountry = countryList[0];
const matches = [];
for (const q of titleList) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const data = await gql(SEARCH_QUERY, { country: searchCountry, q, first: perTitle });
    const edges = data?.popularTitles?.edges || [];
    if (!edges.length) {
        log.warning(`No JustWatch match for "${q}".`);
        continue;
    }
    for (const { node } of edges) {
        if (!node?.id || !node.content) continue;
        matches.push({ searchQuery: q, node });
    }
    await sleep(REQUEST_GAP_MS);
}

if (!matches.length) {
    log.error('No titles matched. Check spelling or try broader titles.');
    await Actor.exit();
}
log.info(`${matches.length} matched title(s); querying offers in: ${countryList.join(', ')}.`);

const scrapedAt = new Date().toISOString();
outer:
for (const { searchQuery, node } of matches) {
    const c = node.content;
    for (const country of countryList) {
        if (rowsPushed >= cap) break outer;
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            break outer;
        }
        const data = await gql(OFFERS_QUERY, { id: node.id, country });
        await sleep(REQUEST_GAP_MS);
        if (!data?.node) {
            log.warning(`Offers query failed for "${c.title}" in ${country}; skipping.`);
            continue;
        }
        const offers = normalizeOffers(data.node.offers);
        await flushRow({
            searchQuery,
            title: c.title,
            type: node.objectType === 'SHOW' ? 'show' : 'movie',
            releaseYear: c.originalReleaseYear ?? null,
            imdbId: c.externalIds?.imdbId || null,
            tmdbId: c.externalIds?.tmdbId || null,
            genres: (c.genres || []).map((g) => g.shortName).filter(Boolean),
            country,
            available: offers.length > 0,
            streamingServices: servicesOf(offers, ['FLATRATE']),
            rentServices: servicesOf(offers, ['RENT']),
            buyServices: servicesOf(offers, ['BUY']),
            freeServices: servicesOf(offers, ['FREE', 'ADS', 'FAST']),
            offerCount: offers.length,
            offers,
            justwatchUrl: c.fullPath ? `https://www.justwatch.com${c.fullPath}` : null,
            posterUrl: c.posterUrl ? `https://images.justwatch.com${c.posterUrl}` : null,
            scrapedAt,
        });
    }
}

log.info(`Done. ${rowsPushed} title x country row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
