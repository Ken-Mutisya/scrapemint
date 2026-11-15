// ads.txt & app-ads.txt Checker
//
// Strategy
// --------
// For each domain we fetch /ads.txt and/or /app-ads.txt (IAB Tech Lab spec)
// and parse every line into ad system, seller account id, relationship
// (DIRECT / RESELLER) and certification authority id, plus the variables
// OWNERDOMAIN, MANAGERDOMAIN, CONTACT, SUBDOMAIN and INVENTORYPARTNERDOMAIN.
// Lines that break the spec (wrong field count, bad relationship, invalid ad
// system domain, duplicates) are reported as errors. A soft 404 (HTML page
// served at /ads.txt) is flagged as a missing file.
//
// Optional seller verification: each ad system's public sellers.json is
// downloaded once per run (following redirects, e.g. pubmatic.com ->
// cdn.pubmatic.com) and every seller id from the domain's file is looked up:
// found or not, seller_type (PUBLISHER / INTERMEDIARY / BOTH) vs. the declared
// relationship, seller name and domain. Large files (Google's is ~100 MB) are
// searched as text instead of parsed. No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   file_checked ($0.002) per ads.txt or app-ads.txt file found and parsed.
//   Missing files, unreachable domains and invalid inputs are free.
//   The first 3 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 3;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 20000;
const SELLERS_TIMEOUT_MS = 120000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SELLERS_BYTES = 160 * 1024 * 1024;
const MAX_ENTRIES_IN_ROW = 3000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

// Where an ad system's sellers.json lives when it is not https://<domain>/sellers.json.
const SELLERS_OVERRIDES = {
    'google.com': 'https://storage.googleapis.com/adx-rtb-dictionaries/sellers.json',
    'appnexus.com': 'https://www.appnexus.com/sellers.json',
    'xandr.com': 'https://www.appnexus.com/sellers.json',
    'triplelift.com': 'https://triplelift.com/sellers.json',
};
// Common aliases, so "google.com" and "doubleclick.net" count as the same system.
const ALIAS = { 'doubleclick.net': 'google.com', 'googlesyndication.com': 'google.com', 'adnxs.com': 'appnexus.com', 'xandr.com': 'appnexus.com' };

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    fileType = 'ads.txt',
    verifySellers = false,
    maxSellersFiles = 25,
    includeEntries = true,
    concurrency = 10,
    maxRows = 5000,
} = input;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 5000));
const conc = Math.max(1, Math.min(30, Number(concurrency) || 10));
const files = fileType === 'both' ? ['ads.txt', 'app-ads.txt'] : [fileType === 'app-ads.txt' ? 'app-ads.txt' : 'ads.txt'];

function normalize(s) {
    let d = String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').split('@').pop().split(':')[0].replace(/\.$/, '');
    d = d.replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && /[a-z]/.test(d.split('.').pop()) ? d : null;
}

const raw = (Array.isArray(domains) ? domains : String(domains || '').split(/[\n,]/)).map((s) => String(s || '').trim()).filter(Boolean);
const seen = new Set();
const targets = [];
const invalid = [];
for (const r of raw) {
    const d = normalize(r);
    if (!d) { invalid.push(r); continue; }
    for (const f of files) {
        const k = `${d}/${f}`;
        if (seen.has(k)) continue;
        seen.add(k);
        targets.push({ input: r, domain: d, file: f });
    }
    if (targets.length >= cap) break;
}
if (!targets.length) {
    await Actor.pushData({ note: 'No valid domains in input. Example: cnn.com' });
    await Actor.exit();
}
log.info(`Checking ${targets.length} files (${invalid.length} invalid inputs).`);

