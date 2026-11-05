// Company Enrichment API: Domain to Company Data
//
// Strategy
// --------
// Domain in, one company profile out, built only from what the company
// publishes about itself:
//   1. Website: the homepage plus up to N about / contact / impressum / team
//      pages. Name, description, logo, language, founding year, address and
//      phone from JSON-LD Organization markup, meta tags and page text;
//      emails, phones and social profiles from links; tech stack from the
//      same signature set as our Website Tech Stack Detector.
//   2. DNS: MX (email provider), SPF includes and verification TXT records
//      (which SaaS tools the company has connected: HubSpot, Salesforce,
//      Zendesk, Atlassian, Stripe, Docusign...), DMARC policy.
//   3. RDAP: domain registration date, expiry and registrar.
// No API key, no proxy, no browser, no third-party database: every field
// is traceable to the company's own site or its public DNS.
//
// Pay per event
// -------------
//   company_enriched ($0.008) per domain where the website answered or DNS
//   returned records. Dead domains and invalid inputs are free.
//   First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import dns from 'node:dns';
import { SIGNATURES } from './signatures.js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 12000;
const HTML_CAP = 800000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    maxPagesPerSite = 4,
    includeTechStack = true,
    includeDnsInsights = true,
    includeDomainAge = true,
    maxRows = 1000,
} = input;

const pageCap = Math.max(1, Math.min(8, Number(maxPagesPerSite) || 4));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const raw = (Array.isArray(domains) ? domains : String(domains || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

function normalize(s) {
    let d = s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').split('@').pop().split(':')[0];
    d = d.replace(/^www\d?\./, '').replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && /[a-z]/.test(d.split('.').pop()) ? d : null;
}
const items = [];
const invalid = [];
const seenIn = new Set();
for (const s of raw) {
    const d = normalize(s);
    if (!d) { invalid.push(s); continue; }
    if (seenIn.has(d)) continue;
    seenIn.add(d);
    items.push({ input: s, domain: d });
    if (items.length >= cap) break;
}
if (!items.length) {
    await Actor.pushData({ note: 'Provide "domains": a list of company domains, websites or work emails, e.g. ["stripe.com", "https://www.notion.so", "jane@acme.com"]. Not charged.' });
    await Actor.exit();
}

// ---------- fetch helpers ----------
async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal, redirect: 'follow',
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        const headers = {};
        for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = String(v).toLowerCase();
        const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
            .map((c) => c.split('=')[0].trim().toLowerCase());
        const html = (headers['content-type'] || '').includes('html') ? (await res.text()).slice(0, HTML_CAP) : '';
        return { ok: res.ok, status: res.status, finalUrl: res.url || url, html, headers, setCookies };
    } catch (err) {
        return { ok: false, status: 0, finalUrl: url, html: '', headers: {}, setCookies: [], error: err?.name === 'AbortError' ? 'timeout' : err?.message };
    } finally {
        clearTimeout(timer);
    }
}

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rdap+json, application/json' } });
        return res.ok ? await res.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
}

// ---------- DNS ----------
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['8.8.8.8', '1.1.1.1']);
const safe = async (p) => { try { return await p; } catch { return []; } };

function emailProvider(mx) {
    const h = mx.join(' ');
    if (/google|googlemail/.test(h)) return 'Google Workspace';
    if (/outlook|protection\.microsoft/.test(h)) return 'Microsoft 365';
    if (/pphosted/.test(h)) return 'Proofpoint (gateway)';
    if (/mimecast/.test(h)) return 'Mimecast (gateway)';
    if (/barracuda/.test(h)) return 'Barracuda (gateway)';
    if (/zoho/.test(h)) return 'Zoho Mail';
    if (/messagingengine/.test(h)) return 'Fastmail';
    if (/protonmail/.test(h)) return 'Proton Mail';
    if (/secureserver/.test(h)) return 'GoDaddy';
    if (/titan/.test(h)) return 'Titan';
    if (/yandex/.test(h)) return 'Yandex';
    if (/amazonaws|awsapps/.test(h)) return 'Amazon WorkMail/SES';
    if (/registrar-servers|privateemail/.test(h)) return 'Namecheap';
    if (/ovh/.test(h)) return 'OVH';
    if (/ionos|1and1/.test(h)) return 'IONOS';
    return mx.length ? 'Other' : null;
}

