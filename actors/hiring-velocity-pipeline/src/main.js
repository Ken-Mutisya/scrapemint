// Hiring Velocity B2B Pipeline
//
// Stage 1: Call scrapemint/indeed-jobs-scraper with the user's skill keywords,
//          country, location filters, experience level, and date window.
//          We turn on scrapeCompanyDetails so each unique company gets a
//          company row with website, industry, headcount, founded year.
// Stage 2: Read the Indeed dataset. Two row types come back: job rows (one
//          per posting) and company rows (one per unique employer). Join on
//          companyName.
// Stage 3: For each company with a website, run cheap inline enrichment:
//            - root-domain extraction
//            - HTTP HEAD reachability
//            - DNS MX lookup
//            - email pattern inference (info@, careers@, hello@)
// Stage 4: Compute hiring velocity (postings count, recency, senior share).
// Stage 5: Tier each row as qualified or basic and charge the matching event.
//          First N qualified_hiring_company per run are free.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_QUALIFIED = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    country = 'US',
    locations = [],
    datePosted = '14',
    experienceLevel = 'senior_level',
    maxJobsPerSearch = 50,
    maxJobsTotal = 200,
    minPostingsPerCompany = 2,
    requireWebsite = true,
    proxyConfiguration: proxyInput,
} = input;

const cleanKeywords = [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))];
if (cleanKeywords.length === 0) {
    log.warning('No keywords provided. Pass at least one skill keyword.');
    await Actor.exit();
}

log.info(`Pulling Indeed jobs for ${cleanKeywords.length} keywords in ${country} (${experienceLevel}, last ${datePosted} days).`);

const indeedRun = await Actor.call(
    'scrapemint/indeed-jobs-scraper',
    {
        keywords: cleanKeywords,
        country,
        locations,
        datePosted,
        experienceLevel,
        maxJobs: maxJobsTotal,
        scrapeCompanyDetails: true,
        extractSkills: true,
        classifySeniority: true,
        parseSalary: false,
        detectRemoteHybrid: true,
        dedupe: true,
        concurrency: 3,
        proxyConfiguration: proxyInput,
    },
    { memory: 2048, build: 'latest' },
);

if (!indeedRun?.defaultDatasetId) {
    log.error('Indeed stage returned no dataset. Aborting.');
    await Actor.exit();
}
log.info(`Indeed stage finished. Reading rows from ${indeedRun.defaultDatasetId}.`);

const indeedDataset = await Actor.openDataset(indeedRun.defaultDatasetId, { forceCloud: true });
const rows = (await indeedDataset.getData()).items ?? [];
log.info(`Got ${rows.length} Indeed rows.`);

// Partition rows into jobs vs companies.
// indeed-jobs-scraper company rows are pushed separately and have a `website`
// field set; job rows have a jobId/title/company instead.
const jobRows = rows.filter((r) => r.jobId || r.title || r.position);
const companyRows = rows.filter((r) => r.website !== undefined && !r.jobId);

log.info(`Partitioned: ${jobRows.length} job rows, ${companyRows.length} company rows.`);

// Indeed sometimes returns company as { name: "..." } and the underlying
// scraper has occasional DOM-selector misses that capture CSS class strings
// instead of the real company name. Validate and normalize defensively.
const cleanCompanyName = (raw) => {
    if (!raw) return null;
    let s = '';
    if (typeof raw === 'string') s = raw;
    else if (typeof raw === 'object') s = raw.name || raw.title || raw.companyName || '';
    s = String(s).trim();
    if (!s) return null;
    // Reject CSS / style artifacts and absurdly long values
    if (s.startsWith('.css') || s.startsWith('.') || /\{[^}]*:/.test(s) || s.length > 120) return null;
    return s;
};
const normCompany = (s) => String(s || '').trim().toLowerCase();

const companyMeta = new Map();
for (const c of companyRows) {
    const name = cleanCompanyName(c.companyName || c.name);
    if (!name) continue;
    companyMeta.set(normCompany(name), {
        companyName: name,
        industry: c.industry || null,
        headcountBand: c.size || c.headcount || null,
        foundedYear: c.foundedYear || c.founded || null,
        website: c.website || c.websiteUrl || null,
        indeedCompanyUrl: c.url || c.companyUrl || null,
        rating: c.rating ?? null,
        reviewCount: c.reviewsCount || c.reviewCount || null,
    });
}

// Aggregate jobs per company.
let skippedNoCompany = 0;
const byCompany = new Map();
for (const j of jobRows) {
    const name = cleanCompanyName(j.company || j.companyName);
    if (!name) { skippedNoCompany += 1; continue; }
    const key = normCompany(name);
    const agg = byCompany.get(key) || {
        keyName: name,
        titles: new Set(),
        skills: new Map(),
        seniorCount: 0,
        leadOrAboveCount: 0,
        postingDates: [],
    };
    if (j.title) agg.titles.add(String(j.title).trim());
    const skillsArr = Array.isArray(j.skills) ? j.skills : [];
    for (const s of skillsArr) {
        const k = String(s).toLowerCase().trim();
        if (k) agg.skills.set(k, (agg.skills.get(k) || 0) + 1);
    }
    const sen = String(j.seniorityTier || j.seniority || '').toLowerCase();
    if (['senior', 'lead', 'staff', 'principal', 'manager', 'director', 'vp', 'c_level', 'c-level'].some((t) => sen.includes(t))) {
        agg.seniorCount += 1;
    }
    if (['lead', 'staff', 'principal', 'manager', 'director', 'vp', 'c_level', 'c-level'].some((t) => sen.includes(t))) {
        agg.leadOrAboveCount += 1;
    }
    const dt = j.postedDate || j.datePosted || j.date;
    if (dt) agg.postingDates.push(new Date(dt).getTime());
    byCompany.set(key, agg);
}

