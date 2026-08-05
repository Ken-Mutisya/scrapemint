// Import Duty & Tariff Calculator
//
// US import duty rates from the keyless USITC Harmonized Tariff Schedule REST
// API, plus bilateral trade flows from the keyless UN Comtrade preview API.
// Look up an HS code or a product keyword, get the duty rate that actually
// applies to it, and estimate the duty on a shipment. No browser, no login,
// no API key.
//
// Endpoints (all keyless):
//   https://hts.usitc.gov/reststop/exportList   full heading, indent ordered
//   https://hts.usitc.gov/reststop/search       keyword match
//   https://comtradeapi.un.org/public/v1/preview/C/A/HS   bilateral flows
//
// Four upstream shapes that a naive read gets wrong:
//
//   * Duty rates live on the 8-digit subheading. The 10-digit statistical
//     lines under it come back with EMPTY rate cells and inherit from their
//     parent. Those 10-digit lines are exactly what an importer types in, so
//     reading a line in isolation reports "no duty rate" across most of the
//     schedule. Rates are resolved by walking the indent tree, and every row
//     says whether its rate was stated on the line or inherited.
//
//   * A specific duty ("3.9¢/kg") has no ad valorem component. Casting it to a
//     percentage yields 0, which reads as duty free. Ad valorem percentages
//     are null unless a percent is genuinely present, and a shipment estimate
//     is refused rather than understated when the rate is specific or compound.
//
//   * The Special column is not one rate. It packs several, sometimes with no
//     separator ("Free (A,AU,...)8.8¢/liter(JO)"), and some entries are cross
//     references ("See 9822.04.15 (AU)") that state no rate at all.
//
//   * Comtrade's ISO2 codes are not unique. DE resolves to both 276 (Germany)
//     and 280 (Fed. Rep. of Germany ...1990); US resolves to 840, 841 and 842.
//     Picking the first match can silently query a country that stopped
//     existing in 1990 and return nothing.
//
// Scope limit worth stating plainly: Section 301, Section 232 and IEEPA
// tariffs are NOT part of the general rate. They live in Chapter 99 and are
// applied on top. Every duty estimate here says so, and `additionalTariffs`
// mode returns the Chapter 99 headings so they can be read directly.
//
// Free tier: first 3 rows per run are free, then each row is charged.

import { Actor, log } from 'apify';
import {
    buildTree, normalizeCode, formatCode,
    COUNTRY_PROGRAMS, COLUMN_2_COUNTRIES,
} from './hts.js';

const FREE_TIER_ROWS = 3;
const HTS_BASE = 'https://hts.usitc.gov/reststop';
const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const PARTNER_REF = 'https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json';
const FETCH_TIMEOUT_MS = 60000;
/* The two upstreams tolerate very different pacing. The USITC schedule showed
 * no rate limiting across sustained bursts; Comtrade's public preview starts
 * returning 429 somewhere above a dozen rapid calls and sends no Retry-After
 * header, so it gets a wider gap rather than relying on the retry to absorb it. */
const HTS_SPACING_MS = 350;
const COMTRADE_SPACING_MS = 1200;
const UA = 'Scrapemint Import Duty actor (admin@scrapemint.com)';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'duty',
    hsCodes = [],
    keyword = '',
    originCountry = '',
    shipmentValueUsd,
    forceColumn = 'auto',
    includeStatisticalLines = true,
    reporterCountry = 'US',
    partnerCountry = '',
    year,
    flow = 'M',
    maxRows = 200,
} = input;

const wantMode = ['duty', 'additionalTariffs', 'tradeFlow'].includes(mode) ? mode : 'duty';
const codes = (Array.isArray(hsCodes) ? hsCodes : [hsCodes])
    .map((c) => normalizeCode(c))
    .filter((c) => c.length >= 4);
const kw = String(keyword ?? '').trim();
const origin = String(originCountry ?? '').trim().toUpperCase();
const shipmentValue = asNum(shipmentValueUsd);
const column = ['auto', 'general', 'special', 'other'].includes(forceColumn) ? forceColumn : 'auto';

