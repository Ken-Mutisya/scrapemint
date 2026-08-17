// Steam Game Studio Lead Scraper
//
// Turns the Steam store into B2B leads. For each keyword it searches the keyless
// Steam store API, reads each game's details for the studio, publisher, and
// website, then scrapes the website for a contact email. Returns game, studio,
// publisher, website, email, genres, release date, price, and review count.
// One lead per game.
//
// Buyers: game-dev tool/middleware vendors, game marketing and PR agencies,
// localization, QA, and porting studios that sell to game developers.
//
// Steam's storesearch + appdetails are keyless. appdetails is rate-limited, so it
// is fetched gently; the website email scrape runs in a separate parallel pool.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_QUALIFIED = 1;
const SITE_FETCH_TIMEOUT_MS = 6000;
const STEAM_GAP_MS = 300; // be gentle with appdetails
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    country = 'us',
    language = 'en',
    maxLeads = 150,
    minReviews = 0,
    qualifiedMinReviews = 50,
    includeEmail = true,
    maxEmailLookups = 100,
    concurrency = 8,
} = input;

const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
if (cleanKeywords.length === 0) throw new Error('Provide at least one keyword, e.g. ["roguelike","city builder","horror"].');

const cc = String(country || 'us').trim().toLowerCase();
const lang = String(language || 'en').trim().toLowerCase();
const leadCap = Math.max(1, Math.min(2000, Number(maxLeads) || 150));
const minRev = Math.max(0, Number(minReviews) || 0);
const qualRev = Math.max(0, Number(qualifiedMinReviews) || 50);
const emailCap = Math.max(0, Math.min(2000, Number(maxEmailLookups) || 100));
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: search the store for app IDs ----------
const ids = [];
const seen = new Set();
for (const kw of cleanKeywords) {
    if (ids.length >= leadCap * 2) break;
    const data = await fetchJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(kw)}&cc=${cc}&l=${lang}`);
    const items = data?.items || [];
    let added = 0;
    for (const it of items) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id); ids.push(it.id); added += 1;
    }
    log.info(`search "${kw}": +${added} (total ${ids.length}).`);
}
if (ids.length === 0) { log.warning('No games matched.'); await Actor.exit(); }

// ---------- Stage 2: app details (throttled) ----------
log.info(`Fetching details for ${Math.min(ids.length, leadCap)} games (throttled).`);
const games = [];
for (const id of ids.slice(0, leadCap)) {
    const d = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=${cc}&l=${lang}`);
    await sleep(STEAM_GAP_MS);
    const entry = d?.[id];
    if (!entry?.success || !entry.data) continue;
    const a = entry.data;
    if (a.type && a.type !== 'game') continue;
    const reviews = a.recommendations?.total ?? null;
    if (minRev > 0 && (reviews || 0) < minRev) continue;
    games.push({
        appId: id,
        name: clean(a.name),
        studio: (a.developers || []).join(', ') || null,
        publisher: (a.publishers || []).join(', ') || null,
        website: webUrl(a.website),
        genres: (a.genres || []).map((g) => g.description).slice(0, 6),
        releaseDate: a.release_date?.date || null,
        price: a.is_free ? 'Free' : (a.price_overview?.final_formatted || null),
        reviews,
        steamUrl: `https://store.steampowered.com/app/${id}/`,
        headerImage: a.header_image || null,
    });
}
log.info(`${games.length} games after details + filters.`);
if (games.length === 0) { log.warning('No games passed filters.'); await Actor.exit(); }
games.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));

// ---------- Stage 3: scrape studio sites for emails ----------
if (includeEmail && emailCap > 0) {
    const targets = games.filter((g) => g.website).slice(0, emailCap);
    log.info(`Stage 3: scraping ${targets.length} studio sites for emails.`);
    await mapWithConcurrency(targets, pool, async (g) => {
        const domain = extractDomain(g.website);
        const { reachable, emails } = await fetchSite(g.website);
        g.websiteReachable = reachable;
        g.emails = emails;
        g.likelyContactEmails = inferContactEmails(domain, emails);
        if (reachable && domain) g.mxFound = await hasMx(domain);
        return g;
    });
}

