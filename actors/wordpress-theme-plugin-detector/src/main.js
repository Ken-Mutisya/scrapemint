// WordPress Theme & Plugin Detector
//
// Strategy
// --------
// For each site we fetch the homepage and collect:
//   - theme slugs from /wp-content/themes/<slug>/ asset paths, then read the
//     theme's style.css header (Theme Name, Version, Author, Template = parent)
//   - plugin slugs from /wp-content/plugins/<slug>/ asset paths, with the
//     ?ver= of their assets as the detected version
//   - plugins that leave HTML markers instead (Yoast, Rank Math, WooCommerce,
//     Elementor, WP Rocket ...) and REST API namespaces from /wp-json/
// Every slug is then looked up once per run in the free wordpress.org API for
// its display name, latest version, active installs and last update, so each
// plugin gets an "outdated" flag. Not in the directory = premium or custom.
// No API key, no proxy, no browser.
//
// Pay per event
// -------------
//   site_detected ($0.003) per URL confirmed as WordPress. Non-WordPress
//   sites, unreachable URLs and invalid inputs are free. The first 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

// HTML markers for plugins that do not always load assets from their folder.
const MARKERS = [
    ['wordpress-seo', 'optimized with the yoast seo'],
    ['seo-by-rank-math', 'rank math'],
    ['all-in-one-seo-pack', 'all in one seo'],
    ['woocommerce', 'woocommerce-no-js', 'wc-block', 'class="woocommerce'],
    ['elementor', 'elementor-kit-', 'elementor-default'],
    ['wp-rocket', 'wp rocket', 'wp-rocket'],
    ['litespeed-cache', 'litespeed cache', 'litespeed-'],
    ['w3-total-cache', 'w3 total cache'],
    ['wp-super-cache', 'wp-super-cache', 'wp super cache'],
    ['autoptimize', 'autoptimize'],
    ['jetpack', 'jetpack-'],
    ['wpforms-lite', 'wpforms'],
    ['contact-form-7', 'wpcf7'],
    ['gravityforms', 'gform_wrapper', 'gravity forms'],
    ['js_composer', 'wpb_row', 'wpbakery'],
    ['beaver-builder-lite-version', 'fl-builder'],
    ['divi-builder', 'et_pb_'],
    ['google-site-kit', 'site kit by google'],
    ['monsterinsights', 'monsterinsights'],
    ['mailchimp-for-wp', 'mc4wp'],
    ['cookie-law-info', 'cookie-law-info', 'cookieyes'],
    ['complianz-gdpr', 'cmplz'],
    ['wordfence', 'wordfence'],
    ['sg-cachepress', 'sg optimizer', 'speed optimizer'],
    ['the-events-calendar', 'tribe-events'],
    ['wpml', 'wpml-'],
    ['polylang', 'polylang'],
    ['translatepress-multilingual', 'trp-language'],
];

