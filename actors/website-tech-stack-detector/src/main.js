// Website Technology Stack Detector (BuiltWith Alternative)
//
// Strategy
// --------
// The buyer supplies a list of websites. For each site we fetch the homepage
// once with plain HTTP and match a precision-first signature set against the
// HTML (vendor asset URLs, unique globals), the response headers (vendor and
// server headers), and set-cookie names. One row per website with the detected
// technologies grouped by category and the evidence that matched. No browser,
// no proxy needed, no API key: these are the buyer's own target domains,
// fetched politely, one request each.
//
// Pay per event
// -------------
//   tech_row ($0.01) charged only when a site yields at least one detected
//   technology. Unreachable or zero-detection sites are free.
//   First 1 tech row per run is free so buyers can validate output.

import { Actor, log } from 'apify';
import { SIGNATURES } from './signatures.js';

const FREE_TIER_ROWS = 1;
const HARD_CAP_SITES = 5000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 600000;
const CONCURRENCY = 10;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    websites = [],
    proxyConfiguration: proxyInput,
} = input;

const siteList = (Array.isArray(websites) ? websites : String(websites).split(/[\n,]/))
    .map((w) => String(w || '').trim()).filter(Boolean)
    .slice(0, HARD_CAP_SITES);
if (!siteList.length) {
    log.warning('Provide "websites": a list of domains or URLs, e.g. ["apify.com", "https://allbirds.com"].');
    await Actor.exit();
}

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

function normalizeUrl(raw) {
    let s = String(raw).trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try { return new URL(s); } catch { return null; }
}

async function fetchSite(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            ...(dispatcher ? { dispatcher } : {}),
        });
        const headers = {};
        for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = String(v).toLowerCase();
        const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
            .map((c) => c.split('=')[0].trim().toLowerCase());
        let html = '';
        if (res.ok && (headers['content-type'] || '').includes('text')) {
            html = (await res.text()).slice(0, MAX_HTML_BYTES).toLowerCase();
        }
        return { ok: res.ok, status: res.status, finalUrl: res.url, html, headers, setCookies };
    } catch {
        return { ok: false, status: 0, finalUrl: url, html: '', headers: {}, setCookies: [] };
    } finally {
        clearTimeout(timer);
    }
}

function detect({ html, headers, setCookies }) {
    const found = [];
    for (const sig of SIGNATURES) {
        let evidence = null;
        if (sig.html) {
            for (const pat of sig.html) {
                if (html.includes(pat)) { evidence = `html: ${pat}`; break; }
            }
        }
        if (!evidence && sig.header) {
            for (const [hname, pat] of sig.header) {
                const v = headers[hname];
                if (v !== undefined && (pat === '' || v.includes(pat))) {
                    evidence = `header: ${hname}${pat ? `=${pat}` : ''}`;
                    break;
                }
            }
        }
        if (!evidence && sig.cookie) {
            for (const pat of sig.cookie) {
                if (setCookies.some((c) => c.includes(pat))) { evidence = `cookie: ${pat}`; break; }
            }
        }
        if (evidence) found.push({ name: sig.name, category: sig.category, evidence });
    }
    return found;
}

async function processSite(raw) {
    const url = normalizeUrl(raw);
    if (!url) return { website: raw, reachable: false, error: 'invalid URL', technologies: [] };
    const res = await fetchSite(url.href);
    if (!res.ok && !res.html) {
        return { website: raw, finalUrl: res.finalUrl, httpStatus: res.status || null, reachable: false, technologies: [] };
    }
    const technologies = detect(res);
    const byCategory = {};
    for (const t of technologies) {
        (byCategory[t.category] ??= []).push(t.name);
    }
    let domain = null;
    try { domain = new URL(res.finalUrl).hostname.replace(/^www\./, ''); } catch {}
    return {
        website: raw,
        finalUrl: res.finalUrl,
        domain,
        httpStatus: res.status,
        reachable: true,
        techCount: technologies.length,
        cms: byCategory.cms?.[0] || null,
        ecommerce: byCategory.ecommerce?.[0] || null,
        byCategory: Object.keys(byCategory).length ? byCategory : null,
        technologies,
    };
}

let totalRowsPushed = 0;
let chargeableRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    totalRowsPushed += 1;
    if (row.technologies.length > 0) {
        chargeableRows += 1;
        if (chargeableRows > FREE_TIER_ROWS) {
            try {
                await Actor.charge({ eventName: 'tech_row' });
            } catch (err) {
                log.warning(`charge failed: ${err?.message}`);
            }
        }
    }
}

log.info(`Detecting tech stacks for ${siteList.length} website(s), ${SIGNATURES.length} signatures.`);

let stopped = false;
for (let i = 0; i < siteList.length && !stopped; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        stopped = true;
        break;
    }
    const batch = siteList.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map((s) => processSite(s)));
    for (const row of rows) await flushRow(row);
    if ((i + CONCURRENCY) % 100 < CONCURRENCY) log.info(`Progress: ${Math.min(i + CONCURRENCY, siteList.length)}/${siteList.length} sites.`);
}

log.info(`Done. ${totalRowsPushed} site row(s), ${chargeableRows} with detections; ${Math.max(0, chargeableRows - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
