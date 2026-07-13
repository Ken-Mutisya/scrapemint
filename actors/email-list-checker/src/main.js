// Email List Checker: Valid, Disposable & Dead Emails
//
// Strategy
// --------
// DNS level email checking over Google's keyless DNS-over-HTTPS JSON API.
// No SMTP (we never contact the inbox), no browser, no proxy, no API key.
// Per email:
//   - syntax check (is it written correctly)
//   - domain exists (NXDOMAIN detection)
//   - can receive mail (MX records, A record fallback)
//   - throwaway/disposable domain (vendored blocklist, ~8k domains)
//   - free inbox (gmail, yahoo, ...) and role inbox (info@, support@, ...)
//   - likely typo with a fix (distance 1 to a popular provider)
//   - sender setup: SPF and DMARC records (optional)
// DNS results are cached per domain within the run, so 10k emails across 2k
// domains stay at a few thousand tiny DoH calls, run with a small pool.
//
// Pay per event
// -------------
//   email_checked per pushed row. First 2 rows per run are free.

import { Actor, log } from 'apify';
import { readFile } from 'node:fs/promises';

const DOH = 'https://dns.google/resolve';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 25000;
const CHUNK_SIZE = 200;
const DNS_CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 15000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

const DISPOSABLE = new Set(JSON.parse(await readFile(new URL('./data/disposable_domains.json', import.meta.url), 'utf8')));

const FREE_PROVIDERS = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'outlook.com',
    'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
    'mac.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
    'yandex.com', 'yandex.ru', 'zoho.com', 'mail.com', 'mail.ru', 'qq.com', '163.com', '126.com',
]);

const ROLE_PREFIXES = new Set([
    'info', 'support', 'admin', 'sales', 'contact', 'hello', 'office', 'billing', 'hr', 'team',
    'help', 'noreply', 'no-reply', 'marketing', 'webmaster', 'postmaster', 'abuse', 'careers',
    'jobs', 'press', 'media', 'legal', 'privacy', 'security', 'accounts', 'orders', 'service',
]);

// Popular domains used for "did you mean" typo fixes.
const POPULAR = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'protonmail.com', 'live.com', 'msn.com', 'comcast.net'];

const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    emails = [],
    checkSenderSetup = true,
    maxRows = 1000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const tokens = [...new Set(asTokens(emails).map((s) => s.toLowerCase()))].slice(0, cap);

if (tokens.length === 0) {
    log.warning('Nothing to check. Paste at least one email address (or bare domain).');
    await Actor.exit();
}

async function dohQuery(name, type) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-email-list-checker/0.1 (+https://apify.com)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        return { status: j.Status, answers: (j.Answer || []).map((a) => String(a.data || '')) };
    } finally {
        clearTimeout(timer);
    }
}

