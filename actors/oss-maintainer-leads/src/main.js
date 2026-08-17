// Open Source Maintainer Leads (npm & PyPI)
//
// Turns the npm and PyPI registries into B2B leads. For each keyword it finds
// packages and returns the maintainer/author public email, package name,
// repository, homepage, monthly downloads (qualification), and last publish date.
// One lead per package.
//
// Buyers: developer-tool SaaS, supply-chain security vendors, DevRel/community
// teams, and technical recruiters who target open-source maintainers.
//
// npm: keyless registry search (full keyword search) + package doc (author and
//   maintainer emails) + downloads API.
// PyPI: keyword search is bot-blocked, so we name-filter the canonical simple
//   index (all 800k+ projects), prioritising exact/prefix matches, then read each
//   package's JSON for author_email / maintainer_email.
//
// Pay-per-event: qualified_lead $0.05, lead $0.02, listing $0.01.
// First 10 qualified_lead per run are free so you can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_QUALIFIED = 1;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    registries = 'both',
    maxLeads = 25,
    maxPerKeyword = 80,
    minMonthlyDownloads = 0,
    qualifiedMinDownloads = 1000,
    requireEmail = false,
    concurrency = 8,
} = input;

const cleanKeywords = [...new Set((Array.isArray(keywords) ? keywords : [keywords]).map((k) => String(k || '').trim()).filter(Boolean))];
if (cleanKeywords.length === 0) throw new Error('Provide at least one keyword, e.g. ["testing","stripe","django"].');

const reg = String(registries || 'both').toLowerCase();
const doNpm = reg === 'npm' || reg === 'both';
const doPypi = reg === 'pypi' || reg === 'both';
const leadCap = Math.max(1, Math.min(5000, Number(maxLeads) || 200));
const perKwCap = Math.max(1, Math.min(250, Number(maxPerKeyword) || 80));
const minDl = Math.max(0, Number(minMonthlyDownloads) || 0);
const qualDl = Math.max(0, Number(qualifiedMinDownloads) || 1000);
const pool = Math.max(1, Math.min(20, Number(concurrency) || 8));

let qualifiedCharged = 0; let qualifiedFree = 0; let leadCount = 0; let listingCount = 0;
let pypiIndexCache = null; // declared up here so top-level collection can use it (no TDZ)

// ---------- Stage 1: collect candidate package refs ----------
const refs = []; // { registry, name }
const seen = new Set();
const addRef = (registry, name) => {
    const key = `${registry}:${name}`;
    if (!name || seen.has(key) || refs.length >= leadCap * 2) return;
    seen.add(key); refs.push({ registry, name });
};

if (doNpm) {
    for (const kw of cleanKeywords) {
        let added = 0;
        for (let from = 0; from < perKwCap && added < perKwCap; from += 250) {
            const size = Math.min(250, perKwCap - added);
            const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(kw)}&size=${size}&from=${from}`);
            const objs = data?.objects || [];
            if (objs.length === 0) break;
            for (const o of objs) { addRef('npm', o.package?.name); added += 1; }
            if (objs.length < size) break;
        }
        log.info(`npm "${kw}": +${added} candidates (total ${refs.length}).`);
    }
}

if (doPypi) {
    const names = await loadPypiIndex();
    if (names) {
        for (const kw of cleanKeywords) {
            const low = kw.toLowerCase();
            const matches = names.filter((n) => n.toLowerCase().includes(low));
            // Rank: exact, then prefix, then shortest (real projects beat noisy forks).
            matches.sort((a, b) => rankName(a, low) - rankName(b, low) || a.length - b.length);
            let added = 0;
            for (const n of matches) { if (added >= perKwCap) break; addRef('pypi', n); added += 1; }
            log.info(`pypi "${kw}": ${matches.length} name matches, took ${added} (total ${refs.length}).`);
        }
    }
}

if (refs.length === 0) { log.warning('No candidate packages found.'); await Actor.exit(); }
log.info(`Enriching ${Math.min(refs.length, leadCap)} of ${refs.length} candidates.`);

// ---------- Stage 2: enrich each candidate into a lead ----------
const candidates = refs.slice(0, leadCap);
const leads = (await mapWithConcurrency(candidates, pool, async (r) => {
    try { return r.registry === 'npm' ? await enrichNpm(r.name) : await enrichPypi(r.name); }
    catch (e) { log.debug(`enrich ${r.registry}:${r.name} failed: ${e?.message}`); return null; }
})).filter(Boolean);

// ---------- Stage 3: filter, score, tier, push, charge ----------
log.info(`Scoring ${leads.length} leads.`);
for (const l of leads) {
    if (minDl > 0 && (l.monthlyDownloads || 0) < minDl) continue;
    if (requireEmail && !l.email) continue;

    const dlScore = scoreDownloads(l.monthlyDownloads);
    const contactScore = (l.email ? 30 : 0) + (l.repository ? 6 : 0) + (l.homepage ? 4 : 0);
    const recScore = recency(l.lastPublishedMs);
    const leadScore = Math.min(100, Math.round(dlScore + contactScore + recScore));

    const tier = (l.email && (l.monthlyDownloads || 0) >= qualDl) ? 'qualified_lead'
        : ((l.email || l.repository) ? 'lead' : 'listing');

    const row = { ...l, tier, leadScore, scoredAt: new Date().toISOString() };
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

// ---------- npm enrichment ----------

async function enrichNpm(name) {
    const d = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`);
    if (!d || !d.name) return null;
    const emails = [];
    if (d.author?.email) emails.push(d.author.email);
    for (const m of d.maintainers || []) if (m?.email) emails.push(m.email);
    const cleanEmails = dedupeEmails(emails);
    const monthlyDownloads = await npmDownloads(name);
    const lastMs = d.time?.modified ? Date.parse(d.time.modified) : null;
    return {
        registry: 'npm',
        name: d.name,
        url: `https://www.npmjs.com/package/${d.name}`,
        description: clean(d.description),
        author: d.author?.name || (d.maintainers?.[0]?.name) || null,
        email: cleanEmails[0] || null,
        emails: cleanEmails,
        maintainers: (d.maintainers || []).map((m) => m.name).filter(Boolean).slice(0, 8),
        repository: repoUrl(d.repository?.url || d.repository),
        homepage: webUrl(d.homepage),
        monthlyDownloads,
        lastPublished: d.time?.modified || null,
        lastPublishedMs: lastMs,
    };
}

