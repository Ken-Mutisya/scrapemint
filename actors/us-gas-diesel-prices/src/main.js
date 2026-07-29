// US Gas & Diesel Prices: Weekly Retail by Region and Grade
//
// What it does
// ------------
// The official weekly survey of what drivers actually pay at the pump, as
// clean rows: national, the five refining regions and their sub districts,
// nine states and ten cities, for every grade of petrol and for diesel.
//
//   prices   one row per series at the latest published week, with the move
//            on the week and on the year, the 52 week range, and the spread
//            against the national average
//   history  one row per series per week over a date range
//   series   the catalogue of regions and grades available
//
// Published as legacy spreadsheets rather than an API, which is why this
// exists. Keyless, no browser.
//
// Pay per event
// -------------
//   price_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';
import * as XLSX from 'xlsx';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 90000;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'prices',
    product = 'gasoline',
    grade = 'regular',
    formulation = 'all',
    regions = [],
    areaTypes = [],
    weeksBack = 52,
    startDate = '',
    endDate = '',
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const normDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim()) ? String(s).trim() : null);
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Dates arrive as Excel serial numbers counted from 30 December 1899.
const serialToIso = (serial) => {
    if (!Number.isFinite(serial)) return null;
    return isoDay(new Date(Date.UTC(1899, 11, 30) + serial * 86400000));
};

const theMode = ['prices', 'history', 'series'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'prices';
const theProduct = ['gasoline', 'diesel'].includes(String(product).toLowerCase())
    ? String(product).toLowerCase() : 'gasoline';
const weeks = Math.max(1, Math.min(2000, Number(weeksBack) || 52));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const wantRegions = asList(regions).map((r) => r.toLowerCase());
const wantAreaTypes = asList(areaTypes).map((a) => a.toLowerCase());

const GASOLINE = {
    url: 'https://www.eia.gov/petroleum/gasdiesel/xls/pswrgvwall.xls',
    label: 'gasoline',
    // grade + formulation choose the sheet; the workbook has one per pair.
    sheets: {
        'regular|conventional': 'Data 1', 'regular|reformulated': 'Data 2', 'regular|all': 'Data 3',
        'midgrade|conventional': 'Data 4', 'midgrade|reformulated': 'Data 5', 'midgrade|all': 'Data 6',
        'premium|conventional': 'Data 7', 'premium|reformulated': 'Data 8', 'premium|all': 'Data 9',
        'all|conventional': 'Data 10', 'all|reformulated': 'Data 11', 'all|all': 'Data 12',
    },
};
const DIESEL = {
    url: 'https://www.eia.gov/petroleum/gasdiesel/xls/psw18vwall.xls',
    label: 'diesel',
    // Only the weekly sheets. The workbook pairs each one with a MONTHLY
    // sheet whose name differs by a single extra space, and mixing them puts
    // monthly averages in a weekly series.
    sheets: {
        'no2|all': 'Data 1', 'all|all': 'Data 1',
        'low_sulfur|all': 'Data 3',
        'ultra_low_sulfur|all': 'Data 5',
    },
};

const GRADES = theProduct === 'diesel'
    ? ['no2', 'low_sulfur', 'ultra_low_sulfur', 'all']
    : ['regular', 'midgrade', 'premium', 'all'];
const requestedGrade = String(grade || '').toLowerCase().trim();
const gradeWasSubstituted = !!requestedGrade && !GRADES.includes(requestedGrade);
const theGrade = GRADES.includes(requestedGrade) ? requestedGrade
    : (theProduct === 'diesel' ? 'no2' : 'regular');
const theFormulation = theProduct === 'diesel' ? 'all'
    : (['conventional', 'reformulated', 'all'].includes(String(formulation).toLowerCase())
        ? String(formulation).toLowerCase() : 'all');

const PADDS = ['east coast', 'new england', 'central atlantic', 'lower atlantic', 'midwest', 'gulf coast', 'rocky mountain', 'west coast'];
const STATES = ['california', 'colorado', 'florida', 'massachusetts', 'minnesota', 'new york', 'ohio', 'texas', 'washington'];

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'price_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

async function fetchWorkbook(url, sheetName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        // Only the sheet in play is parsed; the workbook holds twelve and
        // reading all of them costs memory for nothing.
        const wb = XLSX.read(buf, { type: 'buffer', sheets: [sheetName] });
        const sheet = wb.Sheets[sheetName];
        if (!sheet) return { error: `sheet ${sheetName} not found in the published workbook` };
        return { rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }) };
    } catch (err) {
        return { error: err?.message || 'download failed' };
    } finally { clearTimeout(timer); }
}