const RUN_START = Date.now();
const HARD_TIMEOUT_AT = Actor.getEnv().timeoutAt
    ? new Date(Actor.getEnv().timeoutAt).getTime()
    : RUN_START + 3600 * 1000;
const SOFT_DEADLINE_AT = HARD_TIMEOUT_AT
    - Math.min(300_000, Math.max(90_000, (HARD_TIMEOUT_AT - RUN_START) * 0.1));

/* These live above the mode dispatch on purpose. The dispatch below is a
 * top-level await, so the module body has already started executing by the
 * time the mode functions run. A `const` declared further down would still be
 * in its temporal dead zone and throw on first use, even though the functions
 * that close over it hoist fine. */
const headingCache = new Map();
const seenThisRun = new Set();
let partnerIndex;
let pushed = 0;
let stop = false;

if (wantMode === 'tradeFlow') await runTradeFlow();
else if (wantMode === 'additionalTariffs') await runAdditionalTariffs();
else await runDuty();

log.info(`Done. Pushed ${pushed} rows.`);
await Actor.exit();

// ---------- modes ----------

async function runDuty() {
    if (!codes.length && !kw) {
        log.warning('Nothing to look up: provide hsCodes, a keyword, or both.');
        return;
    }
    log.info(
        `Duty lookup | ${codes.length} code(s)${kw ? ` | keyword "${kw}"` : ''}`
        + `${origin ? ` | origin ${origin}` : ''}`
        + `${shipmentValue !== null ? ` | shipment $${shipmentValue}` : ''}`,
    );

    /* Both inputs reduce to a set of 4-digit headings, because a heading is the
     * smallest unit that carries the full indent tree needed to resolve an
     * inherited rate. Fetching per code would re-download the same heading. */
    const wanted = new Map();
    for (const c of codes) addWanted(wanted, c.slice(0, 4), c);

    if (kw) {
        const hits = await getJson(`${HTS_BASE}/search?keyword=${encodeURIComponent(kw)}`);
        const list = Array.isArray(hits) ? hits : [];
        log.info(`Keyword "${kw}" matched ${list.length} lines.`);
        for (const h of list) {
            const d = normalizeCode(h?.htsno);
            if (d.length >= 4) addWanted(wanted, d.slice(0, 4), d);
        }
    }

    for (const [heading, want] of wanted) {
        if (done()) break;
        const tree = await getHeading(heading);
        if (!tree) continue;
        for (const node of tree) {
            if (done()) break;
            if (!node.htsno) continue; // grouping header, not a tariff line
            const digits = normalizeCode(node.htsno);
            if (!want.whole && ![...want.prefixes].some((p) => digits.startsWith(p))) continue;
            if (!includeStatisticalLines && digits.length > 8) continue;
            await pushRow(toDutyRow(node), 'hts_row');
        }
        await sleep(HTS_SPACING_MS);
    }
}

async function runAdditionalTariffs() {
    /* Chapter 99 is where Section 301, Section 232 and IEEPA duties are
     * codified. It is returned in full and filtered locally: there is no
     * server-side country filter, and the country a heading applies to is
     * stated in prose in the description. */
    log.info(`Chapter 99 additional tariffs${kw ? ` | filter "${kw}"` : ''}`);
    const tree = await getHeading('9903');
    if (!tree) return;
    const needle = kw.toLowerCase();
    for (const node of tree) {
        if (done()) break;
        if (!node.htsno) continue;
        const hay = `${node.htsno} ${node.descriptionPath.join(' ')}`.toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        await pushRow(toAdditionalRow(node), 'hts_row');
    }
}

