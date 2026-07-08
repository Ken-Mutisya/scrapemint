// Twitch Streamer Leads Scraper: Contacts by Game & Followers
//
// Strategy
// --------
// Query Twitch's public web GraphQL endpoint (the same keyless client id
// every anonymous browser visitor sends) three ways: live streamers per
// category, channel search per query, and direct logins. Filter by
// follower band, then enrich each channel with social links, partner
// status, and last broadcast, and extract the business email from the
// bio. One row per streamer.
//
// Pay per event
// -------------
//   streamer_contact_row ($0.015) per streamer pushed WITH a business
//   email found in the bio. streamer_row ($0.005) for all other rows.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';
import { ProxyAgent } from 'undici';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_CATEGORY = 20;
const ENRICH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 25000;
const GQL_URL = 'https://gql.twitch.tv/gql';
// Twitch's public web client id, sent by every anonymous visitor.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories = [],
    searchQueries = [],
    logins = [],
    minFollowers,
    maxFollowers,
    requireEmail = false,
    maxStreamers = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const cats = asList(categories);
const queries = asList(searchQueries);
const directLogins = asList(logins).map((l) => l.toLowerCase().replace(/^@/, ''));
const minF = Number.isFinite(Number(minFollowers)) && minFollowers != null ? Number(minFollowers) : null;
const maxF = Number.isFinite(Number(maxFollowers)) && maxFollowers != null ? Number(maxFollowers) : null;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxStreamers) || 50));

if (!cats.length && !queries.length && !directLogins.length) {
    log.warning('Provide at least one of "categories", "searchQueries", or "logins".');
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('twitch-seen') : null;
const seen = new Set();
if (seenStore) for (const l of (await seenStore.getValue('seen-logins')) || []) seen.add(String(l));

// The user() enrichment query trips Twitch's integrity check from
// datacenter IPs (browse and search pass). Route enrichment through
// residential proxy — responses are a few KB, so bandwidth cost is
// negligible. Native fetch ignores `agent`; undici dispatcher required.
let proxyDispatcher = null;
try {
    const proxyConf = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] });
    const proxyUrl = proxyConf ? await proxyConf.newUrl() : null;
    if (proxyUrl) proxyDispatcher = new ProxyAgent(proxyUrl);
} catch { /* local run without proxy access */ }

async function gql(query, { proxied = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(GQL_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            ...(proxied && proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
        });
        if (!res.ok) { log.warning(`Twitch GQL HTTP ${res.status}`); return null; }
        const d = await res.json();
        if (d.errors?.length) {
            const msg = d.errors[0]?.message;
            // Retry integrity failures once through residential proxy.
            if (!proxied && proxyDispatcher && /integrity/i.test(String(msg))) return gql(query, { proxied: true });
            log.warning(`Twitch GQL: ${msg}`);
            return null;
        }
        return d.data || null;
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
// Emails only — @handles without a TLD don't match.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function followerBandOk(n) {
    if (n == null) return minF == null && maxF == null;
    if (minF != null && n < minF) return false;
    if (maxF != null && n > maxF) return false;
    return true;
}

// --- collect candidates: { login, followers, description, language, liveViewers, matchedCategory, matchedQuery } ---
const candidates = new Map();
function addCandidate(c) {
    if (!c.login || seen.has(c.login) || candidates.has(c.login)) return;
    if (!followerBandOk(c.followers)) return;
    candidates.set(c.login, c);
}

// Candidates beyond the cap are wasted enrichment calls; collect a small buffer only.
const collectTarget = Math.min(HARD_CAP, cap * 2);

for (const cat of cats) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES_PER_CATEGORY && candidates.size < collectTarget; page++) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const after = cursor ? `, after: "${esc(cursor)}"` : '';
        const d = await gql(`query { game(name: "${esc(cat)}") { streams(first: ${PAGE_SIZE}${after}) { edges { cursor node { broadcaster { login displayName followers { totalCount } description } viewersCount language } } pageInfo { hasNextPage } } } }`);
        const game = d?.game;
        if (!game) { if (page === 0) log.warning(`Category "${cat}" not found — use the exact name shown on Twitch.`); break; }
        const edges = game.streams?.edges || [];
        for (const e of edges) {
            const b = e.node?.broadcaster;
            if (!b?.login) continue;
            addCandidate({
                login: b.login.toLowerCase(),
                displayName: b.displayName || null,
                followers: b.followers?.totalCount ?? null,
                description: b.description || null,
                language: e.node.language || null,
                liveViewers: e.node.viewersCount ?? null,
                matchedCategory: cat,
                matchedQuery: null,
            });
            cursor = e.cursor || cursor;
        }
        if (!edges.length || !game.streams?.pageInfo?.hasNextPage) break;
    }
    log.info(`Category "${cat}": ${candidates.size} candidate(s) so far.`);
}

