// Lobbying Disclosure Scraper (US Senate)
//
// Strategy
// --------
// Official US Senate Lobbying Disclosure Act REST API
// (lda.senate.gov/api/v1/filings/), keyless JSON. Filters are combined
// into one query: client_name / registrant_name / lobbyist_name are
// partial case-insensitive matches, filing_specific_lobbying_issues is
// full-text across what the filing says it lobbied on, filing_year pins
// a year. Always ordered -dt_posted (newest first).
//
// Source quirks handled:
//   * Anonymous page size is capped at 25 no matter what you ask for -
//     pagination just walks pages of 25.
//   * general_issue_code is NOT a supported filter (silently ignored,
//     returns everything) - free-text issue search is used instead.
//   * Anonymous rate limit is low; requests are spaced ~4.2s apart, and
//     an optional buyer API key ("Authorization: Token ...") drops the
//     spacing for large pulls.
//
// Pay per event
// -------------
//   filing_row per filing. Empty searches are free note rows. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const API = 'https://lda.senate.gov/api/v1/filings/';
const FILING_URL = 'https://lda.senate.gov/filings/public/filing/';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 10000;
const FETCH_TIMEOUT_MS = 60000;
const ANON_SPACING_MS = 4200;
const KEYED_SPACING_MS = 600;
const RATE_BACKOFF_MS = 65000;
const PAGE_SIZE = 25;
const DETAILS_CAP = 1500;
const LOBBYISTS_CAP = 20;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    clientName = '', registrantName = '', lobbyistName = '', issueText = '',
    filingYear = 2026, newOnly = false, maxRows = 100, apiKey = '',
} = input;

const clean = (v) => String(v || '').trim();
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const client = clean(clientName);
const registrant = clean(registrantName);
const lobbyist = clean(lobbyistName);
const issue = clean(issueText);
const year = clampNum(filingYear, 0, 0, 2100);
const rowCap = clampNum(maxRows, 100, 1, HARD_CAP);
const key = clean(apiKey);
const spacing = key ? KEYED_SPACING_MS : ANON_SPACING_MS;

if (!client && !registrant && !lobbyist && !issue && year === 0) {
    log.warning('Nothing to search. Add a client, firm, lobbyist, issue text, or a filing year.');
    await Actor.exit();
}