// SPF include / TXT verification -> tool the company uses.
const TXT_TOOLS = [
    [/include:_spf\.google\.com|google-site-verification/, 'Google Workspace / Search Console'],
    [/spf\.protection\.outlook\.com|^ms=ms/, 'Microsoft 365'],
    [/hubspot|hs-?site-verification|hubspotemail/, 'HubSpot'],
    [/salesforce|_spf\.salesforce|pardot/, 'Salesforce'],
    [/sendgrid/, 'SendGrid'],
    [/mailgun/, 'Mailgun'],
    [/servers\.mcsv\.net|mandrillapp|mailchimp/, 'Mailchimp'],
    [/amazonses/, 'Amazon SES'],
    [/klaviyo/, 'Klaviyo'],
    [/zendesk/, 'Zendesk'],
    [/freshdesk|freshworks/, 'Freshworks'],
    [/intercom/, 'Intercom'],
    [/atlassian-domain-verification|atlassian/, 'Atlassian'],
    [/docusign/, 'DocuSign'],
    [/adobe-idp-site-verification|adobe-sign/, 'Adobe'],
    [/stripe-verification/, 'Stripe'],
    [/facebook-domain-verification/, 'Meta Business'],
    [/apple-domain-verification/, 'Apple'],
    [/zoom/, 'Zoom'],
    [/slack-domain-verification/, 'Slack'],
    [/dropbox-domain-verification/, 'Dropbox'],
    [/openai-domain-verification/, 'OpenAI'],
    [/anthropic-domain-verification/, 'Anthropic'],
    [/miro-verification/, 'Miro'],
    [/onetrust/, 'OneTrust'],
    [/postmark|mtasv\.net/, 'Postmark'],
    [/sparkpost/, 'SparkPost'],
    [/brevo|sendinblue/, 'Brevo'],
    [/zoho/, 'Zoho'],
    [/mailjet/, 'Mailjet'],
    [/shopify/, 'Shopify'],
    [/webex|cisco-ci-domain-verification/, 'Webex'],
    [/knowbe4/, 'KnowBe4'],
    [/globalsign|digicert|sectigo/, 'SSL certificate authority'],
    [/canva-site-verification/, 'Canva'],
    [/notion/, 'Notion'],
    [/gitlab/, 'GitLab'],
    [/github/, 'GitHub'],
    [/pinterest/, 'Pinterest'],
    [/yandex-verification/, 'Yandex'],
];

async function dnsInsights(domain) {
    const [mx, txt, dmarc] = await Promise.all([
        safe(resolver.resolveMx(domain)),
        safe(resolver.resolveTxt(domain)),
        safe(resolver.resolveTxt(`_dmarc.${domain}`)),
    ]);
    const mxHosts = mx.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
    const txtRecords = txt.map((parts) => parts.join('').toLowerCase());
    const tools = new Set();
    for (const t of txtRecords) for (const [re, name] of TXT_TOOLS) if (re.test(t)) tools.add(name);
    const spf = txtRecords.find((t) => t.startsWith('v=spf1')) || null;
    const dm = dmarc.map((p) => p.join('')).find((t) => /^v=dmarc1/i.test(t)) || null;
    return {
        mxHosts: mxHosts.slice(0, 5),
        emailProvider: emailProvider(mxHosts),
        saasToolsFromDns: [...tools].sort(),
        spfRecord: spf,
        dmarcPolicy: dm ? (dm.match(/p=([a-z]+)/i)?.[1]?.toLowerCase() || 'present') : null,
        hasRecords: mxHosts.length > 0 || txtRecords.length > 0,
    };
}

async function rdap(domain) {
    const d = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
    if (!d) return null;
    const ev = (a) => (d.events || []).find((e) => e.eventAction === a)?.eventDate || null;
    let registrar = null;
    for (const ent of d.entities || []) {
        if (!(ent.roles || []).includes('registrar')) continue;
        const fn = (ent.vcardArray?.[1] || []).find((v) => v[0] === 'fn');
        registrar = fn?.[3] || ent.handle || null;
    }
    return { createdAt: ev('registration'), expiresAt: ev('expiration'), registrar };
}

