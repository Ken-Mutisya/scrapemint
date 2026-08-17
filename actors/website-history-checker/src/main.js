// Website History Checker (Wayback Machine)
//
// Strategy
// --------
// Two keyless Internet Archive endpoints, both open JSON:
//   1. Sparkline (the Wayback UI's own summary call) for per-site history:
//      GET https://web.archive.org/__wb/sparkline?output=json&url=<site>&collection=web
//      -> per-year/per-month capture counts, first_ts, last_ts.
//   2. CDX index for individual snapshots:
//      GET https://web.archive.org/cdx/search/cdx?url=<site>&output=json
//          &collapse=timestamp:4|6&from=<year>&to=<year>&limit=<n>
//      -> one row per capture (collapsed to yearly/monthly), with status,
//         mimetype and size. Note: limit=-1 (reverse) 504s on big sites, so
//         the last snapshot comes from sparkline instead.
// archive.org is scraper friendly by mission; datacenter IPs are fine.
//
// Pay per event
// -------------
//   history_summary ($0.005) one per site: first/last capture, totals, gaps.
//   snapshot_row    ($0.001) one per archived snapshot row.
//   Every row is charged; there is no per-run free allowance.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 0;
const HARD_CAP = 50000;
const REQUEST_DELAY_MS = 300;
const GRANULARITY_COLLAPSE = { yearly: 'timestamp:4', monthly: 'timestamp:6', all: null };
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    websites = [],
    includeSnapshots = true,
    granularity = 'yearly',
    fromYear = 0,
    toYear = 0,
    maxSnapshotsPerSite = 100,
    maxRows = 500,
    proxyConfiguration: proxyInput,
} = input;

const sites = (Array.isArray(websites) ? websites : [websites])
    .map(normalizeSite)
    .filter(Boolean);
if (!sites.length) {
    log.warning('Provide at least one domain or URL in "websites", e.g. ["shopify.com"].');
    await Actor.exit();
}

const collapse = GRANULARITY_COLLAPSE[String(granularity || 'yearly').toLowerCase()] ?? GRANULARITY_COLLAPSE.yearly;
const from = Number(fromYear) >= 1996 ? Math.floor(Number(fromYear)) : null;
const to = Number(toYear) >= 1996 ? Math.floor(Number(toYear)) : null;
const perSiteCap = Math.max(1, Math.min(HARD_CAP, Number(maxSnapshotsPerSite) || 100));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Referer: 'https://web.archive.org/',
};

