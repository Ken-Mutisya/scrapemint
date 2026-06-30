// Google Scholar Scraper
//
// Search Scholar at scale, walk pages of results, optionally enrich each paper
// with author affiliations + h-index, full citing paper lists, BibTeX exports,
// and the cluster of all versions.
//
// Strategy
// --------
// 1. Build seed URLs from the four input modes: queries, authorUrls, clusterIds,
//    paperUrls. Each seed is tagged with a label so the router knows what it is.
// 2. Crawl with Playwright + residential proxy. Scholar fingerprints datacenter
//    IPs hard.
// 3. For search pages: parse div.gs_r.gs_or.gs_scl blocks, push one row per
//    paper, queue the next page if under maxPagesPerQuery and we have a "Next"
//    link.
// 4. For author pages: parse the citation summary box, then walk the publications
//    table.
// 5. Enrichment toggles run after the base scrape: BibTeX modal per paper,
//    cited-by list, all-versions cluster.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const SCHOLAR_BASE = 'https://scholar.google.com';

await Actor.init();
const __chargeJobs = [];

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    authorUrls = [],
    clusterIds = [],
    paperUrls = [],
    yearFrom = 0,
    yearTo = 0,
    sortBy = 'relevance',
    language = 'en',
    includePatents = false,
    includeCaseLaw = false,
    fetchAuthorProfiles = false,
    fetchCitedBy = false,
    minCitationsForCitedBy = 50,
    maxCitedByPapers = 20,
    fetchBibtex = false,
    fetchVersions = false,
    maxPapers = 100,
    maxPagesPerQuery = 10,
    dedupe = true,
    navigationDelayMs = 4500,
    concurrency = 1,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxPapers) > 0 ? Number(maxPapers) : Infinity;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('google-scholar-scraper-seen') : null;
const seenClusters = new Set(seenStore ? (await seenStore.getValue('seen-clusters')) || [] : []);
const authorCache = new Map();
let pushedRows = 0;

const queryList = (Array.isArray(queries) ? queries : []).map((q) => String(q).trim()).filter(Boolean);
const authorList = (Array.isArray(authorUrls) ? authorUrls : []).map((u) => String(u).trim()).filter(Boolean);
const clusterList = (Array.isArray(clusterIds) ? clusterIds : []).map((c) => String(c).trim()).filter(Boolean);
const paperUrlList = (Array.isArray(paperUrls) ? paperUrls : []).map((u) => String(u).trim()).filter(Boolean);

if (queryList.length === 0 && authorList.length === 0 && clusterList.length === 0 && paperUrlList.length === 0) {
    log.warning('No input. Provide at least one entry in queries[], authorUrls[], clusterIds[], or paperUrls[].');
    await Promise.allSettled(__chargeJobs);
await Actor.exit();
}

function buildSearchUrl(query, page = 0) {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('hl', language);
    if (yearFrom > 0) params.set('as_ylo', String(yearFrom));
    if (yearTo > 0) params.set('as_yhi', String(yearTo));
    if (sortBy === 'date') params.set('scisbd', '1');
    const sdt = [];
    sdt.push('0');
    if (includePatents) sdt.push('7');
    if (includeCaseLaw) sdt.push('5');
    params.set('as_sdt', sdt.join(','));
    if (page > 0) params.set('start', String(page * 10));
    return `${SCHOLAR_BASE}/scholar?${params.toString()}`;
}

function buildClusterUrl(clusterId, page = 0) {
    const params = new URLSearchParams();
    params.set('cluster', String(clusterId));
    params.set('hl', language);
    if (page > 0) params.set('start', String(page * 10));
    return `${SCHOLAR_BASE}/scholar?${params.toString()}`;
}

function buildCitedByUrl(clusterId, page = 0) {
    const params = new URLSearchParams();
    params.set('cites', String(clusterId));
    params.set('hl', language);
    if (page > 0) params.set('start', String(page * 10));
    return `${SCHOLAR_BASE}/scholar?${params.toString()}`;
}

const startUrls = [];
for (const q of queryList) {
    startUrls.push({
        url: buildSearchUrl(q, 0),
        userData: { label: 'search', query: q, page: 0 },
    });
}
for (const u of authorList) {
    startUrls.push({
        url: u,
        userData: { label: 'author', authorUrl: u },
    });
}
for (const c of clusterList) {
    startUrls.push({
        url: buildClusterUrl(c, 0),
        userData: { label: 'cluster', clusterId: c, page: 0 },
    });
}
for (const u of paperUrlList) {
    startUrls.push({
        url: u,
        userData: { label: 'paper', paperUrl: u },
    });
}

log.info(`Seeds: ${startUrls.length} (${queryList.length} queries, ${authorList.length} author profiles, ${clusterList.length} clusters, ${paperUrlList.length} paper URLs).`);

