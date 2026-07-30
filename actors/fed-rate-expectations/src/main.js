// Fed Rate Expectations: Meeting Odds and Rate Path
//
// What it does
// ------------
// What the market thinks the Federal Reserve will do next, priced from
// 30 Day Federal Funds futures rather than opinion.
//
//   meetings  one row per upcoming FOMC meeting: the rate the market implies
//             coming out of it, the move in basis points, and the odds of a
//             hike, a hold or a cut
//   path      one row per contract month: the average fed funds rate the
//             market is paying for, and how far it sits from today
//   shift     the same implied path against an earlier trade date, so you can
//             see which meetings repriced and by how much
//
// Three keyless sources, all read from a datacenter with no proxy:
//   CME 30 Day Federal Funds futures settlements (product 305, CBOT)
//   FRED for the effective rate and the current target range
//   federalreserve.gov for the FOMC meeting calendar
//
// Pay per event
// -------------
//   rate_row ($0.008) charged per row pushed. First 2 rows per run are free.
//   Note rows are never charged.

import { Actor, log } from 'apify';
import { num, metric } from './numeric-helpers.js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 500;
const FETCH_TIMEOUT_MS = 25000;
// The two data hosts want opposite things and neither header can be shared.
// The exchange serves a browser and refuses a wildcard Accept; the research
// database stalls a browser User-Agent until it times out and answers a
// self-identifying one immediately.
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA_BOT = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const CME_SETTLEMENTS = 'https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements';
const FED_FUNDS_PRODUCT_ID = 305; // 30 Day Federal Funds Futures, CBOT
const FOMC_CALENDAR = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
// A policy move is announced in 25 basis point steps, which is what makes an
// implied change convertible into odds at all.
const STEP_BP = 25;
// Below this open interest a contract is barely traded and the rate it implies
// is not a market view worth quoting as one.
const THIN_OPEN_INTEREST = 5000;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs !== null && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'meetings',
    tradeDate = '',
    compareDaysBack = 5,
    includeThinContracts = false,
    maxRows = 50,
} = input;

const theMode = ['meetings', 'path', 'shift'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'meetings';
const rowCap = Math.min(Math.max(Number(maxRows) || 50, 1), HARD_CAP);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pushed = 0;
let charged = 0;
let noteCount = 0;

async function pushNote(message, extra = {}) {
    noteCount += 1;
    log.info(`NOTE: ${message}`);
    await Actor.pushData({ recordType: 'note', note: message, ...extra });
}

async function pushRow(row) {
    if (pushed >= rowCap) return false;
    await Actor.pushData(row);
    pushed += 1;
    if (pushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'rate_row' });
            charged += 1;
        } catch (err) {
            log.warning(`charge failed: ${err?.message || err}`);
        }
    }
    return true;
}

/**
 * Fetch with a per host Accept header and a retry policy that knows the
 * difference between "try again" and "no".
 *
 * The exchange's WAF reads the Accept header: asking for json, csv, html and
 * a wildcard together returns 403, while asking for `application/json` alone
 * returns the report, from the same address in the same minute. Each caller
 * therefore states the one type it actually wants.
 *
 * Retrying is reserved for failures that can pass: network errors, 429 and
 * 5xx. A 403 or 404 is a decision, and hammering it eight dates deep times
 * three attempts turned a single refusal into 24 requests and an 80 second
 * run that cost more than the rows it failed to return.
 */
async function fetchText(url, { accept = 'application/json', ua = UA_BROWSER, attempts = 3 } = {}) {
    for (let a = 1; a <= attempts; a++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': ua, accept },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) return { text: await res.text() };
            const retryable = res.status === 429 || res.status >= 500;
            if (!retryable) return { error: `HTTP ${res.status}`, status: res.status, permanent: true };
            if (a === attempts) return { error: `HTTP ${res.status}`, status: res.status };
        } catch (err) {
            if (a === attempts) return { error: String(err?.message || err) };
        }
        await sleep(900 * a);
    }
    return { error: 'unreachable' };
}

async function fetchJson(url, opts = {}) {
    const res = await fetchText(url, { accept: 'application/json', ...opts });
    if (res.error) return res;
    try {
        return { data: JSON.parse(res.text) };
    } catch {
        // An unknown product id answers with an HTML body rather than a JSON
        // error, so a bad id and a broken host must not read the same.
        return { error: 'the response was not JSON, which is how this host reports an unknown product', permanent: true };
    }
}

