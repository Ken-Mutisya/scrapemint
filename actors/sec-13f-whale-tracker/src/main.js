// SEC 13F Whale Portfolio Tracker
//
// For each institutional fund manager, pulls their latest 13F-HR holdings from
// EDGAR and DIFFS them against the prior quarter, surfacing new positions,
// adds, trims, and full exits with position value and portfolio weight. The
// quarter-over-quarter change is the signal, not the static holdings list.
//
// Endpoints (all keyless public EDGAR):
//   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&...  -> name to CIK
//   https://data.sec.gov/submissions/CIK{10digit}.json           -> filing history
//   https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/index.json -> folder listing
//   https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{info}.xml -> holdings table
//
// SEC requires a descriptive User-Agent with an email. Rate limit 10 req/sec;
// we sleep 120ms between requests to stay polite.
//
// Free tier: first 20 rows per run are free. After that each row is charged by
// its change tier (key_move for new/exit, position_change for adds/trims,
// holding for unchanged).

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 20;
const EDGAR_RATE_SLEEP_MS = 120;

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    managers = [],
    maxManagers = 10,
    minPositionValueUsd = 0,
    materialChangePct = 10,
    includeUnchanged = true,
    maxHoldingsPerManager = 500,
    userAgent: userAgentInput = '',
    proxyConfiguration: proxyInput,
} = input;

const managerInputs = (Array.isArray(managers) ? managers : [])
    .map((m) => String(m).trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxManagers) || 10));

if (managerInputs.length === 0) {
    throw new Error('Provide at least one manager (a CIK number or a fund name) in managers.');
}

const userAgent = String(userAgentInput).trim()
    || 'scrapemint-13f-whale-tracker research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses.');
}

const headers = {
    'User-Agent': userAgent,
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
};

// Proxy is optional; EDGAR is a public API and works without one. Resolve a URL
// only if the buyer configured one, falling back to none on any error.
let proxyUrl;
try {
    const pc = await Actor.createProxyConfiguration(proxyInput);
    proxyUrl = pc ? await pc.newUrl() : undefined;
} catch (err) {
    log.warning(`Proxy unavailable, continuing without it: ${err?.message}`);
}

const materialPct = Math.max(0, Number(materialChangePct) || 0);
const minValue = Math.max(0, Number(minPositionValueUsd) || 0);
const perManagerCap = Math.max(1, Number(maxHoldingsPerManager) || 500);

let totalRows = 0;
let keyMoves = 0; let positionChanges = 0; let holdings = 0;

for (const m of managerInputs) {
    const manager = await resolveManager(m);
    if (!manager) { log.warning(`Could not resolve manager "${m}". Skipping.`); continue; }
    await processManager(manager);
}

