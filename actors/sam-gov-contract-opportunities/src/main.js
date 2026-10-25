// SAM.gov Contract Opportunities: US federal solicitations, sources sought,
// presolicitations and award notices with contacts and deadlines.
//
// Strategy
// --------
// sam.gov's own search page calls GET sam.gov/api/prod/sgs/v1/search/
// ?index=opp&mode=search with q, naics, notice_type, set_aside, pop_state,
// modified_date.from/to and response_date.from/to (dates as YYYY-MM-DD-04:00,
// lists comma-separated). It pages 100 at a time up to 10,000 records per
// search. Each hit has title, type, solicitation number, dates and the
// agency hierarchy.
// Details come from GET sam.gov/api/prod/opps/v2/opportunities/{id} (NAICS,
// PSC, set-aside, place of performance, points of contact, full description,
// award) and /opps/v3/opportunities/{id}/resources (attachments). Attachment
// links go through /opps/v3/opportunities/resources/files/{id}/download,
// which redirects to a short-lived S3 URL.
// None of these need the api.data.gov key that the official API asks for.
//
// No key, no proxy. Tested from Apify on 2026-10-25.
//
// Pay per event
// -------------
//   opportunity ($0.0015) one notice with its details
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const BASE = 'https://sam.gov';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE = 100;
const MAX_WINDOW = 10_000;
const SET_ASIDES = {
    SBA: 'Total Small Business Set-Aside (FAR 19.5)', SBP: 'Partial Small Business Set-Aside (FAR 19.5)',
    '8A': '8(a) Set-Aside (FAR 19.8)', '8AN': '8(a) Sole Source (FAR 19.8)',
    HZC: 'HUBZone Set-Aside (FAR 19.13)', HZS: 'HUBZone Sole Source (FAR 19.13)',
    SDVOSBC: 'Service-Disabled Veteran-Owned Small Business (SDVOSB) Set-Aside (FAR 19.14)', SDVOSBS: 'SDVOSB Sole Source (FAR 19.14)',
    WOSB: 'Women-Owned Small Business (WOSB) Program Set-Aside (FAR 19.15)', WOSBSS: 'WOSB Program Sole Source (FAR 19.15)',
    EDWOSB: 'Economically Disadvantaged WOSB (EDWOSB) Program Set-Aside (FAR 19.15)', EDWOSBSS: 'EDWOSB Program Sole Source (FAR 19.15)',
    LAS: 'Local Area Set-Aside (FAR 26.2)', IEE: 'Indian Economic Enterprise (IEE) Set-Aside', ISBEE: 'Indian Small Business Economic Enterprise (ISBEE) Set-Aside',
    BICiv: 'Buy Indian Set-Aside', VSA: 'Veteran-Owned Small Business Set-Aside (VA)', VSS: 'Veteran-Owned Small Business Sole Source (VA)',
};
const TYPES = { o: 'Solicitation', k: 'Combined Synopsis/Solicitation', p: 'Presolicitation', r: 'Sources Sought', s: 'Special Notice', a: 'Award Notice', u: 'Justification', i: 'Intent to Bundle Requirements (DoD-Funded)', g: 'Sale of Surplus Property' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = '',
    naicsCodes = [],
    noticeTypes = ['o', 'k', 'p', 'r'],
    setAsides = [],
    states = [],
    postedWithinDays = 0,
    responseDueWithinDays = 0,
    activeOnly = true,
    includeDetails = true,
    maxResults = 200,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Number(maxResults) || 200);
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

