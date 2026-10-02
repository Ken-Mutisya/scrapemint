// One fetcher per applicant tracking system. Each turns a board into rows of
// one shape, so filters, salary and output never care where a job came from.
//
//   list(board, ctx)  -> jobs from the board's public listing
//   describe(job)     -> (optional) fills description/salary from a detail call,
//                        for ATSes whose listing omits them
//
// ctx: { keyword, withinDays, budget }. A fetcher may use the keyword server
// side where the ATS supports search; the caller filters again regardless.

import { request } from './http.js';
import { htmlToText, parseSalary, postedDaysAgo } from './parse.js';
import { workday } from './workday.js';

const daysSince = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
};
const isoOf = (v) => {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const REMOTE_RE = /\bremote\b|\banywhere\b|work from home/i;

function job(board, f) {
    const postedAt = isoOf(f.postedAt);
    const locations = (f.locations || []).filter(Boolean);
    return {
        ats: board.ats,
        company: f.company || board.name || titleCase(board.tenant),
        title: String(f.title || '').trim(),
        jobId: f.jobId != null ? String(f.jobId) : null,
        department: f.department || null,
        team: f.team || null,
        location: f.location || locations[0] || null,
        additionalLocations: locations.length > 1 ? locations.slice(1) : null,
        country: f.country || null,
        remote: f.remote ?? REMOTE_RE.test(`${f.location || ''} ${locations.join(' ')} ${f.title || ''}`),
        workplaceType: f.workplaceType || null,
        employmentType: f.employmentType || null,
        postedAt,
        postedDaysAgo: postedAt ? daysSince(postedAt) : (f.postedText ? postedDaysAgo(f.postedText) : null),
        description: f.description ?? null,
        salaryMin: f.salary?.salaryMin ?? null,
        salaryMax: f.salary?.salaryMax ?? null,
        salaryCurrency: f.salary?.salaryCurrency ?? null,
        salaryPeriod: f.salary?.salaryPeriod ?? null,
        salaryText: f.salary?.salaryText ?? null,
        url: f.url || null,
        applyUrl: f.applyUrl || f.url || null,
        boardTenant: board.tenant,
        _detail: f._detail || null,
    };
}

// Salary from a structured field when the ATS has one, else from the text.
const salaryOr = (structured, text) => (structured?.salaryMin != null ? structured : parseSalary(text));
const PERIOD = { year: 'year', yearly: 'year', annual: 'year', annually: 'year', '1 year': 'year', month: 'month', monthly: 'month', week: 'week', weekly: 'week', hour: 'hour', hourly: 'hour', day: 'day', daily: 'day' };
const period = (p) => PERIOD[String(p || '').toLowerCase().replace(/^per[_ ]/, '')] || (p ? String(p).toLowerCase() : null);

// ---------------- Greenhouse ----------------
// Listing without content is ~0.6 KB a job (Stripe: 445 KB vs 5.5 MB with
// content), so descriptions are fetched per job, only for jobs that survive the
// filters.
const greenhouse = {
    async list(board) {
        const j = await request(`https://boards-api.greenhouse.io/v1/boards/${board.tenant}/jobs`);
        return (j.jobs || []).map((g) => job(board, {
            company: g.company_name || board.name,
            title: g.title,
            jobId: g.id,
            location: g.location?.name,
            postedAt: g.first_published || g.updated_at,
            url: g.absolute_url,
            _detail: `https://boards-api.greenhouse.io/v1/boards/${board.tenant}/jobs/${g.id}`,
        }));
    },
    async describe(row) {
        const d = await request(row._detail);
        // content arrives HTML-escaped ("&lt;p&gt;").
        const html = String(d.content || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        row.description = htmlToText(html);
        row.department = row.department || d.departments?.[0]?.name || null;
        const offices = (d.offices || []).map((o) => o.name).filter(Boolean);
        if (offices.length > 1 && !row.additionalLocations) row.additionalLocations = offices.filter((o) => o !== row.location);
        // Greenhouse pay transparency: pay_input_ranges when the board publishes it.
        const pr = d.pay_input_ranges?.[0];
        const structured = pr ? { salaryMin: pr.min_cents / 100, salaryMax: pr.max_cents / 100, salaryCurrency: pr.currency_type, salaryPeriod: 'year', salaryText: pr.title || null } : null;
        Object.assign(row, salaryOr(structured, row.description));
    },
};

// ---------------- Lever ----------------
const lever = {
    async list(board) {
        const host = board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
        const j = await request(`https://${host}/v0/postings/${board.tenant}?mode=json`);
        return (Array.isArray(j) ? j : []).map((l) => {
            const lists = (l.lists || []).map((x) => `${x.text}\n${htmlToText(x.content)}`).join('\n\n');
            const description = [l.descriptionPlain, lists, l.additionalPlain].filter(Boolean).join('\n\n').trim();
            const sr = l.salaryRange;
            const structured = sr?.min != null ? { salaryMin: sr.min, salaryMax: sr.max ?? sr.min, salaryCurrency: sr.currency || null, salaryPeriod: period(sr.interval?.replace(/-salary$/, '')), salaryText: null } : null;
            return job(board, {
                title: l.text,
                jobId: l.id,
                department: l.categories?.department || null,
                team: l.categories?.team || null,
                location: l.categories?.location,
                locations: l.categories?.allLocations,
                country: l.country || null,
                workplaceType: l.workplaceType || null,
                remote: l.workplaceType === 'remote' ? true : undefined,
                employmentType: l.categories?.commitment || null,
                postedAt: l.createdAt,
                description,
                salary: salaryOr(structured, description),
                url: l.hostedUrl,
                applyUrl: l.applyUrl,
            });
        });
    },
};

// ---------------- Ashby ----------------
const ashby = {
    async list(board) {
        const j = await request(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.tenant)}?includeCompensation=true`);
        return (j.jobs || []).filter((a) => a.isListed !== false).map((a) => {
            const comp = (a.compensation?.summaryComponents || []).find((c) => c.compensationType === 'Salary' && c.minValue != null);
            const structured = comp ? { salaryMin: comp.minValue, salaryMax: comp.maxValue ?? comp.minValue, salaryCurrency: comp.currencyCode || null, salaryPeriod: period(String(comp.interval || '').replace(/^1 /, '')), salaryText: a.compensation?.compensationTierSummary || null } : null;
            const description = a.descriptionPlain || htmlToText(a.descriptionHtml || '');
            const pa = a.address?.postalAddress;
            return job(board, {
                title: a.title,
                jobId: a.id,
                department: a.department,
                team: a.team,
                location: a.location,
                locations: [a.location, ...(a.secondaryLocations || []).map((s) => s.location)],
                country: pa?.addressCountry || null,
                remote: a.isRemote === true || a.workplaceType === 'Remote' ? true : undefined,
                workplaceType: a.workplaceType || null,
                employmentType: a.employmentType || null,
                postedAt: a.publishedAt,
                description,
                salary: salaryOr(structured, description),
                url: a.jobUrl,
                applyUrl: a.applyUrl,
            });
        });
    },
};

// ---------------- SmartRecruiters ----------------
const smartrecruiters = {
    async list(board, ctx) {
        const out = [];
        // Server-side keyword search; 100 per page.
        for (let offset = 0; offset < 10000 && out.length < ctx.budget; offset += 100) {
            const q = ctx.keyword ? `&q=${encodeURIComponent(ctx.keyword)}` : '';
            const j = await request(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.tenant)}/postings?limit=100&offset=${offset}${q}`);
            const page = j.content || [];
            for (const p of page) {
                out.push(job(board, {
                    company: p.company?.name || board.name,
                    title: p.name,
                    jobId: p.id,
                    department: p.department?.label || p.function?.label || null,
                    // fullLocation keeps empty parts: "London, , United Kingdom".
                    location: (p.location?.fullLocation || [p.location?.city, p.location?.region, p.location?.country?.toUpperCase()].filter(Boolean).join(', ')).replace(/(,\s*)+,/g, ',').replace(/^,\s*|,\s*$/g, '').trim() || null,
                    country: p.location?.country?.toUpperCase() || null,
                    remote: p.location?.remote === true ? true : undefined,
                    workplaceType: p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : 'onsite',
                    employmentType: p.typeOfEmployment?.label || null,
                    postedAt: p.releasedDate,
                    url: `https://jobs.smartrecruiters.com/${board.tenant}/${p.id}`,
                    _detail: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.tenant)}/postings/${p.id}`,
                }));
            }
            if (page.length < 100) break;
            // Newest first without a keyword: stop once a page is past the window.
            if (ctx.withinDays && !ctx.keyword && page.every((p) => daysSince(p.releasedDate) > ctx.withinDays)) break;
        }
        return out;
    },
    async describe(row) {
        const d = await request(row._detail);
        const s = d.jobAd?.sections || {};
        row.description = htmlToText([s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text].filter(Boolean).join('<br><br>'));
        row.url = d.postingUrl || row.url;
        row.applyUrl = d.applyUrl || row.applyUrl;
        Object.assign(row, parseSalary(row.description));
    },
};

// ---------------- Workable ----------------
const workable = {
    async list(board, ctx) {
        const out = [];
        let token = null;
        for (let i = 0; i < 100 && out.length < ctx.budget; i++) {
            const j = await request(`https://apply.workable.com/api/v3/accounts/${board.tenant}/jobs`, { method: 'POST', body: { query: ctx.keyword || '', ...(token ? { token } : {}) } });
            for (const w of j.results || []) {
                const loc = w.location || {};
                out.push(job(board, {
                    title: w.title,
                    jobId: w.shortcode,
                    department: (w.department || [])[0] || null,
                    location: [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || null,
                    locations: (w.locations || []).map((l) => [l.city, l.region, l.country].filter(Boolean).join(', ')),
                    country: loc.country || null,
                    remote: w.remote === true || w.workplace === 'remote' ? true : undefined,
                    workplaceType: w.workplace || null,
                    employmentType: w.type || null,
                    postedAt: w.published,
                    url: `https://apply.workable.com/${board.tenant}/j/${w.shortcode}/`,
                    applyUrl: `https://apply.workable.com/${board.tenant}/j/${w.shortcode}/apply/`,
                    _detail: `https://apply.workable.com/api/v2/accounts/${board.tenant}/jobs/${w.shortcode}`,
                }));
            }
            token = j.nextPage;
            if (!token || !(j.results || []).length) break;
        }
        return out;
    },
    async describe(row) {
        const d = await request(row._detail);
        row.description = htmlToText([d.description, d.requirements, d.benefits].filter(Boolean).join('<br><br>'));
        Object.assign(row, parseSalary(row.description));
    },
};

// ---------------- Recruitee ----------------
const recruitee = {
    async list(board) {
        const j = await request(`https://${board.tenant}.recruitee.com/api/offers/`);
        return (j.offers || []).map((r) => {
            const description = htmlToText([r.description, r.requirements].filter(Boolean).join('<br><br>'));
            const s = r.salary;
            const structured = s?.min != null ? { salaryMin: Number(s.min), salaryMax: Number(s.max ?? s.min), salaryCurrency: s.currency || null, salaryPeriod: period(s.period), salaryText: null } : null;
            return job(board, {
                company: r.company_name || board.name,
                title: r.title,
                jobId: r.id,
                department: r.department || null,
                location: r.location || [r.city, r.country].filter(Boolean).join(', '),
                locations: (r.locations || []).map((l) => [l.city, l.country].filter(Boolean).join(', ')),
                country: r.country || null,
                remote: r.remote === true ? true : undefined,
                workplaceType: r.remote ? 'remote' : r.hybrid ? 'hybrid' : r.on_site ? 'onsite' : null,
                employmentType: r.employment_type_code || null,
                postedAt: r.published_at ? r.published_at.replace(' UTC', 'Z').replace(' ', 'T') : r.created_at,
                description,
                salary: salaryOr(structured, description),
                url: r.careers_url,
                applyUrl: r.careers_apply_url,
            });
        });
    },
};

// ---------------- Personio ----------------
const tag = (x, t) => x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;
const xmlText = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const personio = {
    async list(board) {
        const tld = board.region === 'com' ? 'com' : 'de';
        const x = await request(`https://${board.tenant}.jobs.personio.${tld}/xml?language=en`, { as: 'text' });
        return (x.match(/<position>[\s\S]*?<\/position>/g) || []).map((p) => {
            const id = tag(p, 'id');
            const offices = [tag(p, 'office'), ...((tag(p, 'additionalOffices') || '').match(/<office>([^<]*)<\/office>/g) || []).map((o) => o.replace(/<\/?office>/g, ''))].filter(Boolean).map(xmlText);
            const sections = (p.match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) || []).map((d) => `${xmlText(tag(d, 'name'))}\n${htmlToText(xmlText(tag(d, 'value')))}`);
            const description = sections.join('\n\n').trim();
            return job(board, {
                company: xmlText(tag(p, 'subcompany')) || board.name,
                title: xmlText(tag(p, 'name')),
                jobId: id,
                department: xmlText(tag(p, 'department')) || null,
                location: offices[0],
                locations: offices,
                employmentType: [tag(p, 'employmentType'), tag(p, 'schedule')].filter(Boolean).join(', ') || null,
                postedAt: tag(p, 'createdAt'),
                description,
                salary: parseSalary(description),
                url: `https://${board.tenant}.jobs.personio.${tld}/job/${id}`,
                applyUrl: `https://${board.tenant}.jobs.personio.${tld}/job/${id}#apply`,
            });
        });
    },
};

export const FETCHERS = { greenhouse, lever, ashby, smartrecruiters, workable, recruitee, personio, workday };