// ---------------------------------------------------------------------------
// FOMC calendar
// ---------------------------------------------------------------------------

/**
 * Scheduled FOMC meetings, newest first in the page, with the DECISION day.
 *
 * Two shapes in this page break a naive parser, and both change which futures
 * contract a move lands in:
 *   "Apr/May" + "30-1"   a meeting that straddles two months. The decision is
 *                        on 1 May, not 30 April, so the month cell alone files
 *                        it under the wrong contract entirely.
 *   "August" + "22 (notation vote)"
 *                        a notation vote, which is not a scheduled policy
 *                        meeting with a rate decision, and is excluded.
 */
function parseFomcCalendar(html) {
    const flat = html.replace(/\s+/g, ' ');
    const meetings = [];
    const yearRe = /(20\d\d) FOMC Meetings/g;
    const marks = [];
    let m;
    while ((m = yearRe.exec(flat)) !== null) marks.push({ year: Number(m[1]), at: m.index });
    const rowRe = /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>.*?fomc-meeting__date[^>]*>([^<]+)</g;

    for (let i = 0; i < marks.length; i++) {
        const seg = flat.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : flat.length);
        rowRe.lastIndex = 0;
        let r;
        while ((r = rowRe.exec(seg)) !== null) {
            const monthCell = r[1].trim();
            const dateCell = r[2].trim();
            if (/notation vote/i.test(dateCell)) continue;

            const hasProjections = dateCell.includes('*');
            const clean = dateCell.replace(/\*/g, '').replace(/\(.*?\)/g, '').trim();
            const days = clean.split(/[-–]/).map((s) => s.trim()).filter(Boolean);
            const decisionDay = Number(days[days.length - 1]);
            if (!Number.isFinite(decisionDay)) continue;

            // "Apr/May" means the meeting ends in the SECOND month named.
            const parts = monthCell.split('/').map((s) => s.trim().toLowerCase());
            const lastPart = parts[parts.length - 1];
            const monthIndex = MONTH_NAMES[lastPart] ?? MONTH_ABBR[lastPart.slice(0, 4)] ?? MONTH_ABBR[lastPart.slice(0, 3)];
            if (monthIndex === undefined) continue;

            // A meeting that starts in December and ends in January belongs to
            // the following year.
            let year = marks[i].year;
            const firstPart = parts[0];
            const firstIndex = MONTH_NAMES[firstPart] ?? MONTH_ABBR[firstPart.slice(0, 3)];
            if (parts.length > 1 && firstIndex !== undefined && firstIndex > monthIndex) year += 1;

            meetings.push({
                decisionDate: new Date(Date.UTC(year, monthIndex, decisionDay)),
                year,
                monthIndex,
                decisionDay,
                spansTwoMonths: parts.length > 1,
                hasProjections,
                sourceLabel: `${monthCell} ${dateCell}`,
            });
        }
    }
    meetings.sort((a, b) => a.decisionDate - b.decisionDate);
    return meetings;
}

// ---------------------------------------------------------------------------
// Futures settlements
// ---------------------------------------------------------------------------

const fmtDate = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;

// Settlements publish after the close, so today returns an empty report during
// the session, and weekends and holidays return the same. Walk back for the
// newest date that actually has data.
async function loadSettlements(startDate, maxBack = 8) {
    for (let i = 0; i < maxBack; i++) {
        if (pastDeadline()) break;
        const d = new Date(startDate.getTime() - i * 86400000);
        const url = `${CME_SETTLEMENTS}/${FED_FUNDS_PRODUCT_ID}/FUT?tradeDate=${encodeURIComponent(fmtDate(d))}&strategy=DEFAULT`;
        const res = await fetchJson(url);
        // A refusal will not become an acceptance on an older trade date, so
        // the walk stops rather than repeating it for every day it would try.
        if (res.error && res.permanent) return { error: res.error, permanent: true };
        if (res.error) return { error: res.error };
        const rows = res.data?.settlements || [];
        const real = rows.filter((x) => String(x.month || '').toUpperCase() !== 'TOTAL');
        if (real.length) {
            return {
                tradeDate: res.data.tradeDate || fmtDate(d),
                reportType: res.data.reportType || null,
                updateTime: res.data.updateTime || null,
                // The final row is a "Total" carrying the whole product's
                // volume and open interest. Emitting it invents an expiry that
                // does not exist and double counts the day's volume.
                contracts: real.map(parseContract).filter((c) => c.impliedRatePercent !== null),
            };
        }
        await sleep(200);
    }
    return { error: 'no settlement report with data in the last 8 days' };
}

