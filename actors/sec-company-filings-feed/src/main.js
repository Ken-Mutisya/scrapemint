// SEC Company Filings Feed: Every Filing by Ticker
//
// Strategy
// --------
// Official SEC EDGAR submissions API (data.sec.gov/submissions/CIK##########.json),
// keyless JSON, one GET per company. The response holds the ~1000 most
// recent filings inline under filings.recent (column arrays that align by
// index); older filings live in paged files under filings.files[] and are
// fetched only when the form/date filter and row cap still want more.
// Tickers and company names resolve through www.sec.gov/files/company_tickers.json
// (fetched once, cached). EDGAR requires a descriptive User-Agent with
// contact info and rate-limits ~10 req/s, so requests are spaced.
//
// Distinct from our other SEC actors: this is the per-company filing INDEX
// for ANY form type (8-K-tracker, form4-tracker, full-text-search and the
// XBRL financials actor each cover a narrower slice).
//
// Monitor mode (newOnly) keeps returned accession numbers in a named
// key-value store and emits only unseen filings — a scheduled new-filing
// feed where quiet runs charge nothing.
//
// Pay per event
// -------------
//   filing_row per filing. Unknown tickers/CIKs and companies with no
//   matching filings are free note rows. First 2 chargeable rows free.

import { Actor, log } from 'apify';

const SUBMISSIONS = 'https://data.sec.gov/submissions';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const UA = 'Scrapemint SEC Company Filings actor (admin@scrapemint.com)';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 30000;
const SPACING_MS = 150;
const SEEN_KEY = 'seen-accession-numbers';
const SEEN_MAX = 200000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [], formTypes = [], sinceDays = 365,
    maxPerCompany = 40, newOnly = false, maxRows = 2000,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const clampNum = (v, def, min, max) => Math.max(min, Math.min(max, Number(v) || def));

const companyList = [...new Set(asTokens(companies))];
const formList = [...new Set(asTokens(formTypes).map((f) => f.toUpperCase()))];
const perCompany = clampNum(maxPerCompany, 40, 1, 5000);
const rowCap = clampNum(maxRows, 2000, 1, HARD_CAP);
const days = clampNum(sinceDays, 365, 0, 36500);
const sinceMs = days > 0 ? Date.now() - days * 86400000 : 0;

if (companyList.length === 0) {
    log.warning('No companies given. Add a ticker like "AAPL", a CIK like "320193" or a company name.');
    await Actor.exit();
}

async function apiGet(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (res.status === 404) return { notFound: true };
            const json = await res.json().catch(() => null);
            if (!res.ok || !json) return { error: `HTTP ${res.status}` };
            await sleep(SPACING_MS);
            return json;
        } catch (err) {
            if (attempt === 3) return { error: err?.message };
            await sleep(attempt * 4000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'unreachable' };
}

let rowsPushed = 0;
let chargeableRows = 0;
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
const shouldStop = () => rowsPushed >= rowCap || pastDeadline();

// --- ticker / name resolution ------------------------------------------------

let tickerMap = null; // built lazily: { TICKER -> {cik, name}, names: [{cik,name,ticker}] }
async function loadTickers() {
    if (tickerMap) return tickerMap;
    const json = await apiGet(TICKERS_URL);
    tickerMap = { byTicker: new Map(), rows: [] };
    if (!json || json.error || json.notFound) {
        log.warning('Could not load the ticker map; ticker and name lookups may fail (CIK numbers still work).');
        return tickerMap;
    }
    for (const v of Object.values(json)) {
        const rec = { cik: String(v.cik_str), name: v.title, ticker: v.ticker };
        tickerMap.byTicker.set(String(v.ticker).toUpperCase(), rec);
        tickerMap.rows.push(rec);
    }
    return tickerMap;
}

async function resolveCompany(raw) {
    const s = raw.trim();
    if (/^\d{1,10}$/.test(s)) return { cik: s.padStart(10, '0'), label: `CIK ${s}` };
    const map = await loadTickers();
    const byT = map.byTicker.get(s.toUpperCase());
    if (byT) return { cik: byT.cik.padStart(10, '0'), label: `${byT.ticker} (${byT.name})` };
    const needle = s.toLowerCase();
    const exact = map.rows.find((r) => r.name.toLowerCase() === needle);
    const partial = exact || map.rows.find((r) => r.name.toLowerCase().includes(needle));
    if (partial) return { cik: partial.cik.padStart(10, '0'), label: `${partial.ticker} (${partial.name})` };
    return null;
}

// --- filing extraction -------------------------------------------------------

const matchesForm = (form) => formList.length === 0 || formList.some((f) => String(form || '').toUpperCase().startsWith(f));
const accnDashless = (a) => String(a || '').replace(/-/g, '');

