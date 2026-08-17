// Website Contact Scraper: Emails, Phones & Social Profiles
//
// Strategy
// --------
// The buyer supplies a list of websites. For each site we fetch the homepage
// with plain HTTP, discover likely contact pages from its links (contact,
// about, impressum, support, team), fetch a few of those, and extract emails
// (mailto: + pattern match), phone numbers (tel: + conservative pattern), and
// social profile links (LinkedIn, Facebook, Instagram, X, YouTube, TikTok,
// GitHub) from all pages. One row per website. No browser, no proxy needed,
// no API key: these are the buyer's own target domains, fetched politely.
//
// Pay per event
// -------------
//   contact_row ($0.01) charged only when a site yields at least one email,
//   phone, or social profile. Unreachable or empty sites are free.
//   First 1 contact row per run is free so buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 1;
const HARD_CAP_SITES = 2000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 400000;
const CONCURRENCY = 10;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const PACKAGE_VERSION = /@\d+\.\d+/;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|(^|@|\.)(example|sentry|wixpress|yourdomain)\.|@(domain|email|company)\.|^(no-?reply|donotreply)@|@\dx\.|\.ingest\./i;
// Tracking/DSN keys look like emails with long hex local parts.
const HEX_LOCAL = /^[0-9a-f]{16,}@/i;
// On-page text matching is precision-first: explicit +intl, (xxx) xxx-xxxx, or
// dot/dash separated US formats. Space-separated digit runs are too noisy;
// anything else must come from a tel: link.
const PHONE_RE = /\+[1-9][0-9]{0,2}[0-9 ().\/\-]{6,16}[0-9]|\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}|\b\d{3}[.\-]\d{3}[.\-]\d{4}\b/g;
const CONTACT_LINK_RE = /contact|about|impressum|kontakt|support|team|legal|company/i;
const CONTACT_PATH_PRIORITY = ['contact', 'kontakt', 'impressum', 'about', 'support', 'team', 'legal', 'company'];

const SOCIAL_HOSTS = {
    linkedin: /(?:^|\.)linkedin\.com$/i,
    facebook: /(?:^|\.)facebook\.com$/i,
    instagram: /(?:^|\.)instagram\.com$/i,
    twitter: /(?:^|\.)(?:twitter|x)\.com$/i,
    youtube: /(?:^|\.)youtube\.com$/i,
    tiktok: /(?:^|\.)tiktok\.com$/i,
    github: /(?:^|\.)github\.com$/i,
};
// Share widgets, login pages, and platform plumbing are not profiles.
const SOCIAL_JUNK = /sharer|share\.php|\/share|\/intent|\/login|\/signup|\/oauth|\/plugins|\/embed|\/hashtag|\/search|\/help|\/legal|\/policies|\/privacy|^\/?$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    websites = [],
    maxPagesPerSite = 5,
    proxyConfiguration: proxyInput,
} = input;

const siteList = (Array.isArray(websites) ? websites : String(websites).split(/[\n,]/))
    .map((w) => String(w || '').trim()).filter(Boolean)
    .slice(0, HARD_CAP_SITES);
if (!siteList.length) {
    log.warning('Provide "websites": a list of domains or URLs, e.g. ["apify.com", "https://basecamp.com"].');
    await Actor.exit();
}
const pageCap = Math.max(1, Math.min(10, Number(maxPagesPerSite) || 5));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

function normalizeUrl(raw) {
    let s = String(raw).trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try { return new URL(s); } catch { return null; }
}

async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ContactScraper/1.0; +https://apify.com/scrapemint/website-contact-scraper)',
                Accept: 'text/html,application/xhtml+xml',
            },
            ...(dispatcher ? { dispatcher } : {}),
        });
        if (!res.ok || !(res.headers.get('content-type') || '').includes('text')) {
            return { ok: res.ok, finalUrl: res.url, html: '' };
        }
        const html = (await res.text()).slice(0, MAX_HTML_BYTES);
        return { ok: true, finalUrl: res.url, html };
    } catch {
        return { ok: false, finalUrl: url, html: '' };
    } finally {
        clearTimeout(timer);
    }
}

function addEmail(set, raw) {
    const e = String(raw).toLowerCase().trim().replace(/^mailto:/, '').split('?')[0];
    if (EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e) && !JUNK_EMAIL.test(e) && !HEX_LOCAL.test(e)) set.add(e);
}

function digits(s) { return s.replace(/[^0-9+]/g, ''); }

