// SaaS Customer Finder: companies using any tool, from DNS and the homepage
//
// Strategy
// --------
// The buyer names a technology ("Atlassian", "OpenAI", "Shopify"). We walk a
// ranked list of real company domains (the Tranco top 1M, or the buyer's own
// list) and test each one:
//   1. DNS over HTTPS: TXT and MX. Vendor domain-verification tokens and SPF
//      includes expose internal SaaS (Atlassian, DocuSign, OpenAI, Slack) and
//      the whole email stack, none of which appears on a homepage.
//   2. Homepage, one plain fetch, only when a requested technology is
//      detectable there (Shopify, Klaviyo, HubSpot tracking) or the domain
//      already matched and the buyer wants contacts.
// A matched domain becomes one row: every technology detected, the evidence
// for each, and the public contacts on its site.
//
// No proxy, no browser, no API key. DNS goes to Cloudflare's resolver with
// Google as the fallback, and each homepage is one direct request. This is
// deliberate: proxy bandwidth is what put other actors underwater.
//
// Pay per event
// -------------
//   company_match ($0.01) a company using the technology, no public email found
//   company_lead  ($0.03) a company using the technology with a public email
// Domains scanned that do not match are never charged. The first matched
// company per run is free so buyers can see the full row.

import { Actor, log } from 'apify';
import { SIGNATURES } from './signatures.js';
import { DNS_SIGNATURES, ALIASES } from './dns-signatures.js';

const FREE_TIER_ROWS = 1;
const DNS_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600000;
const MAX_SCAN = 200000;
const DOMAIN_CAP_MS = 30000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    technologies = [],
    matchMode = 'any',
    domains = [],
    startRank = 1,
    maxDomainsToScan = 5000,
    maxResults = 100,
    tlds = [],
    includeContacts = true,
    concurrency = 25,
} = input;

// ---------- Technology catalog: homepage and DNS signatures merged by name ----------

const catalog = new Map();
for (const s of SIGNATURES) catalog.set(s.name.toLowerCase(), { name: s.name, category: s.category, html: s });
for (const s of DNS_SIGNATURES) {
    const key = s.name.toLowerCase();
    const cur = catalog.get(key);
    if (cur) cur.dns = s;
    else catalog.set(key, { name: s.name, category: s.category, dns: s });
}

function resolveTech(raw) {
    const q = String(raw || '').trim().toLowerCase();
    if (!q) return null;
    const alias = ALIASES[q];
    if (alias) return catalog.get(alias.toLowerCase()) || null;
    if (catalog.has(q)) return catalog.get(q);
    const loose = q.replace(/[^a-z0-9]/g, '');
    for (const [k, v] of catalog) if (k.replace(/[^a-z0-9]/g, '') === loose) return v;
    return null;
}

const wanted = [];
const unknown = [];
for (const t of (Array.isArray(technologies) ? technologies : String(technologies).split(/[\n,]/))) {
    if (!String(t || '').trim()) continue;
    const hit = resolveTech(t);
    if (hit) { if (!wanted.includes(hit)) wanted.push(hit); } else unknown.push(String(t).trim());
}

const supported = [...catalog.values()].map((c) => c.name).sort((a, b) => a.localeCompare(b));
if (unknown.length) log.warning(`Not a supported technology, ignored: ${unknown.join(', ')}.`);
if (!wanted.length) {
    await Actor.pushData({
        rowType: 'note',
        note: `${unknown.length ? `Not recognised: ${unknown.join(', ')}. ` : 'No technology given. '}`
            + `Supported (${supported.length}): ${supported.join(', ')}. Not charged.`,
    });
    await Actor.exit();
}