// Edit distance capped at "1 or more than 1": one insert/delete/replace, or
// one swap of adjacent letters (gmial -> gmail), counts as 1.
function lev1(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return 2;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    if (a.length === b.length && i + 1 < a.length
        && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return 1;
    let j = a.length - 1, k = b.length - 1;
    while (j >= i && k >= i && a[j] === b[k]) { j -= 1; k -= 1; }
    return (j - i < 1 && k - i < 1) ? 1 : 2;
}

function typoFix(domain) {
    if (FREE_PROVIDERS.has(domain)) return null;
    for (const p of POPULAR) if (lev1(domain, p) <= 1) return p;
    return null;
}

// DNS facts per domain, cached within the run.
const domainCache = new Map();
async function checkDomain(domain) {
    if (domainCache.has(domain)) return domainCache.get(domain);
    const out = { domainExists: null, mailServers: [], canReceiveMail: null, hasSpf: null, hasDmarc: null };
    try {
        const mx = await dohQuery(domain, 'MX');
        if (mx.status === 3) {
            out.domainExists = false;
            out.canReceiveMail = false;
        } else {
            out.domainExists = true;
            out.mailServers = mx.answers
                .map((d) => d.split(/\s+/).pop()?.replace(/\.$/, ''))
                .filter(Boolean).slice(0, 3);
            if (out.mailServers.length > 0) {
                out.canReceiveMail = true;
            } else {
                // No MX: mail can still fall back to the A record, rare but legal.
                const a = await dohQuery(domain, 'A');
                out.canReceiveMail = a.status === 0 && a.answers.length > 0 ? 'maybe' : false;
            }
        }
        if (checkSenderSetup && out.domainExists) {
            const [txt, dmarc] = await Promise.all([dohQuery(domain, 'TXT'), dohQuery(`_dmarc.${domain}`, 'TXT')]);
            out.hasSpf = txt.answers.some((d) => d.toLowerCase().includes('v=spf1'));
            out.hasDmarc = dmarc.status === 0 && dmarc.answers.length > 0;
        }
    } catch (err) {
        log.warning(`DNS check failed for ${domain}: ${err?.message}`);
    }
    domainCache.set(domain, out);
    return out;
}

async function resolveDomains(domains) {
    const queue = domains.filter((d) => !domainCache.has(d));
    const workers = Array.from({ length: Math.min(DNS_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !pastDeadline()) {
            const d = queue.shift();
            if (d) await checkDomain(d);
        }
    });
    await Promise.all(workers);
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'email_checked' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

function buildRow(token, dns) {
    const isDomainOnly = !token.includes('@');
    const domain = isDomainOnly ? token : token.split('@').pop();
    const local = isDomainOnly ? null : token.slice(0, token.lastIndexOf('@'));
    const validDomainShape = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain);
    const validSyntax = isDomainOnly ? null : EMAIL_RE.test(token);
    const disposable = DISPOSABLE.has(domain);
    const freeProvider = FREE_PROVIDERS.has(domain);
    const roleInbox = local ? ROLE_PREFIXES.has(local.split(/[+.]/)[0]) : null;
    const didYouMean = typoFix(domain);

    const reasons = [];
    let verdict = 'good';
    if (validSyntax === false) { verdict = 'bad'; reasons.push('not a valid email address'); }
    if (isDomainOnly && !validDomainShape) { verdict = 'bad'; reasons.push('not a valid email address or domain'); }
    if (dns.domainExists === false) { verdict = 'bad'; reasons.push('domain does not exist'); }
    else if (dns.canReceiveMail === false) { verdict = 'bad'; reasons.push('domain has no mail server'); }
    if (verdict !== 'bad') {
        if (disposable) { verdict = 'risky'; reasons.push('throwaway email service'); }
        if (didYouMean) { verdict = 'risky'; reasons.push(`possible typo, did you mean ${didYouMean}?`); }
        if (dns.canReceiveMail === 'maybe') { verdict = 'risky'; reasons.push('no mail server listed, delivery uncertain'); }
        if (roleInbox) { if (verdict === 'good') verdict = 'risky'; reasons.push('role inbox, not a person'); }
        if (validDomainShape && dns.domainExists === null) { verdict = 'unknown'; reasons.push('DNS check did not complete'); }
    }

    return {
        email: isDomainOnly ? null : token,
        domain,
        verdict,
        reasons,
        validSyntax,
        domainExists: dns.domainExists,
        canReceiveMail: dns.canReceiveMail,
        mailServers: dns.mailServers,
        disposable,
        freeProvider,
        roleInbox,
        didYouMean,
        hasSpf: dns.hasSpf,
        hasDmarc: dns.hasDmarc,
    };
}

log.info(`Checking ${tokens.length} email(s)/domain(s), DNS pool of ${DNS_CONCURRENCY}...`);

const EMPTY_DNS = { domainExists: null, mailServers: [], canReceiveMail: null, hasSpf: null, hasDmarc: null };

outer:
for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    const domains = [...new Set(chunk
        .map((t) => (t.includes('@') ? t.split('@').pop() : t))
        .filter((d) => d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)))];
    await resolveDomains(domains);
    for (const token of chunk) {
        if (rowsPushed >= cap) break outer;
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break outer; }
        const domain = token.includes('@') ? token.split('@').pop() : token;
        const dns = domainCache.get(domain) ?? EMPTY_DNS;
        await flushRow(buildRow(token, dns));
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable past the ${FREE_TIER_ROWS} free).`);
await Actor.exit();
