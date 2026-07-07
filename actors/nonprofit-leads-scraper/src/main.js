// Nonprofit Leads Scraper: IRS 990 Revenue, Assets & Contacts
//
// Strategy
// --------
// Search ProPublica's Nonprofit Explorer public API (keyless JSON on IRS
// data) per term x state, merge and dedupe by EIN, optionally enrich each
// organization with its 990 financials (latest revenue/expenses/assets and
// a multi-year revenue trend), then filter by revenue band and push one
// row per organization. Optional cross-run dedupe turns a scheduled run
// into a new-prospect feed.
//
// Pay per event
// -------------
//   org_row ($0.01) charged per organization pushed WITH financial data
//   (or per row when financials are disabled). Organizations that have no
//   filing data are pushed as free rows. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const FETCH_TIMEOUT_MS = 25000;
const DETAIL_CONCURRENCY = 5;
const TREND_YEARS = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    states = [],
    nteeCategories = [],
    minRevenue,
    maxRevenue,
    includeFinancials = true,
    maxOrgs = 25,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const terms = asList(searchTerms);
const sts = asList(states).map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
const ntees = asList(nteeCategories).filter((n) => /^([1-9]|10)$/.test(n));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxOrgs) || 25));
const minRev = Number.isFinite(Number(minRevenue)) && minRevenue != null ? Number(minRevenue) : null;
const maxRev = Number.isFinite(Number(maxRevenue)) && maxRevenue != null ? Number(maxRevenue) : null;
const needFinancials = includeFinancials || minRev != null || maxRev != null;

if (!terms.length && !sts.length && !ntees.length) {
    log.warning('Provide at least one of "searchTerms", "states", or "nteeCategories".');
    await Actor.exit();
}

const seenStore = dedupe ? await Actor.openKeyValueStore('nonprofits-seen') : null;
const seen = new Set();
if (seenStore) for (const e of (await seenStore.getValue('seen-eins')) || []) seen.add(String(e));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'NonprofitLeadsScraper/1.0 (+https://apify.com/scrapemint/nonprofit-leads-scraper)' },
        });
        if (res.status === 404) return null;
        if (!res.ok) { log.warning(`ProPublica HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function searchUrl(term, state, ntee, page) {
    const p = new URLSearchParams();
    if (term) p.set('q', term);
    if (state) p.set('state[id]', state);
    if (ntee) p.set('ntee[id]', ntee);
    if (page) p.set('page', String(page));
    return `https://projects.propublica.org/nonprofits/api/v2/search.json?${p.toString()}`;
}

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

async function enrich(ein) {
    const d = await getJson(`https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`);
    if (!d) return { hasFinancials: false };
    const org = d.organization || {};
    const filings = (d.filings_with_data || [])
        .filter((f) => f.tax_prd_yr)
        .sort((a, b) => (b.tax_prd_yr || 0) - (a.tax_prd_yr || 0));
    const latest = filings[0];
    const revenueByYear = {};
    for (const f of filings.slice(0, TREND_YEARS)) revenueByYear[f.tax_prd_yr] = num(f.totrevenue);
    return {
        hasFinancials: Boolean(latest),
        latestFilingYear: latest?.tax_prd_yr ?? null,
        totalRevenue: num(latest?.totrevenue),
        totalExpenses: num(latest?.totfuncexpns),
        totalAssets: num(latest?.totassetsend),
        revenueByYear: Object.keys(revenueByYear).length ? revenueByYear : null,
        filingsAvailable: filings.length,
        latestFilingPdf: latest?.pdf_url || null,
        address: org.address || null,
        zipcode: org.zipcode || null,
        subsectionCode: org.subsection_code ?? null,
        rulingDate: org.ruling_date || null,
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (chargeable && rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'org_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// --- search fan-out ---
const combos = [];
for (const t of terms.length ? terms : ['']) {
    for (const s of sts.length ? sts : ['']) {
        for (const n of ntees.length ? ntees : ['']) combos.push({ t, s, n });
    }
}

log.info(`Searching Nonprofit Explorer: ${combos.length} search combo(s), cap ${cap}${needFinancials ? ', with financials' : ''}.`);

const hits = new Map();
outer:
for (const c of combos) {
    let page = 0;
    while (hits.size < cap * 3) {
        if (deadlineMs && Date.now() > deadlineMs) break outer;
        const d = await getJson(searchUrl(c.t, c.s, c.n, page));
        const orgs = d?.organizations || [];
        if (!orgs.length) break;
        for (const o of orgs) {
            const ein = String(o.ein);
            if (!hits.has(ein)) hits.set(ein, { ...o, matchedTerm: c.t || null });
        }
        page += 1;
        if (orgs.length < 25 || page * 25 >= (d?.total_results || 0)) break;
    }
    log.info(`Search "${c.t || '(none)'}"${c.s ? `/${c.s}` : ''}: ${hits.size} unique org(s) so far.`);
}

const candidates = [...hits.values()].filter((o) => !seen.has(String(o.ein)));
log.info(`${candidates.length} candidate org(s)${dedupe ? ` (${hits.size - candidates.length} skipped as seen)` : ''}.`);

for (let i = 0; i < candidates.length && rowsPushed < cap; i += DETAIL_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((o) => (needFinancials ? enrich(o.ein) : Promise.resolve(null))));
    for (let j = 0; j < batch.length && rowsPushed < cap; j++) {
        const o = batch[j];
        const det = details[j];
        if (det && (minRev != null || maxRev != null)) {
            const rev = det.totalRevenue;
            if (rev == null) continue;
            if (minRev != null && rev < minRev) continue;
            if (maxRev != null && rev > maxRev) continue;
        }
        seen.add(String(o.ein));
        const chargeable = det ? det.hasFinancials : true;
        await flushRow({
            ein: o.ein,
            name: o.name || null,
            city: o.city || null,
            state: o.state || null,
            nteeCode: o.ntee_code || null,
            subsectionCode: det?.subsectionCode ?? o.subseccd ?? null,
            profileUrl: `https://projects.propublica.org/nonprofits/organizations/${o.ein}`,
            matchedTerm: o.matchedTerm,
            ...(det ? {
                latestFilingYear: det.latestFilingYear,
                totalRevenue: det.totalRevenue,
                totalExpenses: det.totalExpenses,
                totalAssets: det.totalAssets,
                revenueByYear: det.revenueByYear,
                filingsAvailable: det.filingsAvailable,
                latestFilingPdf: det.latestFilingPdf,
                address: det.address,
                zipcode: det.zipcode,
                rulingDate: det.rulingDate,
                hasFinancials: det.hasFinancials,
            } : {}),
            scrapedAt: new Date().toISOString(),
        }, chargeable);
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-eins', [...seen].slice(-200000));
}

log.info(`Done. ${rowsPushed} org row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
