// Upcoming Insider Stock Sales: SEC Form 144 Notices
//
// What it does
// ------------
// Before a company insider sells restricted stock they must file a notice with
// the SEC saying how much they intend to sell and roughly when. This reads
// those notices. Our sec-form4-insider-tracker reports sales AFTER they
// execute; this is the same event seen beforehand.
//
//   notices   recent filings across the whole market, newest first
//   company   every planned sale for the tickers you name
//   insiders  grouped per person, with what they have already sold in the last
//             three months alongside what they are now filing to sell
//
// Two keyless SEC endpoints, both already proven by our Form 4 actor:
//   efts.sec.gov/LATEST/search-index?forms=144   discovery (issuer, ticker, date)
//   www.sec.gov/Archives/.../primary_doc.xml     the structured filing itself
//
// Why the filing is worth parsing rather than just counting
// ---------------------------------------------------------
// `securitiesToBeSold` says where the shares came from (restricted stock units,
// an option exercise, a gift), and `securitiesSoldInPast3Months` lists what the
// same person already sold. A routine sale of just-vested RSUs reads very
// differently from a discretionary sale by someone who has already sold three
// times this quarter, and both facts are in the same document.
//
// Source quirks handled
// ---------------------
//   - SEC requires a descriptive User-Agent containing an email or it 403s.
//   - Rate limit is 10 requests/sec and throttling returns EMPTY results rather
//     than an error, so requests are spaced and an empty discovery response is
//     reported as possible throttling rather than silently as "no filings".
//   - Full text search paginates via `from` in multiples of 100 within a 10,000
//     result window.
//   - Every tag carries an `own:` or `com:` namespace prefix, so tag matching
//     has to tolerate any prefix.
//   - Dates arrive as MM/DD/YYYY and are converted to ISO.
//
// Pay per event
// -------------
//   notice_row ($0.005) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const SEEN_MAX = 5000;
const FETCH_TIMEOUT_MS = 45000;
const EDGAR_SLEEP_MS = 130;
const PAGE_SIZE = 100;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'notices',
    tickers = [],
    daysBack = 7,
    minValueUsd = 0,
    maxFilings = 60,
    newOnly = false,
    userAgent = 'Scrapemint Research (admin@scrapemint.com)',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const num = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
// SEC writes dates as MM/DD/YYYY.
const isoDate = (v) => {
    const m = String(v ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : clean(v);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['notices', 'company', 'insiders'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'notices';
const tickerFilter = new Set(asList(tickers).map((t) => t.toUpperCase()));
const windowDays = Math.max(1, Math.min(365, Number(daysBack) || 7));
const valueFloor = Math.max(0, Number(minValueUsd) || 0);
const filingCap = Math.max(1, Math.min(500, Number(maxFilings) || 60));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

const ua = String(userAgent || '').trim() || 'Scrapemint Research (admin@scrapemint.com)';
if (!ua.includes('@')) {
    log.warning('SEC requires an email in the User-Agent. Yours has no @, which usually causes 403 responses.');
}
const HEADERS = { 'User-Agent': ua, Accept: 'application/json, text/xml, */*', 'Accept-Encoding': 'gzip, deflate' };

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 110)}`); return null; }
        return await res.text();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}
const fetchJson = async (url) => { const t = await fetchText(url); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };

// Every tag in these filings is namespaced (own:, com:), so allow any prefix.
const pickTag = (xml, tag) => {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
    return m ? clean(m[1].replace(/<[^>]+>/g, ' ')) : null;
};
const findBlocks = (xml, tag) => xml.match(new RegExp(`<(?:\\w+:)?${tag}[\\s>][\\s\\S]*?</(?:\\w+:)?${tag}>`, 'g')) || [];
const pickAll = (xml, tag) => findBlocks(xml, tag).map((b) => clean(b.replace(/<[^>]+>/g, ' '))).filter(Boolean);

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'notice_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const store = newOnly ? await Actor.openKeyValueStore('form144-seen') : null;
const SEEN_KEY = 'seen-accessions';
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

const fmt = (d) => d.toISOString().slice(0, 10);
const endDate = new Date();
const startDate = new Date(endDate.getTime() - windowDays * 86400000);

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Form 144 ${theMode} | ${fmt(startDate)} to ${fmt(endDate)}`
    + (tickerFilter.size ? ` | ${[...tickerFilter].join(', ')}` : '')
    + `${newOnly ? ' | NEW only' : ''} | up to ${filingCap} filings | cap ${cap} rows`);

