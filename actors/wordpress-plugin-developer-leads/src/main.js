// WordPress Plugin & Theme Developer Lead Scraper
//
// Turns the WordPress.org plugin and theme directories into B2B leads. For each
// keyword (or a browse list) it queries the official keyless WordPress.org API,
// and for every plugin or theme it returns the author, the author's company
// website, active installs, rating, downloads, and maintenance signals. It can
// then scrape the company website for a contact email. One lead per plugin/theme.
//
// Buyers: WordPress hosting, security/backup SaaS, page builders, dev-tool and
// agency vendors, and plugin/theme marketplaces that sell to WP developers.
//
// Stage 1 (keyless WordPress.org API): query_plugins / query_themes, paginated.
// Stage 2 (optional): scrape each top lead's website for a contact email, in a
//   bounded parallel pool.
// Stage 3: score lead quality (installs, recency, popularity, contactability),
//   tier qualified_lead / lead / listing, push, charge.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_QUALIFIED = 10;
const WP_PLUGINS = 'https://api.wordpress.org/plugins/info/1.2/';
const WP_THEMES = 'https://api.wordpress.org/themes/info/1.2/';
const SITE_FETCH_TIMEOUT_MS = 6000;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    type = 'plugins',
    browse = '',
    maxLeads = 25,
    maxPerKeyword = 100,
    minInstalls = 0,
    qualifiedMinInstalls = 1000,
    includeEmail = true,
    maxEmailLookups = 60,
    proxyConfiguration: proxyInput,
} = input;

const wantType = String(type || 'plugins').toLowerCase();
const doPlugins = wantType === 'plugins' || wantType === 'both';
const doThemes = wantType === 'themes' || wantType === 'both';
const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
const browseMode = String(browse || '').trim().toLowerCase();
if (cleanKeywords.length === 0 && !browseMode) {
    throw new Error('Provide at least one keyword (e.g. ["seo","backup"]) or a browse mode (popular / new / updated).');
}

const leadCap = Math.max(1, Math.min(5000, Number(maxLeads) || 200));
const perKwCap = Math.max(1, Math.min(500, Number(maxPerKeyword) || 100));
const minInst = Math.max(0, Number(minInstalls) || 0);
const qualMinInst = Math.max(0, Number(qualifiedMinInstalls) || 1000);
const emailCap = Math.max(0, Math.min(500, Number(maxEmailLookups) || 60));

// proxyConfiguration is accepted for parity but the WordPress.org API and most
// homepages need no proxy; created lazily only if provided.
if (proxyInput) { try { await Actor.createProxyConfiguration(proxyInput); } catch { /* ignore */ } }

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: collect plugins / themes ----------
const leads = [];
const seen = new Set();

if (doPlugins) await collect('plugin', WP_PLUGINS, 'plugins');
if (doThemes) await collect('theme', WP_THEMES, 'themes');

log.info(`Collected ${leads.length} unique leads after filters.`);
if (leads.length === 0) { log.warning('No plugins/themes matched. Nothing to score.'); await Actor.exit(); }
leads.sort((a, b) => (b.activeInstalls || 0) - (a.activeInstalls || 0) || (b.downloaded || 0) - (a.downloaded || 0));
const finalLeads = leads.slice(0, leadCap);

