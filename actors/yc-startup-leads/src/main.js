// Y Combinator Startup Lead Scraper
//
// Turns the YC company directory into B2B leads. Filter by keyword, batch,
// industry, or hiring status, then scrape each company website for a contact
// email. Returns company, website, one-liner, industry, team size, location,
// batch, and hiring flag. One lead per startup.
//
// Buyers: B2B SaaS selling to startups, recruiters (hiring filter), VCs and
// competitive intel, and sales teams targeting funded companies early.
//
// The directory is a keyless static JSON dataset (auto-synced from YC). Emails are
// scraped from the company website (99% of companies list one).
//
// Pay-per-event: qualified_lead $0.08, lead $0.04, listing $0.02.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_QUALIFIED = 1;
const DATA_URL = 'https://yc-oss.github.io/api/companies/all.json';
const SITE_FETCH_TIMEOUT_MS = 6000;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    batches = [],
    industries = [],
    onlyHiring = false,
    minTeamSize = 0,
    maxLeads = 25,
    includeEmail = true,
    maxEmailLookups = 100,
    concurrency = 8,
} = input;

const kw = (Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
const wantBatches = new Set((Array.isArray(batches) ? batches : [batches]).map((b) => String(b || '').trim().toLowerCase()).filter(Boolean));
const wantIndustries = (Array.isArray(industries) ? industries : [industries]).map((i) => String(i || '').trim().toLowerCase()).filter(Boolean);
const minTeam = Math.max(0, Number(minTeamSize) || 0);
const leadCap = Math.max(1, Math.min(6000, Number(maxLeads) || 200));
const emailCap = Math.max(0, Math.min(2000, Number(maxEmailLookups) || 100));
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: load + filter the YC directory ----------
log.info('Loading YC company directory...');
const all = await fetchJson(DATA_URL);
if (!Array.isArray(all) || all.length === 0) { log.error('Could not load YC directory.'); await Actor.exit(); }
log.info(`Directory has ${all.length} companies. Filtering.`);

const matchKw = (c) => {
    if (kw.length === 0) return true;
    const hay = `${c.name || ''} ${c.one_liner || ''} ${c.long_description || ''} ${c.industry || ''} ${c.subindustry || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
    return kw.some((k) => hay.includes(k));
};

let leads = all.filter((c) => {
    if (onlyHiring && !c.isHiring) return false;
    if (minTeam > 0 && (Number(c.team_size) || 0) < minTeam) return false;
    if (wantBatches.size > 0 && !wantBatches.has(String(c.batch || '').toLowerCase())) return false;
    if (wantIndustries.length > 0 && !wantIndustries.some((w) => `${c.industry || ''} ${c.subindustry || ''}`.toLowerCase().includes(w))) return false;
    return matchKw(c);
}).map(normCompany);

log.info(`${leads.length} companies match the filters.`);
if (leads.length === 0) { log.warning('No companies matched. Nothing to score.'); await Actor.exit(); }
// Rank: most recent batch first, then larger teams.
leads.sort((a, b) => (b.launchedMs || 0) - (a.launchedMs || 0) || (b.teamSize || 0) - (a.teamSize || 0));
leads = leads.slice(0, leadCap);

// ---------- Stage 2: scrape company sites for emails ----------
if (includeEmail && emailCap > 0) {
    const targets = leads.filter((l) => l.website).slice(0, emailCap);
    log.info(`Stage 2: scraping ${targets.length} company sites for contact emails.`);
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
log.info(`Scoring ${leads.length} leads.`);
for (const l of leads) {
    const hasEmail = (l.emails && l.emails.length) > 0;
    const teamScore = scoreTeam(l.teamSize);
    const recScore = recency(l.launchedMs);
    const signalScore = (l.isHiring ? 8 : 0) + (l.topCompany ? 6 : 0);
    const contactScore = (hasEmail ? 22 : 0) + (l.website && l.websiteReachable ? 8 : (l.website ? 4 : 0));
    const leadScore = Math.min(100, Math.round(teamScore + recScore + signalScore + contactScore));

    const tier = (hasEmail && ((l.teamSize || 0) >= 5 || l.isHiring)) ? 'qualified_lead'
        : (l.website ? 'lead' : 'listing');

    const row = {
        name: l.name,
        ycUrl: l.ycUrl,
        website: l.website || null,
        websiteReachable: l.websiteReachable ?? null,
        email: (l.emails && l.emails[0]) || null,
        emails: l.emails || [],
        likelyContactEmails: l.likelyContactEmails || [],
        oneLiner: l.oneLiner,
        industry: l.industry,
        subindustry: l.subindustry,
        batch: l.batch,
        teamSize: l.teamSize,
        location: l.location,
        tags: l.tags,
        isHiring: l.isHiring,
        topCompany: l.topCompany,
        launchedAt: l.launchedAt,
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

// ---------- normalize ----------

function normCompany(c) {
    const launchedMs = c.launched_at ? Number(c.launched_at) * 1000 : null;
    return {
        name: clean(c.name),
        ycUrl: c.slug ? `https://www.ycombinator.com/companies/${c.slug}` : null,
        website: webUrl(c.website),
        oneLiner: clean(c.one_liner),
        industry: c.industry || null,
        subindustry: c.subindustry || null,
        batch: c.batch || null,
        teamSize: Number(c.team_size) || null,
        location: c.all_locations || null,
        tags: Array.isArray(c.tags) ? c.tags.slice(0, 10) : [],
        isHiring: !!c.isHiring,
        topCompany: !!c.top_company,
        launchedAt: launchedMs ? new Date(launchedMs).toISOString().slice(0, 10) : null,
        launchedMs,
    };
}

// ---------- scoring ----------

function scoreTeam(n) {
    const v = n || 0;
    if (v >= 200) return 40;
    if (v >= 50) return 34;
    if (v >= 11) return 26;
    if (v >= 5) return 18;
    if (v >= 1) return 10;
    return 0;
}

function recency(ms) {
    if (!ms) return 4;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 365) return 22;
    if (d <= 365 * 3) return 14;
    if (d <= 365 * 6) return 7;
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
    if (domain) for (const local of ['info', 'contact', 'hello', 'team']) set.add(`${local}@${domain}`);
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
    if (/ycombinator\.com/i.test(s)) return null;
    return s;
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null; }

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(400 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-yc-leads/1.0', Accept: 'application/json' } });
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
