// Earnings Call Transcripts: full text of US company earnings calls, split
// into speaker turns, with the call's participants, takeaways and risks.
//
// Strategy
// --------
// The Motley Fool publishes a transcript of most US earnings calls within a
// day, as plain server-rendered HTML.
//
//   tickers       /quote/{exchange}/{ticker}/ lists the company's recent
//                 transcripts (~8). The exchange is unknown up front, so
//                 nasdaq, nyse and nysemkt are tried in turn.
//   date range    /sitemap/YYYY/MM lists every article of a month; transcript
//                 URLs carry their date (/earnings/call-transcripts/2026/10/16/).
//   latest        /earnings-call-transcripts/page/N/, 20 per page, newest first.
//
// Each transcript page has h2 sections: DATE, CALL PARTICIPANTS ("Role -
// Name" list items), TAKEAWAYS, RISKS, SUMMARY, then "Full Conference Call
// Transcript", where a turn starts with <strong>Speaker:</strong> and
// following paragraphs continue it. Q&A starts at the first operator turn
// that mentions questions after an executive has spoken.
//
// No key, no proxy. Tested from Apify on 2026-10-18.
//
// Pay per event
// -------------
//   transcript_row ($0.015) one full transcript
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const BASE = 'https://www.fool.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const GAP_MS = 400;
const EXCHANGES = ['nasdaq', 'nyse', 'nysemkt'];
const LINK_RE = /\/earnings\/call-transcripts\/(\d{4})\/(\d{2})\/(\d{2})\/[a-z0-9-]+\//g;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    tickers = [],
    transcriptsPerTicker = 4,
    dateFrom,
    dateTo,
    transcriptUrls = [],
    includeTurns = true,
    maxTranscripts = 20,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(typeof x === 'object' ? x?.url ?? '' : x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = Math.max(1, Number(maxTranscripts) || 20);
const perTicker = Math.max(1, Number(transcriptsPerTicker) || 4);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

async function getHtml(url) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) {
                last = new Error(`HTTP ${r.status}`);
                await sleep(3000 * (attempt + 1));
                continue;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.text();
        } catch (err) {
            last = err;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

const linksIn = (html) => [...new Set([...String(html || '').matchAll(LINK_RE)].map((m) => BASE + m[0]))];
const dateOfUrl = (u) => { const m = u.match(/call-transcripts\/(\d{4})\/(\d{2})\/(\d{2})\//); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const newestFirst = (a, b) => String(dateOfUrl(b)).localeCompare(String(dateOfUrl(a)));

// ---- collect transcript URLs ----
const queue = []; // { url, ticker }
const seen = new Set();
const add = (url, ticker = null) => { if (!seen.has(url)) { seen.add(url); queue.push({ url, ticker }); } };
const failures = [];

for (const u of list(transcriptUrls)) {
    try { add(new URL(u, BASE).href.replace(/[?#].*$/, '').replace(/\/?$/, '/')); } catch { failures.push({ scope: u, error: 'not a URL' }); }
}

const symbols = list(tickers).map((t) => t.toUpperCase().replace(/^\$/, ''));
for (const sym of symbols) {
    let links = null;
    for (const ex of EXCHANGES) {
        await sleep(GAP_MS);
        const html = await getHtml(`${BASE}/quote/${ex}/${sym.toLowerCase()}/`).catch((err) => { failures.push({ scope: sym, error: err.message }); return null; });
        if (html) { links = linksIn(html); break; }
    }
    if (!links?.length) { failures.push({ scope: sym, error: 'no transcripts listed for this ticker' }); continue; }
    links.sort(newestFirst).slice(0, perTicker).forEach((u) => add(u, sym));
}

const from = /^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || '')) ? dateFrom : null;
const to = /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || '')) ? dateTo : null;
if (from || to) {
    const end = to || new Date().toISOString().slice(0, 10);
    const start = from || end;
    const months = [];
    for (let d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`) && months.length < 24; d.setUTCMonth(d.getUTCMonth() + 1)) {
        months.push(d.toISOString().slice(0, 7));
    }
    for (const ym of months) {
        await sleep(GAP_MS);
        const html = await getHtml(`${BASE}/sitemap/${ym.replace('-', '/')}`).catch((err) => { failures.push({ scope: `sitemap ${ym}`, error: err.message }); return null; });
        linksIn(html).filter((u) => { const d = dateOfUrl(u); return d >= start && d <= end; }).sort(newestFirst).forEach((u) => add(u));
    }
}

if (!queue.length && !symbols.length && !from && !to) {
    for (let page = 1; page <= 50 && queue.length < cap; page++) {
        await sleep(GAP_MS);
        const url = page === 1 ? `${BASE}/earnings-call-transcripts/` : `${BASE}/earnings-call-transcripts/page/${page}/`;
        const links = linksIn(await getHtml(url).catch(() => null));
        if (!links.length) break;
        links.sort(newestFirst).forEach((u) => add(u));
    }
}

log.info(`${queue.length} transcript(s) found; reading up to ${cap}.`);

// ---- parse one transcript ----
function sectionAfter($, body, name) {
    const h = body.find('h2').filter((_, e) => clean($(e).text()).toUpperCase() === name).first();
    return h.length ? h.nextUntil('h2') : null;
}

function parse(html, url, tickerHint) {
    const $ = cheerio.load(html);
    const body = $('.article-body').first();
    const title = clean($('h1').first().text()) || clean($('title').text()).replace(/\s*\|.*$/, '');
    // "JPMorgan Chase (JPM) Q3 2026 ...", "Apple AAPL Q2 2026 ...", or "Apple Q4 2025 ..." with no ticker.
    const head = title.match(/^(.*?)\s+\(?([A-Z][A-Z.\-]{0,7})\)?\s+Q[1-4]\s+\d{4}/)
        || [null, (title.match(/^(.*?)\s+Q[1-4]\s+\d{4}/) || [])[1] || null, null];
    const q = title.match(/\b(Q[1-4])\s+(\d{4})\b/);
    const published = (html.match(/"datePublished":"([^"]+)"/) || [])[1] || null;

    const participants = [];
    sectionAfter($, body, 'CALL PARTICIPANTS')?.find('li').each((_, li) => {
        const t = clean($(li).text());
        const m = t.match(/^(.*?)\s+[-–—]\s+(.+)$/);
        participants.push(m ? { name: m[2], role: m[1] } : { name: t, role: null });
    });
    const items = (name) => (sectionAfter($, body, name)?.find('li').map((_, li) => clean($(li).text())).get() || []).filter(Boolean);
    const paras = (name) => (sectionAfter($, body, name)?.filter('p').map((_, p) => clean($(p).text())).get() || [])
        .filter((t) => t && !/^Need a quote from a Motley Fool analyst/i.test(t));

    // Transcript turns.
    const turns = [];
    const tHead = body.find('h2').filter((_, e) => /conference call transcript/i.test($(e).text())).first();
    const tParas = tHead.length ? tHead.nextAll('p') : body.find('p');
    let section = 'prepared_remarks';
    let execSpoke = false;
    tParas.each((_, p) => {
        const strong = clean($(p).children('strong').first().text());
        const text = clean($(p).text());
        if (!text) return;
        if (strong.endsWith(':')) {
            const speaker = strong.slice(0, -1).trim();
            const said = clean(text.slice(text.indexOf(':') + 1));
            const isOperator = /^operator$/i.test(speaker);
            if (isOperator && execSpoke && section === 'prepared_remarks' && /question/i.test(said)) section = 'qa';
            if (!isOperator) execSpoke = true;
            turns.push({ speaker, section, text: said });
        } else if (turns.length) {
            turns[turns.length - 1].text += `\n\n${text}`;
        }
    });
    const roleOf = new Map(participants.map((x) => [x.name.toLowerCase(), x.role]));
    for (const t of turns) {
        t.role = /^operator$/i.test(t.speaker) ? 'Operator' : roleOf.get(t.speaker.toLowerCase()) ?? (t.section === 'qa' ? 'Analyst' : null);
    }

    const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n\n');
    const callDate = paras('DATE')[0] || null;
    const analysts = [...new Set(turns.filter((t) => t.role === 'Analyst').map((t) => t.speaker))];
    return {
        ticker: head?.[2] || tickerHint || null,
        company: head?.[1] || null,
        quarter: q?.[1] || null,
        fiscalYear: q ? Number(q[2]) : null,
        callDate,
        publishedAt: published,
        title,
        participants,
        analysts,
        takeaways: items('TAKEAWAYS'),
        risks: items('RISKS'),
        summary: paras('SUMMARY').join('\n\n') || null,
        transcript: transcript || null,
        ...(includeTurns ? { turns: turns.map(({ speaker, role, section: s, text }) => ({ speaker, role, section: s, text })) } : {}),
        turnCount: turns.length,
        wordCount: transcript ? transcript.split(/\s+/).length : 0,
        url,
    };
}

// ---- run ----
let rowsOut = 0;
for (const { url, ticker } of queue) {
    if (rowsOut >= cap) break;
    if (pastDeadline()) { log.warning('Close to the run timeout; stopping.'); break; }
    await sleep(GAP_MS);
    let html;
    try { html = await getHtml(url); } catch (err) { failures.push({ scope: url, error: err.message }); continue; }
    if (!html) { failures.push({ scope: url, error: 'HTTP 404' }); continue; }
    const row = parse(html, url, ticker);
    if (!row.turnCount) { failures.push({ scope: url, error: 'no transcript text on the page' }); continue; }
    await Actor.pushData(row);
    rowsOut++;
    try {
        const res = await Actor.charge({ eventName: 'transcript_row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); break; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

if (rowsOut === 0) {
    await Actor.pushData({ type: 'note', note: `No transcripts found. ${failures.slice(0, 3).map((f) => `${f.scope}: ${f.error}`).join('; ')} Not charged.` });
}
await Actor.setValue('SUMMARY', { rows: rowsOut, found: queue.length, failures });
log.info(`Done: ${rowsOut} transcript(s).`);
await Actor.exit();
