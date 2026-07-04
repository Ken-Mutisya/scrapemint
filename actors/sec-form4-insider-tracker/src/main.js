// SEC Form 4 Insider Trading Tracker
// Pulls Form 4 filings (insider stock transactions) from EDGAR, parses the
// XML, and pushes each transaction row (direct + derivative) to the dataset.
// Filters by ticker, insider role, transaction code, min value, and age.
//
// Endpoints:
//   https://www.sec.gov/files/company_tickers.json          -> ticker -> CIK map
//   https://efts.sec.gov/LATEST/search-index?q=&forms=4     -> full text search (JSON)
//   https://data.sec.gov/submissions/CIK{10digit}.json      -> per company filings history
//   https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/index.json -> filing folder listing
//   https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{xml}      -> Form 4 XML
//
// SEC requires a descriptive User-Agent with an email.
// Rate limit: 10 req/sec. We sleep 120ms between requests to stay polite.
//
// Free tier: first 2 transactions per run are free. Charge per transaction after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 2;
const EDGAR_RATE_SLEEP_MS = 120;

const TRANSACTION_CODE_DESCRIPTIONS = {
    P: 'Open market or private purchase',
    S: 'Open market or private sale',
    A: 'Grant, award, or other acquisition',
    D: 'Disposition',
    F: 'Payment of exercise price or tax liability',
    I: 'Discretionary transaction',
    M: 'Exercise or conversion of derivative security',
    C: 'Conversion of derivative security',
    E: 'Expiration of short derivative position',
    H: 'Expiration of long derivative position',
    O: 'Exercise of out of the money derivative security',
    X: 'Exercise of in or at the money derivative security',
    G: 'Bona fide gift',
    L: 'Small acquisition under Rule 16a 6',
    W: 'Acquisition or disposition by will or laws of descent',
    Z: 'Deposit into or withdrawal from voting trust',
    J: 'Other acquisition or disposition',
    K: 'Transaction in equity swap or similar instrument',
    U: 'Disposition in a tender of shares in a change of control',
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    ciks = [],
    transactionCodes = [],
    reporterRoles = [],
    minTransactionValue = 0,
    minShares = 0,
    includeDerivative = true,
    includeNonDerivative = true,
    maxAgeHours = 168,
    maxItemsPerSource = 50,
    maxItemsTotal = 200,
    dedupe = true,
    userAgent: userAgentInput = '',
    proxyConfiguration: proxyInput,
} = input;

const tickerList = (Array.isArray(tickers) ? tickers : [])
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);

const cikList = (Array.isArray(ciks) ? ciks : [])
    .map((c) => String(c).trim().replace(/^0+/, ''))
    .filter(Boolean);

if (tickerList.length === 0 && cikList.length === 0) {
    throw new Error('Provide at least one ticker in tickers or one CIK in ciks.');
}

const codeFilter = new Set(
    (Array.isArray(transactionCodes) ? transactionCodes : [])
        .map((c) => String(c).trim().toUpperCase())
        .filter(Boolean),
);

const roleFilter = new Set(
    (Array.isArray(reporterRoles) ? reporterRoles : [])
        .map((r) => String(r).trim().toLowerCase())
        .filter(Boolean),
);

const userAgent = String(userAgentInput).trim()
    || 'scrapemint-form4-tracker research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses.');
}

const headers = {
    'User-Agent': userAgent,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Host': undefined,
};

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

const store = await Actor.openKeyValueStore('sec-form4-tracker-state');
const seenState = (dedupe && (await store.getValue('SEEN_IDS'))) || [];
const seen = new Set(seenState);
const newSeen = new Set(seen);

const ageCutoffMs = maxAgeHours > 0 ? Date.now() - maxAgeHours * 3600 * 1000 : null;

let totalPushed = 0;
let totalSeen = 0;
let filteredOut = 0;
let deduped = 0;

const tickerToCik = await loadTickerMap();
for (const ticker of tickerList) {
    const cik = tickerToCik.get(ticker);
    if (!cik) {
        log.warning(`Ticker ${ticker} not found in EDGAR ticker map. Skipping.`);
        continue;
    }
    cikList.push(cik);
}

