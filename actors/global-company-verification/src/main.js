// Global Company Verification: Registry & Ownership Lookup
//
// Strategy
// --------
// Verify legal entities worldwide against GLEIF, the official global Legal
// Entity Identifier registry (keyless public JSON:API, ~2.5M entities).
// Inputs are company names (fulltext search) or 20-character LEI codes
// (direct fetch); each hit becomes one row with the official registered
// name, addresses, status, local registry number, and (optionally) the
// direct and ultimate parent companies from the relationship endpoints —
// parent lookups that report "Resource not found" simply mean no parent is
// reported. GLEIF rate-limits per IP (~60 req/min, shared on the platform):
// requests are spaced, 429s get one backoff retry, and a persistent 429
// stops the run cleanly with partial data.
//
// Pay per event
// -------------
//   company_found ($0.005) charged per verified entity row. Searches with
//   no match produce free note rows. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const API = 'https://api.gleif.org/api/v1';
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_GAP_MS = 350; // stay well under GLEIF's per-IP budget
const UA = 'GlobalCompanyVerification/1.0 (+https://apify.com/scrapemint/global-company-verification)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    country,
    activeOnly = false,
    maxResultsPerQuery = 5,
    includeParents = true,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const wanted = asList(queries);
const countryCode = /^[A-Za-z]{2}$/.test(String(country || '').trim()) ? String(country).trim().toUpperCase() : null;
const perQuery = Math.max(1, Math.min(50, Number(maxResultsPerQuery) || 5));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const isLei = (s) => /^[A-Z0-9]{18}[0-9]{2}$/.test(s.toUpperCase());

if (!wanted.length) {
    log.warning('No queries given. Provide company names or 20-character LEI codes, one per line.');
    await Actor.exit();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rateLimited = false;

async function getJson(url, retried = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/vnd.api+json' },
        });
        if (res.status === 404) return { notFound: true };
        if (res.status === 429) {
            if (!retried) {
                log.warning('GLEIF rate limit hit; backing off 15s...');
                await sleep(15000);
                return getJson(url, true);
            }
            rateLimited = true;
            return null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 90)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const addr = (a) => (a ? {
    addressLines: (a.addressLines || []).map(clean).filter(Boolean).join(', ') || null,
    city: clean(a.city),
    region: clean(a.region),
    postalCode: clean(a.postalCode),
    country: clean(a.country),
} : { addressLines: null, city: null, region: null, postalCode: null, country: null });

function toRow(record, query) {
    const a = record.attributes;
    const e = a.entity;
    const legal = addr(e.legalAddress);
    const hq = addr(e.headquartersAddress);
    return {
        query,
        lei: a.lei,
        legalName: clean(e.legalName?.name),
        otherNames: (e.otherNames || []).map((n) => clean(n?.name)).filter(Boolean),
        entityStatus: clean(e.status),
        entityCategory: clean(e.category),
        jurisdiction: clean(e.jurisdiction),
        legalFormId: clean(e.legalForm?.id),
        localRegistryId: clean(e.registeredAs),
        registrationAuthority: clean(e.registeredAt?.id),
        legalAddress: legal.addressLines,
        legalCity: legal.city,
        legalRegion: legal.region,
        legalPostalCode: legal.postalCode,
        legalCountry: legal.country,
        hqAddress: hq.addressLines,
        hqCity: hq.city,
        hqCountry: hq.country,
        entityCreationDate: clean(e.creationDate),
        leiRegistrationStatus: clean(a.registration?.status),
        leiFirstRegistered: clean(a.registration?.initialRegistrationDate),
        leiLastUpdated: clean(a.registration?.lastUpdateDate),
        leiNextRenewal: clean(a.registration?.nextRenewalDate),
    };
}

async function fetchParent(lei, kind) {
    await sleep(REQUEST_GAP_MS);
    const d = await getJson(`${API}/lei-records/${lei}/${kind}`);
    if (!d || d.notFound || !d.data) return { lei: null, name: null };
    return {
        lei: clean(d.data.attributes?.lei),
        name: clean(d.data.attributes?.entity?.legalName?.name),
    };
}

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'company_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Verifying ${wanted.length} quer(ies) against the GLEIF registry${countryCode ? `, country ${countryCode}` : ''}${activeOnly ? ', active only' : ''}. Cap ${cap} rows.`);

outer:
for (const query of wanted) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    if (rateLimited) {
        log.warning('GLEIF rate limit persists; stopping with partial results. Re-run for the rest.');
        break;
    }
    if (rowsPushed >= cap) break;
    await sleep(REQUEST_GAP_MS);

    let records = [];
    if (isLei(query)) {
        const d = await getJson(`${API}/lei-records/${query.toUpperCase()}`);
        if (d?.data) records = [d.data];
        else if (d?.notFound) {
            await flushRow({ query, note: 'LEI not found in the GLEIF registry.' }, false);
            continue;
        }
    } else {
        const p = new URLSearchParams({ 'filter[fulltext]': query, 'page[size]': String(perQuery) });
        if (countryCode) p.set('filter[entity.legalAddress.country]', countryCode);
        if (activeOnly) p.set('filter[entity.status]', 'ACTIVE');
        const d = await getJson(`${API}/lei-records?${p.toString()}`);
        records = d?.data || [];
    }

    if (!records.length) {
        await flushRow({ query, note: 'No match in the GLEIF registry. Only entities active in financial markets carry an LEI; a small local business may legitimately have none.' }, false);
        continue;
    }

    let n = 0;
    for (const record of records) {
        if (rowsPushed >= cap) { log.warning('Row cap reached.'); break outer; }
        const row = toRow(record, query);
        if (includeParents) {
            const direct = await fetchParent(row.lei, 'direct-parent');
            const ultimate = await fetchParent(row.lei, 'ultimate-parent');
            row.directParentLei = direct.lei;
            row.directParentName = direct.name;
            row.ultimateParentLei = ultimate.lei;
            row.ultimateParentName = ultimate.name;
        }
        await flushRow({ ...row, scrapedAt: new Date().toISOString() });
        n += 1;
    }
    log.info(`${query}: ${n} entity row(s).`);
}

log.info(`Done. ${rowsPushed} company row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
