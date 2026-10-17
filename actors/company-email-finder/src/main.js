// Company Email Finder: give it company websites, get back the people on
// their team pages (name and title), every email published on the site,
// the company's email pattern (first.last@, flast@...) worked out from those
// emails, a pattern-based email for each person, the mail provider, and a
// decision-maker flag. Or give it "name + company domain" and get that
// person's most likely email.
//
// Strategy
// --------
// For each domain:
// 1. DNS-over-HTTPS (dns.google) MX lookup: does the domain take mail, and
//    on what (Google Workspace, Microsoft 365, ...).
// 2. Fetch the homepage and /sitemap.xml, pick the pages most likely to
//    list people or addresses (team, about, leadership, management, people,
//    founders, contact, press, impressum), fetch up to maxPagesPerDomain.
// 3. People: JSON-LD Person objects, and name/title pairs in team-card
//    markup (a name-shaped line next to a job-title-shaped line).
// 4. Emails: mailto links and text, cleaned like website-contact-scraper.
//    An email whose local part spells a person's name found on the site
//    (jane.doe@ <-> Jane Doe) reveals the pattern; the pattern with the
//    most such matches wins.
// 5. Each person without a published email gets one built from the
//    pattern (confidence high/medium), or from the most common patterns
//    in B2B when the site gave no evidence (confidence low).
// Mailboxes are not SMTP-checked: datacenter IPs can't reach port 25.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   contact_row ($0.004) one person or email found, or one name lookup
//   answered. Domain summaries are free. Unreachable sites are free.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { FIRST_NAMES } from './first-names.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 1_500_000;
const CONCURRENCY = 5;

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const PACKAGE_VERSION = /@\d+\.\d+/;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|(^|@|\.)(example|sentry|wixpress|yourdomain)\.|@(domain|email|company)\.|^(no-?reply|donotreply)@|@\dx\.|\.ingest\./i;
const HEX_LOCAL = /^[0-9a-f]{16,}@/i;
const GENERIC = /^(info|contact|hello|hi|hey|sales|support|help|team|office|admin|press|media|pr|marketing|careers|jobs|hr|recruiting|billing|accounts|finance|legal|privacy|security|abuse|webmaster|postmaster|enquiries|inquiries|feedback|partners|partnerships|investors|ir|service|customerservice|orders|bookings|reservations|mail|general|events|newsletter|social|studio|design|dev|engineering|ops|operations|compliance|dpo|gdpr)[0-9]*@/i;
// Pages about other companies' people: customer stories, testimonials, blog.
const OUTSIDE_PAGE = /case-stud|customer|testimonial|stories|story\/|blog|glossary|resources|webinar|podcast|events?\/|news\/|press-release|portfolio|templates|marketplace|partners\/directory|community/i;
const PAGE_HINT = /team|about|leadership|management|people|founder|staff|who-we-are|our-story|company|contact|press|media|impressum|kontakt|board|executive|partners|attorneys|lawyers|advisors|faculty|directory/i;
const TITLE_WORDS = /\b(ceo|cto|cfo|coo|cmo|cio|cpo|cro|ciso|chief|founder|co-founder|cofounder|president|vice president|vp|svp|evp|head|director|manager|lead|partner|owner|principal|officer|engineer|developer|designer|architect|scientist|analyst|consultant|associate|advisor|counsel|attorney|lawyer|editor|producer|chair|chairman|chairwoman|chairperson|treasurer|secretary|coordinator|specialist|representative|executive|managing|general manager|gm|strategist|recruiter|accountant|controller|founding|investor|professor|doctor|dr\.?|nurse|physician|agent|broker)\b/i;
// Senior titles are rarely section headings, so they vouch for a name even
// when its first name is not in the list.
const STRONG_TITLE = /\b(ceo|cto|cfo|coo|cmo|cio|cpo|cro|ciso|chief|founder|co-founder|cofounder|president|vice president|vp|head of|director|managing partner|general partner|partner|officer|chair)\b/i;
const DECISION = /\b(ceo|cto|cfo|coo|cmo|cio|cpo|cro|ciso|chief|founder|co-founder|cofounder|president|vice president|vp|svp|evp|head of|director|partner|owner|principal|managing|general manager|chair)/i;
const NAME_SHAPE = /^[A-ZÀ-Ý][a-zà-ÿ'’\-]+(?: [A-ZÀ-Ý]\.?)?(?: (?:van|von|de|da|del|der|di|la|le|du|bin|al|el|mac|mc)?\s?[A-ZÀ-Ý][A-Za-zà-ÿ'’\-]+){1,2}$/;
const NOT_NAME = /\b(sort|filter|apps|by|show|all|browse|explore|search|load|see|back|next|previous|menu|open|close|download|watch|listen|try|start|join|book|request|schedule|demo|free|new|latest|top|best|team|about|contact|our|the|and|company|services|privacy|policy|terms|careers|news|blog|home|learn|more|read|view|get|started|sign|log|in|out|us|we|solutions|products|pricing|features|platform|customers|partners|resources|support|follow|connect|meet|board|directors|leadership|management|advisors|investors|press|media|inc|llc|ltd|gmbh|group)\b/i;