function extractFromHtml(html, baseUrl, found) {
    const $ = cheerio.load(html);
    for (const el of $('a[href]').toArray()) {
        const href = String($(el).attr('href') || '').trim();
        if (!href) continue;
        if (/^mailto:/i.test(href)) { addEmail(found.emails, decodeURIComponent(href)); continue; }
        if (/^tel:/i.test(href)) {
            const p = digits(decodeURIComponent(href.slice(4)));
            if (p.replace('+', '').length >= 7) found.phones.add(p);
            continue;
        }
        let u;
        try { u = new URL(href, baseUrl); } catch { continue; }
        for (const [network, hostRe] of Object.entries(SOCIAL_HOSTS)) {
            if (hostRe.test(u.hostname) && !SOCIAL_JUNK.test(u.pathname) && u.pathname.length > 1) {
                if (!found.socials[network]) found.socials[network] = `${u.origin}${u.pathname}`.replace(/\/$/, '');
            }
        }
    }
    for (const m of html.matchAll(EMAIL_RE)) addEmail(found.emails, m[0]);
    const text = $('body').text();
    for (const m of text.matchAll(PHONE_RE)) {
        const p = digits(m[0]);
        if (p.replace('+', '').length >= 8 && p.replace('+', '').length <= 15) found.phones.add(p);
    }
    return $;
}

function contactPageLinks($, baseUrl) {
    const candidates = new Map();
    for (const el of $('a[href]').toArray()) {
        const href = String($(el).attr('href') || '').trim();
        const label = `${href} ${$(el).text()}`;
        if (!CONTACT_LINK_RE.test(label)) continue;
        let u;
        try { u = new URL(href, baseUrl); } catch { continue; }
        if (u.hostname !== new URL(baseUrl).hostname) continue;
        if (!/^https?:$/.test(u.protocol)) continue;
        const clean = `${u.origin}${u.pathname}`;
        const rank = CONTACT_PATH_PRIORITY.findIndex((k) => u.pathname.toLowerCase().includes(k));
        candidates.set(clean, rank === -1 ? 99 : rank);
    }
    return [...candidates.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
}

// Prefer role inboxes on the site's own domain when picking the best email.
function pickBestEmail(emails, domain) {
    const list = [...emails];
    if (!list.length) return null;
    const score = (e) => {
        let s = 0;
        if (domain && e.endsWith(`@${domain}`)) s -= 10;
        if (/^(contact|info|hello|sales|support|hi|office|mail|team)@/.test(e)) s -= 5;
        return s;
    };
    return list.sort((a, b) => score(a) - score(b))[0];
}

async function processSite(raw) {
    const url = normalizeUrl(raw);
    if (!url) return { website: raw, reachable: false, error: 'invalid URL' };
    const found = { emails: new Set(), phones: new Set(), socials: {} };
    const pagesScanned = [];

    const home = await fetchHtml(url.href);
    if (!home.html) {
        return { website: raw, finalUrl: home.finalUrl, reachable: home.ok, pagesScanned };
    }
    pagesScanned.push(home.finalUrl);
    const $ = extractFromHtml(home.html, home.finalUrl, found);

    const extras = contactPageLinks($, home.finalUrl)
        .filter((u) => u !== home.finalUrl)
        .slice(0, pageCap - 1);
    for (const pageUrl of extras) {
        const page = await fetchHtml(pageUrl);
        if (!page.html) continue;
        pagesScanned.push(page.finalUrl);
        extractFromHtml(page.html, page.finalUrl, found);
    }

    const domain = new URL(home.finalUrl).hostname.replace(/^www\./, '');
    const emails = [...found.emails].slice(0, 20);
    return {
        website: raw,
        finalUrl: home.finalUrl,
        domain,
        reachable: true,
        emails,
        bestEmail: pickBestEmail(found.emails, domain),
        phones: [...found.phones].slice(0, 10),
        socials: Object.keys(found.socials).length ? found.socials : null,
        pagesScanned,
    };
}

const hasContacts = (r) => Boolean((r.emails && r.emails.length) || (r.phones && r.phones.length) || r.socials);

let totalRowsPushed = 0;
let chargeableRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData({ ...row, contactsFound: hasContacts(row), scrapedAt: new Date().toISOString() });
    totalRowsPushed += 1;
    if (hasContacts(row)) {
        chargeableRows += 1;
        if (chargeableRows > FREE_TIER_ROWS) {
            try {
                await Actor.charge({ eventName: 'contact_row' });
            } catch (err) {
                log.warning(`charge failed: ${err?.message}`);
            }
        }
    }
}

log.info(`Scanning ${siteList.length} website(s), up to ${pageCap} page(s) each.`);

let stopped = false;
for (let i = 0; i < siteList.length && !stopped; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        stopped = true;
        break;
    }
    const batch = siteList.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map((s) => processSite(s)));
    for (const row of rows) await flushRow(row);
    if ((i + CONCURRENCY) % 100 < CONCURRENCY) log.info(`Progress: ${Math.min(i + CONCURRENCY, siteList.length)}/${siteList.length} sites.`);
}

log.info(`Done. ${totalRowsPushed} site row(s), ${chargeableRows} with contacts; ${Math.max(0, chargeableRows - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