function isCaptchaPage(html) {
    if (!html) return false;
    return /id="gs_captcha_ccl"|"sorry\/index"|"unusual traffic"|"can't verify"/i.test(html);
}

function parseAuthorVenue(text) {
    if (!text) return { authors: [], year: null, venue: null, publisher: null };
    const parts = text.split(' - ').map((s) => s.trim());
    const authors = (parts[0] || '').split(',').map((a) => a.trim()).filter(Boolean);
    const middle = parts[1] || '';
    const yearMatch = middle.match(/\b(1[89]\d{2}|20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const venue = middle ? middle.replace(/,?\s*\b(1[89]\d{2}|20\d{2})\b\s*$/, '').trim() || null : null;
    const publisher = parts[2] || null;
    return { authors, year, venue, publisher };
}

function parseCitedByCount(text) {
    if (!text) return null;
    const m = text.match(/Cited by\s+(\d[\d,]*)/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
}

function parseVersionCount(text) {
    if (!text) return null;
    const m = text.match(/All\s+(\d+)\s+versions/i);
    return m ? Number(m[1]) : null;
}

function extractClusterIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/[?&](?:cluster|cites)=(\d+)/);
    return m ? m[1] : null;
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(8, Number(concurrency) || 1)),
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler({ request, page, enqueueLinks, log: ll }) {
        const { label } = request.userData;

        if (navigationDelayMs > 0) {
            await page.waitForTimeout(navigationDelayMs);
        }

        const html = await page.content();
        if (isCaptchaPage(html)) {
            ll.warning(`CAPTCHA on ${request.url}. Backing off.`);
            throw new Error('CAPTCHA');
        }

        if (label === 'search' || label === 'cluster') {
            await handleResultsPage({ request, page, ll });
        } else if (label === 'author') {
            await handleAuthorPage({ request, page, ll });
        } else if (label === 'paper') {
            await handlePaperPage({ request, page, ll });
        } else if (label === 'citedBy') {
            await handleCitedByPage({ request, page, ll });
        } else {
            ll.warning(`Unknown label: ${label}`);
        }
    },
    failedRequestHandler({ request, log: ll }) {
        ll.warning(`Failed: ${request.url} after retries.`);
    },
});