// ---- discovery -------------------------------------------------------------
const hits = [];
for (let from = 0; from < 10000 && hits.length < filingCap; from += PAGE_SIZE) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=144&startdt=${fmt(startDate)}&enddt=${fmt(endDate)}`
        + (from ? `&from=${from}` : '');
    const j = await fetchJson(url);
    const page = j?.hits?.hits || [];
    if (!page.length) {
        if (from === 0) {
            // EDGAR answers a throttled request with an empty result set rather
            // than an error, so an empty first page is ambiguous by design.
            log.warning('No Form 144 filings returned. If this is unexpected, EDGAR may be throttling; retry in a minute.');
        }
        break;
    }
    hits.push(...page);
    await sleep(EDGAR_SLEEP_MS);
    if (page.length < PAGE_SIZE) break;
}
log.info(`Discovery: ${hits.length} Form 144 filing(s) in the window.`);

// "Natera, Inc.  (NTRA)  (CIK 0001604821)" -> NTRA
const tickerOf = (displayNames = []) => {
    for (const n of displayNames) {
        const m = String(n).match(/\(([A-Z][A-Z0-9.\-]{0,6})\)\s*\(CIK/);
        if (m) return m[1];
    }
    return null;
};

const filings = [];
for (const h of hits) {
    const [accession, filename] = String(h._id || '').split(':');
    if (!accession || !filename) continue;
    const src = h._source || {};
    const ticker = tickerOf(src.display_names);
    if (tickerFilter.size && (!ticker || !tickerFilter.has(ticker))) continue;
    if (newOnly && seen.has(accession)) { skippedSeen += 1; continue; }
    filings.push({
        accession,
        filename,
        cik: (src.ciks || [])[0],
        ticker,
        filedDate: src.file_date || null,
        displayNames: src.display_names || [],
    });
    if (filings.length >= filingCap) break;
}

if (!filings.length) {
    await flushRow({
        type: 'note', found: false,
        note: newOnly
            ? 'no Form 144 filings since the last run in this window; not charged'
            : tickerFilter.size
                ? 'no Form 144 filings for those tickers in this window; widen daysBack; not charged'
                : 'no Form 144 filings matched; not charged',
    }, false);
}

// ---- detail ----------------------------------------------------------------
function parseFiling(xml) {
    const info = pickTag(xml, 'securitiesInformation') != null ? xml : xml;
    const relationships = pickAll(xml, 'relationshipToIssuer');
    const shares = num(pickTag(xml, 'noOfUnitsSold'));
    const value = num(pickTag(xml, 'aggregateMarketValue'));
    const outstanding = num(pickTag(xml, 'noOfUnitsOutstanding'));

    // Where the shares came from: RSU vesting reads very differently from a
    // discretionary sale, and it is structured rather than only in remarks.
    const toBeSold = findBlocks(xml, 'securitiesToBeSold')[0] || '';
    // Everything this person already sold in the last three months.
    const past = findBlocks(xml, 'securitiesSoldInPast3Months').map((b) => ({
        saleDate: isoDate(pickTag(b, 'saleDate')),
        shares: num(pickTag(b, 'amountOfSecuritiesSold')),
        grossProceedsUsd: num(pickTag(b, 'grossProceeds')),
    })).filter((p) => p.shares != null || p.grossProceedsUsd != null);
    const pastShares = past.reduce((t, p) => t + (p.shares ?? 0), 0);
    const pastProceeds = past.reduce((t, p) => t + (p.grossProceedsUsd ?? 0), 0);

    return {
        issuerName: pickTag(xml, 'issuerName'),
        issuerCik: pickTag(xml, 'issuerCik'),
        insiderName: pickTag(xml, 'nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold'),
        relationships,
        relationshipSummary: relationships.length ? relationships.join(', ') : null,
        securitiesClass: pickTag(info, 'securitiesClassTitle'),
        broker: pickTag(findBlocks(xml, 'brokerOrMarketmakerDetails')[0] || '', 'name'),
        sharesToBeSold: shares,
        aggregateMarketValueUsd: value,
        sharesOutstanding: outstanding,
        percentOfSharesOutstanding: shares != null && outstanding ? round((shares / outstanding) * 100, 5) : null,
        approxSaleDate: isoDate(pickTag(xml, 'approxSaleDate')),
        exchange: pickTag(xml, 'securitiesExchangeName'),
        acquisitionNature: pickTag(toBeSold, 'natureOfAcquisitionTransaction'),
        acquiredDate: isoDate(pickTag(toBeSold, 'acquiredDate')),
        acquiredFrom: pickTag(toBeSold, 'nameOfPersonfromWhomAcquired'),
        isGift: (pickTag(toBeSold, 'isGiftTransaction') || '').toUpperCase() === 'Y',
        soldPast3MonthsCount: past.length,
        soldPast3MonthsShares: past.length ? pastShares : null,
        soldPast3MonthsProceedsUsd: past.length ? round(pastProceeds, 2) : null,
        recentSales: past,
        remarks: pickTag(xml, 'remarks'),
        noticeDate: isoDate(pickTag(xml, 'noticeDate')),
    };
}

const parsed = [];
for (const f of filings) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const noDash = f.accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${noDash}/${f.filename}`;
    const xml = await fetchText(url);
    await sleep(EDGAR_SLEEP_MS);
    if (!xml) continue;
    const d = parseFiling(xml);
    if (valueFloor && (d.aggregateMarketValueUsd ?? 0) < valueFloor) continue;
    parsed.push({
        ...f,
        ...d,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${f.cik}/${noDash}/${f.filename}`,
        // What this person is selling now plus what they already sold recently.
        totalRecentAndPlannedUsd: round((d.aggregateMarketValueUsd ?? 0) + (d.soldPast3MonthsProceedsUsd ?? 0), 2),
    });
    if (newOnly) seen.add(f.accession);
}

parsed.sort((a, b) => String(b.filedDate).localeCompare(String(a.filedDate))
    || (b.aggregateMarketValueUsd ?? 0) - (a.aggregateMarketValueUsd ?? 0));

if (theMode === 'insiders') {
    // One row per person per issuer, aggregated across their filings.
    const groups = new Map();
    for (const p of parsed) {
        const key = `${p.insiderName || 'unknown'}|${p.issuerCik || p.issuerName}`;
        if (!groups.has(key)) {
            groups.set(key, {
                insiderName: p.insiderName, issuerName: p.issuerName, issuerCik: p.issuerCik,
                ticker: p.ticker, relationshipSummary: p.relationshipSummary,
                filings: 0, plannedShares: 0, plannedValueUsd: 0,
                pastProceedsUsd: p.soldPast3MonthsProceedsUsd ?? 0,
                pastSales: p.soldPast3MonthsCount ?? 0,
                latestFiledDate: p.filedDate, earliestFiledDate: p.filedDate,
                natures: new Set(), urls: [],
            });
        }
        const g = groups.get(key);
        g.filings += 1;
        g.plannedShares += p.sharesToBeSold ?? 0;
        g.plannedValueUsd += p.aggregateMarketValueUsd ?? 0;
        // The three month history repeats on every filing by the same person,
        // so take the largest rather than summing it into a fiction.
        g.pastProceedsUsd = Math.max(g.pastProceedsUsd, p.soldPast3MonthsProceedsUsd ?? 0);
        g.pastSales = Math.max(g.pastSales, p.soldPast3MonthsCount ?? 0);
        if (p.acquisitionNature) g.natures.add(p.acquisitionNature);
        if (String(p.filedDate) > String(g.latestFiledDate)) g.latestFiledDate = p.filedDate;
        if (String(p.filedDate) < String(g.earliestFiledDate)) g.earliestFiledDate = p.filedDate;
        if (g.urls.length < 5) g.urls.push(p.filingUrl);
    }
    const rows = [...groups.values()].sort((a, b) => b.plannedValueUsd - a.plannedValueUsd);
    for (const g of rows) {
        if (stopEarly()) break;
        await flushRow({
            mode: 'insiders',
            insiderName: g.insiderName,
            ticker: g.ticker,
            issuerName: g.issuerName,
            issuerCik: g.issuerCik,
            relationshipSummary: g.relationshipSummary,
            filingsInWindow: g.filings,
            plannedShares: g.plannedShares || null,
            plannedValueUsd: round(g.plannedValueUsd, 2) || null,
            soldPast3MonthsCount: g.pastSales || null,
            soldPast3MonthsProceedsUsd: g.pastProceedsUsd || null,
            totalRecentAndPlannedUsd: round(g.plannedValueUsd + g.pastProceedsUsd, 2) || null,
            acquisitionNatures: [...g.natures],
            earliestFiledDate: g.earliestFiledDate,
            latestFiledDate: g.latestFiledDate,
            filingUrls: g.urls,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
} else {
    for (const p of parsed) {
        if (stopEarly()) break;
        await flushRow({
            mode: theMode,
            ticker: p.ticker,
            issuerName: p.issuerName,
            issuerCik: p.issuerCik,
            insiderName: p.insiderName,
            relationships: p.relationships,
            relationshipSummary: p.relationshipSummary,
            sharesToBeSold: p.sharesToBeSold,
            aggregateMarketValueUsd: p.aggregateMarketValueUsd,
            percentOfSharesOutstanding: p.percentOfSharesOutstanding,
            sharesOutstanding: p.sharesOutstanding,
            approxSaleDate: p.approxSaleDate,
            securitiesClass: p.securitiesClass,
            exchange: p.exchange,
            broker: p.broker,
            acquisitionNature: p.acquisitionNature,
            acquiredDate: p.acquiredDate,
            acquiredFrom: p.acquiredFrom,
            isGift: p.isGift,
            soldPast3MonthsCount: p.soldPast3MonthsCount,
            soldPast3MonthsShares: p.soldPast3MonthsShares,
            soldPast3MonthsProceedsUsd: p.soldPast3MonthsProceedsUsd,
            totalRecentAndPlannedUsd: p.totalRecentAndPlannedUsd,
            recentSales: p.recentSales,
            remarks: p.remarks,
            filedDate: p.filedDate,
            noticeDate: p.noticeDate,
            accessionNumber: p.accession,
            filingUrl: p.filingUrl,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
}

if (!emitted && filings.length) {
    await flushRow({
        type: 'note', found: false,
        note: valueFloor
            ? `no Form 144 filings cleared $${valueFloor}; not charged`
            : 'filings were found but none could be parsed; not charged',
    }, false);
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} accession(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