const uniqueCiks = [...new Set(cikList)];
log.info(`Resolved ${uniqueCiks.length} unique CIK(s): ${uniqueCiks.join(', ')}`);

for (const cik of uniqueCiks) {
    if (totalPushed >= maxItemsTotal) break;
    await processCik(cik);
}

if (dedupe) {
    const trimmed = [...newSeen].slice(-50_000);
    await store.setValue('SEEN_IDS', trimmed);
}

log.info(`Run complete. Pushed ${totalPushed}. seen=${totalSeen} filteredOut=${filteredOut} deduped=${deduped}`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---- ticker map ----

async function loadTickerMap() {
    const url = 'https://www.sec.gov/files/company_tickers.json';
    try {
        const res = await fetch(url, { headers: stripHostHeader(headers) });
        if (!res.ok) {
            log.warning(`Ticker map HTTP ${res.status}. Tickers will not resolve.`);
            return new Map();
        }
        const json = await res.json();
        const map = new Map();
        for (const key of Object.keys(json)) {
            const row = json[key];
            if (row?.ticker && row?.cik_str) {
                map.set(String(row.ticker).toUpperCase(), String(row.cik_str));
            }
        }
        log.info(`Loaded ${map.size} tickers from EDGAR.`);
        return map;
    } catch (err) {
        log.warning(`Ticker map fetch failed: ${err?.message}`);
        return new Map();
    }
}

// ---- per CIK processing ----

async function processCik(cikRaw) {
    const cik = String(cikRaw).replace(/^0+/, '');
    const cikPadded = cik.padStart(10, '0');
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
    log.info(`Fetching submissions for CIK ${cik} (${submissionsUrl})`);

    await sleep(EDGAR_RATE_SLEEP_MS);
    let submissions;
    try {
        const res = await fetch(submissionsUrl, { headers: stripHostHeader(headers) });
        if (!res.ok) {
            log.warning(`submissions HTTP ${res.status} for CIK ${cik}`);
            return;
        }
        submissions = await res.json();
    } catch (err) {
        log.warning(`submissions fetch failed: ${err?.message}`);
        return;
    }

    const issuerName = submissions?.name || null;
    const tickerFromSub = (submissions?.tickers && submissions.tickers[0]) || null;

    const recent = submissions?.filings?.recent;
    if (!recent) return;

    const forms = recent.form || [];
    const accs = recent.accessionNumber || [];
    const dates = recent.filingDate || [];
    const primaryDocs = recent.primaryDocument || [];

    let pulled = 0;
    for (let i = 0; i < forms.length; i++) {
        if (pulled >= maxItemsPerSource) break;
        if (totalPushed >= maxItemsTotal) break;
        if (forms[i] !== '4') continue;

        const accession = accs[i];
        const filingDate = dates[i];
        if (!accession || !filingDate) continue;

        const filingMs = Date.parse(filingDate + 'T00:00:00Z');
        if (ageCutoffMs !== null && filingMs < ageCutoffMs) continue;

        totalSeen += 1;
        if (dedupe && seen.has(accession)) { deduped += 1; continue; }

        const accNoDashes = accession.replace(/-/g, '');
        const primary = primaryDocs[i];

        await sleep(EDGAR_RATE_SLEEP_MS);
        const xml = await fetchForm4Xml(cik, accNoDashes, primary);
        if (!xml) { filteredOut += 1; continue; }

        const parsed = parseForm4(xml);
        if (!parsed) { filteredOut += 1; continue; }

        const insiderMatches = filterByRole(parsed.reportingOwner);
        if (!insiderMatches) { filteredOut += 1; continue; }

        const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${primary || 'index.json'}`;
        const context = {
            accessionNumber: accession,
            filingDate,
            filingUrl,
            issuer: {
                cik: parsed.issuer.cik || cik,
                name: parsed.issuer.name || issuerName,
                ticker: parsed.issuer.ticker || tickerFromSub,
            },
            insider: parsed.reportingOwner,
        };

        let anyPushed = false;
        if (includeNonDerivative) {
            for (const tx of parsed.nonDerivativeTransactions) {
                if (totalPushed >= maxItemsTotal) break;
                if (await pushIfMatches(tx, context, 'non_derivative')) anyPushed = true;
            }
        }
        if (includeDerivative) {
            for (const tx of parsed.derivativeTransactions) {
                if (totalPushed >= maxItemsTotal) break;
                if (await pushIfMatches(tx, context, 'derivative')) anyPushed = true;
            }
        }

        if (anyPushed) pulled += 1;
        newSeen.add(accession);
    }
}

function filterByRole(owner) {
    if (roleFilter.size === 0) return true;
    const roles = [];
    if (owner.isDirector) roles.push('director');
    if (owner.isOfficer) roles.push('officer');
    if (owner.isTenPercentOwner) roles.push('ten_percent_owner');
    if (owner.isOther) roles.push('other');
    return roles.some((r) => roleFilter.has(r));
}

async function pushIfMatches(tx, ctx, kind) {
    if (codeFilter.size > 0 && !codeFilter.has(tx.transactionCode)) { filteredOut += 1; return false; }

    const shares = toNumber(tx.shares);
    const price = toNumber(tx.pricePerShare);
    const totalValue = shares && price ? shares * price : null;

    if (minShares > 0 && shares && shares < minShares) { filteredOut += 1; return false; }
    if (minTransactionValue > 0 && (totalValue === null || totalValue < minTransactionValue)) {
        filteredOut += 1;
        return false;
    }

    const id = `${ctx.accessionNumber}#${kind}#${tx.index}`;

    await Actor.pushData({
        transactionId: id,
        accessionNumber: ctx.accessionNumber,
        filingDate: ctx.filingDate,
        filingUrl: ctx.filingUrl,
        kind,
        issuer: ctx.issuer,
        insider: {
            cik: ctx.insider.cik,
            name: ctx.insider.name,
            title: ctx.insider.officerTitle || null,
            isDirector: !!ctx.insider.isDirector,
            isOfficer: !!ctx.insider.isOfficer,
            isTenPercentOwner: !!ctx.insider.isTenPercentOwner,
            isOther: !!ctx.insider.isOther,
        },
        transaction: {
            date: tx.transactionDate || null,
            code: tx.transactionCode || null,
            codeDescription: TRANSACTION_CODE_DESCRIPTIONS[tx.transactionCode] || null,
            shares: shares,
            pricePerShare: price,
            totalValue: totalValue,
            sharesOwnedAfter: toNumber(tx.sharesOwnedAfter),
            directOrIndirect: tx.directOrIndirect || null,
            securityTitle: tx.securityTitle || null,
        },
        scrapedAt: new Date().toISOString(),
    });

    totalPushed += 1;
    maybeCharge();
    return true;
}

// ---- XML fetch + parse ----

async function fetchForm4Xml(cik, accNoDashes, primaryDoc) {
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/index.json`;
    let xmlName = null;

    if (primaryDoc && primaryDoc.endsWith('.xml')) {
        // EDGAR's primaryDocument for Form 4/5 points at the XSLT-rendered
        // viewer path (xslF345X0N/<file>.xml), which is HTML, not the ownership
        // XML. Strip that prefix to reach the raw XML in the accession root, or
        // every filing parses to zero transactions.
        xmlName = primaryDoc.replace(/^xslF345X\d+\//i, '');
    }

    if (!xmlName) {
        try {
            const res = await fetch(indexUrl, { headers: stripHostHeader(headers) });
            if (res.ok) {
                const idx = await res.json();
                const items = idx?.directory?.item || [];
                const xml = items.find((it) => /\.xml$/i.test(it.name) && !/index/i.test(it.name));
                if (xml) xmlName = xml.name;
            }
        } catch (err) {
            log.warning(`Index fetch failed for ${accNoDashes}: ${err?.message}`);
        }
    }

    if (!xmlName) return null;

    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${xmlName}`;
    try {
        await sleep(EDGAR_RATE_SLEEP_MS);
        const res = await fetch(xmlUrl, { headers: stripHostHeader({ ...headers, 'Accept': 'application/xml,text/xml,*/*' }) });
        if (!res.ok) {
            log.warning(`XML HTTP ${res.status} for ${xmlUrl}`);
            return null;
        }
        return await res.text();
    } catch (err) {
        log.warning(`XML fetch failed: ${err?.message}`);
        return null;
    }
}

function parseForm4(xml) {
    const issuer = {
        cik: pickTag(xml, 'issuerCik'),
        name: pickTag(xml, 'issuerName'),
        ticker: pickTag(xml, 'issuerTradingSymbol'),
    };

    const reportingOwner = {
        cik: pickInSection(xml, 'reportingOwnerId', 'rptOwnerCik'),
        name: pickInSection(xml, 'reportingOwnerId', 'rptOwnerName'),
        isDirector: pickBool(xml, 'isDirector'),
        isOfficer: pickBool(xml, 'isOfficer'),
        isTenPercentOwner: pickBool(xml, 'isTenPercentOwner'),
        isOther: pickBool(xml, 'isOther'),
        officerTitle: pickTag(xml, 'officerTitle'),
    };

    const nonDerivativeTransactions = [];
    const derivativeTransactions = [];

    const ndBlocks = findAllBlocks(xml, 'nonDerivativeTransaction');
    ndBlocks.forEach((block, i) => {
        nonDerivativeTransactions.push({
            index: i,
            securityTitle: pickInSection(block, 'securityTitle', 'value'),
            transactionDate: pickInSection(block, 'transactionDate', 'value'),
            transactionCode: pickInSection(block, 'transactionCoding', 'transactionCode'),
            shares: pickInSection(block, 'transactionShares', 'value'),
            pricePerShare: pickInSection(block, 'transactionPricePerShare', 'value'),
            sharesOwnedAfter: pickInSection(block, 'postTransactionAmounts', 'sharesOwnedFollowingTransaction', 'value'),
            directOrIndirect: pickInSection(block, 'ownershipNature', 'directOrIndirectOwnership', 'value'),
        });
    });

    const dBlocks = findAllBlocks(xml, 'derivativeTransaction');
    dBlocks.forEach((block, i) => {
        derivativeTransactions.push({
            index: i,
            securityTitle: pickInSection(block, 'securityTitle', 'value'),
            transactionDate: pickInSection(block, 'transactionDate', 'value'),
            transactionCode: pickInSection(block, 'transactionCoding', 'transactionCode'),
            shares: pickInSection(block, 'transactionShares', 'value'),
            pricePerShare: pickInSection(block, 'transactionPricePerShare', 'value'),
            sharesOwnedAfter: pickInSection(block, 'postTransactionAmounts', 'sharesOwnedFollowingTransaction', 'value'),
            directOrIndirect: pickInSection(block, 'ownershipNature', 'directOrIndirectOwnership', 'value'),
        });
    });

    return { issuer, reportingOwner, nonDerivativeTransactions, derivativeTransactions };
}

function findAllBlocks(xml, tag) {
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g');
    return xml.match(re) || [];
}

function pickTag(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
    const m = xml.match(re);
    return m ? m[1].trim() : null;
}

function pickInSection(xml, ...tags) {
    let current = xml;
    for (const tag of tags) {
        const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
        const m = current.match(re);
        if (!m) return null;
        current = m[1];
    }
    return current.trim() || null;
}

function pickBool(xml, tag) {
    const val = pickTag(xml, tag);
    if (val === null) return false;
    return val === '1' || val.toLowerCase() === 'true';
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function stripHostHeader(h) {
    const copy = { ...h };
    delete copy['Host'];
    return copy;
}

function maybeCharge() {
    if (totalPushed > FREE_TIER_ITEMS) {
        __chargeJobs.push(Actor.charge({ eventName: 'filing_row' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }));
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