log.info(`Aggregated to ${byCompany.size} unique companies. Skipped ${skippedNoCompany} job rows missing a clean company name. Enriching.`);

if (skippedNoCompany > 0 && byCompany.size === 0) {
    log.warning('All job rows were skipped because no valid company names were captured. This usually means the upstream Indeed scraper hit antibot challenges or its company-name DOM selector is failing. Try a smaller maxJobsTotal, a different country, or rerun in a few hours.');
}

const extractDomain = (urlOrHost) => {
    if (!urlOrHost) return null;
    try {
        const u = String(urlOrHost).trim();
        const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
        const host = new URL(withProto).hostname.toLowerCase();
        return host.replace(/^www\./, '');
    } catch {
        return null;
    }
};

const headReachable = async (websiteUrl) => {
    if (!websiteUrl) return false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(websiteUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        clearTimeout(timeout);
        return res.status < 500;
    } catch {
        return false;
    }
};

const hasMx = async (domain) => {
    if (!domain) return false;
    try {
        const records = await dns.resolveMx(domain);
        return Array.isArray(records) && records.length > 0;
    } catch {
        return false;
    }
};

const inferContactEmails = (domain) => {
    if (!domain) return [];
    return ['info', 'careers', 'hello'].map((local) => `${local}@${domain}`);
};

const today = Date.now();
const daysAgo = (ts) => Math.max(0, Math.floor((today - ts) / (1000 * 60 * 60 * 24)));

let qualifiedCharged = 0;
let basicCharged = 0;
let qualifiedFree = 0;

for (const [key, agg] of byCompany) {
    const meta = companyMeta.get(key) || {};
    const companyName = meta.companyName || agg.keyName;
    const website = meta.website || null;
    const domain = extractDomain(website);

    const websiteReachable = website ? await headReachable(website) : false;
    const mxFound = websiteReachable ? await hasMx(domain) : false;

    const openRolesCount = agg.titles.size + Math.max(0, agg.postingDates.length - agg.titles.size);
    const totalPostings = agg.postingDates.length || agg.titles.size;
    const sortedDates = [...agg.postingDates].sort((a, b) => a - b);
    const firstPostingDate = sortedDates[0] ? new Date(sortedDates[0]).toISOString().slice(0, 10) : null;
    const lastPostingDate = sortedDates.at(-1) ? new Date(sortedDates.at(-1)).toISOString().slice(0, 10) : null;
    const daysSinceLastPosting = sortedDates.at(-1) ? daysAgo(sortedDates.at(-1)) : null;

    const topSkills = [...agg.skills.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([s]) => s);

    const seniorShare = totalPostings > 0 ? agg.seniorCount / totalPostings : 0;
    const recencyScore = daysSinceLastPosting == null ? 0 : Math.max(0, 1 - daysSinceLastPosting / 14);
    const volumeScore = Math.min(1, totalPostings / 10);
    const hiringVelocityScore = Math.round(100 * (0.5 * volumeScore + 0.3 * seniorShare + 0.2 * recencyScore));

    const passesPostings = totalPostings >= minPostingsPerCompany;
    const passesWebsite = !requireWebsite || (websiteReachable && mxFound);
    const qualityTier = (passesPostings && passesWebsite) ? 'qualified' : 'basic';

    const row = {
        companyName,
        industry: meta.industry,
        headcountBand: meta.headcountBand,
        foundedYear: meta.foundedYear,
        companyWebsite: website,
        websiteReachable,
        domain,
        mxFound,
        likelyContactEmails: inferContactEmails(domain),
        openRolesCount,
        totalPostings,
        roleTitles: [...agg.titles].slice(0, 20),
        topSkills,
        seniorPostingsCount: agg.seniorCount,
        leadOrAbovePostingsCount: agg.leadOrAboveCount,
        hiringVelocityScore,
        daysSinceLastPosting,
        firstPostingDate,
        lastPostingDate,
        indeedRating: meta.rating,
        indeedReviewCount: meta.reviewCount,
        indeedCompanyUrl: meta.indeedCompanyUrl,
        qualityTier,
    };

    await Actor.pushData(row);

    if (qualityTier === 'qualified') {
        if (qualifiedCharged + qualifiedFree < FREE_TIER_QUALIFIED) {
            qualifiedFree++;
        } else {
            await Actor.charge({ eventName: 'qualified_hiring_company' });
            qualifiedCharged++;
        }
    } else {
        await Actor.charge({ eventName: 'basic_company' });
        basicCharged++;
    }
}

log.info(`Done. qualified_charged=${qualifiedCharged} qualified_free=${qualifiedFree} basic=${basicCharged} total_rows=${byCompany.size}`);

await Actor.exit();
