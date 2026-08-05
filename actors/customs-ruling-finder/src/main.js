// Customs Ruling Finder
//
// CBP classification precedent from the keyless CROSS API: which HTS code
// Customs actually assigned to a product, in which ruling, and whether that
// ruling still stands. Search by product name or tariff code, optionally pull
// the full ruling text. No browser, no login, no API key.
//
// Endpoints (keyless):
//   https://rulings.cbp.gov/api/search           summaries, paged
//   https://rulings.cbp.gov/api/ruling/{number}  full ruling text
//
// Five upstream shapes that a naive read gets wrong:
//
//   * CROSS writes a ten-digit code 4.2.4 ("6109.10.0040"). The tariff schedule
//     writes the same digits 4.2.2.2 ("6109.10.00.40"). Search matches the term
//     literally, so the HTS form returns ZERO hits where the CROSS form returns
//     121, and a digits-only code returns zero as well. Codes are reformatted
//     before searching, and both forms are emitted so rows join cleanly against
//     tariff data.
//
//   * Revoked rulings are returned inline with live ones and look identical. A
//     customs ruling is legal authority, so every row states its precedent
//     status and names whatever superseded it.
//
//   * About 1% of rulings carry "0001-01-01" as their date, meaning the date
//     metadata is missing. Published as-is they sort as year 1 and poison any
//     date filter, so they become null and are flagged.
//
//   * The default sort is relevance and returns 1990s rulings first. For "what
//     is the current thinking" that is the wrong end of the collection, so
//     newest-first is the default here.
//
//   * Document URLs come back relative ("/docs/hq/2002/w964711.doc").
//
// Server-side date filtering does not exist on this API: a startDate parameter
// is accepted and ignored. Date filters are therefore applied after fetching,
// and rows filtered out are never charged for.
//
// Free tier: first 3 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';
import {
    codeDigits, toHtsFormat, normalizeTerm,
    rulingDate, yearFromPath, precedent, cleanText, absoluteUrl, rulingPageUrl,
    COLLECTION_LABELS,
} from './cross.js';

const FREE_TIER_ROWS = 3;
const API = 'https://rulings.cbp.gov/api';
const PAGE_SIZE = 200;
const FETCH_TIMEOUT_MS = 60000;
const SPACING_MS = 300;
/* Cross-run memory for monitor mode. MUST be named: an unnamed key value store
 * is recreated per run, so cross-run dedupe would silently never fire. */
const SEEN_STORE = 'customs-ruling-seen';
const SEEN_KEY = 'seen-rulings';
const SEEN_CAP = 20000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    rulingNumbers = [],
    collection = 'ALL',
    sortBy = 'DATE_DESC',
    dateFrom,
    dateTo,
    onlyCurrentPrecedent = false,
    includeFullText = false,
    newOnly = false,
    maxRows = 100,
} = input;

const terms = (Array.isArray(searchTerms) ? searchTerms : [searchTerms])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean);
const numbers = (Array.isArray(rulingNumbers) ? rulingNumbers : [rulingNumbers])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
const wantCollection = ['ALL', 'ny', 'hq'].includes(collection) ? collection : 'ALL';
/* DATE_ASC is accepted by the API but sorts the missing-date rulings to the
 * front, so it is not offered. */
const wantSort = ['DATE_DESC', 'RELEVANCE'].includes(sortBy) ? sortBy : 'DATE_DESC';
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

if (!terms.length && !numbers.length) {
    log.warning('Nothing to look up: provide searchTerms, rulingNumbers, or both.');
} else {
    log.info(
        `CROSS lookup | ${terms.length} search term(s), ${numbers.length} ruling number(s)`
        + ` | collection=${wantCollection} | sort=${wantSort}`
        + `${from || to ? ` | ${from ?? 'any'} to ${to ?? 'any'}` : ''}`
        + `${onlyCurrentPrecedent ? ' | current precedent only' : ''}`
        + `${includeFullText ? ' | with full text' : ''}`
        + `${newOnly ? ` | monitor mode, ${seenAcrossRuns.size} remembered` : ''}`,
    );
    await runNumbers();
    await runSearches();
}

if (newOnly) {
    /* Deduped before the cap is applied. seenThisRun also holds rulings that
     * were skipped because they were already known, so a plain concatenation
     * re-adds them every run and the cap then evicts genuinely distinct keys to
     * make room for copies. */
    const merged = [...new Set([...seenAcrossRuns, ...seenThisRun])].slice(-SEEN_CAP);
    await store.setValue(SEEN_KEY, merged);
    log.info(`Monitor mode: remembering ${merged.length} rulings for the next run.`);
}

log.info(`Done. Pushed ${pushed} rulings.`);
await Actor.exit();

// ---------- flows ----------

async function runNumbers() {
    for (const number of numbers) {
        if (done()) break;
        const detail = await getJson(`${API}/ruling/${encodeURIComponent(number)}`);
        if (!detail) {
            log.warning(`Ruling ${number} not found.`);
            continue;
        }
        await pushRuling(detail, { searchTerm: null, detail });
        await sleep(SPACING_MS);
    }
}

