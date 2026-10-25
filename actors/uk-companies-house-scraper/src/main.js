// UK Companies House Scraper: companies from the public register by
// incorporation date, SIC code, location, name, status and type, with
// optional profile details and active directors.
//
// Strategy
// --------
// The register's advanced search (find-and-update.company-information.
// service.gov.uk/advanced-search) has a CSV export at /advanced-search/csv
// that takes the same GET parameters and returns up to 5,000 companies in
// one response: name, number, status, type, incorporation and dissolution
// dates, SIC codes and registered office address.
// The results page shows the match count. When a search hits the 5,000 cap
// and has a date range, the range is halved until each window fits.
// Optional details read /company/{number} (accounts and confirmation-
// statement deadlines, previous names) and /company/{number}/officers?
// filter=active (active directors and secretaries). Dates of birth and
// home-style correspondence addresses are left out on purpose.
// Company numbers can also be given directly.
//
// No key, no proxy. Tested from Apify on 2026-10-25.
//
// Pay per event
// -------------
//   company_row    ($0.001)  one company from the search export
//   company_detail ($0.003)  one company with profile and active officers
// Only one of the two is charged per company. No start fee.

import { Actor, log } from 'apify';
import { readFileSync } from 'node:fs';

const BASE = 'https://find-and-update.company-information.service.gov.uk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CSV_CAP = 5000;
const SIC = JSON.parse(readFileSync(new URL('./sic.json', import.meta.url), 'utf8'));
const TYPES = {
    ltd: 'Private limited company', plc: 'Public limited company', llp: 'Limited liability partnership',
    'private-unlimited': 'Private unlimited company', 'private-limited-guarant-nsc': 'Private limited by guarantee without share capital',
    'private-limited-guarant-nsc-limited-exemption': 'Private limited by guarantee (exempt from using Limited)',
    'limited-partnership': 'Limited partnership', 'scottish-partnership': 'Scottish partnership', 'charitable-incorporated-organisation': 'Charitable incorporated organisation',
    'scottish-charitable-incorporated-organisation': 'Scottish charitable incorporated organisation', 'registered-society-non-jurisdictional': 'Registered society',
    'oversea-company': 'Overseas company', 'registered-overseas-entity': 'Registered overseas entity', 'royal-charter': 'Royal charter company',
    'old-public-company': 'Old public company', 'converted-or-closed': 'Converted or closed', 'uk-establishment': 'UK establishment',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyNumbers = [],
    incorporatedFrom = '',
    incorporatedTo = '',
    incorporatedInLastDays = 0,
    sicCodes = [],
    location = '',
    nameIncludes = '',
    nameExcludes = '',
    status = ['active'],
    companyTypes = [],
    includeDetails = false,
    maxResults = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Number(maxResults) || 1000);
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

