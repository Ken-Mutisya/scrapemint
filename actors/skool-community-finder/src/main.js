// Skool Community Finder: Skool communities with the owner's name, bio,
// website and social links, plus members, price, rating and activity.
//
// Strategy
// --------
// skool.com is a Next.js site and every page carries its data in
// <script id="__NEXT_DATA__">.
//
//   1. Discovery: /discovery?q={search}&c={categoryId}&p={page} returns 30
//      communities a page, up to 1,000 per search (numGroups caps at 1000):
//      name, slug, description, members, price, rating and review count.
//   2. About page: /{slug}/about adds the owner (name, bio, website,
//      Instagram, YouTube, LinkedIn, X, Facebook, location), posts, courses,
//      modules, admins, members online and the landing-page text.
//
// No login, no key, no proxy. Tested from Apify on 2026-10-19.
//
// Pay per event
// -------------
//   community_row ($0.003) one community
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const BASE = 'https://www.skool.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CATEGORIES = {
    hobbies: '8a7678583d3246a1a1a0a4a994321146',
    music: 'f08071afbd9746b6adb83522451cd280',
    money: '2830789533b448d8812e7d5d661d776c',
    spirituality: 'ce77e1a8d5824d8497921368a9328dc0',
    tech: 'b1dae7402dda47a0b7aa51334474a158',
    health: 'e85018a1df484d5ea09c43c8b2764586',
    sports: 'ca063c42092041d5a8f48dd1903a1f3b',
    self_improvement: '5c00cc7aee1048588759b5504380917a',
    relationships: 'fd915e5fee4a496db1c82c527a33ef09',
};
const CONCURRENCY = 5;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchQueries = [],
    categories = [],
    communityUrls = [],
    price = 'any',
    minMembers = 0,
    maxMembers,
    includeOwner = true,
    maxCommunities = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const cap = Math.min(5000, Math.max(1, Number(maxCommunities) || 100));