// "-" means no value while "" coerces to 0, and UNCH is a legitimate zero.
function cleanNumber(v) {
    const s = String(v ?? '').trim();
    if (s === '' || s === '-') return null;
    if (/^unch$/i.test(s)) return 0;
    return num(s.replace(/[A-Za-z]$/, '').replace(/,/g, ''));
}

function parseContract(row) {
    const settle = cleanNumber(row.settle);
    const label = String(row.month || '').trim().toUpperCase();
    const m = /^([A-Z]{3})\s*(\d{2})$/.exec(label);
    let year = null;
    let monthIndex = null;
    if (m) {
        monthIndex = MONTHS.indexOf(m[1]);
        year = 2000 + Number(m[2]);
        if (monthIndex === -1) monthIndex = null;
    }
    return {
        contractMonth: label,
        year,
        monthIndex,
        settle,
        // A fed funds future settles to 100 minus the AVERAGE effective rate
        // over the contract month, which is why a month holding a meeting
        // cannot be read as a single rate.
        impliedRatePercent: settle === null ? null : metric(100 - settle, 4),
        openInterest: cleanNumber(row.openInterest),
        volume: cleanNumber(row.volume),
        change: cleanNumber(row.change),
    };
}

// ---------------------------------------------------------------------------
// FRED anchor
// ---------------------------------------------------------------------------

// FRED wants the opposite of the exchange: a wildcard Accept works and a
// narrow `text/csv` does not. The two hosts pull in different directions, so
// neither header can be shared.
async function loadFredSeries(id, sinceDays = 30) {
    const start = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
    const res = await fetchText(`${FRED_CSV}?id=${encodeURIComponent(id)}&cosd=${start}`, { accept: '*/*', ua: UA_BOT });
    if (res.error) return { error: res.error };
    const lines = res.text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
        const [date, value] = lines[i].split(',');
        // A holiday inside a daily series returns an EMPTY value rather than a
        // missing row, and Number('') is 0, which would publish a zero rate.
        const v = cleanNumber(value);
        if (v !== null) return { date: (date || '').trim(), value: v };
    }
    return { error: `no observation with a value in the last ${sinceDays} days` };
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * Turn an implied change into odds over 25 basis point steps.
 *
 * A change of 7.5bp is not "a 7.5bp hike"; no such move exists. It is the
 * market pricing roughly a 30% chance of a single 25bp hike and a 70% chance
 * of no move at all. A change beyond one step splits across the two adjacent
 * whole moves.
 */
function outcomeOdds(changeBp) {
    if (changeBp === null) return null;
    const dir = changeBp >= 0 ? 1 : -1;
    const magnitude = Math.abs(changeBp);
    const lower = Math.floor(magnitude / STEP_BP);
    const frac = (magnitude - lower * STEP_BP) / STEP_BP;
    const label = (steps) => {
        if (steps === 0) return 'hold';
        return `${dir > 0 ? '+' : '-'}${steps * STEP_BP}bp`;
    };
    const odds = [];
    if (frac > 0.0001) {
        odds.push({ outcome: label(lower), probabilityPercent: metric((1 - frac) * 100, 1) });
        odds.push({ outcome: label(lower + 1), probabilityPercent: metric(frac * 100, 1) });
    } else {
        odds.push({ outcome: label(lower), probabilityPercent: 100 });
    }
    return odds.sort((a, b) => b.probabilityPercent - a.probabilityPercent);
}

// A meeting-month solve divides by the days LEFT in the month, so a decision
// on the 28th of a 30 day month divides by 2 and multiplies any error in the
// inputs about fifteen times. Chained across meetings that compounds into
// nonsense: an early version produced a -1.47% policy rate and a +796bp move.
// Below this many remaining days the solve is not trusted.
const MIN_DAYS_AFTER_DECISION = 5;

