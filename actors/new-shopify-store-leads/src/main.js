// New Shopify Store Leads: Stores Launched This Week, with Emails
//
// Strategy
// --------
// 1. Download the free daily newly-registered-domains list (whoisds.com,
//    ~70,000 domains a day, published one day behind). Optional keyword and
//    TLD filters on the domain name.
// 2. Resolve each domain's A record with our own DNS client (Google and
//    Cloudflare resolvers). Shopify custom domains point at Shopify's edge,
//    23.227.38.0/23, so this finds Shopify stores without fetching a page.
//    About 2-3% of a day's new domains are Shopify stores (~1,500-2,000).
// 3. Each Shopify hit is enriched from the store itself: /meta.json (store
//    name, city, region, country, currency, product and collection counts,
//    ship-to countries, myshopify domain), the homepage (launched or still
//    behind the password page, title, socials, emails, phones) and
//    /policies/contact-information (the owner's contact email, often a
//    personal Gmail), then /pages/contact if no email yet. MX records give
//    the email provider.
// 4. Optional: WooCommerce and BigCommerce stores from the same list by
//    fingerprinting the homepage of a capped number of other live domains.
// Streaming: DNS runs in chunks and stops once enough stores matched, so a
// 50-store run does not resolve all 70,000 domains. No proxy, no browser,
// no key.
//
// Pay per event
// -------------
//   store_lead_with_email ($0.012) per store row with at least one email.
//   store_lead ($0.004) per store row without an email.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';
import zlib from 'node:zlib';
import dns from 'node:dns';

const PRICES = { store_lead_with_email: 0.012, store_lead: 0.004 };
const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const DNS_CHUNK = 3000;
const DNS_CONCURRENCY = 150;
const ENRICH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 12000;
const HTML_CAP = 600000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    daysBack = 1,
    keywords = [],
    tlds = [],
    platforms = ['shopify'],
    countries = [],
    currencies = [],
    minProducts = 0,
    onlyLaunched = false,
    requireEmail = false,
    maxStores = 100,
    maxSitesToFingerprint = 1500,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
const kws = asList(keywords);
const tldList = asList(tlds).map((t) => t.replace(/^\./, ''));
const plats = new Set(asList(platforms).length ? asList(platforms) : ['shopify']);
const wantShopify = plats.has('shopify');
const wantOther = ['woocommerce', 'bigcommerce'].filter((p) => plats.has(p));
const countryList = asList(countries).map((c) => (c === 'uk' ? 'gb' : c));
const currencyList = asList(currencies);
const minProd = Math.max(0, Number(minProducts) || 0);
const days = Math.max(1, Math.min(7, Number(daysBack) || 1));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxStores) || 100));
const fpBudget = Math.max(0, Math.min(20000, Number(maxSitesToFingerprint) || 0));

