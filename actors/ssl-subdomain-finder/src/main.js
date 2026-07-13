// SSL Certificate & Subdomain Finder for Any Website
//
// Strategy
// --------
// Two keyless sources, no browser, no proxy, no API key:
//   1. crt.sh certificate transparency search (JSON) — every subdomain that
//      has ever appeared in a public SSL certificate for the domain. This is
//      the standard passive way to enumerate subdomains.
//   2. Outbound TLS (node:tls) — connect to each subdomain on 443 and read
//      its LIVE certificate: issuer, valid dates, days to expiry, and whether
//      it is valid right now. rejectUnauthorized:false so we can still read
//      and report expired/self-signed certs instead of erroring out.
//
// One row per unique subdomain, enriched with the newest cert seen in the CT
// logs plus (optionally) the live certificate.
//
// Pay per event
// -------------
//   subdomain_found per pushed row. First 2 rows per run are free.

import { Actor, log } from 'apify';
import tls from 'node:tls';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const CRT_TIMEOUT_MS = 45000;
const TLS_TIMEOUT_MS = 8000;
const TLS_CONCURRENCY = 12;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    checkLiveCert = true,
    maxRows = 300,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const cleanDomain = (d) => String(d || '')
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '')
    .trim().toLowerCase();

const domainList = [...new Set(asTokens(domains).map(cleanDomain).filter((d) => /\.[a-z]{2,}$/i.test(d)))];
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 300));

if (domainList.length === 0) {
    log.warning('No valid domains given. Add at least one domain, e.g. github.com.');
    await Actor.exit();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CRT_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-ssl-subdomain-finder/0.1 (+https://apify.com)', accept: 'application/json' },
        });
        if ([502, 503, 504, 429].includes(res.status)) throw new Error(`HTTP ${res.status} (transient)`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.trim()) throw new Error('empty response');
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

// Certificate transparency source, normalized to { names[], issuer, notBefore,
// notAfter }. Primary is SSLMate's certspotter (reliable infra, keyless tier);
// crt.sh is the fallback (standard but flaky, often 502s from cloud IPs).
// Each is retried with backoff before falling through.
async function fetchCertspotter(domain) {
    const url = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names&expand=issuer&expand=not_before&expand=not_after`;
    const arr = await fetchJson(url);
    if (!Array.isArray(arr)) throw new Error(arr?.message || 'unexpected certspotter response');
    return arr.map((c) => ({
        names: c.dns_names || [],
        issuer: c.issuer?.name || null,
        notBefore: c.not_before || null,
        notAfter: c.not_after || null,
    }));
}

async function fetchCrtSh(domain) {
    const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired&deduplicate=Y`;
    const arr = await fetchJson(url);
    if (!Array.isArray(arr)) throw new Error('unexpected crt.sh response');
    return arr.map((r) => ({
        names: [...String(r.name_value || '').split('\n'), r.common_name].map((s) => String(s || '').trim()).filter(Boolean),
        issuer: r.issuer_name || null,
        notBefore: r.not_before || null,
        notAfter: r.not_after || null,
    }));
}

async function fetchCertRecords(domain) {
    const sources = [['certspotter', fetchCertspotter], ['crt.sh', fetchCrtSh]];
    let lastErr;
    for (const [name, fn] of sources) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (pastDeadline()) break;
            try {
                const recs = await fn(domain);
                log.info(`${domain}: ${recs.length} cert record(s) from ${name}.`);
                return recs;
            } catch (err) {
                lastErr = err;
                if (attempt < 3) {
                    const wait = 2000 * attempt + Math.floor(Math.random() * 1000);
                    log.info(`${name} ${domain}: ${err?.message}; retry ${attempt}/2 in ${Math.round(wait / 1000)}s...`);
                    await sleep(wait);
                }
            }
        }
        log.info(`${name} unavailable for ${domain}, trying next source...`);
    }
    throw lastErr || new Error('no certificate source available');
}

