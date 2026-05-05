// Pharma Research & Clinical Trial Monitor
//
// Pulls PubMed papers and ClinicalTrials.gov studies via their public APIs.
// One row per record. Mixes queries with direct PMIDs and NCT IDs in one run.
//
// Strategy
// --------
// 1. PubMed: NCBI E-utilities (esearch + efetch). esearch returns PMIDs, efetch
//    returns full XML records in batches of 100. Parse with fast-xml-parser.
// 2. ClinicalTrials.gov: REST API v2 (JSON). Paginate via nextPageToken.
// 3. Optional enrichment: NCBI iCite for citation counts and Relative Citation
//    Ratio. ELink for reference and citing PMID lists.
// 4. Dedupe across runs by PMID and NCT ID via key value store.

import { Actor, log } from 'apify';
import { XMLParser } from 'fast-xml-parser';

const PUBMED_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const ICITE_BASE = 'https://icite.od.nih.gov/api/pubs';
const CT_BASE = 'https://clinicaltrials.gov/api/v2/studies';

const FREE_TIER_ITEMS = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    pubmedQueries = [],
    clinicalTrialsQueries = [],
    pmids = [],
    nctIds = [],
    dateFrom = '',
    dateTo = '',
    publicationTypes = [],
    studyStatus = [],
    phases = [],
    studyTypes = [],
    fetchAbstracts = true,
    fetchMeshTerms = true,
    fetchReferences = false,
    fetchTrialResults = true,
    maxRecords = 200,
    maxPerQuery = 100,
    ncbiApiKey = '',
    email = '',
    dedupe = true,
    navigationDelayMs = 350,
} = input;

const cap = Number(maxRecords) > 0 ? Number(maxRecords) : Infinity;
const perQueryCap = Math.max(1, Number(maxPerQuery) || 100);
const delayMs = Math.max(0, Number(navigationDelayMs) || 0);

const seenStore = dedupe ? await Actor.openKeyValueStore('pubmed-clinical-trials-seen') : null;
const seenPmids = new Set(seenStore ? (await seenStore.getValue('seen-pmids')) || [] : []);
const seenNctIds = new Set(seenStore ? (await seenStore.getValue('seen-nct-ids')) || [] : []);

let pushedRows = 0;

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
});

const userAgent = `Scrapemint-PubMedCT/0.1 (${email || 'apify-actor'}; +https://apify.com)`;

const pubmedQueryList = toStringList(pubmedQueries);
const ctQueryList = toStringList(clinicalTrialsQueries);
const pmidList = toStringList(pmids);
const nctIdList = toStringList(nctIds).map(normalizeNctId).filter(Boolean);

if (pubmedQueryList.length === 0 && ctQueryList.length === 0 && pmidList.length === 0 && nctIdList.length === 0) {
    log.warning('No input. Provide at least one entry in pubmedQueries[], clinicalTrialsQueries[], pmids[], or nctIds[].');
    await Actor.exit();
}

log.info(`Seeds: ${pubmedQueryList.length} PubMed queries, ${ctQueryList.length} CT.gov queries, ${pmidList.length} direct PMIDs, ${nctIdList.length} direct NCT IDs.`);