async function getJson(url) {
    const res = await fetch(url, { headers: HEADERS, ...(dispatcher ? { dispatcher } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function tsToIso(ts) {
    const s = String(ts || '');
    if (!/^\d{4,14}$/.test(s)) return null;
    const p = s.padEnd(14, '0');
    return `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}T${p.slice(8, 10)}:${p.slice(10, 12)}:${p.slice(12, 14)}.000Z`;
}

function buildSummary(site, spark) {
    const years = spark?.years && typeof spark.years === 'object' ? spark.years : {};
    const yearKeys = Object.keys(years).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!yearKeys.length) return null;
    const snapshotsPerYear = {};
    let total = 0;
    for (const y of yearKeys) {
        const count = (years[y] || []).reduce((a, b) => a + (Number(b) || 0), 0);
        snapshotsPerYear[y] = count;
        total += count;
    }
    const firstYear = yearKeys[0];
    const lastYear = yearKeys[yearKeys.length - 1];
    const missingYears = [];
    let longestGapYears = 0;
    let gap = 0;
    for (let y = firstYear; y <= lastYear; y++) {
        if (!snapshotsPerYear[y]) {
            missingYears.push(y);
            gap += 1;
            if (gap > longestGapYears) longestGapYears = gap;
        } else {
            gap = 0;
        }
    }
    const firstTs = spark?.first_ts ?? null;
    const lastTs = spark?.last_ts ?? null;
    return {
        type: 'summary',
        website: site,
        archived: true,
        firstSnapshot: tsToIso(firstTs),
        lastSnapshot: tsToIso(lastTs),
        totalSnapshots: total,
        firstYear,
        lastYear,
        yearsWithCaptures: yearKeys.length,
        missingYears,
        longestGapYears,
        snapshotsPerYear,
        waybackFirstUrl: firstTs ? `https://web.archive.org/web/${firstTs}/${site}` : null,
        waybackLastUrl: lastTs ? `https://web.archive.org/web/${lastTs}/${site}` : null,
        calendarUrl: `https://web.archive.org/web/*/${site}`,
        scrapedAt,
    };
}

async function cdxQuery(site, limit, extra = {}) {
    const params = new URLSearchParams({ url: site, output: 'json', limit: String(limit) });
    if (collapse) params.set('collapse', collapse);
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
    const rows = await getJson(`https://web.archive.org/cdx/search/cdx?${params}`);
    return Array.isArray(rows) ? rows : [];
}

// CDX scans the whole index even when collapsed, so very large sites (100k+
// captures) can 504. Retry once, then fall back to one small bounded query
// per year, which stays fast regardless of site size.
async function fetchSnapshots(site, limit, summary) {
    let rows = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            rows = await cdxQuery(site, limit, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
            break;
        } catch (err) {
            if (attempt === 1) {
                log.warning(`Site "${site}" full CDX query failed twice (${err?.message}); falling back to per-year queries.`);
                rows = [];
            } else {
                await sleep(1500);
            }
        }
    }
    if (rows.length < 2 && summary?.firstYear) {
        const perYear = String(granularity).toLowerCase() === 'monthly' ? 12 : 1;
        const years = Object.keys(summary.snapshotsPerYear || {}).map(Number)
            .filter((y) => (!from || y >= from) && (!to || y <= to)).sort((a, b) => a - b);
        for (const y of years) {
            if ((rows.length - 1) >= limit) break;
            if (deadlineMs && Date.now() > deadlineMs) break;
            try {
                const yearRows = await cdxQuery(site, perYear, { from: y, to: y });
                if (rows.length === 0 && yearRows.length) rows = [yearRows[0]];
                rows.push(...yearRows.slice(1));
            } catch (err) {
                log.warning(`Site "${site}" year ${y} query failed: ${err?.message}`);
            }
            await sleep(150);
        }
    }
    if (rows.length < 2) return [];
    const header = rows[0];
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    return rows.slice(1, limit + 1).map((r) => ({
        type: 'snapshot',
        website: site,
        timestamp: tsToIso(r[idx.timestamp]),
        year: Number(String(r[idx.timestamp]).slice(0, 4)) || null,
        statusCode: r[idx.statuscode] === '-' ? null : Number(r[idx.statuscode]) || null,
        mimetype: r[idx.mimetype] ?? null,
        lengthBytes: Number(r[idx.length]) || null,
        originalUrl: r[idx.original] ?? null,
        waybackUrl: `https://web.archive.org/web/${r[idx.timestamp]}/${r[idx.original]}`,
        scrapedAt,
    }));
}

let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, eventName) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const scrapedAt = new Date().toISOString();
log.info(`Checking Wayback Machine history for ${sites.length} site(s), granularity=${granularity}${from ? `, from=${from}` : ''}${to ? `, to=${to}` : ''}.`);

let stopped = false;
let failures = 0;
for (const site of sites) {
    if (stopped || totalRowsPushed >= cap) break;
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    let spark;
    try {
        spark = await getJson(`https://web.archive.org/__wb/sparkline?output=json&url=${encodeURIComponent(site)}&collection=web`);
        failures = 0;
    } catch (err) {
        failures += 1;
        log.warning(`Site "${site}" summary failed: ${err?.message}`);
        if (failures >= 5) {
            log.warning('Five consecutive failures; archive.org may be throttling. Stopping.');
            break;
        }
        await sleep(2000);
        continue;
    }
    const summary = buildSummary(site, spark);
    if (!summary) {
        await flushRow({
            type: 'summary',
            website: site,
            archived: false,
            firstSnapshot: null,
            lastSnapshot: null,
            totalSnapshots: 0,
            calendarUrl: `https://web.archive.org/web/*/${site}`,
            scrapedAt,
        }, 'history_summary');
        log.info(`Site "${site}": never archived.`);
        await sleep(REQUEST_DELAY_MS);
        continue;
    }
    await flushRow(summary, 'history_summary');
    if (includeSnapshots && totalRowsPushed < cap) {
        const budget = Math.min(perSiteCap, cap - totalRowsPushed);
        let snaps = [];
        try {
            snaps = await fetchSnapshots(site, budget, summary);
        } catch (err) {
            log.warning(`Site "${site}" snapshot fetch failed: ${err?.message}. Summary row already saved.`);
        }
        for (const snap of snaps) {
            if (totalRowsPushed >= cap) break;
            await flushRow(snap, 'snapshot_row');
        }
        log.info(`Site "${site}": ${summary.totalSnapshots} captures ${summary.firstYear}-${summary.lastYear}, ${snaps.length} snapshot row(s).`);
    } else {
        log.info(`Site "${site}": ${summary.totalSnapshots} captures ${summary.firstYear}-${summary.lastYear}.`);
    }
    await sleep(REQUEST_DELAY_MS);
}

log.info(`Done. Pushed ${totalRowsPushed} row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();

function normalizeSite(value) {
    let s = String(value || '').trim();
    if (!s) return null;
    s = s.replace(/^https?:\/\//i, '').replace(/^\/\//, '').replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+(\/.*)?$/i.test(s) || !s.includes('.')) {
        log.warning(`Skipping unrecognized website: "${value}". Use a domain like example.com or a full URL.`);
        return null;
    }
    return s.toLowerCase();
}

// Buyer-selected RESIDENTIAL or SERP proxy groups bill the developer under
// pay-per-event pricing, and this data source works from datacenter IPs, so
// those groups are stripped (buyer-supplied proxyUrls pass through untouched).
function sanitizeProxyInput(p) {
    if (!p || typeof p !== 'object') return p;
    const out = { ...p };
    if (Array.isArray(out.apifyProxyGroups)) {
        const kept = out.apifyProxyGroups.filter((g) => !/RESIDENTIAL|SERP/i.test(String(g)));
        if (kept.length !== out.apifyProxyGroups.length) {
            log.warning('Ignoring RESIDENTIAL/SERP proxy groups: this source works from datacenter IPs and premium groups only raise run costs.');
        }
        if (kept.length) out.apifyProxyGroups = kept;
        else delete out.apifyProxyGroups;
    }
    return out;
}
