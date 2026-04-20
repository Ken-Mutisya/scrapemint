// Product Hunt Launch Tracker
// Polls Product Hunt's official GraphQL API for new launches, filters by
// topic, keyword, vote floor, comment count, and age, dedupes launch IDs
// across runs via a named key value store, and pushes only new matches.
//
// Auth: buyer pastes their own Product Hunt developer token. Tokens are
// created free at producthunt.com/v2/oauth/applications and never expire.
//
// Endpoint: https://api.producthunt.com/v2/api/graphql
// Docs:     https://api.producthunt.com/v2/docs
//
// Free tier: first 30 launches per run are free. After that charge per launch.

import { Actor, log } from 'apify';

const FREE_TIER_LAUNCHES = 30;
const GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';

const POSTED_WITHIN_HOURS = {
    HOUR_24: 24,
    DAY_7: 168,
    DAY_30: 720,
    ANY: null,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    developerToken,
    topics = [],
    keywords = [],
    sortBy = 'NEWEST',
    postedWithin = 'DAY_7',
    minVotes = 0,
    minComments = 0,
    featuredOnly = false,
    maxLaunchesPerTopic = 100,
    maxLaunchesTotal = 200,
    dedupe = true,
    proxyConfiguration: proxyInput,
} = input;

if (!developerToken || String(developerToken).trim() === '') {
    throw new Error('developerToken is required. Create one at https://www.producthunt.com/v2/oauth/applications');
}

const topicSlugs = (Array.isArray(topics) ? topics : [])
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);

const kwList = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);

const windowHours = POSTED_WITHIN_HOURS[postedWithin] ?? null;
const postedAfter = windowHours !== null
    ? new Date(Date.now() - windowHours * 3600 * 1000).toISOString()
    : null;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
if (proxyUrl) log.info('Routing GraphQL requests through Apify proxy.');

const store = await Actor.openKeyValueStore('producthunt-launch-tracker-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const VALID_ORDER = new Set(['NEWEST', 'VOTES', 'RANKING', 'FEATURED_AT']);
const order = VALID_ORDER.has(sortBy) ? sortBy : 'NEWEST';

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

const POST_QUERY = `
    query Posts($after: String, $order: PostsOrder, $topic: String, $featured: Boolean, $postedAfter: DateTime) {
      posts(first: 20, after: $after, order: $order, topic: $topic, featured: $featured, postedAfter: $postedAfter) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            name
            tagline
            description
            slug
            url
            website
            votesCount
            commentsCount
            reviewsCount
            createdAt
            featuredAt
            thumbnail { url type }
            topics(first: 10) { edges { node { id name slug } } }
            makers { id name username url headline }
          }
        }
      }
    }
`;

// Iterate one or many topics. If no topics given, do one global pass.
const sources = topicSlugs.length > 0 ? topicSlugs : [null];

for (const slug of sources) {
    if (totalPushed >= maxLaunchesTotal) break;
    await harvestTopic(slug);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Actor.exit();

// ---- helpers ----

async function harvestTopic(slug) {
    const label = slug ? `topic:${slug}` : 'global';
    let after = null;
    let pulled = 0;

    while (pulled < maxLaunchesPerTopic && totalPushed < maxLaunchesTotal) {
        const variables = {
            after,
            order,
            topic: slug,
            featured: featuredOnly ? true : null,
            postedAfter,
        };

        log.info(`Querying ${label} after=${after ?? 'null'}`);

        let json;
        try {
            json = await graphql(POST_QUERY, variables);
        } catch (err) {
            log.warning(`${label} GraphQL failed: ${err?.message}`);
            break;
        }

        const edges = json?.data?.posts?.edges;
        if (!Array.isArray(edges) || edges.length === 0) break;

        for (const edge of edges) {
            if (totalPushed >= maxLaunchesTotal) break;
            if (pulled >= maxLaunchesPerTopic) break;
            const node = edge?.node;
            if (!node?.id) continue;

            pulled += 1;
            totalSeen += 1;

            if (dedupe && seen.has(node.id)) { deduped += 1; continue; }
            if (minVotes > 0 && (node.votesCount || 0) < minVotes) { filteredOut += 1; continue; }
            if (minComments > 0 && (node.commentsCount || 0) < minComments) { filteredOut += 1; continue; }

            const title = node.name || '';
            const tagline = node.tagline || '';
            const description = node.description || '';
            let matchedKeywords = [];
            if (kwList.length > 0) {
                const hay = `${title}\n${tagline}\n${description}`.toLowerCase();
                matchedKeywords = kwList.filter((kw) => hay.includes(kw));
                if (matchedKeywords.length === 0) { filteredOut += 1; continue; }
            }

            await Actor.pushData({
                launchId: node.id,
                name: title,
                tagline,
                description,
                slug: node.slug,
                url: node.url,
                website: node.website,
                thumbnailUrl: node.thumbnail?.url || null,
                votesCount: node.votesCount ?? 0,
                commentsCount: node.commentsCount ?? 0,
                reviewsCount: node.reviewsCount ?? 0,
                createdAt: node.createdAt || null,
                featuredAt: node.featuredAt || null,
                topics: (node.topics?.edges || []).map((e) => ({
                    id: e.node?.id,
                    name: e.node?.name,
                    slug: e.node?.slug,
                })),
                makers: (node.makers || []).map((m) => ({
                    id: m.id,
                    name: m.name,
                    username: m.username,
                    url: m.url,
                    headline: m.headline,
                })),
                matchedKeywords,
                sourceTopic: slug,
                scrapedAt: new Date().toISOString(),
            });

            newSeen.add(node.id);
            totalPushed += 1;

            if (totalPushed > FREE_TIER_LAUNCHES) {
                Actor.charge({ eventName: 'launch_extracted' }).catch((err) => {
                    log.warning(`charge failed (continuing): ${err?.message}`);
                });
            }
        }

        const pageInfo = json?.data?.posts?.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        after = pageInfo.endCursor;
        await sleep(400);
    }

    log.info(`${label}: pulled ${pulled}, pushed so far ${totalPushed}`);
}

async function graphql(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${developerToken}`,
        },
        body: JSON.stringify({ query, variables }),
    });
    const bodyText = await res.text();
    let json;
    try { json = JSON.parse(bodyText); } catch {}

    if (Array.isArray(json?.errors) && json.errors.length) {
        const first = json.errors[0];
        if (first?.error === 'invalid_oauth_token') {
            throw new Error('Product Hunt rejected the developer token. Create a new one at https://www.producthunt.com/v2/oauth/applications');
        }
        const msg = first?.error_description || first?.message || JSON.stringify(first);
        throw new Error(`GraphQL error: ${msg}`);
    }

    if (!res.ok) {
        throw new Error(`GraphQL HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return json;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
