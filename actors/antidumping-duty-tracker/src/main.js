// Antidumping & Countervailing Duty Tracker
//
// AD/CVD proceedings from the keyless Federal Register API: which products from
// which countries are under an antidumping or countervailing duty order, where
// each case stands, and what changed. These duties routinely run 20 to 400% and
// sit on top of the tariff-schedule rate, so an order nobody checked for is the
// single most expensive thing an importer can miss.
//
// Endpoint (keyless):
//   https://www.federalregister.gov/api/v1/documents.json
//
// Four upstream shapes that a naive read gets wrong:
//
//   * Rescission is not revocation. "Rescission, in Part, of Antidumping Duty
//     Administrative Review" ends a REVIEW and leaves the order fully in force;
//     "Revocation of Antidumping Duty Order" ends the order. Rescissions
//     outnumber revocations about 17 to 1, so conflating them reports a large
//     share of live orders as dead.
//
//   * The structured docket field is incomplete. Filtering by docket_id on
//     A-570-135 returns 11 documents while a full-text search for the same case
//     number returns 25. The missing 14 are omnibus notices that carry no
//     docket of their own.
//
//   * Those omnibus notices name dozens of unrelated cases at once. They belong
//     in a case history but must never set its status: "Opportunity To Request
//     Administrative Review" listing a case does not mean that case had one.
//
//   * A notice can cover several countries, each a separate case, so product
//     and country are parsed as a list rather than a pair.
//
// Commerce publishes no status field. Whether an order is actually in force is
// derived from the notice sequence, and every case row says which notice set
// its status and whether that was stated outright or inferred.
//
// Free tier: first 3 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';
import {
    extractCaseNumbers, parseCaseNumber, parseTitle, classifyStage, isOmnibus,
    deriveCaseStatus, normalizeCountry, pickCaseCountry, STATUS_NOTES,
} from './adcvd.js';

const FREE_TIER_ROWS = 3;
const API = 'https://www.federalregister.gov/api/v1/documents.json';
const ITA_AGENCY = 'international-trade-administration';
const PAGE_SIZE = 250;
/* The API refuses page * per_page beyond 10,000 results. */
const MAX_RESULT_WINDOW = 10000;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 350;
const FIELDS = [
    'document_number', 'title', 'publication_date', 'type', 'abstract', 'action',
    'citation', 'docket_ids', 'agencies', 'html_url', 'pdf_url', 'dates',
    'effective_on',
];
const SEEN_STORE = 'adcvd-seen';
const SEEN_KEY = 'seen-documents';
const SEEN_CAP = 20000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'notices',
    searchTerms = [],
    caseNumbers = [],
    countries = [],
    dutyType = 'both',
    stages = [],
    dateFrom,
    dateTo,
    onlyActiveOrders = false,
    includeOmnibusNotices = false,
    newOnly = false,
    maxRows = 100,
} = input;

const wantMode = ['notices', 'cases'].includes(mode) ? mode : 'notices';
const terms = toList(searchTerms);
const cases = toList(caseNumbers).map((c) => c.toUpperCase());
const countryFilter = toList(countries).map((c) => (normalizeCountry(c) ?? '').toLowerCase())
    .filter(Boolean);
const wantDuty = ['both', 'antidumping', 'countervailing'].includes(dutyType) ? dutyType : 'both';
const stageFilter = new Set(toList(stages));
const from = isDate(dateFrom) ? dateFrom : null;
const to = isDate(dateTo) ? dateTo : null;

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

const store = newOnly ? await Actor.openKeyValueStore(SEEN_STORE) : null;
const seenAcrossRuns = new Set(newOnly ? ((await store.getValue(SEEN_KEY)) ?? []) : []);
const seenThisRun = new Set();
let pushed = 0;
let stop = false;

log.info(
    `AD/CVD ${wantMode} | ${terms.length} term(s), ${cases.length} case(s)`
    + `${countryFilter.length ? ` | countries=${countryFilter.join(',')}` : ''}`
    + ` | duty=${wantDuty}${from || to ? ` | ${from ?? 'any'} to ${to ?? 'any'}` : ''}`
    + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
);

if (wantMode === 'cases') await runCases();
else await runNotices();

