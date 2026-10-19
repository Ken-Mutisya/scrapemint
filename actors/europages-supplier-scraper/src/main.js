// Europages Supplier Scraper: European B2B suppliers by product and
// country, with website, phone, VAT ID and size.
//
// Strategy
// --------
// europages.co.uk is a Nuxt site. Each page embeds its data in
// <script id="__NUXT_DATA__">, a flattened array where objects point at
// other entries by index (devalue format); unflatten() rebuilds it.
//
//   1. Search: /companies/{product-slug}.html?countries=DE&page=N gives 30
//      companies a page (state.$ssearchCompaniesResponse): name, website,
//      street, city, country, supplier types, founding year, response rate.
//      Pages run out somewhere past 100 with a 404.
//   2. Company page: /en/company/{slug} adds phone, fax, VAT ID, employee
//      count, contacts, keywords, payment methods/terms and Incoterms.
//
// No login, no key, no proxy. Tested from Apify on 2026-10-19.
//
// Pay per event
// -------------
//   company_row ($0.003) one company
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const BASE = 'https://www.europages.co.uk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const CONCURRENCY = 5;
const WRAPPERS = new Set(['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef', 'NuxtError']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    countries = [],
    startUrls = [],
    includeDetails = true,
    requireWebsite = false,
    maxCompanies = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' ? x?.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.min(20000, Math.max(1, Number(maxCompanies) || 100));
const ctry = list(countries).map((c) => c.toUpperCase().replace(/^UK$/, 'GB')).filter((c) => /^[A-Z]{2}$/.test(c));
const slugify = (t) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

function unflatten(arr) {
    const memo = new Map();
    const r = (i) => {
        if (typeof i !== 'number') return i;
        if (i < 0) return null;
        if (memo.has(i)) return memo.get(i);
        const v = arr[i];
        if (Array.isArray(v)) {
            if (typeof v[0] === 'string' && WRAPPERS.has(v[0])) { const o = v.length > 1 ? r(v[1]) : null; memo.set(i, o); return o; }
            if (v[0] === 'Set') { const o = v.slice(1).map(r); memo.set(i, o); return o; }
            if (v[0] === 'Date') return v[1];
            const o = []; memo.set(i, o); for (const x of v) o.push(r(x)); return o;
        }
        if (v && typeof v === 'object') { const o = {}; memo.set(i, o); for (const [k, x] of Object.entries(v)) o[k] = r(x); return o; }
        return v;
    };
    return r(0);
}

async function page(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(60_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const html = await r.text();
            const m = html.match(/<script type="application\/json" id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (!m) throw new Error('no page data');
            return unflatten(JSON.parse(m[1]));
        } catch (err) {
            last = err;
            await sleep(1500 * (attempt + 1));
        }
    }
    throw last;
}

function findKey(o, key, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    if (o[key]) return o[key];
    for (const v of Object.values(o)) { const f = findKey(v, key, depth + 1); if (f) return f; }
    return null;
}

const clean = (s) => (s ? String(s).trim() || null : null);
function searchRow(c) {
    return {
        name: c.name,
        europagesUrl: `${BASE}/en/company/${c.slug}`,
        website: clean(c.homepage),
        country: c.countryCode || null,
        city: clean(c.city),
        street: clean(c.street),
        postalCode: clean(c.zipcode),
        latitude: c.location?.latitude ?? null,
        longitude: c.location?.longitude ?? null,
        description: clean(c.description),
        supplierTypes: c.supplierTypes || [],
        distributionArea: c.distributionArea || null,
        foundingYear: c.foundingYear || null,
        certificates: c.certificatesCount ?? null,
        responseRate: c.responseRate ?? null,
        averageResponseTime: c.averageResponseTime || null,
        logoUrl: c.logoUrl || null,
        slug: c.slug,
    };
}

function detailRow(row, co) {
    if (!co) return row;
    const contacts = (co.contacts || []).map((p) => ({
        name: [p.title, p.firstName, p.lastName].filter((x) => x && x !== 'N/A').join(' ') || null,
        role: p.executiveTypeText || p.executiveType || null,
        phone: p.phoneNumber || null,
        fax: p.faxNumber || null,
    })).filter((p) => p.name || p.phone);
    return {
        ...row,
        phone: co.phoneNumber || contacts.find((p) => p.phone)?.phone || null,
        fax: co.faxNumber || null,
        vatId: co.vatId || null,
        employees: co.employeeCount || null,
        website: row.website || clean(co.homepage),
        address: co.address ? [...(co.address.addressLines || []), [co.address.postalCode, co.address.city].filter(Boolean).join(' '), co.address.countryCode].filter(Boolean).join(', ') : null,
        foundingYear: row.foundingYear || co.foundingYear || null,
        mainBusinessArea: co.mainBusinessArea?.title || null,
        keywords: Array.isArray(co.keywords) ? co.keywords.slice(0, 50) : co.seoKeywords || [],
        contacts,
        paymentMethods: co.paymentMethods?.codes || [],
        paymentTerms: co.paymentTerms || [],
        incoterms: co.incoterms || [],
        certificateNames: (co.certificates || []).map((c) => c?.name || c?.title).filter(Boolean),
        canBeContacted: co.canBeContacted ?? null,
    };
}

// ---- 1. search ----
const searches = [];
for (const u of list(startUrls)) searches.push({ label: u, url: u });
for (const t of list(searchTerms)) {
    const qs = ctry.length ? `?countries=${ctry.join(',')}` : '';
    searches.push({ label: `${t}${ctry.length ? ` / ${ctry.join(',')}` : ''}`, url: `${BASE}/companies/${slugify(t)}.html${qs}` });
}
if (!searches.length) searches.push({ label: 'office furniture', url: `${BASE}/companies/office-furniture.html` }); // empty input runs the prefill

const found = new Map();
const perSearch = {};
for (const s of searches) {
    let total = null;
    let added = 0;
    for (let p = 1; p <= 400 && found.size < cap && !pastDeadline(); p++) {
        const u = new URL(s.url, BASE);
        if (p > 1) u.searchParams.set('page', String(p));
        let d;
        try { d = await page(u.toString()); } catch (err) { log.warning(`${s.label} p${p}: ${err.message}`); break; }
        const res = d?.state?.$ssearchCompaniesResponse;
        if (!res) { if (p === 1) log.warning(`${s.label}: no results page (Europages has no listing under that name; try a broader term).`); break; }
        total = res.total ?? total;
        const companies = res.companies || [];
        for (const c of companies) {
            if (!c?.slug || found.has(c.slug)) continue;
            const row = searchRow(c);
            if (requireWebsite && !row.website) continue;
            row.foundBy = s.label;
            found.set(c.slug, row);
            added++;
            if (found.size >= cap) break;
        }
        if (companies.length < 30) break;
    }
    perSearch[s.label] = { matching: total, added };
    log.info(`${s.label}: ${total ?? 0} matching companies, ${added} added.`);
}

// ---- 2. company pages + output ----
const rows = [...found.values()];
let out = 0;
let failed = 0;
let stop = false;
let next = 0;
async function worker() {
    while (next < rows.length && !stop && !pastDeadline()) {
        let row = rows[next++];
        if (includeDetails) {
            try {
                const d = await page(row.europagesUrl);
                row = detailRow(row, findKey(d?.data, 'company'));
            } catch (err) {
                failed++;
                if (failed <= 3) log.warning(`${row.name}: ${err.message}`);
            }
        }
        delete row.slug;
        await Actor.pushData(row);
        out++;
        try {
            const res = await Actor.charge({ eventName: 'company_row' });
            if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        if (out % 100 === 0) log.info(`${out}/${rows.length} companies written.`);
    }
}
await Promise.all(Array.from({ length: includeDetails ? CONCURRENCY : 1 }, worker));
if (pastDeadline()) log.warning(`Close to the run timeout; wrote ${out} of ${rows.length}.`);

if (!out) await Actor.pushData({ note: 'No Europages companies matched. Not charged.' });
await Actor.setValue('SUMMARY', { companies: out, perSearch, companyPagesFailed: failed });
log.info(`Done: ${out} companies.`);
await Actor.exit();