log.info(`Run complete. rows=${totalRows} (key_move=${keyMoves}, position_change=${positionChanges}, holding=${holdings}).`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();

// ---------- manager resolution ----------

async function resolveManager(raw) {
    if (/^\d+$/.test(raw)) {
        return { cik: raw.replace(/^0+/, ''), name: null };
    }
    // Resolve by FILER entity name via EDGAR company search. NOT full text search:
    // FTS matches any filing that merely MENTIONS the name (e.g. a fund that holds
    // Berkshire), so "Berkshire Hathaway" there returns the wrong filer. getcompany
    // matches the filing entity itself, restricted to 13F-HR filers.
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(raw)}&type=13F-HR&dateb=&owner=include&count=5&output=atom`;
    try {
        await sleep(EDGAR_RATE_SLEEP_MS);
        const res = await fetch(url, { headers: { ...headers, 'Accept': 'application/atom+xml,text/xml,*/*' } });
        if (!res.ok) { log.warning(`company search HTTP ${res.status} for "${raw}".`); return null; }
        const xml = await res.text();
        const cm = xml.match(/<cik>(\d+)<\/cik>/i);
        if (!cm) { log.warning(`No 13F filer found for "${raw}".`); return null; }
        const nm = xml.match(/<conformed-name>([\s\S]*?)<\/conformed-name>/i);
        return { cik: cm[1].replace(/^0+/, ''), name: nm ? nm[1].trim() : null };
    } catch (err) {
        log.warning(`Manager resolve failed for "${raw}": ${err?.message}`);
        return null;
    }
}

// ---------- per manager ----------

async function processManager(manager) {
    const cikPadded = String(manager.cik).padStart(10, '0');
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;
    await sleep(EDGAR_RATE_SLEEP_MS);

    let submissions;
    try {
        const res = await fetch(submissionsUrl, { headers });
        if (!res.ok) { log.warning(`submissions HTTP ${res.status} for CIK ${manager.cik}`); return; }
        submissions = await res.json();
    } catch (err) {
        log.warning(`submissions fetch failed for CIK ${manager.cik}: ${err?.message}`);
        return;
    }

    const managerName = manager.name || submissions?.name || null;
    const recent = submissions?.filings?.recent;
    if (!recent) { log.warning(`No filings for CIK ${manager.cik}.`); return; }

    const forms = recent.form || [];
    const filings = [];
    for (let i = 0; i < forms.length; i++) {
        if (forms[i] !== '13F-HR') continue;
        filings.push({
            accession: recent.accessionNumber?.[i],
            filingDate: recent.filingDate?.[i] || null,
            reportDate: recent.reportDate?.[i] || null,
        });
    }
    if (filings.length === 0) { log.warning(`No 13F-HR filings for ${managerName || manager.cik}.`); return; }

    // filings.recent is newest-first; take the latest report and the one before.
    const latest = filings[0];
    const prior = filings[1] || null;
    log.info(`${managerName || manager.cik}: latest 13F report ${latest.reportDate || latest.filingDate}${prior ? `, prior ${prior.reportDate || prior.filingDate}` : ' (no prior quarter)'}.`);

    const latestHoldings = await fetchHoldings(manager.cik, latest.accession);
    const priorHoldings = prior ? await fetchHoldings(manager.cik, prior.accession) : new Map();
    if (latestHoldings.size === 0) { log.warning(`No parseable holdings in latest filing for ${managerName || manager.cik}.`); return; }

    const totalValue = [...latestHoldings.values()].reduce((s, h) => s + h.value, 0);
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${manager.cik}/${latest.accession.replace(/-/g, '')}/`;
    const hasPrior = prior && priorHoldings.size > 0;

    let pushedForManager = 0;

    // Current holdings, annotated with the change vs the prior quarter.
    for (const [cusip, h] of latestHoldings) {
        if (pushedForManager >= perManagerCap) break;
        if (h.value < minValue) continue;

        const p = priorHoldings.get(cusip);
        let changeType; let priorShares = null; let priorValue = null;
        if (!hasPrior) {
            changeType = 'current';
        } else if (!p) {
            changeType = 'new';
        } else {
            priorShares = p.shares; priorValue = p.value;
            const pct = p.shares > 0 ? ((h.shares - p.shares) / p.shares) * 100 : (h.shares > 0 ? Infinity : 0);
            if (Math.abs(pct) < materialPct) changeType = 'unchanged';
            else changeType = pct > 0 ? 'increased' : 'reduced';
        }

        if (!includeUnchanged && changeType === 'unchanged') continue;

        await pushHolding({
            managerName, managerCik: manager.cik,
            reportDate: latest.reportDate, priorReportDate: prior?.reportDate || null,
            filingDate: latest.filingDate, accessionNumber: latest.accession, filingUrl,
            h, changeType, priorShares, priorValue, totalValue,
        });
        pushedForManager += 1;
    }

    // Full exits: held last quarter, gone this quarter.
    if (hasPrior) {
        for (const [cusip, p] of priorHoldings) {
            if (pushedForManager >= perManagerCap) break;
            if (latestHoldings.has(cusip)) continue;
            if (p.value < minValue) continue;
            await pushHolding({
                managerName, managerCik: manager.cik,
                reportDate: latest.reportDate, priorReportDate: prior?.reportDate || null,
                filingDate: latest.filingDate, accessionNumber: latest.accession, filingUrl,
                h: { issuer: p.issuer, cusip, titleOfClass: p.titleOfClass, putCall: p.putCall, shares: 0, value: 0 },
                changeType: 'exited', priorShares: p.shares, priorValue: p.value, totalValue,
            });
            pushedForManager += 1;
        }
    }
}

// ---------- holdings fetch + parse ----------