async function runTradeFlow() {
    if (!codes.length) {
        log.warning('tradeFlow mode needs at least one HS code in hsCodes.');
        return;
    }
    const partners = await getPartnerIndex();
    if (!partners) return;

    const reporter = resolveArea(partners, reporterCountry);
    if (!reporter) {
        log.warning(`Could not resolve reporter country "${reporterCountry}".`);
        return;
    }
    const partner = partnerCountry ? resolveArea(partners, partnerCountry) : null;
    if (partnerCountry && !partner) {
        log.warning(`Could not resolve partner country "${partnerCountry}".`);
        return;
    }

    const period = Number.isInteger(year) ? year : new Date().getUTCFullYear() - 2;
    const flowCode = ['M', 'X'].includes(String(flow).toUpperCase())
        ? String(flow).toUpperCase() : 'M';

    log.info(
        `Trade flows | reporter ${reporter.name} (${reporter.code})`
        + `${partner ? ` | partner ${partner.name} (${partner.code})` : ' | all partners'}`
        + ` | ${period} | flow ${flowCode} | ${codes.length} code(s)`,
    );

    for (const code of codes) {
        if (done()) break;
        /* Comtrade keys commodities at the HS-6 level. A 10-digit US statistical
         * code has no counterpart in the international dataset, so it is
         * truncated rather than queried as-is and returning nothing. */
        const cmd = code.slice(0, 6);
        const url = `${COMTRADE_BASE}?reporterCode=${reporter.code}&period=${period}`
            + `&cmdCode=${cmd}&flowCode=${flowCode}`
            + (partner ? `&partnerCode=${partner.code}` : '');
        const json = await getJson(url);
        const rows = json?.data ?? [];
        if (!rows.length) {
            log.warning(`No ${period} ${flowCode} data for HS ${cmd} reported by ${reporter.name}.`);
        }
        for (const d of rows) {
            if (done()) break;
            await pushRow(toTradeFlowRow(d, partners, reporter, cmd, code), 'trade_flow_row');
        }
        await sleep(COMTRADE_SPACING_MS);
    }
}

// ---------- shaping ----------

function toDutyRow(node) {
    const digits = normalizeCode(node.htsno);
    const g = node.resolvedGeneral;
    const o = node.resolvedOther;
    const special = node.resolvedSpecial ?? [];

    const eligible = origin ? (COUNTRY_PROGRAMS[origin] ?? []) : [];
    const matched = special.filter((s) => eligible.includes(s.programCode));

    const applied = pickColumn(g, o, matched);
    const estimate = estimateDuty(applied.rate, shipmentValue);

    return {
        htsCode: formatCode(digits),
        htsCodeDigits: digits,
        /* 4 heading, 6 international subheading, 8 US legal rate line,
         * 10 US statistical reporting line. */
        codeLevel: digits.length,
        isStatisticalLine: digits.length > 8,
        description: node.description,
        descriptionPath: node.descriptionPath,
        fullDescription: node.descriptionPath.join(' > ') || null,
        unitsOfQuantity: node.units,
        footnotes: node.footnotes,

        generalRateText: g.text,
        generalRateAdValoremPct: g.adValoremPct,
        generalRateSpecific: g.specificRateText,
        generalRateIsCompound: g.isCompound,
        generalRateSource: node.generalSource,
        generalRateInheritedFrom: node.generalFrom,

        column2RateText: o.text,
        column2RateAdValoremPct: o.adValoremPct,
        column2RateSource: node.otherSource,
        column2RateInheritedFrom: node.otherFrom,

        specialPrograms: special.length ? special : null,
        specialRateSource: node.specialSource,
        specialRateInheritedFrom: node.specialFrom,

        originCountry: origin || null,
        /* Named so it cannot be read as a ruling: the country takes part in
         * these programs. Whether this shipment qualifies turns on rules of
         * origin that the tariff schedule does not publish. */
        originEligiblePrograms: origin ? (matched.length ? matched : null) : null,
        originEligibilityCaveat: origin
            ? 'Country participates in these programs. Qualifying also requires meeting the '
              + 'agreement rules of origin, which the HTS does not publish.'
            : null,

        appliedColumn: applied.column,
        appliedRateText: applied.rate?.text ?? null,
        appliedAdValoremPct: applied.rate?.adValoremPct ?? null,

        shipmentValueUsd: shipmentValue,
        estimatedDutyUsd: estimate.usd,
        estimatedLandedCostUsd: estimate.usd !== null && shipmentValue !== null
            ? Math.round((shipmentValue + estimate.usd) * 100) / 100
            : null,
        dutyEstimateComplete: estimate.complete,
        dutyEstimateNotes: estimate.notes,

        /* Stated on every row, not just the ones with an estimate: an importer
         * comparing a general rate against an invoice needs to know this
         * number is not the whole bill. */
        excludesChapter99Tariffs: true,
        chapter99Note: 'Section 301, Section 232 and IEEPA tariffs are additional to this rate '
            + 'and are codified in Chapter 99. Run this actor in additionalTariffs mode to read them.',
        source: 'USITC Harmonized Tariff Schedule',
    };
}