const NAMESPACES = {
    'yoast/v1': 'wordpress-seo', 'rankmath/v1': 'seo-by-rank-math', 'aioseo/v1': 'all-in-one-seo-pack', 'wc/v3': 'woocommerce', 'wc/store': 'woocommerce',
    'elementor/v1': 'elementor', 'contact-form-7/v1': 'contact-form-7', 'jetpack/v4': 'jetpack', 'wordfence/v1': 'wordfence', 'redirection/v1': 'redirection',
    'litespeed/v1': 'litespeed-cache', 'akismet/v1': 'akismet', 'mc4wp/v1': 'mailchimp-for-wp', 'tribe/events/v1': 'the-events-calendar', 'buddypress/v1': 'buddypress',
    'wp-statistics/v2': 'wp-statistics', 'siteground-optimizer/v1': 'sg-cachepress', 'ithemes-security/v1': 'better-wp-security', 'gf/v2': 'gravityforms',
    'wpforms/v1': 'wpforms-lite', 'google-site-kit/v1': 'google-site-kit', 'monsterinsights/v1': 'google-analytics-for-wordpress', 'complianz/v1': 'complianz-gdpr',
    'wp-rocket/v1': 'wp-rocket', 'ninja-forms-submissions': 'ninja-forms', 'wpml/v1': 'wpml', 'pll/v1': 'polylang', 'activitypub/1.0': 'activitypub',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { urls = [], enrichFromWordPressOrg = true, checkRestApi = true, concurrency = 6, maxRows = 1000 } = input;
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const conc = Math.max(1, Math.min(20, Number(concurrency) || 6));

function normalizeUrl(s) {
    const str = String(s || '').trim();
    if (!str) return null;
    try {
        const u = new URL(/^[a-z]+:\/\//i.test(str) ? str : `https://${str}`);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
        return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return null; }
}

const raw = (Array.isArray(urls) ? urls : String(urls || '').split(/[\n,]/)).map((s) => (typeof s === 'object' && s ? s.url : s)).map((s) => String(s || '').trim()).filter(Boolean);
const seen = new Set();
const targets = [];
const invalid = [];
for (const r of raw) {
    const u = normalizeUrl(r);
    if (!u) { invalid.push(r); continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    targets.push({ input: r, url: u });
    if (targets.length >= cap) break;
}
if (!targets.length) {
    await Actor.pushData({ note: 'No valid site URLs in input. Example: techcrunch.com' });
    await Actor.exit();
}
log.info(`Checking ${targets.length} sites (${invalid.length} invalid).`);

// One retry with backoff when the site rate-limits us (429) or is briefly unavailable (503).
async function get(url, { accept = 'text/html,application/xhtml+xml', maxBytes = MAX_HTML_BYTES } = {}) {
    const r = await getOnce(url, { accept, maxBytes });
    if (r.status !== 429 && r.status !== 503) return r;
    const wait = Math.min(15, Number(r.headers?.get('retry-after')) || 0) * 1000 || 3000 + Math.random() * 3000;
    await new Promise((res) => setTimeout(res, wait));
    return getOnce(url, { accept, maxBytes });
}

async function getOnce(url, { accept = 'text/html,application/xhtml+xml', maxBytes = MAX_HTML_BYTES } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' } });
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, url: res.url, headers: res.headers, text: buf.subarray(0, maxBytes).toString('utf8') };
    } catch (err) {
        return { status: 0, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
    } finally { clearTimeout(t); }
}

const decode = (s) => (s == null ? s : String(s).replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/<[^>]+>/g, '').trim());

function cmpVer(a, b) {
    const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
    }
    return 0;
}

// wordpress.org lookups, cached per run.
const orgCache = new Map();
function orgInfo(kind, slug) {
    const key = `${kind}:${slug}`;
    if (!orgCache.has(key)) {
        orgCache.set(key, (async () => {
            const url = kind === 'plugin'
                ? `https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${encodeURIComponent(slug)}&request%5Bfields%5D%5Bsections%5D=0&request%5Bfields%5D%5Bactive_installs%5D=1`
                : `https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=${encodeURIComponent(slug)}&request%5Bfields%5D%5Bactive_installs%5D=1`;
            const r = await get(url, { accept: 'application/json', maxBytes: 2 * 1024 * 1024 });
            if (r.status !== 200) return { inDirectory: r.status === 404 ? false : null };
            try {
                const j = JSON.parse(r.text);
                if (j.error || !j.slug) return { inDirectory: false };
                return {
                    inDirectory: true,
                    name: decode(j.name),
                    latestVersion: j.version ?? null,
                    activeInstalls: j.active_installs ?? null,
                    lastUpdated: j.last_updated ? String(j.last_updated).slice(0, 10) : null,
                    author: decode(typeof j.author === 'string' ? j.author : j.author?.display_name),
                    rating: j.rating ?? null,
                    homepage: j.homepage ?? null,
                    directoryUrl: `https://wordpress.org/${kind === 'plugin' ? 'plugins' : 'themes'}/${slug}/`,
                };
            } catch { return { inDirectory: null }; }
        })());
    }
    return orgCache.get(key);
}

function styleHeader(css) {
    const h = {};
    const head = css.slice(0, 8000);
    for (const [k, field] of [['name', 'Theme Name'], ['version', 'Version'], ['author', 'Author'], ['authorUri', 'Author URI'], ['themeUri', 'Theme URI'], ['parent', 'Template'], ['textDomain', 'Text Domain']]) {
        const m = head.match(new RegExp(`^[\\s*#@]*${field}\\s*:\\s*(.+)$`, 'mi'));
        if (m) h[k] = m[1].replace(/\*\/.*$/, '').trim();
    }
    return h;
}

