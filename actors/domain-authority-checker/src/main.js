// Bulk Domain Authority Checker: Rank, Referring Domains & Age
//
// Strategy
// --------
// Three free, daily-updated top-1M lists, downloaded once per run:
//   - Majestic Million (CSV, ~80 MB): rank by referring IP subnets, the
//     link-based authority signal. Gives RefSubNets, RefIPs and yesterday's
//     rank for movement.
//   - Tranco (zip, ~10 MB): research-grade popularity rank that averages
//     several providers over 30 days.
//   - Cisco Umbrella (zip, ~13 MB): DNS query popularity.
// Lists are streamed and only the buyer's domains are kept in memory. Each
// domain then gets an optional RDAP lookup (registration date, expiry,
// registrar) and an optional Wayback first-capture date. We compute a 0-100
// authority score from referring subnets (log scale, normalized to #1) and
// Tranco rank. Domains outside every list are reported as unranked. No API
// key, no proxy, no browser.
//
// Pay per event
// -------------
//   domain_checked ($0.002) per domain row that returned any data (a rank,
//   a registration record or a Wayback date). Domains with no data at all
//   and invalid inputs are free. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;
const LOOKUP_CONCURRENCY = 8;
const MAJESTIC_URL = 'https://downloads.majestic.com/majestic_million.csv';
const TRANCO_URL = 'https://tranco-list.eu/top-1m.csv.zip';
const UMBRELLA_URL = 'http://s3-us-west-1.amazonaws.com/umbrella-static/top-1m.csv.zip';
const UA = 'Mozilla/5.0 (compatible; DomainAuthorityChecker/1.0; +https://apify.com/scrapemint/domain-authority-checker)';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    includeDomainAge = true,
    includeWaybackFirstSeen = false,
    maxRows = 5000,
} = input;

const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 5000));
const raw = (Array.isArray(domains) ? domains : String(domains || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

function normalize(s) {
    let d = s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').split('@').pop().split(':')[0];
    d = d.replace(/^www\d?\./, '').replace(/\.$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && /[a-z]/.test(d.split('.').pop()) ? d : null;
}

// Second-level public suffixes common enough to matter for the parent fallback.
const TWO_LEVEL = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
function parentDomain(d) {
    const parts = d.split('.');
    const keep = TWO_LEVEL.test(d) ? 3 : 2;
    return parts.length > keep ? parts.slice(-keep).join('.') : null;
}

const items = [];
const invalid = [];
const seenInput = new Set();
for (const s of raw) {
    const d = normalize(s);
    if (!d) { invalid.push(s); continue; }
    if (seenInput.has(d)) continue;
    seenInput.add(d);
    items.push({ input: s, domain: d, parent: parentDomain(d) });
    if (items.length >= cap) break;
}
if (!items.length) {
    await Actor.pushData({ note: 'Provide "domains": a list of domains or URLs, e.g. ["apify.com", "https://www.shopify.com"]. Not charged.' });
    await Actor.exit();
}
const wanted = new Set(items.flatMap((i) => [i.domain, i.parent].filter(Boolean)));
log.info(`Checking ${items.length} domain(s)${invalid.length ? `, ${invalid.length} invalid skipped` : ''}.`);

async function fetchRes(url, timeoutMs = 120000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    return { res, done: () => clearTimeout(timer) };
}

// Stream a CSV body line by line; onLine returns nothing.
async function streamLines(body, onLine) {
    const rl = readline.createInterface({ input: Readable.fromWeb(body), crlfDelay: Infinity });
    for await (const line of rl) onLine(line);
}

function unzipFirst(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const off = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const localOff = buf.readUInt32LE(off + 42);
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(start, start + compSize);
    return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
}

const sources = {};

async function loadMajestic() {
    const map = new Map();
    let topSubnets = null;
    const t = Date.now();
    const { res, done } = await fetchRes(MAJESTIC_URL, 300000);
    try {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sources.majestic = { lastModified: res.headers.get('last-modified') };
        let header = true;
        await streamLines(res.body, (line) => {
            if (header) { header = false; return; }
            // GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs
            const c = line.split(',');
            if (topSubnets == null) topSubnets = Number(c[4]);
            if (!wanted.has(c[2])) return;
            map.set(c[2], {
                globalRank: Number(c[0]), tldRank: Number(c[1]), refSubNets: Number(c[4]), refIPs: Number(c[5]),
                prevGlobalRank: Number(c[8]) > 0 ? Number(c[8]) : null, prevRefSubNets: Number(c[10]) > 0 ? Number(c[10]) : null,
            });
        });
    } finally { done(); }
    sources.majestic.topRefSubNets = topSubnets;
    log.info(`Majestic Million loaded in ${((Date.now() - t) / 1000).toFixed(1)}s, ${map.size} match(es).`);
    return { map, topSubnets };
}

async function loadZipRanks(name, url) {
    const map = new Map();
    const t = Date.now();
    const { res, done } = await fetchRes(url);
    try {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sources[name] = { lastModified: res.headers.get('last-modified') };
        const text = unzipFirst(Buffer.from(await res.arrayBuffer()));
        if (!text) throw new Error('could not read zip');
        let i = 0;
        while (i < text.length) {
            let j = text.indexOf('\n', i);
            if (j < 0) j = text.length;
            const comma = text.indexOf(',', i);
            if (comma > i && comma < j) {
                const d = text.slice(comma + 1, j).trim().toLowerCase();
                if (wanted.has(d) && !map.has(d)) map.set(d, Number(text.slice(i, comma)));
            }
            i = j + 1;
        }
    } finally { done(); }
    log.info(`${name} list loaded in ${((Date.now() - t) / 1000).toFixed(1)}s, ${map.size} match(es).`);
    return map;
}

const settle = async (name, p) => {
    try { return await p; } catch (err) {
        log.warning(`${name} list unavailable: ${err?.message}. Continuing without it.`);
        sources[name] = { error: err?.message };
        return null;
    }
};
const [maj, tranco, umbrella] = await Promise.all([
    settle('majestic', loadMajestic()),
    settle('tranco', loadZipRanks('tranco', TRANCO_URL)),
    settle('umbrella', loadZipRanks('umbrella', UMBRELLA_URL)),
]);
const majMap = maj?.map || new Map();
const topSubnets = maj?.topSubnets || 500000;
const trancoMap = tranco || new Map();
const umbrellaMap = umbrella || new Map();

async function getJson(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'application/rdap+json, application/json' } });
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; } finally { clearTimeout(timer); }
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