function toAdditionalRow(node) {
    const digits = normalizeCode(node.htsno);
    const g = node.resolvedGeneral;
    const text = g.text ?? '';
    /* Chapter 99 rates are written as a delta on the underlying line: "The duty
     * provided in the applicable subheading + 25%". The additive percentage is
     * the number that matters, and it is not the total duty. */
    const addl = text.match(/\+\s*(\d+(?:\.\d+)?)\s*%/);
    return {
        htsCode: formatCode(digits),
        htsCodeDigits: digits,
        description: node.description,
        descriptionPath: node.descriptionPath,
        fullDescription: node.descriptionPath.join(' > ') || null,
        rateText: g.text,
        additionalAdValoremPct: addl ? Number(addl[1]) : null,
        /* "No change" and "The duty provided in the applicable subheading" both
         * mean no extra duty from this heading, which is a real zero, unlike an
         * unparsed rate where the answer is unknown. */
        isNoAdditionalDuty: /no change/i.test(text)
            || (/duty provided in the applicable subheading/i.test(text) && !addl),
        appliesOnTopOfUnderlyingRate: true,
        note: 'Applicability is defined in the US notes to Chapter 99 subchapter III, which '
            + 'list the covered subheadings and countries in prose. Read the heading text before relying on it.',
        source: 'USITC Harmonized Tariff Schedule, Chapter 99',
    };
}

function toTradeFlowRow(d, partners, reporter, cmdQueried, codeRequested) {
    const partnerName = partners.byCode.get(Number(d?.partnerCode))?.text ?? null;
    return {
        year: asNum(d?.refYear),
        period: d?.period ?? null,
        flowCode: d?.flowCode ?? null,
        flowDescription: d?.flowCode === 'M' ? 'Import' : (d?.flowCode === 'X' ? 'Export' : null),
        reporterCode: reporter.code,
        reporterName: reporter.name,
        partnerCode: asNum(d?.partnerCode),
        partnerName,
        /* Comtrade reports a "World" partner row (code 0) alongside the
         * bilateral ones. Summing the column without this flag double counts. */
        isWorldAggregate: Number(d?.partnerCode) === 0,
        hsCode: d?.cmdCode ?? cmdQueried,
        hsCodeRequested: formatCode(codeRequested),
        tradeValueUsd: asNum(d?.primaryValue),
        cifValueUsd: asNum(d?.cifvalue),
        fobValueUsd: asNum(d?.fobvalue),
        netWeightKg: asNum(d?.netWgt),
        netWeightIsEstimated: typeof d?.isNetWgtEstimated === 'boolean'
            ? d.isNetWgtEstimated : null,
        isAggregate: typeof d?.isAggregate === 'boolean' ? d.isAggregate : null,
        /* Quantity is deliberately omitted. The preview endpoint returns a
         * qtyUnitCode with no companion reference table to name it, and the
         * values include placeholder 1s. A quantity whose unit cannot be named
         * is not a fact worth billing for. */
        source: 'UN Comtrade',
    };
}

