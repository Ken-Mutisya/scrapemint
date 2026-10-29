// Newly Registered Domain Leads: Daily New Domains by Keyword
//
// Strategy
// --------
// Download the free daily newly-registered-domains list (whoisds.com, a
// keyless ~70k-domain zip published one day behind), filter domains by
// buyer keywords and TLDs, then enrich each match with keyless DNS-over-
// HTTPS lookups (A record = resolving, MX = email configured, classified
// to a provider) and a live-site probe (HTTP status + page title). One
// row per matched domain. Optional cross-run dedupe turns a scheduled
// run into a daily new-prospect feed.
//
// Pay per event
// -------------
//   enriched_domain_row ($0.01) per pushed domain that yields DNS signal
//   (resolves or has MX). domain_row ($0.004) for unenriched rows and for
//   enriched domains with no DNS yet. First 2 rows per run are free.

import { Actor, log } from 'apify';
import zlib from 'node:zlib';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 8000;
const ENRICH_CONCURRENCY = 8;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    tlds = [],
    daysBack = 1,
    enrichWithDns = true,
    maxDomains = 50,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
const kws = asList(keywords);
const tldList = asList(tlds).map((t) => t.replace(/^\./, ''));
const days = Math.max(1, Math.min(7, Number(daysBack) || 1));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxDomains) || 50));