async function inspect(t) {
    const home = await get(t.url);
    const base = { input: t.input, url: home.url || t.url, domain: new URL(t.url).hostname };
    if (!home.status || home.status >= 400) {
        return { ok: false, row: { ...base, isWordPress: null, httpStatus: home.status || null, error: home.error || `HTTP ${home.status}`, checkedAt: new Date().toISOString() } };
    }
    // Unescape JSON-embedded paths (wp-content\/plugins\/...) so asset matching sees them.
    const html = home.text.replace(/\\\//g, '/');
    const lower = html.toLowerCase();
    const origin = new URL(home.url || t.url).origin;
    const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]+)?/i);
    const isWp = !!generator || lower.includes('/wp-content/') || lower.includes('/wp-includes/') || lower.includes('api.w.org');
    if (!isWp) return { ok: false, row: { ...base, isWordPress: false, httpStatus: home.status, note: 'Not a WordPress site. Not charged.', checkedAt: new Date().toISOString() } };

    // Themes and plugins from asset paths (also matches CDN-rewritten URLs).
    const themeHits = {};
    for (const m of html.matchAll(/wp-content\/themes\/([a-z0-9_.-]+)\//gi)) { const s = m[1].toLowerCase(); themeHits[s] = (themeHits[s] || 0) + 1; }
    const plugins = new Map();
    const addPlugin = (slug, by, ver) => {
        const p = plugins.get(slug) || { slug, detectedVersion: null, detectedBy: [] };
        if (ver && !p.detectedVersion) p.detectedVersion = ver;
        if (!p.detectedBy.includes(by)) p.detectedBy.push(by);
        plugins.set(slug, p);
    };
    for (const m of html.matchAll(/wp-content\/plugins\/([a-z0-9_.-]+)\/[^"'\s)]*?(?:\?ver=([\d.]+))?["'\s)]/gi)) addPlugin(m[1].toLowerCase(), 'assets', m[2]);
    for (const [slug, ...markers] of MARKERS) if (markers.some((k) => lower.includes(k))) addPlugin(slug, 'html');
    const yoastV = html.match(/Yoast SEO (?:plugin )?v([\d.]+)/i)?.[1];
    if (yoastV) addPlugin('wordpress-seo', 'html', yoastV);
    const rmV = html.match(/Rank Math (?:PRO )?(?:WordPress SEO plugin )?v?([\d.]+)/i)?.[1];
    if (rmV && plugins.has('seo-by-rank-math')) plugins.get('seo-by-rank-math').detectedVersion ||= rmV;

    let siteName = null; let siteDescription = null; let restApi = null;
    if (checkRestApi) {
        const api = await get(`${origin}/wp-json/`, { accept: 'application/json', maxBytes: 3 * 1024 * 1024 });
        if (api.status === 200) {
            try {
                const j = JSON.parse(api.text);
                restApi = true;
                siteName = decode(j.name) || null;
                siteDescription = decode(j.description) || null;
                for (const ns of j.namespaces || []) if (NAMESPACES[ns]) addPlugin(NAMESPACES[ns], 'rest-api');
            } catch { restApi = false; }
        } else restApi = false;
    }

    // Active theme = most referenced; a second theme named as Template is the parent.
    const themeSlugs = Object.entries(themeHits).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    let theme = null; let parentTheme = null;
    if (themeSlugs.length) {
        const headers = {};
        for (const s of themeSlugs.slice(0, 3)) {
            const css = await get(`${origin}/wp-content/themes/${s}/style.css`, { accept: 'text/css,*/*', maxBytes: 16000 });
            headers[s] = css.status === 200 && /Theme Name/i.test(css.text) ? styleHeader(css.text) : {};
        }
        let active = themeSlugs.find((s) => headers[s]?.parent && themeSlugs.includes(headers[s].parent.toLowerCase())) || themeSlugs[0];
        const h = headers[active] || {};
        theme = { slug: active, name: h.name ?? null, version: h.version ?? null, author: h.author ?? null, authorUri: h.authorUri ?? null, themeUri: h.themeUri ?? null };
        const parentSlug = h.parent?.toLowerCase();
        if (parentSlug) {
            const ph = headers[parentSlug] || {};
            parentTheme = { slug: parentSlug, name: ph.name ?? null, version: ph.version ?? null, author: ph.author ?? null };
        }
        if (enrichFromWordPressOrg) {
            for (const th of [theme, parentTheme].filter(Boolean)) {
                const o = await orgInfo('theme', th.slug);
                Object.assign(th, {
                    inDirectory: o.inDirectory,
                    latestVersion: o.latestVersion ?? null,
                    activeInstalls: o.activeInstalls ?? null,
                    lastUpdated: o.lastUpdated ?? null,
                    isOutdated: th.version && o.latestVersion ? cmpVer(th.version, o.latestVersion) < 0 : null,
                    directoryUrl: o.directoryUrl ?? null,
                });
                if (!th.name && o.name) th.name = o.name;
            }
        }
    }

    const pluginList = [...plugins.values()];
    if (enrichFromWordPressOrg) {
        await Promise.all(pluginList.map(async (p) => {
            const o = await orgInfo('plugin', p.slug);
            Object.assign(p, {
                name: o.name ?? null,
                inDirectory: o.inDirectory,
                latestVersion: o.latestVersion ?? null,
                isOutdated: p.detectedVersion && o.latestVersion ? cmpVer(p.detectedVersion, o.latestVersion) < 0 : null,
                activeInstalls: o.activeInstalls ?? null,
                lastUpdated: o.lastUpdated ?? null,
                author: o.author ?? null,
                directoryUrl: o.directoryUrl ?? null,
            });
        }));
    }
    pluginList.sort((a, b) => (b.activeInstalls || 0) - (a.activeInstalls || 0));

    return {
        ok: true,
        row: {
            ...base,
            isWordPress: true,
            wordpressVersion: generator?.[1] ?? null,
            siteName,
            siteDescription,
            themeSlug: theme?.slug ?? null,
            themeName: theme?.name ?? null,
            themeVersion: theme?.version ?? null,
            theme,
            parentTheme,
            isChildTheme: !!parentTheme,
            plugins: pluginList,
            pluginCount: pluginList.length,
            pluginNames: pluginList.map((p) => p.name || p.slug).join(', '),
            outdatedPluginCount: pluginList.filter((p) => p.isOutdated).length,
            premiumOrCustomPluginCount: pluginList.filter((p) => p.inDirectory === false).length,
            isWooCommerce: plugins.has('woocommerce'),
            restApiOpen: restApi,
            httpStatus: home.status,
            checkedAt: new Date().toISOString(),
        },
    };
}

let chargeable = 0;
const stats = { urls: targets.length, wordpress: 0, notWordpress: 0, failed: 0, invalid: invalid.length };
const themeCounts = {}; const pluginCounts = {};
let idx = 0;
async function worker() {
    while (idx < targets.length) {
        if (pastDeadline()) return;
        const t = targets[idx++];
        let res;
        try { res = await inspect(t); } catch (err) { res = { ok: false, row: { input: t.input, url: t.url, isWordPress: null, error: String(err?.message || err), checkedAt: new Date().toISOString() } }; }
        const { row, ok } = res;
        await Actor.pushData(row);
        if (row.isWordPress === true) {
            stats.wordpress += 1;
            const tn = row.parentTheme?.slug || row.themeSlug;
            if (tn) themeCounts[tn] = (themeCounts[tn] || 0) + 1;
            for (const p of row.plugins) pluginCounts[p.slug] = (pluginCounts[p.slug] || 0) + 1;
        } else if (row.isWordPress === false) stats.notWordpress += 1; else stats.failed += 1;
        if (ok) {
            chargeable += 1;
            if (chargeable > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'site_detected' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    }
}
await Promise.all(Array.from({ length: conc }, worker));
if (pastDeadline()) log.warning('Approaching run timeout; stopped early with results so far.');

for (const s of invalid.slice(0, 50)) await Actor.pushData({ input: s, note: 'Not a valid URL or domain. Not charged.' });
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([slug, sites]) => ({ slug, sites }));
await Actor.setValue('SUMMARY', { ...stats, topThemes: top(themeCounts), topPlugins: top(pluginCounts) });
log.info(`Done. ${JSON.stringify(stats)}`);
await Actor.exit();
