// Remote Jobs Scraper: RemoteOK, Remotive, WeWorkRemotely, Himalayas
//
// Strategy
// --------
// Four remote job boards expose keyless public feeds (no key, no login):
//   RemoteOK        GET https://remoteok.com/api                (JSON array, [0] is a legal notice)
//   Remotive        GET https://remotive.com/api/remote-jobs    (JSON, server-side ?search=)
//   WeWorkRemotely  GET https://weworkremotely.com/remote-jobs.rss (RSS XML)
//   Himalayas       GET https://himalayas.app/jobs/api          (JSON, ?limit=&offset=)
// We pull each, normalize to one row schema, filter by keyword client-side,
// dedupe, and push. RemoteOK and Remotive require attribution: every row
// carries source and sourceUrl, and the README credits them.
//
// Pay per event
// -------------
//   job_row ($0.003) charged when a job row is pushed.
//   First 2 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ALL_SOURCES = ['remoteok', 'remotive', 'weworkremotely', 'himalayas'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    sources = ALL_SOURCES,
    maxJobsPerSource = 25,
    maxRows = 100,
    postedWithinDays = 0,
    proxyConfiguration: proxyInput,
} = input;

const kw = (Array.isArray(keywords) ? keywords : [keywords])
    .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
const wantedSources = (Array.isArray(sources) ? sources : [sources])
    .map((s) => String(s || '').trim().toLowerCase()).filter((s) => ALL_SOURCES.includes(s));
const activeSources = wantedSources.length ? wantedSources : ALL_SOURCES;
const perSource = Math.max(1, Math.min(HARD_CAP, Number(maxJobsPerSource) || 25));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const maxAgeMs = Number(postedWithinDays) > 0 ? Number(postedWithinDays) * 86_400_000 : null;

// Soft deadline derived from the run timeout so we exit cleanly instead of TIMED-OUT.
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : null;
const deadline = timeoutAt ? timeoutAt - 30_000 : null;
const pastDeadline = () => deadline && Date.now() > deadline;

let dispatcher = null;
if (proxyInput?.useApifyProxy || proxyInput?.proxyUrls?.length) {
    try {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        const proxyUrl = await proxyConfiguration?.newUrl();
        if (proxyUrl) {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
            log.info('Routing requests through proxy.');
        }
    } catch (err) {
        log.warning(`Proxy requested but unavailable, continuing direct: ${err?.message}`);
    }
}

async function get(url, asText = false) {
    const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: asText ? '*/*' : 'application/json' },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return asText ? res.text() : res.json();
}

const stripHtml = (s) => String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

const toIso = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    const d = Number.isFinite(n) && n > 1_000_000_000 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const matchesKeywords = (row) => {
    if (!kw.length) return true;
    const hay = `${row.title} ${row.company} ${(row.tags || []).join(' ')} ${row.category || ''}`.toLowerCase();
    return kw.some((k) => hay.includes(k));
};

const freshEnough = (row) => {
    if (!maxAgeMs || !row.postedAt) return true;
    return Date.now() - new Date(row.postedAt).getTime() <= maxAgeMs;
};

// --- Source fetchers, each returns normalized rows ---------------------------

async function fromRemoteOk() {
    const data = await get('https://remoteok.com/api');
    return (Array.isArray(data) ? data : []).filter((j) => j && j.id && j.position).map((j) => ({
        source: 'RemoteOK',
        sourceUrl: 'https://remoteok.com',
        jobId: `remoteok-${j.id}`,
        title: j.position,
        company: j.company || null,
        companyLogo: j.company_logo || j.logo || null,
        tags: Array.isArray(j.tags) ? j.tags : [],
        category: null,
        jobType: null,
        salaryMin: j.salary_min || null,
        salaryMax: j.salary_max || null,
        salaryText: null,
        location: j.location || 'Remote',
        postedAt: toIso(j.date || j.epoch),
        applyUrl: j.apply_url || j.url || null,
        url: j.url || null,
        description: stripHtml(j.description).slice(0, 1500) || null,
    }));
}