/**
 * Chain the meetings through the futures curve.
 *
 * A contract prices the AVERAGE effective rate over its month, so a month
 * holding a decision on day D of N is a blend of the old and new rates:
 *
 *   avg = (D * before + (N - D) * after) / N
 *
 * There are two ways to recover the post-meeting rate, and preferring the
 * right one is what keeps the chain stable:
 *
 *   1. A CLEAN month, one with no meeting in it, prices a single constant
 *      rate. When the month straight after a decision is clean, its implied
 *      average IS the post-meeting rate, with no division and nothing to
 *      amplify. This is used wherever it exists.
 *   2. Otherwise solve the blend above, but only when enough days remain
 *      after the decision for the answer to mean anything.
 */
function buildMeetingPath(contracts, meetings, anchorRatePercent) {
    const byKey = new Map();
    for (const c of contracts) {
        if (c.year !== null && c.monthIndex !== null) byKey.set(`${c.year}-${c.monthIndex}`, c);
    }
    const monthHasMeeting = new Set(meetings.map((m) => `${m.year}-${m.monthIndex}`));
    const nextMonth = (year, monthIndex) => (monthIndex === 11 ? { year: year + 1, monthIndex: 0 } : { year, monthIndex: monthIndex + 1 });

    const out = [];
    let before = anchorRatePercent;
    const now = Date.now();
    const upcoming = meetings.filter((m) => m.decisionDate.getTime() >= now - 86400000);

    for (const meeting of upcoming) {
        const key = `${meeting.year}-${meeting.monthIndex}`;
        const contract = byKey.get(key) || null;
        const push = (after, method, unresolved) => {
            const changeBp = after === null ? null : (after - before) * 100;
            out.push({ meeting, contract, before, after, changeBp, method, unresolved });
            if (after !== null) before = after;
        };

        if (upcoming.filter((x) => `${x.year}-${x.monthIndex}` === key).length > 1) {
            // One monthly average cannot separate two decisions in that month.
            push(null, null, 'two meetings fall in this contract month, which a single monthly average cannot separate');
            continue;
        }

        // Route 1: the month after the decision carries no meeting, so it
        // prices the new rate outright.
        const nm = nextMonth(meeting.year, meeting.monthIndex);
        const nmKey = `${nm.year}-${nm.monthIndex}`;
        const nmContract = byKey.get(nmKey);
        if (!monthHasMeeting.has(nmKey) && nmContract && nmContract.impliedRatePercent !== null) {
            push(nmContract.impliedRatePercent, 'clean month after the decision', null);
            continue;
        }

        // Route 2: solve the blend, if the remaining days can carry it.
        if (!contract || contract.impliedRatePercent === null) {
            push(null, null, 'no settled contract for this meeting month, and the month after it also holds a meeting');
            continue;
        }
        const N = daysInMonth(meeting.year, meeting.monthIndex);
        const D = Math.min(meeting.decisionDay, N);
        const daysAfter = N - D;
        if (daysAfter < MIN_DAYS_AFTER_DECISION) {
            push(null, null, `the decision falls with only ${daysAfter} day(s) left in the contract month, too few to separate the new rate from the old one, and the following month also holds a meeting`);
            continue;
        }
        const after = (contract.impliedRatePercent * N - D * before) / daysAfter;
        // A solved rate outside any plausible policy range means an input was
        // wrong; publishing it as an expectation would be worse than saying so.
        if (!Number.isFinite(after) || after < -1 || after > 25) {
            push(null, null, 'the implied rate solved to an implausible value, so the inputs for this meeting do not agree');
            continue;
        }
        push(after, `blend of ${D} day(s) at the old rate and ${daysAfter} at the new`, null);
    }
    return out;
}

// ---------------------------------------------------------------------------

async function gatherInputs(forDate) {
    const [calendar, effr, targetUpper, targetLower] = await Promise.all([
        fetchText(FOMC_CALENDAR, { accept: 'text/html' }),
        loadFredSeries('EFFR', 21),
        loadFredSeries('DFEDTARU', 45),
        loadFredSeries('DFEDTARL', 45),
    ]);
    if (calendar.error) return { error: `could not read the FOMC calendar: ${calendar.error}` };
    const meetings = parseFomcCalendar(calendar.text);
    if (!meetings.length) return { error: 'the FOMC calendar returned no meetings, so its page layout has probably changed' };

    const settlements = await loadSettlements(forDate);
    if (settlements.error) return { error: `could not read fed funds futures settlements: ${settlements.error}` };

    // The futures settle against the EFFECTIVE rate, which trades a few basis
    // points below the top of the target range. Anchoring on the target
    // midpoint instead would shift every probability in the run.
    const anchor = effr.error ? null : effr.value;
    const midpoint = targetUpper.error || targetLower.error ? null : metric((targetUpper.value + targetLower.value) / 2, 4);
    return {
        meetings,
        settlements,
        anchorRatePercent: anchor ?? midpoint,
        anchorProblem: anchor === null ? `EFFR: ${effr.error || 'no value'}; target range: ${targetUpper.error || targetLower.error || 'no value'}` : null,
        anchorSource: anchor !== null ? 'effective federal funds rate (FRED EFFR)' : 'target range midpoint (FRED DFEDTARU/DFEDTARL)',
        anchorIsEffective: anchor !== null,
        anchorDate: effr.error ? (targetUpper.date || null) : effr.date,
        targetUpperPercent: targetUpper.error ? null : targetUpper.value,
        targetLowerPercent: targetLower.error ? null : targetLower.value,
        targetMidpointPercent: midpoint,
    };
}

