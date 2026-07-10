// Domain WHOIS & Age Checker: Bulk RDAP Registration Data
//
// Strategy
// --------
// RDAP is the IETF-standard JSON replacement for WHOIS, served by the
// registries themselves, so there is no antibot layer and no key. Per run:
// fetch the IANA RDAP bootstrap once (TLD -> registry base URL), then query
// each input domain directly at its registry, with rdap.org as fallback when
// the registry endpoint fails. One row per domain: registrar, creation and
// expiry dates, age, status locks, nameservers, DNSSEC. An authoritative 404
// from the registry means the domain is not registered, which is an answer
// too (bulk availability checking).
//
// Pay per event
// -------------
//   domain_row ($0.003) per domain with a definitive answer (registration
//   data or authoritative not-registered). Lookups that fail or hit a TLD
//   without RDAP are pushed uncharged so buyers never pay for a non-answer.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';
import { domainToASCII } from 'node:url';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const LOOKUP_TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { domains = [], maxDomains = 500 } = input;

const cap = Math.max(1, Math.min(HARD_CAP, Number(maxDomains) || 500));

// Accept bare domains, URLs, or hostnames with paths; normalize to a
// punycoded registrable hostname.
function normalizeDomain(raw) {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0].split('@').pop().split(':')[0];
    s = s.replace(/^www\./, '').replace(/\.$/, '');
    const ascii = domainToASCII(s);
    if (!ascii || !ascii.includes('.')) return null;
    return ascii;
}

const list = (Array.isArray(domains) ? domains : String(domains || '').split(/[\n,]/))
    .map(normalizeDomain).filter(Boolean);
const targets = [...new Set(list)].slice(0, cap);

if (!targets.length) {
    log.error('Provide "domains" — one domain or URL per line, e.g. stripe.com.');
    await Actor.exit();
}

async function fetchWithTimeout(url, timeoutMs = LOOKUP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                accept: 'application/rdap+json, application/json',
                'user-agent': 'DomainWhoisChecker/1.0 (+https://apify.com/scrapemint/domain-whois-checker)',
            },
        });
    } finally {
        clearTimeout(timer);
    }
}

// ccTLDs missing from the IANA bootstrap but served by a known registry
// endpoint (verified 200 for registered, 404 for available).
const EXTRA_RDAP = new Map([
    ['io', 'https://rdap.identitydigital.services/rdap/'],
    ['sh', 'https://rdap.identitydigital.services/rdap/'],
]);

// --- IANA bootstrap: TLD -> RDAP registry base URL ---
async function loadBootstrap() {
    const map = new Map(EXTRA_RDAP);
    try {
        const res = await fetchWithTimeout('https://data.iana.org/rdap/dns.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        for (const [tlds, urls] of data?.services || []) {
            const base = urls.find((u) => u.startsWith('https://')) || urls[0];
            if (!base) continue;
            for (const tld of tlds) map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
        }
    } catch (err) {
        log.warning(`IANA bootstrap fetch failed (${err?.message}); falling back to rdap.org for all lookups.`);
    }
    return map;
}

function eventDate(events, action) {
    const e = (events || []).find((ev) => ev.eventAction === action);
    return e?.eventDate || null;
}

function registrarInfo(entities) {
    const reg = (entities || []).find((en) => (en.roles || []).includes('registrar'));
    if (!reg) return { registrar: null, registrarIanaId: null };
    let name = null;
    for (const item of reg.vcardArray?.[1] || []) {
        if (item[0] === 'fn' && typeof item[3] === 'string') { name = item[3]; break; }
    }
    const ianaId = (reg.publicIds || []).find((p) => /iana/i.test(p.type || ''))?.identifier || null;
    return { registrar: name, registrarIanaId: ianaId };
}

function parseRdap(data, domain, source) {
    const createdAt = eventDate(data.events, 'registration');
    const expiresAt = eventDate(data.events, 'expiration');
    const updatedAt = eventDate(data.events, 'last changed');
    const now = Date.now();
    const createdMs = createdAt ? Date.parse(createdAt) : NaN;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    return {
        domain,
        registered: true,
        ...registrarInfo(data.entities),
        createdAt,
        updatedAt,
        expiresAt,
        ageDays: Number.isFinite(createdMs) ? Math.floor((now - createdMs) / 86400000) : null,
        ageYears: Number.isFinite(createdMs) ? Math.round((now - createdMs) / 31557600000 * 10) / 10 : null,
        daysUntilExpiry: Number.isFinite(expiresMs) ? Math.floor((expiresMs - now) / 86400000) : null,
        status: data.status || [],
        nameservers: (data.nameservers || []).map((ns) => String(ns.ldhName || '').toLowerCase()).filter(Boolean),
        dnssec: data.secureDNS?.delegationSigned ?? null,
        rdapSource: source,
        scrapedAt: new Date().toISOString(),
    };
}

// Definitive answers: registration data, or an authoritative 404 from the
// TLD's own registry (= not registered). Anything else is a non-answer.
async function lookup(domain, bootstrap) {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const base = bootstrap.get(tld);
    if (!base && bootstrap.size) {
        return { row: { domain, registered: null, error: 'unsupported_tld', rdapSource: null, scrapedAt: new Date().toISOString() }, definitive: false };
    }
    const urls = base
        ? [`${base}domain/${domain}`, `https://rdap.org/domain/${domain}`]
        : [`https://rdap.org/domain/${domain}`];
    for (let i = 0; i < urls.length; i++) {
        const authoritative = base ? i === 0 : false;
        try {
            const res = await fetchWithTimeout(urls[i]);
            if (res.status === 404 && authoritative) {
                return {
                    row: { domain, registered: false, registrar: null, createdAt: null, expiresAt: null, ageDays: null, status: [], nameservers: [], rdapSource: new URL(urls[i]).hostname, scrapedAt: new Date().toISOString() },
                    definitive: true,
                };
            }
            if (!res.ok) continue;
            const data = await res.json();
            if (data?.objectClassName !== 'domain' && !data?.events) continue;
            return { row: parseRdap(data, domain, new URL(res.url || urls[i]).hostname), definitive: true };
        } catch { /* try next source */ }
    }
    return { row: { domain, registered: null, error: 'lookup_failed', rdapSource: null, scrapedAt: new Date().toISOString() }, definitive: false };
}

let rowsPushed = 0;
let charged = 0;
let failures = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, definitive) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!definitive) { failures += 1; return; }
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'domain_row' });
            charged += 1;
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const bootstrap = await loadBootstrap();
log.info(`Checking ${targets.length} domain(s) via RDAP (${bootstrap.size} TLDs in IANA bootstrap).`);

for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((d) => lookup(d, bootstrap)));
    for (const { row, definitive } of results) await flushRow(row, definitive);
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${charged} charged, ${failures} non-answer(s) free.`);
await Actor.exit();