for (const q of queries) {
    if (candidates.size >= collectTarget) break;
    if (deadlineMs && Date.now() > deadlineMs) break;
    const d = await gql(`query { searchFor(userQuery: "${esc(q)}", platform: "web") { channels { edges { item { ... on User { login displayName followers { totalCount } description } } } } } }`);
    const edges = d?.searchFor?.channels?.edges || [];
    for (const e of edges) {
        const u = e.item;
        if (!u?.login) continue;
        addCandidate({
            login: u.login.toLowerCase(),
            displayName: u.displayName || null,
            followers: u.followers?.totalCount ?? null,
            description: u.description || null,
            language: null,
            liveViewers: null,
            matchedCategory: null,
            matchedQuery: q,
        });
    }
    log.info(`Search "${q}": ${edges.length} channel(s), ${candidates.size} candidate(s) total.`);
}

for (const l of directLogins) {
    addCandidate({ login: l, displayName: null, followers: null, description: null, language: null, liveViewers: null, matchedCategory: null, matchedQuery: null });
}

log.info(`${candidates.size} candidate streamer(s), enriching up to ${cap}.`);

async function enrich(login) {
    const d = await gql(`query { user(login: "${esc(login)}") { login displayName description createdAt followers { totalCount } roles { isPartner isAffiliate } channel { socialMedias { name title url } } lastBroadcast { startedAt game { name } } } }`, { proxied: true });
    return d?.user || null;
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const list = [...candidates.values()];
outer:
for (let i = 0; i < list.length && rowsPushed < cap; i += ENRICH_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = list.slice(i, i + ENRICH_CONCURRENCY);
    const users = await Promise.all(batch.map((c) => enrich(c.login)));
    for (let j = 0; j < batch.length && rowsPushed < cap; j++) {
        const c = batch[j];
        const u = users[j];
        if (!u && !c.displayName) continue; // direct login that doesn't exist
        const followers = u?.followers?.totalCount ?? c.followers;
        if (!followerBandOk(followers)) continue;
        const description = u?.description ?? c.description ?? null;
        const businessEmail = description?.match(EMAIL_RE)?.[0] || null;
        if (requireEmail && !businessEmail) continue;
        const socials = (u?.channel?.socialMedias || []).map((s) => ({ title: s.title || s.name || null, url: s.url || null }));
        seen.add(c.login);
        await flushRow({
            login: c.login,
            url: `https://www.twitch.tv/${c.login}`,
            displayName: u?.displayName ?? c.displayName,
            followers,
            description,
            businessEmail,
            isPartner: u?.roles?.isPartner ?? null,
            isAffiliate: u?.roles?.isAffiliate ?? null,
            language: c.language,
            liveViewers: c.liveViewers,
            socialLinks: socials.length ? socials : null,
            accountCreatedAt: u?.createdAt || null,
            lastStreamedAt: u?.lastBroadcast?.startedAt || null,
            lastGame: u?.lastBroadcast?.game?.name || null,
            matchedCategory: c.matchedCategory,
            matchedQuery: c.matchedQuery,
            scrapedAt: new Date().toISOString(),
        }, businessEmail ? 'streamer_contact_row' : 'streamer_row');
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-logins', [...seen].slice(-300000));
}

log.info(`Done. ${rowsPushed} streamer row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
