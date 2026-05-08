// Domain Intelligence: WHOIS + DNS Bulk Lookup
//
// Per domain:
//   - RDAP (modern WHOIS) lookup at rdap.org for registrar, dates, org, country
//   - DNS resolution for A, MX, NS, TXT records
//   - DMARC policy lookup at _dmarc.<domain>
//   - Inferred signals: email provider (Google Workspace, Microsoft 365, etc),
//     DNS provider (Cloudflare, Route 53, etc), SPF/DMARC presence
//
// Pay-per-event:
//   domain_lookup ($0.005) charged when lookup returns at least DNS or WHOIS data.
//   First 10 domains per run are free.

import { Actor, log } from 'apify';
import { promises as dns } from 'node:dns';

const FREE_TIER_LOOKUPS = 10;

const EMAIL_PROVIDER_RULES = [
    [/aspmx\.l\.google\.com|googlemail\.com|google\.com$/i, 'Google Workspace'],
    [/protection\.outlook\.com|mail\.protection\.outlook\.com/i, 'Microsoft 365'],
    [/secureserver\.net/i, 'GoDaddy Email'],
    [/zoho\.com|zohomail\.com/i, 'Zoho Mail'],
    [/protonmail\.ch|proton\.me/i, 'Proton Mail'],
    [/emailsrvr\.com/i, 'Rackspace'],
    [/amazonses\.com/i, 'Amazon SES'],
    [/sendgrid\.net/i, 'SendGrid'],
    [/mailgun\.org/i, 'Mailgun'],
    [/pphosted\.com/i, 'Proofpoint'],
    [/mxlogic\.net/i, 'McAfee MX'],
    [/mimecast\.com/i, 'Mimecast'],
    [/fastmail\.com/i, 'Fastmail'],
    [/yandex\.net|yandex\.ru/i, 'Yandex Mail'],
];

const DNS_PROVIDER_RULES = [
    [/cloudflare\.com/i, 'Cloudflare'],
    [/awsdns/i, 'AWS Route 53'],
    [/googledomains\.com|google\.com$/i, 'Google'],
    [/azure-dns/i, 'Azure DNS'],
    [/nsone\.net/i, 'NS1'],
    [/dnsimple\.com/i, 'DNSimple'],
    [/dnsmadeeasy\.com/i, 'DNS Made Easy'],
    [/domaincontrol\.com/i, 'GoDaddy'],
    [/registrar-servers\.com/i, 'Namecheap'],
    [/worldnic\.com/i, 'Network Solutions'],
    [/digitalocean\.com/i, 'DigitalOcean'],
    [/he\.net/i, 'Hurricane Electric'],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    domains = [],
    includeWhois = true,
    includeDns = true,
    includeDmarc = true,
    concurrency = 10,
} = input;

if (!Array.isArray(domains) || domains.length === 0) {
    log.warning('No domains provided in input. Add at least one domain to the `domains` field and run again.');
    await Actor.exit();
}

const normalizeDomain = (raw) => {
    let s = String(raw).trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
    return s;
};

const cleanDomains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
log.info(`Looking up ${cleanDomains.length} domains.`);

const inferProvider = (records, rules) => {
    if (!records || records.length === 0) return null;
    const haystack = records.join(' ');
    for (const [re, name] of rules) {
        if (re.test(haystack)) return name;
    }
    return null;
};