async function runSearches() {
    for (const term of terms) {
        if (done()) break;
        const query = normalizeTerm(term);
        if (query !== term) {
            log.info(`Reformatted "${term}" to "${query}" for CROSS, which matches codes literally.`);
        }

        for (let page = 1; !done(); page += 1) {
            const url = `${API}/search?term=${encodeURIComponent(query)}`
                + `&pageSize=${PAGE_SIZE}&page=${page}&collection=${wantCollection}`
                + `&sortBy=${wantSort}`;
            const json = await getJson(url);
            const rows = json?.rulings ?? [];
            if (page === 1) {
                log.info(`"${query}" matched ${json?.totalHits ?? 0} rulings.`);
            }
            const monitoringNewestFirst = newOnly && wantSort === 'DATE_DESC';
            let caughtUp = false;
            for (const r of rows) {
                if (done()) break;
                const result = await pushRuling(r, { searchTerm: term, queryUsed: query });
                if (result === 'alreadySeen') {
                    caughtUp = true;
                    /* Stop at the row, not just at the page boundary. Carrying
                     * on through the rest of the page would emit the rulings
                     * immediately older than the watermark, which is exactly
                     * the history this is meant to stop re-walking. */
                    if (monitoringNewestFirst) break;
                }
            }
            /* Newest-first monitoring stops at the first ruling it already
             * knows: everything past that point is older, so paging on would
             * walk backwards through decades of history and bill for rulings
             * the caller has implicitly already passed over. The trade-off is
             * that a ruling backfilled with an older date after a previous run
             * will be missed; relevance sort does not apply this and sweeps the
             * whole result set. */
            if (caughtUp && monitoringNewestFirst) {
                log.info(`Caught up with "${query}"; stopping at the first ruling already seen.`);
                break;
            }
            const total = asNum(json?.totalHits) ?? 0;
            if (rows.length === 0 || page * PAGE_SIZE >= total) break;
            await sleep(SPACING_MS);
        }
    }
}

// ---------- shaping ----------

async function pushRuling(r, ctx) {
    const number = String(r?.rulingNumber ?? '').trim();
    if (!number) return 'skipped';

    if (seenThisRun.has(number)) return 'duplicate';
    seenThisRun.add(number);
    /* Reported back to the caller so newest-first monitoring can tell "nothing
     * new here" apart from "filtered out", and stop paging. */
    if (newOnly && seenAcrossRuns.has(number)) return 'alreadySeen';

    const prec = precedent(r);
    /* Filters run before the charge, so a caller narrowing to current precedent
     * or a date window is not billed for the rows they excluded. */
    if (onlyCurrentPrecedent && prec.isSuperseded) return 'filtered';

    const date = rulingDate(r?.rulingDate);
    if ((from || to) && !inWindow(date, from, to)) return 'filtered';

    /* One extra request per ruling, so it is only made for rows that survived
     * every filter above. */
    let detail = ctx.detail ?? null;
    if (includeFullText && !detail) {
        detail = await getJson(`${API}/ruling/${encodeURIComponent(number)}`);
        await sleep(SPACING_MS);
    }

    const docPath = detail?.url ?? r?.url ?? null;
    /* A lookup by ruling number goes straight to the detail endpoint, which
     * only ever returns the full body, so those rows carry text regardless of
     * the flag and are charged at the full-text rate. */
    const text = (includeFullText || ctx.detail) ? cleanText(detail?.text) : null;
    const tariffs = Array.isArray(r?.tariffs) ? r.tariffs.filter(Boolean) : [];

    const row = {
        rulingNumber: number,
        subject: r?.subject ?? null,
        categories: r?.categories ?? null,

        rulingDate: date,
        /* Distinguishes "CBP did not record a date" from "no ruling here". */
        rulingDateMissing: date === null,
        yearFromDocumentPath: yearFromPath(docPath),

        collection: r?.collection ?? null,
        collectionLabel: COLLECTION_LABELS[r?.collection] ?? null,

        /* Codes CBP assigned, in both notations. CROSS groups ten digits 4.2.4
         * and the tariff schedule groups them 4.2.2.2, so emitting only one
         * form breaks whichever system the caller joins against. */
        tariffs: tariffs.length ? tariffs : null,
        tariffsHtsFormat: tariffs.length ? tariffs.map((t) => toHtsFormat(t)) : null,
        tariffDigits: tariffs.length ? tariffs.map((t) => codeDigits(t)) : null,
        primaryTariff: tariffs.length ? tariffs[0] : null,

        ...prec,
        relatedRulings: Array.isArray(r?.relatedRulings) && r.relatedRulings.length
            ? r.relatedRulings : null,

        isUsmca: typeof r?.isUsmca === 'boolean' ? r.isUsmca : null,
        isNafta: typeof r?.isNafta === 'boolean' ? r.isNafta : null,
        commodityGrouping: r?.commodityGrouping ?? null,

        rulingUrl: rulingPageUrl(number),
        documentUrl: absoluteUrl(docPath),

        fullText: text,
        /* Null when the text was not requested, so it cannot be read as an
         * empty ruling. */
        fullTextChars: text === null ? null : text.length,

        matchedSearchTerm: ctx.searchTerm,
        queryUsed: ctx.queryUsed ?? null,
        source: 'US Customs and Border Protection, CROSS',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    pushed += 1;
    /* Full text costs an extra upstream request and returns the whole ruling,
     * so it is a different event rather than a surcharge on the same one. */
    const eventName = text !== null ? 'ruling_full_text' : 'ruling';
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 25 === 0) log.info(`Pushed ${pushed} rulings...`);
    return 'pushed';
}

// ---------- helpers ----------

/* A ruling with no recorded date cannot be placed in a window. It is excluded
 * rather than assumed to fall inside, so a date-filtered run does not quietly
 * return undated rows the caller cannot verify. */
function inWindow(date, lo, hi) {
    if (date === null) return false;
    if (lo && date < lo) return false;
    if (hi && date > hi) return false;
    return true;
}

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
                    'User-Agent': 'Scrapemint Customs Ruling actor (admin@scrapemint.com)',
                    Accept: 'application/json',
                },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (res.status === 404) return null;
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return JSON.parse(await res.text());
        } catch (err) {
            if (attempt === 3) {
                log.warning(`fetch failed for ${url}: ${err?.message}`);
                return null;
            }
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
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