if (!kws.length && !tldList.length) {
    log.warning('Provide "keywords" and/or "tlds" — an unfiltered day is ~70,000 domains.');
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('nrd-seen') : null;
const seen = new Set();
if (seenStore) for (const d of (await seenStore.getValue('seen-domains')) || []) seen.add(String(d));

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            redirect: 'follow',
            ...opts,
            signal: controller.signal,
            headers: {
                'User-Agent': 'NewlyRegisteredDomainLeads/1.0 (+https://apify.com/scrapemint/newly-registered-domain-leads)',
                ...(opts.headers || {}),
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

// --- minimal ZIP reader (central directory) for the one-file NRD archive ---
function unzipFirstText(buf) {
    // Locate end-of-central-directory, walk entries, inflate the first .txt.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    let off = buf.readUInt32LE(eocd + 16);
    while (off + 46 <= buf.length && buf.readUInt32LE(off) === 0x02014b50) {
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        if (name.toLowerCase().endsWith('.txt')) {
            const lNameLen = buf.readUInt16LE(localOff + 26);
            const lExtraLen = buf.readUInt16LE(localOff + 28);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;
            const data = buf.subarray(dataStart, dataStart + compSize);
            return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

function nrdUrl(dateStr) {
    const b64 = Buffer.from(`${dateStr}.zip`).toString('base64');
    return `https://www.whoisds.com/whois-database/newly-registered-domains/${b64}/nrd`;
}

async function fetchDayList(dateStr) {
    try {
        const res = await fetchWithTimeout(nrdUrl(dateStr));
        if (!res.ok) { log.info(`No list for ${dateStr} (HTTP ${res.status}).`); return null; }
        const buf = Buffer.from(await res.arrayBuffer());
        const text = unzipFirstText(buf);
        if (!text) { log.warning(`Could not read zip for ${dateStr}.`); return null; }
        return text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
    } catch (err) {
        log.warning(`Fetch failed for ${dateStr}: ${err?.message}`);
        return null;
    }
}

async function doh(name, type) {
    for (const base of ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query']) {
        try {
            const res = await fetchWithTimeout(
                `${base}?name=${encodeURIComponent(name)}&type=${type}`,
                { headers: { accept: 'application/dns-json' } },
                10000,
            );
            if (!res.ok) continue;
            const d = await res.json();
            if (typeof d?.Status === 'number') return d;
        } catch { /* try next resolver */ }
    }
    return null;
}

function emailProvider(mxHosts) {
    const h = mxHosts.join(' ');
    if (/aspmx|google|googlemail/.test(h)) return 'google_workspace';
    if (/outlook|protection\.microsoft/.test(h)) return 'microsoft_365';
    if (/zoho/.test(h)) return 'zoho';
    if (/titan/.test(h)) return 'titan';
    if (/yandex/.test(h)) return 'yandex';
    if (/registrar-servers|privateemail/.test(h)) return 'namecheap';
    if (/mail\.protection|mxrecord|mx\d*\./.test(h)) return 'other';
    return mxHosts.length ? 'other' : null;
}

async function probeSite(domain) {
    try {
        const res = await fetchWithTimeout(`https://${domain}/`, {}, PROBE_TIMEOUT_MS);
        const html = (await res.text()).slice(0, 100000);
        const title = html.match(/<title[^>]*>([^<]{0,300})/i)?.[1]?.trim() || null;
        return { live: res.ok, status: res.status, finalUrl: res.url || null, title };
    } catch {
        return { live: false, status: null, finalUrl: null, title: null };
    }
}

async function enrich(domain) {
    const [a, mx] = await Promise.all([doh(domain, 'A'), doh(domain, 'MX')]);
    const ips = (a?.Answer || []).filter((r) => r.type === 1).map((r) => r.data);
    const mxHosts = (mx?.Answer || []).filter((r) => r.type === 15)
        .map((r) => String(r.data).split(/\s+/).pop()?.replace(/\.$/, '').toLowerCase()).filter(Boolean);
    const resolves = ips.length > 0;
    const site = resolves ? await probeSite(domain) : { live: false, status: null, finalUrl: null, title: null };
    return {
        resolves,
        ipAddress: ips[0] || null,
        hasMx: mxHosts.length > 0,
        mxHosts: mxHosts.length ? mxHosts : null,
        emailProvider: emailProvider(mxHosts),
        websiteLive: site.live,
        websiteStatus: site.status,
        websiteUrl: site.finalUrl,
        websiteTitle: site.title,
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- collect daily lists (published one day behind; tolerate gaps) ---
const matches = [];
let filesRead = 0;
let attempts = 0;
const d = new Date();
d.setUTCDate(d.getUTCDate() - 1);
while (filesRead < days && attempts < days + 3 && matches.length < cap) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const dateStr = d.toISOString().slice(0, 10);
    const list = await fetchDayList(dateStr);
    attempts += 1;
    d.setUTCDate(d.getUTCDate() - 1);
    if (!list) continue;
    filesRead += 1;
    let dayMatches = 0;
    for (const domain of list) {
        if (matches.length >= cap) break;
        if (seen.has(domain)) continue;
        if (tldList.length && !tldList.some((t) => domain.endsWith(`.${t}`))) continue;
        const kw = kws.length ? kws.find((k) => domain.includes(k)) : null;
        if (kws.length && !kw) continue;
        matches.push({ domain, registrationDate: dateStr, matchedKeyword: kw });
        dayMatches += 1;
    }
    log.info(`${dateStr}: ${list.length} new domains, ${dayMatches} match(es).`);
}

if (!filesRead) {
    log.error('No daily domain list could be fetched. The source may be down; try again later.');
    await Actor.exit();
}
log.info(`${matches.length} matched domain(s) from ${filesRead} day(s)${enrichWithDns ? ', enriching with DNS + site probe' : ''}.`);

for (let i = 0; i < matches.length; i += ENRICH_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = matches.slice(i, i + ENRICH_CONCURRENCY);
    const details = await Promise.all(batch.map((m) => (enrichWithDns ? enrich(m.domain) : Promise.resolve(null))));
    for (let j = 0; j < batch.length; j++) {
        const m = batch[j];
        const det = details[j];
        seen.add(m.domain);
        const dot = m.domain.indexOf('.');
        // Enriched price only when the lookup yielded signal; dead domains bill as basic rows.
        const eventName = det && (det.resolves || det.hasMx) ? 'enriched_domain_row' : 'domain_row';
        await flushRow({
            domain: m.domain,
            name: dot > 0 ? m.domain.slice(0, dot) : m.domain,
            tld: dot > 0 ? m.domain.slice(dot + 1) : null,
            registrationDate: m.registrationDate,
            matchedKeyword: m.matchedKeyword,
            ...(det || {}),
            source: 'whoisds.com daily NRD list',
            scrapedAt: new Date().toISOString(),
        }, eventName);
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-domains', [...seen].slice(-300000));
}

log.info(`Done. ${rowsPushed} domain row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