function buildFilings(recent, meta) {
    const n = (recent.accessionNumber || []).length;
    const out = [];
    for (let i = 0; i < n; i += 1) {
        const accession = recent.accessionNumber[i];
        const form = recent.form[i];
        const filingDate = recent.filingDate[i];
        if (!matchesForm(form)) continue;
        if (sinceMs && filingDate && Date.parse(filingDate) < sinceMs) continue;
        const noDash = accnDashless(accession);
        const primary = recent.primaryDocument?.[i] || '';
        out.push({
            filing_meta: meta,
            accession,
            form,
            formDescription: recent.primaryDocDescription?.[i] || null,
            filingDate: filingDate || null,
            reportDate: recent.reportDate?.[i] || null,
            acceptanceDateTime: recent.acceptanceDateTime?.[i] || null,
            act: recent.act?.[i] || null,
            fileNumber: recent.fileNumber?.[i] || null,
            items: recent.items?.[i] ? String(recent.items[i]).split(',').map((x) => x.trim()).filter(Boolean) : [],
            sizeBytes: recent.size?.[i] ?? null,
            isXBRL: recent.isXBRL?.[i] === 1,
            documentUrl: primary ? `https://www.sec.gov/Archives/edgar/data/${meta.cikNum}/${noDash}/${primary}` : null,
            filingIndexUrl: `https://www.sec.gov/Archives/edgar/data/${meta.cikNum}/${noDash}/${accession}-index.htm`,
        });
    }
    return out;
}

// --- monitor state -----------------------------------------------------------

const store = newOnly ? await Actor.openKeyValueStore('sec-filings-seen') : null;
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

// --- per company -------------------------------------------------------------

log.info(`Fetching filings for ${companyList.length} compan(ies), forms ${formList.join('/') || 'all'}, `
    + `${days ? `last ${days} days` : 'all history'}${newOnly ? ', NEW filings only' : ''}...`);

for (const raw of companyList) {
    if (shouldStop()) break;
    const resolved = await resolveCompany(raw);
    if (!resolved) {
        await flushRow({ type: 'note', input: raw, found: false, note: 'could not resolve to a company (unknown ticker/name; try the exact ticker or CIK number); not charged' }, false);
        continue;
    }
    const json = await apiGet(`${SUBMISSIONS}/CIK${resolved.cik}.json`);
    if (json?.notFound || json?.error) {
        await flushRow({ type: 'note', input: raw, found: false, note: json?.notFound ? `no EDGAR record for ${resolved.label}; not charged` : `fetch failed (${json.error}); not charged, try again later` }, false);
        continue;
    }
    // EDGAR archive paths use the UNPADDED CIK; the padded form 301-redirects.
    const cikNum = String(Number(json.cik ?? resolved.cik));
    const meta = {
        company: json.name || null,
        cik: resolved.cik,
        cikNum,
        ticker: (json.tickers || [])[0] || null,
        tickers: json.tickers || [],
        exchange: (json.exchanges || [])[0] || null,
        sic: json.sicDescription || null,
        fiscalYearEnd: json.fiscalYearEnd || null,
    };

    let collected = buildFilings(json.filings?.recent || {}, meta);

    // Page into older filings only if the caller wants more than the recent
    // window yielded and a date window has not already been satisfied.
    const older = json.filings?.files || [];
    for (const f of older) {
        if (collected.length >= perCompany) break;
        if (sinceMs && f.filingTo && Date.parse(f.filingTo) < sinceMs) continue; // whole page too old
        if (pastDeadline()) break;
        const page = await apiGet(`${SUBMISSIONS}/${f.name}`);
        if (page?.error || page?.notFound) continue;
        collected = collected.concat(buildFilings(page, meta));
    }

    // recent is already newest-first; older pages append older filings after.
    let emitted = 0;
    let anyKept = false;
    for (const filing of collected) {
        if (emitted >= perCompany || shouldStop()) break;
        anyKept = true;
        if (newOnly && seen.has(filing.accession)) { skippedSeen += 1; continue; }
        if (newOnly) seen.add(filing.accession);
        const { filing_meta, ...rest } = filing;
        await flushRow({ type: 'filing', ...filing_meta, ...rest, sourceInput: raw }, true);
        emitted += 1;
    }
    if (!anyKept) {
        await flushRow({ type: 'note', input: raw, found: false, note: `no filings for ${resolved.label} matched these form/date filters; not charged` }, false);
    } else if (emitted === 0 && newOnly) {
        log.info(`${resolved.label}: all matching filings already seen.`);
    }
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} accession number(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; notes free)`
    + `${pastDeadline() ? ' — stopped near timeout' : ''}.`);
await Actor.exit();