// Series are titled "Weekly Los Angeles Regular All Formulations Retail
// Gasoline Prices (Dollars per Gallon)". Everything except the place name is
// boilerplate, so it is stripped back to the region.
function parseSeriesName(rawName) {
    let s = String(rawName || '').replace(/\s+/g, ' ').trim();
    const frequency = /^weekly/i.test(s) ? 'weekly' : (/^monthly/i.test(s) ? 'monthly' : null);
    s = s.replace(/^(weekly|monthly)\s+/i, '')
        .replace(/\s*\(dollars per gallon\)\s*$/i, '')
        .replace(/\s*retail (gasoline|diesel) prices\s*$/i, '')
        .replace(/\s*retail prices\s*$/i, '');
    const gradeMatch = s.match(/(all grades|regular|midgrade|premium|no 2 diesel ultra low sulfur \(0-15 ppm\)|no 2 diesel low sulfur \(15-500 ppm\)|no 2 diesel)/i);
    const formMatch = s.match(/(all formulations|conventional|reformulated)/i);
    let region = s;
    if (gradeMatch) region = region.replace(gradeMatch[0], ' ');
    if (formMatch) region = region.replace(formMatch[0], ' ');
    region = region.replace(/\s+/g, ' ').trim();
    // Refining districts carry their designator in the name, as in "Central
    // Atlantic (PADD 1B)". It is pulled out so the district still classifies
    // as a region rather than falling through as an unknown area.
    const paddMatch = region.match(/\(PADD\s*([0-9A-C]+)\)/i);
    const paddCode = paddMatch ? paddMatch[1].toUpperCase() : null;
    const bare = region.replace(/\s*\(PADD\s*[0-9A-C]+\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
    const lower = bare.toLowerCase();
    // The survey publishes exactly four kinds of area, so anything that is
    // not the nation, a refining district or a state is one of the ten cities.
    // The diesel workbook adds district variants such as "West Coast Except
    // California", so a district is matched by containment rather than an
    // exact name, otherwise those variants fall through as cities.
    const areaType = /^u\.?s\.?$/i.test(bare) ? 'national'
        : (STATES.includes(lower) ? 'state'
            : (PADDS.some((p) => lower === p || lower.startsWith(`${p} `)) ? 'region' : 'city'));
    return {
        region: region || null,
        regionName: bare || null,
        paddCode,
        areaType,
        gradeLabel: gradeMatch ? gradeMatch[0] : null,
        formulationLabel: formMatch ? formMatch[0] : null,
        frequency,
    };
}

const source = theProduct === 'diesel' ? DIESEL : GASOLINE;
const sheetKey = `${theGrade}|${theFormulation}`;
const sheetName = source.sheets[sheetKey];

log.info(`Fuel prices ${theMode} | ${theProduct} ${theGrade} ${theFormulation} | sheet ${sheetName || 'none'}`);
if (gradeWasSubstituted) {
    await note({
        requestedGrade: grade, usedGrade: theGrade, product: theProduct,
        note: `"${grade}" is not a published ${theProduct} grade, so ${theGrade} was used instead; ${theProduct} grades are ${GRADES.join(', ')}; not charged`,
    });
}

if (!sheetName) {
    await note({
        requestedProduct: theProduct, requestedGrade: grade, requestedFormulation: formulation,
        note: `that combination is not published: ${theProduct} grades are ${GRADES.join(', ')}${theProduct === 'gasoline' ? ' and formulations are conventional, reformulated, all' : ' (diesel has no formulation split)'}; not charged`,
    });
} else {
    const wb = await fetchWorkbook(source.url, sheetName);
    if (wb.error || !Array.isArray(wb.rows)) {
        await note({ note: `could not read the published workbook: ${wb.error}; not charged` });
    } else {
        const rows = wb.rows;
        const sourceKeys = rows[1] || [];
        const names = rows[2] || [];
        const series = [];
        for (let c = 1; c < names.length; c += 1) {
            if (!names[c]) continue;
            const meta = parseSeriesName(names[c]);
            series.push({ col: c, sourceKey: sourceKeys[c] || null, title: String(names[c]).replace(/\s+/g, ' ').trim(), ...meta });
        }

        // Data rows: a numeric first cell is an Excel date serial. The sheet
        // ends with an empty row, and every series starts on its own date so
        // blanks appear inside otherwise complete rows.
        const observations = [];
        for (let r = 3; r < rows.length; r += 1) {
            const row = rows[r];
            if (!row || !row.length || typeof row[0] !== 'number') continue;
            const date = serialToIso(row[0]);
            if (date) observations.push({ date, row });
        }
        observations.sort((a, b) => a.date.localeCompare(b.date));

        // The published frequency is confirmed from the dates themselves,
        // because the diesel workbook pairs each weekly sheet with a monthly
        // one whose title differs by a single extra space.
        let detectedFrequency = null;
        if (observations.length > 2) {
            const gap = (Date.parse(observations[observations.length - 1].date)
                - Date.parse(observations[observations.length - 2].date)) / 86400000;
            detectedFrequency = gap > 20 ? 'monthly' : 'weekly';
        }

        const latest = observations[observations.length - 1];
        const to = normDay(endDate) || (latest ? latest.date : null);
        const from = normDay(startDate)
            || (to ? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - weeks * 7 * 86400000)) : null);

        const matches = (s) => {
            if (wantAreaTypes.length && !wantAreaTypes.includes(s.areaType)) return false;
            if (wantRegions.length && !wantRegions.some((w) => `${s.region || ''} ${s.regionName || ''}`.toLowerCase().includes(w))) return false;
            return true;
        };
        const selected = series.filter(matches);
        if (!selected.length) {
            await note({
                availableRegions: series.map((s) => s.region).filter(Boolean).slice(0, 30),
                note: 'no series matched the region or area filters; run series mode to list what is published; not charged',
            });
        }

        const valueAt = (s, obs) => {
            const v = obs.row[s.col];
            // A blank means that series was not surveyed that week, never a
            // price of zero.
            return typeof v === 'number' && Number.isFinite(v) ? v : null;
        };

        if (theMode === 'series') {
            for (const s of selected) {
                if (emitted >= rowCap) break;
                const withValues = observations.filter((o) => valueAt(s, o) != null);
                await push({
                    mode: 'series',
                    product: source.label,
                    grade: theGrade,
                    formulation: theProduct === 'diesel' ? null : theFormulation,
                    region: s.region,
                    regionName: s.regionName,
                    paddCode: s.paddCode,
                    areaType: s.areaType,
                    seriesTitle: s.title,
                    sourceKey: s.sourceKey,
                    frequency: detectedFrequency || s.frequency,
                    firstWeek: withValues.length ? withValues[0].date : null,
                    latestWeek: withValues.length ? withValues[withValues.length - 1].date : null,
                    observations: withValues.length,
                    unit: 'US dollars per gallon',
                    sourceName: 'US Energy Information Administration',
                    sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/',
                    scrapedAt: new Date().toISOString(),
                });
            }
        } else if (theMode === 'prices') {
            // National average for the same grade drives the spread column.
            const national = selected.find((s) => s.areaType === 'national')
                || series.find((s) => s.areaType === 'national');
            const nationalPrice = national && latest ? valueAt(national, latest) : null;
            const weekAgo = observations[observations.length - 2] || null;
            const yearAgo = observations.slice().reverse()
                .find((o) => Date.parse(o.date) <= Date.parse(latest.date) - 364 * 86400000) || null;

            const shaped = [];
            for (const s of selected) {
                const price = latest ? valueAt(s, latest) : null;
                if (price == null) continue;
                const prev = weekAgo ? valueAt(s, weekAgo) : null;
                const prior = yearAgo ? valueAt(s, yearAgo) : null;
                const window = observations
                    .filter((o) => o.date > isoDay(new Date(Date.parse(`${latest.date}T00:00:00Z`) - 364 * 86400000)))
                    .map((o) => valueAt(s, o)).filter((v) => v != null);
                shaped.push({
                    s,
                    price,
                    row: {
                        mode: 'prices',
                        product: source.label,
                        grade: theGrade,
                        formulation: theProduct === 'diesel' ? null : theFormulation,
                        region: s.region,
                        regionName: s.regionName,
                        paddCode: s.paddCode,
                        areaType: s.areaType,
                        weekEnding: latest.date,
                        pricePerGallon: round(price, 3),
                        unit: 'US dollars per gallon',
                        previousWeekPrice: prev != null ? round(prev, 3) : null,
                        weekChangeCents: prev != null ? round((price - prev) * 100, 1) : null,
                        yearAgoPrice: prior != null ? round(prior, 3) : null,
                        yearChangeCents: prior != null ? round((price - prior) * 100, 1) : null,
                        yearChangePercent: prior ? round(((price - prior) / prior) * 100, 2) : null,
                        fiftyTwoWeekHigh: window.length ? round(Math.max(...window), 3) : null,
                        fiftyTwoWeekLow: window.length ? round(Math.min(...window), 3) : null,
                        // What this region pays above or below the national
                        // average, which is the comparison people actually make.
                        centsVersusNationalAverage: nationalPrice != null && s.areaType !== 'national'
                            ? round((price - nationalPrice) * 100, 1) : null,
                        nationalAveragePrice: nationalPrice != null ? round(nationalPrice, 3) : null,
                        frequency: detectedFrequency,
                        seriesTitle: s.title,
                        sourceKey: s.sourceKey,
                        sourceName: 'US Energy Information Administration',
                        sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/',
                        scrapedAt: new Date().toISOString(),
                    },
                });
            }
            shaped.sort((a, b) => b.price - a.price);
            const total = shaped.length;
            for (let i = 0; i < shaped.length; i += 1) {
                if (emitted >= rowCap || pastDeadline()) break;
                await push({ ...shaped[i].row, priceRankMostExpensive: i + 1, seriesCompared: total });
            }
            if (!shaped.length && selected.length) {
                await note({ weekEnding: latest ? latest.date : null, note: 'the latest published week carries no price for the selected series; not charged' });
            }
        } else {
            const inRange = observations.filter((o) => (!from || o.date >= from) && (!to || o.date <= to));
            const out = [];
            for (const s of selected) {
                for (const o of inRange) {
                    const price = valueAt(s, o);
                    if (price == null) continue;
                    out.push({
                        mode: 'history',
                        product: source.label,
                        grade: theGrade,
                        formulation: theProduct === 'diesel' ? null : theFormulation,
                        region: s.region,
                        regionName: s.regionName,
                        paddCode: s.paddCode,
                        areaType: s.areaType,
                        weekEnding: o.date,
                        pricePerGallon: round(price, 3),
                        unit: 'US dollars per gallon',
                        frequency: detectedFrequency,
                        seriesTitle: s.title,
                        sourceKey: s.sourceKey,
                        sourceName: 'US Energy Information Administration',
                        sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/',
                        scrapedAt: new Date().toISOString(),
                    });
                }
            }
            // Newest first, and interleaved across regions so a row cap
            // returns a recent window for every region rather than the whole
            // history of the first one.
            out.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding)
                || String(a.region).localeCompare(String(b.region)));
            for (const row of out) {
                if (emitted >= rowCap || pastDeadline()) break;
                await push(row);
            }
            if (!out.length) {
                await note({ note: `no observations between ${from} and ${to} for the selected series; not charged` });
            }
        }
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the product, grade and region requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
