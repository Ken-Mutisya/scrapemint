// BBB Business Leads: local businesses from the Better Business Bureau
// directory with phone, address, rating and accreditation.
//
// Strategy
// --------
// GET bbb.org/api/search?find_country=USA&find_text={type}&find_loc={city
// or ZIP}&page={n}&sort=Relevance returns 15 businesses a page and at most
// 15 pages (totalPages caps at 15 even when totalResults is in the
// thousands). Asking past totalPages hangs, so paging stops there.
// Each row has name, phones, street address, BBB rating and score,
// accreditation, categories, service areas, coordinates and profile links.
//
// Profile pages (/us/.../profile/...) answer 403 from datacenter IPs, so
// this actor uses the search API only: no emails or websites.
//
// No key, no proxy. Tested from Apify on 2026-10-19.
//
// Pay per event
// -------------
//   business_row ($0.002) one business
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const BASE = 'https://www.bbb.org';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const PAGE_SIZE = 15;
const MAX_PAGES = 15;
const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    locations = [],
    country = 'US',
    accreditedOnly = false,
    minRating = 'any',
    requirePhone = true,
    strictMatch = false,
    maxResultsPerSearch = 225,
    maxResults = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// An empty input (store health checks) runs the form's prefill.
const terms = list(searchTerms).length ? list(searchTerms) : ['roofing'];
const locs = list(locations).length ? list(locations) : ['Austin, TX'];
const findCountry = String(country).toUpperCase().startsWith('C') ? 'CAN' : 'USA';
const perSearch = Math.min(225, Math.max(1, Number(maxResultsPerSearch) || 225));
const cap = Math.max(1, Number(maxResults) || 500);
const minIdx = GRADES.indexOf(minRating);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 60_000;

async function search(term, loc, page) {
    const qs = new URLSearchParams({ find_country: findCountry, find_text: term, find_loc: loc, page: String(page), sort: 'Relevance' });
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(`${BASE}/api/search?${qs}`, {
                headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${BASE}/search?${qs}` },
                signal: AbortSignal.timeout(30_000),
            });
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

const strip = (s) => (s ? String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim() || null : null);
const abs = (p) => (p ? (p.startsWith('http') ? p : BASE + p) : null);

function toRow(b, term, loc) {
    const [lat, lng] = String(b.location || '').split(',').map(Number);
    const phones = (b.phone || []).filter(Boolean);
    return {
        name: strip(b.businessName),
        phone: phones[0] || null,
        phones,
        address: strip(b.address),
        city: b.city || null,
        state: b.state || null,
        postalCode: b.postalcode || null,
        country: findCountry === 'CAN' ? 'CA' : 'US',
        category: b.tobText || null,
        categories: (b.categories || []).map((c) => c.name).filter(Boolean),
        rating: b.rating || null,
        ratingScore: b.ratingScore ?? null,
        accredited: !!b.bbbMember,
        isCharity: !!b.isCharity,
        outOfBusiness: b.outOfBusinessStatus || null,
        serviceAreas: b.serviceAreasSummary || [],
        bbbProfileUrl: abs(b.reportUrl),
        requestQuoteUrl: b.raqEnabled ? abs(b.requestAQuoteUrl) : null,
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lng) ? lng : null,
        logoUrl: b.logoUri || null,
        localBbb: b.bbbName || null,
        businessId: b.businessId || null,
        bbbId: b.bbbId || null,
        searchTerm: term,
        searchLocation: loc,
    };
}

// BBB search also returns neighbouring trades (a roofing search brings some general contractors).
const stem = (t) => t.toLowerCase().replace(/(ing|ers|er|s)$/, '');
function keep(row, term) {
    if (strictMatch && ![row.name, ...row.categories].join(' ').toLowerCase().includes(stem(term))) return false;
    if (requirePhone && !row.phone) return false;
    if (accreditedOnly && !row.accredited) return false;
    if (minIdx >= 0) {
        const i = GRADES.indexOf(row.rating);
        if (i < 0 || i > minIdx) return false;
    }
    if (row.outOfBusiness) return false;
    return true;
}

const seen = new Set();
const summary = {};
let out = 0;
let stop = false;
for (const term of terms) {
    for (const loc of locs) {
        if (stop || out >= cap || pastDeadline()) break;
        const label = `${term} / ${loc}`;
        let added = 0;
        let total = null;
        let totalPages = MAX_PAGES;
        for (let page = 1; page <= Math.min(totalPages, MAX_PAGES) && added < perSearch && out < cap && !stop; page++) {
            let res;
            try { res = await search(term, loc, page); } catch (err) { log.warning(`${label} p${page}: ${err.message}`); break; }
            if (res.errorMessage) { log.warning(`${label}: ${res.errorMessage}`); break; }
            total = res.totalResults ?? total;
            totalPages = res.totalPages ?? totalPages;
            const results = res.results || [];
            for (const b of results) {
                const key = b.id || `${b.businessId}_${b.bbbId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const row = toRow(b, term, loc);
                if (!keep(row, term)) continue;
                await Actor.pushData(row);
                out++; added++;
                try {
                    const r = await Actor.charge({ eventName: 'business_row' });
                    if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; break; }
                } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
                if (added >= perSearch || out >= cap) break;
            }
            if (results.length < PAGE_SIZE) break;
        }
        summary[label] = { bbbTotal: total, written: added };
        log.info(`${label}: ${added} businesses written (BBB lists ${total ?? 0}).`);
    }
}

if (!out) await Actor.pushData({ note: 'No BBB businesses matched. Not charged.' });
await Actor.setValue('SUMMARY', { businesses: out, perSearch: summary });
log.info(`Done: ${out} businesses.`);
await Actor.exit();
