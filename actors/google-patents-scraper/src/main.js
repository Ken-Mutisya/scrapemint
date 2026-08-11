// Google Patents Scraper
//
// Search Google Patents at scale, walk paginated results, optionally enrich
// each patent with full claims, description, citations (forward + backward),
// family members, and PDF URLs.
//
// Strategy
// --------
// patents.google.com renders the search UI client-side, but the data it shows
// comes from a public XHR JSON endpoint and the per-patent pages are
// server-rendered for SEO. So we skip the browser entirely:
//
// 1. Search/assignee/inventor seeds hit `/xhr/query`, which returns JSON with
//    one object per result (title, snippet, dates, assignee, inventor, pdf).
//    We paginate by bumping the `page` param.
// 2. Direct patentIds and (when enrichment is on) each search hit fetch the
//    server-rendered `/patent/{id}/en` page and read structured data from the
//    itemprop DOM with Cheerio: inventors, assignees, dates, CPC/IPC, claims,
//    description, citations, forward citations, family members.
//
// Plain HTTP + residential proxy. No Playwright, no shadow DOM.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const PATENTS_BASE = 'https://patents.google.com';

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    patentIds = [],
    assignees = [],
    inventors = [],
    yearFrom = 0,
    yearTo = 0,
    jurisdictions = [],
    statusFilter = 'any',
    cpcClasses = [],
    language = 'en',
    fetchClaims = false,
    fetchDescription = false,
    fetchCitations = false,
    fetchCitedBy = false,
    fetchFamily = false,
    fetchPdf = true,
    maxPatents = 100,
    maxPagesPerQuery = 10,
    // Defaults to false. This is a search tool, not a monitor: someone querying
    // "perovskite solar cell" wants the patents every time they ask. Keyed on
    // publicationNumber, which never changes, so `true` suppressed a patent
    // permanently after its first appearance and a buyer's second run on the
    // same query returned and billed NOTHING. Measured 2026-08-11: the same
    // query logged "10 results, 0 new, pushed 0/10" against 10 rows / 5 charged
    // with dedupe off. Same failure as the google-maps-scraper margin incident.
    // Set it to true deliberately to poll for newly published patents only.
    dedupe = false,
    concurrency = 2,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxPatents) > 0 ? Number(maxPatents) : Infinity;
// Default to Apify residential: Google blocks datacenter IPs on these endpoints.
const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput ?? { groups: ['RESIDENTIAL'] },
);
const seenStore = dedupe ? await Actor.openKeyValueStore('google-patents-scraper-seen') : null;
const seenPatents = new Set(seenStore ? (await seenStore.getValue('seen-patents')) || [] : []);
let pushedRows = 0;

const queryList = (Array.isArray(queries) ? queries : []).map((q) => String(q).trim()).filter(Boolean);
const patentIdList = (Array.isArray(patentIds) ? patentIds : []).map((p) => normalizePatentId(p)).filter(Boolean);
const assigneeList = (Array.isArray(assignees) ? assignees : []).map((a) => String(a).trim()).filter(Boolean);
const inventorList = (Array.isArray(inventors) ? inventors : []).map((i) => String(i).trim()).filter(Boolean);
const cpcList = (Array.isArray(cpcClasses) ? cpcClasses : []).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
const jurisdictionSet = new Set((Array.isArray(jurisdictions) ? jurisdictions : []).map((j) => String(j).toUpperCase()).filter(Boolean));

