// Oil & Gas Inventory Report: Weekly Stocks, Production and Draws
//
// What it does
// ------------
// Twice a week the US government publishes the numbers the whole energy
// market trades on: how much crude, gasoline and diesel is in storage, how
// much was produced, imported and refined, and how much natural gas is in the
// ground. The prints move Brent in Singapore as readily as WTI in Houston,
// which is why the release times are in every energy trader's calendar.
//
//   stocks       one row per product: what is in storage, the weekly build or
//                draw, and the same week a year ago
//   supply       one row per line of the balance: production, imports,
//                exports, refinery runs, with four week and year to date
//                averages
//   natural_gas  the gas storage report: total, net change, the year ago
//                comparison and the five year average
//
// Distinct from our commodity-futures-settlements, which gives the PRICE of
// crude and gas, and from european-electricity-prices, which gives power
// demand. This is the supply side that moves both.
//
// Pay per event
// -------------
//   inventory_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const FETCH_TIMEOUT_MS = 45000;
const PETROLEUM_URL = 'https://ir.eia.gov/wpsr/table1.csv';
const GAS_URL = 'https://ir.eia.gov/ngs/wngsr.txt';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'stocks',
    productFilter = [],
    onlyDraws = false,
    onlyBuilds = false,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['stocks', 'supply', 'natural_gas'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'stocks';
const filters = asList(productFilter).map((s) => s.toLowerCase());
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

async function getText(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        // The published URL redirects to a signed CDN link, which fetch
        // follows on its own; requesting the signed link directly would break
        // as soon as its signature expired.
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)', accept: 'text/csv, text/plain, */*' },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.text();
    } catch (err) {
        if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            return getText(url, attempt + 1);
        }
        log.warning(`fetch failed: ${url} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'inventory_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; }
            else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

// Values carry thousands separators, and where a percent change is undefined
// the file contains a replacement-character placeholder rather than a number
// or an empty cell. Anything that is not a number becomes null, never 0.
function num(v) {
    const s = String(v ?? '').replace(/,/g, '').trim();
    if (!s || !/^[+-]?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

// "7/17/26" -> "2026-07-17"
function isoFromShort(v) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    const [, mo, d, y] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// table1.csv is not one table. It holds the stocks table and then, part way
// down, a SECOND header row starting another table with a different column
// count and a different unit: stocks are million barrels, supply is thousand
// barrels per day. Parsing the file as a single CSV misaligns every row after
// the break and silently mixes the two units together.
function splitSections(csv) {
    const lines = csv.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    const sections = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith('"STUB_1"')) {
            current = { header: splitCsvLine(line), rows: [] };
            sections.push(current);
            continue;
        }
        if (current) current.rows.push(splitCsvLine(line));
    }
    return sections;
}

const passesFilter = (label) => !filters.length
    || filters.some((f) => String(label || '').toLowerCase().includes(f));

let emitted = 0;
const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

log.info(`EIA inventory ${theMode}`);

if (theMode === 'natural_gas') {
    const text = await getText(GAS_URL);
    if (!text) {
        await flushRow({ type: 'note', found: false, note: 'the natural gas storage report could not be read; usually transient, try again; not charged' }, false);
    } else {
        const grab = (re) => { const m = text.match(re); return m ? m[1] : null; };
        const weekEnding = grab(/Total\s*\(([\d/]+)\)/);
        const priorWeek = (text.match(/Total\s*\(([\d/]+)\)/g) || [])[1]?.match(/\(([\d/]+)\)/)?.[1] ?? null;
        const totals = [...text.matchAll(/Total\s*\([\d/]+\):\s*([\d,]+)\s*Bcf/g)].map((m) => num(m[1]));
        const row = {
            mode: 'natural_gas',
            report: 'Weekly Natural Gas Storage Report',
            weekEnding: isoFromShort(weekEnding),
            priorWeekEnding: isoFromShort(priorWeek),
            totalStocksBcf: totals[0] ?? null,
            priorWeekStocksBcf: totals[1] ?? null,
            netChangeBcf: num(grab(/Net change:\s*(-?[\d,]+)\s*Bcf/)),
            impliedFlowBcf: num(grab(/Implied flow:\s*(-?[\d,]+)\s*Bcf/)),
            yearAgoStocksBcf: num(grab(/Year ago stocks:\s*([\d,]+)\s*Bcf/)),
            percentVsYearAgo: num(grab(/% change from year ago:\s*(-?[\d.]+)/)),
            fiveYearAverageBcf: num(grab(/5-year avg stocks:\s*([\d,]+)\s*Bcf/)),
            percentVsFiveYearAverage: num(grab(/% change from 5-year avg:\s*(-?[\d.]+)/)),
            unit: 'Bcf',
            source: 'US Energy Information Administration',
            scrapedAt: new Date().toISOString(),
        };
        row.direction = row.netChangeBcf == null ? null : (row.netChangeBcf > 0 ? 'injection' : (row.netChangeBcf < 0 ? 'withdrawal' : 'flat'));
        if (row.totalStocksBcf == null) {
            await flushRow({ type: 'note', found: false, note: 'the gas storage report was reachable but could not be parsed; the layout may have changed; not charged' }, false);
        } else {
            await push(row);
        }
    }
} else {
    const csv = await getText(PETROLEUM_URL);
    if (!csv) {
        await flushRow({ type: 'note', found: false, note: 'the petroleum status report could not be read; usually transient, try again; not charged' }, false);
    } else {
        const sections = splitSections(csv);
        log.info(`Petroleum report parsed into ${sections.length} table(s)`);
        const stocksSection = sections.find((s) => s.header.length <= 9);
        const supplySection = sections.find((s) => s.header.length > 9);

        if (theMode === 'stocks') {
            if (!stocksSection) {
                await flushRow({ type: 'note', found: false, note: 'the stocks table was not found in the report; the layout may have changed; not charged' }, false);
            } else {
                const [, curDate, priorDate, , , yearDate] = stocksSection.header;
                for (const cells of stocksSection.rows) {
                    if (emitted >= rowCap) break;
                    if (deadlineMs && Date.now() > deadlineMs) break;
                    const label = clean(cells[0]);
                    if (!label || !passesFilter(label)) continue;
                    const weeklyChange = num(cells[3]);
                    if (onlyDraws && !(weeklyChange < 0)) continue;
                    if (onlyBuilds && !(weeklyChange > 0)) continue;
                    await push({
                        mode: 'stocks',
                        product: label,
                        weekEnding: isoFromShort(curDate),
                        priorWeekEnding: isoFromShort(priorDate),
                        yearAgoWeekEnding: isoFromShort(yearDate),
                        stocks: num(cells[1]),
                        priorWeekStocks: num(cells[2]),
                        weeklyChange,
                        weeklyPercentChange: num(cells[4]),
                        direction: weeklyChange == null ? null : (weeklyChange > 0 ? 'build' : (weeklyChange < 0 ? 'draw' : 'flat')),
                        yearAgoStocks: num(cells[5]),
                        yearOverYearChange: num(cells[6]),
                        yearOverYearPercentChange: num(cells[7]),
                        // Stocks are millions of barrels; the supply table in
                        // the same file is thousand barrels per day.
                        unit: 'million barrels',
                        source: 'US Energy Information Administration',
                        scrapedAt: new Date().toISOString(),
                    });
                }
            }
        } else {
            if (!supplySection) {
                await flushRow({ type: 'note', found: false, note: 'the supply table was not found in the report; the layout may have changed; not charged' }, false);
            } else {
                const h = supplySection.header;
                const curDate = h[2];
                const priorDate = h[3];
                const yearDate = h[5];
                for (const cells of supplySection.rows) {
                    if (emitted >= rowCap) break;
                    if (deadlineMs && Date.now() > deadlineMs) break;
                    const category = clean(cells[0]);
                    const rawItem = clean(cells[1]);
                    if (!rawItem) continue;
                    // Items are numbered in the report, e.g. "(17) Crude Oil
                    // Input to Refineries". The number is kept separately so
                    // the label is searchable.
                    const lineNo = (rawItem.match(/^\((\d+)\)/) || [])[1] ?? null;
                    const item = clean(rawItem.replace(/^\(\d+\)\s*/, ''));
                    if (!passesFilter(item) && !passesFilter(category)) continue;
                    await push({
                        mode: 'supply',
                        category,
                        item,
                        lineNumber: lineNo ? Number(lineNo) : null,
                        weekEnding: isoFromShort(curDate),
                        priorWeekEnding: isoFromShort(priorDate),
                        yearAgoWeekEnding: isoFromShort(yearDate),
                        value: num(cells[2]),
                        priorWeekValue: num(cells[3]),
                        weeklyChange: num(cells[4]),
                        yearAgoValue: num(cells[5]),
                        yearOverYearChange: num(cells[6]),
                        fourWeekAverage: num(cells[7]),
                        fourWeekAverageYearAgo: num(cells[8]),
                        fourWeekPercentChange: num(cells[9]),
                        yearToDateAverage: num(cells[10]),
                        yearToDateAverageYearAgo: num(cells[11]),
                        yearToDatePercentChange: num(cells[12]),
                        unit: 'thousand barrels per day',
                        source: 'US Energy Information Administration',
                        scrapedAt: new Date().toISOString(),
                    });
                }
            }
        }
    }
}

if (!emitted) {
    await flushRow({
        type: 'note', found: false,
        note: 'no rows matched; clear productFilter, or turn off onlyDraws and onlyBuilds, which cannot both be true; not charged',
    }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
