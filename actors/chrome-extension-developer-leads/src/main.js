// Chrome Extension Developer Leads: Publisher Contacts
//
// Strategy
// --------
// Chrome Web Store pages are server-rendered and keyless. Category and search
// pages carry extension ids in plain HTML; each detail page embeds an
// AF_initDataCallback JSON blob whose developer node includes the contact
// email for every publisher and, for EU trader-disclosure publishers, also a
// phone number, physical address, and legal entity name. We discover
// extensions per keyword/category (plus a one-hop related-extension fan-out),
// parse each detail page's blob, and aggregate one lead row per DEVELOPER.
// No browser, no proxy, no website scraping: the store itself publishes the
// contact data.
//
// Buyers: devtool/API/SaaS vendors selling to extension builders, AI-tooling
// companies, martech agencies, and recruiters sourcing shipped-product devs.
//
// Pay per event
// -------------
//   developer_contact_row ($0.01) per developer pushed WITH an email or phone.
//   developer_row ($0.004) for the rest. First 2 rows per run are free.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const FETCH_TIMEOUT_MS = 30000;
const BASE = 'https://chromewebstore.google.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ID_RE = /\/detail\/(?:[^/"'\s]+\/)?([a-p]{32})/g;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    categories = [],
    minUsers = 0,
    maxDevelopers = 50,
    followRelated = true,
    concurrency = 6,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = [...new Set(asList(keywords))];
const cats = [...new Set(asList(categories).map((c) => c.toLowerCase().replace(/^\/+|\/+$/g, '')))];
if (kws.length === 0 && cats.length === 0) {
    throw new Error('Provide at least one keyword (e.g. ["crm","screenshot"]) or category (e.g. ["productivity/workflow"]).');
}
const minU = Math.max(0, Number(minUsers) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxDevelopers) || 50));
const pool = Math.max(1, Math.min(12, Number(concurrency) || 6));
// Each detail page is one ~700KB HTTP fetch; bound total work per run.
const detailCap = Math.min(1500, cap * 3);

const seenStore = dedupe ? await Actor.openKeyValueStore('chrome-developers-seen') : null;
const seen = new Set();
if (seenStore) for (const id of (await seenStore.getValue('seen-developers')) || []) seen.add(String(id));

// ---------- Stage 1: discover extension ids from listing pages ----------
const queue = []; // extension ids in discovery order (listing order ~ popularity)
const queued = new Set();
const enqueue = (id) => { if (id && !queued.has(id)) { queued.add(id); queue.push(id); } };

for (const cat of cats) {
    if (pastDeadline()) break;
    const html = await fetchText(`${BASE}/category/extensions/${cat}`);
    const n = harvestIds(html);
    log.info(`category "${cat}": +${n} extensions (queue ${queue.length}).`);
}
for (const kw of kws) {
    if (pastDeadline()) break;
    const html = await fetchText(`${BASE}/search/${encodeURIComponent(kw)}`);
    const n = harvestIds(html);
    log.info(`search "${kw}": +${n} extensions (queue ${queue.length}).`);
}
if (queue.length === 0) { log.warning('No extensions discovered. Check keyword/category spelling (categories use store slugs like "productivity/workflow").'); await Actor.exit(); }

function harvestIds(html) {
    if (!html) return 0;
    let n = 0;
    for (const m of html.matchAll(ID_RE)) { if (!queued.has(m[1])) { enqueue(m[1]); n += 1; } }
    return n;
}

// ---------- Stage 2: fetch detail pages, aggregate per developer ----------
const developers = new Map(); // devKey -> aggregate
let fetched = 0;

async function processDetail(extId) {
    const html = await fetchText(`${BASE}/detail/${extId}`);
    fetched += 1;
    if (!html) return;
    // One-hop fan-out: related extensions on the detail page extend discovery.
    if (followRelated && queue.length < detailCap) harvestIds(html);

    const blob = extractBlob(html);
    if (!blob) { log.debug(`no data blob for ${extId}`); return; }
    const ext = blob[0] || [];
    const dev = blob[10] || [];
    const email = cleanEmail(dev[0]);
    const devKey = dev[10] || email || cleanStr(dev[5]) || `ext:${extId}`;

    let agg = developers.get(devKey);
    if (!agg) {
        agg = {
            devKey,
            developer: cleanStr(dev[5]) || cleanStr(dev[7]) || null,
            legalEntity: cleanStr(dev[6]) || null,
            isTrader: dev[3] === 1,
            email,
            phone: cleanStr(dev[9]) || null,
            address: dev[1] ? String(dev[1]).replace(/\n/g, ', ').trim() : null,
            website: siteUrl(ext[7]),
            extensions: [],
            extensionCount: 0,
            totalUsers: 0,
            ratingSum: 0,
            ratingCount: 0,
            categories: new Set(),
        };
        developers.set(devKey, agg);
    }
    if (!agg.email && email) agg.email = email;
    if (!agg.website) agg.website = siteUrl(ext[7]);
    if (Array.isArray(ext[11]) && ext[11][0]) agg.categories.add(String(ext[11][0]));
    if (agg.extensions.some((x) => x.id === extId)) return;
    const users = Number(ext[14]) || 0;
    agg.extensionCount += 1;
    agg.totalUsers += users;
    if (typeof ext[3] === 'number' && Number(ext[4])) {
        agg.ratingSum += ext[3] * Number(ext[4]);
        agg.ratingCount += Number(ext[4]);
    }
    agg.extensions.push({
        id: extId,
        title: cleanStr(ext[2]),
        users,
        rating: typeof ext[3] === 'number' ? Math.round(ext[3] * 100) / 100 : null,
        ratingCount: Number(ext[4]) || null,
        url: `${BASE}/detail/${extId}`,
    });
}