if (newOnly) {
    const merged = [...new Set([...seenAcrossRuns, ...seenThisRun])].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} documents for the next run.`);
}

log.info(`Done. Pushed ${pushed} rows.`);
await Actor.exit();

// ---------- modes ----------

async function runNotices() {
    const queries = buildQueries();
    for (const q of queries) {
        if (done()) break;
        for await (const doc of fetchDocuments(q)) {
            if (done()) break;
            const row = toNoticeRow(doc, q.label);
            if (!row) continue;
            const result = await pushRow(row, 'notice');
            /* Newest-first monitoring stops at the first document it already
             * knows: everything past it is older, so paging on would walk back
             * through years of notices and bill for them. */
            if (result === 'alreadySeen' && newOnly) {
                log.info(`Caught up with "${q.label}"; stopping at the first document already seen.`);
                break;
            }
        }
    }
}

async function runCases() {
    /* A case row is an aggregate, so the case numbers have to be known before
     * their histories can be fetched. Explicit case numbers are used as given;
     * otherwise a search pass discovers which cases match the product or
     * country the caller asked about. */
    const discovered = new Set(cases);
    if (!discovered.size) {
        log.info('No case numbers given; discovering cases from the search terms first.');
        for (const q of buildQueries()) {
            if (Date.now() > SOFT_DEADLINE_AT) break;
            for await (const doc of fetchDocuments(q)) {
                if (Date.now() > SOFT_DEADLINE_AT) break;
                if (isOmnibus(doc)) continue;
                for (const id of docCaseNumbers(doc)) discovered.add(id);
                if (discovered.size >= maxRows * 3) break;
            }
            if (discovered.size >= maxRows * 3) break;
        }
        log.info(`Discovered ${discovered.size} case number(s).`);
    }

    for (const caseNumber of discovered) {
        if (done()) break;
        const parsed = parseCaseNumber(caseNumber);
        if (!parsed) {
            log.warning(`"${caseNumber}" is not a Commerce case number (expected A-570-135 form).`);
            continue;
        }
        if (wantDuty !== 'both' && parsed.dutyType !== wantDuty) continue;

        /* Full-text search rather than the docket filter: the structured field
         * is missing on every omnibus notice, which is more than half the paper
         * trail on a long-running case. */
        const notices = [];
        for await (const doc of fetchDocuments({
            label: caseNumber,
            params: [`conditions[term]=${encodeURIComponent(`"${caseNumber}"`)}`],
            order: 'oldest',
        })) {
            const row = toNoticeRow(doc, caseNumber, caseNumber);
            if (row) notices.push(row);
        }
        if (!notices.length) {
            log.warning(`No notices found for ${caseNumber}.`);
            continue;
        }
        const row = toCaseRow(parsed, notices);
        if (onlyActiveOrders
            && !['activeOrder', 'activeOrderInferred'].includes(row.currentStatus)) continue;
        if (countryFilter.length && !countryFilter.includes(String(row.country ?? '').toLowerCase())) {
            continue;
        }
        await pushRow(row, 'case_summary');
        await sleep(SPACING_MS);
    }
}

/* One query per search term, or a single agency-wide sweep when the caller gave
 * only filters. Case numbers are quoted so the API matches them as a phrase. */
function buildQueries() {
    const out = [];
    for (const t of terms) {
        out.push({ label: t, params: [`conditions[term]=${encodeURIComponent(t)}`] });
    }
    for (const c of cases) {
        out.push({ label: c, params: [`conditions[term]=${encodeURIComponent(`"${c}"`)}`] });
    }
    if (!out.length) out.push({ label: 'all ITA notices', params: [] });
    return out;
}

// ---------- fetching ----------

async function* fetchDocuments(query) {
    const base = [
        `per_page=${PAGE_SIZE}`,
        `order=${query.order ?? 'newest'}`,
        `conditions[agencies][]=${ITA_AGENCY}`,
        ...FIELDS.map((f) => `fields[]=${f}`),
        ...query.params,
    ];
    if (from) base.push(`conditions[publication_date][gte]=${from}`);
    if (to) base.push(`conditions[publication_date][lte]=${to}`);

    for (let page = 1; ; page += 1) {
        if (Date.now() > SOFT_DEADLINE_AT) return;
        /* Asking past the API's result window returns an error rather than an
         * empty page, so stop before crossing it. */
        if ((page - 1) * PAGE_SIZE >= MAX_RESULT_WINDOW) {
            log.warning(
                `"${query.label}" has more than ${MAX_RESULT_WINDOW} results; narrow the date `
                + 'range to reach the rest.',
            );
            return;
        }
        const json = await getJson(`${API}?${base.join('&')}&page=${page}`);
        const results = json?.results ?? [];
        if (page === 1) log.info(`"${query.label}" matched ${json?.count ?? 0} notices.`);
        for (const doc of results) yield doc;
        const total = asNum(json?.count) ?? 0;
        if (!results.length || page * PAGE_SIZE >= Math.min(total, MAX_RESULT_WINDOW)) return;
        await sleep(SPACING_MS);
    }
}

// ---------- shaping ----------

function docCaseNumbers(doc) {
    const dockets = Array.isArray(doc?.docket_ids) ? doc.docket_ids : [];
    const fromDockets = extractCaseNumbers(dockets.join(' '));
    return fromDockets.length ? fromDockets : extractCaseNumbers(doc?.title);
}

function toNoticeRow(doc, matchedTerm, forCase = null) {
    const documentNumber = doc?.document_number ?? null;
    if (!documentNumber) return null;

    const title = doc?.title ?? null;
    const { product, countries: titleCountries, actionClause } = parseTitle(title);
    const stage = classifyStage(title);
    const omnibus = isOmnibus(doc);

    const caseIds = docCaseNumbers(doc);
    const primary = forCase ? parseCaseNumber(forCase) : parseCaseNumber(caseIds[0]);

    /* Cross-check, not an override. The country in the title is what Commerce
     * published; the case number only agrees or does not. */
    const titleCountry = titleCountries[0] ?? null;
    const codeCountry = primary?.countryFromCaseNumber ?? null;
    const agrees = titleCountry && codeCountry
        ? titleCountry.toLowerCase() === codeCountry.toLowerCase()
        : null;

    return {
        documentNumber,
        title,
        publicationDate: doc?.publication_date ?? null,
        effectiveOn: doc?.effective_on ?? null,
        documentType: doc?.type ?? null,
        citation: doc?.citation ?? null,

        caseNumbers: caseIds.length ? caseIds : null,
        primaryCaseNumber: primary?.caseNumber ?? null,
        dutyType: primary?.dutyType ?? null,
        countryCode: primary?.countryCode ?? null,

        product,
        countries: titleCountries.length ? titleCountries : null,
        country: titleCountry,
        countryFromCaseNumber: codeCountry,
        /* Null when either side is missing, so "not checked" stays distinct
         * from "checked and disagreed". */
        countryMatchesCaseNumber: agrees,

        stage: stage.stage,
        stageDetail: actionClause,
        /* Called out because rescission of a review reads like revocation of an
         * order and means the opposite. */
        endsOrder: stage.endsOrder,
        establishesOrder: stage.establishesOrder,
        changesRates: stage.changesRates,

        isCaseSpecific: !omnibus,
        isOmnibusNotice: omnibus,

        abstract: doc?.abstract ?? null,
        action: doc?.action ?? null,
        dates: doc?.dates ?? null,
        agencies: Array.isArray(doc?.agencies)
            ? doc.agencies.map((a) => a?.name).filter(Boolean) : null,
        documentUrl: doc?.html_url ?? null,
        pdfUrl: doc?.pdf_url ?? null,

        matchedSearchTerm: matchedTerm ?? null,
        source: 'US Federal Register, International Trade Administration',
        scrapedAt: new Date().toISOString(),
    };
}

function toCaseRow(parsed, notices) {
    const status = deriveCaseStatus(notices, parsed.caseNumber);
    const caseSpecific = notices.filter((n) => n.isCaseSpecific);
    const dated = caseSpecific.filter((n) => n.publicationDate)
        .sort((a, b) => (a.publicationDate < b.publicationDate ? -1 : 1));

    /* The product and country come from case-specific notices only. An omnibus
     * notice lists dozens of unrelated products, so reading either off one
     * would attach another case's goods to this one. */
    const singleCase = dated.filter(
        (n) => !Array.isArray(n.caseNumbers) || n.caseNumbers.length <= 1,
    );
    const product = (singleCase.find((n) => n.product) ?? dated.find((n) => n.product))
        ?.product ?? null;
    const country = pickCaseCountry(dated, parsed.countryFromCaseNumber);

    return {
        caseNumber: parsed.caseNumber,
        dutyType: parsed.dutyType,
        countryCode: parsed.countryCode,
        country,
        countryFromCaseNumber: parsed.countryFromCaseNumber,
        product,

        currentStatus: status.currentStatus,
        currentStatusNote: STATUS_NOTES[status.currentStatus] ?? null,
        /* `stated` means a notice said so outright; `inferred` means it was
         * read off surrounding activity, which is weaker and should be treated
         * that way when money depends on it. */
        statusConfidence: status.statusConfidence,
        statusSetByDocument: status.statusSetByDocument,
        statusSetByTitle: status.statusSetByTitle,
        statusAsOf: status.statusAsOf,
        /* Populated when a later joint notice covering several cases points at
         * a different status. Which case it acted on is not stated, so the
         * disagreement is reported rather than resolved. */
        conflictingNoticeDocument: status.conflictingNoticeDocument ?? null,
        conflictingNoticeTitle: status.conflictingNoticeTitle ?? null,
        conflictingNoticeDate: status.conflictingNoticeDate ?? null,

        orderIssuedDate: status.orderIssuedDate,
        revokedDate: status.revokedDate,
        lastRateActionDate: status.lastRateActionDate,

        noticeCount: notices.length,
        caseSpecificNoticeCount: caseSpecific.length,
        omnibusNoticeCount: notices.length - caseSpecific.length,
        firstNoticeDate: dated.length ? dated[0].publicationDate : null,
        latestNoticeDate: dated.length ? dated[dated.length - 1].publicationDate : null,

        notices: dated.map((n) => ({
            documentNumber: n.documentNumber,
            publicationDate: n.publicationDate,
            stage: n.stage,
            title: n.title,
            documentUrl: n.documentUrl,
        })),

        /* Stated on every case row: the rate itself is published in tables
         * inside the notice body and varies by exporter, so this actor points
         * at the notice rather than inventing a single number for the case. */
        ratesNote: 'Cash deposit rates are set per exporter in the tables inside each notice, and '
            + 'change at every administrative review. Open the notice at lastRateActionDate for '
            + 'the rate that applies to your supplier.',
        source: 'US Federal Register, International Trade Administration',
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- output ----------

async function pushRow(row, eventName) {
    const key = eventName === 'case_summary' ? row.caseNumber : row.documentNumber;
    if (seenThisRun.has(key)) return 'duplicate';
    seenThisRun.add(key);
    /* Reported back so newest-first monitoring can tell "nothing new here" apart
     * from "filtered out" and stop paging. */
    if (newOnly && seenAcrossRuns.has(key)) return 'alreadySeen';

    /* Filters run before the charge, so a caller is never billed for rows their
     * own filters removed. */
    if (eventName === 'notice') {
        if (!includeOmnibusNotices && row.isOmnibusNotice) return 'filtered';
        if (stageFilter.size && !stageFilter.has(row.stage)) return 'filtered';
        if (wantDuty !== 'both' && row.dutyType && row.dutyType !== wantDuty) return 'filtered';
        if (countryFilter.length) {
            const hit = (row.countries ?? []).some((c) => countryFilter.includes(c.toLowerCase()));
            if (!hit) return 'filtered';
        }
    }

    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 25 === 0) log.info(`Pushed ${pushed} rows...`);
    return 'pushed';
}

// ---------- helpers ----------

function done() {
    if (stop) return true;
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        stop = true;
        return true;
    }
    return false;
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Scrapemint AD/CVD Tracker actor (admin@scrapemint.com)',
                    Accept: 'application/json',
                },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return JSON.parse(await res.text());
        } catch (err) {
            if (attempt === 3) {
                log.warning(`fetch failed: ${err?.message}`);
                return null;
            }
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

function toList(v) {
    return (Array.isArray(v) ? v : [v])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
}
function asNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
