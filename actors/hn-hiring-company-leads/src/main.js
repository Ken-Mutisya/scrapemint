// Hacker News "Who is Hiring" Company Lead Scraper
//
// Each month Hacker News runs a "Who is hiring?" thread where companies post open
// roles. This turns those posts into B2B leads: company, role, location, remote
// flag, salary, apply email, apply URL, and the company website. One lead per post.
//
// Buyers: recruiting and sourcing SaaS, developer-tool and dev-service vendors
// selling to engineering teams, and sales teams targeting companies actively
// hiring (a strong growth signal).
//
// Source is the keyless HN Firebase API. Apply emails are taken from the post text;
// when only a URL is given, the company website is captured and optionally scraped
// for an email.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_QUALIFIED = 1;
const HN = 'https://hacker-news.firebaseio.com/v0';
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/i;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    months = 1,
    keywords = [],
    remoteOnly = false,
    requireEmail = false,
    maxLeads = 25,
    concurrency = 10,
} = input;

const monthCount = Math.max(1, Math.min(12, Number(months) || 1));
const kw = (Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
const leadCap = Math.max(1, Math.min(10000, Number(maxLeads) || 500));
const pool = Math.max(1, Math.min(30, Number(concurrency) || 10));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;

// ---------- Stage 1: find the recent "Who is hiring" threads ----------
const user = await fetchJson(`${HN}/user/whoishiring.json`);
const submitted = user?.submitted || [];
if (submitted.length === 0) { log.error('Could not load whoishiring submissions.'); await Actor.exit(); }

const threads = [];
for (const id of submitted) {
    if (threads.length >= monthCount) break;
    const it = await fetchJson(`${HN}/item/${id}.json`);
    if (it?.title && /Who is hiring/i.test(it.title)) {
        threads.push({ id, title: it.title, month: monthLabel(it.title), kids: it.kids || [] });
    }
}
if (threads.length === 0) { log.warning('No "Who is hiring" threads found.'); await Actor.exit(); }
log.info(`Threads: ${threads.map((t) => t.month).join(', ')}.`);

// ---------- Stage 2: fetch + parse top-level comments ----------
const commentRefs = [];
for (const t of threads) for (const cid of t.kids) commentRefs.push({ cid, month: t.month });

const parsed = (await mapWithConcurrency(commentRefs.slice(0, leadCap * 2), pool, async (ref) => {
    const c = await fetchJson(`${HN}/item/${ref.cid}.json`);
    if (!c || c.deleted || c.dead || !c.text) return null;
    return parsePost(c, ref.month);
})).filter(Boolean);

let leads = parsed.filter((l) => l.company);
if (remoteOnly) leads = leads.filter((l) => l.remote);
if (kw.length) leads = leads.filter((l) => kw.some((k) => l._hay.includes(k)));
if (requireEmail) leads = leads.filter((l) => l.applyEmail);
leads = leads.slice(0, leadCap);

if (leads.length === 0) { log.warning('No matching posts. Nothing to score.'); await Actor.exit(); }

// ---------- Stage 3: score, tier, push, charge ----------
log.info(`Scoring ${leads.length} leads.`);
for (const l of leads) {
    const tier = l.applyEmail ? 'qualified_lead' : ((l.applyUrl || l.website) ? 'lead' : 'listing');
    const score = Math.min(100, Math.round(
        (l.applyEmail ? 45 : 0) + ((l.applyUrl || l.website) ? 20 : 0)
        + (l.role ? 10 : 0) + (l.location ? 8 : 0) + (l.remote ? 8 : 0) + (l.salary ? 9 : 0),
    ));
    const row = {
        company: l.company,
        role: l.role,
        location: l.location,
        remote: l.remote,
        salary: l.salary,
        applyEmail: l.applyEmail,
        applyUrl: l.applyUrl,
        website: l.website,
        month: l.month,
        hnCommentUrl: l.hnCommentUrl,
        postedAt: l.postedAt,
        text: l.text,
        tier,
        leadScore: score,
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

// ---------- parsing ----------

function parsePost(c, month) {
    const html = c.text;
    // Apply URL: first non-HN external link in the markup, then bare URLs in text.
    const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    const text = clean(stripTags(decodeEntities(html)), 800);
    const bareUrl = (text.match(/https?:\/\/[^\s)]+/i) || [])[0] || null;
    const applyUrl = links.find((u) => /^https?:\/\//i.test(u) && !/news\.ycombinator\.com/i.test(u)) || bareUrl;

    const emailM = text.match(EMAIL_RE);
    const applyEmail = emailM && EMAIL_SHAPE.test(emailM[0].toLowerCase()) && !/noreply|no-reply|@example\./i.test(emailM[0])
        ? emailM[0].toLowerCase() : null;

    // First line, pipe-delimited: Company | Role | Location | Remote | Salary | ...
    const firstLine = text.split(/\s{2,}|\n|\. /)[0];
    const segs = firstLine.split('|').map((s) => s.trim()).filter(Boolean);
    let company = segs[0] || null;
    if (company) company = company.replace(/\(?\s*https?:\/\/[^\s)]+\s*\)?/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    const role = segs[1] ? segs[1].replace(/https?:\/\/\S+/g, '').trim().slice(0, 120) || null : null;
    const location = segs.find((s) => /remote|onsite|hybrid|[A-Z]{2}\b|,/.test(s) && s !== segs[0]) || segs[2] || null;
    const remote = /\bremote\b/i.test(firstLine) || /\bremote\b/i.test(text.slice(0, 200));
    const salary = (text.match(/\$\s?[0-9]{2,3}[kK](?:\s?[-–to]+\s?\$?\s?[0-9]{2,3}[kK])?/) || [])[0] || null;

    const website = applyUrl ? rootSite(applyUrl) : null;

    return {
        company,
        role,
        location: location ? location.slice(0, 80) : null,
        remote,
        salary,
        applyEmail,
        applyUrl,
        website,
        month,
        hnCommentUrl: `https://news.ycombinator.com/item?id=${c.id}`,
        postedAt: c.time ? new Date(c.time * 1000).toISOString() : null,
        text,
        _hay: `${company || ''} ${role || ''} ${text}`.toLowerCase(),
    };
}

function rootSite(u) {
    try {
        const host = new URL(u).hostname.toLowerCase();
        if (/ycombinator\.com|github\.com|google\.com|notion\.so|greenhouse\.io|lever\.co|ashbyhq\.com/i.test(host)) return u; // ATS/link, keep full
        return `https://${host.replace(/^www\./, '')}`;
    } catch { return null; }
}

function monthLabel(title) {
    const m = title.match(/\(([^)]+)\)/);
    return m ? m[1] : title;
}

// ---------- helpers ----------

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

function stripTags(s) { return s ? String(s).replace(/<\/p>/gi, '  ').replace(/<[^>]+>/g, ' ') : s; }

function decodeEntities(s) {
    if (!s) return s;
    return String(s)
        .replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&gt;/g, '>');
}

function clean(s, n = 300) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null : null; }

async function fetchJson(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(250 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-hn-leads/1.0', Accept: 'application/json' } });
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