function maybeCharge() {
    if (pushedRows > FREE_TIER_ITEMS) {
        Actor.charge({ eventName: 'result_item' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
}

function toStringList(arr) {
    return (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean);
}

function normalizeNctId(id) {
    const m = String(id).trim().toUpperCase().match(/NCT\d{8}/);
    return m ? m[0] : null;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, attempt = 1) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
        if (res.status === 429 || res.status === 503) throw new Error(`Rate limited ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
    } catch (err) {
        if (attempt >= 4) throw err;
        const wait = 1000 * 2 ** (attempt - 1);
        log.warning(`fetchJson failed (${err.message}), retry ${attempt} in ${wait}ms: ${url.slice(0, 120)}`);
        await sleep(wait);
        return fetchJson(url, attempt + 1);
    }
}

async function fetchText(url, attempt = 1) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
        if (res.status === 429 || res.status === 503) throw new Error(`Rate limited ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.text();
    } catch (err) {
        if (attempt >= 4) throw err;
        const wait = 1000 * 2 ** (attempt - 1);
        log.warning(`fetchText failed (${err.message}), retry ${attempt} in ${wait}ms: ${url.slice(0, 120)}`);
        await sleep(wait);
        return fetchText(url, attempt + 1);
    }
}

function buildPubmedDateFilter() {
    if (!dateFrom && !dateTo) return '';
    const from = dateFrom ? dateFrom.replace(/-/g, '/') : '1900/01/01';
    const to = dateTo ? dateTo.replace(/-/g, '/') : '3000/01/01';
    return ` AND ${from}:${to}[PDAT]`;
}

function buildPubmedTypeFilter() {
    if (!Array.isArray(publicationTypes) || publicationTypes.length === 0) return '';
    const parts = publicationTypes.map((t) => `"${String(t).replace(/"/g, '')}"[PT]`).join(' OR ');
    return ` AND (${parts})`;
}

function appendApiKey(url) {
    if (!ncbiApiKey) return url;
    return url + (url.includes('?') ? '&' : '?') + `api_key=${encodeURIComponent(ncbiApiKey)}`;
}

async function esearchPmids(query) {
    const term = `${query}${buildPubmedTypeFilter()}${buildPubmedDateFilter()}`;
    const ids = [];
    const batchSize = 200;
    let retstart = 0;
    while (ids.length < perQueryCap) {
        const want = Math.min(batchSize, perQueryCap - ids.length);
        const params = new URLSearchParams({
            db: 'pubmed',
            term,
            retmode: 'json',
            retmax: String(want),
            retstart: String(retstart),
            sort: 'most+recent',
        });
        const url = appendApiKey(`${PUBMED_BASE}/esearch.fcgi?${params.toString()}`);
        await sleep(delayMs);
        const data = await fetchJson(url);
        const idlist = data?.esearchresult?.idlist || [];
        if (idlist.length === 0) break;
        for (const id of idlist) ids.push(id);
        const total = Number(data?.esearchresult?.count || 0);
        retstart += idlist.length;
        if (retstart >= total) break;
        if (idlist.length < want) break;
    }
    return ids;
}

async function efetchPubmedRecords(idChunk) {
    const params = new URLSearchParams({
        db: 'pubmed',
        id: idChunk.join(','),
        retmode: 'xml',
    });
    const url = appendApiKey(`${PUBMED_BASE}/efetch.fcgi?${params.toString()}`);
    await sleep(delayMs);
    const xml = await fetchText(url);
    const parsed = xmlParser.parse(xml);
    const articles = parsed?.PubmedArticleSet?.PubmedArticle;
    if (!articles) return [];
    return Array.isArray(articles) ? articles : [articles];
}

function asArray(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function textOf(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
        if (typeof v['#text'] === 'string') return v['#text'];
        const parts = Object.values(v).filter((x) => typeof x === 'string');
        if (parts.length) return parts.join(' ');
    }
    return String(v);
}

function joinAbstract(abstractNode) {
    if (!abstractNode) return null;
    const parts = asArray(abstractNode.AbstractText);
    if (parts.length === 0) return null;
    return parts
        .map((p) => {
            if (typeof p === 'string') return p;
            const label = p?.['@_Label'];
            const text = textOf(p);
            return label ? `${label}: ${text}` : text;
        })
        .filter(Boolean)
        .join('\n')
        .trim() || null;
}

function parsePubmedRow(article) {
    const med = article?.MedlineCitation || {};
    const cit = article?.PubmedData || {};
    const articleNode = med.Article || {};
    const journal = articleNode.Journal || {};
    const issue = journal.JournalIssue || {};

    const pmid = textOf(med.PMID);
    const title = textOf(articleNode.ArticleTitle);
    const abstract = fetchAbstracts ? joinAbstract(articleNode.Abstract) : null;

    const authors = asArray(articleNode.AuthorList?.Author).map((a) => {
        const last = textOf(a.LastName);
        const fore = textOf(a.ForeName);
        const init = textOf(a.Initials);
        const collective = textOf(a.CollectiveName);
        const name = collective || [fore || init, last].filter(Boolean).join(' ');
        const affiliations = asArray(a.AffiliationInfo).map((af) => textOf(af.Affiliation)).filter(Boolean);
        const orcid = asArray(a.Identifier).find((i) => i?.['@_Source'] === 'ORCID');
        return {
            name: name || null,
            lastName: last || null,
            foreName: fore || null,
            affiliations,
            orcid: orcid ? textOf(orcid) : null,
        };
    });

    const meshTerms = fetchMeshTerms ? asArray(med.MeshHeadingList?.MeshHeading).map((m) => {
        const descriptor = m?.DescriptorName;
        return {
            term: textOf(descriptor),
            ui: descriptor?.['@_UI'] || null,
            major: descriptor?.['@_MajorTopicYN'] === 'Y',
            qualifiers: asArray(m.QualifierName).map((q) => textOf(q)).filter(Boolean),
        };
    }) : [];

    const keywords = asArray(med.KeywordList?.Keyword).map((k) => textOf(k)).filter(Boolean);

    const ids = asArray(cit?.ArticleIdList?.ArticleId);
    const idMap = {};
    for (const i of ids) {
        const t = i?.['@_IdType'];
        const v = textOf(i);
        if (t && v) idMap[t] = v;
    }

    const grants = asArray(articleNode.GrantList?.Grant).map((g) => ({
        grantId: textOf(g.GrantID),
        agency: textOf(g.Agency),
        country: textOf(g.Country),
    }));

    const pubTypes = asArray(articleNode.PublicationTypeList?.PublicationType).map((p) => textOf(p)).filter(Boolean);

    const pubDate = issue?.PubDate || articleNode.ArticleDate;
    const year = textOf(pubDate?.Year) || null;
    const month = textOf(pubDate?.Month) || null;
    const day = textOf(pubDate?.Day) || null;

    return {
        type: 'pubmed',
        pmid,
        doi: idMap.doi || null,
        pmcid: idMap.pmc || null,
        title,
        abstract,
        authors,
        journal: textOf(journal.Title) || null,
        journalIso: textOf(journal.ISOAbbreviation) || null,
        issn: textOf(journal.ISSN) || null,
        volume: textOf(issue.Volume) || null,
        issue: textOf(issue.Issue) || null,
        pages: textOf(articleNode.Pagination?.MedlinePgn) || null,
        publicationYear: year ? Number(year) : null,
        publicationDate: [year, month, day].filter(Boolean).join('-') || null,
        publicationTypes: pubTypes,
        meshTerms,
        keywords,
        grants,
        language: textOf(articleNode.Language) || null,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
        scrapedAt: new Date().toISOString(),
    };
}

async function enrichWithICite(rows) {
    const ids = rows.map((r) => r.pmid).filter(Boolean);
    if (ids.length === 0) return;
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    const map = new Map();
    for (const chunk of chunks) {
        const url = `${ICITE_BASE}?pmids=${chunk.join(',')}`;
        await sleep(delayMs);
        try {
            const data = await fetchJson(url);
            for (const p of data?.data || []) map.set(String(p.pmid), p);
        } catch (e) {
            log.debug(`iCite enrichment failed: ${e.message}`);
        }
    }
    for (const row of rows) {
        const m = map.get(String(row.pmid));
        if (!m) continue;
        row.citationCount = m.citation_count ?? null;
        row.relativeCitationRatio = m.relative_citation_ratio ?? null;
        row.fieldCitationRate = m.field_citation_rate ?? null;
        row.isHumanResearch = m.is_research_article ?? null;
        row.expectedCitations = m.expected_citations_per_year ?? null;
    }
}

async function fetchPubmedReferences(pmid) {
    const params = new URLSearchParams({
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: pmid,
        retmode: 'json',
        linkname: 'pubmed_pubmed_refs',
    });
    const url = appendApiKey(`${PUBMED_BASE}/elink.fcgi?${params.toString()}`);
    await sleep(delayMs);
    try {
        const data = await fetchJson(url);
        const linkset = data?.linksets?.[0];
        return (linkset?.linksetdbs?.[0]?.links || []).map(String);
    } catch (e) {
        log.debug(`elink refs failed for ${pmid}: ${e.message}`);
        return [];
    }
}

async function fetchPubmedCitedBy(pmid) {
    const params = new URLSearchParams({
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: pmid,
        retmode: 'json',
        linkname: 'pubmed_pubmed_citedin',
    });
    const url = appendApiKey(`${PUBMED_BASE}/elink.fcgi?${params.toString()}`);
    await sleep(delayMs);
    try {
        const data = await fetchJson(url);
        const linkset = data?.linksets?.[0];
        return (linkset?.linksetdbs?.[0]?.links || []).map(String);
    } catch (e) {
        log.debug(`elink citedin failed for ${pmid}: ${e.message}`);
        return [];
    }
}

async function processPubmedIds(ids, sourceQuery = null) {
    const fresh = ids.filter((id) => !(dedupe && seenPmids.has(String(id))));
    log.info(`PubMed: efetch ${fresh.length} records (skipped ${ids.length - fresh.length} already seen).`);
    for (let i = 0; i < fresh.length; i += 100) {
        if (pushedRows >= cap) break;
        const chunk = fresh.slice(i, i + 100);
        const articles = await efetchPubmedRecords(chunk);
        const rows = articles.map(parsePubmedRow).filter((r) => r.pmid);
        await enrichWithICite(rows);

        for (const row of rows) {
            if (pushedRows >= cap) break;
            row.sourceQuery = sourceQuery;

            if (fetchReferences && row.pmid) {
                const [refs, citedBy] = await Promise.all([
                    fetchPubmedReferences(row.pmid),
                    fetchPubmedCitedBy(row.pmid),
                ]);
                row.references = refs;
                row.citedByPmids = citedBy;
            }

            await Actor.pushData(row);
            pushedRows += 1;
            maybeCharge();
            seenPmids.add(String(row.pmid));
        }
    }
}

function buildCtFilters() {
    const params = [];
    if (Array.isArray(studyStatus) && studyStatus.length > 0) {
        params.push(['filter.overallStatus', studyStatus.join(',')]);
    }
    const advanced = [];
    if (Array.isArray(phases) && phases.length > 0) {
        advanced.push(`AREA[Phase]COVERAGE[FullMatch] (${phases.join(' OR ')})`);
    }
    if (Array.isArray(studyTypes) && studyTypes.length > 0) {
        advanced.push(`AREA[StudyType]COVERAGE[FullMatch] (${studyTypes.join(' OR ')})`);
    }
    if (dateFrom || dateTo) {
        const from = dateFrom || '1900-01-01';
        const to = dateTo || '3000-01-01';
        advanced.push(`AREA[LastUpdatePostDate]RANGE[${from},${to}]`);
    }
    if (advanced.length > 0) {
        params.push(['filter.advanced', advanced.join(' AND ')]);
    }
    return params;
}

function parseCtRow(study, sourceQuery = null) {
    const proto = study?.protocolSection || {};
    const ident = proto.identificationModule || {};
    const status = proto.statusModule || {};
    const sponsor = proto.sponsorCollaboratorsModule || {};
    const desc = proto.descriptionModule || {};
    const cond = proto.conditionsModule || {};
    const design = proto.designModule || {};
    const arms = proto.armsInterventionsModule || {};
    const outcomes = proto.outcomesModule || {};
    const eligibility = proto.eligibilityModule || {};
    const contacts = proto.contactsLocationsModule || {};
    const oversight = proto.oversightModule || {};

    const nctId = ident?.nctId || null;
    const interventions = (arms?.interventions || []).map((iv) => ({
        type: iv.type || null,
        name: iv.name || null,
        description: iv.description || null,
        otherNames: iv.otherNames || [],
    }));
    const locations = (contacts?.locations || []).map((l) => ({
        facility: l.facility || null,
        city: l.city || null,
        state: l.state || null,
        country: l.country || null,
        status: l.status || null,
    }));
    const collaborators = (sponsor?.collaborators || []).map((c) => c.name).filter(Boolean);

    return {
        type: 'clinical_trial',
        nctId,
        title: ident?.briefTitle || null,
        officialTitle: ident?.officialTitle || null,
        url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
        status: status?.overallStatus || null,
        whyStopped: status?.whyStopped || null,
        startDate: status?.startDateStruct?.date || null,
        primaryCompletionDate: status?.primaryCompletionDateStruct?.date || null,
        completionDate: status?.completionDateStruct?.date || null,
        firstPostedDate: status?.studyFirstPostDateStruct?.date || null,
        lastUpdatePostedDate: status?.lastUpdatePostDateStruct?.date || null,
        studyType: design?.studyType || null,
        phases: design?.phases || [],
        enrollment: design?.enrollmentInfo?.count ?? null,
        enrollmentType: design?.enrollmentInfo?.type || null,
        allocation: design?.designInfo?.allocation || null,
        masking: design?.designInfo?.maskingInfo?.masking || null,
        primaryPurpose: design?.designInfo?.primaryPurpose || null,
        leadSponsor: sponsor?.leadSponsor?.name || null,
        leadSponsorClass: sponsor?.leadSponsor?.class || null,
        collaborators,
        conditions: cond?.conditions || [],
        keywords: cond?.keywords || [],
        interventions,
        briefSummary: desc?.briefSummary || null,
        detailedDescription: desc?.detailedDescription || null,
        primaryOutcomes: (outcomes?.primaryOutcomes || []).map((o) => ({
            measure: o.measure || null,
            description: o.description || null,
            timeFrame: o.timeFrame || null,
        })),
        secondaryOutcomes: (outcomes?.secondaryOutcomes || []).map((o) => ({
            measure: o.measure || null,
            timeFrame: o.timeFrame || null,
        })),
        eligibilityCriteria: eligibility?.eligibilityCriteria || null,
        sex: eligibility?.sex || null,
        minimumAge: eligibility?.minimumAge || null,
        maximumAge: eligibility?.maximumAge || null,
        healthyVolunteers: eligibility?.healthyVolunteers ?? null,
        locations,
        locationCount: locations.length,
        hasResults: study?.hasResults ?? null,
        resultsSection: fetchTrialResults ? (study?.resultsSection || null) : null,
        oversightHasDmc: oversight?.oversightHasDmc ?? null,
        sourceQuery,
        scrapedAt: new Date().toISOString(),
    };
}

async function fetchCtPage(query, pageToken = null) {
    const params = new URLSearchParams();
    if (query) params.set('query.term', query);
    params.set('pageSize', '100');
    if (pageToken) params.set('pageToken', pageToken);
    for (const [k, v] of buildCtFilters()) params.append(k, v);
    if (fetchTrialResults) params.set('fields', '');
    const url = `${CT_BASE}?${params.toString()}`;
    await sleep(delayMs);
    return fetchJson(url);
}

async function processCtQuery(query) {
    let pageToken = null;
    let count = 0;
    while (count < perQueryCap && pushedRows < cap) {
        const data = await fetchCtPage(query, pageToken);
        const studies = data?.studies || [];
        if (studies.length === 0) break;
        for (const study of studies) {
            if (count >= perQueryCap || pushedRows >= cap) break;
            const row = parseCtRow(study, query);
            if (!row.nctId) continue;
            if (dedupe && seenNctIds.has(row.nctId)) continue;
            await Actor.pushData(row);
            pushedRows += 1;
            count += 1;
            maybeCharge();
            seenNctIds.add(row.nctId);
        }
        pageToken = data?.nextPageToken;
        if (!pageToken) break;
    }
    log.info(`CT.gov [${query}]: pushed ${count}, total ${pushedRows}/${cap === Infinity ? '∞' : cap}.`);
}

async function processCtIds(ids) {
    for (const nctId of ids) {
        if (pushedRows >= cap) break;
        if (dedupe && seenNctIds.has(nctId)) continue;
        const url = `${CT_BASE}/${nctId}`;
        await sleep(delayMs);
        try {
            const study = await fetchJson(url);
            const row = parseCtRow(study, null);
            if (!row.nctId) continue;
            await Actor.pushData(row);
            pushedRows += 1;
            maybeCharge();
            seenNctIds.add(row.nctId);
        } catch (e) {
            log.warning(`Failed to fetch ${nctId}: ${e.message}`);
        }
    }
}

try {
    for (const q of pubmedQueryList) {
        if (pushedRows >= cap) break;
        log.info(`PubMed query: "${q}"`);
        const ids = await esearchPmids(q);
        log.info(`PubMed [${q}]: esearch returned ${ids.length} PMIDs.`);
        await processPubmedIds(ids, q);
    }

    if (pmidList.length > 0 && pushedRows < cap) {
        await processPubmedIds(pmidList, null);
    }

    for (const q of ctQueryList) {
        if (pushedRows >= cap) break;
        log.info(`ClinicalTrials.gov query: "${q}"`);
        await processCtQuery(q);
    }

    if (nctIdList.length > 0 && pushedRows < cap) {
        log.info(`ClinicalTrials.gov: fetching ${nctIdList.length} direct NCT IDs.`);
        await processCtIds(nctIdList);
    }
} finally {
    if (seenStore) {
        await seenStore.setValue('seen-pmids', [...seenPmids]);
        await seenStore.setValue('seen-nct-ids', [...seenNctIds]);
    }
}

log.info(`Done. Pushed ${pushedRows} rows.`);
await Actor.exit();