async function fromRemotive() {
    const search = kw.length ? `&search=${encodeURIComponent(kw[0])}` : '';
    const data = await get(`https://remotive.com/api/remote-jobs?limit=${Math.min(perSource * 2, 200)}${search}`);
    return (data?.jobs || []).map((j) => ({
        source: 'Remotive',
        sourceUrl: 'https://remotive.com',
        jobId: `remotive-${j.id}`,
        title: j.title,
        company: j.company_name?.trim() || null,
        companyLogo: j.company_logo_url || j.company_logo || null,
        tags: Array.isArray(j.tags) ? j.tags : [],
        category: j.category || null,
        jobType: j.job_type || null,
        salaryMin: null,
        salaryMax: null,
        salaryText: j.salary || null,
        location: j.candidate_required_location || 'Remote',
        postedAt: toIso(j.publication_date),
        applyUrl: j.url || null,
        url: j.url || null,
        description: stripHtml(j.description).slice(0, 1500) || null,
    }));
}

async function fromWeWorkRemotely() {
    const xml = await get('https://weworkremotely.com/remote-jobs.rss', true);
    const items = xml.split('<item>').slice(1);
    const pick = (block, tag) => {
        const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return m ? stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : null;
    };
    return items.map((block, i) => {
        const rawTitle = pick(block, 'title') || '';
        const [company, ...titleParts] = rawTitle.split(': ');
        const link = pick(block, 'link');
        return {
            source: 'WeWorkRemotely',
            sourceUrl: 'https://weworkremotely.com',
            jobId: `wwr-${link || i}`,
            title: titleParts.length ? titleParts.join(': ') : rawTitle,
            company: titleParts.length ? company : null,
            companyLogo: (block.match(/<media:content url="([^"]+)"/) || [])[1] || null,
            tags: (pick(block, 'skills') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12),
            category: pick(block, 'category'),
            jobType: pick(block, 'type'),
            salaryMin: null,
            salaryMax: null,
            salaryText: null,
            location: pick(block, 'region') || 'Remote',
            postedAt: toIso(pick(block, 'pubDate')),
            applyUrl: link,
            url: link,
            description: (pick(block, 'description') || '').slice(0, 1500) || null,
        };
    });
}

async function fromHimalayas() {
    const data = await get(`https://himalayas.app/jobs/api?limit=${Math.min(perSource * 2, 100)}`);
    return (data?.jobs || []).map((j, i) => ({
        source: 'Himalayas',
        sourceUrl: 'https://himalayas.app',
        jobId: `himalayas-${j.guid || i}`,
        title: j.title,
        company: j.companyName || null,
        companyLogo: j.companyLogo || null,
        tags: [...(j.categories || []), ...(j.seniority || [])].slice(0, 12),
        category: (j.parentCategories || j.categories || [])[0] || null,
        jobType: j.employmentType || null,
        salaryMin: j.minSalary || null,
        salaryMax: j.maxSalary || null,
        salaryText: j.currency && j.minSalary ? `${j.currency} ${j.minSalary}${j.maxSalary ? ` to ${j.maxSalary}` : ''} ${j.salaryPeriod || ''}`.trim() : null,
        location: (j.locationRestrictions || []).join(', ') || 'Remote (worldwide)',
        postedAt: toIso(j.pubDate),
        applyUrl: j.applicationLink || null,
        url: j.applicationLink || null,
        description: stripHtml(j.excerpt || j.description).slice(0, 1500) || null,
    }));
}

const FETCHERS = {
    remoteok: fromRemoteOk,
    remotive: fromRemotive,
    weworkremotely: fromWeWorkRemotely,
    himalayas: fromHimalayas,
};

// --- Run ----------------------------------------------------------------------

let totalRowsPushed = 0;
const seen = new Set();

async function pushRow(row) {
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'job_row' });
        } catch (err) {
            log.warning(`charge failed (continuing): ${err?.message}`);
        }
    }
}

for (const src of activeSources) {
    if (pastDeadline() || totalRowsPushed >= rowCap) break;
    let rows = [];
    try {
        rows = await FETCHERS[src]();
    } catch (err) {
        log.warning(`${src} failed, continuing with other sources: ${err?.message}`);
        continue;
    }
    let pushedForSource = 0;
    for (const row of rows) {
        if (pushedForSource >= perSource || totalRowsPushed >= rowCap) break;
        if (!matchesKeywords(row) || !freshEnough(row)) continue;
        const key = `${(row.title || '').toLowerCase()}|${(row.company || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await pushRow(row);
        pushedForSource += 1;
    }
    log.info(`${src}: ${pushedForSource} row(s) pushed (${rows.length} fetched).`);
}

log.info(`Done. Pushed ${totalRowsPushed} job row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
