// DNS Records Checker: Full DNS Report for Any Domain
//
// Strategy
// --------
// Google DNS-over-HTTPS (dns.google/resolve), keyless JSON, no browser, no
// proxy. Already proven to serve Apify datacenter IPs. One row per domain
// holding every requested record type, plus convenience flags:
//   - hasSpf / hasDmarc read from TXT / _dmarc TXT
//   - dnssec from the AD (authenticated data) bit on the SOA answer
// Record lookups for a domain run in parallel; domains run through a pool.
//
// Pay per event
// -------------
//   domain_report per pushed row. First 2 rows per run are free.

import { Actor, log } from 'apify';

const DOH = 'https://dns.google/resolve';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const DOMAIN_CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 15000;

// DNS numeric type -> label, for the record types we support.
const TYPE_NUM = { A: 1, AAAA: 28, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257, CNAME: 5 };
const DEFAULT_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'SOA', 'CAA', 'CNAME_WWW'];

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    recordTypes = [],
    maxRows = 500,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const cleanDomain = (d) => String(d || '')
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '')
    .trim().toLowerCase();

const domainList = [...new Set(asTokens(domains).map(cleanDomain).filter((d) => /\.[a-z]{2,}$/i.test(d)))];
const wantTypes = (Array.isArray(recordTypes) && recordTypes.length > 0 ? recordTypes : DEFAULT_TYPES)
    .filter((t) => t === 'CNAME_WWW' || TYPE_NUM[t]);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

if (domainList.length === 0) {
    log.warning('No valid domains given. Add at least one domain, e.g. cloudflare.com.');
    await Actor.exit();
}

async function doh(name, type) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-dns-records-checker/0.1 (+https://apify.com)', accept: 'application/dns-json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Records for the numeric type only (DoH Answer mixes in CNAME hops).
const dataFor = (json, type) => (json.Answer || [])
    .filter((a) => a.type === TYPE_NUM[type])
    .map((a) => String(a.data || '').replace(/^"|"$/g, ''));

// MX "10 mail.x." -> { priority, host }, sorted by priority.
function parseMx(values) {
    return values.map((v) => {
        const [pri, host] = v.split(/\s+/);
        return { priority: Number(pri), host: (host || '').replace(/\.$/, '') };
    }).sort((a, b) => a.priority - b.priority);
}

const strip = (arr) => arr.map((v) => v.replace(/\.$/, ''));

async function checkDomain(domain) {
    const row = { domain };
    const jobs = [];

    for (const t of wantTypes) {
        if (t === 'CNAME_WWW') {
            jobs.push(doh(`www.${domain}`, 'CNAME').then((j) => {
                row.wwwAlias = dataFor(j, 'CNAME').map((v) => v.replace(/\.$/, ''));
            }).catch(() => { row.wwwAlias = null; }));
            continue;
        }
        jobs.push(doh(domain, t).then((j) => {
            const vals = dataFor(j, t);
            if (t === 'MX') row.mx = parseMx(vals);
            else if (t === 'NS') row.ns = strip(vals);
            else if (t === 'SOA') { row.soa = vals[0] || null; row.dnssec = Boolean(j.AD); }
            else if (t === 'A') row.a = vals;
            else if (t === 'AAAA') row.aaaa = vals;
            else if (t === 'TXT') row.txt = vals;
            else if (t === 'CAA') row.caa = vals;
        }).catch((err) => { log.warning(`${domain} ${t}: ${err?.message}`); }));
    }

    // SPF/DMARC convenience flags (independent of whether TXT was requested).
    jobs.push(doh(domain, 'TXT').then((j) => {
        row.hasSpf = dataFor(j, 'TXT').some((v) => v.toLowerCase().startsWith('v=spf1'));
    }).catch(() => { row.hasSpf = null; }));
    jobs.push(doh(`_dmarc.${domain}`, 'TXT').then((j) => {
        row.hasDmarc = dataFor(j, 'TXT').some((v) => v.toLowerCase().startsWith('v=dmarc1'));
    }).catch(() => { row.hasDmarc = null; }));

    await Promise.all(jobs);

    // A domain that resolves at all is "live"; NXDOMAIN leaves everything empty.
    row.resolves = Boolean((row.a && row.a.length) || (row.aaaa && row.aaaa.length)
        || (row.mx && row.mx.length) || (row.ns && row.ns.length) || row.soa);
    return row;
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'domain_report' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`${domainList.length} domain(s), record types [${wantTypes.join(', ')}]...`);

const toEmit = domainList.slice(0, cap);
const queue = [...toEmit];
const results = new Map();
const workers = Array.from({ length: Math.min(DOMAIN_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && !pastDeadline()) {
        const d = queue.shift();
        if (d) {
            try { results.set(d, await checkDomain(d)); }
            catch (err) { log.warning(`${d}: ${err?.message}`); results.set(d, { domain: d, resolves: false, error: 'lookup failed' }); }
        }
    }
});
await Promise.all(workers);

for (const d of toEmit) {
    if (rowsPushed >= cap) break;
    const row = results.get(d);
    if (row) await flushRow(row);
}

log.info(`Done. ${rowsPushed} domain report(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable past the ${FREE_TIER_ROWS} free).`);
await Actor.exit();
