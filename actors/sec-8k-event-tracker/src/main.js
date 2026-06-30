// SEC 8-K Material Event Tracker
// Pulls 8-K filings (material corporate events) from EDGAR and pushes one
// row per filing, tagged with the 8-K item codes it reports.
// Filters by ticker, CIK, item code, category shortcut, and age.
//
// Endpoints:
//   https://www.sec.gov/files/company_tickers.json          -> ticker -> CIK map
//   https://data.sec.gov/submissions/CIK{10digit}.json      -> per company filings history
//   https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc} -> primary document
//
// SEC requires a descriptive User-Agent with an email.
// Rate limit: 10 req/sec. We sleep 120ms between requests to stay polite.
//
// Free tier: first 30 filings per run are free. Charge per filing after.

import { Actor, log } from 'apify';

const FREE_TIER_ITEMS = 30;
const EDGAR_RATE_SLEEP_MS = 120;

const ITEM_DESCRIPTIONS = {
    '1.01': 'Entry into a material definitive agreement',
    '1.02': 'Termination of a material definitive agreement',
    '1.03': 'Bankruptcy or receivership',
    '1.04': 'Mine safety reporting',
    '1.05': 'Material cybersecurity incidents',
    '2.01': 'Completion of acquisition or disposition of assets',
    '2.02': 'Results of operations and financial condition (earnings)',
    '2.03': 'Creation of a direct financial obligation',
    '2.04': 'Triggering events that accelerate a financial obligation',
    '2.05': 'Costs associated with exit or disposal activities',
    '2.06': 'Material impairments',
    '3.01': 'Notice of delisting or failure to satisfy a listing rule',
    '3.02': 'Unregistered sales of equity securities',
    '3.03': 'Material modification to rights of security holders',
    '4.01': 'Changes in registrant accountant',
    '4.02': 'Non reliance on previously issued financial statements',
    '5.01': 'Changes in control of registrant',
    '5.02': 'Departure, appointment, or compensation of directors and officers',
    '5.03': 'Amendments to articles of incorporation or bylaws',
    '5.04': 'Temporary suspension of trading under registrant employee benefit plans',
    '5.05': 'Amendments to the registrant code of ethics',
    '5.06': 'Change in shell company status',
    '5.07': 'Submission of matters to a vote of security holders',
    '5.08': 'Shareholder director nominations',
    '6.01': 'ABS informational and computational material',
    '6.02': 'Change of servicer or trustee',
    '6.03': 'Change in credit enhancement or other external support',
    '6.04': 'Failure to make a required distribution',
    '6.05': 'Securities Act updating disclosure',
    '7.01': 'Regulation FD disclosure',
    '8.01': 'Other events',
    '9.01': 'Financial statements and exhibits',
};

const CATEGORY_TO_ITEMS = {
    earnings: ['2.02'],
    exec_changes: ['5.02'],
    ma: ['1.01', '2.01'],
    material_agreements: ['1.01', '1.02'],
    cyber: ['1.05'],
    bankruptcy: ['1.03'],
    delisting: ['3.01'],
    impairments: ['2.06'],
    accountant: ['4.01', '4.02'],
    control: ['5.01'],
    regulation_fd: ['7.01'],
    other: ['8.01'],
};

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    ciks = [],
    items: itemFilter = [],
    categories = [],
    includeAmendments = true,
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

const itemSet = new Set(
    (Array.isArray(itemFilter) ? itemFilter : [])
        .map((c) => String(c).trim())
        .filter(Boolean),
);

for (const cat of (Array.isArray(categories) ? categories : [])) {
    const key = String(cat).trim().toLowerCase();
    const mapped = CATEGORY_TO_ITEMS[key];
    if (mapped) {
        for (const it of mapped) itemSet.add(it);
    } else {
        log.warning(`Unknown category "${cat}". Known: ${Object.keys(CATEGORY_TO_ITEMS).join(', ')}`);
    }
}

const userAgent = String(userAgentInput).trim()
    || 'scrapemint-8k-tracker research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses.');
}

const headers = {
    'User-Agent': userAgent,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
};

await Actor.createProxyConfiguration(proxyInput);

const store = await Actor.openKeyValueStore('sec-8k-tracker-state');
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
if (itemSet.size > 0) log.info(`Filtering to items: ${[...itemSet].join(', ')}`);

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
        const res = await fetch(url, { headers });
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
    log.info(`Fetching submissions for CIK ${cik}`);

    await sleep(EDGAR_RATE_SLEEP_MS);
    let submissions;
    try {
        const res = await fetch(submissionsUrl, { headers });
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
    const exchangeFromSub = (submissions?.exchanges && submissions.exchanges[0]) || null;
    const sic = submissions?.sic || null;
    const sicDescription = submissions?.sicDescription || null;

    const recent = submissions?.filings?.recent;
    if (!recent) return;

    const forms = recent.form || [];
    const accs = recent.accessionNumber || [];
    const filingDates = recent.filingDate || [];
    const reportDates = recent.reportDate || [];
    const acceptanceDates = recent.acceptanceDateTime || [];
    const primaryDocs = recent.primaryDocument || [];
    const itemsArr = recent.items || [];
    const primaryDocDescs = recent.primaryDocDescription || [];

    let pulled = 0;
    for (let i = 0; i < forms.length; i++) {
        if (pulled >= maxItemsPerSource) break;
        if (totalPushed >= maxItemsTotal) break;

        const form = forms[i];
        const is8K = form === '8-K' || (includeAmendments && form === '8-K/A');
        if (!is8K) continue;

        const accession = accs[i];
        const filingDate = filingDates[i];
        if (!accession || !filingDate) continue;

        const acceptance = acceptanceDates[i] || null;
        const filingMs = acceptance ? Date.parse(acceptance) : Date.parse(filingDate + 'T00:00:00Z');
        if (ageCutoffMs !== null && filingMs < ageCutoffMs) continue;

        const itemStr = itemsArr[i] || '';
        const itemList = itemStr
            ? itemStr.split(',').map((s) => s.trim()).filter(Boolean)
            : [];

        totalSeen += 1;

        if (itemSet.size > 0) {
            const matches = itemList.some((it) => itemSet.has(it));
            if (!matches) { filteredOut += 1; continue; }
        }

        if (dedupe && seen.has(accession)) { deduped += 1; continue; }

        const accNoDashes = accession.replace(/-/g, '');
        const primary = primaryDocs[i] || null;
        const filingUrl = primary
            ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/${primary}`
            : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K`;
        const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}/`;

        const itemDetails = itemList.map((code) => ({
            code,
            description: ITEM_DESCRIPTIONS[code] || null,
        }));

        await Actor.pushData({
            accessionNumber: accession,
            form,
            filingDate,
            reportDate: reportDates[i] || null,
            acceptanceDateTime: acceptance,
            filingUrl,
            indexUrl,
            primaryDocDescription: primaryDocDescs[i] || null,
            issuer: {
                cik,
                name: issuerName,
                ticker: tickerFromSub,
                exchange: exchangeFromSub,
                sic,
                sicDescription,
            },
            items: itemDetails,
            itemCodes: itemList,
            scrapedAt: new Date().toISOString(),
        });

        totalPushed += 1;
        pulled += 1;
        newSeen.add(accession);
        maybeCharge();
    }
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
