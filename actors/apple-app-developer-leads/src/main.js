// Apple App Store Developer Lead Scraper
//
// Turns the iOS App Store into B2B leads. For each keyword it searches the keyless
// iTunes API, then scrapes each app's developer website for a contact email.
// Returns app name, seller, website, email, category, rating, review count, price,
// and last-update date. One lead per app.
//
// Buyers: app-tool/SDK vendors, ASO and mobile-marketing agencies, and ad networks
// that sell to iOS developers (pairs with the Google Play actor for full coverage).
//
// The iTunes Search API gives the seller website, ratings, and category. Apple
// does not publish the developer email directly, so the email is scraped from the
// seller website (100% of apps have a sellerUrl). Both stages are plain HTTP.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_QUALIFIED = 10;
const SITE_FETCH_TIMEOUT_MS = 6000;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    country = 'US',
    maxLeads = 200,
    maxPerKeyword = 100,
    minRatings = 0,
    qualifiedMinRatings = 50,
    includeEmail = true,
    maxEmailLookups = 80,
    concurrency = 8,
} = input;

const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
if (cleanKeywords.length === 0) throw new Error('Provide at least one keyword, e.g. ["invoice","meditation","crm"].');

const gl = String(country || 'US').trim().toLowerCase();
const leadCap = Math.max(1, Math.min(5000, Number(maxLeads) || 200));
const perKwCap = Math.max(1, Math.min(200, Number(maxPerKeyword) || 100));
const minR = Math.max(0, Number(minRatings) || 0);
const qualR = Math.max(0, Number(qualifiedMinRatings) || 50);
const emailCap = Math.max(0, Math.min(1000, Number(maxEmailLookups) || 80));
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: search the App Store ----------
const leads = [];
const seen = new Set();
for (const kw of cleanKeywords) {
    if (leads.length >= leadCap) break;
    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(kw)}&media=software&entity=software&limit=${perKwCap}&country=${gl}`);
    const results = data?.results || [];
    let added = 0;
    for (const r of results) {
        const id = r.trackId || r.bundleId;
        if (!id || seen.has(id)) continue;
        const ratings = numOrNull(r.userRatingCount);
        if (minR > 0 && (ratings || 0) < minR) continue;
        seen.add(id);
        leads.push({
            appId: r.trackId || null,
            bundleId: r.bundleId || null,
            name: clean(r.trackName),
            seller: clean(r.sellerName || r.artistName),
            website: webUrl(r.sellerUrl),
            category: r.primaryGenreName || null,
            genres: Array.isArray(r.genres) ? r.genres : [],
            ratings,
            rating: numOrNull(r.averageUserRating),
            price: r.formattedPrice || (r.price === 0 ? 'Free' : null),
            version: r.version || null,
            lastUpdated: r.currentVersionReleaseDate || null,
            lastUpdatedMs: r.currentVersionReleaseDate ? Date.parse(r.currentVersionReleaseDate) : null,
            appStoreUrl: r.trackViewUrl || null,
            artworkUrl: r.artworkUrl512 || r.artworkUrl100 || null,
        });
        added += 1;
        if (leads.length >= leadCap) break;
    }
    log.info(`search "${kw}": +${added} apps (total ${leads.length}).`);
}

if (leads.length === 0) { log.warning('No apps matched.'); await Actor.exit(); }
leads.sort((a, b) => (b.ratings || 0) - (a.ratings || 0));
const finalLeads = leads.slice(0, leadCap);

// ---------- Stage 2: scrape seller sites for emails ----------
if (includeEmail && emailCap > 0) {
    const targets = finalLeads.filter((l) => l.website).slice(0, emailCap);
    log.info(`Stage 2: scraping ${targets.length} seller websites for contact emails.`);
    await mapWithConcurrency(targets, pool, async (l) => {
        const domain = extractDomain(l.website);
        const { reachable, emails } = await fetchSite(l.website);
        l.websiteReachable = reachable;
        l.emails = emails;
        l.likelyContactEmails = inferContactEmails(domain, emails);
        if (reachable && domain) l.mxFound = await hasMx(domain);
        return l;
    });
}

// ---------- Stage 3: score, tier, push, charge ----------
log.info(`Scoring ${finalLeads.length} leads.`);
for (const l of finalLeads) {
    const hasEmail = (l.emails && l.emails.length) > 0;
    const ratingScore = scoreRatings(l.ratings);
    const recScore = recency(l.lastUpdatedMs);
    const contactScore = (hasEmail ? 25 : 0) + (l.website && l.websiteReachable ? 8 : (l.website ? 4 : 0));
    const leadScore = Math.min(100, Math.round(ratingScore + recScore + contactScore));

    const tier = (hasEmail && (l.ratings || 0) >= qualR) ? 'qualified_lead'
        : (l.website ? 'lead' : 'listing');

    const row = {
        name: l.name,
        seller: l.seller,
        website: l.website || null,
        websiteReachable: l.websiteReachable ?? null,
        email: (l.emails && l.emails[0]) || null,
        emails: l.emails || [],
        likelyContactEmails: l.likelyContactEmails || [],
        category: l.category,
        genres: l.genres,
        ratings: l.ratings,
        rating: l.rating,
        price: l.price,
        version: l.version,
        lastUpdated: l.lastUpdated,
        appStoreUrl: l.appStoreUrl,
        appId: l.appId,
        bundleId: l.bundleId,
        artworkUrl: l.artworkUrl,
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

function scoreRatings(n) {
    const v = n || 0;
    if (v >= 100_000) return 50;
    if (v >= 10_000) return 42;
    if (v >= 1_000) return 32;
    if (v >= 100) return 22;
    if (v >= 10) return 12;
    return v > 0 ? 5 : 0;
}

function recency(ms) {
    if (!ms) return 2;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 90) return 15;
    if (d <= 365) return 9;
    if (d <= 730) return 4;
    return 1;
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
    if (domain) for (const local of ['info', 'contact', 'hello', 'support']) set.add(`${local}@${domain}`);
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
    if (/apps\.apple\.com|itunes\.apple\.com/i.test(s)) return null; // store link, not the dev site
    return s;
}

function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null; }

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(300 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-ios-leads/1.0', Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`fetch failed ${url}: ${err?.message}`);
        }
    }
    return null;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
