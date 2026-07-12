// Government Tender Finder: EU, UK & World Bank Contracts
//
// Strategy
// --------
// Query three official keyless public-procurement APIs per keyword, normalize
// to one row per tender notice, merge and dedupe, then push newest first:
//   - EU TED v3 search API (POST, expert query) — all EU/EEA notices
//   - UK Contracts Finder OCDS search (GET, cursor paging)
//   - World Bank procurement notices API (GET, offset paging) — development
//     projects across ~140 countries, often with buyer contact emails
// Optional cross-run dedupe in a named key-value store turns a scheduled run
// into a new-tender alert.
//
// Pay per event
// -------------
//   tender_row ($0.01) charged per tender pushed. Searches that match nothing
//   cost nothing. First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 1000;
const FETCH_TIMEOUT_MS = 25000;
const TED_PAGE = 100;
const UK_PAGE = 100;
const WB_PAGE = 100;
const USER_AGENT = 'GovernmentTenderFinder/1.0 (+https://apify.com/scrapemint/government-tender-finder)';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;
const outOfTime = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    sources = ['ted', 'uk', 'worldbank'],
    countries = [],
    publishedWithinDays = 14,
    activeOnly = true,
    maxTenders = 25,
    dedupe = false,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const kws = asList(keywords);
const srcs = asList(sources).map((s) => s.toLowerCase()).filter((s) => ['ted', 'uk', 'worldbank'].includes(s));
const countryTokens = asList(countries);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxTenders) || 25));
const lookbackDays = Math.max(1, Math.min(90, Number(publishedWithinDays) || 14));
const sinceMs = Date.now() - lookbackDays * 24 * 3600 * 1000;

if (!kws.length) {
    log.warning('Provide at least one keyword in "keywords".');
    await Actor.exit();
}
if (!srcs.length) srcs.push('ted', 'uk', 'worldbank');

const seenStore = dedupe ? await Actor.openKeyValueStore('tenders-seen') : null;
const seen = new Set();
if (seenStore) for (const id of (await seenStore.getValue('seen-ids')) || []) seen.add(String(id));

async function request(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} from ${new URL(url).host}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request to ${new URL(url).host} failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n = 2000) => (s ? String(s).slice(0, n) : null);
// TED multilingual objects: { eng: "..." } or { eng: ["..."] }; prefer English.
const pickLang = (obj) => {
    if (obj == null || typeof obj !== 'object') return obj || null;
    const val = obj.eng ?? Object.values(obj)[0];
    return (Array.isArray(val) ? val[0] : val) || null;
};
const first = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
// Take the literal calendar date; converting through UTC can shift the day.
const isoDate = (s) => /(\d{4}-\d{2}-\d{2})/.exec(String(s || ''))?.[1] || null;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// World Bank noticedate format: "10-Jul-2026"
const wbDate = (s) => {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
    if (!m) return isoDate(s);
    return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()] ?? 0, Number(m[1]))).toISOString().slice(0, 10);
};

// ---- EU TED --------------------------------------------------------------
const TED_FIELDS = [
    'publication-number', 'publication-date', 'notice-title', 'description-proc',
    'buyer-name', 'organisation-country-buyer', 'organisation-email-buyer',
    'deadline-receipt-tender-date-lot', 'classification-cpv', 'notice-type',
    'estimated-value-proc', 'estimated-value-cur-proc', 'place-of-performance-country-proc',
];
const yyyymmdd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

