// ETF & Mutual Fund Holdings: Every Stock a Fund Owns
//
// What it does
// ------------
// Give it a fund ticker like VOO and it returns what that fund actually holds:
// every position, the share count, the dollar value and the percent of the
// portfolio. Registered funds report their FULL portfolio on SEC form NPORT-P,
// which is a different filing from the 13F our whale tracker reads: 13F is for
// institutional managers and covers US equities, NPORT-P is for mutual funds
// and ETFs and covers everything they own, bonds and cash included.
//
//   top       the largest positions by percent of portfolio (default, and the
//             row-efficient one: VTI alone reports 3,524 holdings)
//   holdings  the entire portfolio
//   summary   one row per fund: net assets, holding count, asset mix, long vs
//             short, largest position, and the period the report covers
//
// Reporting lag
// -------------
// This is quarterly data published roughly 60 days in arrears, the same nature
// as 13F. A filing opened on 2026-07-27 reported positions as of 2026-05-31.
// Every row carries reportPeriod and filedDate so the age is never ambiguous.
//
// Resolution chain, all keyless
// -----------------------------
//   sec.gov/files/company_tickers_mf.json   ticker -> cik + seriesId (28k rows)
//   data.sec.gov/submissions/CIK{cik}.json  that registrant's NPORT-P filings
//   Archives/.../primary_doc.xml            the filing itself
//
// Two traps this is built around
// ------------------------------
//   - The submissions API's `primaryDocument` points at an XSL RENDERED HTML
//     copy under xslFormNPORT-P_X01/, which is 9.76 MB with no parseable tags.
//     The raw XML is the same filename WITHOUT that directory prefix and is
//     500 KB. Always strip to the basename.
//   - One registrant CIK files SEVERAL NPORT-P filings on the same day, one
//     per fund series, and the submissions API does not say which is which.
//     Vanguard filed three at once. Candidates are fetched newest first and
//     matched on the seriesId that the ticker map supplied.
//
// Pay per event
// -------------
//   holding_row ($0.004) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 90000;
const EDGAR_SLEEP_MS = 130;
const MAX_CANDIDATES = 10;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'top',
    tickers = ['VOO', 'ARKK'],
    topN = 25,
    minPercent = 0,
    assetCategory = 'all',
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['top', 'holdings', 'summary'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'top';
const wanted = [...new Set(asList(tickers).map((t) => t.toUpperCase()))].slice(0, 25);
const perFund = Math.max(1, Math.min(2000, Number(topN) || 25));
const pctFloor = Math.max(0, Number(minPercent) || 0);
const catFilter = String(assetCategory).toUpperCase();
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

const ua = String(userAgent || '').trim() || 'Scrapemint Research (admin@scrapemint.com)';
if (!ua.includes('@')) log.warning('SEC requires an email in the User-Agent. Yours has no @, which usually causes 403 responses.');
const HEADERS = { 'User-Agent': ua, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' };

if (!wanted.length) {
    log.warning('Provide at least one fund ticker, e.g. VOO, QQQ, ARKK.');
    await Actor.exit();
}

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

const pick = (xml, tag) => {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
    return m ? clean(m[1].replace(/<[^>]+>/g, ' ')) : null;
};
const pickAttr = (block, tag, attr) => {
    const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*\\b${attr}="([^"]*)"`));
    return m ? clean(m[1]) : null;
};

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'holding_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Fund holdings ${theMode} | ${wanted.join(', ')} | cap ${cap} rows`);

// ---- ticker -> cik + seriesId ---------------------------------------------
const mfMap = await fetchJson('https://www.sec.gov/files/company_tickers_mf.json');
const bySymbol = new Map();
for (const row of mfMap?.data || []) {
    const [cik, seriesId, classId, symbol] = row;
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(String(symbol).toUpperCase(), { cik, seriesId, classId });
}
log.info(`Ticker map: ${bySymbol.size} fund symbols.`);

// Asset categories as the SEC codes them, mapped to something readable.
const ASSET_CATS = {
    EC: 'equity-common', EP: 'equity-preferred', DBT: 'debt', ABS: 'asset-backed',
    STIV: 'short-term-investment', RE: 'real-estate', LON: 'loan', COMM: 'commodity',
    // Derivatives report a NEGATIVE percent of portfolio when written rather
    // than held, which is why an asset mix can contain a small minus figure.
    DE: 'derivative', DFE: 'derivative-equity', DIR: 'derivative-rate',
    DCR: 'derivative-credit', DFC: 'derivative-currency', DCO: 'derivative-commodity',
    SN: 'structured-note', UST: 'us-treasury', RA: 'repurchase-agreement',
};

function parseHoldings(xml) {
    const blocks = xml.match(/<invstOrSec>[\s\S]*?<\/invstOrSec>/g) || [];
    const out = [];
    for (const b of blocks) {
        const pct = num(pick(b, 'pctVal'));
        const cat = pick(b, 'assetCat');
        out.push({
            securityName: pick(b, 'name'),
            title: pick(b, 'title'),
            cusip: pick(b, 'cusip'),
            isin: pickAttr(b, 'isin', 'value'),
            lei: pick(b, 'lei'),
            shares: num(pick(b, 'balance')),
            units: pick(b, 'units'),
            currency: pick(b, 'curCd'),
            valueUsd: num(pick(b, 'valUSD')),
            percentOfPortfolio: pct == null ? null : round(pct, 6),
            position: pick(b, 'payoffProfile'),
            assetCategory: cat,
            assetCategoryLabel: cat ? (ASSET_CATS[cat] || cat.toLowerCase()) : null,
            issuerCategory: pick(b, 'issuerCat'),
            country: pick(b, 'invCountry'),
        });
    }
    return out;
}

