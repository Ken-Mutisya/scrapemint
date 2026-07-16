// Lookalike Domain Finder: Typosquat & Phishing Detection
//
// Strategy
// --------
// For each brand domain, generate hundreds of lookalike variants offline
// (character swap/omission/insertion/repeat, adjacent-key typos, homoglyph
// substitutions, hyphen insertion, common phishing prefixes/suffixes, and
// TLD swaps), then resolve each variant through Google DNS-over-HTTPS
// (dns.google/resolve, proven DC-safe and keyless). Only variants that are
// actually REGISTERED are returned. MX records are checked too: a mail
// server on a lookalike domain means it can send brand-spoofing email, the
// highest-risk signal. Optional RDAP enrichment adds the registration date
// so freshly registered lookalikes stand out. With `dedupe` on a schedule,
// each run returns only newly appeared lookalikes: a brand-abuse monitor.
//
// Pay per event
// -------------
//   lookalike_found ($0.01) charged per REGISTERED lookalike domain. Variants
//   that do not resolve are never charged. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const DOH = 'https://dns.google/resolve';
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 12;
const UA = 'LookalikeDomainFinder/1.0 (+https://apify.com/scrapemint/lookalike-domain-finder)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    extraTlds = [],
    includeHomoglyphs = true,
    onlyWithMx = false,
    includeRegistrationDate = true,
    maxVariantsPerDomain = 600,
    maxRows = 100,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

// Normalize "https://www.Stripe.com/x" -> { sld:"stripe", tld:"com", root:"stripe.com" }.
function parseDomain(raw) {
    let s = String(raw).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (!s.includes('.')) return null;
    const parts = s.split('.');
    // Handle common two-label public suffixes (co.uk, com.au, co.ke...).
    const TWO_LABEL = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'co.nz', 'co.za', 'com.br', 'co.ke', 'co.in', 'co.jp']);
    const lastTwo = parts.slice(-2).join('.');
    let tld; let sld;
    if (parts.length >= 3 && TWO_LABEL.has(lastTwo)) {
        tld = parts.slice(-2).join('.');
        sld = parts.slice(0, -2).join('.');
    } else {
        tld = parts.slice(-1)[0];
        sld = parts.slice(0, -1).join('.');
    }
    return sld ? { sld, tld, root: `${sld}.${tld}` } : null;
}

const KEYBOARD = {
    q: 'wa', w: 'qeas', e: 'wrd', r: 'etf', t: 'ryg', y: 'tuh', u: 'yij', i: 'uok', o: 'ipl', p: 'ol',
    a: 'qsz', s: 'awdxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
    0: 'o', 1: 'l', 5: 's',
};
const HOMOGLYPHS = {
    o: ['0'], l: ['1', 'i'], i: ['1', 'l'], e: ['3'], a: ['4'], s: ['5'], b: ['8'],
    g: ['q'], m: ['rn'], w: ['vv'], d: ['cl'],
};
const PREFIXES = ['login', 'secure', 'account', 'my', 'app', 'mail', 'verify', 'support', 'billing'];
const SUFFIXES = ['login', 'secure', 'online', 'support', 'app', 'help', 'pay', 'account'];
const DEFAULT_TLDS = ['com', 'net', 'org', 'co', 'io', 'info', 'xyz', 'online', 'site', 'app', 'us', 'biz'];

function generateVariants(sld, tld, homoglyphs, extraTldList, limit) {
    const roots = new Set();
    const chars = sld.split('');
    // Character omission
    for (let i = 0; i < chars.length; i++) roots.add(sld.slice(0, i) + sld.slice(i + 1));
    // Adjacent transposition
    for (let i = 0; i < chars.length - 1; i++) {
        const a = chars.slice(); [a[i], a[i + 1]] = [a[i + 1], a[i]]; roots.add(a.join(''));
    }
    // Character repetition
    for (let i = 0; i < chars.length; i++) roots.add(sld.slice(0, i + 1) + chars[i] + sld.slice(i + 1));
    // Adjacent-key replacement + insertion
    for (let i = 0; i < chars.length; i++) {
        for (const k of KEYBOARD[chars[i]] || '') {
            roots.add(sld.slice(0, i) + k + sld.slice(i + 1));
            roots.add(sld.slice(0, i) + k + sld.slice(i));
        }
    }
    // Homoglyph substitution
    if (homoglyphs) {
        for (let i = 0; i < chars.length; i++) {
            for (const g of HOMOGLYPHS[chars[i]] || []) roots.add(sld.slice(0, i) + g + sld.slice(i + 1));
        }
    }
    // Hyphenation between every pair
    for (let i = 1; i < chars.length; i++) roots.add(`${sld.slice(0, i)}-${sld.slice(i)}`);
    roots.delete(sld);

    const variants = new Set();
    const tlds = [...new Set([...DEFAULT_TLDS, ...extraTldList])];
    // Same-name-different-TLD (a top phishing pattern)
    for (const t of tlds) if (t !== tld) variants.add(`${sld}.${t}`);
    // Prefix/suffix on the real name, on the original TLD and .com
    for (const pre of PREFIXES) { variants.add(`${pre}-${sld}.${tld}`); variants.add(`${pre}-${sld}.com`); }
    for (const suf of SUFFIXES) { variants.add(`${sld}-${suf}.${tld}`); variants.add(`${sld}-${suf}.com`); }
    // Typo roots across the original TLD, .com, .net
    for (const r of roots) for (const t of [tld, 'com', 'net']) variants.add(`${r}.${t}`);

    variants.delete(`${sld}.${tld}`);
    return [...variants].slice(0, limit);
}