// ---------- page extraction ----------
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|(^|@|\.)(example|sentry|wixpress|yourdomain|domain|email|company|sentry-next)\.|^(no-?reply|donotreply)@|\.ingest\.|^[0-9a-f]{16,}@|@\d+x\./i;
const PHONE_RE = /\+[1-9][0-9]{0,2}[0-9 ().\/\-]{6,16}[0-9]|\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}|\b\d{3}[.\-]\d{3}[.\-]\d{4}\b/g;
const SOCIAL_HOSTS = {
    linkedin: /(?:^|\.)linkedin\.com$/i, x: /(?:^|\.)(?:twitter|x)\.com$/i, facebook: /(?:^|\.)facebook\.com$/i,
    instagram: /(?:^|\.)instagram\.com$/i, youtube: /(?:^|\.)youtube\.com$/i, tiktok: /(?:^|\.)tiktok\.com$/i,
    github: /(?:^|\.)github\.com$/i, crunchbase: /(?:^|\.)crunchbase\.com$/i, glassdoor: /(?:^|\.)glassdoor\.[a-z.]+$/i,
};
const SOCIAL_JUNK = /\/watch|\/results|sharer|share\.php|\/share|\/intent|\/login|\/signup|\/oauth|\/plugins|\/embed|\/hashtag|\/search|\/help|\/legal|\/policies|\/privacy|\/dialog|^\/?$/i;
const PAGE_LINK_RE = /about|company|contact|impressum|kontakt|team|who-we-are|uber-uns|ueber-uns|a-propos|quienes-somos|chi-siamo|legal-notice|imprint/i;

function jsonLdOrgs($) {
    const out = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        let parsed;
        try { parsed = JSON.parse($(el).contents().text().trim()); } catch { return; }
        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
            const n = stack.pop();
            if (!n || typeof n !== 'object') continue;
            if (n['@graph']) stack.push(...[].concat(n['@graph']));
            const t = [].concat(n['@type'] || []).join(' ');
            if (/Organization|Corporation|LocalBusiness|Store|Company|NGO|EducationalOrganization|Restaurant|Hotel|MedicalBusiness|LegalService|ProfessionalService/i.test(t)) out.push(n);
        }
    });
    return out;
}

function addEmail(set, e, domain) {
    e = String(e).toLowerCase().trim().replace(/^mailto:/, '').split('?')[0];
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || JUNK_EMAIL.test(e)) return;
    set.add(e);
}

function extractPage(html, baseUrl, acc, domain) {
    const $ = cheerio.load(html);
    for (const el of $('a[href]').toArray()) {
        const href = String($(el).attr('href') || '').trim();
        if (/^mailto:/i.test(href)) { try { addEmail(acc.emails, decodeURIComponent(href), domain); } catch { /* bad escape */ } continue; }
        if (/^tel:/i.test(href)) {
            const p = href.slice(4).replace(/[^0-9+]/g, '');
            if (p.replace('+', '').length >= 7) acc.phones.add(p);
            continue;
        }
        let u;
        try { u = new URL(href, baseUrl); } catch { continue; }
        for (const [net, re] of Object.entries(SOCIAL_HOSTS)) {
            if (re.test(u.hostname) && !SOCIAL_JUNK.test(u.pathname) && !acc.socials[net]) {
                acc.socials[net] = `${u.origin}${u.pathname}`.replace(/\/$/, '');
            }
        }
        const label = `${href} ${$(el).text()}`;
        if (PAGE_LINK_RE.test(label) && u.hostname.replace(/^www\./, '') === domain && /^https?:$/.test(u.protocol)) {
            acc.pageLinks.add(`${u.origin}${u.pathname}`);
        }
    }
    for (const m of html.matchAll(EMAIL_RE)) addEmail(acc.emails, m[0], domain);
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ');
    for (const m of text.matchAll(PHONE_RE)) {
        const p = m[0].replace(/[^0-9+]/g, '');
        if (p.replace('+', '').length >= 8 && p.replace('+', '').length <= 15) acc.phones.add(p);
    }
    const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1])).filter((y) => y > 1990 && y < 2100);
    if (years.length) acc.copyrightYear = Math.max(acc.copyrightYear || 0, ...years);
    const founded = text.match(/\b(?:founded|established|since|gegründet|fondée? en|fundada en)\s+(?:in\s+)?((?:18|19|20)\d{2})\b/i);
    if (founded && !acc.foundedTextYear) acc.foundedTextYear = Number(founded[1]);
    return $;
}

const metaContent = ($, sel) => {
    const v = $(sel).attr('content');
    return v ? v.trim() || null : null;
};

function detectTech(res) {
    const html = res.html.toLowerCase();
    const found = [];
    for (const sig of SIGNATURES) {
        let hit = false;
        if (sig.html) hit = sig.html.some((p) => html.includes(p));
        if (!hit && sig.header) hit = sig.header.some(([h, p]) => res.headers[h] !== undefined && (p === '' || res.headers[h].includes(p)));
        if (!hit && sig.cookie) hit = sig.cookie.some((p) => res.setCookies.some((c) => c.includes(p)));
        if (hit) found.push({ name: sig.name, category: sig.category });
    }
    return found;
}