/**
 * Decide which tariff column applies.
 *
 * Column 2 is not a preference, it is a penalty rate for countries without
 * Normal Trade Relations, so it is checked before the preference columns.
 * A special rate is only offered when the origin country actually takes part
 * in a program named on the line AND that entry states a rate of its own
 * (a "See 9822.04.15" cross reference does not).
 */
function pickColumn(general, other, matchedPrograms) {
    /* A special-column entry is keyed on `rateText` because it also carries
     * program metadata. Reshape it to the same field names a general or column 2
     * rate uses, so the estimator has one shape to reason about instead of
     * silently reading `undefined` off the preference branch. */
    const asRate = (s) => ({
        text: s.rateText,
        adValoremPct: s.adValoremPct,
        specificRateText: s.specificRateText,
        isCompound: s.isCompound,
        isFree: s.isFree,
    });

    if (column === 'general') return { column: 'general', rate: general };
    if (column === 'other') return { column: 'other', rate: other };
    if (column === 'special') {
        const forced = matchedPrograms.find((s) => !s.isCrossReference);
        return forced
            ? { column: 'special', rate: asRate(forced), programCode: forced.programCode }
            : { column: 'general', rate: general };
    }

    if (origin && COLUMN_2_COUNTRIES.has(origin)) return { column: 'other', rate: other };

    /* Best available preference, judged on the ad valorem number so a Free
     * entry wins over a reduced-but-nonzero one. */
    const usable = matchedPrograms
        .filter((s) => !s.isCrossReference && s.adValoremPct !== null)
        .sort((a, b) => a.adValoremPct - b.adValoremPct)[0];
    const beatsGeneral = usable
        && (general.adValoremPct === null || usable.adValoremPct < general.adValoremPct);
    if (beatsGeneral) {
        return { column: 'special', rate: asRate(usable), programCode: usable.programCode };
    }
    return { column: 'general', rate: general };
}

/**
 * Money on a shipment, or an explicit refusal.
 *
 * The refusals matter more than the arithmetic. A specific duty is charged per
 * kilo or per pair, and this actor is not given the shipment weight or piece
 * count, so any number it produced would be made up. A compound rate has an ad
 * valorem part that CAN be computed but is only part of the bill, and quoting
 * the part as the whole understates what the importer will owe.
 */
function estimateDuty(rate, value) {
    const notes = [];
    if (value === null) return { usd: null, complete: false, notes: ['No shipmentValueUsd supplied.'] };
    if (!rate || rate.text === null) {
        return { usd: null, complete: false, notes: ['No duty rate published or inherited for this line.'] };
    }
    if (rate.adValoremPct === null) {
        return {
            usd: null,
            complete: false,
            notes: [
                `Rate "${rate.text}" is charged per unit of quantity, not on value. `
                + 'Estimating it needs the shipment weight or piece count, which this actor is not given.',
            ],
        };
    }

    const usd = Math.round(value * (rate.adValoremPct / 100) * 100) / 100;
    let complete = true;
    if (rate.isCompound) {
        complete = false;
        notes.push(
            `Rate "${rate.text}" is compound. This covers only the ${rate.adValoremPct}% `
            + `ad valorem part; the ${rate.specificRateText} per-unit part is additional.`,
        );
    }
    notes.push('Excludes Chapter 99 tariffs (Section 301, Section 232, IEEPA), merchandise '
        + 'processing fee and harbor maintenance fee.');
    return { usd, complete, notes };
}

// ---------- upstream ----------

async function getHeading(heading) {
    if (headingCache.has(heading)) return headingCache.get(heading);
    /* exportList treats `to` as an exclusive-ish bound: from=8541&to=8541
     * returns the single heading row with no children, so the next heading is
     * requested and anything outside the prefix is dropped locally. */
    const next = String(Number(heading) + 1).padStart(4, '0');
    const url = `${HTS_BASE}/exportList?from=${heading}&to=${next}&format=JSON&styles=true`;
    const raw = await getJson(url);
    if (!Array.isArray(raw)) {
        headingCache.set(heading, null);
        return null;
    }
    const scoped = raw.filter((r) => {
        const d = normalizeCode(r?.htsno);
        return d === '' || d.startsWith(heading);
    });
    const tree = buildTree(scoped);
    headingCache.set(heading, tree);
    return tree;
}

