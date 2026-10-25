// Trade Show Exhibitor List Scraper: every exhibitor of a Map Your Show
// trade show, with booth, hall, description and (optionally) the contact
// details from each exhibitor's profile page.
//
// Strategy
// --------
// Map Your Show hosts each show at {showcode}.mapyourshow.com. The exhibitor
// gallery loads from /8_0/ajax/remote-proxy.cfm?action=search&searchtype=
// exhibitorgallery&searchsize=N&start=M, which answers JSON to a plain request
// carrying X-Requested-With: XMLHttpRequest: name, id, booths, hall,
// description, logo, featured flag.
// Profile pages (/8_0/exhibitor/exhibitor-details.cfm?exhid=) sit behind an
// AWS WAF JavaScript challenge (HTTP 202, empty body). One headless Chrome
// visit per show solves it; the aws-waf-token cookie it earns is then sent
// with plain fetches. When the token expires (202 again) the browser
// fetches a new one. Contact data sits in the page's contactinfov3 Vue
// component (addressValues, websiteValue, phoneValue, linkedInValue ...);
// booths, product categories and brands are in the HTML.
// Email addresses and staff contacts are login-only on Map Your Show and are
// not collected.
//
// No key, no proxy. Tested from Apify on 2026-10-25.
//
// Pay per event
// -------------
//   exhibitor        ($0.001) one exhibitor from the list
//   exhibitor_detail ($0.003) one exhibitor with its profile details
// Only one of the two per exhibitor. No start fee.

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE = 500;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    shows = [],
    includeDetails = true,
    keyword = '',
    maxResultsPerShow = 0,
    maxResults = 5000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,\s]+/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;
const cap = Math.max(1, Number(maxResults) || 5000);
const perShow = Number(maxResultsPerShow) > 0 ? Number(maxResultsPerShow) : Infinity;

// "aapex2026", "https://aapex2026.mapyourshow.com/8_0/explore/..." -> "aapex2026"
function showCode(s) {
    const m = String(s).match(/^(?:https?:\/\/)?([a-z0-9-]+)\.mapyourshow\.com/i);
    if (m) return m[1].toLowerCase();
    if (/^[a-z0-9-]+$/i.test(s)) return s.toLowerCase();
    return null;
}
// An empty input (store health checks) runs the form's prefill.
const codes = [...new Set((list(shows).length ? list(shows) : ['rsna2026']).map(showCode).filter(Boolean))];
const bad = list(shows).filter((s) => !showCode(s));
if (bad.length) log.warning(`Not Map Your Show addresses, skipped: ${bad.join(', ')}. Use the show's *.mapyourshow.com link or its code, e.g. aapex2026.`);