// Collapse normalized cert records into one row per subdomain, newest cert won.
function collectSubdomains(records, domain) {
    const byName = new Map();
    for (const rec of records) {
        const notAfter = Date.parse(rec.notAfter);
        for (const raw of rec.names) {
            const name = String(raw).trim().toLowerCase();
            const wildcard = name.startsWith('*.');
            const host = wildcard ? name.slice(2) : name;
            if (!host || (host !== domain && !host.endsWith(`.${domain}`))) continue;
            const prev = byName.get(host);
            if (!prev || (Number.isFinite(notAfter) && notAfter > prev._notAfterMs)) {
                byName.set(host, {
                    subdomain: host,
                    domain,
                    seenAsWildcard: wildcard,
                    certIssuer: issuerOrg(rec.issuer),
                    certValidFrom: (rec.notBefore || '').slice(0, 10) || null,
                    certValidTo: (rec.notAfter || '').slice(0, 10) || null,
                    _notAfterMs: Number.isFinite(notAfter) ? notAfter : 0,
                });
            }
        }
    }
    return [...byName.values()].sort((a, b) => a.subdomain.localeCompare(b.subdomain));
}

function issuerOrg(issuer) {
    const m = String(issuer || '').match(/O=([^,]+)/);
    return m ? m[1].trim() : (issuer || null);
}

function liveCert(host) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS }, () => {
            const c = socket.getPeerCertificate();
            const toMs = c?.valid_to ? Date.parse(c.valid_to) : NaN;
            const fromMs = c?.valid_from ? Date.parse(c.valid_from) : NaN;
            const now = Date.now();
            finish({
                liveReachable: true,
                liveIssuer: c?.issuer?.O || null,
                liveValidFrom: Number.isFinite(fromMs) ? new Date(fromMs).toISOString().slice(0, 10) : null,
                liveValidTo: Number.isFinite(toMs) ? new Date(toMs).toISOString().slice(0, 10) : null,
                liveDaysToExpiry: Number.isFinite(toMs) ? Math.round((toMs - now) / 86400000) : null,
                liveValidNow: Number.isFinite(toMs) && Number.isFinite(fromMs) ? (now >= fromMs && now <= toMs) : null,
                liveSanCount: c?.subjectaltname ? c.subjectaltname.split(',').length : null,
            });
            socket.end();
        });
        socket.on('error', (e) => finish({ liveReachable: false, liveError: e.code || e.message }));
        socket.on('timeout', () => { finish({ liveReachable: false, liveError: 'timeout' }); socket.destroy(); });
    });
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'subdomain_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`${domainList.length} domain(s), live cert check ${checkLiveCert ? 'on' : 'off'}...`);

outer:
for (const domain of domainList) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

    let records;
    try {
        records = await fetchCertRecords(domain);
    } catch (err) {
        log.warning(`Certificate lookup failed for ${domain}: ${err?.message}. Skipping.`);
        continue;
    }
    const subs = collectSubdomains(records, domain);
    log.info(`${domain}: ${subs.length} subdomain(s) in certificate records.`);
    if (subs.length === 0) continue;

    // Live cert checks run in a small pool over the subdomains we will emit.
    const emit = subs.slice(0, Math.max(0, cap - rowsPushed));
    const liveByHost = new Map();
    if (checkLiveCert) {
        const queue = emit.map((s) => s.subdomain);
        const workers = Array.from({ length: Math.min(TLS_CONCURRENCY, queue.length) }, async () => {
            while (queue.length > 0 && !pastDeadline()) {
                const host = queue.shift();
                if (host) liveByHost.set(host, await liveCert(host));
            }
        });
        await Promise.all(workers);
    }

    for (const s of emit) {
        if (rowsPushed >= cap) break outer;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break outer; }
        const { _notAfterMs, ...clean } = s;
        await flushRow({ ...clean, ...(checkLiveCert ? (liveByHost.get(s.subdomain) || { liveReachable: false, liveError: 'not checked' }) : {}) });
    }
}

log.info(`Done. ${rowsPushed} subdomain(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable past the ${FREE_TIER_ROWS} free).`);
await Actor.exit();