async function get(url, { timeout = FETCH_TIMEOUT_MS, maxBytes = MAX_FILE_BYTES } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/plain,application/json,*/*' } });
        if (!res.body) return { status: res.status, url: res.url, headers: res.headers, text: '' };
        const chunks = []; let size = 0; let truncated = false;
        for await (const c of res.body) {
            size += c.length;
            if (size > maxBytes) { truncated = true; break; }
            chunks.push(c);
        }
        if (truncated) ctrl.abort();
        return { status: res.status, url: res.url, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), truncated, size };
    } catch (err) {
        return { status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
    } finally { clearTimeout(t); }
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
function parse(text) {
    const entries = []; const errors = []; const vars = {};
    const dupKeys = new Set(); let duplicates = 0;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    lines.forEach((line, i) => {
        const l = line.replace(/#.*$/, '').trim();
        if (!l) return;
        const v = l.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
        if (v && !l.includes(',')) {
            const key = v[1].toUpperCase();
            (vars[key] ||= []).push(v[2].trim());
            return;
        }
        const f = l.split(',').map((x) => x.trim());
        const lineNo = i + 1;
        if (f.length < 3) { errors.push({ line: lineNo, text: line.slice(0, 200), error: 'fewer than 3 fields' }); return; }
        const adSystem = f[0].toLowerCase();
        const rel = f[2].toUpperCase();
        if (!DOMAIN_RE.test(adSystem)) errors.push({ line: lineNo, text: line.slice(0, 200), error: 'ad system is not a domain' });
        if (rel !== 'DIRECT' && rel !== 'RESELLER') { errors.push({ line: lineNo, text: line.slice(0, 200), error: `relationship must be DIRECT or RESELLER, got "${f[2]}"` }); return; }
        if (!f[1]) { errors.push({ line: lineNo, text: line.slice(0, 200), error: 'empty seller account id' }); return; }
        const key = `${adSystem}|${f[1].toLowerCase()}|${rel}`;
        if (dupKeys.has(key)) { duplicates += 1; return; }
        dupKeys.add(key);
        entries.push({ adSystem, sellerId: f[1], relationship: rel, certId: f[3] || null });
    });
    return { entries, errors, vars, duplicates };
}

// sellers.json cache: ad system -> Promise<{ok, url, text, size, truncated, error}>
const sellersCache = new Map();
let sellersFetched = 0;
function sellersFor(adSystem) {
    const sys = ALIAS[adSystem] || adSystem;
    if (sellersCache.has(sys)) return sellersCache.get(sys);
    if (sellersFetched >= Math.max(1, Number(maxSellersFiles) || 25)) return null;
    sellersFetched += 1;
    const p = (async () => {
        const candidates = SELLERS_OVERRIDES[sys] ? [SELLERS_OVERRIDES[sys]] : [`https://${sys}/sellers.json`, `https://www.${sys}/sellers.json`];
        let last = null;
        for (const u of candidates) {
            const r = await get(u, { timeout: SELLERS_TIMEOUT_MS, maxBytes: MAX_SELLERS_BYTES });
            last = r;
            if (r.status === 200 && /"sellers"\s*:/.test(r.text.slice(0, 1_000_000))) return { ok: true, url: r.url, text: r.text, truncated: r.truncated };
        }
        return { ok: false, url: candidates[0], error: last?.error || `HTTP ${last?.status}` };
    })();
    sellersCache.set(sys, p);
    return p;
}

// Find one seller object by id without parsing the whole file.
function lookupSeller(text, sellerId) {
    const esc = sellerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"seller_id"\\s*:\\s*"?${esc}"?\\s*[,}]`, 'i');
    const m = re.exec(text);
    if (!m) return null;
    const start = text.lastIndexOf('{', m.index);
    const end = text.indexOf('}', m.index);
    if (start < 0 || end < 0) return {};
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return {}; }
}

async function check(t) {
    const url = `https://${t.domain}/${t.file}`;
    let r = await get(url);
    if (!r.status || r.status >= 400) {
        const r2 = await get(`https://www.${t.domain}/${t.file}`);
        if (r2.status === 200) r = r2;
    }
    const base = { input: t.input, domain: t.domain, fileType: t.file, fileUrl: url };
    if (r.status !== 200) {
        return { ok: false, row: { ...base, found: false, httpStatus: r.status || null, error: r.error || `HTTP ${r.status}`, note: 'No file found. Not charged.', checkedAt: new Date().toISOString() } };
    }
    const ct = r.headers.get('content-type') || '';
    if (/<html|<!doctype/i.test(r.text.slice(0, 500)) || /text\/html/i.test(ct)) {
        return { ok: false, row: { ...base, found: false, httpStatus: 200, finalUrl: r.url, error: 'An HTML page is served at this path (soft 404), not a text file.', note: 'No valid file. Not charged.', checkedAt: new Date().toISOString() } };
    }
    const { entries, errors, vars, duplicates } = parse(r.text);
    const bySystem = {};
    for (const e of entries) {
        const s = (bySystem[e.adSystem] ||= { adSystem: e.adSystem, direct: 0, reseller: 0 });
        if (e.relationship === 'DIRECT') s.direct += 1; else s.reseller += 1;
    }
    const systems = Object.values(bySystem).sort((a, b) => (b.direct + b.reseller) - (a.direct + a.reseller));
    const direct = entries.filter((e) => e.relationship === 'DIRECT').length;

    let verification = null;
    if (verifySellers && entries.length) {
        const v = { checked: 0, found: 0, notFound: 0, typeMismatch: 0, unverifiable: 0, sellersFilesUnavailable: [] };
        for (const sys of systems.map((s) => s.adSystem)) {
            if (pastDeadline()) break;
            const pr = sellersFor(sys);
            const sf = pr ? await pr : null;
            const rows = entries.filter((e) => e.adSystem === sys);
            if (!sf || !sf.ok) {
                v.unverifiable += rows.length;
                if (sf && !sf.ok) v.sellersFilesUnavailable.push(sys);
                for (const e of rows) e.sellerVerified = null;
                continue;
            }
            for (const e of rows) {
                v.checked += 1;
                const s = lookupSeller(sf.text, e.sellerId);
                if (!s) { v.notFound += 1; e.sellerVerified = false; continue; }
                v.found += 1;
                e.sellerVerified = true;
                e.sellerType = s.seller_type ? String(s.seller_type).toUpperCase() : null;
                e.sellerName = s.name ?? null;
                e.sellerDomain = s.domain ?? null;
                e.sellerConfidential = s.is_confidential ? true : undefined;
                const mismatch = e.sellerType && ((e.relationship === 'DIRECT' && e.sellerType === 'INTERMEDIARY') || (e.relationship === 'RESELLER' && e.sellerType === 'PUBLISHER'));
                if (mismatch) { e.typeMismatch = true; v.typeMismatch += 1; }
            }
        }
        verification = v;
    }

    const first = (k) => vars[k]?.[0] ?? null;
    return {
        ok: true,
        row: {
            ...base,
            found: true,
            finalUrl: r.url !== url ? r.url : null,
            httpStatus: 200,
            sizeBytes: r.size ?? r.text.length,
            lastModified: r.headers.get('last-modified') || null,
            totalEntries: entries.length,
            directEntries: direct,
            resellerEntries: entries.length - direct,
            adSystemCount: systems.length,
            topAdSystems: systems.slice(0, 15),
            hasGoogleDirect: entries.some((e) => (ALIAS[e.adSystem] || e.adSystem) === 'google.com' && e.relationship === 'DIRECT'),
            ownerDomain: first('OWNERDOMAIN'),
            managerDomain: first('MANAGERDOMAIN'),
            contact: vars.CONTACT ?? [],
            subdomains: vars.SUBDOMAIN ?? [],
            inventoryPartnerDomains: vars.INVENTORYPARTNERDOMAIN ?? [],
            errorCount: errors.length,
            duplicateCount: duplicates,
            errors: errors.slice(0, 25),
            sellerVerification: verification,
            entries: includeEntries ? entries.slice(0, MAX_ENTRIES_IN_ROW) : undefined,
            entriesTruncated: includeEntries && entries.length > MAX_ENTRIES_IN_ROW ? true : undefined,
            checkedAt: new Date().toISOString(),
        },
    };
}

let chargeable = 0;
const stats = { files: targets.length, found: 0, missing: 0, invalidInputs: invalid.length, entries: 0 };
const sysCounts = {};
let idx = 0;
async function worker() {
    while (idx < targets.length) {
        if (pastDeadline()) return;
        const t = targets[idx++];
        let res;
        try { res = await check(t); } catch (err) { res = { ok: false, row: { input: t.input, domain: t.domain, fileType: t.file, found: null, error: String(err?.message || err), checkedAt: new Date().toISOString() } }; }
        await Actor.pushData(res.row);
        if (res.row.found) {
            stats.found += 1; stats.entries += res.row.totalEntries;
            for (const s of res.row.topAdSystems) sysCounts[s.adSystem] = (sysCounts[s.adSystem] || 0) + 1;
        } else stats.missing += 1;
        if (res.ok) {
            chargeable += 1;
            if (chargeable > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'file_checked' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    }
}
// Seller verification shares big downloads, so keep it gentler.
await Promise.all(Array.from({ length: verifySellers ? Math.min(conc, 4) : conc }, worker));
if (pastDeadline()) log.warning('Approaching run timeout; stopped early with results so far.');

for (const s of invalid.slice(0, 50)) await Actor.pushData({ input: s, note: 'Not a valid domain. Not charged.' });
const topSystems = Object.entries(sysCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([adSystem, domains]) => ({ adSystem, domains }));
const sellersFiles = [];
for (const [sys, p] of sellersCache) { const s = await p; sellersFiles.push({ adSystem: sys, ok: s.ok, url: s.url, error: s.error }); }
await Actor.setValue('SUMMARY', { ...stats, topAdSystems: topSystems, sellersFiles });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