async function tedSearch(kw, collect) {
    const parts = [
        `FT ~ ("${kw.replace(/"/g, '')}")`,
        'form-type IN (competition)',
        `publication-date >= ${yyyymmdd(sinceMs)}`,
    ];
    // Push ISO3 country codes into the query; anything else is filtered client-side.
    const iso3 = countryTokens.filter((c) => /^[A-Za-z]{3}$/.test(c)).map((c) => c.toUpperCase());
    if (iso3.length && iso3.length === countryTokens.length) parts.push(`organisation-country-buyer IN (${iso3.join(' ')})`);
    const maxPages = Math.ceil((cap * 2) / TED_PAGE) + 1;
    for (let page = 1; page <= maxPages; page++) {
        if (outOfTime()) return;
        const d = await request('https://api.ted.europa.eu/v3/notices/search', {
            query: `${parts.join(' AND ')} SORT BY publication-date DESC`,
            fields: TED_FIELDS, limit: TED_PAGE, page,
        });
        const notices = d?.notices || [];
        for (const n of notices) {
            const id = `ted:${n['publication-number']}`;
            const links = n.links || {};
            collect(id, {
                source: 'eu-ted',
                noticeId: n['publication-number'] || null,
                title: pickLang(n['notice-title']),
                description: clip(stripHtml(pickLang(n['description-proc']))),
                buyer: pickLang(n['buyer-name']),
                buyerCountry: first(n['organisation-country-buyer']),
                country: first(n['place-of-performance-country-proc']) || first(n['organisation-country-buyer']),
                publishedDate: isoDate(n['publication-date']),
                deadline: isoDate(first(n['deadline-receipt-tender-date-lot'])),
                noticeType: n['notice-type'] || null,
                cpvCodes: [...new Set(n['classification-cpv'] || [])],
                estimatedValue: Number(n['estimated-value-proc']) || null,
                currency: n['estimated-value-cur-proc'] || null,
                projectId: null,
                projectName: null,
                contactName: null,
                contactEmail: first(n['organisation-email-buyer']),
                contactPhone: null,
                url: links.htmlDirect?.ENG || links.html?.ENG || `https://ted.europa.eu/en/notice/${n['publication-number']}`,
            }, kw);
        }
        if (notices.length < TED_PAGE || page * TED_PAGE >= (d?.totalNoticeCount || 0)) return;
    }
}

// ---- UK Contracts Finder (OCDS) ------------------------------------------
async function ukSearch(kw, collect) {
    const from = new Date(sinceMs).toISOString().slice(0, 19);
    let url = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search'
        + `?stages=tender&keyword=${encodeURIComponent(kw)}&size=${UK_PAGE}&publishedFrom=${encodeURIComponent(from)}`;
    const maxPages = Math.ceil((cap * 2) / UK_PAGE) + 1;
    for (let page = 1; page <= maxPages && url; page++) {
        if (outOfTime()) return;
        const d = await request(url);
        const releases = d?.releases || [];
        for (const rel of releases) {
            const t = rel.tender || {};
            const buyerParty = (rel.parties || []).find((p) => (p.roles || []).includes('buyer')) || {};
            const contact = buyerParty.contactPoint || {};
            const noticeDoc = (t.documents || []).find((doc) => doc.documentType === 'tenderNotice');
            const cpv = [t.classification, ...(t.additionalClassifications || [])]
                .filter((c) => c && c.scheme === 'CPV').map((c) => String(c.id));
            collect(`uk:${rel.id}`, {
                source: 'uk-contracts-finder',
                noticeId: rel.id,
                title: t.title || null,
                description: clip(stripHtml(t.description)),
                buyer: rel.buyer?.name || buyerParty.name || null,
                buyerCountry: 'GBR',
                country: 'United Kingdom',
                publishedDate: isoDate(t.datePublished || rel.date),
                deadline: isoDate(t.tenderPeriod?.endDate),
                noticeType: t.procurementMethodDetails || t.procurementMethod || 'tender',
                cpvCodes: [...new Set(cpv)],
                estimatedValue: t.value?.amount ?? null,
                currency: t.value?.currency || (t.value?.amount != null ? 'GBP' : null),
                projectId: null,
                projectName: null,
                contactName: contact.name || null,
                contactEmail: contact.email || null,
                contactPhone: contact.telephone || null,
                url: noticeDoc?.url || `https://www.contractsfinder.service.gov.uk/Notice/${t.id || rel.id}`,
            }, kw);
        }
        url = releases.length ? d?.links?.next : null;
    }
}