function contractConfidence(contract) {
    const oi = contract?.openInterest ?? null;
    return {
        openInterest: oi,
        volume: contract?.volume ?? null,
        // Far dated contracts thin out fast: the front months carry hundreds of
        // thousands of lots while a contract a year out can carry a few hundred.
        isThinlyTraded: oi === null ? null : oi < THIN_OPEN_INTEREST,
    };
}

async function runMeetings(ctx) {
    const path = buildMeetingPath(ctx.settlements.contracts, ctx.meetings, ctx.anchorRatePercent);
    if (!path.length) {
        await pushNote('No upcoming FOMC meetings were found in the calendar.');
        return;
    }
    let emitted = 0;
    for (const step of path) {
        const conf = contractConfidence(step.contract);
        if (!includeThinContracts && conf.isThinlyTraded === true && step.changeBp !== null) continue;
        const changeBp = step.changeBp === null ? null : metric(step.changeBp, 1);
        const odds = outcomeOdds(changeBp);
        const ok = await pushRow({
            recordType: 'meeting',
            meetingDate: step.meeting.decisionDate.toISOString().slice(0, 10),
            meetingLabel: step.meeting.sourceLabel,
            meetingSpansTwoMonths: step.meeting.spansTwoMonths,
            hasEconomicProjections: step.meeting.hasProjections,
            daysUntilMeeting: Math.round((step.meeting.decisionDate.getTime() - Date.now()) / 86400000),
            rateBeforePercent: metric(step.before, 4),
            impliedRateAfterPercent: step.after === null ? null : metric(step.after, 4),
            impliedChangeBasisPoints: changeBp,
            impliedChangeMeasured: changeBp !== null,
            outcomeOdds: odds,
            mostLikelyOutcome: odds ? odds[0].outcome : null,
            mostLikelyProbabilityPercent: odds ? odds[0].probabilityPercent : null,
            unresolvedReason: step.unresolved,
            contractMonth: step.contract?.contractMonth ?? null,
            contractImpliedAverageRatePercent: step.contract?.impliedRatePercent ?? null,
            ...conf,
            currentTargetUpperPercent: ctx.targetUpperPercent,
            currentTargetLowerPercent: ctx.targetLowerPercent,
            currentTargetMidpointPercent: ctx.targetMidpointPercent,
            anchorRatePercent: metric(ctx.anchorRatePercent, 4),
            anchorSource: ctx.anchorSource,
            anchorObservedOn: ctx.anchorDate,
            settlementTradeDate: ctx.settlements.tradeDate,
            settlementReportType: ctx.settlements.reportType,
            source: 'CME 30 Day Federal Funds futures, FRED, federalreserve.gov',
            retrievedAt: new Date().toISOString(),
        });
        if (!ok) break;
        emitted += 1;
    }
    if (!emitted) await pushNote('Every upcoming meeting resolved to a thinly traded contract. Switch on thin contracts to see them anyway.');
}

