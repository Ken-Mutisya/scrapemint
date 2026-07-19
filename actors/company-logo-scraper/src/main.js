// Company Logo & Brand Asset Scraper
//
// Strategy
// --------
// Plain HTTP fetch of each domain's homepage (https first, http fallback,
// redirects followed), then extract the brand assets the site itself
// declares, ranked by how reliably each source is an actual logo:
//   1. JSON-LD Organization "logo"
//   2. og:logo meta (rare but explicit)
//   3. largest apple-touch-icon (high-quality square mark)
//   4. largest <link rel="icon">-family asset
//   5. /favicon.ico fallback
// og:image is captured separately (it is usually a social banner, not a
// logo). With verifyLogo on, the best pick is fetched and the next
// candidate is tried if it does not load - so charged rows carry a logo
// URL that actually works.
//
// Pay per event
// -------------
//   logo_found only for domains where a logo/icon was found. Unreachable
//   domains and pages with no discoverable assets are free note rows.
//   First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const FETCH_TIMEOUT_MS = 20000;
const SPACING_MS = 200;
const HTML_CAP = 500000;
const VERIFY_ATTEMPTS = 3;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { domains = [], verifyLogo = true, includeAllIcons = true, maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));
const rowCap = clampNum(maxRows, 1000, 1, 25000);

const normalizeDomain = (raw) => {
    let s = String(raw || '').trim().toLowerCase();
    s = s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').split('@').pop().split(':')[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
};
const domainList = [...new Set(asTokens(domains).map(normalizeDomain).filter(Boolean))].slice(0, rowCap);

if (domainList.length === 0) {
    log.warning('No valid domains given.');
    await Actor.exit();
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA, accept: 'text/html,application/xhtml+xml,*/*' } });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const text = (await res.text()).slice(0, HTML_CAP);
        return { text, finalUrl: res.url || url };
    } catch (err) {
        return { error: err?.message };
    } finally {
        clearTimeout(timer);
    }
}

