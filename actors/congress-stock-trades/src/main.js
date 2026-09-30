// Congress Stock Trades Tracker: every House member trade from STOCK Act filings
//
// Strategy
// --------
// Members of the House must report each trade over $1,000 in a Periodic
// Transaction Report (PTR) within 45 days. The Clerk publishes:
//   1. a yearly index, {YEAR}FD.zip, one line per filing (member, district,
//      filing type, filing date, document id), and
//   2. each PTR as a PDF at /ptr-pdfs/{YEAR}/{DocID}.pdf.
// We read the index, keep PTRs filed inside the window, filter on member,
// state and party before downloading anything, then parse each PDF into one
// row per trade (see ptr-parser.js). Party, bioguide id and committee seats
// come from the Clerk's own MemberData.xml.
//
// All three sources are official, public and keyless: no browser, no proxy.
// Handwritten paper filings are scanned images with no text; they are returned
// as a free row linking the PDF, never guessed at.
//
// Built for schedules: filings already returned are remembered (per filter
// set, in a named store in the buyer's account), so each run returns only new
// filings. Set onlyNew=false to get everything in the window again.
//
// Pay per event
// -------------
//   trade_row          ($0.01) one trade
//   notable_trade_row  ($0.03) a trade worth attention: $50,001 or more, a
//                      stock option, or disclosed after the 45-day deadline
// No per-run free allowance (a poller); a run with no new filings is free.

import { Actor, log } from 'apify';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { parsePtr } from './ptr-parser.js';

const CLERK = 'https://disclosures-clerk.house.gov/public_disc';
const LATE_DAYS = 45;
const NOTABLE_MIN = 50001;
const FETCH_TIMEOUT_MS = 30000;
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (compatible; ScrapemintCongressTrades/1.0)';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    lookbackDays = 30,
    members = [],
    states = [],
    parties = [],
    tickers = [],
    transactionTypes = [],
    assetTypes = [],
    minAmount = 0,
    includeSpouseAndJoint = true,
    onlyNew = true,
    includeScanned = true,
    maxTrades = 500,
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const memberQ = listOf(members).map((m) => m.toLowerCase());
const stateQ = new Set(listOf(states).map((s) => s.toUpperCase()));
const partyQ = new Set(listOf(parties).map((p) => p[0].toUpperCase()));
const tickerQ = new Set(listOf(tickers).map((t) => t.toUpperCase().replace(/^\$/, '')));
const typeQ = new Set(listOf(transactionTypes).map((t) => t.toLowerCase()));
const assetQ = new Set(listOf(assetTypes).map((t) => t.toUpperCase()));
const tradeCap = Math.max(1, Number(maxTrades) || 500);
const days = Math.max(1, Math.min(3650, Number(lookbackDays) || 30));
const since = new Date(Date.now() - days * 86400000);

