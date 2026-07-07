// Grant Opportunity Finder: US Federal Grants with Deadlines
//
// Strategy
// --------
// Query grants.gov's official public Search2 API (keyless JSON POST) per
// keyword, merge and dedupe hits, optionally enrich each opportunity via
// fetchOpportunity (award amounts, eligibility, description, agency contact
// email), and push one row per grant opportunity. Optional cross-run dedupe
// in a named key-value store turns a scheduled run into a new-grant alert.
//
// Pay per event
// -------------
//   opportunity_row ($0.01) charged per opportunity pushed. Searches that
//   match nothing cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const SEARCH_PAGE = 100;
const FETCH_TIMEOUT_MS = 25000;
const DETAIL_CONCURRENCY = 5;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    oppStatuses = ['posted'],
    agencyCodes = [],
    fundingCategories = [],
    eligibilityCodes = [],
    includeDetails = true,
    maxOpportunities = 25,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(keywords);
const statuses = asList(oppStatuses).map((s) => s.toLowerCase()).filter((s) => ['posted', 'forecasted', 'closed', 'archived'].includes(s));
const agencies = asList(agencyCodes);
const cats = asList(fundingCategories);
const eligs = asList(eligibilityCodes);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxOpportunities) || 25));

if (!kws.length && !agencies.length && !cats.length) {
    log.warning('Provide at least one of "keywords", "agencyCodes", or "fundingCategories".');
    await Actor.exit();
}
if (!statuses.length) statuses.push('posted');
const searches = kws.length ? kws : [''];

const seenStore = dedupe ? await Actor.openKeyValueStore('grants-seen') : null;
const seen = new Set();
if (seenStore) for (const id of (await seenStore.getValue('seen-ids')) || []) seen.add(String(id));

async function post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'GrantOpportunityFinder/1.0 (+https://apify.com/scrapemint/grant-opportunity-finder)',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) { log.warning(`grants.gov HTTP ${res.status}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`grants.gov request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const money = (v) => {
    if (v == null || v === '' || String(v).toLowerCase() === 'none') return null;
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
};

async function enrich(oppId) {
    const d = (await post('https://api.grants.gov/v1/api/fetchOpportunity', { opportunityId: Number(oppId) }))?.data;
    if (!d) return {};
    const syn = d.synopsis || d.forecast || {};
    return {
        agencyName: (d.agencyDetails || {}).agencyName || syn.agencyName || null,
        awardCeiling: money(syn.awardCeiling),
        awardFloor: money(syn.awardFloor),
        estimatedFunding: money(syn.estimatedFunding),
        expectedNumberOfAwards: syn.expectedNumberOfAwards != null ? Number(syn.expectedNumberOfAwards) || null : null,
        applicantTypes: (syn.applicantTypes || []).map((t) => t.description).filter(Boolean),
        fundingCategories: (syn.fundingActivityCategories || []).map((c) => c.description).filter(Boolean),
        fundingInstruments: (syn.fundingInstruments || []).map((c) => c.description).filter(Boolean),
        agencyContactEmail: syn.agencyContactEmail || syn.grantorContactEmail || null,
        agencyContactName: syn.agencyContactName || null,
        description: (syn.synopsisDesc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || null,
        costSharing: syn.costSharing ?? null,
        cfdas: (d.cfdas || []).map((c) => c.cfdaNumber || c.programTitle).filter(Boolean),
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'opportunity_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Searching grants.gov: ${searches.length} search(es), statuses [${statuses.join(',')}], cap ${cap}.`);

const hits = new Map();
for (const kw of searches) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    let start = 0;
    while (hits.size < cap * 2) {
        const body = {
            keyword: kw || undefined,
            oppStatuses: statuses.join('|'),
            rows: SEARCH_PAGE,
            startRecordNum: start,
            ...(agencies.length ? { agencies: agencies.join('|') } : {}),
            ...(cats.length ? { fundingCategories: cats.join('|') } : {}),
            ...(eligs.length ? { eligibilities: eligs.join('|') } : {}),
        };
        const d = (await post('https://api.grants.gov/v1/api/search2', body))?.data;
        const page = d?.oppHits || [];
        if (!page.length) break;
        for (const h of page) {
            const id = String(h.id);
            if (!hits.has(id)) hits.set(id, { ...h, matchedKeyword: kw || null });
        }
        start += page.length;
        if (page.length < SEARCH_PAGE || start >= (d?.hitCount || 0)) break;
    }
    log.info(`Search "${kw || '(no keyword)'}": ${hits.size} unique hit(s) so far.`);
}

// grants.gov relevance ordering surfaces stale items; prefer newest openDate
// and drop opportunities whose application deadline has already passed.
const parseUsDate = (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
    return m ? Date.parse(`${m[3]}-${m[1]}-${m[2]}`) : null;
};
const today = Date.now() - 24 * 3600 * 1000;
const candidates = [...hits.values()]
    .filter((h) => !seen.has(String(h.id)))
    .filter((h) => {
        const close = parseUsDate(h.closeDate);
        return close == null || close >= today;
    })
    .sort((a, b) => (parseUsDate(b.openDate) || 0) - (parseUsDate(a.openDate) || 0))
    .slice(0, cap);
log.info(`${candidates.length} opportunit(ies) to push${dedupe ? ` (${hits.size - candidates.length} skipped as seen)` : ''}.`);

for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((h) => (includeDetails ? enrich(h.id) : Promise.resolve({}))));
    for (let j = 0; j < batch.length; j++) {
        const h = batch[j];
        seen.add(String(h.id));
        await flushRow({
            opportunityId: h.id,
            opportunityNumber: h.number || null,
            title: h.title || null,
            agencyCode: h.agencyCode || h.agency || null,
            agencyName: details[j].agencyName || h.agencyName || null,
            status: h.oppStatus || null,
            openDate: h.openDate || null,
            closeDate: h.closeDate || null,
            docType: h.docType || null,
            cfdaList: h.alnist || h.cfdaList || [],
            url: `https://www.grants.gov/search-results-detail/${h.id}`,
            matchedKeyword: h.matchedKeyword,
            ...details[j],
            scrapedAt: new Date().toISOString(),
        });
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen].slice(-100000));
}

log.info(`Done. ${rowsPushed} opportunity row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