// Workers drain the queue, which can grow behind them via the related fan-out.
let cursor = 0;
async function worker() {
    while (cursor < queue.length && fetched < detailCap && !pastDeadline()) {
        const i = cursor++;
        try { await processDetail(queue[i]); }
        catch (e) { log.debug(`detail ${queue[i]} failed: ${e?.message}`); }
    }
}
await Promise.all(Array.from({ length: pool }, worker));
log.info(`Fetched ${fetched} detail pages, ${developers.size} distinct developers.`);

// ---------- Stage 3: filter, rank, cap ----------
let leads = [...developers.values()].filter((d) => d.totalUsers >= minU);
if (seen.size) leads = leads.filter((d) => !seen.has(d.devKey));
leads.sort((a, b) => b.totalUsers - a.totalUsers);
leads = leads.slice(0, cap);
log.info(`${leads.length} developer leads after filters (minUsers=${minU}, cap=${cap}).`);
if (leads.length === 0) { log.warning('No developers passed filters.'); await Actor.exit(); }

// ---------- Stage 4: MX check, push, charge ----------
let rowsPushed = 0; let contactRows = 0; let basicRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

for (const d of leads) {
    const hasContact = Boolean(d.email || d.phone);
    const emailDomain = d.email ? d.email.split('@')[1] : null;
    const row = {
        developer: d.developer,
        legalEntity: d.legalEntity,
        isTrader: d.isTrader,
        email: d.email,
        phone: d.phone,
        address: d.address,
        website: d.website,
        mxFound: emailDomain && !pastDeadline() ? await hasMx(emailDomain) : null,
        extensionCount: d.extensionCount,
        totalUsers: d.totalUsers,
        avgRating: d.ratingCount ? Math.round((d.ratingSum / d.ratingCount) * 100) / 100 : null,
        topExtensions: d.extensions.sort((a, b) => b.users - a.users).slice(0, 5),
        categories: [...d.categories].slice(0, 8),
        scrapedAt: new Date().toISOString(),
    };
    await flushRow(row, hasContact ? 'developer_contact_row' : 'developer_row');
    if (hasContact) contactRows += 1; else basicRows += 1;
    seen.add(d.devKey);
}

if (seenStore) await seenStore.setValue('seen-developers', [...seen].slice(-50000));
log.info(`Done. ${rowsPushed} developer row(s) pushed: ${contactRows} with contact, ${basicRows} without (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();

// ---------- parsing ----------

function extractBlob(html) {
    const m = html.match(/AF_initDataCallback\(\{key: 'ds:0'.*?data:(\[.*?\]), sideChannel/s);
    if (!m) return null;
    try {
        const data = JSON.parse(m[1]);
        return Array.isArray(data) && Array.isArray(data[0]) ? data : null;
    } catch { return null; }
}

function cleanStr(s) { return s ? String(s).replace(/\s+/g, ' ').trim().slice(0, 300) || null : null; }

function cleanEmail(s) {
    const e = String(s || '').trim().toLowerCase();
    return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e) ? e : null;
}

function siteUrl(u) {
    const s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    if (/chromewebstore\.google\.com|chrome\.google\.com/i.test(s)) return null;
    return s.slice(0, 300);
}

async function hasMx(domain) {
    try {
        const records = await Promise.race([
            dns.resolveMx(domain),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        return Array.isArray(records) && records.length > 0;
    } catch { return false; }
}

// ---------- shared ----------

async function fetchText(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        if (i) await sleep(800 * i);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                redirect: 'follow',
                headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
            });
            if (res.ok) return await res.text();
            if (res.status === 404) return null;
            if (res.status >= 500 || res.status === 429) continue;
            log.warning(`HTTP ${res.status} for ${url}`);
            return null;
        } catch (err) {
            if (i === attempts - 1) log.debug(`fetch failed ${url}: ${err?.message}`);
        } finally { clearTimeout(timer); }
    }
    return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