const minM = Math.max(0, Number(minMembers) || 0);
const maxM = num(maxMembers);
const priceMode = ['free', 'paid'].includes(price) ? price : 'any';
const cats = list(categories).map((c) => c.toLowerCase()).filter((c) => CATEGORIES[c]);
const queries = list(searchQueries);
const slugs = list(communityUrls).map((u) => u.replace(/^https?:\/\/(www\.)?skool\.com\//i, '').split(/[/?#]/)[0]).filter(Boolean);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

async function nextData(path) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(BASE + path, {
                // Accept: text/html gets a 202 bot challenge; */* gets the page (2026-10-19)
                headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
                signal: AbortSignal.timeout(45_000),
            });
            if (r.status === 404) return null;
            if (r.status === 202 || r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const html = await r.text();
            const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (!m) throw new Error('no page data');
            return JSON.parse(m[1]).props?.pageProps ?? null;
        } catch (err) {
            last = err;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

const parse = (v) => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };
const clean = (s) => (s ? String(s).trim() || null : null);

function priceOf(meta) {
    const p = parse(meta?.displayPrice);
    if (!p || !p.amount) return { isPaid: false, priceUsd: 0, priceCurrency: null, billingInterval: null };
    return {
        isPaid: true,
        priceUsd: p.currency?.toLowerCase() === 'usd' ? p.amount / 100 : null,
        priceAmount: p.amount / 100,
        priceCurrency: (p.currency || '').toUpperCase() || null,
        billingInterval: p.recurring_interval || 'one-time',
    };
}

function fromDiscovery(g) {
    const grp = g.group || g;
    const m = grp.metadata || {};
    return {
        slug: grp.name,
        url: `${BASE}/${grp.name}`,
        name: m.displayName || grp.name,
        description: clean(m.description),
        members: num(m.totalMembers),
        ...priceOf(m),
        rating: num(m.reviewAverageRating),
        reviews: num(m.reviewCount),
        logoUrl: m.logoUrl || null,
        coverUrl: m.coverSmallUrl || null,
        createdAt: grp.createdAt || null,
        discoveryRank: g.rank ?? null,
    };
}

function about(pp, base) {
    const g = pp?.currentGroup;
    if (!g) return base;
    const m = g.metadata || {};
    const o = parse(m.owner) || {};
    const om = o.metadata || {};
    const links = parse(m.links)?.links || [];
    const row = base || { slug: g.name, url: `${BASE}/${g.name}`, name: m.displayName || g.name, description: clean(m.description), ...priceOf(m) };
    const products = pp.groupMembershipProducts || [];
    if (!base && products.length) {
        const p = products[0];
        const amount = num(p.amount ?? p.price ?? p.metadata?.amount);
        if (amount) Object.assign(row, { isPaid: true, priceAmount: amount / 100, priceCurrency: (p.currency || 'usd').toUpperCase(), priceUsd: (p.currency || 'usd').toLowerCase() === 'usd' ? amount / 100 : null, billingInterval: p.recurring_interval || p.interval || null });
    }
    return {
        ...row,
        members: num(m.totalMembers) ?? row.members,
        membersOnline: num(m.totalOnlineMembers),
        posts: num(m.totalPosts),
        admins: num(m.totalAdmins),
        courses: num(m.numCourses),
        modules: num(m.numModules),
        privacy: m.privacy === 1 ? 'private' : m.privacy === 0 ? 'public' : null,
        landingPageText: clean(m.lpDescription),
        communityLinks: links.filter((l) => l.public !== false).map((l) => ({ label: l.label, url: l.url })),
        ownerName: [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
        ownerUsername: o.name || null,
        ownerProfileUrl: o.name ? `${BASE}/@${o.name}` : null,
        ownerBio: clean(om.bio),
        ownerLocation: clean(om.location),
        ownerWebsite: clean(om.link_website),
        ownerInstagram: clean(om.link_instagram),
        ownerYoutube: clean(om.link_youtube),
        ownerLinkedin: clean(om.link_linkedin),
        ownerTwitter: clean(om.link_twitter),
        ownerFacebook: clean(om.link_facebook),
        ownerPhotoUrl: om.picture_profile || null,
        createdAt: row.createdAt || g.createdAt || null,
    };
}

function keep(row) {
    if (row.members != null && row.members < minM) return false;
    if (maxM != null && row.members != null && row.members > maxM) return false;
    if (priceMode === 'free' && row.isPaid) return false;
    if (priceMode === 'paid' && !row.isPaid) return false;
    return true;
}

// ---- 1. discovery ----
const found = new Map();
for (const s of slugs.slice(0, cap)) found.set(s, null); // named communities first
const perSearch = {};
const searches = [];
for (const q of queries.length ? queries : ['']) for (const c of cats.length ? cats : ['']) searches.push({ q, c });
if (!slugs.length || queries.length || cats.length) {
    for (const { q, c } of searches) {
        const label = [q || 'trending', c].filter(Boolean).join(' / ');
        let added = 0;
        for (let page = 1; page <= 34 && found.size < cap && !pastDeadline(); page++) {
            const qs = new URLSearchParams();
            if (q) qs.set('q', q);
            if (c) qs.set('c', CATEGORIES[c]);
            if (page > 1) qs.set('p', String(page));
            let pp;
            try { pp = await nextData(`/discovery${qs.size ? `?${qs}` : ''}`); } catch (err) { log.warning(`${label} p${page}: ${err.message}`); break; }
            const groups = pp?.groups || [];
            for (const g of groups) {
                const row = fromDiscovery(g);
                if (!row.slug || !keep(row)) continue;
                if (found.has(row.slug)) { if (found.get(row.slug) === null) found.set(row.slug, { ...row, foundBy: label }); continue; }
                row.foundBy = label;
                found.set(row.slug, row);
                added++;
                if (found.size >= cap) break;
            }
            if (groups.length < 30) break;
        }
        perSearch[label] = added;
        log.info(`${label}: ${added} communities.`);
    }
}

// ---- 2. about pages + output ----
let out = 0;
let failed = 0;
let stop = false;
const order = [...found.keys()];
let next = 0;
async function emit(row) {
    if (stop) return;
    await Actor.pushData(row);
    out++;
    try {
        const res = await Actor.charge({ eventName: 'community_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}
async function worker() {
    while (next < order.length && !stop && !pastDeadline()) {
        const slug = order[next++];
        let row = found.get(slug);
        if (includeOwner || !row) {
            try {
                const pp = await nextData(`/${slug}/about`);
                if (!pp?.currentGroup) { if (!row) { log.warning(`${slug}: not found`); continue; } } else row = about(pp, row);
            } catch (err) {
                failed++;
                if (failed <= 3) log.warning(`${slug}: ${err.message}`);
                if (!row) continue;
            }
            if (!found.get(slug) && !keep(row)) continue;
        }
        await emit(row);
        if (out % 50 === 0 && out) log.info(`${out}/${order.length} communities written.`);
    }
}
await Promise.all(Array.from({ length: includeOwner ? CONCURRENCY : 1 }, worker));
if (pastDeadline()) log.warning('Close to the run timeout; stopped early.');

if (!out) await Actor.pushData({ note: 'No Skool communities matched. Not charged.' });
await Actor.setValue('SUMMARY', { communities: out, perSearch, aboutPagesFailed: failed });
log.info(`Done: ${out} communities.`);
await Actor.exit();