async function fetchRdap(domain) {
    try {
        const res = await fetch(`https://rdap.org/domain/${domain}`, {
            headers: { accept: 'application/rdap+json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const events = data.events || [];
        const findEvent = (action) => events.find((e) => e.eventAction === action)?.eventDate || null;
        const registrar = (data.entities || [])
            .find((e) => (e.roles || []).includes('registrar'))
            ?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] || null;
        const registrant = (data.entities || []).find((e) => (e.roles || []).includes('registrant'));
        const registrantVcard = registrant?.vcardArray?.[1] || [];
        const findVcard = (key) => registrantVcard.find((v) => v[0] === key)?.[3] || null;
        const adr = registrantVcard.find((v) => v[0] === 'adr')?.[3] || [];
        return {
            registrar,
            created_at: findEvent('registration')?.slice(0, 10) || null,
            expires_at: findEvent('expiration')?.slice(0, 10) || null,
            updated_at: findEvent('last changed')?.slice(0, 10) || null,
            org: findVcard('org') || findVcard('fn'),
            country: Array.isArray(adr) ? adr[6] || null : null,
            status: data.status || [],
        };
    } catch (err) {
        log.debug(`rdap failed for ${domain}: ${err.message}`);
        return null;
    }
}

async function fetchDns(domain) {
    const out = { a: [], mx: [], ns: [], txt: [] };
    const tasks = [
        dns.resolve4(domain).then((r) => { out.a = r; }).catch(() => {}),
        dns.resolveMx(domain).then((r) => { out.mx = r.sort((a, b) => a.priority - b.priority).map((m) => m.exchange); }).catch(() => {}),
        dns.resolveNs(domain).then((r) => { out.ns = r; }).catch(() => {}),
        dns.resolveTxt(domain).then((r) => { out.txt = r.map((entries) => entries.join('')); }).catch(() => {}),
    ];
    await Promise.all(tasks);
    return out;
}

async function fetchDmarc(domain) {
    try {
        const records = await dns.resolveTxt(`_dmarc.${domain}`);
        const flat = records.map((r) => r.join('')).find((r) => /^v=DMARC1/i.test(r));
        if (!flat) return { has_dmarc: false, policy: null };
        const policyMatch = flat.match(/p=(\w+)/i);
        return { has_dmarc: true, policy: policyMatch ? policyMatch[1].toLowerCase() : null };
    } catch {
        return { has_dmarc: false, policy: null };
    }
}

async function processDomain(domain) {
    const [whois, dnsRecords, dmarc] = await Promise.all([
        includeWhois ? fetchRdap(domain) : Promise.resolve(null),
        includeDns ? fetchDns(domain) : Promise.resolve(null),
        includeDmarc ? fetchDmarc(domain) : Promise.resolve({ has_dmarc: false, policy: null }),
    ]);

    const hasData = (whois && whois.registrar) || (dnsRecords && (dnsRecords.a.length || dnsRecords.mx.length || dnsRecords.ns.length));
    const hasSpf = dnsRecords ? dnsRecords.txt.some((r) => /^v=spf1/i.test(r)) : false;
    const emailProvider = dnsRecords ? inferProvider(dnsRecords.mx, EMAIL_PROVIDER_RULES) : null;
    const dnsProvider = dnsRecords ? inferProvider(dnsRecords.ns, DNS_PROVIDER_RULES) : null;

    return {
        domain,
        whois,
        dns: dnsRecords,
        signals: {
            email_provider: emailProvider,
            dns_provider: dnsProvider,
            has_spf: hasSpf,
            has_dmarc: dmarc.has_dmarc,
            dmarc_policy: dmarc.policy,
        },
        scraped_at: new Date().toISOString(),
        _has_data: hasData,
    };
}

const dataset = await Actor.openDataset();
const queue = [...cleanDomains];
const workers = [];
let processed = 0;
let charged = 0;

const runWorker = async () => {
    while (queue.length > 0) {
        const domain = queue.shift();
        try {
            const row = await processDomain(domain);
            const hasData = row._has_data;
            delete row._has_data;
            await dataset.pushData(row);
            processed += 1;
            if (hasData) {
                charged += 1;
                if (charged > FREE_TIER_LOOKUPS) {
                    Actor.charge({ eventName: 'domain_lookup' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
                }
            }
            if (processed % 25 === 0) log.info(`Processed ${processed}/${cleanDomains.length}.`);
        } catch (err) {
            log.warning(`failed for ${domain}: ${err.message}`);
        }
    }
};

const cap = Math.max(1, Math.min(50, Number(concurrency) || 10));
for (let i = 0; i < cap; i += 1) workers.push(runWorker());
await Promise.all(workers);

log.info(`Done. Processed ${processed}, charged ${Math.max(0, charged - FREE_TIER_LOOKUPS)}, free ${Math.min(charged, FREE_TIER_LOOKUPS)}.`);
await Actor.exit();