if (!wantShopify && !wantOther.length) {
    await Actor.pushData({ note: '"platforms" must include shopify, woocommerce or bigcommerce. Not charged.' });
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('new-store-leads-seen') : null;
const seen = new Set();
if (seenStore) for (const d of (await seenStore.getValue('seen-domains')) || []) seen.add(String(d));

// ---------- daily list ----------
function unzipFirstText(buf) {
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
            const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
            const data = buf.subarray(start, start + compSize);
            return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf8');
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

async function fetchDayList(dateStr) {
    const b64 = Buffer.from(`${dateStr}.zip`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const res = await fetch(`https://www.whoisds.com/whois-database/newly-registered-domains/${b64}/nrd`, {
            signal: controller.signal, headers: { 'User-Agent': UA },
        });
        if (!res.ok) { log.info(`No list for ${dateStr} (HTTP ${res.status}).`); return null; }
        const text = unzipFirstText(Buffer.from(await res.arrayBuffer()));
        return text ? text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean) : null;
    } catch (err) {
        log.warning(`List fetch failed for ${dateStr}: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const candidates = [];
const regDate = new Map();
let filesRead = 0;
const day = new Date();
day.setUTCDate(day.getUTCDate() - 1);
for (let attempts = 0; filesRead < days && attempts < days + 3; attempts++) {
    const dateStr = day.toISOString().slice(0, 10);
    day.setUTCDate(day.getUTCDate() - 1);
    const list = await fetchDayList(dateStr);
    if (!list) continue;
    filesRead += 1;
    let n = 0;
    for (const d of list) {
        if (seen.has(d) || regDate.has(d)) continue;
        if (tldList.length && !tldList.some((t) => d.endsWith(`.${t}`))) continue;
        if (kws.length && !kws.some((k) => d.includes(k))) continue;
        regDate.set(d, dateStr);
        candidates.push(d);
        n += 1;
    }
    log.info(`${dateStr}: ${list.length} new domains, ${n} after filters.`);
}
if (!filesRead) {
    await Actor.pushData({ note: 'The daily new-domain list could not be downloaded. The source may be down; try again later. Not charged.' });
    await Actor.exit();
}

// ---------- DNS ----------
const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
const isShopifyIp = (ip) => /^23\.227\.3[89]\./.test(ip);

async function resolveChunk(domains) {
    const out = [];
    const q = [...domains];
    await Promise.all(Array.from({ length: DNS_CONCURRENCY }, async () => {
        while (q.length) {
            const d = q.shift();
            try {
                const ips = await resolver.resolve4(d);
                out.push({ domain: d, ips });
            } catch { /* NXDOMAIN / no A: not live */ }
        }
    }));
    return out;
}

async function mxProvider(domain) {
    try {
        const mx = (await resolver.resolveMx(domain)).map((r) => r.exchange.toLowerCase());
        const h = mx.join(' ');
        let provider = null;
        if (/google|googlemail/.test(h)) provider = 'google_workspace';
        else if (/outlook|protection\.microsoft/.test(h)) provider = 'microsoft_365';
        else if (/zoho/.test(h)) provider = 'zoho';
        else if (/titan/.test(h)) provider = 'titan';
        else if (/improvmx/.test(h)) provider = 'improvmx';
        else if (/registrar-servers|privateemail/.test(h)) provider = 'namecheap';
        else if (/secureserver/.test(h)) provider = 'godaddy';
        else if (/hostinger/.test(h)) provider = 'hostinger';
        else if (mx.length) provider = 'other';
        return { hasMx: mx.length > 0, emailProvider: provider };
    } catch {
        return { hasMx: false, emailProvider: null };
    }
}

// ---------- HTTP + extraction ----------
async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' } });
        const text = (await res.text()).slice(0, HTML_CAP);
        return { status: res.status, ok: res.ok, finalUrl: res.url || url, text };
    } catch {
        return { status: 0, ok: false, finalUrl: url, text: '' };
    } finally {
        clearTimeout(timer);
    }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|(^|@|\.)(example|sentry|wixpress|yourdomain|domain|email|shopify|shoptimized|myshopify|godaddy)\.|^(no-?reply|donotreply)@|\.ingest\.|^[0-9a-f]{16,}@/i;
const SOCIAL = {
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i,
    facebook: /https?:\/\/(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9_.\-]+)/i,
    tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]+)/i,
    youtube: /https?:\/\/(?:www\.)?youtube\.com\/(@[A-Za-z0-9_.\-]+|channel\/[A-Za-z0-9_\-]+|c\/[A-Za-z0-9_\-]+)/i,
    x: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i,
    pinterest: /https?:\/\/(?:[a-z]+\.)?pinterest\.[a-z.]+\/([A-Za-z0-9_\-]+)/i,
    linkedin: /https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(company\/[A-Za-z0-9_\-%]+|in\/[A-Za-z0-9_\-%]+)/i,
};
const SOCIAL_JUNK = /^(shopify|sharer|share|intent|plugins|tr|dialog|home|login|p|explore|hashtag|watch|wix|woocommerce|wordpress|bigcommerce|pages)$/i;

function extractContacts(html, found) {
    if (!html) return;
    const decoded = html.replace(/&#64;|&#x40;|\[at\]/gi, '@').replace(/%40/g, '@');
    for (const m of decoded.matchAll(EMAIL_RE)) {
        const e = m[0].toLowerCase().replace(/^mailto:/, '');
        if (!JUNK_EMAIL.test(e) && !/@\d+x\./.test(e)) found.emails.add(e);
    }
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
        const p = decodeURIComponent(m[1]).replace(/[^0-9+]/g, '');
        if (p.replace('+', '').length >= 7) found.phones.add(p);
    }
    for (const [net, re] of Object.entries(SOCIAL)) {
        if (found.socials[net]) continue;
        const g = new RegExp(re.source, 'gi');
        for (const m of html.matchAll(g)) {
            const handle = m[1].split('/').pop();
            if (handle && !SOCIAL_JUNK.test(handle)) { found.socials[net] = m[0].replace(/["'<>].*$/, ''); break; }
        }
    }
}

const meta = (html, prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return m ? decodeEntities(m[1]).trim() || null : null;
};
function decodeEntities(s) {
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
const titleOf = (html) => {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
};

function bestEmail(emails, domain) {
    const list = [...emails];
    const score = (e) => (e.endsWith(`@${domain}`) ? 0 : /@(gmail|outlook|hotmail|yahoo|icloud|proton)/.test(e) ? 1 : 2);
    return list.sort((a, b) => score(a) - score(b))[0] || null;
}

async function enrichShopify(domain) {
    const [metaRes, home] = await Promise.all([
        fetchText(`https://${domain}/meta.json`, 'application/json'),
        fetchText(`https://${domain}/`),
    ]);
    let m = null;
    try { m = metaRes.ok ? JSON.parse(metaRes.text) : null; } catch { m = null; }
    if (!m && !home.ok) return null;
    const found = { emails: new Set(), phones: new Set(), socials: {} };
    const passwordProtected = /\/password\/?$/.test(new URL(home.finalUrl).pathname) || /<form[^>]+action=["'][^"']*\/password/i.test(home.text);
    extractContacts(home.text, found);
    const policy = await fetchText(`https://${domain}/policies/contact-information`);
    if (policy.ok) extractContacts(policy.text, found);
    if (!found.emails.size) {
        const contact = await fetchText(`https://${domain}/pages/contact`);
        if (contact.ok) extractContacts(contact.text, found);
    }
    const ships = Array.isArray(m?.ships_to_countries) ? m.ships_to_countries.filter((c) => c !== '*') : [];
    return {
        platform: 'shopify',
        storeName: m?.name || meta(home.text, 'og:site_name') || titleOf(home.text),
        description: m?.description || meta(home.text, 'description') || null,
        city: m?.city || null,
        region: m?.province || null,
        country: m?.country || null,
        currency: m?.currency || null,
        productsCount: m?.published_products_count ?? null,
        collectionsCount: m?.published_collections_count ?? null,
        shipsToCountries: ships.length ? ships : null,
        shipsToCountriesCount: ships.length || null,
        shopPayInstallments: m?.offers_shop_pay_installments ?? null,
        myshopifyDomain: m?.myshopify_domain || null,
        shopifyShopId: m?.id ?? null,
        launched: !passwordProtected,
        homepageTitle: titleOf(home.text),
        found,
    };
}

const FINGERPRINTS = {
    woocommerce: [/\/plugins\/woocommerce\//i, /woocommerce-page/i, /wc-block-/i, /woocommerce_params/i],
    bigcommerce: [/cdn11\.bigcommerce\.com/i, /bigcommerce\.com\/s-/i],
};

async function fingerprint(domain) {
    const home = await fetchText(`https://${domain}/`);
    if (!home.ok || !home.text) return null;
    const platform = wantOther.find((p) => FINGERPRINTS[p].some((re) => re.test(home.text)));
    if (!platform) return null;
    const found = { emails: new Set(), phones: new Set(), socials: {} };
    extractContacts(home.text, found);
    let wp = null;
    if (platform === 'woocommerce') {
        const r = await fetchText(`https://${domain}/wp-json/`, 'application/json');
        try { wp = r.ok ? JSON.parse(r.text) : null; } catch { wp = null; }
    }
    if (!found.emails.size) {
        const linkMatch = home.text.match(/href=["']([^"']*(?:contact|kontakt|contacto|contato)[^"']*)["']/i);
        if (linkMatch) {
            let u = null;
            try { u = new URL(decodeEntities(linkMatch[1]), home.finalUrl); } catch { u = null; }
            if (u && u.hostname.replace(/^www\./, '') === domain) {
                const c = await fetchText(u.href);
                if (c.ok) extractContacts(c.text, found);
            }
        }
    }
    return {
        platform,
        storeName: (wp?.name && decodeEntities(wp.name)) || meta(home.text, 'og:site_name') || titleOf(home.text),
        description: (wp?.description && decodeEntities(wp.description)) || meta(home.text, 'description') || meta(home.text, 'og:description'),
        city: null, region: null, country: null,
        currency: home.text.match(/"currency"\s*:\s*"([A-Z]{3})"/)?.[1] || null,
        productsCount: null, collectionsCount: null, shipsToCountries: null, shipsToCountriesCount: null,
        shopPayInstallments: null, myshopifyDomain: null, shopifyShopId: null,
        launched: true,
        homepageTitle: titleOf(home.text),
        found,
    };
}

// ---------- push ----------
let rowsPushed = 0;
const stats = { listDomains: candidates.length, resolved: 0, shopifyDetected: 0, fingerprinted: 0, otherDetected: 0, filteredOut: 0, unreachable: 0, rows: 0, withEmail: 0 };

function passesFilters(s) {
    if (countryList.length && !(s.country && countryList.includes(s.country.toLowerCase()))) return false;
    if (currencyList.length && !(s.currency && currencyList.includes(s.currency.toLowerCase()))) return false;
    if (minProd > 0 && !(s.productsCount != null && s.productsCount >= minProd)) return false;
    if (onlyLaunched && !s.launched) return false;
    return true;
}

async function emit(domain, s) {
    if (rowsPushed >= cap) return;
    if (!passesFilters(s)) { stats.filteredOut += 1; return; }
    const emails = [...s.found.emails].slice(0, 10);
    if (requireEmail && !emails.length) { stats.filteredOut += 1; return; }
    const mx = await mxProvider(domain);
    const { found, ...rest } = s;
    const row = {
        domain,
        url: `https://${domain}`,
        ...rest,
        email: bestEmail(found.emails, domain),
        emails,
        phones: [...found.phones].slice(0, 5),
        socials: Object.keys(found.socials).length ? found.socials : null,
        ...mx,
        registeredOn: regDate.get(domain) || null,
        source: 'whoisds.com newly registered domains + store pages',
        scrapedAt: new Date().toISOString(),
    };
    await Actor.pushData(row);
    rowsPushed += 1;
    stats.rows += 1;
    seen.add(domain);
    if (emails.length) stats.withEmail += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        const ev = emails.length ? 'store_lead_with_email' : 'store_lead';
        try { await Actor.charge({ eventName: ev }); } catch (err) { log.warning(`charge failed: ${err?.message} (${PRICES[ev]})`); }
    }
}

async function enrichAll(list, fn, countMisses = false, conc = ENRICH_CONCURRENCY) {
    for (let i = 0; i < list.length && rowsPushed < cap; i += conc) {
        if (pastDeadline()) return;
        const batch = list.slice(i, i + conc);
        const res = await Promise.all(batch.map((d) => fn(d)));
        for (let j = 0; j < batch.length && rowsPushed < cap; j++) {
            if (!res[j]) { if (countMisses) stats.unreachable += 1; continue; }
            await emit(batch[j], res[j]);
        }
    }
}

log.info(`${candidates.length} candidate domain(s); looking for ${[...plats].join(', ')} stores (up to ${cap}).`);
let fpLeft = fpBudget;
for (let i = 0; i < candidates.length && rowsPushed < cap; i += DNS_CHUNK) {
    if (pastDeadline()) { log.warning('Approaching run timeout; stopping early with results so far.'); break; }
    if (!wantShopify && fpLeft <= 0) break;
    const resolved = await resolveChunk(candidates.slice(i, i + DNS_CHUNK));
    stats.resolved += resolved.length;
    const shops = resolved.filter((r) => r.ips.some(isShopifyIp)).map((r) => r.domain);
    stats.shopifyDetected += shops.length;
    if (wantShopify) await enrichAll(shops, enrichShopify, true);
    if (wantOther.length && fpLeft > 0 && rowsPushed < cap) {
        const others = resolved.filter((r) => !r.ips.some(isShopifyIp)).map((r) => r.domain).slice(0, fpLeft);
        fpLeft -= others.length;
        stats.fingerprinted += others.length;
        const before = rowsPushed;
        await enrichAll(others, fingerprint, false, 20);
        stats.otherDetected += rowsPushed - before;
    }
    log.info(`Scanned ${Math.min(i + DNS_CHUNK, candidates.length)}/${candidates.length} domains: ${stats.shopifyDetected} Shopify detected, ${rowsPushed} row(s) pushed.`);
}

if (seenStore && rowsPushed > 0) await seenStore.setValue('seen-domains', [...seen].slice(-300000));
if (!rowsPushed) await Actor.pushData({ note: 'No new stores matched these filters in the scanned days. Try more daysBack or fewer filters. Not charged.' });
await Actor.setValue('SUMMARY', { ...stats, daysScanned: filesRead });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
