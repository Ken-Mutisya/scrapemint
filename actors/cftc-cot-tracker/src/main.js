// CFTC Commitments of Traders (COT) Tracker
//
// Strategy
// --------
// One official keyless source: the CFTC Public Reporting Environment (Socrata),
// which publishes the weekly Commitments of Traders report — how the big trader
// classes are positioned (long/short) in every US futures market. Traders watch
// COT to see what commercials (hedgers), large speculators, managed money and
// leveraged funds are doing in FX, gold, crude, indices, crypto futures and more.
//
// Three report flavours, each its own Socrata dataset with its own trader
// classes, normalized here into one `groups` array so the row shape is stable:
//   - legacy         Large Speculators / Commercials / Small Traders (the classic)
//   - disaggregated  Producer-Merchant / Swap Dealers / Managed Money / Other
//   - financial(TFF) Dealers / Asset Managers / Leveraged Funds / Other
//
// The net position (long - short) and its week-over-week change are the numbers
// traders act on, so each group carries `net` and (where the dataset provides
// it) `netChange`. Socrata serves every numeric column as a STRING, so all math
// is done client-side after Number() coercion.
//
// With `dedupe` on and a weekly schedule, every run returns only report weeks
// not seen before — an alert for "the new COT just dropped".
//
// Pay per event
// -------------
//   positioning_row ($0.004) charged per market row pushed. First 2 rows per run
//   are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 30000;
const HOST = 'publicreporting.cftc.gov';
const UA = 'Scrapemint COT Tracker (admin@scrapemint.com)';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    reportType = 'legacy',
    markets = [],
    latestOnly = true,
    weeksBack = 12,
    maxRows = 200,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
// Socrata returns numbers as strings; coerce and try candidate field names in order.
const num = (row, ...cands) => {
    for (const c of cands) {
        const v = row[c];
        if (v !== undefined && v !== null && v !== '') { const n = Number(v); if (Number.isFinite(n)) return n; }
    }
    return null;
};

const REPORTS = {
    legacy: {
        ds: '6dca-aqww',
        label: 'Legacy (Futures Only)',
        headline: 'Large Speculators',
        groups: [
            { name: 'Large Speculators', long: ['noncomm_positions_long_all'], short: ['noncomm_positions_short_all'], changeLong: ['change_in_noncomm_long_all'], changeShort: ['change_in_noncomm_short_all'], pctLong: ['pct_of_oi_noncomm_long_all'], pctShort: ['pct_of_oi_noncomm_short_all'] },
            { name: 'Commercials', long: ['comm_positions_long_all'], short: ['comm_positions_short_all'], changeLong: ['change_in_comm_long_all'], changeShort: ['change_in_comm_short_all'], pctLong: ['pct_of_oi_comm_long_all'], pctShort: ['pct_of_oi_comm_short_all'] },
            { name: 'Small Traders', long: ['nonrept_positions_long_all'], short: ['nonrept_positions_short_all'], changeLong: ['change_in_nonrept_long_all'], changeShort: ['change_in_nonrept_short_all'], pctLong: ['pct_of_oi_nonrept_long_all'], pctShort: ['pct_of_oi_nonrept_short_all'] },
        ],
    },
    disaggregated: {
        ds: '72hh-3qpy',
        label: 'Disaggregated (Futures Only)',
        headline: 'Managed Money',
        groups: [
            { name: 'Producer/Merchant', long: ['prod_merc_positions_long', 'prod_merc_positions_long_all'], short: ['prod_merc_positions_short', 'prod_merc_positions_short_all'], changeLong: ['change_in_prod_merc_long', 'change_in_prod_merc_long_all'], changeShort: ['change_in_prod_merc_short', 'change_in_prod_merc_short_all'] },
            { name: 'Swap Dealers', long: ['swap_positions_long_all', 'swap__positions_long_all'], short: ['swap__positions_short_all', 'swap_positions_short_all'], changeLong: ['change_in_swap_long_all', 'change_in_swap__long_all'], changeShort: ['change_in_swap_short_all', 'change_in_swap__short_all'] },
            { name: 'Managed Money', long: ['m_money_positions_long_all'], short: ['m_money_positions_short_all'], changeLong: ['change_in_m_money_long_all'], changeShort: ['change_in_m_money_short_all'] },
            { name: 'Other Reportables', long: ['other_rept_positions_long', 'other_rept_positions_long_all'], short: ['other_rept_positions_short', 'other_rept_positions_short_all'], changeLong: ['change_in_other_rept_long', 'change_in_other_rept_long_all'], changeShort: ['change_in_other_rept_short', 'change_in_other_rept_short_all'] },
        ],
    },
    financial: {
        ds: 'gpe5-46if',
        label: 'Traders in Financial Futures',
        headline: 'Leveraged Funds',
        groups: [
            { name: 'Dealers', long: ['dealer_positions_long_all'], short: ['dealer_positions_short_all'], changeLong: ['change_in_dealer_long_all'], changeShort: ['change_in_dealer_short_all'] },
            { name: 'Asset Managers', long: ['asset_mgr_positions_long', 'asset_mgr_positions_long_all'], short: ['asset_mgr_positions_short', 'asset_mgr_positions_short_all'], changeLong: ['change_in_asset_mgr_long', 'change_in_asset_mgr_long_all'], changeShort: ['change_in_asset_mgr_short', 'change_in_asset_mgr_short_all'] },
            { name: 'Leveraged Funds', long: ['lev_money_positions_long', 'lev_money_positions_long_all'], short: ['lev_money_positions_short', 'lev_money_positions_short_all'], changeLong: ['change_in_lev_money_long', 'change_in_lev_money_long_all'], changeShort: ['change_in_lev_money_short', 'change_in_lev_money_short_all'] },
            { name: 'Other Reportables', long: ['other_rept_positions_long', 'other_rept_positions_long_all'], short: ['other_rept_positions_short', 'other_rept_positions_short_all'], changeLong: ['change_in_other_rept_long', 'change_in_other_rept_long_all'], changeShort: ['change_in_other_rept_short', 'change_in_other_rept_short_all'] },
        ],
    },
};