// ---------- list ----------
async function getJson(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/javascript, */*', 'X-Requested-With': 'XMLHttpRequest' }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
            if (r.status >= 300 && r.status < 400) return { redirected: r.headers.get('location') };
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            last = err;
            if (/HTTP 4\d\d/.test(err.message)) break;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

const clean = (s) => (s == null ? null : String(s).replace(/randomstring/g, '').replace(/\r\n?/g, '\n').trim() || null);

async function listExhibitors(code) {
    const base = `https://${code}.mapyourshow.com`;
    const out = [];
    const seen = new Set();
    let total = null;
    for (let start = 0; start < 20_000; start += PAGE) {
        const q = new URLSearchParams({ action: 'search', searchtype: 'exhibitorgallery', searchsize: String(PAGE), start: String(start) });
        if (String(keyword).trim()) q.set('search', String(keyword).trim());
        const res = await getJson(`${base}/8_0/ajax/remote-proxy.cfm?${q}`);
        if (res.redirected) throw new Error(/no_showid/.test(res.redirected) ? 'Show not found on Map Your Show (check the code, e.g. aapex2026)' : `Redirected to ${res.redirected}`);
        const ex = res?.DATA?.results?.exhibitor;
        total ??= res?.DATA?.totalhits ?? ex?.found ?? null;
        const hits = ex?.hit || [];
        for (const h of hits) {
            const f = h.fields || {};
            const id = f.exhid_l || h.id?.split('-')[0];
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({
                show: code.toUpperCase(),
                exhibitorId: String(id),
                companyName: clean(f.exhname_t),
                booths: (f.boothsdisplay_la || f.booths_la || []).map(clean).filter(Boolean),
                halls: (f.hallid_la || []).map(clean).filter(Boolean),
                description: clean(f.exhdesc_t),
                logoUrl: f.exhlogo_t ? `${base}/mys_shared/${code.toUpperCase()}/logos/${f.exhlogo_t}` : null,
                featured: f.exhfeatured_t === '1',
                profileUrl: `${base}/8_0/exhibitor/exhibitor-details.cfm?exhid=${id}`,
            });
        }
        if (hits.length < PAGE) break;
    }
    return { rows: out, total };
}

// ---------- WAF token via one browser visit ----------
let browser = null;
const tokens = new Map();
const pendingToken = new Map();

async function freshToken(code, exhid) {
    if (pendingToken.has(code)) return pendingToken.get(code);
    const p = (async () => {
        browser ??= await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        const ctx = await browser.newContext({ userAgent: UA });
        try {
            const page = await ctx.newPage();
            await page.route(/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4)(\?|$)/i, (r) => r.abort());
            await page.goto(`https://${code}.mapyourshow.com/8_0/exhibitor/exhibitor-details.cfm?exhid=${exhid}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            for (let i = 0; i < 40; i++) {
                const c = (await ctx.cookies()).find((x) => x.name === 'aws-waf-token');
                if (c) break;
                await sleep(500);
            }
            const cookies = await ctx.cookies();
            if (!cookies.some((x) => x.name === 'aws-waf-token')) throw new Error('Could not pass the site check');
            const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            tokens.set(code, header);
            return header;
        } finally {
            await ctx.close().catch(() => {});
        }
    })();
    pendingToken.set(code, p);
    try { return await p; } finally { pendingToken.delete(code); }
}

async function fetchDetail(row, code) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const cookie = tokens.get(code) || await freshToken(code, row.exhibitorId);
        let r;
        try {
            r = await fetch(row.profileUrl, { headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: cookie }, signal: AbortSignal.timeout(60_000) });
        } catch (err) { await sleep(2000 * (attempt + 1)); continue; }
        if (r.status === 202 || r.status === 403 || r.status === 405) {
            await r.arrayBuffer().catch(() => {});
            if (tokens.get(code) === cookie) tokens.delete(code);
            continue;
        }
        if (r.status === 429 || r.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
    }
    throw new Error('Profile page kept failing');
}

const jsStr = (html, key) => {
    const m = html.match(new RegExp(`${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`).trim() || null; } catch { return m[1].replace(/\\\//g, '/').trim() || null; }
};
const textOf = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&#x2f;/gi, '/').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const section = (html, cls) => {
    const i = html.indexOf(`section--${cls}"`);
    if (i < 0) return [];
    const end = html.indexOf('</article>', i);
    return [...html.slice(i, end).matchAll(/<li class="o-List_Columns_Item">([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1])).filter(Boolean);
};

function parseDetail(html, row) {
    let addr = {};
    const am = html.match(/addressValues:\s*(\{[^}]*\})/);
    if (am) { try { addr = JSON.parse(am[1]); } catch { /* keep empty */ } }
    const locations = [...html.matchAll(/id="newfloorplanlink_sidebar_\d+"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => textOf(m[1]));
    const street = [addr.ADDRESS1, addr.ADDRESS2, addr.ADDRESS3].map((x) => (x || '').trim()).filter(Boolean).join(', ') || null;
    return {
        ...row,
        website: jsStr(html, 'websiteValue'),
        phone: jsStr(html, 'phoneValue'),
        fax: jsStr(html, 'faxValue'),
        street,
        city: (addr.CITY || '').trim() || null,
        state: (addr.STATE || '').trim() || null,
        postalCode: (addr.ZIP || '').trim() || null,
        country: (addr.COUNTRY || '').trim() || null,
        linkedin: jsStr(html, 'linkedInValue'),
        facebook: jsStr(html, 'facebookValue'),
        twitter: jsStr(html, 'twitterValue'),
        instagram: jsStr(html, 'instagramValue'),
        boothLocations: locations.length ? locations : row.booths,
        productCategories: section(html, 'products'),
        brands: section(html, 'brands'),
    };
}

// ---------- run ----------
let out = 0;
let stop = false;
const summary = {};

async function charge(eventName, count) {
    try {
        const r = await Actor.charge({ eventName, count });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

for (const code of codes) {
    if (stop || out >= cap || pastDeadline()) break;
    let rows, total;
    try { ({ rows, total } = await listExhibitors(code)); } catch (err) {
        log.error(`${code}: ${err.message}`);
        summary[code] = { error: err.message };
        await Actor.pushData({ show: code.toUpperCase(), error: err.message, note: 'Not charged.' });
        continue;
    }
    rows = rows.slice(0, Math.min(perShow, cap - out));
    log.info(`${code}: ${total ?? rows.length} exhibitors listed, writing ${rows.length}${includeDetails ? ' with profile details' : ''}.`);
    let written = 0;
    if (!includeDetails) {
        for (let i = 0; i < rows.length && !stop; i += 500) {
            const chunk = rows.slice(i, i + 500);
            await Actor.pushData(chunk);
            out += chunk.length; written += chunk.length;
            await charge('exhibitor', chunk.length);
        }
    } else {
        const CONC = 6;
        let failures = 0;
        for (let i = 0; i < rows.length && !stop && !pastDeadline(); i += CONC) {
            const chunk = rows.slice(i, i + CONC);
            const done = await Promise.all(chunk.map(async (row) => {
                try { return { row: parseDetail(await fetchDetail(row, code), row), ok: true }; } catch (err) { return { row: { ...row, detailsError: err.message }, ok: false }; }
            }));
            for (const d of done) {
                await Actor.pushData(d.row);
                out++; written++;
                if (!d.ok) failures++;
                await charge(d.ok ? 'exhibitor_detail' : 'exhibitor', 1);
            }
            if ((i / CONC) % 25 === 0 && i) log.info(`${code}: ${written}/${rows.length} exhibitors.`);
            if (failures > 30 && failures > written / 2) { log.error(`${code}: profile pages keep failing; writing the rest from the list only.`); break; }
        }
        // Anything left after a failure streak still goes out from the list.
        if (written < rows.length && !stop && !pastDeadline()) {
            const rest = rows.slice(written);
            await Actor.pushData(rest);
            out += rest.length; written += rest.length;
            await charge('exhibitor', rest.length);
        }
    }
    summary[code] = { listed: total ?? rows.length, written };
}

if (browser) await browser.close().catch(() => {});
if (!out) await Actor.pushData({ note: 'No exhibitors found. Not charged.' });
await Actor.setValue('SUMMARY', summary);
log.info(`Done: ${out} exhibitors.`);
await Actor.exit();
