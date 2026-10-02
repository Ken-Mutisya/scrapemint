// Workday, ported from workday-jobs-scraper: the listing stops at 2,000 and an
// offset past it wraps to page one, so a site at the cap is split on its own
// facets until every slice fits. With no keyword the listing is newest first;
// with one it is by relevance, so the posted-within early stop needs no keyword.

import { request } from './http.js';
import { htmlToText, parseSalary, postedDaysAgo } from './parse.js';

const PAGE = 20;
const CAP = 2000;
const PAGE_BATCH = 6;

function flattenFacets(facets, out = []) {
    for (const f of facets || []) {
        if (f.facetParameter && Array.isArray(f.values) && f.values.length && f.values.every((v) => v.id)) {
            out.push({ param: f.facetParameter, values: f.values.filter((v) => (v.count ?? 1) > 0) });
        }
        if (Array.isArray(f.values)) flattenFacets(f.values.filter((v) => v.facetParameter), out);
    }
    return out;
}

// "2100 NVIDIA USA", "CN05 NVIDIA Shanghai WFOE", "ADUS-Adobe Inc.": internal entity codes first.
const cleanEntity = (n) => String(n || '').replace(/^\d+\s+/, '').replace(/^[A-Z]{2}\d{2,}\s+/, '').replace(/^[A-Z0-9]{2,6}-(?=[A-Z])/, '').trim() || null;

export const workday = {
    async list(board, ctx) {
        const base = `https://${board.host}/wday/cxs/${board.tenant}/${board.site}`;
        const found = new Map();
        const budget = ctx.budget;
        const page = (applied, offset) => request(`${base}/jobs`, { method: 'POST', body: { limit: PAGE, offset, searchText: ctx.keyword || '', appliedFacets: applied } });

        async function walk(applied, depth) {
            if (found.size >= budget) return;
            const first = await page(applied, 0);
            const total = Number(first.total) || 0;
            if (total >= CAP && depth < 4) {
                const used = new Set(Object.keys(applied));
                const options = flattenFacets(first.facets).filter((f) => !used.has(f.param));
                const score = (f) => f.values.reduce((a, v) => a + (v.count || 0), 0);
                const fits = options.filter((f) => f.values.every((v) => (v.count || 0) < CAP)).sort((a, b) => score(b) - score(a));
                const pick = fits[0] || options.sort((a, b) => Math.max(...a.values.map((v) => v.count || 0)) - Math.max(...b.values.map((v) => v.count || 0)))[0];
                if (pick) {
                    const queue = [...pick.values];
                    await Promise.all(Array.from({ length: 3 }, async () => {
                        while (queue.length && found.size < budget) {
                            const v = queue.shift();
                            await walk({ ...applied, [pick.param]: [v.id] }, depth + 1);
                        }
                    }));
                    return;
                }
            }
            const add = (p) => { if (p?.externalPath && !found.has(p.externalPath)) found.set(p.externalPath, p); };
            (first.jobPostings || []).forEach(add);
            const last = Math.min(total, CAP);
            for (let offset = PAGE; offset < last && found.size < budget; offset += PAGE * PAGE_BATCH) {
                const offsets = [];
                for (let o = offset; o < Math.min(last, offset + PAGE * PAGE_BATCH); o += PAGE) offsets.push(o);
                const pages = await Promise.all(offsets.map((o) => page(applied, o)));
                const posts = pages.flatMap((pg) => pg.jobPostings || []);
                if (!posts.length) break;
                posts.forEach(add);
                if (ctx.withinDays && !ctx.keyword && posts.every((p) => (postedDaysAgo(p.postedOn) ?? 0) > ctx.withinDays)) break;
            }
        }

        await walk({}, 0);
        return [...found.values()].map((p) => {
            const url = `https://${board.host}/${board.site}${p.externalPath}`;
            return {
                ats: 'workday',
                company: board.name || board.tenant.charAt(0).toUpperCase() + board.tenant.slice(1),
                title: p.title,
                jobId: (p.bulletFields || [])[0] || p.externalPath,
                department: null,
                team: null,
                location: p.locationsText || null,
                additionalLocations: null,
                country: null,
                remote: /\bremote\b/i.test(`${p.locationsText || ''} ${p.title || ''}`),
                workplaceType: null,
                employmentType: null,
                postedAt: null,
                postedDaysAgo: postedDaysAgo(p.postedOn),
                postedText: p.postedOn || null,
                description: null,
                salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryText: null,
                url,
                applyUrl: `${url}/apply`,
                boardTenant: board.tenant,
                _detail: `${base}${p.externalPath}`,
            };
        });
    },
    async describe(row) {
        const d = await request(row._detail);
        const info = d.jobPostingInfo || {};
        row.company = cleanEntity(d.hiringOrganization?.name) || row.company;
        row.jobId = info.jobReqId || row.jobId;
        row.location = info.location || row.location;
        row.additionalLocations = (info.additionalLocations || []).length ? info.additionalLocations : null;
        row.country = info.jobRequisitionLocation?.country?.descriptor || info.country?.descriptor || null;
        row.employmentType = info.timeType || null;
        row.workplaceType = info.remoteType || null;
        if (/remote/i.test(String(info.remoteType || ''))) row.remote = true;
        if (info.startDate) row.postedAt = new Date(`${info.startDate}T00:00:00Z`).toISOString();
        row.description = info.jobDescription ? htmlToText(info.jobDescription) : null;
        row.url = info.externalUrl || row.url;
        row.applyUrl = `${row.url.replace(/\/$/, '')}/apply`;
        Object.assign(row, parseSalary(row.description));
    },
};