// ---- World Bank procurement notices ---------------------------------------
async function wbSearch(kw, collect) {
    const maxPages = Math.ceil((cap * 2) / WB_PAGE) + 1;
    for (let page = 0; page < maxPages; page++) {
        if (outOfTime()) return;
        const d = await request('https://search.worldbank.org/api/v2/procnotices'
            + `?format=json&qterm=${encodeURIComponent(kw)}&rows=${WB_PAGE}&os=${page * WB_PAGE}`);
        const notices = d?.procnotices || [];
        let anyRecent = false;
        for (const n of notices) {
            const published = wbDate(n.noticedate);
            if (published && Date.parse(published) >= sinceMs) anyRecent = true;
            collect(`wb:${n.id}`, {
                source: 'world-bank',
                noticeId: n.id,
                title: n.bid_description || n.project_name || null,
                description: clip(stripHtml(n.notice_text)),
                buyer: n.contact_organization || null,
                buyerCountry: n.project_ctry_name || null,
                country: n.project_ctry_name || null,
                publishedDate: published,
                deadline: isoDate(n.submission_deadline_date),
                noticeType: [n.notice_type, n.procurement_method_name].filter(Boolean).join(' / ') || null,
                cpvCodes: [],
                estimatedValue: null,
                currency: null,
                projectId: n.project_id || null,
                projectName: n.project_name || null,
                contactName: n.contact_name || null,
                contactEmail: n.contact_email || null,
                contactPhone: n.contact_phone_no || null,
                url: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${n.id}`,
            }, kw);
        }
        // Results are newest first; once a whole page is older than the
        // lookback window there is nothing further worth paging into.
        if (notices.length < WB_PAGE || !anyRecent) return;
    }
}

// ---- Collect, filter, push -------------------------------------------------
const rows = new Map();
const collect = (id, row, kw) => {
    if (!rows.has(id)) rows.set(id, { ...row, matchedKeyword: kw });
};
const searchers = { ted: tedSearch, uk: ukSearch, worldbank: wbSearch };

log.info(`Searching ${srcs.join(', ')} for ${kws.length} keyword(s), last ${lookbackDays} day(s), cap ${cap}.`);
for (const kw of kws) {
    if (outOfTime()) break;
    await Promise.all(srcs.map((s) => searchers[s](kw, collect)));
    log.info(`Keyword "${kw}": ${rows.size} unique notice(s) so far.`);
}

const matchesCountry = (row) => {
    if (!countryTokens.length) return true;
    const code = String(row.buyerCountry || '').toLowerCase();
    const name = String(row.country || '').toLowerCase();
    return countryTokens.some((tok) => {
        const t = tok.toLowerCase();
        return code === t || name === t || (t.length > 3 && name.includes(t));
    });
};
const yesterday = Date.now() - 24 * 3600 * 1000;
const eligible = [...rows.entries()]
    .filter(([id]) => !seen.has(id))
    .filter(([, r]) => matchesCountry(r))
    .filter(([, r]) => !r.publishedDate || Date.parse(r.publishedDate) >= sinceMs)
    .filter(([, r]) => !activeOnly || !r.deadline || Date.parse(r.deadline) >= yesterday)
    .sort(([, a], [, b]) => (Date.parse(b.publishedDate) || 0) - (Date.parse(a.publishedDate) || 0));
// Newest first, but round-robin across sources within the same publish date so
// one high-volume source cannot crowd the others out of a capped run.
const candidates = [];
for (let i = 0; i < eligible.length && candidates.length < cap;) {
    const date = eligible[i][1].publishedDate;
    const group = [];
    for (; i < eligible.length && eligible[i][1].publishedDate === date; i++) group.push(eligible[i]);
    const queues = new Map();
    for (const entry of group) {
        if (!queues.has(entry[1].source)) queues.set(entry[1].source, []);
        queues.get(entry[1].source).push(entry);
    }
    while (candidates.length < cap && [...queues.values()].some((q) => q.length)) {
        for (const q of queues.values()) {
            if (q.length && candidates.length < cap) candidates.push(q.shift());
        }
    }
}
log.info(`${candidates.length} tender(s) to push${dedupe ? ` (${rows.size - candidates.length} filtered or already seen)` : ''}.`);

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
for (const [id, row] of candidates) {
    if (outOfTime()) { log.warning('Approaching run timeout; stopping early with results so far.'); break; }
    seen.add(id);
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'tender_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

if (seenStore && rowsPushed > 0) {
    await seenStore.setValue('seen-ids', [...seen].slice(-100000));
}

log.info(`Done. ${rowsPushed} tender row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
