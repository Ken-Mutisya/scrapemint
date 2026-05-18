// LinkedIn Company Hiring Signal Tracker
//
// Strategy (all cookieless, validated 2026-05-18)
// -----------------------------------------------
//   1. Resolve each company slug to its numeric organization id by fetching
//      the public company page. The id is present as urn:li:organization:{id}
//      and f_C={id} in that page's HTML without a login.
//   2. Walk the public jobs endpoint filtered to that company:
//      /jobs-guest/jobs/api/seeMoreJobPostings/search?f_C={id}&start=N
//      25 cards at a time, paginating until the list is exhausted or the cap.
//   3. Aggregate into ONE row per company: total open roles plus a breakdown
//      by seniority, function, and location. This is the difference from the
//      per job linkedin-jobs-scraper: a buying signal, not a job feed.
//   4. With trackDeltas on, the prior count per company is kept in a key value
//      store, so a scheduled run reports the change versus last run. The
//      hiring velocity is the whole product.
//
// Free tier: first 3 companies per run are free. After that charge per company.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const FREE_TIER_COMPANIES = 3;
const PAGE_SIZE = 25;
const HISTORY_STORE = 'linkedin-hiring-history';

const FUNCTION_RULES = [
    ['engineering', /\b(engineer|developer|programmer|sre|devops|architect|software|backend|frontend|full.?stack|machine learning|ml |ai |data scientist|infrastructure|platform)\b/],
    ['data', /\b(data analyst|data engineer|analytics|business intelligence|bi )\b/],
    ['product', /\b(product manager|product owner|product lead|head of product|pm\b)/],
    ['design', /\b(designer|ux|ui |product design|brand design)\b/],
    ['sales', /\b(sales|account executive|account manager|business development|bdr|sdr|revenue|partnerships)\b/],
    ['marketing', /\b(marketing|growth|demand gen|content|seo|brand|communications|pr )\b/],
    ['customer', /\b(customer success|customer support|customer experience|support engineer|technical support|implementation)\b/],
    ['operations', /\b(operations|program manager|project manager|chief of staff|strategy)\b/],
    ['finance', /\b(finance|accountant|accounting|controller|fp&a|treasury|audit)\b/],
    ['people', /\b(recruiter|talent|people ops|human resources|hr |sourcer)\b/],
    ['legal', /\b(legal|counsel|compliance|paralegal|attorney)\b/],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companyUrls = [],
    maxRolesScanPerCompany = 300,
    roleKeyword = '',
    trackDeltas = true,
    topLocations = 8,
    proxyConfiguration: proxyInput,
} = input;

const targets = [];
const seenTargets = new Set();
for (const raw of companyUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const t = parseCompanyTarget(String(v).trim());
    if (t && !seenTargets.has(t.key)) { seenTargets.add(t.key); targets.push(t); }
}

if (targets.length === 0) {
    log.warning('No valid LinkedIn company URLs or numeric ids provided. Example: https://www.linkedin.com/company/anthropicresearch/');
    await Actor.exit();
}

const roleKw = String(roleKeyword || '').trim().toLowerCase();
const scanCap = Math.max(PAGE_SIZE, Number(maxRolesScanPerCompany) || 300);
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const history = trackDeltas ? await Actor.openKeyValueStore(HISTORY_STORE) : null;
const collectors = new Map(); // companyId -> collector
let companiesPushed = 0;