// ---------- Stage 4: score, tier, push, charge ----------
log.info(`Scoring ${games.length} leads.`);
for (const g of games) {
    const hasEmail = (g.emails && g.emails.length) > 0;
    const revScore = scoreReviews(g.reviews);
    const contactScore = (hasEmail ? 28 : 0) + (g.website && g.websiteReachable ? 8 : (g.website ? 4 : 0));
    const recScore = recency(g.releaseDate);
    const leadScore = Math.min(100, Math.round(revScore + contactScore + recScore));

    const tier = (hasEmail && (g.reviews || 0) >= qualRev) ? 'qualified_lead'
        : (g.website ? 'lead' : 'listing');

    const row = {
        game: g.name,
        studio: g.studio,
        publisher: g.publisher,
        website: g.website || null,
        websiteReachable: g.websiteReachable ?? null,
        email: (g.emails && g.emails[0]) || null,
        emails: g.emails || [],
        likelyContactEmails: g.likelyContactEmails || [],
        genres: g.genres,
        releaseDate: g.releaseDate,
        price: g.price,
        reviews: g.reviews,
        steamUrl: g.steamUrl,
        appId: g.appId,
        tier,
        leadScore,
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(row);

    if (tier === 'qualified_lead') {
        if (qualifiedFree + qualifiedCharged < FREE_TIER_QUALIFIED) qualifiedFree += 1;
        else { await charge('qualified_lead'); qualifiedCharged += 1; }
    } else if (tier === 'lead') {
        await charge('lead'); leadCount += 1;
    } else {
        await charge('listing'); listingCount += 1;
    }
}

log.info(`Done. qualified_lead charged=${qualifiedCharged} free=${qualifiedFree}, lead=${leadCount}, listing=${listingCount}.`);
await Actor.exit();

// ---------- scoring ----------

function scoreReviews(n) {
    const v = n || 0;
    if (v >= 50_000) return 50;
    if (v >= 5_000) return 42;
    if (v >= 500) return 32;
    if (v >= 50) return 22;
    if (v >= 5) return 12;
    return v > 0 ? 5 : 0;
}

function recency(dateStr) {
    const ms = dateStr ? Date.parse(dateStr) : null;
    if (!ms) return 4;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 180) return 14;
    if (d <= 365 * 2) return 8;
    return 3;
}

// ---------- website email enrichment ----------

function extractDomain(urlOrHost) {
    if (!urlOrHost) return null;
    try {
        const u = String(urlOrHost).trim();
        const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
        return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
    } catch { return null; }
}

async function fetchSite(websiteUrl) {
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
            emails = extractEmailsFromHtml((await res.text()).slice(0, 300000));
        }
        return { reachable, emails };
    } catch { return { reachable: false, emails: [] }; }
}

async function hasMx(domain) {
    if (!domain) return false;
    try {
        const records = await Promise.race([
            dns.resolveMx(domain),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        return Array.isArray(records) && records.length > 0;
    } catch { return false; }
}

function extractEmailsFromHtml(html) {
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
        if (/@(?:sentry|wixpress|example|email|2x)\./i.test(e)) continue;
        set.add(e);
    }
    return [...set];
}

function inferContactEmails(domain, existing) {
    const set = new Set();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        if (typeof e !== 'string' || PACKAGE_VERSION.test(e) || !EMAIL_SHAPE.test(e)) continue;
        set.add(e.toLowerCase());
    }
    if (domain) for (const local of ['info', 'contact', 'hello', 'press']) set.add(`${local}@${domain}`);
    return [...set];
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

// ---------- shared ----------

function webUrl(u) {
    const s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    if (/steampowered\.com|steamcommunity\.com/i.test(s)) return null;
    return s;
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null; }

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(500 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-steam-leads/1.0', Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            return null;
        } catch (err) {
            if (i === attempts - 1) log.debug(`fetch failed ${url}: ${err?.message}`);
        }
    }
    return null;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
