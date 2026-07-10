// Government Contract Winner Leads: New Federal Contract Awards
//
// Strategy
// --------
// USAspending.gov publishes every federal contract award through a keyless
// JSON API. Search awards signed in the last N days (date_type=date_signed
// catches NEW awards, not modifications) filtered by keyword, NAICS, agency
// and amount, then enrich each winner via the recipient profile endpoint:
// street address, UEI, business-type flags and lifetime prime award total.
// A company that just won a contract is hiring, buying and subcontracting;
// one row per award is a timed sales trigger.
//
// Pay per event
// -------------
//   lead_row ($0.015) per award row with recipient profile enrichment
//   (address, business types, lifetime totals). award_row ($0.005) when
//   enrichment is off or the recipient profile is unavailable. First 2 rows
//   per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 30000;
const ENRICH_CONCURRENCY = 8;
const API = 'https://api.usaspending.gov/api/v2';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    naicsCodes = [],
    agencies = [],
    daysBack = 7,
    minAmount = 0,
    smallBusinessOnly = false,
    enrichRecipient = true,
    maxAwards = 50,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(keywords);
const naics = asList(naicsCodes);
const agencyNames = asList(agencies);
const days = Math.max(1, Math.min(90, Number(daysBack) || 7));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxAwards) || 50));
const floor = Math.max(0, Number(minAmount) || 0);

async function fetchJson(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            ...opts,
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                'user-agent': 'GovernmentContractWinnerLeads/1.0 (+https://apify.com/scrapemint/government-contract-winner-leads)',
                ...(opts.headers || {}),
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function buildFilters() {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const filters = {
        time_period: [{
            start_date: start.toISOString().slice(0, 10),
            end_date: end.toISOString().slice(0, 10),
            date_type: 'date_signed',
        }],
        award_type_codes: ['A', 'B', 'C', 'D'],
    };
    if (kws.length) filters.keywords = kws;
    if (naics.length) filters.naics_codes = naics;
    if (agencyNames.length) {
        filters.agencies = agencyNames.map((name) => ({ type: 'awarding', tier: 'toptier', name }));
    }
    if (floor > 0) filters.award_amounts = [{ lower_bound: floor }];
    if (smallBusinessOnly) filters.recipient_type_names = ['small_business'];
    return filters;
}

const FIELDS = [
    'Award ID', 'Recipient Name', 'Award Amount', 'Description',
    'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date',
    'recipient_id', 'Place of Performance State Code', 'Place of Performance City Code',
    'NAICS', 'PSC',
];

async function searchAwards() {
    const awards = [];
    const filters = buildFilters();
    for (let page = 1; awards.length < cap; page++) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        // Keyword search on USAspending can take 30s+ cold; allow 75s and
        // retry twice before giving up on the page.
        let data = null;
        for (let attempt = 1; attempt <= 3 && !data; attempt++) {
            try {
                data = await fetchJson(`${API}/search/spending_by_award/`, {
                    method: 'POST',
                    body: JSON.stringify({
                        filters,
                        fields: FIELDS,
                        limit: Math.min(PAGE_SIZE, cap - awards.length),
                        page,
                        sort: 'Award Amount',
                        order: 'desc',
                    }),
                }, 75000);
            } catch (err) {
                log.warning(`Award search page ${page} attempt ${attempt} failed: ${err?.message}`);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
            }
        }
        if (!data) break;
        const results = data?.results || [];
        awards.push(...results);
        if (!data?.page_metadata?.hasNext || !results.length) break;
    }
    return awards.slice(0, cap);
}

async function enrich(recipientId, attempt = 0) {
    if (!recipientId) return null;
    try {
        const r = await fetchJson(`${API}/recipient/${recipientId}/`);
        const loc = r?.location || {};
        const types = r?.business_types || [];
        return {
            uei: r?.uei || null,
            addressLine1: loc.address_line1 || null,
            city: loc.city_name || null,
            state: loc.state_code || null,
            zip: loc.zip || null,
            country: loc.country_code || null,
            businessTypes: types,
            smallBusiness: types.includes('small_business'),
            lifetimePrimeAwards: r?.total_transaction_amount ?? null,
        };
    } catch {
        // Profile lookups are transiently flaky under concurrency; retry once.
        if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1500));
            return enrich(recipientId, 1);
        }
        return null;
    }
}

let rowsPushed = 0;
let charged = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName });
            charged += 1;
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const awards = await searchAwards();
if (!awards.length) {
    log.warning('No new awards matched. Widen daysBack, drop filters, or lower minAmount.');
    await Actor.exit();
}
log.info(`${awards.length} new award(s) matched${enrichRecipient ? ', enriching recipients' : ''}.`);

for (let i = 0; i < awards.length; i += ENRICH_CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = awards.slice(i, i + ENRICH_CONCURRENCY);
    const profiles = await Promise.all(
        batch.map((a) => (enrichRecipient ? enrich(a.recipient_id) : Promise.resolve(null))),
    );
    for (let j = 0; j < batch.length; j++) {
        const a = batch[j];
        const p = profiles[j];
        await flushRow({
            awardId: a['Award ID'],
            recipientName: a['Recipient Name'],
            awardAmount: a['Award Amount'],
            description: a.Description || null,
            awardingAgency: a['Awarding Agency'],
            awardingSubAgency: a['Awarding Sub Agency'],
            naicsCode: a.NAICS?.code || null,
            naicsDescription: a.NAICS?.description || null,
            pscCode: a.PSC?.code || null,
            pscDescription: a.PSC?.description || null,
            placeOfPerformanceState: a['Place of Performance State Code'] || null,
            startDate: a['Start Date'] || null,
            endDate: a['End Date'] || null,
            usaspendingUrl: a.generated_internal_id
                ? `https://www.usaspending.gov/award/${a.generated_internal_id}` : null,
            ...(p || {}),
            enriched: !!p,
            source: 'usaspending.gov',
            scrapedAt: new Date().toISOString(),
        }, p ? 'lead_row' : 'award_row');
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${charged} charged.`);
await Actor.exit();