// Confirm an asset URL actually loads and looks like an image-ish response.
async function verifyAsset(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': UA, accept: 'image/*,*/*' } });
        const type = res.headers.get('content-type') || '';
        controller.abort(); // headers are enough; do not download the body
        if (!res.ok) return { ok: false };
        // Icons must look like images: some sites serve HTML error pages or
        // junk with 200s, which must not become charged "logos".
        if (!/^image\//i.test(type) && !/octet-stream/i.test(type)) return { ok: false };
        return { ok: true, contentType: type.split(';')[0] || null };
    } catch (err) {
        return err?.name === 'AbortError' ? { ok: false } : { ok: false };
    } finally {
        clearTimeout(timer);
    }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const abs = (href, base) => {
    try { return new URL(decode(href), base).href; } catch { return null; }
};
const sizeOf = (sizes) => {
    const m = String(sizes || '').match(/(\d+)x\d+/i);
    return m ? Number(m[1]) : 0;
};

function metaContent(html, keyAttr, keyVal) {
    const re = new RegExp(`<meta\\s[^>]*${keyAttr}=["']${keyVal}["'][^>]*>`, 'i');
    const m = html.match(re);
    if (!m) return null;
    const c = m[0].match(/content=["']([^"']+)["']/i);
    return c ? decode(c[1]).trim() : null;
}

function extract(html, baseUrl) {
    const out = { jsonLdLogo: null, ogLogo: null, ogImage: null, ogSiteName: null, themeColor: null, title: null, icons: [] };

    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        if (out.jsonLdLogo) break;
        try {
            const parsed = JSON.parse(m[1].trim());
            const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
            while (stack.length) {
                const node = stack.pop();
                if (!node || typeof node !== 'object') continue;
                if (node['@graph']) stack.push(...[].concat(node['@graph']));
                const logo = node.logo;
                if (logo) {
                    const url = typeof logo === 'string' ? logo : logo.url;
                    if (url) { out.jsonLdLogo = abs(url, baseUrl); break; }
                }
            }
        } catch { /* malformed JSON-LD is common; skip */ }
    }

    // Never pass '' to abs(): new URL('', base) resolves to the base page
    // itself and would fabricate an asset where none is declared.
    const ogLogoRaw = metaContent(html, 'property', 'og:logo');
    const ogImageRaw = metaContent(html, 'property', 'og:image') || metaContent(html, 'name', 'twitter:image');
    out.ogLogo = ogLogoRaw ? abs(ogLogoRaw, baseUrl) : null;
    out.ogImage = ogImageRaw ? abs(ogImageRaw, baseUrl) : null;
    out.ogSiteName = metaContent(html, 'property', 'og:site_name');
    out.themeColor = metaContent(html, 'name', 'theme-color');
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    out.title = t ? decode(t[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : null;

    for (const m of html.matchAll(/<link\s[^>]*>/gi)) {
        const tag = m[0];
        const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
        if (!/icon/i.test(rel)) continue;
        const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
        if (!href) continue;
        const url = abs(href, baseUrl);
        if (!url) continue;
        const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || null;
        out.icons.push({ url, rel: rel.toLowerCase(), sizes, size: sizeOf(sizes) });
    }
    return out;
}

function candidates(x, finalUrl) {
    const apple = x.icons.filter((i) => /apple-touch/i.test(i.rel)).sort((a, b) => b.size - a.size);
    const plain = x.icons.filter((i) => !/apple-touch|mask/i.test(i.rel)).sort((a, b) => b.size - a.size);
    const list = [];
    if (x.jsonLdLogo) list.push({ url: x.jsonLdLogo, source: 'jsonld_logo' });
    if (x.ogLogo) list.push({ url: x.ogLogo, source: 'og_logo' });
    for (const i of apple) list.push({ url: i.url, source: 'apple_touch_icon' });
    for (const i of plain) list.push({ url: i.url, source: 'icon_link' });
    try { list.push({ url: new URL('/favicon.ico', finalUrl).href, source: 'favicon_fallback' }); } catch { /* bad base */ }
    const seenUrl = new Set();
    // data: URIs are usually blank favicon suppressors ("data:,"), never a
    // usable logo asset - only real http(s) URLs qualify.
    return list.filter((c) => c.url && /^https?:/i.test(c.url) && !seenUrl.has(c.url) && seenUrl.add(c.url));
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'logo_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- run ---------------------------------------------------------------------------

log.info(`Extracting brand assets for ${domainList.length} domain(s)${verifyLogo ? ' (verifying logos)' : ''}...`);
let found = 0;

for (const domain of domainList) {
    if (shouldStop()) break;
    let page = await fetchPage(`https://${domain}/`);
    if (page.error) page = await fetchPage(`http://${domain}/`);
    if (page.error) {
        await flushRow({ type: 'note', input: domain, found: false, note: `site unreachable (${page.error}); not charged` }, false);
        continue;
    }
    const x = extract(page.text, page.finalUrl);
    const cands = candidates(x, page.finalUrl);

    let best = null;
    let contentType = null;
    let verified = null;
    if (verifyLogo) {
        for (const c of cands.slice(0, VERIFY_ATTEMPTS)) {
            if (pastDeadline()) break;
            const v = await verifyAsset(c.url);
            if (v.ok) { best = c; contentType = v.contentType || null; verified = true; break; }
        }
        if (!best && cands.length > 0) { best = cands[0]; verified = false; }
    } else {
        best = cands[0] || null;
    }

    if (!best && !x.ogImage) {
        await flushRow({ type: 'note', input: domain, found: false, note: 'page loaded but no logo, icon or og image declared; not charged' }, false);
        continue;
    }
    // On-yield honesty: with verification on, a row whose only logo candidates
    // all failed to load is charged only if it still carries a usable og image.
    if (verifyLogo && verified === false && !x.ogImage) {
        await flushRow({ type: 'note', input: domain, found: false, note: 'declared logo assets did not load and no og image; not charged' }, false);
        continue;
    }

    await flushRow({
        domain,
        finalUrl: page.finalUrl,
        siteName: x.ogSiteName || null,
        title: x.title,
        logoUrl: best?.url || null,
        logoSource: best?.source || null,
        logoContentType: contentType,
        logoVerified: verified,
        ogImage: x.ogImage,
        themeColor: x.themeColor,
        ...(includeAllIcons ? { icons: x.icons.map(({ url, rel, sizes }) => ({ url, rel, sizes })) } : {}),
    }, true);
    found += 1;
    await sleep(SPACING_MS);
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} with assets (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