if (queryList.length === 0 && patentIdList.length === 0 && assigneeList.length === 0 && inventorList.length === 0) {
    log.warning('No input. Provide at least one entry in queries[], patentIds[], assignees[], or inventors[].');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

const wantsDetailFetch = fetchClaims || fetchDescription || fetchCitations || fetchCitedBy || fetchFamily;

function normalizePatentId(s) {
    if (!s) return null;
    const id = String(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return id || null;
}

// Build the Google Patents query string (the value of the `q=` term). Note:
// date bounds are NOT part of q on the XHR API; they go in before=/after=
// params (see buildQueryXhrUrl). Putting them in q returns zero results.
function buildSearchQuery(rawQuery) {
    const parts = [];
    if (rawQuery) parts.push(rawQuery);
    if (statusFilter === 'grant') parts.push('status:GRANT');
    if (statusFilter === 'application') parts.push('status:APPLICATION');
    for (const c of cpcList) parts.push(`CPC=${c}`);
    for (const j of jurisdictionSet) parts.push(`country:${j}`);
    return parts.filter(Boolean).join(' ');
}

// The XHR endpoint takes a single `url` param whose value is itself a
// query string (q, before, after, num, page, ...) that we encode once.
// Date filtering uses before=/after= with a literal `filing:YYYYMMDD` value:
// the colon must survive as a single %3A, so we append these as raw text and
// keep them out of URLSearchParams (which would pre-encode the colon and leave
// it double-encoded as %253A, which Google rejects with a 500).
function buildQueryXhrUrl(rawQuery, page = 0) {
    const usp = new URLSearchParams();
    usp.set('q', buildSearchQuery(rawQuery));
    usp.set('num', '10');
    if (page > 0) usp.set('page', String(page));
    let inner = usp.toString();
    if (yearFrom > 0) inner += `&after=filing:${yearFrom}0101`;
    if (yearTo > 0) inner += `&before=filing:${yearTo}1231`;
    return `${PATENTS_BASE}/xhr/query?url=${encodeURIComponent(inner)}&exp=`;
}

function buildPatentUrl(patentId) {
    return `${PATENTS_BASE}/patent/${patentId}/${language}`;
}

const startUrls = [];
for (const q of queryList) {
    startUrls.push({ url: buildQueryXhrUrl(q, 0), userData: { label: 'search', rawQuery: q, query: buildSearchQuery(q), rawSeed: q, page: 0 } });
}
for (const a of assigneeList) {
    const q = `assignee:"${a}"`;
    startUrls.push({ url: buildQueryXhrUrl(q, 0), userData: { label: 'search', rawQuery: q, query: buildSearchQuery(q), rawSeed: a, page: 0 } });
}
for (const inv of inventorList) {
    const q = `inventor:"${inv}"`;
    startUrls.push({ url: buildQueryXhrUrl(q, 0), userData: { label: 'search', rawQuery: q, query: buildSearchQuery(q), rawSeed: inv, page: 0 } });
}
for (const id of patentIdList) {
    startUrls.push({ url: buildPatentUrl(id), userData: { label: 'detail', patentId: id, fromSearch: false } });
}

log.info(`Seeds: ${startUrls.length} (${queryList.length} queries, ${assigneeList.length} assignees, ${inventorList.length} inventors, ${patentIdList.length} direct patent IDs).`);

const crawler = new CheerioCrawler({
    proxyConfiguration,
    // The XHR endpoint returns application/json; let Crawlee accept it.
    additionalMimeTypes: ['application/json', 'text/javascript', 'application/javascript'],
    maxConcurrency: Math.max(1, Math.min(8, Number(concurrency) || 2)),
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 4,
    async requestHandler(context) {
        const { request } = context;
        const { label } = request.userData;
        if (label === 'search') {
            await handleSearchPage(context);
        } else if (label === 'detail') {
            await handleDetailPage(context);
        } else {
            context.log.warning(`Unknown label: ${label}`);
        }
    },
    failedRequestHandler({ request, log: ll }) {
        ll.warning(`Failed: ${request.url} after retries.`);
    },
});

async function handleSearchPage({ request, body, json, log: ll }) {
    const { rawQuery, query, rawSeed, page: pageIdx = 0 } = request.userData;

    let data = json;
    if (!data) {
        try { data = JSON.parse(body.toString()); } catch { data = null; }
    }
    const clusters = data?.results?.cluster || [];
    const results = clusters.flatMap((c) => c?.result || []);

    if (results.length === 0) {
        ll.warning(`[search] "${rawSeed}" page ${pageIdx + 1}: no results in response (possible block or empty query).`);
        return;
    }

    let queuedThisPage = 0;
    for (const r of results) {
        if (pushedRows >= cap) break;
        const base = mapSearchResult(r, query, rawSeed);
        if (!base.publicationNumber) continue;
        if (dedupe && seenPatents.has(base.publicationNumber)) continue;

        if (wantsDetailFetch) {
            await crawler.addRequests([{
                url: buildPatentUrl(base.publicationNumber),
                userData: { label: 'detail', patentId: base.publicationNumber, fromSearch: true, baseRow: base },
            }]);
        } else {
            await Actor.pushData({ ...base, scrapedAt: new Date().toISOString() });
            pushedRows += 1;
            if (pushedRows > 5) __chargeJobs.push(Actor.charge({ eventName: 'patent_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
            seenPatents.add(base.publicationNumber);
        }
        queuedThisPage += 1;
    }

    ll.info(`[search] "${rawSeed}" page ${pageIdx + 1}: ${results.length} results, ${queuedThisPage} new, pushed ${pushedRows}/${cap === Infinity ? '∞' : cap}.`);

    if (pushedRows >= cap || queuedThisPage === 0) return;
    if (pageIdx + 1 >= maxPagesPerQuery) return;

    await crawler.addRequests([{
        url: buildQueryXhrUrl(rawQuery, pageIdx + 1),
        userData: { label: 'search', rawQuery, query, rawSeed, page: pageIdx + 1 },
    }]);
}

// Map one /xhr/query result object into our row shape.
function mapSearchResult(r, query, rawSeed) {
    const id = String(r.id || '');
    const p = r.patent || {};
    const pubNum = normalizePatentId(id.split('/')[1] || p.publication_number);
    const assignee = cleanText(p.assignee);
    const inventor = cleanText(p.inventor);
    return {
        publicationNumber: pubNum,
        title: cleanText(p.title),
        snippet: cleanText(p.snippet),
        assignees: assignee ? [assignee] : [],
        inventors: inventor ? [inventor] : [],
        priorityDate: p.priority_date || null,
        filingDate: p.filing_date || null,
        publicationDate: p.publication_date || null,
        grantDate: p.grant_date || null,
        language: p.language || language,
        countryCode: p.country_code || (pubNum ? pubNum.slice(0, 2) : null),
        pdfUrl: fetchPdf ? buildPdfUrl(p.pdf) : null,
        url: pubNum ? buildPatentUrl(pubNum) : null,
        sourceQuery: query,
        sourceSeed: rawSeed,
    };
}

function buildPdfUrl(pdf) {
    if (!pdf) return null;
    const s = String(pdf);
    if (s.startsWith('http')) return s;
    return `https://patentimages.storage.googleapis.com/${s.replace(/^\/+/, '')}`;
}

async function handleDetailPage({ request, $, log: ll }) {
    const { patentId, baseRow = {} } = request.userData;

    const text = (sel) => $(sel).first().text().trim() || null;
    const metaC = (name) => $(`meta[name="${name}"]`).first().attr('content') || null;
    const allText = (sel) => $(sel).map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const allMeta = (name) => $(`meta[name="${name}"]`).map((_, el) => $(el).attr('content')).get().filter(Boolean);

    const title = text('h1[itemprop="title"]') || text('h1#title') || metaC('DC.title') || baseRow.title || null;
    const abstract = text('div.abstract') || text('section.abstract') || text('abstract') || metaC('description') || baseRow.snippet || null;

    let inventorsArr = allText('dd[itemprop="inventor"]');
    if (inventorsArr.length === 0) inventorsArr = allMeta('DC.contributor');
    let assigneesCurrent = allText('dd[itemprop="assigneeCurrent"]');
    const assigneesOriginal = allText('dd[itemprop="assigneeOriginal"]');
    if (assigneesCurrent.length === 0) assigneesCurrent = allMeta('DC.assignee');

    const filingDate = $('time[itemprop="filingDate"]').first().attr('datetime') || text('time[itemprop="filingDate"]') || baseRow.filingDate || null;
    const publicationDate = $('time[itemprop="publicationDate"]').first().attr('datetime') || text('time[itemprop="publicationDate"]') || baseRow.publicationDate || null;
    const priorityDate = $('time[itemprop="priorityDate"]').first().attr('datetime') || text('time[itemprop="priorityDate"]') || baseRow.priorityDate || null;
    const grantDate = $('time[itemprop="grantDate"]').first().attr('datetime') || text('time[itemprop="grantDate"]') || baseRow.grantDate || null;

    const cpcCodes = uniq($('li[itemprop="cpcs"] span[itemprop="Code"], ul[itemprop="cpcs"] li[itemprop="Code"]').map((_, el) => $(el).text().trim()).get().filter(Boolean));
    const ipcCodes = uniq($('li[itemprop="ipcs"] span[itemprop="Code"]').map((_, el) => $(el).text().trim()).get().filter(Boolean));

    const legalStatus = text('span[itemprop="status"]') || text('.legal-status') || null;
    const applicationNumber = text('dd[itemprop="applicationNumber"]') || null;
    const familyId = text('dd[itemprop="familyId"]') || null;

    const detail = {
        title,
        abstract,
        inventors: inventorsArr.length ? inventorsArr : (baseRow.inventors || []),
        assignees: assigneesCurrent.length ? assigneesCurrent : (assigneesOriginal.length ? assigneesOriginal : (baseRow.assignees || [])),
        assigneesOriginal,
        assigneesCurrent,
        filingDate,
        publicationDate,
        priorityDate,
        grantDate,
        applicationNumber,
        familyId,
        cpcCodes,
        ipcCodes,
        legalStatus,
    };

    if (fetchClaims) {
        detail.claims = text('section[itemprop="claims"]') || text('#claims') || text('.claims');
    }
    if (fetchDescription) {
        detail.description = text('section[itemprop="description"]') || text('#description') || text('.description');
    }
    if (fetchCitations) {
        detail.citedPatents = $('tr[itemprop="backwardReferencesOrig"], tr[itemprop="backwardReferences"]').map((_, tr) => ({
            publicationNumber: $(tr).find('span[itemprop="publicationNumber"]').first().text().trim() || null,
            priorityDate: $(tr).find('time[itemprop="priorityDate"]').first().attr('datetime') || null,
            publicationDate: $(tr).find('time[itemprop="publicationDate"]').first().attr('datetime') || null,
            assignee: $(tr).find('span[itemprop="assigneeOriginal"]').first().text().trim() || null,
            title: $(tr).find('span[itemprop="title"]').first().text().trim() || null,
        })).get().filter((c) => c.publicationNumber);
        detail.citedNonPatentLiterature = allText('dd[itemprop="nplCitations"], span[itemprop="description"][itemprop="nplCitations"]');
    }
    if (fetchCitedBy) {
        detail.citingPatents = $('tr[itemprop="forwardReferencesOrig"], tr[itemprop="forwardReferences"]').map((_, tr) => ({
            publicationNumber: $(tr).find('span[itemprop="publicationNumber"]').first().text().trim() || null,
            priorityDate: $(tr).find('time[itemprop="priorityDate"]').first().attr('datetime') || null,
            publicationDate: $(tr).find('time[itemprop="publicationDate"]').first().attr('datetime') || null,
            assignee: $(tr).find('span[itemprop="assigneeOriginal"]').first().text().trim() || null,
            title: $(tr).find('span[itemprop="title"]').first().text().trim() || null,
        })).get().filter((c) => c.publicationNumber);
    }
    if (fetchFamily) {
        detail.family = $('tr[itemprop="familyMembers"]').map((_, tr) => ({
            publicationNumber: $(tr).find('span[itemprop="publicationNumber"]').first().text().trim() || null,
            country: $(tr).find('span[itemprop="countryCode"]').first().text().trim() || null,
            publicationDate: $(tr).find('time[itemprop="publicationDate"]').first().attr('datetime') || null,
            title: $(tr).find('span[itemprop="title"]').first().text().trim() || null,
        })).get().filter((m) => m.publicationNumber);
    }

    const pdfUrl = fetchPdf ? (metaC('citation_pdf_url') || baseRow.pdfUrl || null) : null;

    const row = {
        publicationNumber: patentId,
        url: buildPatentUrl(patentId),
        sourceQuery: baseRow.sourceQuery || null,
        sourceSeed: baseRow.sourceSeed || null,
        ...detail,
        pdfUrl,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    pushedRows += 1;
    if (pushedRows > 5) __chargeJobs.push(Actor.charge({ eventName: 'patent_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    seenPatents.add(patentId);
    ll.info(`[detail] ${patentId}: "${(title || '').slice(0, 60)}", ${detail.inventors.length} inventors, ${detail.cpcCodes.length} CPC.`);
}

function cleanText(s) {
    if (s === null || s === undefined) return null;
    return String(s)
        .replace(/<[^>]*>/g, '')
        .replace(/&hellip;/g, '…')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

function uniq(arr) {
    return [...new Set(arr)];
}

await crawler.run(startUrls);

if (seenStore) {
    await seenStore.setValue('seen-patents', [...seenPatents]);
}

log.info(`Done. Pushed ${pushedRows} rows.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();