async function getJson(path) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${BASE}/search/` }, signal: AbortSignal.timeout(45_000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * 2 ** attempt); continue; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (err) {
            last = err;
            if (/HTTP 4\d\d/.test(err.message)) break;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

// ---------- search ----------
const day = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const q = new URLSearchParams({ index: 'opp', mode: 'search', sort: '-modifiedDate', size: String(PAGE) });
if (activeOnly) q.set('is_active', 'true');
if (String(keywords).trim()) q.set('q', String(keywords).trim());
const naics = list(naicsCodes).map((x) => x.replace(/\D/g, '')).filter(Boolean);
if (naics.length) q.set('naics', naics.join(','));
const types = list(noticeTypes).map((x) => x.toLowerCase());
if (types.length) q.set('notice_type', types.join(','));
const asides = list(setAsides);
if (asides.length) q.set('set_aside', asides.join(','));
const st = list(states).map((x) => x.toUpperCase());
if (st.length) q.set('pop_state', st.join(','));
if (Number(postedWithinDays) > 0) {
    q.set('modified_date.from', `${day(new Date(now.getTime() - Number(postedWithinDays) * 86400_000))}-04:00`);
    q.set('modified_date.to', `${day(new Date(now.getTime() + 86400_000))}-04:00`);
}
if (Number(responseDueWithinDays) > 0) {
    q.set('response_date.from', `${day(now)}-04:00`);
    q.set('response_date.to', `${day(new Date(now.getTime() + Number(responseDueWithinDays) * 86400_000))}-04:00`);
}

// ---------- rows ----------
const strip = (s) => (s ? String(s).replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim() || null : null);
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?/i;

function hierarchy(h) {
    if (!Array.isArray(h)) h = [];
    const by = (lvl) => h.find((o) => o.level === lvl) || null;
    const office = [...h].sort((a, b) => b.level - a.level)[0] || null;
    const a = office?.address || {};
    return {
        department: by(1)?.name || null,
        agency: by(2)?.name || null,
        subTier: h.length > 3 ? by(3)?.name || null : null,
        office: office && office.level > 1 ? office.name : null,
        officeCode: office?.code || null,
        officeAddress: [a.streetAddress, a.streetAddress2, a.city, a.state, a.zip].filter(Boolean).join(', ') || null,
    };
}

function contacts(poc) {
    return (Array.isArray(poc) ? poc : []).map((p) => {
        const raw = p.fullName || '';
        // Some offices pack phone and email into the name field.
        const name = raw.split(/,\s*(?:PHONE|EMAIL|TEL|FAX)\b/i)[0].trim() || null;
        return {
            type: p.type || null,
            name,
            title: p.title || null,
            email: p.email || raw.match(EMAIL)?.[0] || null,
            phone: p.phone || raw.match(PHONE)?.[0] || null,
        };
    }).filter((c) => c.name || c.email || c.phone);
}

function baseRow(h) {
    const desc = h.descriptions?.[0]?.content || null;
    return {
        noticeId: h._id,
        title: h.title || null,
        solicitationNumber: h.solicitationNumber || null,
        noticeType: h.type?.value || TYPES[h.type?.code] || null,
        noticeTypeCode: h.type?.code || null,
        postedDate: h.publishDate || null,
        modifiedDate: h.modifiedDate || null,
        responseDeadline: h.responseDateActual || h.responseDate || null,
        responseTimeZone: h.responseTimeZone || null,
        active: h.isActive ?? null,
        cancelled: h.isCanceled ?? null,
        ...hierarchy(h.organizationHierarchy),
        naicsCodes: [],
        pscCode: null,
        setAside: null,
        setAsideCode: null,
        placeOfPerformance: null,
        contacts: [],
        description: strip(desc),
        attachments: [],
        award: h.award?.awardee?.name ? { awardee: h.award.awardee.name, awardeeUei: h.award.awardee.ueiSAM || null } : null,
        parentNoticeId: h.parentNoticeId || null,
        url: `${BASE}/opp/${h._id}/view`,
    };
}

async function addDetails(row) {
    const [d, res] = await Promise.all([
        getJson(`/api/prod/opps/v2/opportunities/${row.noticeId}`).catch((e) => ({ _err: e.message })),
        getJson(`/api/prod/opps/v3/opportunities/${row.noticeId}/resources`).catch(() => null),
    ]);
    if (!d || d._err) return { ...row, detailsError: d?._err || 'not found' };
    const x = d.data2 || {};
    const pop = x.placeOfPerformance;
    const code = x.solicitation?.setAside || null;
    const aw = x.award || {};
    const atts = (res?._embedded?.opportunityAttachmentList || []).flatMap((l) => l.attachments || [])
        .filter((a) => a.deletedFlag !== '1' && a.accessStatus !== 'private')
        .map((a) => ({
            name: a.name || null,
            type: a.type || null,
            sizeBytes: a.size ?? null,
            postedDate: a.postedDate || null,
            url: a.type === 'link' && a.uri ? a.uri : `${BASE}/api/prod/opps/v3/opportunities/resources/files/${a.resourceId}/download`,
        }));
    const body = (d.description || []).sort((a, b) => String(b.modifiedOn).localeCompare(String(a.modifiedOn)))[0]?.body;
    return {
        ...row,
        naicsCodes: (x.naics || []).flatMap((n) => n.code || []),
        pscCode: x.classificationCode || null,
        setAside: code ? SET_ASIDES[code] || code : null,
        setAsideCode: code,
        placeOfPerformance: pop ? {
            city: pop.city?.name || null,
            state: pop.state?.code || null,
            zip: pop.zip || null,
            country: pop.country?.code || null,
            text: [pop.city?.name, pop.state?.code, pop.zip, pop.country?.code && pop.country.code !== 'USA' ? pop.country.name : null].filter(Boolean).join(', ') || null,
        } : null,
        contacts: contacts(x.pointOfContact),
        description: (strip(body) || row.description)?.slice(0, 20_000) || null,
        attachments: atts,
        archiveDate: x.archive?.date || null,
        award: aw.awardee?.name || aw.amount || aw.number ? {
            awardee: aw.awardee?.name || null,
            awardeeUei: aw.awardee?.ueiSAM || null,
            amount: aw.amount != null ? Number(aw.amount) : null,
            date: aw.date || null,
            contractNumber: aw.number || null,
        } : row.award,
        relatedNoticeId: d.related?.opportunityId || null,
        parentNoticeId: d.parent?.opportunityId || row.parentNoticeId,
    };
}

// ---------- run ----------
let out = 0;
let stop = false;
let total = null;
const DETAIL_CONC = 5;
for (let page = 0; out < cap && !stop && !pastDeadline(); page++) {
    if ((page + 1) * PAGE > MAX_WINDOW) { log.warning(`SAM.gov returns at most ${MAX_WINDOW} notices per search. Narrow the filters for the rest.`); break; }
    q.set('page', String(page));
    let res;
    try { res = await getJson(`/api/prod/sgs/v1/search/?${q}`); } catch (err) { log.error(`Search page ${page}: ${err.message}`); break; }
    total ??= res?.page?.totalElements ?? 0;
    if (page === 0) log.info(`${total} notices match.`);
    const hits = res?._embedded?.results || [];
    if (!hits.length) break;
    const rows = hits.slice(0, cap - out).map(baseRow);
    for (let i = 0; i < rows.length && !stop && !pastDeadline(); i += DETAIL_CONC) {
        const chunk = rows.slice(i, i + DETAIL_CONC);
        const done = includeDetails ? await Promise.all(chunk.map(addDetails)) : chunk;
        await Actor.pushData(done);
        out += done.length;
        try {
            const r = await Actor.charge({ eventName: 'opportunity', count: done.length });
            if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
        } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    }
    if (hits.length < PAGE) break;
}

if (!out) await Actor.pushData({ note: 'No SAM.gov notices matched. Not charged.' });
await Actor.setValue('SUMMARY', { matching: total, written: out, search: Object.fromEntries(q) });
log.info(`Done: ${out} notices.`);
await Actor.exit();