async function runPath(ctx) {
    const rows = ctx.settlements.contracts.filter((c) => c.impliedRatePercent !== null);
    if (!rows.length) {
        await pushNote('The settlement report held no priced contract months.');
        return;
    }
    for (const c of rows) {
        if (!includeThinContracts && (c.openInterest ?? 0) < THIN_OPEN_INTEREST) continue;
        const diffBp = metric((c.impliedRatePercent - ctx.anchorRatePercent) * 100, 1);
        const ok = await pushRow({
            recordType: 'contract_month',
            contractMonth: c.contractMonth,
            settlementPrice: c.settle,
            impliedAverageRatePercent: c.impliedRatePercent,
            basisPointsVersusToday: diffBp,
            // Expressed in whole moves because that is the unit a decision
            // comes in. It counts moves priced by then, not at one meeting.
            movesPricedByThen: diffBp === null ? null : metric(diffBp / STEP_BP, 2),
            direction: diffBp === null ? null : diffBp > 0 ? 'tightening' : diffBp < 0 ? 'easing' : 'unchanged',
            ...contractConfidence(c),
            anchorRatePercent: metric(ctx.anchorRatePercent, 4),
            anchorSource: ctx.anchorSource,
            settlementTradeDate: ctx.settlements.tradeDate,
            settlementReportType: ctx.settlements.reportType,
            source: 'CME 30 Day Federal Funds futures, FRED',
            retrievedAt: new Date().toISOString(),
        });
        if (!ok) break;
    }
}

async function runShift(ctx) {
    // The exchange serves only about the last week of settlement reports:
    // probing from a fixed date, 24 July answered and 22 July did not, six
    // days before the run. A comparison further back than that cannot be
    // built from this source at all, so the input is capped rather than
    // offering a window that always comes back empty.
    const back = Math.min(Math.max(Number(compareDaysBack) || 5, 1), 10);
    const past = await loadSettlements(new Date(Date.now() - back * 86400000), 4);
    if (past.error) {
        await pushNote(`No settlement report was available around ${back} day(s) ago. The exchange keeps only about the last week of reports, so try a smaller number of days. (${past.error})`);
        return;
    }
    const then = new Map(past.contracts.map((c) => [c.contractMonth, c]));
    let emitted = 0;
    for (const c of ctx.settlements.contracts) {
        const before = then.get(c.contractMonth);
        if (!before || before.impliedRatePercent === null || c.impliedRatePercent === null) continue;
        if (!includeThinContracts && (c.openInterest ?? 0) < THIN_OPEN_INTEREST) continue;
        const moveBp = metric((c.impliedRatePercent - before.impliedRatePercent) * 100, 1);
        const ok = await pushRow({
            recordType: 'repricing',
            contractMonth: c.contractMonth,
            impliedRateThenPercent: before.impliedRatePercent,
            impliedRateNowPercent: c.impliedRatePercent,
            repricedBasisPoints: moveBp,
            repricedMeasured: moveBp !== null,
            direction: moveBp === null ? null : moveBp > 0 ? 'more tightening priced' : moveBp < 0 ? 'more easing priced' : 'unchanged',
            comparedTradeDate: past.tradeDate,
            settlementTradeDate: ctx.settlements.tradeDate,
            ...contractConfidence(c),
            source: 'CME 30 Day Federal Funds futures',
            retrievedAt: new Date().toISOString(),
        });
        if (!ok) break;
        emitted += 1;
    }
    if (!emitted) await pushNote(`No contract month appears in both the current report and the one near ${back} days ago.`);
}

process.on('unhandledRejection', (err) => log.exception(err instanceof Error ? err : new Error(String(err)), 'Unhandled rejection'));
process.on('uncaughtException', (err) => log.exception(err, 'Uncaught exception'));

try {
    log.info(`Mode: ${theMode}, row cap ${rowCap}`);
    let forDate = new Date();
    if (String(tradeDate).trim()) {
        const parsed = Date.parse(`${String(tradeDate).trim()}T00:00:00Z`);
        if (Number.isFinite(parsed)) forDate = new Date(parsed);
        else await pushNote(`Could not read "${tradeDate}" as a date, so the newest published report was used instead.`);
    }
    const ctx = await gatherInputs(forDate);
    if (ctx.error) {
        await pushNote(ctx.error);
    } else if (ctx.anchorRatePercent === null) {
        await pushNote(`Neither the effective rate nor the target range could be read, and every figure here is measured against one of them. Reason: ${ctx.anchorProblem || 'unknown'}`);
    } else {
        if (theMode === 'meetings') await runMeetings(ctx);
        else if (theMode === 'path') await runPath(ctx);
        else await runShift(ctx);
    }
} catch (err) {
    log.exception(err, 'Run failed');
    await pushNote(`The run stopped early: ${String(err?.message || err)}`);
}

log.info(`Pushed ${pushed} rows (${charged} charged, ${noteCount} free notes).`);
await Actor.exit();