let rateLimited = false;
async function doh(name, type) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, accept: 'application/dns-json' },
        });
        if (res.status === 429) { rateLimited = true; return null; }
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function rdapCreated(domain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`https://rdap.org/domain/${domain}`, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, accept: 'application/rdap+json' },
        });
        if (!res.ok) return null;
        const d = await res.json();
        const ev = (d.events || []).find((e) => e.eventAction === 'registration');
        return ev?.eventDate ? String(ev.eventDate).slice(0, 10) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'lookalike_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const targets = asList(domains).map(parseDomain).filter(Boolean);
const extraTldList = asList(extraTlds).map((t) => t.toLowerCase().replace(/[^a-z.]/g, '')).filter(Boolean);
const perDomain = Math.max(20, Math.min(2000, Number(maxVariantsPerDomain) || 600));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

if (!targets.length) {
    log.warning('No valid domains given. Provide brand domains like stripe.com, one per line.');
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('lookalikes-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-lookalikes')) || []) seen.add(String(k));

log.info(`Scanning ${targets.length} domain(s) for registered lookalikes${includeHomoglyphs ? ' (with homoglyphs)' : ''}${onlyWithMx ? ', mail-capable only' : ''}. Cap ${cap} rows.`);

outer:
for (const target of targets) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching run timeout; stopping early.'); break; }
    if (rateLimited) { log.warning('DNS rate limit persists; stopping with partial results.'); break; }
    const variants = generateVariants(target.sld, target.tld, includeHomoglyphs, extraTldList, perDomain);
    log.info(`${target.root}: checking ${variants.length} variant(s)...`);
    let found = 0;

    // Resolve A records in bounded-concurrency waves.
    for (let i = 0; i < variants.length; i += CONCURRENCY) {
        if (rowsPushed >= cap) break outer;
        if (deadlineMs && Date.now() > deadlineMs) break outer;
        if (rateLimited) break outer;
        const wave = variants.slice(i, i + CONCURRENCY);
        const results = await Promise.all(wave.map(async (domain) => {
            const a = await doh(domain, 'A');
            // Status 0 with answers = registered and resolving; status 0 with an
            // Authority SOA but no Answer can still be registered (parked), so
            // treat "not NXDOMAIN (status !== 3) and has A answers" as the hit.
            if (!a || a.Status === 3) return null;
            const ips = (a.Answer || []).filter((x) => x.type === 1).map((x) => x.data);
            if (!ips.length) return null;
            return { domain, ips };
        }));
        for (const hit of results) {
            if (!hit) continue;
            if (rowsPushed >= cap) break outer;
            const key = `${target.root}:${hit.domain}`;
            if (seen.has(key)) continue;

            const mx = await doh(hit.domain, 'MX');
            const mxHosts = (mx?.Answer || []).filter((x) => x.type === 15).map((x) => String(x.data).split(' ').pop().replace(/\.$/, ''));
            if (onlyWithMx && !mxHosts.length) continue;
            const ns = await doh(hit.domain, 'NS');
            const nsHosts = (ns?.Answer || []).filter((x) => x.type === 2).map((x) => String(x.data).replace(/\.$/, ''));

            seen.add(key);
            const registered = includeRegistrationDate ? await rdapCreated(hit.domain) : null;
            await flushRow({
                brandDomain: target.root,
                lookalikeDomain: hit.domain,
                registered: true,
                ipAddresses: hit.ips,
                hasMailServer: mxHosts.length > 0,
                mxHosts,
                nameServers: nsHosts,
                registrationDate: registered,
                riskFlags: [
                    mxHosts.length ? 'mail-capable' : null,
                    hit.domain.includes('-') ? 'hyphenated' : null,
                    !hit.domain.endsWith(`.${target.tld}`) ? 'different-tld' : null,
                ].filter(Boolean),
                scrapedAt: new Date().toISOString(),
            });
            found += 1;
        }
    }
    log.info(`${target.root}: ${found} registered lookalike(s).`);
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-lookalikes', [...seen].slice(-200000));
}

if (rateLimited) log.warning('Stopped early on a DNS rate limit; results are partial. Re-run for the rest.');
log.info(`Done. ${rowsPushed} registered lookalike(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