async function get(path, accept = 'text/html') {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-GB,en;q=0.9' }, signal: AbortSignal.timeout(60_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(4000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.text();
        } catch (err) {
            last = err;
            if (/HTTP 4\d\d/.test(err.message)) break;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

// ---------- search parameters ----------
const iso = (d) => d.toISOString().slice(0, 10);
const parseDate = (s) => {
    const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
let from = parseDate(incorporatedFrom);
let to = parseDate(incorporatedTo);
if (Number(incorporatedInLastDays) > 0) {
    to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    from = new Date(to.getTime() - (Number(incorporatedInLastDays) - 1) * 86400_000);
}
const numbers = list(companyNumbers).map((n) => n.toUpperCase().replace(/\s+/g, '')).map((n) => (/^\d+$/.test(n) ? n.padStart(8, '0') : n));
const sics = list(sicCodes).map((s) => s.replace(/\D/g, '')).filter(Boolean);
const hasFilter = from || to || sics.length || String(location).trim() || String(nameIncludes).trim();
// An empty input (store health checks) runs the form's prefill.
if (!numbers.length && !hasFilter) {
    to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    from = new Date(to.getTime() - 6 * 86400_000);
    sics.push('62012');
    log.info('No filters given: using new software companies from the last 7 days.');
}

function params(f, t, sic) {
    const q = new URLSearchParams();
    if (String(nameIncludes).trim()) q.set('companyNameIncludes', String(nameIncludes).trim());
    if (String(nameExcludes).trim()) q.set('companyNameExcludes', String(nameExcludes).trim());
    if (String(location).trim()) q.set('registeredOfficeAddress', String(location).trim());
    if (f) { q.set('incorporationFromDay', f.getUTCDate()); q.set('incorporationFromMonth', f.getUTCMonth() + 1); q.set('incorporationFromYear', f.getUTCFullYear()); }
    if (t) { q.set('incorporationToDay', t.getUTCDate()); q.set('incorporationToMonth', t.getUTCMonth() + 1); q.set('incorporationToYear', t.getUTCFullYear()); }
    for (const s of list(status)) q.append('status', s);
    if (sic) q.set('sicCodes', sic);
    for (const ty of list(companyTypes)) q.append('type', ty);
    return q;
}

async function count(q) {
    const t = await get(`/advanced-search/get-results?${q}`);
    const m = t && t.match(/([\d,]+)\s+results?</);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
}

// Split [f, t] until each window is under the export cap.
async function windows(f, t, sic, depth = 0) {
    const n = await count(params(f, t, sic));
    if (n < CSV_CAP || !f || !t || t - f < 86400_000 || depth > 12) {
        if (n >= CSV_CAP) log.warning(`${f ? iso(f) : 'any'}..${t ? iso(t) : 'any'}: ${n}+ matches, the register exports the first ${CSV_CAP}. Add a date range or narrow the filters for more.`);
        return n ? [[f, t, n, sic]] : [];
    }
    const mid = new Date(f.getTime() + Math.floor((t - f) / 86400_000 / 2) * 86400_000);
    const next = new Date(mid.getTime() + 86400_000);
    return [...await windows(f, mid, sic, depth + 1), ...await windows(next, t, sic, depth + 1)];
}

function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [head, ...body] = rows;
    const h = head.map((x) => x.trim());
    const nob = h.indexOf('nature_of_business');
    // The export does not quote multi-code SIC lists ("[46499, 62012]"), so a
    // row can have extra cells. Rebuild it around the bracketed SIC list.
    return body.filter((r) => r.length > 1).map((r) => {
        let cells = r;
        if (r.length !== h.length && nob > 0) {
            const i = r.findIndex((c, k) => k >= nob && c.trim().startsWith('['));
            const j = i < 0 ? -1 : r.findIndex((c, k) => k >= i && c.trim().endsWith(']'));
            if (i >= 0 && j >= i) {
                const pre = r.slice(0, i);
                const name = pre.slice(0, pre.length - (nob - 1)).join(',');
                cells = [name, ...pre.slice(pre.length - (nob - 1)), r.slice(i, j + 1).join(','), r.slice(j + 1).join(',')];
            }
        }
        return Object.fromEntries(h.map((k, i) => [k, (cells[i] ?? '').trim()]));
    });
}

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$/i;
const titleStatus = (s) => (s ? s.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : null);

function fromCsv(r) {
    const codes = (r.nature_of_business || '').replace(/[[\]]/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    const address = r.registered_office_address || null;
    return {
        companyName: r.company_name,
        companyNumber: r.company_number,
        status: titleStatus(r.company_status),
        companyType: TYPES[r.company_type] || r.company_type || null,
        companyTypeCode: r.company_type || null,
        incorporationDate: r.incorporation_date || null,
        dissolutionDate: r.dissolution_date || null,
        registeredOfficeAddress: address,
        postcode: address?.match(POSTCODE)?.[1]?.toUpperCase() || null,
        sicCodes: codes,
        sicDescriptions: codes.map((c) => SIC[c] || null).filter(Boolean),
        companyUrl: `${BASE}/company/${r.company_number}`,
    };
}

// ---------- details ----------
const clean = (s) => (s == null ? null : s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || null);
const byId = (html, id) => clean(html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</(?:dd|td|span|p|h1|div|strong)>`))?.[1]);
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12, Jan: 1, Feb: 2, Mar: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12 };
const toIso = (s) => {
    const m = String(s || '').match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
    return m && MONTHS[m[2]] ? `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

function parseProfile(html) {
    const text = clean(html.replace(/<script[\s\S]*?<\/script>/g, '')) || '';
    const pick = (re) => toIso(text.match(re)?.[1]);
    const prev = [];
    for (let i = 1; i < 50; i++) {
        const n = byId(html, `previous-name-${i}`);
        if (!n) break;
        prev.push({ name: n, period: byId(html, `previous-date-${i}`) });
    }
    const sicList = [...html.matchAll(/id="sic\d+"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1])).filter(Boolean);
    return {
        companyName: clean(html.match(/<h1[^>]*class="heading-xlarge"[^>]*>([\s\S]*?)<\/h1>/)?.[1]) || clean(html.match(/<p class="heading-xlarge">([\s\S]*?)<\/p>/)?.[1]),
        registeredOfficeAddress: byId(html, 'roa-address'),
        status: byId(html, 'company-status'),
        companyType: byId(html, 'company-type'),
        incorporationDate: toIso(byId(html, 'company-creation-date')),
        sic: sicList,
        accountsNextMadeUpTo: pick(/(?:Next|First) accounts made up to (\d{1,2} \w+ \d{4})/),
        accountsNextDue: pick(/(?:Next|First) accounts made up to \d{1,2} \w+ \d{4} due by (\d{1,2} \w+ \d{4})/),
        accountsLastMadeUpTo: pick(/Last accounts made up to (\d{1,2} \w+ \d{4})/),
        accountsOverdue: /accounts overdue/i.test(text),
        confirmationStatementNextDue: pick(/(?:Next|First) statement date \d{1,2} \w+ \d{4} due by (\d{1,2} \w+ \d{4})/),
        confirmationStatementLastDate: pick(/Last statement dated (\d{1,2} \w+ \d{4})/),
        confirmationStatementOverdue: /confirmation statement overdue/i.test(text),
        previousNames: prev,
    };
}

function parseOfficers(html) {
    const out = [];
    for (let i = 1; i < 200; i++) {
        if (!html.includes(`id="officer-name-${i}"`)) break;
        const name = clean(html.match(new RegExp(`id="officer-name-${i}"[^>]*>([\\s\\S]*?)</span>`))?.[1]);
        const st = byId(html, `officer-status-tag-${i}`);
        if (st && !/active/i.test(st)) continue;
        out.push({
            name,
            role: byId(html, `officer-role-${i}`),
            appointedOn: toIso(byId(html, `officer-appointed-on-${i}`)),
            nationality: byId(html, `officer-nationality-${i}`),
            countryOfResidence: byId(html, `officer-country-of-residence-${i}`),
            appointmentsUrl: (() => { const h = html.match(new RegExp(`id="officer-name-${i}"[\\s\\S]*?href="([^"]+)"`))?.[1]; return h ? BASE + h : null; })(),
        });
    }
    return out;
}

async function details(number) {
    const [prof, offs] = await Promise.all([get(`/company/${number}`), get(`/company/${number}/officers?filter=active`)]);
    if (!prof) return null;
    const p = parseProfile(prof);
    const officers = offs ? parseOfficers(offs) : [];
    return { ...p, officers };
}

// ---------- run ----------
let out = 0;
let stop = false;
const summary = { windows: [], companies: 0 };

async function emit(row, detailed) {
    await Actor.pushData(row);
    out++;
    try {
        const r = await Actor.charge({ eventName: detailed ? 'company_detail' : 'company_row' });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
}

async function enrich(base) {
    try {
        const d = await details(base.companyNumber);
        if (!d) return { ...base, detailsError: 'Company page not found' };
        const codes = d.sic.map((s) => s.match(/^(\d{4,5})/)?.[1]).filter(Boolean);
        return {
            ...base,
            companyName: base.companyName || d.companyName,
            status: base.status || d.status,
            companyType: base.companyType || d.companyType,
            incorporationDate: base.incorporationDate || d.incorporationDate,
            registeredOfficeAddress: d.registeredOfficeAddress || base.registeredOfficeAddress,
            postcode: (d.registeredOfficeAddress || base.registeredOfficeAddress || '').match(POSTCODE)?.[1]?.toUpperCase() || base.postcode || null,
            sicCodes: base.sicCodes?.length ? base.sicCodes : codes,
            sicDescriptions: base.sicDescriptions?.length ? base.sicDescriptions : d.sic.map((s) => s.replace(/^\d+\s*-\s*/, '')),
            accountsNextMadeUpTo: d.accountsNextMadeUpTo,
            accountsNextDue: d.accountsNextDue,
            accountsLastMadeUpTo: d.accountsLastMadeUpTo,
            accountsOverdue: d.accountsOverdue,
            confirmationStatementNextDue: d.confirmationStatementNextDue,
            confirmationStatementLastDate: d.confirmationStatementLastDate,
            confirmationStatementOverdue: d.confirmationStatementOverdue,
            previousNames: d.previousNames,
            activeOfficerCount: d.officers.length,
            directors: d.officers.filter((o) => /director/i.test(o.role || '')).map((o) => o.name),
            officers: d.officers,
        };
    } catch (err) {
        return { ...base, detailsError: err.message };
    }
}

// Search rows go out in bulk; detail lookups run a few at a time.
async function writeBatch(rows) {
    if (!includeDetails) {
        for (let i = 0; i < rows.length && !stop; i += 500) {
            const chunk = rows.slice(i, Math.min(i + 500, i + cap - out));
            if (!chunk.length) return;
            await Actor.pushData(chunk);
            out += chunk.length;
            try {
                const r = await Actor.charge({ eventName: 'company_row', count: chunk.length });
                if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
            } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        }
        return;
    }
    const CONC = 4;
    for (let i = 0; i < rows.length && !stop && !pastDeadline(); i += CONC) {
        const chunk = rows.slice(i, i + CONC);
        const done = await Promise.all(chunk.map(enrich));
        for (const r of done) {
            if (stop || out >= cap) return;
            await emit(r, includeDetails && !r.detailsError);
        }
    }
}

if (numbers.length) {
    log.info(`Looking up ${numbers.length} company numbers.`);
    const rows = numbers.slice(0, cap).map((n) => ({ companyName: null, companyNumber: n, status: null, companyType: null, incorporationDate: null, registeredOfficeAddress: null, postcode: null, sicCodes: [], sicDescriptions: [], companyUrl: `${BASE}/company/${n}` }));
    const saved = includeDetails;
    // Number lookups always read the company page: that is where the data is.
    const CONC = 4;
    for (let i = 0; i < rows.length && !stop && !pastDeadline(); i += CONC) {
        const done = await Promise.all(rows.slice(i, i + CONC).map(async (r) => {
            const e = await enrich(r);
            if (!saved) { delete e.officers; delete e.directors; delete e.activeOfficerCount; }
            return e;
        }));
        for (const r of done) {
            if (stop || out >= cap) break;
            if (r.detailsError) { await Actor.pushData({ companyNumber: r.companyNumber, error: r.detailsError, note: 'Not charged.' }); continue; }
            await emit(r, saved);
        }
    }
} else {
    // The register takes one SIC code per search, so each code is its own search.
    const wins = [];
    for (const sic of sics.length ? sics : [null]) wins.push(...await windows(from, to, sic));
    const total = wins.reduce((s, w) => s + w[2], 0);
    log.info(`${total} matching companies in ${wins.length} export window(s).`);
    const seen = new Set();
    for (const [f, t, n, sic] of wins) {
        if (stop || out >= cap || pastDeadline()) break;
        const csv = await get(`/advanced-search/csv?${params(f, t, sic)}`, 'text/csv');
        const rows = parseCsv(csv || '').map(fromCsv).filter((r) => r.companyNumber && !seen.has(r.companyNumber) && seen.add(r.companyNumber));
        summary.windows.push({ sicCode: sic, from: f ? iso(f) : null, to: t ? iso(t) : null, matches: n, exported: rows.length });
        log.info(`${sic ? `SIC ${sic} ` : ''}${f ? iso(f) : 'any'}..${t ? iso(t) : 'any'}: ${rows.length} new companies.`);
        await writeBatch(rows.slice(0, cap - out));
    }
}

summary.companies = out;
if (!out) await Actor.pushData({ note: 'No companies matched. Not charged.' });
await Actor.setValue('SUMMARY', summary);
log.info(`Done: ${out} companies.`);
await Actor.exit();