const cfg = REPORTS[String(reportType).toLowerCase()] || REPORTS.legacy;
if (!REPORTS[String(reportType).toLowerCase()]) log.warning(`Unknown reportType "${reportType}"; using legacy. Options: ${Object.keys(REPORTS).join(', ')}.`);
const marketKeywords = asList(markets).map((k) => k.toUpperCase());
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const weeks = Math.max(1, Math.min(520, Number(weeksBack) || 12));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'User-Agent': UA } });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 140)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

// Latest report date across the dataset (COT is one date per week for all markets).
const maxResp = await getJson(`https://${HOST}/resource/${cfg.ds}.json?$select=max(report_date_as_yyyy_mm_dd) as maxd`);
const maxDate = clean(maxResp?.[0]?.maxd);
if (!maxDate) { log.warning('Could not read latest report date from CFTC.'); await Actor.exit(); }

const conds = [];
if (latestOnly) {
    conds.push(`report_date_as_yyyy_mm_dd='${maxDate}'`);
} else {
    const cutoff = new Date(Date.parse(maxDate) - weeks * 7 * 86400000).toISOString().slice(0, 19);
    conds.push(`report_date_as_yyyy_mm_dd>='${cutoff}'`);
}
if (marketKeywords.length) {
    const or = marketKeywords.map((k) => `upper(market_and_exchange_names) like '%${k.replace(/'/g, "''")}%'`).join(' OR ');
    conds.push(`(${or})`);
}
const where = encodeURIComponent(conds.join(' AND '));
const order = encodeURIComponent('report_date_as_yyyy_mm_dd DESC, market_and_exchange_names ASC');

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'positioning_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

function buildGroup(row, g) {
    const long = num(row, ...g.long);
    const short = num(row, ...g.short);
    if (long === null && short === null) return null;
    const out = { group: g.name, long, short, net: (long ?? 0) - (short ?? 0) };
    const cl = g.changeLong ? num(row, ...g.changeLong) : null;
    const cs = g.changeShort ? num(row, ...g.changeShort) : null;
    if (cl !== null || cs !== null) { out.changeLong = cl; out.changeShort = cs; out.netChange = (cl ?? 0) - (cs ?? 0); }
    const pl = g.pctLong ? num(row, ...g.pctLong) : null;
    const ps = g.pctShort ? num(row, ...g.pctShort) : null;
    if (pl !== null || ps !== null) { out.pctLong = pl; out.pctShort = ps; }
    return out;
}

const seenStore = dedupe ? await Actor.openKeyValueStore('cot-seen') : null;
const seen = new Set();
if (seenStore) for (const k of (await seenStore.getValue('seen-cot')) || []) seen.add(String(k));

log.info(`CFTC COT ${cfg.label} | ${latestOnly ? `latest report ${maxDate.slice(0, 10)}` : `last ${weeks} weeks`}${marketKeywords.length ? `, markets ~ ${marketKeywords.join(', ')}` : ' (all markets)'}. Cap ${cap} rows.`);

let emitted = 0;
let offset = 0;
let stop = false;

while (!stop && emitted < cap) {
    if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching run timeout; stopping early.'); break; }
    const url = `https://${HOST}/resource/${cfg.ds}.json?$where=${where}&$order=${order}&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const rows = await getJson(url);
    if (!rows || !rows.length) break;
    for (const row of rows) {
        if (emitted >= cap) { stop = true; break; }
        const reportDate = clean(row.report_date_as_yyyy_mm_dd)?.slice(0, 10);
        const full = clean(row.market_and_exchange_names) || '';
        const [marketName, ...exch] = full.split(' - ');
        const code = clean(row.cftc_contract_market_code);
        const dedupeKey = `${cfg.ds}|${code || marketName}|${reportDate}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const groups = cfg.groups.map((g) => buildGroup(row, g)).filter(Boolean);
        const headline = groups.find((g) => g.group === cfg.headline);
        const oi = num(row, 'open_interest_all');
        await flushRow({
            reportType: String(reportType).toLowerCase(),
            reportLabel: cfg.label,
            reportDate,
            market: clean(marketName),
            exchange: clean(exch.join(' - ')),
            contractName: clean(row.contract_market_name),
            contractCode: code,
            openInterest: oi,
            openInterestChange: num(row, 'change_in_open_interest_all'),
            headlineGroup: cfg.headline,
            headlineNet: headline?.net ?? null,
            headlineNetChange: headline?.netChange ?? null,
            groups,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
}

if (seenStore && emitted > 0) await seenStore.setValue('seen-cot', [...seen].slice(-300000));

log.info(`Done. ${emitted} market row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