async function getPartnerIndex() {
    if (partnerIndex !== undefined) return partnerIndex;
    const json = await getJson(PARTNER_REF);
    const results = json?.results;
    if (!Array.isArray(results)) {
        log.warning('Could not load the Comtrade country reference table.');
        partnerIndex = null;
        return null;
    }
    const byCode = new Map();
    for (const r of results) byCode.set(Number(r.id), r);
    partnerIndex = { results, byCode };
    return partnerIndex;
}

/**
 * ISO2 or numeric code to a Comtrade area.
 *
 * ISO2 is not a key in this table: DE matches both 276 (Germany) and 280 (Fed.
 * Rep. of Germany ...1990), US matches 840, 841 and 842. Expired entries are
 * dropped first, then the most recently effective one wins, which picks the
 * live entity in both cases.
 */
function resolveArea(partners, wanted) {
    const w = String(wanted ?? '').trim();
    if (!w) return null;

    if (/^\d+$/.test(w)) {
        const hit = partners.byCode.get(Number(w));
        return hit ? { code: Number(w), name: hit.text } : { code: Number(w), name: null };
    }

    const up = w.toUpperCase();
    const live = partners.results.filter((r) => !r.entryExpiredDate);
    const byIso = live.filter(
        (r) => r.PartnerCodeIsoAlpha2 === up || r.PartnerCodeIsoAlpha3 === up,
    );
    const pool = byIso.length
        ? byIso
        : live.filter((r) => String(r.text ?? '').toLowerCase() === w.toLowerCase());
    if (!pool.length) return null;

    const best = pool.sort(
        (a, b) => new Date(b.entryEffectiveDate ?? 0) - new Date(a.entryEffectiveDate ?? 0),
    )[0];
    if (pool.length > 1) {
        log.info(`"${w}" matched ${pool.length} Comtrade areas; using ${best.id} (${best.text}).`);
    }
    return { code: Number(best.id), name: best.text };
}

async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': UA, Accept: 'application/json' },
            });
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) {
                log.warning(`HTTP ${res.status} for ${url}`);
                return null;
            }
            return JSON.parse(await res.text());
        } catch (err) {
            if (attempt === 3) {
                log.warning(`fetch failed for ${url}: ${err?.message}`);
                return null;
            }
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

// ---------- helpers ----------

/* A bare 4-digit request means the whole heading. That has to be sticky: if
 * "8541" and "8541430010" both arrive, the broader request wins regardless of
 * arrival order, so a set that was deliberately emptied is not refilled by a
 * later narrower code. */
function addWanted(map, heading, fullCode) {
    if (!map.has(heading)) map.set(heading, { whole: false, prefixes: new Set() });
    const entry = map.get(heading);
    if (fullCode.length <= 4) {
        entry.whole = true;
        entry.prefixes.clear();
    } else if (!entry.whole) {
        entry.prefixes.add(fullCode);
    }
}

function done() {
    if (stop) return true;
    if (pushed >= maxRows) return true;
    if (Date.now() > SOFT_DEADLINE_AT) {
        log.warning('Run-time budget reached; finishing with partial results.');
        stop = true;
        return true;
    }
    return false;
}

async function pushRow(row, eventName) {
    const key = `${eventName}:${row.htsCode ?? ''}:${row.partnerCode ?? ''}:${row.year ?? ''}`;
    if (seenThisRun.has(key)) return;
    seenThisRun.add(key);

    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        await Actor.charge({ eventName })
            .catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
    if (pushed % 50 === 0) log.info(`Pushed ${pushed} rows...`);
}

/* Absent stays null. Number(null) is 0 and a 0 duty rate, trade value or
 * weight is a specific claim that an importer would act on. */
function asNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