const needHtml = wanted.some((w) => w.html);
const tldList = (Array.isArray(tlds) ? tlds : String(tlds).split(/[\n,]/))
    .map((t) => String(t).trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
const scanCap = Math.min(MAX_SCAN, Math.max(1, Number(maxDomainsToScan) || 5000));
const resultCap = Math.max(1, Number(maxResults) || 100);
const workers = Math.max(1, Math.min(50, Number(concurrency) || 25));

log.info(`Looking for companies using ${wanted.map((w) => w.name).join(matchMode === 'all' ? ' AND ' : ' OR ')}. `
    + `Detected via ${needHtml ? 'DNS and homepage' : 'DNS only (fast)'}.`);

// ---------- Candidate domains ----------

const cleanDomain = (d) => {
    let s = String(d || '').trim().toLowerCase();
    if (!s) return null;
    try { if (/^https?:\/\//.test(s)) s = new URL(s).hostname; } catch { return null; }
    s = s.replace(/^www\./, '').replace(/\/.*$/, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
};
const tldOk = (d) => !tldList.length || tldList.some((t) => d === t || d.endsWith(`.${t}`));

let candidates = [];
let source;
const ownList = (Array.isArray(domains) ? domains : String(domains).split(/[\n,]/)).map(cleanDomain).filter(Boolean);
if (ownList.length) {
    source = 'your domain list';
    candidates = [...new Set(ownList)].filter(tldOk).slice(0, scanCap).map((domain, i) => ({ domain, rank: i + 1 }));
} else {
    source = 'Tranco top sites';
    candidates = await loadTranco(Math.max(1, Number(startRank) || 1), scanCap);
}
if (!candidates.length) {
    await Actor.pushData({ rowType: 'note', note: `No domains to scan from ${source}${tldList.length ? ` with TLD ${tldList.join(', ')}` : ''}. Not charged.` });
    await Actor.exit();
}
log.info(`Scanning up to ${candidates.length} domain(s) from ${source}, stopping at ${resultCap} match(es).`);

async function loadTranco(from, count) {
    // Tranco serves any prefix of today's list as plain CSV ("rank,domain").
    // With a TLD filter most rows are dropped, so read further to fill the scan.
    const meta = await fetchJson('https://tranco-list.eu/api/lists/date/latest');
    if (!meta?.list_id) throw new Error('Tranco list metadata unavailable');
    const want = tldList.length ? 1000000 : Math.min(1000000, from + count);
    const size = [10000, 100000, 1000000].find((n) => n >= want) || 1000000;
    const res = await fetch(`https://tranco-list.eu/download/${meta.list_id}/${size}`, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Tranco download HTTP ${res.status}`);
    const out = [];
    for (const line of (await res.text()).split('\n')) {
        const i = line.indexOf(',');
        if (i < 0) continue;
        const rank = Number(line.slice(0, i));
        const domain = line.slice(i + 1).trim().toLowerCase();
        if (rank < from || !domain || !tldOk(domain)) continue;
        out.push({ domain, rank });
        if (out.length >= count) break;
    }
    log.info(`Tranco list ${meta.list_id} (${meta.created_on?.slice(0, 10)}): ${out.length} domain(s) from rank ${from}.`);
    return out;
}

async function fetchJson(url, headers = {}) {
    try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

// ---------- DNS over HTTPS ----------

const RESOLVERS = [
    (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`,
    (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}`,
];
let dnsErrors = 0;

async function dnsQuery(name, type) {
    for (const build of RESOLVERS) {
        try {
            const r = await fetch(build(name, type), {
                headers: { accept: 'application/dns-json' },
                signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
            });
            if (!r.ok) continue; // 429 or 5xx: try the next resolver
            const j = await r.json();
            const code = type === 'TXT' ? 16 : 15;
            return (j.Answer || []).filter((a) => a.type === code).map((a) => String(a.data));
        } catch { /* next resolver */ }
    }
    dnsErrors += 1;
    return [];
}

// A TXT answer arrives quoted and may be split into 255-byte chunks.
const unquoteTxt = (s) => s.replace(/^"|"$/g, '').replace(/"\s*"/g, '');

async function detectDns(domain) {
    const [txtRaw, mxRaw] = await Promise.all([dnsQuery(domain, 'TXT'), dnsQuery(domain, 'MX')]);
    const txt = txtRaw.map((t) => unquoteTxt(t).trim().toLowerCase());
    const spf = txt.find((t) => t.startsWith('v=spf1')) || '';
    const mx = mxRaw.map((m) => m.split(/\s+/).pop().replace(/\.$/, '').toLowerCase());
    const found = [];
    for (const s of DNS_SIGNATURES) {
        let evidence = null;
        for (const p of s.txt || []) { const hit = txt.find((t) => t.startsWith(p)); if (hit) { evidence = `txt: ${hit.slice(0, 60)}`; break; } }
        if (!evidence && spf) for (const p of s.spf || []) { if (spf.includes(p)) { evidence = `spf: ${p}`; break; } }
        if (!evidence) for (const p of s.mx || []) { const hit = mx.find((m) => m.includes(p)); if (hit) { evidence = `mx: ${hit}`; break; } }
        if (evidence) found.push({ name: s.name, category: s.category, source: 'dns', evidence });
    }
    const emailHost = found.find((f) => f.category === 'email-hosting')?.name || null;
    return { found, hasDns: txt.length > 0 || mx.length > 0, emailProvider: emailHost };
}

// ---------- Homepage ----------

// Read at most MAX_HTML_BYTES and stop: some sites stream without end, and a
// plain res.text() would wait on them. The whole fetch shares one abort signal.
async function readCapped(res, controller) {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let size = 0;
    try {
        while (size < MAX_HTML_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
        }
    } finally {
        controller.abort();
        reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, MAX_HTML_BYTES);
}

async function fetchPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        const headers = {};
        for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = String(v).toLowerCase();
        const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
            .map((c) => c.split('=')[0].trim().toLowerCase());
        let raw = '';
        if ((headers['content-type'] || '').includes('text')) raw = await readCapped(res, controller);
        else { controller.abort(); res.body?.cancel?.().catch(() => {}); }
        return { ok: res.ok, status: res.status, finalUrl: res.url, raw, html: raw.toLowerCase(), headers, setCookies };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchHomepage(domain) {
    const t0 = Date.now();
    const first = await fetchPage(`https://${domain}/`);
    if (first?.ok && first.raw) return first;
    // A site that stalled for the whole timeout is refusing this IP, and www.
    // will stall the same way: fail in 8s instead of 16.
    if (!first && Date.now() - t0 >= FETCH_TIMEOUT_MS - 500) return null;
    const www = await fetchPage(`https://www.${domain}/`);
    return www?.raw ? www : first;
}

function detectHtml(page) {
    const found = [];
    if (!page) return found;
    for (const sig of SIGNATURES) {
        let evidence = null;
        for (const pat of sig.html || []) if (page.html.includes(pat)) { evidence = `html: ${pat}`; break; }
        if (!evidence) for (const [h, pat] of sig.header || []) {
            const v = page.headers[h];
            if (v !== undefined && (pat === '' || v.includes(pat))) { evidence = `header: ${h}${pat ? `=${pat}` : ''}`; break; }
        }
        if (!evidence) for (const pat of sig.cookie || []) if (page.setCookies.some((c) => c.includes(pat))) { evidence = `cookie: ${pat}`; break; }
        if (evidence) found.push({ name: sig.name, category: sig.category, source: 'homepage', evidence });
    }
    return found;
}

// ---------- Contacts ----------

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|domain|email|yourdomain|company|test)\.|sentry|wixpress|^(no-?reply|donotreply|u00|name@|user@|you@|your@|email@)|^[0-9a-f]{16,}@/i;
const FREEMAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol|gmx|web|mail|yandex|zoho)\.[a-z.]+$/i;
// Titles a CDN or bot wall serves in place of the site, never a company name.
const BLOCK_TITLE = /access denied|attention required|just a moment|forbidden|unable to provide|captcha|are you a robot|not found|error|^40\d|^50\d/i;

// Cloudflare's email protection hides addresses as a hex string XOR'd with its first byte.
function decodeCfEmail(hex) {
    try {
        const key = parseInt(hex.slice(0, 2), 16);
        let out = '';
        for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
        return out;
    } catch { return ''; }
}

function extractContacts(raw, domain) {
    const emails = new Set();
    const text = raw.replace(/&#64;|\[at\]|\(at\)/gi, '@');
    for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
    for (const m of raw.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) { const e = decodeCfEmail(m[1]); if (e.includes('@')) emails.add(e.toLowerCase()); }
    const clean = [...emails].filter((e) => !JUNK_EMAIL.test(e) && e.length < 80);
    // Addresses on the company's own domain first: those are the reachable ones.
    const own = clean.filter((e) => e.split('@')[1].endsWith(domain));
    const ranked = [...own, ...clean.filter((e) => !own.includes(e))].slice(0, 5);

    const phones = [...new Set([...raw.matchAll(/href=["']tel:([+\d().\s-]{7,20})["']/gi)].map((m) => m[1].trim()))].slice(0, 3);
    const social = {};
    const socialRe = {
        linkedin: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[a-z0-9_%.-]+/i,
        twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)[a-z0-9_]{2,15}/i,
        facebook: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|tr\?|plugins)[a-z0-9_.-]{3,}/i,
        instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/)[a-z0-9_.]{2,30}/i,
        youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[a-z0-9_.-]+/i,
        github: /https?:\/\/(?:www\.)?github\.com\/(?!login|features|about|pricing)[a-z0-9-]{2,39}(?=["'\/?#\s])/i,
    };
    for (const [k, re] of Object.entries(socialRe)) { const m = raw.match(re); if (m) social[k] = m[0]; }

    let title = decode((raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1]);
    if (title && BLOCK_TITLE.test(title)) title = null;
    if (title && /^(home|home ?page|startseite|accueil|inicio|welcome|index|homepage)$/i.test(title.trim())) title = null;
    // "Acme - Project software for teams" -> "Acme"
    const shortTitle = title ? title.split(/\s+[-|–—:·]\s+/)[0].trim() || title : null;
    const siteName = decode((raw.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,120})["']/i) || [])[1]);
    const description = decode((raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i) || [])[1]);
    const contactHref = (raw.match(/href=["']([^"'#]*(?:contact|kontakt|contacto|contatti)[^"'#]*)["']/i) || [])[1] || null;
    return { emails: ranked, phones, social, title: shortTitle, siteName, description, contactHref };
}

function decode(s) {
    if (!s) return null;
    return s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() || null;
}

// ---------- Scan ----------

const runStart = Date.now();
const hardTimeoutAt = Actor.getEnv().timeoutAt ? new Date(Actor.getEnv().timeoutAt).getTime() : runStart + 3600 * 1000;
// Stop taking new domains with room for in-flight ones (DNS 2x5s + two 8s fetches).
const softDeadlineAt = hardTimeoutAt - Math.min(60_000, (hardTimeoutAt - runStart) * 0.25);

let cursor = 0;
let scanned = 0;
let matched = 0;
let leads = 0;
let charged = 0;
let stopReason = null;
let lastRank = 0;
let capped = 0;

async function scanOne({ domain, rank }) {
    const dns = await detectDns(domain);
    let techs = dns.found;
    const has = (list) => wanted.map((w) => list.some((t) => t.name === w.name));
    const hitsFrom = (list) => (matchMode === 'all' ? has(list).every(Boolean) : has(list).some(Boolean));

    // Only fetch the homepage when it could change the answer, or to find contacts on a match.
    let page = null;
    const dnsDecides = !needHtml || (matchMode !== 'all' && hitsFrom(techs));
    if (!dnsDecides) {
        page = await fetchHomepage(domain);
        techs = mergeTechs(techs, detectHtml(page));
    }
    if (!hitsFrom(techs)) return;
    if (includeContacts && !page) {
        page = await fetchHomepage(domain);
        techs = mergeTechs(techs, detectHtml(page));
    }

    let contacts = page?.raw ? extractContacts(page.raw, domain) : null;
    // No reachable address on the homepage: try the linked contact page, then
    // the usual paths. At most two extra fetches, and only for a match.
    if (includeContacts && contacts && !contacts.emails.some((e) => isOwnEmail(e, domain))) {
        const tries = [contacts.contactHref, '/contact', '/contact-us'].filter(Boolean);
        const seenUrls = new Set();
        for (const t of tries) {
            if (seenUrls.size >= 2) break;
            let href = null;
            try { href = new URL(t, page.finalUrl).href; } catch { continue; }
            if (seenUrls.has(href) || !new URL(href).hostname.endsWith(domain)) continue;
            seenUrls.add(href);
            const cp = await fetchPage(href);
            if (!cp?.ok || !cp.raw) continue;
            const more = extractContacts(cp.raw, domain);
            contacts.emails = [...new Set([...more.emails, ...contacts.emails])].slice(0, 5);
            contacts.phones = contacts.phones.length ? contacts.phones : more.phones;
            contacts.social = { ...more.social, ...contacts.social };
            if (contacts.emails.some((e) => isOwnEmail(e, domain))) break;
        }
    }
    await emit({ domain, rank, dns, techs, page, contacts });
}

// A lead is an address the company answers: its own domain, or a free mailbox
// on its own site (common for small firms). Vendor or agency addresses found on
// the page are still returned, but do not make the row a lead.
function isOwnEmail(e, domain) {
    const host = e.split('@')[1] || '';
    return host === domain || host.endsWith(`.${domain}`) || FREEMAIL.test(e);
}

function mergeTechs(a, b) {
    const seen = new Set(a.map((t) => t.name));
    return [...a, ...b.filter((t) => !seen.has(t.name))];
}

async function emit({ domain, rank, dns, techs, page, contacts }) {
    if (matched >= resultCap) return;
    matched += 1;
    const emails = contacts?.emails || [];
    const isLead = emails.some((e) => isOwnEmail(e, domain));
    const byCategory = {};
    for (const t of techs) (byCategory[t.category] ??= []).push(t.name);
    await Actor.pushData({
        domain,
        rank: source === 'Tranco top sites' ? rank : null,
        companyName: (page?.ok && (contacts?.siteName || contacts?.title)) || null,
        matchedTechnologies: wanted.map((w) => w.name).filter((n) => techs.some((t) => t.name === n)),
        leadTier: isLead ? 'lead' : 'match',
        primaryEmail: emails.find((e) => isOwnEmail(e, domain)) || null,
        emails,
        phones: contacts?.phones || [],
        linkedin: contacts?.social?.linkedin || null,
        social: contacts?.social || {},
        website: page?.finalUrl || `https://${domain}/`,
        websiteReachable: Boolean(page?.ok),
        description: contacts?.description || null,
        emailProvider: dns.emailProvider,
        techCount: techs.length,
        byCategory,
        technologies: techs,
        scrapedAt: new Date().toISOString(),
    });
    if (isLead) leads += 1;
    if (matched > FREE_TIER_ROWS) {
        try {
            const r = await Actor.charge({ eventName: isLead ? 'company_lead' : 'company_match' });
            charged += 1;
            if (r?.eventChargeLimitReached) stopReason = 'your maximum cost per run';
        } catch (err) {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }
    }
    if (matched >= resultCap) stopReason ??= `${resultCap} match(es) found`;
}

async function worker() {
    while (!stopReason) {
        if (Date.now() > softDeadlineAt) { stopReason ??= 'the run time limit'; break; }
        const c = candidates[cursor];
        if (!c) break;
        cursor += 1;
        lastRank = Math.max(lastRank, c.rank);
        // Hard cap per domain, independent of fetch internals: a platform run on
        // 2026-09-30 sat at 2% CPU for 11 minutes on requests that never settled.
        let cap;
        await Promise.race([
            scanOne(c),
            new Promise((_, reject) => { cap = setTimeout(() => reject(new Error('domain time cap')), DOMAIN_CAP_MS); }),
        ]).catch((err) => { if (err?.message === 'domain time cap') capped += 1; log.debug(`${c.domain}: ${err?.message}`); });
        clearTimeout(cap);
        scanned += 1;
        if (scanned % (needHtml ? 100 : 500) === 0) log.info(`Scanned ${scanned}/${candidates.length}, ${matched} match(es) so far.`);
    }
}

await Promise.all(Array.from({ length: workers }, worker));
stopReason ??= `all ${candidates.length} domain(s) scanned`;

const nextStartRank = source === 'Tranco top sites' ? lastRank + 1 : null;
await Actor.setValue('SUMMARY', {
    technologies: wanted.map((w) => w.name), matchMode, source, scanned, matched, leads, charged,
    stoppedBecause: stopReason, nextStartRank, dnsErrors,
});

if (matched === 0) {
    await Actor.pushData({
        rowType: 'note',
        note: `Scanned ${scanned} domain(s) from ${source} and none use ${wanted.map((w) => w.name).join(matchMode === 'all' ? ' and ' : ' or ')}. `
            + `${nextStartRank ? `Continue with startRank ${nextStartRank}, ` : ''}raise maxDomainsToScan, or try a more widely used tool. Not charged.`,
    });
}

log.info(`Done (stopped: ${stopReason}). Scanned ${scanned}, matched ${matched} (${leads} with email), charged ${charged}.`
    + `${nextStartRank ? ` Next page: startRank=${nextStartRank}.` : ''}${dnsErrors ? ` DNS lookups failed: ${dnsErrors}.` : ''}${capped ? ` Domains cut off at ${DOMAIN_CAP_MS / 1000}s: ${capped}.` : ''}`);
await Actor.exit();