const initialRequests = targets.map((t) => {
    if (t.id) {
        return {
            url: listUrl(t.id, 0),
            userData: { type: 'list', companyId: t.id, target: t, start: 0 },
            uniqueKey: `list:${t.id}:0`,
        };
    }
    return {
        url: `https://www.linkedin.com/company/${t.slug}/`,
        userData: { type: 'resolve', target: t },
        uniqueKey: `resolve:${t.slug}`,
    };
});

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    maxConcurrency: 2,
    sameDomainDelaySecs: 1.5,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 200,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    additionalMimeTypes: ['application/json', 'text/plain'],
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...request.headers,
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
            };
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'resolve') return handleResolve(ctx);
        if (t === 'list') return handleList(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Request failed after retries: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Companies pushed: ${companiesPushed}/${targets.length}.`);
await Actor.exit();

// ---------- handlers ----------

async function handleResolve({ $, request, crawler: c }) {
    const target = request.userData.target;
    const html = $.root().html() || '';
    const m = html.match(/urn:li:organization:(\d+)/) || html.match(/[?&]f_C=(\d+)/);
    if (!m) {
        log.warning(`Could not resolve numeric id for company "${target.slug}" from its public page. Skipping.`);
        return;
    }
    const companyId = m[1];
    log.info(`Resolved ${target.slug} -> organization ${companyId}`);
    await c.addRequests([{
        url: listUrl(companyId, 0),
        userData: { type: 'list', companyId, target, start: 0 },
        uniqueKey: `list:${companyId}:0`,
    }]);
}

async function handleList({ $, request, crawler: c }) {
    const { companyId, target, start } = request.userData;

    let col = collectors.get(companyId);
    if (!col) {
        col = { id: companyId, slug: target.slug || null, roles: new Map(), companyName: null };
        collectors.set(companyId, col);
    }

    let cardCount = 0;
    $('[data-entity-urn^="urn:li:jobPosting:"]').each((_, el) => {
        cardCount += 1;
        const card = $(el);
        const root = card.closest('li, div.base-card, div.job-search-card');
        const scope = root.length ? root : card;
        const jobId = (card.attr('data-entity-urn') || '').replace('urn:li:jobPosting:', '').trim();
        if (!jobId || col.roles.has(jobId)) return;
        const title = clean(scope.find('.base-search-card__title, h3').first().text());
        const company = clean(scope.find('.base-search-card__subtitle, h4 a').first().text());
        const location = clean(scope.find('.job-search-card__location').first().text());
        const dt = scope.find('time[datetime]').first().attr('datetime') || null;
        if (company && !col.companyName) col.companyName = company;
        col.roles.set(jobId, { jobId, title: title || null, location: location || null, postedAt: dt });
    });

    const total = col.roles.size;
    log.info(`${target.slug || companyId} list start=${start}: ${cardCount} cards, ${total} unique so far.`);

    const more = cardCount >= 10 && total < scanCap;
    if (more) {
        const nextStart = start + (cardCount || PAGE_SIZE);
        await c.addRequests([{
            url: listUrl(companyId, nextStart),
            userData: { type: 'list', companyId, target, start: nextStart },
            uniqueKey: `list:${companyId}:${nextStart}`,
        }]);
    } else {
        await finalizeCompany(companyId);
    }
}

async function finalizeCompany(companyId) {
    const col = collectors.get(companyId);
    if (!col || col.finalized) return;
    col.finalized = true;

    let roles = [...col.roles.values()];
    if (roleKw) roles = roles.filter((r) => (r.title || '').toLowerCase().includes(roleKw));

    const bySeniority = {};
    const byFunction = {};
    const byLocation = {};
    let newestPostedAt = null;
    for (const r of roles) {
        const sen = seniorityFromTitle(r.title) || 'unknown';
        bySeniority[sen] = (bySeniority[sen] || 0) + 1;
        const fn = functionFromTitle(r.title);
        byFunction[fn] = (byFunction[fn] || 0) + 1;
        if (r.location) byLocation[r.location] = (byLocation[r.location] || 0) + 1;
        if (r.postedAt && (!newestPostedAt || r.postedAt > newestPostedAt)) newestPostedAt = r.postedAt;
    }

    const topLoc = Object.entries(byLocation)
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, Number(topLocations) || 8))
        .map(([location, count]) => ({ location, count }));

    const total = roles.length;

    let previousTotal = null;
    let previousScrapedAt = null;
    let delta = null;
    let deltaPct = null;
    if (history) {
        const prev = await history.getValue(`c_${companyId}`);
        if (prev && typeof prev.count === 'number') {
            previousTotal = prev.count;
            previousScrapedAt = prev.scrapedAt || null;
            delta = total - prev.count;
            deltaPct = prev.count > 0 ? Math.round((delta / prev.count) * 1000) / 10 : null;
        }
        await history.setValue(`c_${companyId}`, { count: total, scrapedAt: new Date().toISOString() });
    }

    await Actor.pushData({
        company: col.companyName || col.slug || null,
        companySlug: col.slug,
        companyId,
        companyUrl: col.slug ? `https://www.linkedin.com/company/${col.slug}/` : null,
        jobsUrl: `https://www.linkedin.com/jobs/search/?f_C=${companyId}`,
        roleKeyword: roleKw || null,
        totalOpenRoles: total,
        scanCapped: col.roles.size >= scanCap,
        previousTotal,
        previousScrapedAt,
        delta,
        deltaPct,
        hiringTrend: delta == null ? 'baseline' : delta > 0 ? 'ramping' : delta < 0 ? 'slowing' : 'flat',
        bySeniority,
        byFunction,
        topLocations: topLoc,
        newestRolePostedAt: newestPostedAt,
        sampleTitles: roles.slice(0, 10).map((r) => r.title).filter(Boolean),
        scrapedAt: new Date().toISOString(),
    });

    companiesPushed += 1;
    if (companiesPushed > FREE_TIER_COMPANIES) {
        await Actor.charge({ eventName: 'company_tracked' }).catch((err) => {
            log.warning(`charge failed (continuing): ${err?.message}`);
        });
    }
    log.info(`Pushed ${col.companyName || companyId}: ${total} open roles (trend ${delta == null ? 'baseline' : delta}).`);
}

// ---------- helpers ----------

function listUrl(companyId, start) {
    const qs = new URLSearchParams({ f_C: String(companyId), start: String(start) });
    return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs.toString()}`;
}

function parseCompanyTarget(raw) {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return { id: raw, slug: null, key: `id:${raw}` };
    let u;
    try { u = new URL(raw.startsWith('http') ? raw : `https://${raw}`); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
    const m = u.pathname.match(/\/company\/([^/]+)/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    return { id: null, slug, key: `slug:${slug}` };
}

function clean(s) {
    return s ? s.replace(/\s+/g, ' ').trim() : '';
}

function functionFromTitle(title) {
    if (!title) return 'other';
    const t = ` ${title.toLowerCase()} `;
    for (const [name, re] of FUNCTION_RULES) if (re.test(t)) return name;
    return 'other';
}

function seniorityFromTitle(title) {
    if (!title) return null;
    const t = title.toLowerCase();
    if (/\bintern\b|internship/.test(t)) return 'intern';
    if (/\b(ceo|cto|coo|cfo|cmo|cpo|ciso|cio|chief\s+\w+\s+officer)\b/.test(t)) return 'c-suite';
    if (/\bvp\b|vice\s+president/.test(t)) return 'vp';
    if (/\bdirector\b|\bhead\s+of\b/.test(t)) return 'director';
    if (/\bmanager\b|\bmgr\b/.test(t)) return 'manager';
    if (/\bprincipal\b|\bstaff\b/.test(t)) return 'staff';
    if (/\blead\b|\btech\s+lead\b/.test(t)) return 'lead';
    if (/\bsenior\b|\bsr\.?\b/.test(t)) return 'senior';
    if (/\bjunior\b|\bjr\.?\b|\bentry\s*level\b|\bnew\s*grad\b|\bgraduate\b/.test(t)) return 'entry';
    return 'mid';
}