for (const ticker of wanted) {
    if (stopEarly()) break;
    const ref = bySymbol.get(ticker);
    if (!ref) {
        log.warning(`${ticker}: not in the SEC fund ticker map`);
        await flushRow({ type: 'note', ticker, found: false, note: 'not a registered fund ticker in the SEC mutual fund map; not charged' }, false);
        continue;
    }

    const cikPadded = String(ref.cik).padStart(10, '0');
    const sub = await fetchJson(`https://data.sec.gov/submissions/CIK${cikPadded}.json`);
    await sleep(EDGAR_SLEEP_MS);
    const rec = sub?.filings?.recent;
    if (!rec) {
        await flushRow({ type: 'note', ticker, found: false, note: 'could not load this registrant\'s filing history; not charged' }, false);
        continue;
    }

    const candidates = [];
    for (let i = 0; i < (rec.form || []).length; i++) {
        if (!String(rec.form[i]).startsWith('NPORT-P')) continue;
        candidates.push({
            accession: rec.accessionNumber[i],
            filedDate: rec.filingDate[i],
            // primaryDocument points at the XSL-rendered HTML copy; the raw XML
            // is the same filename with the directory prefix stripped.
            doc: String(rec.primaryDocument[i] || 'primary_doc.xml').split('/').pop(),
        });
        if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (!candidates.length) {
        await flushRow({ type: 'note', ticker, found: false, note: 'no NPORT-P filings on record for this registrant; not charged' }, false);
        continue;
    }

    // A fund family files one NPORT-P per series on the same day, so walk the
    // candidates newest first until the seriesId matches this ticker's fund.
    let xml = null; let matched = null;
    for (const c of candidates) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const noDash = c.accession.replace(/-/g, '');
        const url = `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${noDash}/${c.doc}`;
        const text = await fetchText(url);
        await sleep(EDGAR_SLEEP_MS);
        if (!text) continue;
        const sid = pick(text, 'seriesId');
        if (sid && sid === ref.seriesId) { xml = text; matched = { ...c, url }; break; }
    }
    if (!xml) {
        log.warning(`${ticker}: no NPORT-P filing matched series ${ref.seriesId} in the last ${candidates.length} filings`);
        await flushRow({
            type: 'note', ticker, found: false,
            note: `no recent NPORT-P filing matched this fund's series (${ref.seriesId}); the registrant files one per series and this fund's may be older; not charged`,
        }, false);
        continue;
    }

    const fund = {
        ticker,
        fundName: pick(xml, 'seriesName'),
        seriesId: ref.seriesId,
        registrantName: pick(xml, 'regName'),
        registrantCik: String(ref.cik),
        reportPeriod: pick(xml, 'repPdDate'),
        filedDate: matched.filedDate,
        totalAssetsUsd: num(pick(xml, 'totAssets')),
        netAssetsUsd: num(pick(xml, 'netAssets')),
        filingUrl: matched.url,
    };

    let holdings = parseHoldings(xml);
    const totalHoldings = holdings.length;
    if (catFilter !== 'ALL') holdings = holdings.filter((h) => String(h.assetCategory || '').toUpperCase() === catFilter);
    if (pctFloor) holdings = holdings.filter((h) => (h.percentOfPortfolio ?? 0) >= pctFloor);
    holdings.sort((a, b) => (b.percentOfPortfolio ?? 0) - (a.percentOfPortfolio ?? 0));

    log.info(`${ticker}: ${fund.fundName} | ${totalHoldings} holdings | period ${fund.reportPeriod} | filed ${fund.filedDate}`);

    if (theMode === 'summary') {
        const long = holdings.filter((h) => String(h.position).toLowerCase() === 'long');
        const short = holdings.filter((h) => String(h.position).toLowerCase() === 'short');
        const mix = {};
        for (const h of holdings) {
            const k = h.assetCategoryLabel || 'unknown';
            mix[k] = round((mix[k] || 0) + (h.percentOfPortfolio ?? 0), 4);
        }
        const top = holdings[0];
        await flushRow({
            mode: 'summary',
            ...fund,
            holdingsReported: totalHoldings,
            holdingsAfterFilters: holdings.length,
            longPositions: long.length,
            shortPositions: short.length,
            topHolding: top?.securityName ?? null,
            topHoldingPercent: top?.percentOfPortfolio ?? null,
            topHoldingValueUsd: top?.valueUsd ?? null,
            top10Percent: round(holdings.slice(0, 10).reduce((t, h) => t + (h.percentOfPortfolio ?? 0), 0), 4),
            assetMixPercent: mix,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
        continue;
    }

    const slice = theMode === 'top' ? holdings.slice(0, perFund) : holdings;
    if (!slice.length) {
        await flushRow({ type: 'note', ticker, found: false, note: 'no holdings matched the filters; not charged' }, false);
        continue;
    }
    let rank = 0;
    for (const h of slice) {
        if (stopEarly()) break;
        rank += 1;
        await flushRow({
            mode: theMode,
            ticker,
            fundName: fund.fundName,
            reportPeriod: fund.reportPeriod,
            filedDate: fund.filedDate,
            rank,
            ...h,
            netAssetsUsd: fund.netAssetsUsd,
            filingUrl: fund.filingUrl,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