async function npmDownloads(name) {
    const d = await fetchJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`, 2);
    return Number.isFinite(d?.downloads) ? d.downloads : null;
}

// ---------- PyPI enrichment ----------

async function loadPypiIndex() {
    if (pypiIndexCache) return pypiIndexCache;
    log.info('Loading PyPI simple index (one-time ~40MB)...');
    const d = await fetchJson('https://pypi.org/simple/', 2, { Accept: 'application/vnd.pypi.simple.v1+json' });
    pypiIndexCache = (d?.projects || []).map((p) => p.name);
    log.info(`PyPI index loaded: ${pypiIndexCache.length} projects.`);
    return pypiIndexCache.length ? pypiIndexCache : null;
}

async function enrichPypi(name) {
    const d = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    const info = d?.info;
    if (!info) return null;
    const emails = dedupeEmails([
        ...extractEmails(info.author_email),
        ...extractEmails(info.maintainer_email),
    ]);
    const urls = info.project_urls || {};
    const repo = repoUrl(Object.entries(urls).find(([k]) => /source|repo|github|code/i.test(k))?.[1]);
    const home = webUrl(info.home_page || urls.Homepage || urls.Home);
    // Latest release upload time.
    let lastMs = null; let lastIso = null;
    const files = d.urls || [];
    if (files[0]?.upload_time_iso_8601) { lastIso = files[0].upload_time_iso_8601; lastMs = Date.parse(lastIso); }
    const monthlyDownloads = await pypiDownloads(name);
    return {
        registry: 'pypi',
        name: info.name || name,
        url: `https://pypi.org/project/${info.name || name}/`,
        description: clean(info.summary),
        author: info.author || info.maintainer || stripEmail(info.author_email) || null,
        email: emails[0] || null,
        emails,
        maintainers: [info.maintainer || info.author].filter(Boolean).slice(0, 8),
        repository: repo,
        homepage: home,
        monthlyDownloads,
        lastPublished: lastIso,
        lastPublishedMs: lastMs,
    };
}

async function pypiDownloads(name) {
    const d = await fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`, 2);
    return Number.isFinite(d?.data?.last_month) ? d.data.last_month : null;
}

// ---------- scoring ----------

function scoreDownloads(dl) {
    const v = dl || 0;
    if (v >= 1_000_000) return 50;
    if (v >= 100_000) return 42;
    if (v >= 10_000) return 32;
    if (v >= 1_000) return 22;
    if (v >= 100) return 12;
    return v > 0 ? 5 : 0;
}

function recency(ms) {
    if (!ms) return 2;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 90) return 14;
    if (d <= 365) return 8;
    if (d <= 730) return 4;
    return 1;
}

// ---------- helpers ----------

function rankName(name, kw) {
    const n = name.toLowerCase();
    if (n === kw) return 0;
    if (n.startsWith(kw)) return 1;
    if (n.startsWith(`${kw}-`) || n.startsWith(`${kw}_`)) return 1;
    return 2;
}

function extractEmails(s) {
    if (!s) return [];
    return [...String(s).matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
}

function dedupeEmails(arr) {
    const set = new Set();
    for (const e of arr) {
        const x = String(e || '').toLowerCase().trim();
        if (!EMAIL_SHAPE.test(x)) continue;
        if (/noreply|no-reply|\.invalid$|@example\.|users\.noreply\.github|npm@npmjs|@npmjs\.com$/i.test(x)) continue;
        set.add(x);
    }
    return [...set];
}

function stripEmail(s) {
    if (!s) return null;
    const name = String(s).replace(/<[^>]*>/g, '').replace(EMAIL_RE, '').replace(/[,"]/g, ' ').trim();
    return name || null;
}

function repoUrl(u) {
    if (!u) return null;
    let s = String(typeof u === 'object' ? (u.url || '') : u).trim();
    if (!s) return null;
    s = s.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '').replace(/^ssh:\/\/git@/, 'https://').replace(/git@github\.com:/, 'https://github.com/');
    return /^https?:\/\//.test(s) ? s : null;
}

function webUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : null;
}

function clean(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null; }

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

async function fetchJson(url, attempts = 4, extraHeaders = {}) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(250 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-oss-leads/1.0', Accept: 'application/json', ...extraHeaders } });
            if (res.ok) return await res.json();
            if (res.status === 404) return null;
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
