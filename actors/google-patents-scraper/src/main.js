// Google Patents Scraper
//
// Search Google Patents at scale, walk paginated results, optionally enrich
// each patent with full claims, description, citations (forward + backward),
// family members, and PDF URLs.
//
// Strategy
// --------
// 1. Build seed URLs from queries, assignees, inventors, and direct patentIds.
// 2. Crawl with Playwright. Patents.google.com renders results via web
//    components, so we navigate the HTML and read structured data from the
//    rendered DOM.
// 3. Search pages return basic patent metadata. Enrichment toggles queue
//    detail page fetches for full claims, description, citations, and family.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const PATENTS_BASE = 'https://patents.google.com';

await Actor.init();

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
    dedupe = true,
    navigationDelayMs = 3500,
    concurrency = 2,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxPatents) > 0 ? Number(maxPatents) : Infinity;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
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
    await Actor.exit();
}

function normalizePatentId(s) {
    if (!s) return null;
    const id = String(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return id || null;
}

function buildSearchQuery(rawQuery) {
    const parts = [];
    if (rawQuery) parts.push(rawQuery);
    if (yearFrom > 0 || yearTo > 0) {
        const lo = yearFrom > 0 ? `${yearFrom}0101` : '';
        const hi = yearTo > 0 ? `${yearTo}1231` : '';
        if (lo) parts.push(`after:filing:${lo}`);
        if (hi) parts.push(`before:filing:${hi}`);
    }
    if (statusFilter === 'grant') parts.push('status:GRANT');
    if (statusFilter === 'application') parts.push('status:APPLICATION');
    for (const c of cpcList) parts.push(`CPC=${c}`);
    for (const j of jurisdictionSet) parts.push(`country:${j}`);
    return parts.filter(Boolean).join(' ');
}

function buildSearchUrl(rawQuery, page = 0) {
    const q = buildSearchQuery(rawQuery);
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('hl', language);
    params.set('num', '10');
    if (page > 0) params.set('page', String(page));
    return `${PATENTS_BASE}/?${params.toString()}`;
}

function buildPatentUrl(patentId) {
    return `${PATENTS_BASE}/patent/${patentId}/${language}`;
}

const startUrls = [];
for (const q of queryList) {
    startUrls.push({ url: buildSearchUrl(q, 0), userData: { label: 'search', query: q, rawSeed: q, page: 0 } });
}
for (const a of assigneeList) {
    const q = `assignee:"${a}"`;
    startUrls.push({ url: buildSearchUrl(q, 0), userData: { label: 'search', query: q, rawSeed: a, page: 0 } });
}
for (const inv of inventorList) {
    const q = `inventor:"${inv}"`;
    startUrls.push({ url: buildSearchUrl(q, 0), userData: { label: 'search', query: q, rawSeed: inv, page: 0 } });
}
for (const id of patentIdList) {
    startUrls.push({ url: buildPatentUrl(id), userData: { label: 'detail', patentId: id, fromSearch: false } });
}

log.info(`Seeds: ${startUrls.length} (${queryList.length} queries, ${assigneeList.length} assignees, ${inventorList.length} inventors, ${patentIdList.length} direct patent IDs).`);

const wantsDetailFetch = fetchClaims || fetchDescription || fetchCitations || fetchCitedBy || fetchFamily;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(8, Number(concurrency) || 2)),
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ request, page, log: ll }) {
        const { label } = request.userData;
        if (navigationDelayMs > 0) {
            await page.waitForTimeout(navigationDelayMs);
        }

        if (label === 'search') {
            await handleSearchPage({ request, page, ll });
        } else if (label === 'detail') {
            await handleDetailPage({ request, page, ll });
        } else {
            ll.warning(`Unknown label: ${label}`);
        }
    },
    failedRequestHandler({ request, log: ll }) {
        ll.warning(`Failed: ${request.url} after retries.`);
    },
});

