// ATS Hiring-Signal Tracker
//
// Account intelligence, not lead discovery. You give it a list of target
// companies; it resolves each on Greenhouse and Lever (the public, keyless job
// board APIs) and returns the live hiring signal: open-role count, which
// departments are hiring, locations, senior-role count, newest posting, and the
// roles posted in the last 30 days. "Is this account hiring, and for what?"
//
// Buyers: B2B sales teams (hiring is a buying trigger), competitive intel, and
// recruiters tracking named accounts.
//
// Greenhouse: boards-api.greenhouse.io/v1/boards/{token}/jobs
// Lever:      api.lever.co/v0/postings/{token}?mode=json
// Both keyless. The company's ATS token defaults to a slug of its name; pass it
// explicitly as "greenhouse:token" or "lever:token" for an exact match.
//
// Pay-per-event: hot_account $0.15, active_account $0.08, quiet_account $0.03.
// Companies not found on any ATS are returned but never charged.
// First 5 hot_account per run are free so you can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_HOT = 5;
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead|director|vp|vice president|head of|chief|c[teo]o|cfo|cmo|cro)\b/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [],
    hotMinRoles = 10,
    maxCompanies = 200,
    concurrency = 5,
} = input;

const entries = [...new Set((Array.isArray(companies) ? companies : [companies]).map((c) => String(c || '').trim()).filter(Boolean))].slice(0, Math.max(1, Math.min(2000, Number(maxCompanies) || 200)));
if (entries.length === 0) throw new Error('Provide at least one company, e.g. ["Stripe","Ramp","greenhouse:airbnb"].');

const hotMin = Math.max(1, Number(hotMinRoles) || 10);
const pool = Math.max(1, Math.min(15, Number(concurrency) || 5));

let hotCharged = 0; let hotFree = 0; let active = 0; let quiet = 0; let notFound = 0;

const results = await mapWithConcurrency(entries, pool, resolveCompany);

log.info(`Scoring ${results.length} companies.`);
for (const r of results) {
    await Actor.pushData(r);
    if (r.status === 'not_found') { notFound += 1; continue; }
    if (r.tier === 'hot_account') {
        if (hotFree + hotCharged < FREE_TIER_HOT) hotFree += 1;
        else { await charge('hot_account'); hotCharged += 1; }
    } else if (r.tier === 'active_account') {
        await charge('active_account'); active += 1;
    } else {
        await charge('quiet_account'); quiet += 1;
    }
}

log.info(`Done. hot charged=${hotCharged} free=${hotFree}, active=${active}, quiet=${quiet}, not_found=${notFound}.`);
await Actor.exit();

// ---------- resolution ----------

async function resolveCompany(entry) {
    const { platform, tokens } = parseEntry(entry);
    let jobs = null; let used = null; let usedPlatform = null;

    for (const token of tokens) {
        if (!platform || platform === 'greenhouse') {
            const gh = await greenhouse(token);
            if (gh) { jobs = gh; used = token; usedPlatform = 'greenhouse'; break; }
        }
        if (!platform || platform === 'lever') {
            const lv = await lever(token);
            if (lv && lv.length) { jobs = lv; used = token; usedPlatform = 'lever'; break; }
        }
    }

    const company = displayName(entry);
    if (jobs == null) {
        return { company, status: 'not_found', atsPlatform: null, atsToken: null, openRoles: null, scrapedAt: new Date().toISOString() };
    }
    return { ...aggregate(jobs), company, status: 'found', atsPlatform: usedPlatform, atsToken: used, scrapedAt: new Date().toISOString() };
}

function parseEntry(s) {
    const m = s.match(/^(greenhouse|lever)\s*:\s*(.+)$/i);
    if (m) return { platform: m[1].toLowerCase(), tokens: [m[2].trim()] };
    const base = s.toLowerCase().trim();
    const cands = [
        base.replace(/[^a-z0-9]/g, ''),
        base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        base.split(/\s+/)[0].replace(/[^a-z0-9]/g, ''),
    ];
    return { platform: null, tokens: [...new Set(cands.filter(Boolean))] };
}

function displayName(s) {
    return s.replace(/^(greenhouse|lever)\s*:\s*/i, '').trim();
}

async function greenhouse(token) {
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`);
    if (!data || !Array.isArray(data.jobs)) return null; // 404 / unknown board -> null
    return data.jobs.map((j) => ({
        title: j.title || '',
        department: deptFromTitle(j.title),
        location: j.location?.name || null,
        postedMs: j.updated_at ? Date.parse(j.updated_at) : (j.first_published ? Date.parse(j.first_published) : null),
    }));
}

async function lever(token) {
    const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
    if (!Array.isArray(data)) return null;
    return data.map((p) => ({
        title: p.text || '',
        department: p.categories?.team || deptFromTitle(p.text),
        location: p.categories?.location || null,
        postedMs: p.createdAt ? Number(p.createdAt) : null,
    }));
}

// ---------- aggregation ----------

function aggregate(jobs) {
    const openRoles = jobs.length;
    const byDept = countBy(jobs.map((j) => j.department).filter(Boolean));
    const byLoc = countBy(jobs.map((j) => j.location).filter(Boolean));
    const seniorRoles = jobs.filter((j) => SENIOR_RE.test(j.title)).length;
    const newestMs = jobs.reduce((m, j) => Math.max(m, j.postedMs || 0), 0) || null;

    // Tier on open-role count only: Greenhouse's updated_at is bulk-refreshed, so
    // a "posted in last 30 days" metric would be misleading across platforms.
    const tier = openRoles >= hotMin ? 'hot_account' : (openRoles >= 1 ? 'active_account' : 'quiet_account');
    // Real departments first; "Other" is the unclassified bucket, not a signal.
    const signal = topEntries(byDept, 4).map((e) => e.name).filter((n) => n !== 'Other').slice(0, 3);

    return {
        tier,
        openRoles,
        seniorRoles,
        lastActivityDate: newestMs ? new Date(newestMs).toISOString().slice(0, 10) : null,
        departments: topEntries(byDept, 8),
        topLocations: topEntries(byLoc, 6).map((e) => e.name),
        sampleRoles: jobs.slice(0, 10).map((j) => j.title).filter(Boolean),
        hiringSignal: signal,
    };
}

function deptFromTitle(t) {
    const s = String(t || '').toLowerCase();
    if (/\b(engineer|developer|swe|sre|devops|platform|infrastructure|backend|frontend|full.?stack|mobile|data engineer|ml|machine learning)\b/.test(s)) return 'Engineering';
    if (/\b(sales|account executive|ae\b|sdr|bdr|account manager|revenue)\b/.test(s)) return 'Sales';
    if (/\b(market|growth|demand gen|content|brand|seo|social)\b/.test(s)) return 'Marketing';
    if (/\b(product manager|product owner|pm\b|product design|ux|ui|designer)\b/.test(s)) return 'Product & Design';
    if (/\b(recruit|people|talent|hr\b|human resources)\b/.test(s)) return 'People';
    if (/\b(finance|accounting|fp&a|controller|treasury)\b/.test(s)) return 'Finance';
    if (/\b(support|success|customer|csm)\b/.test(s)) return 'Customer';
    if (/\b(security|infosec|compliance|legal|counsel)\b/.test(s)) return 'Security & Legal';
    if (/\b(operations|ops|program|project)\b/.test(s)) return 'Operations';
    return 'Other';
}

// ---------- helpers ----------

function countBy(arr) {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
}
function topEntries(map, n) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
}

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(300 * i);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'scrapemint-ats-signal/1.0', Accept: 'application/json' } });
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