async function get(url, as = 'text') {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

// ---------- Members: party, bioguide, committees ----------

const membersByDistrict = new Map();
try {
    const xml = await get('https://clerk.house.gov/xml/lists/MemberData.xml');
    const committees = new Map();
    for (const m of xml.matchAll(/<committee [^>]*comcode="([A-Z0-9]+)"[^>]*>\s*<committee-fullname>([^<]+)<\/committee-fullname>/g)) committees.set(m[1], decode(m[2]));
    for (const m of xml.matchAll(/<member>([\s\S]*?)<\/member>/g)) {
        const b = m[1];
        const tag = (t) => decode((b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '') || null;
        const sd = tag('statedistrict');
        if (!sd) continue;
        const coms = [...b.matchAll(/<committee comcode="([A-Z0-9]+)"/g)].map((c) => committees.get(c[1])).filter(Boolean);
        membersByDistrict.set(sd, {
            name: tag('official-name'), party: tag('party'), bioguideId: tag('bioguideID'),
            lastName: tag('lastname'), committees: [...new Set(coms)],
        });
    }
    log.info(`Loaded ${membersByDistrict.size} House members and ${committees.size} committees.`);
} catch (err) {
    log.warning(`Member list unavailable, party and committees will be blank: ${err?.message}`);
}

function decode(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

// ---------- Filing index ----------

const years = [];
for (let y = since.getUTCFullYear(); y <= new Date().getUTCFullYear(); y += 1) years.push(y);
const filings = [];
for (const year of years) {
    let zip;
    try { zip = await get(`${CLERK}/financial-pdfs/${year}FD.zip`, 'bytes'); } catch (err) { log.warning(`Index ${year} unavailable: ${err?.message}`); continue; }
    const files = unzipSync(new Uint8Array(zip));
    const txt = Object.entries(files).find(([n]) => n.endsWith('.txt'));
    if (!txt) continue;
    for (const line of strFromU8(txt[1]).split(/\r?\n/).slice(1)) {
        const [prefix, last, first, suffix, type, stateDst, yr, filed, docId] = line.split('\t');
        if (type !== 'P' || !docId) continue;
        const [mm, dd, yyyy] = String(filed).split('/');
        const filedAt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (Number.isNaN(filedAt.getTime()) || filedAt < since) continue;
        filings.push({
            docId: docId.trim(), year: Number(yr) || year, stateDst: (stateDst || '').trim(),
            filedAt, indexName: [first, last, suffix].map((s) => (s || '').trim()).filter(Boolean).join(' '),
            lastName: (last || '').trim(),
        });
    }
}

// Filter on who before downloading any PDF.
const who = filings.filter((f) => {
    const m = membersByDistrict.get(f.stateDst);
    if (stateQ.size && !stateQ.has(f.stateDst.slice(0, 2))) return false;
    if (partyQ.size && !partyQ.has(m?.party || '?')) return false;
    if (memberQ.length) {
        const hay = `${f.indexName} ${m?.name || ''}`.toLowerCase();
        if (!memberQ.some((q) => hay.includes(q))) return false;
    }
    return true;
}).sort((a, b) => b.filedAt - a.filedAt);

// State is kept per filter set, so a second schedule with other filters
// does not inherit the first one's history.
const filterKey = createHash('sha1').update(JSON.stringify({ memberQ, stateQ: [...stateQ], partyQ: [...partyQ], tickerQ: [...tickerQ], typeQ: [...typeQ], assetQ: [...assetQ], minAmount, includeSpouseAndJoint })).digest('hex').slice(0, 12);
const store = await Actor.openKeyValueStore('congress-stock-trades-state');
const stateName = `SEEN_${filterKey}`;
const seen = new Set((onlyNew && (await store.getValue(stateName))) || []);
// Filings cut off by maxTrades or the buyer's cost limit: how many of their
// matching trades were already returned, so the next run resumes after them
// instead of returning (and billing) those rows twice.
const partial = (onlyNew && (await store.getValue(`PARTIAL_${filterKey}`))) || {};
const firstRun = onlyNew && seen.size === 0;
const todo = who.filter((f) => !seen.has(f.docId));
log.info(`${filings.length} trade report(s) filed since ${since.toISOString().slice(0, 10)}; ${who.length} match the member filters; ${todo.length} not returned before.`);

// ---------- Parse and emit ----------

let trades = 0;
let charged = 0;
let scanned = 0;
let parseErrors = 0;
let stopped = false;
const done = [];

function keep(t) {
    if (!includeSpouseAndJoint && t.owner !== 'Self') return false;
    if (tickerQ.size && !tickerQ.has(t.ticker || '')) return false;
    if (assetQ.size && !assetQ.has(t.assetTypeCode || '')) return false;
    if (typeQ.size) {
        const k = t.transactionType.toLowerCase();
        const want = [...typeQ].some((q) => (q.startsWith('p') && k === 'purchase') || (q.startsWith('s') && k.includes('sale')) || (q.startsWith('e') && k === 'exchange'));
        if (!want) return false;
    }
    if (minAmount && (t.amountMax ?? t.amountMin ?? 0) < minAmount) return false;
    return true;
}

async function handle(f) {
    const url = `${CLERK}/ptr-pdfs/${f.year}/${f.docId}.pdf`;
    const m = membersByDistrict.get(f.stateDst);
    const who = {
        member: m?.name || f.indexName,
        party: m?.party || null,
        state: f.stateDst.slice(0, 2) || null,
        district: f.stateDst || null,
        bioguideId: m?.bioguideId || null,
        committees: m?.committees || [],
    };
    let parsed;
    try {
        parsed = await parsePtr(await get(url, 'bytes'));
    } catch (err) {
        parseErrors += 1;
        log.warning(`${f.docId}: ${err?.message}`);
        return; // not marked done, so the next run retries it
    }
    const filingDate = f.filedAt.toISOString().slice(0, 10);
    if (parsed.scanned) {
        scanned += 1;
        // Only worth returning when no trade filter could exclude it unseen.
        if (includeScanned && !tickerQ.size && !assetQ.size && !typeQ.size && !minAmount) {
            await Actor.pushData({
                rowType: 'scanned-filing', ...who, filingId: f.docId, filingDate, filingUrl: url,
                note: 'Handwritten paper filing with no text layer; open the PDF for its trades. Not charged.',
            });
        }
        done.push(f.docId);
        return;
    }
    const kept = parsed.transactions.filter(keep);
    let i = Number(partial[f.docId]) || 0;
    for (; i < kept.length; i += 1) {
        // Reserve the slot before any await, so parallel workers cannot overshoot the cap.
        if (stopped || trades >= tradeCap) { stopped = true; break; }
        trades += 1;
        const t = kept[i];
        const daysToDisclose = t.transactionDate
            ? Math.round((Date.parse(filingDate) - Date.parse(t.transactionDate)) / 86400000) : null;
        const reasons = [];
        if ((t.amountMin ?? 0) >= NOTABLE_MIN) reasons.push('large');
        if (t.assetTypeCode === 'OP') reasons.push('option');
        if (daysToDisclose !== null && daysToDisclose > LATE_DAYS) reasons.push('late');
        await Actor.pushData({
            ...who,
            ...t,
            filingId: f.docId,
            filingDate,
            daysToDisclose,
            lateDisclosure: daysToDisclose !== null && daysToDisclose > LATE_DAYS,
            notable: reasons.length > 0,
            notableReasons: reasons,
            filingUrl: url,
            scrapedAt: new Date().toISOString(),
        });
        try {
            const r = await Actor.charge({ eventName: reasons.length ? 'notable_trade_row' : 'trade_row' });
            charged += 1;
            if (r?.eventChargeLimitReached) { stopped = true; log.warning('Maximum cost per run reached; stopping.'); }
        } catch (err) {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }
    }
    if (i >= kept.length) { done.push(f.docId); delete partial[f.docId]; }
    else partial[f.docId] = i;
}

let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (!stopped && cursor < todo.length) await handle(todo[cursor++]);
}));

if (onlyNew) {
    await store.setValue(stateName, [...new Set([...seen, ...done])].slice(-20000));
    await store.setValue(`PARTIAL_${filterKey}`, partial);
}

if (trades === 0 && (firstRun || !onlyNew)) {
    await Actor.pushData({
        rowType: 'note',
        note: `No trades matched in House filings from the last ${days} day(s) (${who.length} report(s) checked). `
            + 'Widen lookbackDays or loosen the filters. The Senate is not covered: its disclosure site blocks automated access. Not charged.',
    });
}

await Actor.setValue('SUMMARY', {
    since: since.toISOString().slice(0, 10), reportsInWindow: filings.length, reportsMatchingMembers: who.length,
    reportsParsed: done.length, scannedReports: scanned, parseErrors, trades, charged, stoppedAtCap: stopped,
});
log.info(`Done. ${done.length} report(s) read in full (${scanned} scanned), ${trades} trade(s), ${charged} charged${stopped ? `, stopped at maxTrades${onlyNew ? '; the next run continues from here' : ''}` : ''}.`);
await Actor.exit();