async function waybackFirst(domain) {
    const d = await getJson(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp`, 30000);
    const ts = d?.[1]?.[0];
    return ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null;
}

const linkScore = (subnets) => (subnets > 0 ? Math.round((100 * Math.log1p(subnets)) / Math.log1p(topSubnets)) : null);
const popularityScore = (rank) => (rank > 0 ? Math.max(0, Math.round(100 * (1 - Math.log10(rank) / 6))) : null);
function tier(score) {
    if (score == null) return 'unranked (outside top 1M)';
    if (score >= 80) return 'elite';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
}

let rowsPushed = 0;
let chargeable = 0;
async function flushRow(row, hasData) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!hasData) return;
    chargeable += 1;
    if (chargeable > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'domain_checked' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const yearsSince = (iso) => (iso ? Math.round(((Date.now() - Date.parse(iso)) / (365.25 * 86400000)) * 10) / 10 : null);
const stats = { domains: items.length, inMajestic: 0, inTranco: 0, unranked: 0, invalid: invalid.length };

for (let i = 0; i < items.length; i += LOOKUP_CONCURRENCY) {
    if (pastDeadline()) { log.warning('Approaching run timeout; stopping early with results so far.'); break; }
    const batch = items.slice(i, i + LOOKUP_CONCURRENCY);
    const extra = await Promise.all(batch.map(async (it) => {
        const regDomain = it.parent || it.domain;
        const [r, w] = await Promise.all([
            includeDomainAge ? rdap(regDomain) : null,
            includeWaybackFirstSeen ? waybackFirst(it.domain) : null,
        ]);
        return { r, w };
    }));
    for (let j = 0; j < batch.length; j++) {
        const it = batch[j];
        // Exact host first; a subdomain falls back to its parent's ranks.
        const pick = (m) => (m.has(it.domain) ? [m.get(it.domain), it.domain] : it.parent && m.has(it.parent) ? [m.get(it.parent), it.parent] : [null, null]);
        const [m, mFrom] = pick(majMap);
        const [tr, tFrom] = pick(trancoMap);
        const [um] = pick(umbrellaMap);
        const ls = m ? linkScore(m.refSubNets) : null;
        const ps = tr ? popularityScore(tr) : null;
        const parts = [ls, ps].filter((v) => v != null);
        const score = parts.length ? Math.round(ls != null && ps != null ? 0.7 * ls + 0.3 * ps : parts[0]) : null;
        if (m) stats.inMajestic += 1;
        if (tr) stats.inTranco += 1;
        if (score == null) stats.unranked += 1;
        const { r, w } = extra[j];
        await flushRow({
            domain: it.domain,
            input: it.input,
            authorityScore: score,
            authorityTier: tier(score),
            linkScore: ls,
            popularityScore: ps,
            referringSubnets: m?.refSubNets ?? null,
            referringIps: m?.refIPs ?? null,
            referringSubnetsChange: m && m.prevRefSubNets != null ? m.refSubNets - m.prevRefSubNets : null,
            majesticRank: m?.globalRank ?? null,
            majesticRankChange: m && m.prevGlobalRank != null ? m.prevGlobalRank - m.globalRank : null,
            majesticTldRank: m?.tldRank ?? null,
            trancoRank: tr ?? null,
            umbrellaRank: um ?? null,
            rankedAs: mFrom || tFrom || null,
            inTop1M: !!(m || tr || um),
            domainCreatedAt: r?.createdAt ?? null,
            domainAgeYears: yearsSince(r?.createdAt),
            domainExpiresAt: r?.expiresAt ?? null,
            registrar: r?.registrar ?? null,
            waybackFirstSeen: w ?? null,
            checkedAt: new Date().toISOString(),
        }, !!(m || tr || um || r || w));
    }
}

for (const s of invalid.slice(0, 50)) await Actor.pushData({ input: s, note: 'Not a valid domain. Not charged.' });
await Actor.setValue('SUMMARY', { ...stats, rows: rowsPushed, sources });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
