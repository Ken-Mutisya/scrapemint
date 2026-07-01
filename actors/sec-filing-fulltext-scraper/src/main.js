// SEC Filing Full-Text Search Scraper
//
// Strategy
// --------
// The SEC EDGAR full-text search index is a keyless JSON API that searches the
// body of every filing since 2001 across all companies and forms:
//   GET https://efts.sec.gov/LATEST/search-index?q=<query>&forms=<f>&startdt=&enddt=&ciks=&from=<offset>
// It returns up to 100 hits per request; page by advancing `from` in steps of
// 100 up to EDGAR's 10,000 result window. Each hit carries the company, form,
// filing date, accession number, and the document filename, from which we build
// a direct link to the filing. No login, no API key, no browser.
//
// This is keyword full-text search across ALL filings and companies, distinct
// from the per-form, per-ticker EDGAR trackers.
//
// Pay per event
// -------------
//   filing_row ($0.007) charged when a filing row is pushed.
//   First 15 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 15;
const HARD_CAP = 5000;
const PAGE_SIZE = 100;
const EDGAR_WINDOW = 10000; // EDGAR full-text search caps deep paging here
const RATE_SLEEP_MS = 250;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    query,
    forms = [],
    startDate,
    endDate,
    ciks = [],
    maxRows = 200,
    proxyConfiguration: proxyInput,
} = input;

const q = String(query || '').trim();
if (!q) {
    log.warning('Provide a "query", e.g. "material weakness" or going concern. Wrap phrases in quotes.');
    await Actor.exit();
}

const formList = (Array.isArray(forms) ? forms : String(forms).split(','))
    .map((f) => String(f || '').trim()).filter(Boolean);
const cikList = (Array.isArray(ciks) ? ciks : String(ciks).split(','))
    .map((c) => String(c || '').trim().replace(/[^0-9]/g, '')).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

function buildUrl(from) {
    const params = new URLSearchParams();
    params.set('q', q);
    if (formList.length) params.set('forms', formList.join(','));
    if (cikList.length) params.set('ciks', cikList.join(','));
    if (startDate || endDate) {
        params.set('dateRange', 'custom');
        if (startDate) params.set('startdt', String(startDate).trim());
        if (endDate) params.set('enddt', String(endDate).trim());
    }
    if (from) params.set('from', String(from));
    return `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
}

async function fetchPage(url) {
    // EDGAR requires a descriptive User-Agent with contact info.
    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Scrapemint SEC Filing Search actor (admin@scrapemint.com)',
        },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`edgar HTTP ${res.status}`);
    return res.json();
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// display_names look like "Apple Inc  (AAPL)  (CIK 0000320193)".
function parseName(raw) {
    if (!raw) return { companyName: null, ticker: null };
    const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*\(CIK\s*\d+\)\s*$/);
    if (m) return { companyName: m[1].trim(), ticker: m[2].trim() };
    return { companyName: raw.replace(/\s*\(CIK\s*\d+\)\s*$/, '').trim(), ticker: null };
}

function filingUrl(adsh, cik, filename) {
    if (!adsh || !cik) return null;
    const nodash = String(adsh).replace(/-/g, '');
    const cikInt = String(Number(cik)); // strip leading zeros
    if (filename) return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${nodash}/${filename}`;
    return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${nodash}/${adsh}-index.htm`;
}

const seen = new Set();
let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'filing_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`EDGAR full-text search: q="${q}"${formList.length ? ` forms=${formList.join(',')}` : ''}${cikList.length ? ` ciks=${cikList.join(',')}` : ''}, up to ${cap} rows.`);

let from = 0;
let reportedTotal = null;
while (totalRowsPushed < cap && from < EDGAR_WINDOW) {
    let data;
    try {
        data = await fetchPage(buildUrl(from));
    } catch (err) {
        log.warning(`Page at from=${from} failed: ${err?.message}. Stopping.`);
        break;
    }
    const hits = data?.hits?.hits || [];
    if (reportedTotal === null) {
        reportedTotal = data?.hits?.total?.value ?? null;
        log.info(`EDGAR reports ${reportedTotal} total matching filing(s).`);
    }
    if (hits.length === 0) break;

    for (const hit of hits) {
        if (totalRowsPushed >= cap) break;
        const s = hit._source || {};
        const adsh = s.adsh || null;
        const filename = typeof hit._id === 'string' && hit._id.includes(':')
            ? hit._id.slice(hit._id.indexOf(':') + 1) : null;
        const key = hit._id || `${adsh}:${filename}`;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);

        const { companyName, ticker } = parseName((s.display_names || [])[0]);
        const cik = (s.ciks || [])[0] || null;

        await flushRow({
            query: q,
            companyName,
            ticker,
            cik,
            ciks: s.ciks || null,
            form: s.form || null,
            rootForm: (s.root_forms || [])[0] || null,
            fileDate: s.file_date || null,
            periodEnding: s.period_ending || null,
            fileType: s.file_type || null,
            fileDescription: s.file_description || null,
            accessionNo: adsh,
            filingUrl: filingUrl(adsh, cik, filename),
            sic: (s.sics || [])[0] || null,
            businessLocation: (s.biz_locations || [])[0] || null,
            businessStates: s.biz_states || null,
            incorporationStates: s.inc_states || null,
            score: hit._score ?? null,
            scrapedAt: new Date().toISOString(),
        });
    }

    if (hits.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    await sleep(RATE_SLEEP_MS);
}

log.info(`Done. Pushed ${totalRowsPushed} filing row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