async function handleSearchPage({ request, page, ll }) {
    const { query, rawSeed, page: pageIdx = 0 } = request.userData;

    await page.waitForSelector('search-result-item, state-modifier[data-result]', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const results = await page.$$eval(
        'search-result-item',
        (nodes) => nodes.slice(0, 20).map((n) => {
            const root = n.shadowRoot || n;
            const stateMod = n.querySelector('state-modifier') || root.querySelector?.('state-modifier');
            const dataResult = stateMod?.getAttribute('data-result') || null;
            const id = stateMod?.getAttribute('data-result')?.split('/')?.[1] || stateMod?.getAttribute('data-id') || null;
            const title = (n.querySelector('h3, h4, span.result-title') || root.querySelector?.('h3, h4, span.result-title'))?.textContent?.trim() || null;
            const snippet = (n.querySelector('.abstract, .snippet') || root.querySelector?.('.abstract, .snippet'))?.textContent?.trim() || null;
            const meta = (n.querySelector('.metadata, .result-source') || root.querySelector?.('.metadata, .result-source'))?.textContent?.trim() || null;
            return { id, title, snippet, meta, dataResult };
        })
    ).catch(() => []);

    if (results.length === 0) {
        const fallback = await page.$$eval(
            'state-modifier[data-result]',
            (nodes) => nodes.slice(0, 20).map((n) => ({
                id: n.getAttribute('data-result')?.split('/')?.[1] || null,
                title: n.querySelector('h3, h4, span')?.textContent?.trim() || null,
                snippet: n.parentElement?.querySelector('.abstract, .snippet')?.textContent?.trim() || null,
                meta: n.parentElement?.querySelector('.metadata')?.textContent?.trim() || null,
                dataResult: n.getAttribute('data-result'),
            }))
        ).catch(() => []);
        results.push(...fallback);
    }

    let pushedThisPage = 0;
    for (const r of results) {
        if (pushedRows >= cap) break;
        if (!r.id) continue;
        const patentId = normalizePatentId(r.id);
        if (!patentId) continue;
        if (dedupe && seenPatents.has(patentId)) continue;

        if (wantsDetailFetch || fetchPdf) {
            await crawler.addRequests([{
                url: buildPatentUrl(patentId),
                userData: { label: 'detail', patentId, fromSearch: true, baseRow: { searchTitle: r.title, searchSnippet: r.snippet, searchMeta: r.meta, sourceQuery: query, sourceSeed: rawSeed } },
            }]);
        } else {
            await Actor.pushData({
                publicationNumber: patentId,
                title: r.title,
                snippet: r.snippet,
                meta: r.meta,
                url: buildPatentUrl(patentId),
                sourceQuery: query,
                sourceSeed: rawSeed,
                scrapedAt: new Date().toISOString(),
            });
            pushedRows += 1;
            seenPatents.add(patentId);
        }
        pushedThisPage += 1;
    }

    ll.info(`[search] page ${pageIdx + 1} for "${rawSeed}": ${results.length} results, queued ${pushedThisPage}, pushed total ${pushedRows}/${cap === Infinity ? '∞' : cap}.`);

    if (pushedRows >= cap || pushedThisPage === 0) return;
    if (pageIdx + 1 >= maxPagesPerQuery) return;

    await crawler.addRequests([{
        url: buildSearchUrl(query, pageIdx + 1),
        userData: { label: 'search', query, rawSeed, page: pageIdx + 1 },
    }]);
}

async function handleDetailPage({ request, page, ll }) {
    const { patentId, baseRow = {} } = request.userData;

    await page.waitForSelector('h1, h1[itemprop="title"], .important-people, dd[itemprop="inventor"]', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const detail = await page.evaluate(({ wantClaims, wantDesc, wantCitations, wantCitedBy, wantFamily, wantPdf }) => {
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const all = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => el.textContent?.trim() || null).filter(Boolean);
        const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;

        const title = text('h1[itemprop="title"]') || text('h1');
        const abstract = text('div.abstract, section.abstract, abstract');

        const inventors = all('dd[itemprop="inventor"]');
        const assigneesOriginal = all('dd[itemprop="assigneeOriginal"]');
        const assigneesCurrent = all('dd[itemprop="assigneeCurrent"]');

        const filingDate = attr('time[itemprop="filingDate"]', 'datetime') || text('time[itemprop="filingDate"]');
        const publicationDate = attr('time[itemprop="publicationDate"]', 'datetime') || text('time[itemprop="publicationDate"]');
        const priorityDate = attr('time[itemprop="priorityDate"]', 'datetime') || text('time[itemprop="priorityDate"]');
        const grantDate = attr('time[itemprop="grantDate"]', 'datetime') || text('time[itemprop="grantDate"]');

        const cpcCodes = Array.from(document.querySelectorAll('ul[itemprop="cpcs"] li[itemprop="classifications"], li[itemprop="cpcs"] span[itemprop="Code"]')).map((el) => el.textContent?.trim()).filter(Boolean);
        const ipcCodes = Array.from(document.querySelectorAll('ul[itemprop="ipcs"] li, li[itemprop="ipcs"] span[itemprop="Code"]')).map((el) => el.textContent?.trim()).filter(Boolean);

        const legalStatus = text('span[itemprop="status"]') || text('.legal-status');
        const applicationNumber = text('dd[itemprop="applicationNumber"]');
        const familyId = text('dd[itemprop="familyId"]');

        const out = {
            title,
            abstract,
            inventors,
            assigneesOriginal,
            assigneesCurrent,
            filingDate,
            publicationDate,
            priorityDate,
            grantDate,
            applicationNumber,
            familyId,
            cpcCodes: [...new Set(cpcCodes)],
            ipcCodes: [...new Set(ipcCodes)],
            legalStatus,
        };

        if (wantClaims) {
            out.claims = text('section[itemprop="claims"]') || text('.claims') || text('section#claims');
        }
        if (wantDesc) {
            out.description = text('section[itemprop="description"]') || text('.description') || text('section#description');
        }
        if (wantCitations) {
            out.citedPatents = Array.from(document.querySelectorAll('tr[itemprop="backwardReferencesOrig"], tr[itemprop="backwardReferences"]')).map((tr) => ({
                publicationNumber: tr.querySelector('span[itemprop="publicationNumber"]')?.textContent?.trim() || null,
                primaryExaminer: tr.querySelector('span[itemprop="primaryExaminer"]')?.textContent?.trim() || null,
                priorityDate: tr.querySelector('time[itemprop="priorityDate"]')?.getAttribute('datetime') || null,
                publicationDate: tr.querySelector('time[itemprop="publicationDate"]')?.getAttribute('datetime') || null,
                assignee: tr.querySelector('span[itemprop="assigneeOriginal"]')?.textContent?.trim() || null,
                title: tr.querySelector('span[itemprop="title"]')?.textContent?.trim() || null,
            })).filter((c) => c.publicationNumber);
            out.citedNonPatentLiterature = Array.from(document.querySelectorAll('dd[itemprop="nplCitations"]')).map((el) => el.textContent?.trim()).filter(Boolean);
        }
        if (wantCitedBy) {
            out.citingPatents = Array.from(document.querySelectorAll('tr[itemprop="forwardReferencesOrig"], tr[itemprop="forwardReferences"]')).map((tr) => ({
                publicationNumber: tr.querySelector('span[itemprop="publicationNumber"]')?.textContent?.trim() || null,
                priorityDate: tr.querySelector('time[itemprop="priorityDate"]')?.getAttribute('datetime') || null,
                publicationDate: tr.querySelector('time[itemprop="publicationDate"]')?.getAttribute('datetime') || null,
                assignee: tr.querySelector('span[itemprop="assigneeOriginal"]')?.textContent?.trim() || null,
                title: tr.querySelector('span[itemprop="title"]')?.textContent?.trim() || null,
            })).filter((c) => c.publicationNumber);
        }
        if (wantFamily) {
            out.family = Array.from(document.querySelectorAll('tr[itemprop="familyMembers"]')).map((tr) => ({
                publicationNumber: tr.querySelector('span[itemprop="publicationNumber"]')?.textContent?.trim() || null,
                country: tr.querySelector('span[itemprop="countryCode"]')?.textContent?.trim() || null,
                publicationDate: tr.querySelector('time[itemprop="publicationDate"]')?.getAttribute('datetime') || null,
                title: tr.querySelector('span[itemprop="title"]')?.textContent?.trim() || null,
            })).filter((m) => m.publicationNumber);
        }
        if (wantPdf) {
            out.pdfUrl = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute('content') || null;
        }
        return out;
    }, {
        wantClaims: !!fetchClaims,
        wantDesc: !!fetchDescription,
        wantCitations: !!fetchCitations,
        wantCitedBy: !!fetchCitedBy,
        wantFamily: !!fetchFamily,
        wantPdf: !!fetchPdf,
    });

    const row = {
        publicationNumber: patentId,
        url: buildPatentUrl(patentId),
        ...baseRow,
        ...detail,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.pushData(row);
    pushedRows += 1;
    seenPatents.add(patentId);
    ll.info(`[detail] ${patentId}: "${(detail.title || '').slice(0, 60)}", ${detail.inventors?.length || 0} inventors, ${detail.cpcCodes?.length || 0} CPC.`);
}

await crawler.run(startUrls);

if (seenStore) {
    await seenStore.setValue('seen-patents', [...seenPatents]);
}

log.info(`Done. Pushed ${pushedRows} rows.`);
await Actor.exit();