const CC_TLD = { uk: 'GB', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', be: 'BE', ch: 'CH', at: 'AT', se: 'SE', no: 'NO', dk: 'DK', fi: 'FI', pl: 'PL', pt: 'PT', ie: 'IE', au: 'AU', nz: 'NZ', ca: 'CA', in: 'IN', jp: 'JP', br: 'BR', mx: 'MX', za: 'ZA', sg: 'SG', ke: 'KE', ng: 'NG', ae: 'AE', il: 'IL', tr: 'TR', cz: 'CZ', ro: 'RO', gr: 'GR', hu: 'HU', ar: 'AR', cl: 'CL', co: 'CO', kr: 'KR', cn: 'CN', hk: 'HK', tw: 'TW', my: 'MY', ph: 'PH', id: 'ID', vn: 'VN', th: 'TH' };

function cleanName(title, domain) {
    if (!title) return null;
    const parts = title.split(/\s+[|\-–—:·•]\s+/).map((s) => s.trim()).filter(Boolean);
    const root = domain.split('.')[0].replace(/-/g, '');
    const hit = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(root) || root.includes(p.toLowerCase().replace(/[^a-z0-9]/g, '')));
    return (hit || parts[parts.length > 1 ? parts.length - 1 : 0]).slice(0, 120);
}

function bestEmail(emails, domain) {
    const list = [...emails];
    const score = (e) => {
        let s = 0;
        if (e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`)) s -= 10;
        if (/^(info|hello|contact|sales|team|office|hi|enquiries|inquiries|mail)@/.test(e)) s -= 3;
        if (/^(support|help|privacy|legal|abuse|security|jobs|careers|press)@/.test(e)) s += 2;
        return s;
    };
    return list.sort((a, b) => score(a) - score(b))[0] || null;
}

async function enrich(it) {
    const { domain } = it;
    const tasks = [
        (async () => {
            let home = await fetchHtml(`https://${domain}/`);
            if (!home.html) {
                const alt = await fetchHtml(`https://www.${domain}/`);
                if (alt.html) home = alt;
                else if (!home.ok) {
                    const plain = await fetchHtml(`http://${domain}/`);
                    if (plain.html) home = plain;
                }
            }
            return home;
        })(),
        includeDnsInsights ? dnsInsights(domain) : null,
        includeDomainAge ? rdap(domain) : null,
    ];
    const [home, dnsInfo, reg] = await Promise.all(tasks);
    const acc = { emails: new Set(), phones: new Set(), socials: {}, pageLinks: new Set(), copyrightYear: null, foundedTextYear: null };
    let $ = null;
    let orgs = [];
    const pagesScanned = [];
    if (home.html) {
        pagesScanned.push(home.finalUrl);
        $ = extractPage(home.html, home.finalUrl, acc, domain);
        orgs = jsonLdOrgs(cheerio.load(home.html));
        const extra = [...acc.pageLinks]
            .filter((u) => u !== home.finalUrl)
            .sort((a, b) => (/contact|impressum|kontakt|imprint/i.test(a) ? 0 : 1) - (/contact|impressum|kontakt|imprint/i.test(b) ? 0 : 1))
            .slice(0, pageCap - 1);
        for (const url of extra) {
            const p = await fetchHtml(url);
            if (!p.html) continue;
            pagesScanned.push(p.finalUrl);
            extractPage(p.html, p.finalUrl, acc, domain);
            if (!orgs.length) orgs = jsonLdOrgs(cheerio.load(p.html));
        }
    }

    const org = orgs.find((o) => o.name) || orgs[0] || {};
    const addr = [].concat(org.address || [])[0];
    const address = addr && typeof addr === 'object' ? {
        street: addr.streetAddress || null,
        city: addr.addressLocality || null,
        region: addr.addressRegion || null,
        postalCode: addr.postalCode || null,
        country: typeof addr.addressCountry === 'object' ? addr.addressCountry?.name || null : addr.addressCountry || null,
    } : null;
    if (org.telephone) acc.phones.add(String(org.telephone).replace(/[^0-9+]/g, ''));
    if (org.email) addEmail(acc.emails, org.email, domain);
    for (const s of [].concat(org.sameAs || [])) {
        let u;
        try { u = new URL(s); } catch { continue; }
        for (const [net, re] of Object.entries(SOCIAL_HOSTS)) if (re.test(u.hostname) && !acc.socials[net]) acc.socials[net] = s.replace(/\/$/, '');
    }

    const title = $ ? $('title').first().text().replace(/\s+/g, ' ').trim() : null;
    const ogSite = $ ? metaContent($, 'meta[property="og:site_name"]') : null;
    const name = (typeof org.name === 'string' && org.name.trim()) || ogSite || cleanName(title, domain);
    const description = (typeof org.description === 'string' && org.description.trim())
        || ($ && (metaContent($, 'meta[name="description"]') || metaContent($, 'meta[property="og:description"]'))) || null;
    const logoRaw = (typeof org.logo === 'string' ? org.logo : org.logo?.url)
        || ($ && ($('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href')))
        || null;
    let logo = null;
    if (logoRaw && !/^data:/i.test(logoRaw)) { try { logo = new URL(logoRaw, home.finalUrl).href; } catch { logo = null; } }
    const tech = includeTechStack && home.html ? detectTech(home) : [];
    const techByCategory = {};
    for (const t of tech) (techByCategory[t.category] ??= []).push(t.name);

    const tld = domain.split('.').pop();
    const foundingYear = Number(String(org.foundingDate || '').slice(0, 4)) || acc.foundedTextYear || null;
    const createdAt = reg?.createdAt || null;
    const phones = [...acc.phones].filter((p) => p.replace('+', '').length >= 7).slice(0, 8);
    const emails = [...acc.emails].slice(0, 15);

    return {
        domain,
        input: it.input,
        websiteReachable: !!home.html,
        httpStatus: home.status || null,
        finalUrl: home.html ? home.finalUrl : null,
        companyName: name ? String(name).slice(0, 150) : null,
        legalName: typeof org.legalName === 'string' ? org.legalName : null,
        description: description ? description.slice(0, 1000) : null,
        logoUrl: logo,
        language: $ ? ($('html').attr('lang') || '').split('-')[0].toLowerCase() || null : null,
        foundingYear,
        country: address?.country || CC_TLD[tld] || null,
        address,
        email: bestEmail(acc.emails, domain),
        emails,
        phones,
        socials: Object.keys(acc.socials).length ? acc.socials : null,
        linkedinUrl: acc.socials.linkedin || null,
        techStack: tech.map((t) => t.name),
        techByCategory: Object.keys(techByCategory).length ? techByCategory : null,
        cms: techByCategory.cms?.[0] || null,
        ecommercePlatform: techByCategory.ecommerce?.[0] || null,
        emailProvider: dnsInfo?.emailProvider ?? null,
        mxHosts: dnsInfo?.mxHosts ?? null,
        saasToolsFromDns: dnsInfo?.saasToolsFromDns ?? null,
        dmarcPolicy: dnsInfo?.dmarcPolicy ?? null,
        domainCreatedAt: createdAt,
        domainAgeYears: createdAt ? Math.round(((Date.now() - Date.parse(createdAt)) / (365.25 * 86400000)) * 10) / 10 : null,
        domainExpiresAt: reg?.expiresAt || null,
        registrar: reg?.registrar || null,
        copyrightYear: acc.copyrightYear,
        pagesScanned,
        enrichedAt: new Date().toISOString(),
        _chargeable: !!home.html || !!dnsInfo?.hasRecords,
    };
}