async function handleResultsPage({ request, page, ll }) {
    const { label, query, clusterId, page: pageIdx = 0 } = request.userData;

    const results = await page.$$eval('div.gs_r.gs_or.gs_scl', (blocks) => blocks.map((b) => {
        const titleA = b.querySelector('h3.gs_rt > a');
        const titleText = b.querySelector('h3.gs_rt')?.textContent?.trim() || null;
        const titleHref = titleA?.href || null;
        const authorVenue = b.querySelector('div.gs_a')?.textContent?.trim() || null;
        const authorLinks = Array.from(b.querySelectorAll('div.gs_a a')).map((a) => ({
            name: a.textContent?.trim() || null,
            url: a.href || null,
        }));
        const snippet = b.querySelector('div.gs_rs')?.textContent?.trim() || null;
        const links = Array.from(b.querySelectorAll('div.gs_fl a')).map((a) => ({
            text: a.textContent?.trim() || null,
            url: a.href || null,
        }));
        const pdfLink = b.querySelector('div.gs_or_ggsm a')?.href || null;
        const pdfLabel = b.querySelector('div.gs_or_ggsm a span.gs_ctg2')?.textContent?.trim() || null;
        const cid = b.getAttribute('data-cid') || null;
        return { titleText, titleHref, authorVenue, authorLinks, snippet, links, pdfLink, pdfLabel, cid };
    }));

    let pushedThisPage = 0;
    for (const r of results) {
        if (pushedRows >= cap) break;

        const { authors, year, venue, publisher } = parseAuthorVenue(r.authorVenue);
        const citedByLink = r.links.find((l) => /^Cited by/i.test(l.text || ''));
        const versionsLink = r.links.find((l) => /\bAll\s+\d+\s+versions/i.test(l.text || ''));
        const relatedLink = r.links.find((l) => /^Related articles/i.test(l.text || ''));
        const citedByCount = parseCitedByCount(citedByLink?.text);
        const versionCount = parseVersionCount(versionsLink?.text);
        const cid = r.cid || extractClusterIdFromUrl(citedByLink?.url) || extractClusterIdFromUrl(versionsLink?.url);

        if (dedupe && cid && seenClusters.has(cid)) {
            continue;
        }

        const enrichedAuthors = [];
        if (Array.isArray(r.authorLinks) && r.authorLinks.length > 0 && fetchAuthorProfiles) {
            for (const a of r.authorLinks) {
                if (!a.url) { enrichedAuthors.push({ ...a, profile: null }); continue; }
                if (authorCache.has(a.url)) {
                    enrichedAuthors.push({ ...a, profile: authorCache.get(a.url) });
                } else {
                    enrichedAuthors.push({ ...a, profile: null });
                    await crawler.addRequests([{
                        url: a.url,
                        userData: { label: 'author', authorUrl: a.url, fromPaper: r.titleText },
                    }]);
                }
            }
        }

        const row = {
            title: r.titleText,
            url: r.titleHref,
            scholarClusterId: cid,
            authors: authors,
            authorProfileLinks: r.authorLinks.filter((a) => a.url),
            year,
            venue,
            publisher,
            snippet: r.snippet,
            citedByCount,
            citedByUrl: citedByLink?.url || null,
            versionCount,
            versionsUrl: versionsLink?.url || null,
            relatedUrl: relatedLink?.url || null,
            pdfUrl: r.pdfLink,
            pdfLabel: r.pdfLabel,
            sourceQuery: label === 'search' ? query : null,
            sourceClusterId: label === 'cluster' ? clusterId : null,
            scrapedAt: new Date().toISOString(),
        };

        if (fetchBibtex && r.titleHref) {
            row.bibtex = await fetchBibtexForResult(page, r, ll).catch(() => null);
        }

        if (fetchCitedBy && cid && (citedByCount ?? 0) >= minCitationsForCitedBy && maxCitedByPapers > 0) {
            await crawler.addRequests([{
                url: buildCitedByUrl(cid, 0),
                userData: { label: 'citedBy', sourceClusterId: cid, sourceTitle: r.titleText, page: 0, collected: [] },
            }]);
        }

        if (fetchVersions && cid && (versionCount ?? 0) > 1) {
            await crawler.addRequests([{
                url: buildClusterUrl(cid, 0),
                userData: { label: 'cluster', clusterId: cid, page: 0 },
            }]);
        }

        await Actor.pushData(row);
        pushedRows += 1;
        if (pushedRows > 10) __chargeJobs.push(Actor.charge({ eventName: 'paper_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
        pushedThisPage += 1;
        if (cid) {
            seenClusters.add(cid);
        }
    }

    ll.info(`[${label}] page ${pageIdx + 1}: pushed ${pushedThisPage}, total ${pushedRows}/${cap === Infinity ? '∞' : cap}.`);

    if (pushedRows >= cap) return;

    const nextHref = await page.$eval('#gs_n a, td[align="left"] a', (a) => a.href).catch(() => null);
    const hasNext = !!nextHref && pageIdx + 1 < maxPagesPerQuery;
    if (hasNext) {
        if (label === 'search') {
            await crawler.addRequests([{
                url: buildSearchUrl(query, pageIdx + 1),
                userData: { label: 'search', query, page: pageIdx + 1 },
            }]);
        } else if (label === 'cluster') {
            await crawler.addRequests([{
                url: buildClusterUrl(clusterId, pageIdx + 1),
                userData: { label: 'cluster', clusterId, page: pageIdx + 1 },
            }]);
        }
    }
}

async function fetchBibtexForResult(page, r, ll) {
    if (!r.cid) return null;
    try {
        const citeBtn = await page.$(`div[data-cid="${r.cid}"] a.gs_or_cit, div[data-cid="${r.cid}"] a[href*="cites="]`);
        if (!citeBtn) return null;
        await page.click(`div[data-cid="${r.cid}"] a.gs_or_cit`).catch(() => {});
        await page.waitForSelector('#gs_citi a:has-text("BibTeX")', { timeout: 5000 }).catch(() => null);
        const bibUrl = await page.$eval('#gs_citi a:has-text("BibTeX")', (a) => a.href).catch(() => null);
        await page.click('#gs_md_cita-d-x').catch(() => {});
        if (!bibUrl) return null;
        const ctx = page.context();
        const resp = await ctx.request.get(bibUrl, { timeout: 15000 });
        if (!resp.ok()) return null;
        return (await resp.text()).trim();
    } catch (e) {
        ll.debug(`bibtex fetch failed: ${e.message}`);
        return null;
    }
}

async function handleAuthorPage({ request, page, ll }) {
    await page.waitForSelector('#gsc_prf_in', { timeout: 20000 }).catch(() => {});

    let prevCount = -1;
    for (let i = 0; i < 10; i += 1) {
        const moreBtn = await page.$('#gsc_bpf_more:not([disabled])');
        if (!moreBtn) break;
        const beforeRows = await page.$$eval('#gsc_a_b > tr.gsc_a_tr', (rs) => rs.length).catch(() => 0);
        if (beforeRows === prevCount) break;
        prevCount = beforeRows;
        await moreBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
    }

    const profile = await page.evaluate(() => {
        const name = document.querySelector('#gsc_prf_in')?.textContent?.trim() || null;
        const ils = Array.from(document.querySelectorAll('.gsc_prf_il')).map((el) => el.textContent?.trim() || null);
        const interests = Array.from(document.querySelectorAll('a.gsc_prf_inta')).map((a) => a.textContent?.trim() || null);
        const stats = Array.from(document.querySelectorAll('#gsc_rsb_st .gsc_rsb_std')).map((el) => Number(el.textContent?.trim() || 0));
        const photo = document.querySelector('#gsc_prf_pup-img')?.getAttribute('src') || null;
        return {
            name,
            affiliation: ils[0] || null,
            verifiedEmailDomain: (ils[1] || '').replace(/^Verified email at\s*/i, '').trim() || null,
            homepage: document.querySelector('#gsc_prf_ivh a')?.href || null,
            interests: interests.filter(Boolean),
            stats: {
                totalCitations: stats[0] ?? null,
                citationsSince5Years: stats[1] ?? null,
                hIndex: stats[2] ?? null,
                hIndexSince5Years: stats[3] ?? null,
                i10Index: stats[4] ?? null,
                i10IndexSince5Years: stats[5] ?? null,
            },
            photo,
        };
    });

    const papers = await page.$$eval('#gsc_a_b > tr.gsc_a_tr', (rows) => rows.map((tr) => {
        const titleA = tr.querySelector('.gsc_a_at');
        const grays = tr.querySelectorAll('.gs_gray');
        const cited = tr.querySelector('.gsc_a_ac')?.textContent?.trim() || null;
        const year = tr.querySelector('.gsc_a_y .gsc_a_h, .gsc_a_y span')?.textContent?.trim() || null;
        return {
            title: titleA?.textContent?.trim() || null,
            url: titleA?.href || null,
            authors: grays[0]?.textContent?.trim() || null,
            venue: grays[1]?.textContent?.trim() || null,
            citedBy: cited ? Number(cited) : 0,
            year: year ? Number(year) : null,
        };
    }));

    const enrichedProfile = { ...profile, profileUrl: request.url, papersCount: papers.length };
    authorCache.set(request.url, {
        name: enrichedProfile.name,
        affiliation: enrichedProfile.affiliation,
        hIndex: enrichedProfile.stats.hIndex,
        i10Index: enrichedProfile.stats.i10Index,
        totalCitations: enrichedProfile.stats.totalCitations,
        profileUrl: request.url,
    });

    await Actor.pushData({
        type: 'author',
        ...enrichedProfile,
        papers,
        scrapedAt: new Date().toISOString(),
    });
    pushedRows += 1;
    if (pushedRows > 10) __chargeJobs.push(Actor.charge({ eventName: 'paper_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`)));
    ll.info(`Author scraped: ${enrichedProfile.name} (${papers.length} papers, h-index ${enrichedProfile.stats.hIndex}).`);
}

async function handlePaperPage({ request, page, ll }) {
    await handleResultsPage({ request: { ...request, userData: { ...request.userData, label: 'search', query: null, page: 0 } }, page, ll });
}

async function handleCitedByPage({ request, page, ll }) {
    const { sourceClusterId, sourceTitle, page: pageIdx = 0, collected: prev = [] } = request.userData;

    const results = await page.$$eval('div.gs_r.gs_or.gs_scl', (blocks) => blocks.map((b) => {
        const titleA = b.querySelector('h3.gs_rt > a');
        const titleText = b.querySelector('h3.gs_rt')?.textContent?.trim() || null;
        const authorVenue = b.querySelector('div.gs_a')?.textContent?.trim() || null;
        const cid = b.getAttribute('data-cid') || null;
        return { title: titleText, url: titleA?.href || null, authorVenue, scholarClusterId: cid };
    }));

    const collected = [...prev, ...results];
    const remaining = maxCitedByPapers - collected.length;
    const nextHref = await page.$eval('#gs_n a, td[align="left"] a', (a) => a.href).catch(() => null);

    if (nextHref && remaining > 0 && pageIdx + 1 < maxPagesPerQuery) {
        await crawler.addRequests([{
            url: buildCitedByUrl(sourceClusterId, pageIdx + 1),
            userData: { label: 'citedBy', sourceClusterId, sourceTitle, page: pageIdx + 1, collected },
        }]);
    } else {
        await Actor.pushData({
            type: 'citedBy',
            sourceClusterId,
            sourceTitle,
            citingPapers: collected.slice(0, maxCitedByPapers),
            scrapedAt: new Date().toISOString(),
        });
        ll.info(`Cited-by completed for cluster ${sourceClusterId}: ${collected.length} citing papers.`);
    }
}

await crawler.run(startUrls);

if (seenStore) {
    await seenStore.setValue('seen-clusters', [...seenClusters]);
}

log.info(`Done. Pushed ${pushedRows} rows.`);
await Promise.allSettled(__chargeJobs);
await Actor.exit();
