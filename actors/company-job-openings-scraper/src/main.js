// Company Job Openings Scraper: Greenhouse, Lever, Ashby & More
//
// Strategy
// --------
// The buyer supplies company names (or explicit ATS board tokens). For each
// company we probe the keyless public job-board APIs of the four big ATS
// providers and return every open job as one normalized row:
//   Greenhouse:      boards-api.greenhouse.io/v1/boards/{token}/jobs
//                    (+ /departments once, to map jobId -> department)
//   Lever:           api.lever.co/v0/postings/{token}?mode=json
//   Ashby:           api.ashbyhq.com/posting-api/job-board/{org}
//   SmartRecruiters: api.smartrecruiters.com/v1/companies/{co}/postings
// The ATS token defaults to slug candidates of the company name; pass
// "greenhouse:token", "lever:token", "ashby:token", or "smartrecruiters:token"
// for an exact match. No login, no API key, no browser.
//
// Pay per event
// -------------
//   job_row ($0.003) charged when a job row is pushed.
//   Companies not found on any ATS produce one free status row.
//   First 1 job row per run is free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const HARD_CAP_COMPANIES = 500;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 20000;
const SR_PAGE = 100;
const PLATFORMS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    companies = [],
    keyword,
    location: locationFilter,
    remoteOnly = false,
    maxJobsPerCompany = 200,
} = input;

const entries = [...new Set((Array.isArray(companies) ? companies : String(companies).split(/[\n,]/))
    .map((c) => String(c || '').trim()).filter(Boolean))].slice(0, HARD_CAP_COMPANIES);
if (!entries.length) {
    log.warning('Provide "companies": names or ATS tokens, e.g. ["Stripe", "Ramp", "greenhouse:airbnb"].');
    await Actor.exit();
}
const jobCap = Math.max(1, Math.min(5000, Number(maxJobsPerCompany) || 200));
const kw = String(keyword || '').trim().toLowerCase();
const locKw = String(locationFilter || '').trim().toLowerCase();

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; JobOpeningsScraper/1.0; +https://apify.com/scrapemint/company-job-openings-scraper)',
            },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function parseEntry(s) {
    const m = s.match(/^(greenhouse|lever|ashby|smartrecruiters)\s*:\s*(.+)$/i);
    if (m) return { platform: m[1].toLowerCase(), tokens: [m[2].trim()] };
    const base = s.toLowerCase().trim();
    const cands = [
        base.replace(/[^a-z0-9]/g, ''),
        base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        base.split(/\s+/)[0].replace(/[^a-z0-9]/g, ''),
    ];
    return { platform: null, tokens: [...new Set(cands.filter(Boolean))] };
}

const displayName = (s) => s.replace(/^(greenhouse|lever|ashby|smartrecruiters)\s*:\s*/i, '').trim();
const iso = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const looksRemote = (s) => /\bremote\b/i.test(String(s || ''));

// ---------- Per-ATS fetchers, each returning normalized job rows or null ----------

async function greenhouse(token) {
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`);
    if (!data || !Array.isArray(data.jobs)) return null;
    // The jobs list omits departments; one extra light call maps them.
    const deptByJob = new Map();
    const depts = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/departments`);
    for (const d of depts?.departments || []) {
        for (const j of d.jobs || []) deptByJob.set(j.id, d.name);
    }
    return data.jobs.map((j) => ({
        jobId: String(j.id),
        title: j.title || null,
        department: deptByJob.get(j.id) || null,
        team: null,
        location: j.location?.name || null,
        additionalLocations: null,
        remote: looksRemote(j.location?.name) || null,
        workplaceType: null,
        employmentType: null,
        postedAt: iso(j.first_published),
        updatedAt: iso(j.updated_at),
        url: j.absolute_url || null,
        applyUrl: j.absolute_url || null,
    }));
}

async function lever(token) {
    const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
    if (!Array.isArray(data) || data.length === 0) return null; // empty board is indistinguishable from unknown token
    return data.map((j) => ({
        jobId: j.id || null,
        title: j.text || null,
        department: j.categories?.department || null,
        team: j.categories?.team || null,
        location: j.categories?.location || null,
        additionalLocations: j.categories?.allLocations?.length > 1 ? j.categories.allLocations : null,
        remote: j.workplaceType ? j.workplaceType === 'remote' : looksRemote(j.categories?.location) || null,
        workplaceType: j.workplaceType || null,
        employmentType: j.categories?.commitment || null,
        postedAt: iso(j.createdAt),
        updatedAt: null,
        url: j.hostedUrl || null,
        applyUrl: j.applyUrl || j.hostedUrl || null,
    }));
}