let rowsPushed = 0;
let chargeable = 0;
const stats = { domains: items.length, reachable: 0, withEmail: 0, withPhone: 0, withLinkedin: 0, invalid: invalid.length };
log.info(`Enriching ${items.length} domain(s).`);

for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (pastDeadline()) { log.warning('Approaching run timeout; stopping early with results so far.'); break; }
    const batch = items.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map((it) => enrich(it).catch((err) => ({ domain: it.domain, input: it.input, error: err?.message, _chargeable: false }))));
    for (const row of rows) {
        const { _chargeable, ...out } = row;
        if (!_chargeable && !out.error) out.note = 'Domain did not answer and has no DNS records. Not charged.';
        await Actor.pushData(out);
        rowsPushed += 1;
        if (out.websiteReachable) stats.reachable += 1;
        if (out.email) stats.withEmail += 1;
        if (out.phones?.length) stats.withPhone += 1;
        if (out.linkedinUrl) stats.withLinkedin += 1;
        if (_chargeable) {
            chargeable += 1;
            if (chargeable > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'company_enriched' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    }
    if ((i + CONCURRENCY) % 80 < CONCURRENCY) log.info(`Progress: ${Math.min(i + CONCURRENCY, items.length)}/${items.length}.`);
}

for (const s of invalid.slice(0, 50)) await Actor.pushData({ input: s, note: 'Not a valid domain. Not charged.' });
await Actor.setValue('SUMMARY', { ...stats, rows: rowsPushed });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