// Popularity of corporate patterns (published B2B studies put first.last
// near half, then first, flast, firstlast, first_last, firstl, last...).
const PATTERNS = ['first.last', 'first', 'flast', 'firstlast', 'first_last', 'firstl', 'last', 'f.last', 'last.first', 'first-last', 'lastf'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    people = [],
    maxPagesPerDomain = 8,
    onlyDecisionMakers = false,
    includeGenericEmails = true,
    maxResultsPerDomain = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((x) => (typeof x === 'string' ? x.trim() : x)).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pagesCap = Math.min(25, Math.max(1, Number(maxPagesPerDomain) || 8));
const perDomainCap = Math.max(1, Number(maxResultsPerDomain) || 100);

function domainOf(raw) {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (s.includes('@')) s = s.split('@').pop();
    if (!/^https?:\/\//.test(s)) s = `https://${s}`;
    try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return null; }
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const PARTICLE = /^(van|von|de|da|del|della|der|den|di|du|la|le|el|al|bin|ben|mac|mc|st|ter|ten|dos|das)$/i;

function nameParts(full) {
    const words = String(full).replace(/\b(dr|mr|mrs|ms|prof)\.?\s+/gi, '').replace(/,.*$/, '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    const first = fold(words[0]);
    // "Pierre Le Poulain" -> lepoulain, "Ismail El Azizi" -> elazizi
    const n = words.length;
    const last = fold(n >= 3 && PARTICLE.test(words[n - 2]) ? `${words[n - 2]}${words[n - 1]}` : words[n - 1]);
    if (!first || !last) return null;
    return { first, last };
}

function build(pattern, { first, last }) {
    const f = first[0];
    const l = last[0];
    return {
        'first.last': `${first}.${last}`, first, flast: `${f}${last}`, firstlast: `${first}${last}`, first_last: `${first}_${last}`,
        firstl: `${first}${l}`, last, 'f.last': `${f}.${last}`, 'last.first': `${last}.${first}`, 'first-last': `${first}-${last}`, lastf: `${last}${f}`,
    }[pattern];
}

// Which patterns turn this person into this local part?
function patternsFor(local, parts) {
    return PATTERNS.filter((p) => build(p, parts) === local);
}

async function fetchText(url) {
    try {
        const r = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !/text|xml|html/.test(type)) return { ok: r.ok, status: r.status, url: r.url, text: '' };
        return { ok: true, status: r.status, url: r.url, text: (await r.text()).slice(0, MAX_HTML_BYTES) };
    } catch (err) {
        return { ok: false, status: 0, url, text: '', error: err.message };
    }
}

async function mx(domain) {
    try {
        const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { signal: AbortSignal.timeout(10_000) });
        const d = await r.json();
        const hosts = (d.Answer || []).filter((a) => a.type === 15).map((a) => String(a.data).split(' ').pop().replace(/\.$/, '').toLowerCase());
        const h = hosts.join(' ');
        const provider = /google|googlemail/.test(h) ? 'Google Workspace' : /outlook|protection\.outlook|office365|microsoft/.test(h) ? 'Microsoft 365'
            : /zoho/.test(h) ? 'Zoho' : /pphosted|proofpoint/.test(h) ? 'Proofpoint' : /mimecast/.test(h) ? 'Mimecast' : /secureserver|godaddy/.test(h) ? 'GoDaddy'
                : /yandex/.test(h) ? 'Yandex' : /icloud|apple/.test(h) ? 'iCloud' : /mailgun/.test(h) ? 'Mailgun' : /amazonaws|awsapps/.test(h) ? 'Amazon WorkMail'
                    : /protonmail|proton\.ch/.test(h) ? 'Proton' : /barracuda/.test(h) ? 'Barracuda' : hosts.length ? 'Other' : null;
        return { acceptsMail: hosts.length > 0, provider, mxHosts: hosts.slice(0, 5) };
    } catch {
        return { acceptsMail: null, provider: null, mxHosts: [] };
    }
}

function cleanEmail(raw) {
    let e = String(raw).toLowerCase().trim().replace(/^mailto:/, '').split('?')[0];
    try { e = decodeURIComponent(e); } catch { /* keep */ }
    e = e.replace(/^[^a-z0-9]+/, '');
    if (EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e) && !JUNK_EMAIL.test(e) && !HEX_LOCAL.test(e)) return e;
    return null;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Name-shaped and either a known first name or vouched for by a senior
// title or by the card (LinkedIn profile, personal mailto, JSON-LD Person).
function looksLikeName(s, vouched = false) {
    const t = clean(s);
    if (!(t.length >= 5 && t.length <= 40 && NAME_SHAPE.test(t) && !NOT_NAME.test(t) && !TITLE_WORDS.test(t))) return false;
    return vouched || FIRST_NAMES.has(fold(t.split(' ')[0]));
}

// The separate lines of an element: "CEO & Co-Founder" and "Chicago, USA"
// instead of cheerio's run-together "CEO & Co-FounderChicago, USA".
function linesOf($, el) {
    const html = $(el).html() || '';
    if (html.length > 20_000) return [];
    return html.replace(/<(br|\/p|\/div|\/span|\/h\d|\/li|\/a|\/strong|\/b|\/em|\/small|\/figcaption)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&[a-z]+;/g, ' ')
        .split('\n').map(clean).filter(Boolean);
}

// "Director of Marketing, Angel City FC", "Founder at RBL Media", "CEO of
// ibelong": a title that names another organisation is a customer or a
// quote, not staff.
function externalTitle(title, company) {
    const t = clean(title);
    if (!t) return false;
    const co = fold(company || '');
    const mentionsUs = (x) => co && fold(x).includes(co);
    const at = t.match(/\b(?:at|@)\s+(.+)$/);
    if (at && !mentionsUs(at[1])) return true;
    const of = t.match(/^(?:co-?founder|founder|ceo|owner|president)\s+of\s+(.+)$/i);
    if (of && !mentionsUs(of[1])) return true;
    const tail = t.split(/,\s*/).slice(1).pop();
    if (tail && !TITLE_WORDS.test(tail) && !/^(inc|llc|ltd)\.?$/i.test(tail) && !mentionsUs(tail) && /^[A-Z0-9]/.test(tail)) return true;
    return false;
}

function looksLikeTitle(s) {
    const t = clean(s);
    return t.length >= 2 && t.length <= 90 && TITLE_WORDS.test(t) && !/[.!?]\s+\S+\s+\S+\s+\S+/.test(t);
}

// People from one page: JSON-LD first, then name/title pairs in cards.
function peopleFrom($, pageUrl) {
    const out = [];
    const add = (name, title, extra = {}, vouched = false) => {
        const n = clean(name);
        const t = clean(title) || null;
        if (!looksLikeName(n, vouched || STRONG_TITLE.test(t || ''))) return;
        out.push({ name: n, title: t, sourceUrl: pageUrl, ...extra });
    };
    $('script[type="application/ld+json"]').each((_, el) => {
        let d;
        try { d = JSON.parse($(el).contents().text()); } catch { return; }
        const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            const t = [].concat(o['@type'] || []);
            if (t.includes('Person') && o.name) {
                add(o.name, o.jobTitle, { linkedin: [].concat(o.sameAs || []).find((u) => /linkedin\.com\/in\//.test(u)) || null, email: o.email ? cleanEmail(o.email) : null }, true);
            }
            for (const k of ['founder', 'founders', 'employee', 'employees', 'member', 'members', 'author', '@graph', 'mainEntity', 'itemListElement', 'item']) walk(o[k]);
        };
        walk(d);
    });
    // Cards: a short element whose text is a name, with a title on a nearby
    // line inside the same small container.
    $('h1,h2,h3,h4,h5,h6,strong,b,p,span,div,a,li,figcaption,dt').each((_, el) => {
        const node = $(el);
        if (node.children().length > 2) return;
        const text = clean(node.text());
        if (text.length < 5 || text.length > 40 || !NAME_SHAPE.test(text)) return;
        // A person card is small; a "card" spanning the page is layout, not a person.
        const card = node.closest('div,li,article,section,tr');
        const small = (card.html() || '').length < 6000;
        const li = small ? card.find('a[href*="linkedin.com/in/"]').first().attr('href') || null : null;
        const mails = small ? card.find('a[href^="mailto:"]').toArray().map((a) => cleanEmail($(a).attr('href'))).filter((e) => e && !GENERIC.test(e)) : [];
        let title = null;
        for (const c of [node.next(), node.prev(), node.parent().next(), node.siblings().first()]) {
            if (!c?.length) continue;
            const t = linesOf($, c).find((l) => l !== text && looksLikeTitle(l));
            if (t) { title = t; break; }
        }
        if (!title) {
            // "Jane Doe, CEO" / "Jane Doe – Head of Sales" on one line
            const line = linesOf($, node.parent()).find((l) => l.startsWith(text) && l.length < 140);
            const m = line ? line.slice(text.length).match(/^\s*[,–—|\-:]\s*([^,|]{2,80})/) : null;
            if (m && looksLikeTitle(m[1])) title = m[1];
        }
        // A card with a personal mailto is a person even without a title.
        if (!title && !mails.length) return;
        add(text, title, { linkedin: li, email: mails[0] || null }, Boolean(li || mails.length));
    });
    return out;
}

function pageLinks($, base, host) {
    const out = new Map();
    $('a[href]').each((_, el) => {
        const href = String($(el).attr('href') || '');
        let u;
        try { u = new URL(href, base); } catch { return; }
        if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== host) return;
        const label = `${u.pathname} ${$(el).text()}`;
        if (!PAGE_HINT.test(label) || OUTSIDE_PAGE.test(u.pathname) || /\.(pdf|jpe?g|png|zip|docx?)$/i.test(u.pathname)) return;
        out.set(`${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`, label);
    });
    return [...out.keys()];
}

function rankPages(urls) {
    const score = (u) => {
        const p = new URL(u).pathname.toLowerCase();
        if (/team|leadership|management|people|founder|staff|executive|board|attorneys|lawyers/.test(p)) return 0;
        if (/about|who-we-are|our-story|company/.test(p)) return 1;
        if (/contact|kontakt|impressum/.test(p)) return 2;
        return 3;
    };
    const norm = (u) => u.replace(/\/+$/, '');
    return [...new Set(urls.map(norm))].sort((a, b) => score(a) - score(b) || a.length - b.length);
}

async function crawl(domain) {
    const visited = new Set();
    const emails = new Map(); // email -> sourceUrl
    const persons = new Map(); // fold(name) -> person
    let companyName = null;
    let reachable = false;
    let pagesRead = 0;
    let home = await fetchText(`https://${domain}/`);
    if (!home.text) home = await fetchText(`https://www.${domain}/`);
    if (!home.text) home = await fetchText(`http://${domain}/`);
    const host = home.url ? new URL(home.url).hostname.replace(/^www\./, '') : domain;
    let queue = [];
    const take = (res, url) => {
        if (!res.text) return null;
        reachable = true;
        pagesRead += 1;
        visited.add(url);
        const $ = cheerio.load(res.text);
        $('a[href^="mailto:"]').each((_, el) => { const e = cleanEmail($(el).attr('href')); if (e && !emails.has(e)) emails.set(e, res.url || url); });
        // "jane [at] acme [dot] com" -> jane@acme.com. Whitespace is collapsed
        // first and kept to single spaces in the pattern: pages with 30k-char
        // whitespace runs made a \s*-based version backtrack for minutes.
        const txt = res.text.replace(/\s{2,}/g, ' ')
            .replace(/ ?(?:\[at\]|\(at\)| at ) ?(?=[a-z0-9-]+ ?(?:\[dot\]|\(dot\)|\.) ?[a-z]{2,})/gi, '@')
            .replace(/ ?(?:\[dot\]|\(dot\)) ?/gi, '.');
        for (const m of txt.matchAll(EMAIL_RE)) {
            const e = cleanEmail(m[0]);
            if (!e) continue;
            if (!emails.has(e)) emails.set(e, res.url || url);
            // Sites that ship their team as a JSON blob (Framer, Next.js...) put
            // the name a few hundred characters before the email: take the
            // nearest preceding name that the email's local part spells.
            if (e.endsWith(`@${domain}`) && !GENERIC.test(e)) {
                const local = e.split('@')[0];
                const before = txt.slice(Math.max(0, m.index - 2000), m.index);
                const names = [...before.matchAll(/[A-ZÀ-Ý][a-zà-ÿ'’\-]+(?: (?:van|von|de|da|del|der|di|la|le|du|el|al) )?(?: ?[A-ZÀ-Ý][a-zà-ÿ'’\-]+){1,2}/g)].reverse();
                for (const nm of names) {
                    const parts = nameParts(nm[0]);
                    if (!parts || !(patternsFor(local, parts).length || local === parts.first)) continue;
                    const k = fold(nm[0]);
                    const prev = persons.get(k);
                    if (!prev) persons.set(k, { name: clean(nm[0]), title: null, sourceUrl: res.url || url, linkedin: null, email: e });
                    else if (!prev.email) prev.email = e;
                    break;
                }
            }
        }
        for (const p of peopleFrom($, res.url || url)) {
            const k = fold(p.name);
            const prev = persons.get(k);
            if (!prev) persons.set(k, p);
            else persons.set(k, { ...prev, title: prev.title || p.title, linkedin: prev.linkedin || p.linkedin, email: prev.email || p.email });
        }
        return $;
    };
    const $home = take(home, `https://${domain}/`);
    if ($home) {
        const fromTitle = clean($home('title').text()).split(/\s[|–—\-:·]\s|:\s/)[0].trim();
        companyName = clean($home('meta[property="og:site_name"]').attr('content')).split(/\s[|–—\-:·]\s|:\s/)[0]
            || (fromTitle && !/^(home|homepage|welcome|index)$/i.test(fromTitle) ? fromTitle : null)
            || domain.split('.')[0].replace(/^./, (c) => c.toUpperCase());
        queue.push(...pageLinks($home, home.url, host));
    }
    if (reachable) {
        const sm = await fetchText(`https://${host === domain ? domain : host}/sitemap.xml`);
        const locs = [...(sm.text || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
        // A sitemap index lists more sitemaps; read the first page-ish one.
        const sub = locs.find((l) => /\.xml/i.test(l) && /page|post-type|pages/i.test(l)) || (locs.every((l) => /\.xml/i.test(l)) ? locs[0] : null);
        let urls = locs;
        if (sub) urls = [...((await fetchText(sub)).text || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
        queue.push(...urls.filter((u) => {
            try { const path = new URL(u).pathname; return PAGE_HINT.test(path) && !OUTSIDE_PAGE.test(path) && path.split('/').filter(Boolean).length <= 2; } catch { return false; }
        }));
        if (!queue.length) queue.push(`https://${host}/about`, `https://${host}/team`, `https://${host}/contact`);
    }
    visited.add(`https://${domain}`).add(`https://${host}`).add(`https://www.${domain}`);
    queue = rankPages(queue).filter((u) => !visited.has(u));
    // The homepage counts as the first page.
    let fetched = 1;
    for (const u of queue) {
        if (fetched >= pagesCap) break;
        visited.add(u);
        fetched += 1;
        const res = await fetchText(u);
        const $ = take(res, u);
        // A team page may link to individual bio pages; they're queued too.
        if ($ && fetched < pagesCap) for (const l of rankPages(pageLinks($, res.url, host))) if (!visited.has(l) && !queue.includes(l)) queue.push(l);
    }
    return { reachable, companyName, host, emails, persons: [...persons.values()], pagesRead };
}

function inferPattern(emails, persons, domain) {
    const votes = {};
    const examples = {};
    const byLocal = [...emails.keys()].filter((e) => e.endsWith(`@${domain}`) && !GENERIC.test(e)).map((e) => e.split('@')[0]);
    for (const p of persons) {
        const parts = nameParts(p.name);
        if (!parts) continue;
        for (const local of byLocal) {
            for (const pat of patternsFor(local, parts)) {
                votes[pat] = (votes[pat] || 0) + 1;
                (examples[pat] ||= []).push(`${local}@${domain}`);
            }
        }
    }
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1] || PATTERNS.indexOf(a[0]) - PATTERNS.indexOf(b[0]))[0];
    if (!best) return null;
    return { pattern: best[0], evidence: best[1], examples: [...new Set(examples[best[0]])].slice(0, 3) };
}

function guess(parts, domain, inferred) {
    if (inferred) {
        return {
            email: `${build(inferred.pattern, parts)}@${domain}`,
            confidence: inferred.evidence >= 2 ? 'high' : 'medium',
            alternatives: [],
            basis: `Company pattern ${inferred.pattern}@ seen in ${inferred.evidence} published email(s).`,
        };
    }
    const cands = PATTERNS.slice(0, 5).map((p) => `${build(p, parts)}@${domain}`);
    return { email: cands[0], confidence: 'low', alternatives: cands.slice(1), basis: 'No published personal emails to learn the pattern from; most common B2B patterns.' };
}

// ---- run ----
let rowsOut = 0;
let keepGoing = true;
const failures = [];
const summaries = [];

async function emit(row) {
    await Actor.pushData(row);
    rowsOut += 1;
    try {
        const res = await Actor.charge({ eventName: 'contact_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); keepGoing = false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

// Name lookups: "Jane Doe, acme.com" / "Jane Doe acme.com" / {name, domain}.
const lookups = list(people).map((p) => {
    if (typeof p === 'object') return { name: clean(p.name || [p.firstName, p.lastName].filter(Boolean).join(' ')), domain: domainOf(p.domain || p.website || p.company) };
    const m = String(p).match(/^(.*?)[\s,;|@]+((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\S*)$/i);
    return m ? { name: clean(m[1]), domain: domainOf(m[2]) } : { name: clean(p), domain: null };
});
const domainList = [...new Set([...list(domains).map(domainOf), ...lookups.map((l) => l.domain)].filter(Boolean))];
const wantedFull = new Set(list(domains).map(domainOf).filter(Boolean));
if (!domainList.length) await Actor.pushData({ type: 'error', error: 'Add company domains, or people as "First Last, company.com". Not charged.' });
for (const l of lookups) if (!l.domain || !nameParts(l.name)) await Actor.pushData({ type: 'error', input: l.name, error: 'Each person needs a first and last name and a company domain, e.g. "Jane Doe, acme.com". Not charged.' });

async function processDomain(domain) {
    const [mail, site] = await Promise.all([mx(domain), crawl(domain)]);
    const inferred = inferPattern(site.emails, site.persons, domain);
    let n = 0;
    const domainRows = [];
    if (wantedFull.has(domain)) {
        const emailed = new Set();
        for (const p of site.persons) {
            if (externalTitle(p.title, site.companyName) && !p.email) continue;
            if (onlyDecisionMakers && !DECISION.test(p.title || '')) continue;
            const parts = nameParts(p.name);
            const published = p.email || [...site.emails.keys()].find((e) => parts && e.endsWith(`@${domain}`) && patternsFor(e.split('@')[0], parts).length);
            const g = !published && parts && mail.acceptsMail !== false ? guess(parts, domain, inferred) : null;
            if (published) emailed.add(published);
            domainRows.push({
                type: 'person', domain, company: site.companyName, name: p.name, title: p.title, isDecisionMaker: DECISION.test(p.title || ''),
                email: published || g?.email || null, emailSource: published ? 'published on site' : g ? 'pattern' : null,
                confidence: published ? 'verified on site' : g?.confidence || null, alternatives: g?.alternatives?.length ? g.alternatives : null,
                basis: g?.basis || null, linkedin: p.linkedin || null, sourceUrl: p.sourceUrl, mailProvider: mail.provider,
            });
        }
        if (!onlyDecisionMakers) {
            for (const [e, src] of site.emails) {
                if (emailed.has(e)) continue;
                const generic = GENERIC.test(e);
                if (generic && !includeGenericEmails) continue;
                domainRows.push({
                    type: 'email', domain, company: site.companyName, name: null, title: null, isDecisionMaker: false, email: e,
                    emailSource: 'published on site', confidence: 'verified on site', emailType: generic ? 'generic' : 'personal',
                    onCompanyDomain: e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`), sourceUrl: src, mailProvider: mail.provider,
                });
            }
        }
        domainRows.sort((a, b) => Number(b.isDecisionMaker) - Number(a.isDecisionMaker));
        for (const r of domainRows) {
            if (!keepGoing || n >= perDomainCap) break;
            await emit(r);
            n += 1;
        }
    }
    for (const l of lookups.filter((x) => x.domain === domain && nameParts(x.name))) {
        if (!keepGoing) break;
        const parts = nameParts(l.name);
        const onSite = site.persons.find((p) => fold(p.name) === fold(l.name));
        const published = onSite?.email || [...site.emails.keys()].find((e) => e.endsWith(`@${domain}`) && patternsFor(e.split('@')[0], parts).length);
        if (mail.acceptsMail === false && !published) {
            await Actor.pushData({ type: 'lookup', input: l.name, domain, email: null, confidence: null, basis: `${domain} has no MX record, so it receives no email. Not charged.` });
            continue;
        }
        const g = published ? null : guess(parts, domain, inferred);
        await emit({
            type: 'lookup', input: l.name, domain, company: site.companyName, name: onSite?.name || l.name, title: onSite?.title || null,
            isDecisionMaker: DECISION.test(onSite?.title || ''), email: published || g.email, emailSource: published ? 'published on site' : 'pattern',
            confidence: published ? 'verified on site' : g.confidence, alternatives: g?.alternatives?.length ? g.alternatives : null, basis: g?.basis || null,
            linkedin: onSite?.linkedin || null, sourceUrl: onSite?.sourceUrl || null, mailProvider: mail.provider,
        });
    }
    const summary = {
        type: 'domain', domain, company: site.companyName, reachable: site.reachable, pagesRead: site.pagesRead, acceptsMail: mail.acceptsMail,
        mailProvider: mail.provider, mxHosts: mail.mxHosts, emailPattern: inferred ? `${inferred.pattern}@${domain}` : null,
        patternEvidence: inferred?.evidence ?? 0, patternExamples: inferred?.examples ?? [], peopleFound: site.persons.filter((p) => p.email || !externalTitle(p.title, site.companyName)).length,
        decisionMakersFound: site.persons.filter((p) => DECISION.test(p.title || '') && !externalTitle(p.title, site.companyName)).length, emailsFound: site.emails.size,
        genericEmails: [...site.emails.keys()].filter((e) => GENERIC.test(e)).slice(0, 10),
        note: !site.reachable ? 'Website did not load (blocked, down or not a website). Not charged.' : null,
    };
    // The summary is free: pushed without a charge.
    await Actor.pushData(summary);
    summaries.push({ domain, rows: n, people: site.persons.length, emails: site.emails.size, pattern: summary.emailPattern });
    log.info(`${domain}: ${site.pagesRead} page(s), ${site.persons.length} people, ${site.emails.size} emails, pattern ${summary.emailPattern || 'unknown'}.`);
}

const queue = [...domainList];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length && keepGoing) {
        const d = queue.shift();
        try { await processDomain(d); } catch (err) {
            failures.push({ domain: d, error: String(err.message) });
            await Actor.pushData({ type: 'error', domain: d, error: `${err.message}. Not charged.` });
        }
        await sleep(100);
    }
}));

await Actor.setValue('SUMMARY', { rows: rowsOut, domains: summaries, failures });
log.info(`Done. ${rowsOut} charged row(s) across ${summaries.length} domain(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