// ---------- Stage 2: email enrichment (optional) ----------
if (includeEmail && emailCap > 0) {
    const targets = finalLeads.filter((l) => l.website).slice(0, emailCap);
    log.info(`Stage 2: scraping ${targets.length} websites for contact emails.`);
    await mapWithConcurrency(targets, 10, async (l) => {
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
    const installScore = scoreInstalls(l.activeInstalls, l.numRatings);
    const recScore = recency(l.lastUpdatedMs);
    const popScore = scorePopularity(l.downloaded, l.numRatings, l.rating);
    const contactScore = scoreContact(l);
    const leadScore = Math.min(100, Math.round(installScore + recScore + popScore + contactScore));

    const hasEmail = (l.emails && l.emails.length) > 0;
    const tier = (hasEmail && (l.activeInstalls || 0) >= qualMinInst) ? 'qualified_lead'
        : (l.website ? 'lead' : 'listing');

    const row = {
        type: l.type,
        name: l.name,
        slug: l.slug,
        wpDirUrl: l.wpDirUrl,
        tier,
        leadScore,
        author: l.author,
        authorProfile: l.authorProfile,
        website: l.website || null,
        websiteReachable: l.websiteReachable ?? null,
        emails: l.emails || [],
        likelyContactEmails: l.likelyContactEmails || [],
        activeInstalls: l.activeInstalls ?? null,
        downloaded: l.downloaded ?? null,
        rating: l.rating ?? null,
        numRatings: l.numRatings ?? null,
        supportThreads: l.supportThreads ?? null,
        supportResolved: l.supportResolved ?? null,
        lastUpdated: l.lastUpdated || null,
        added: l.added || null,
        tags: l.tags || [],
        scoredAt: new Date().toISOString(),
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

log.info(`Done. qualified_lead charged=${qualifiedCharged} free=${qualifiedFree}, lead=${leadCount}, listing=${listingCount}. Total=${finalLeads.length}.`);
await Actor.exit();

// ---------- Stage 1 helpers ----------

async function collect(kind, apiBase, resultKey) {
    const queries = cleanKeywords.length ? cleanKeywords : [null]; // null => browse mode
    for (const kw of queries) {
        if (leads.length >= leadCap * 2) break;
        let added = 0;
        for (let page = 1; page <= 10 && added < perKwCap; page += 1) {
            const url = buildWpUrl(apiBase, kind, kw, page);
            const data = await fetchJson(url);
            const items = data?.[resultKey] || [];
            if (items.length === 0) break;
            for (const it of items) {
                if (added >= perKwCap) break;
                const lead = kind === 'plugin' ? normPlugin(it) : normTheme(it);
                if (!lead || !lead.slug || seen.has(`${kind}:${lead.slug}`)) continue;
                if (minInst > 0 && (lead.activeInstalls || 0) < minInst) continue;
                seen.add(`${kind}:${lead.slug}`);
                leads.push(lead);
                added += 1;
            }
            const pages = data?.info?.pages || 1;
            if (page >= pages) break;
        }
        log.info(`${kind} "${kw || browseMode}": +${added} (total ${leads.length}).`);
    }
}

function buildWpUrl(apiBase, kind, kw, page) {
    const action = kind === 'plugin' ? 'query_plugins' : 'query_themes';
    const params = [`action=${action}`, `request[per_page]=100`, `request[page]=${page}`];
    if (kw) params.push(`request[search]=${encodeURIComponent(kw)}`);
    else if (browseMode) params.push(`request[browse]=${encodeURIComponent(browseMode)}`);
    return `${apiBase}?${params.join('&')}`;
}

function normPlugin(p) {
    const slug = p.slug || null;
    return {
        type: 'plugin',
        name: clean(decodeEntities(p.name)),
        slug,
        wpDirUrl: slug ? `https://wordpress.org/plugins/${slug}/` : null,
        author: clean(stripTags(decodeEntities(p.author))),
        authorProfile: p.author_profile || null,
        website: cleanUrl(p.homepage),
        activeInstalls: numOrNull(p.active_installs),
        downloaded: numOrNull(p.downloaded),
        rating: numOrNull(p.rating),
        numRatings: numOrNull(p.num_ratings),
        supportThreads: numOrNull(p.support_threads),
        supportResolved: numOrNull(p.support_threads_resolved),
        lastUpdated: p.last_updated || null,
        lastUpdatedMs: parseWpDate(p.last_updated),
        added: p.added || null,
        tags: p.tags ? Object.values(p.tags).slice(0, 8) : [],
    };
}

function normTheme(t) {
    const slug = t.slug || null;
    const author = t.author || {};
    return {
        type: 'theme',
        name: clean(decodeEntities(t.name)),
        slug,
        wpDirUrl: slug ? `https://wordpress.org/themes/${slug}/` : null,
        author: clean(decodeEntities(author.author || author.display_name || author.user_nicename)),
        authorProfile: author.profile || null,
        website: cleanUrl(author.author_url),
        activeInstalls: numOrNull(t.active_installs),
        downloaded: null,
        rating: numOrNull(t.rating),
        numRatings: numOrNull(t.num_ratings),
        supportThreads: null,
        supportResolved: null,
        lastUpdated: t.last_updated || null,
        lastUpdatedMs: parseWpDate(t.last_updated),
        added: null,
        tags: t.tags ? Object.values(t.tags).slice(0, 8) : [],
    };
}

// ---------- Stage 2 helpers: website email enrichment ----------

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
        if (/@(?:sentry|wixpress|example|email|2x|wordpress)\./i.test(e)) continue;
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

// ---------- scoring ----------

function scoreInstalls(installs, numRatings) {
    const v = installs || 0;
    if (v >= 1_000_000) return 45;
    if (v >= 100_000) return 38;
    if (v >= 10_000) return 28;
    if (v >= 1_000) return 18;
    if (v >= 100) return 10;
    if (v > 0) return 5;
    // themes have no installs; fall back to rating volume
    return (numRatings || 0) >= 50 ? 12 : (numRatings || 0) >= 5 ? 6 : 0;
}

function scorePopularity(downloaded, numRatings, rating) {
    let s = 0;
    if ((downloaded || 0) >= 1_000_000) s += 10; else if ((downloaded || 0) >= 100_000) s += 6; else if ((downloaded || 0) >= 10_000) s += 3;
    if ((numRatings || 0) >= 100) s += 6; else if ((numRatings || 0) >= 10) s += 3;
    if ((rating || 0) >= 80) s += 4;
    return Math.min(20, s);
}

function scoreContact(l) {
    let s = 0;
    if (l.website && l.websiteReachable) s += 8; else if (l.website) s += 4;
    if ((l.emails || []).length > 0) s += 8;
    if (l.authorProfile) s += 2;
    return Math.min(20, s);
}

function recency(ms) {
    if (!ms) return 3;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 30) return 15;
    if (d <= 90) return 11;
    if (d <= 365) return 6;
    return 2;
}

// ---------- shared helpers ----------

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(300 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-wp-leads/1.0', Accept: 'application/json' } });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            log.warning(`WP API HTTP ${res.status} for ${url}`);
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`WP API fetch failed: ${err?.message}`);
        }
    }
    return null;
}

function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[,+]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function parseWpDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const p = Date.parse(s);
    return Number.isFinite(p) ? p : null;
}

function cleanUrl(u) {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return null;
    if (/^https?:\/\/(www\.)?wordpress\.org/i.test(s)) return null; // not a company site
    return s;
}

function stripTags(s) { return s ? String(s).replace(/<[^>]+>/g, '') : s; }

function decodeEntities(s) {
    if (!s) return s;
    return String(s)
        .replace(/&amp;/g, '&').replace(/&#8211;/g, '-').replace(/&#8217;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim() || null : null; }

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