let rateLimited = false;
async function apiGet(page) {
    const usp = new URLSearchParams({ ordering: '-dt_posted', page_size: String(PAGE_SIZE), page: String(page) });
    if (client) usp.set('client_name', client);
    if (registrant) usp.set('registrant_name', registrant);
    if (lobbyist) usp.set('lobbyist_name', lobbyist);
    if (issue) usp.set('filing_specific_lobbying_issues', issue);
    if (year > 0) usp.set('filing_year', String(year));
    const headers = { accept: 'application/json', 'User-Agent': 'Scrapemint Lobbying Disclosure actor (admin@scrapemint.com)' };
    if (key) headers.Authorization = `Token ${key}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(`${API}?${usp}`, { signal: controller.signal, headers });
            if (res.status === 429) {
                if (attempt === 3) { rateLimited = true; return { error: 'HTTP 429 (rate limited)' }; }
                log.info(`Rate limited, backing off ${RATE_BACKOFF_MS / 1000}s...`);
                await sleep(RATE_BACKOFF_MS);
                continue;
            }
            if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (res.status === 401 || res.status === 403) return { error: `HTTP ${res.status} (check the API key)` };
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const json = await res.json();
            await sleep(spacing);
            return { json };
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 5000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

const money = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

function toRow(f) {
    const activities = f.lobbying_activities || [];
    const issues = [...new Set(activities.map((a) => a.general_issue_code_display).filter(Boolean))];
    const details = activities.map((a) => clean(a.description)).filter(Boolean).join(' | ').slice(0, DETAILS_CAP) || null;
    const lobbyists = [];
    for (const a of activities) {
        for (const l of a.lobbyists || []) {
            const name = [l.lobbyist?.first_name, l.lobbyist?.last_name].filter(Boolean).join(' ').trim();
            if (!name) continue;
            const covered = clean(l.covered_position) && !/^n\/?a$/i.test(clean(l.covered_position)) ? ` (${clean(l.covered_position).slice(0, 120)})` : '';
            lobbyists.push(`${name}${covered}`);
        }
    }
    const uniqLobbyists = [...new Set(lobbyists)].slice(0, LOBBYISTS_CAP);
    const income = money(f.income);
    const expenses = money(f.expenses);
    return {
        filingId: f.filing_uuid || null,
        filingYear: f.filing_year || null,
        period: f.filing_period_display || null,
        type: f.filing_type_display || null,
        postedAt: f.dt_posted || null,
        clientName: f.client?.name || null,
        clientState: f.client?.state_display || f.client?.state || null,
        clientDescription: clean(f.client?.general_description).slice(0, 300) || null,
        registrantName: f.registrant?.name || null,
        registrantDescription: clean(f.registrant?.description).slice(0, 300) || null,
        incomeUsd: income,
        expensesUsd: expenses,
        amountUsd: income ?? expenses,
        issues,
        issueDetails: details,
        lobbyists: uniqLobbyists,
        activityCount: activities.length,
        documentUrl: f.filing_document_url || null,
        filingUrl: f.filing_uuid ? `${FILING_URL}${f.filing_uuid}/print/` : null,
    };
}

let rowsPushed = 0;
let chargeableRows = 0;
// The API pages with `ordering=-dt_posted`, and dt_posted is not unique: a
// quarter's filings are posted in bulk and share a timestamp. With a tie on the
// sort key the server is free to order those rows differently on each request,
// so the same filing can land on two consecutive pages. That shipped as byte
// identical duplicate rows that were pushed AND charged (36% of a 25 row run on
// 2026-08-09), and it also let maxRows fill with copies instead of filings.
// Keyed on filing_uuid, which is unique per filing and always present.
const emittedIds = new Set();
let duplicatesSkipped = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'filing_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}
const shouldStop = () => rowsPushed >= rowCap || pastDeadline() || rateLimited;

const store = newOnly ? await Actor.openKeyValueStore('lda-filings-seen') : null;
const SEEN_KEY = 'seen-filing-ids';
const SEEN_MAX = 300000;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- run ---------------------------------------------------------------------------

const label = [client && `client "${client}"`, registrant && `firm "${registrant}"`, lobbyist && `lobbyist "${lobbyist}"`, issue && `issue "${issue}"`, year > 0 && `year ${year}`]
    .filter(Boolean).join(', ');
log.info(`Searching filings: ${label}${newOnly ? ', NEW filings only' : ''}${key ? ' (with API key)' : ''}...`);

let total = null;
let emitted = 0;
let allSeenPages = 0;
for (let page = 1; !shouldStop(); page += 1) {
    const { json, error } = await apiGet(page);
    if (error) {
        if (emitted === 0) await flushRow({ type: 'note', input: label, found: false, note: `search failed (${error}); not charged, try again later` }, false);
        break;
    }
    if (total === null) {
        total = json?.count ?? 0;
        if (total > 0) log.info(`${total} filing(s) match.`);
    }
    const results = json?.results || [];
    if (results.length === 0) break;
    let newInPage = 0;
    for (const f of results) {
        if (shouldStop()) break;
        const id = f.filing_uuid;
        if (id && emittedIds.has(id)) { duplicatesSkipped += 1; continue; }
        if (newOnly && id && seen.has(id)) { skippedSeen += 1; continue; }
        if (newOnly && id) seen.add(id);
        if (id) emittedIds.add(id);
        await flushRow(toRow(f), true);
        emitted += 1;
        newInPage += 1;
    }
    // Newest-first ordering: in monitor mode, several consecutive fully-seen
    // pages mean everything older is seen too - stop instead of walking the
    // whole result set every scheduled run.
    if (newOnly) {
        allSeenPages = newInPage === 0 ? allSeenPages + 1 : 0;
        if (allSeenPages >= 3) break;
    }
    if (!json.next) break;
}
if (emitted === 0 && total === 0) {
    await flushRow({ type: 'note', input: label, found: false, note: 'no filings matched; names are partial matches, so try a shorter form; not charged' }, false);
} else if (emitted === 0 && total > 0 && newOnly && !rateLimited) {
    await flushRow({ type: 'note', input: label, found: false, note: 'no new filings since the last run; not charged' }, false);
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} filing id(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${duplicatesSkipped ? ` — ${duplicatesSkipped} duplicate filing(s) from the API skipped, not charged` : ''}`
    + `${rateLimited ? ' — stopped early on API rate limit' : ''}${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