async function fetchHoldings(cik, accession) {
    const accNoDashes = String(accession).replace(/-/g, '');
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDashes}`;
    let infoName = null;
    try {
        await sleep(EDGAR_RATE_SLEEP_MS);
        const res = await fetch(`${base}/index.json`, { headers });
        if (res.ok) {
            const idx = await res.json();
            const items = (idx?.directory?.item || []).filter((it) => /\.xml$/i.test(it.name) && it.name !== 'primary_doc.xml');
            // Prefer a file that names itself an info/holdings table; otherwise the
            // first non-cover xml (13F info tables are often numerically named).
            const preferred = items.find((it) => /(info|table|holding)/i.test(it.name));
            infoName = (preferred || items[0])?.name || null;
        }
    } catch (err) {
        log.warning(`index fetch failed for ${accNoDashes}: ${err?.message}`);
    }
    if (!infoName) return new Map();

    let xml;
    try {
        await sleep(EDGAR_RATE_SLEEP_MS);
        const res = await fetch(`${base}/${infoName}`, { headers: { ...headers, 'Accept': 'application/xml,text/xml,*/*' } });
        if (!res.ok) { log.warning(`info table HTTP ${res.status} for ${base}/${infoName}`); return new Map(); }
        xml = await res.text();
    } catch (err) {
        log.warning(`info table fetch failed: ${err?.message}`);
        return new Map();
    }

    return parseInfoTable(xml);
}

function parseInfoTable(xml) {
    const blocks = xml.match(/<(?:\w+:)?infoTable\b[\s\S]*?<\/(?:\w+:)?infoTable>/g) || [];
    // Aggregate by CUSIP: managers can split one issuer across several lot rows.
    const byCusip = new Map();
    for (const b of blocks) {
        const cusip = (pick(b, 'cusip') || '').toUpperCase();
        if (!cusip) continue;
        const value = numUsd(pick(b, 'value'));
        const shares = num(pickNested(b, 'shrsOrPrnAmt', 'sshPrnamt')) ?? num(pick(b, 'sshPrnamt')) ?? 0;
        const existing = byCusip.get(cusip);
        if (existing) {
            existing.value += value;
            existing.shares += shares;
        } else {
            byCusip.set(cusip, {
                issuer: pick(b, 'nameOfIssuer'),
                cusip,
                titleOfClass: pick(b, 'titleOfClass'),
                putCall: pickNested(b, 'putCall') || pick(b, 'putCall') || null,
                value,
                shares,
            });
        }
    }
    return byCusip;
}

// ---------- push + charge ----------

async function pushHolding(c) {
    const { h } = c;
    const sharesChange = c.priorShares == null ? null : h.shares - c.priorShares;
    const sharesChangePct = (c.priorShares && c.priorShares > 0)
        ? Math.round(((h.shares - c.priorShares) / c.priorShares) * 1000) / 10
        : null;
    const valueChange = c.priorValue == null ? null : h.value - c.priorValue;
    const weightPct = c.totalValue > 0 ? Math.round((h.value / c.totalValue) * 10000) / 100 : null;

    await Actor.pushData({
        manager: { name: c.managerName, cik: c.managerCik },
        reportDate: c.reportDate,
        priorReportDate: c.priorReportDate,
        filingDate: c.filingDate,
        accessionNumber: c.accessionNumber,
        filingUrl: c.filingUrl,
        issuer: h.issuer,
        cusip: h.cusip,
        titleOfClass: h.titleOfClass || null,
        putCall: h.putCall || null,
        changeType: c.changeType,
        shares: h.shares,
        value: h.value,
        portfolioWeightPct: weightPct,
        priorShares: c.priorShares,
        priorValue: c.priorValue,
        sharesChange,
        sharesChangePct,
        valueChange,
        scrapedAt: new Date().toISOString(),
    });

    totalRows += 1;
    charge(c.changeType);
}

// Tier each row: new/exited are the high-signal key moves, material adds/trims
// are position changes, everything else is a plain holding. First 20 rows free.
function charge(changeType) {
    let event;
    if (changeType === 'new' || changeType === 'exited') { event = 'key_move'; keyMoves += 1; }
    else if (changeType === 'increased' || changeType === 'reduced') { event = 'position_change'; positionChanges += 1; }
    else { event = 'holding'; holdings += 1; }

    if (totalRows <= FREE_TIER_ROWS) return;
    __chargeJobs.push(Actor.charge({ eventName: event }).catch((err) => log.warning(`charge ${event} failed (continuing): ${err?.message}`)));
}

// ---------- xml helpers ----------

function pick(block, tag) {
    const m = block.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
    return m ? m[1].trim() : null;
}

function pickNested(block, ...tags) {
    let cur = block;
    for (const tag of tags) {
        const m = cur.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
        if (!m) return null;
        cur = m[1];
    }
    return cur.trim() || null;
}

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

// 13F value is reported in whole dollars for filings since 2023 (was thousands
// before). Treat as dollars; pre-2023 reports under-state value, which is fine
// since the actor focuses on recent quarter-over-quarter changes.
function numUsd(v) {
    return num(v) ?? 0;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