async function ashby(token) {
    const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
    if (!data || !Array.isArray(data.jobs)) return null;
    return data.jobs.filter((j) => j.isListed !== false).map((j) => ({
        jobId: j.id || null,
        title: j.title || null,
        department: j.department || null,
        team: j.team || null,
        location: j.location || null,
        additionalLocations: (j.secondaryLocations || []).map((l) => l.location).filter(Boolean).slice(0, 10) || null,
        remote: typeof j.isRemote === 'boolean' ? j.isRemote : null,
        workplaceType: j.workplaceType || null,
        employmentType: j.employmentType || null,
        postedAt: iso(j.publishedAt),
        updatedAt: null,
        url: j.jobUrl || null,
        applyUrl: j.applyUrl || j.jobUrl || null,
    }));
}

async function smartrecruiters(token) {
    const first = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${SR_PAGE}`);
    if (!first || !Array.isArray(first.content)) return null;
    const all = [...first.content];
    const total = Math.min(Number(first.totalFound) || all.length, jobCap);
    for (let offset = SR_PAGE; offset < total && all.length < total; offset += SR_PAGE) {
        const page = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${SR_PAGE}&offset=${offset}`);
        if (!page || !Array.isArray(page.content) || page.content.length === 0) break;
        all.push(...page.content);
    }
    if (all.length === 0) return null; // treat an empty board as not found, like Lever
    return all.map((j) => {
        const loc = j.location || {};
        const locStr = [loc.city, loc.region, (loc.country || '').toUpperCase()].filter(Boolean).join(', ') || null;
        return {
            jobId: String(j.id),
            title: j.name || null,
            department: j.department?.label || null,
            team: j.function?.label || null,
            location: locStr,
            additionalLocations: null,
            remote: typeof loc.remote === 'boolean' ? loc.remote : null,
            workplaceType: loc.remote ? 'remote' : (loc.hybrid ? 'hybrid' : null),
            employmentType: j.typeOfEmployment?.label || null,
            postedAt: iso(j.releasedDate),
            updatedAt: null,
            url: `https://jobs.smartrecruiters.com/${encodeURIComponent(j.company?.identifier || token)}/${j.id}`,
            applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(j.company?.identifier || token)}/${j.id}`,
        };
    });
}

const FETCHERS = { greenhouse, lever, ashby, smartrecruiters };

async function resolveCompany(entry) {
    const { platform, tokens } = parseEntry(entry);
    for (const token of tokens) {
        for (const p of platform ? [platform] : PLATFORMS) {
            const jobs = await FETCHERS[p](token);
            if (jobs) return { jobs, atsPlatform: p, atsToken: token };
        }
    }
    return { jobs: null, atsPlatform: null, atsToken: null };
}

function passesFilters(row) {
    if (kw && !String(row.title || '').toLowerCase().includes(kw)) return false;
    if (locKw) {
        const hay = [row.location, ...(row.additionalLocations || [])].join(' | ').toLowerCase();
        if (!hay.includes(locKw)) return false;
    }
    if (remoteOnly && !(row.remote === true || row.workplaceType === 'remote' || looksRemote(row.location))) return false;
    return true;
}

let totalJobRows = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushJobRow(row) {
    await Actor.pushData(row);
    totalJobRows += 1;
    if (totalJobRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'job_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Fetching openings for ${entries.length} company(ies)${kw ? `, keyword "${kw}"` : ''}${locKw ? `, location "${locKw}"` : ''}${remoteOnly ? ', remote only' : ''}, up to ${jobCap} jobs each.`);

let notFound = 0;
let stopped = false;
for (let i = 0; i < entries.length && !stopped; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const batch = entries.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(batch.map((e) => resolveCompany(e)));
    for (let k = 0; k < batch.length; k += 1) {
        const company = displayName(batch[k]);
        const { jobs, atsPlatform, atsToken } = resolved[k];
        if (!jobs) {
            notFound += 1;
            await Actor.pushData({
                company, status: 'ats_not_found', atsPlatform: null, atsToken: null,
                jobId: null, title: null, department: null, team: null, location: null,
                scrapedAt: new Date().toISOString(),
            });
            continue;
        }
        let pushed = 0;
        for (const row of jobs) {
            if (pushed >= jobCap) break;
            if (!passesFilters(row)) continue;
            await flushJobRow({ company, status: 'ok', atsPlatform, atsToken, ...row, scrapedAt: new Date().toISOString() });
            pushed += 1;
        }
        log.info(`${company}: ${pushed} job(s) via ${atsPlatform} (board "${atsToken}", ${jobs.length} open before filters).`);
    }
}

log.info(`Done. ${totalJobRows} job row(s) across ${entries.length - notFound} company(ies); ${notFound} not found on any ATS; ${Math.max(0, totalJobRows - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
