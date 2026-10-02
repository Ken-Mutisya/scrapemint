#!/usr/bin/env node
// Build src/directories/<ats>.json: every live public job board we can find on
// each applicant tracking system, so one search can cover all of them.
//
// Candidates come from the Common Crawl URL index and Hacker News job threads
// (both keyless). Each is checked
// against the board's own public API and kept with its open-job count and,
// where the API gives one, the employer's name. Index pages are cached on disk
// (CC_CACHE) because the CDX server throws 502/503 under load; a rerun only
// fetches the gaps. Workday's directory is built by workday-jobs-scraper.
//
//   node scripts/build-directory.mjs [ats,...] [crawls=2]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/directories');
const CACHE = process.env.CC_CACHE || path.join(os.tmpdir(), 'ats-cc-cache');
fs.mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdx(url, tries = 8) {
    const file = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-180));
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (res.ok) { const t = await res.text(); fs.writeFileSync(file, t); return t; }
            if (res.status === 404) return '';
        } catch {}
        await sleep(Math.min(60_000, 5000 * (i + 1)));
    }
    return null;
}

const seg = (u, i) => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean)[i] || ''); } catch { return ''; } };
const sub = (u) => { try { return new URL(u).hostname.split('.')[0]; } catch { return ''; } };
const okSlug = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s);

async function getJson(url, init) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000), ...init });
    if (!res.ok) return null;
    return res.json().catch(() => null);
}

// Each ATS: Common Crawl patterns, a tenant extractor, and a live check that
// returns { jobs, name } or null.
const ATS = {
    greenhouse: {
        patterns: ['boards.greenhouse.io/*', 'job-boards.greenhouse.io/*', 'job-boards.eu.greenhouse.io/*'],
        tenant: (u) => {
            try { const q = new URL(u).searchParams.get('for'); if (q) return q.toLowerCase(); } catch {}
            const t = seg(u, 0).toLowerCase();
            return ['embed', 'v1', 'jobs', 'api'].includes(t) ? '' : t;
        },
        check: async (t) => {
            const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`);
            if (!j || !Array.isArray(j.jobs)) return null;
            const b = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}`);
            return { jobs: j.meta?.total ?? j.jobs.length, name: b?.name || j.jobs[0]?.company_name || null };
        },
    },
    lever: {
        patterns: ['jobs.lever.co/*', 'jobs.eu.lever.co/*'],
        tenant: (u) => { const t = seg(u, 0).toLowerCase(); return t; },
        region: (u) => (/jobs\.eu\.lever\.co/.test(u) ? 'eu' : undefined),
        check: async (t, region) => {
            const host = region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
            // limit=1: Lever returns full descriptions, so a whole board can be
            // megabytes. This only needs to know the board is live and hiring.
            const j = await getJson(`https://${host}/v0/postings/${t}?mode=json&limit=1`);
            if (!Array.isArray(j)) return null;
            return { jobs: j.length };
        },
    },
    ashby: {
        patterns: ['jobs.ashbyhq.com/*'],
        tenant: (u) => seg(u, 0),
        check: async (t) => {
            const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`);
            if (!j || !Array.isArray(j.jobs)) return null;
            return { jobs: j.jobs.length };
        },
    },
    smartrecruiters: {
        patterns: ['jobs.smartrecruiters.com/*', 'careers.smartrecruiters.com/*'],
        tenant: (u) => { const t = seg(u, 0); return ['oneclick-ui', 'sr-jobs', 'api'].includes(t.toLowerCase()) ? '' : t; },
        check: async (t) => {
            const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t)}/postings?limit=1`);
            if (!j || typeof j.totalFound !== 'number') return null;
            return { jobs: j.totalFound, name: j.content?.[0]?.company?.name || null };
        },
    },
    workable: {
        patterns: ['apply.workable.com/*'],
        tenant: (u) => { const t = seg(u, 0).toLowerCase(); return ['api', 'j', 'careers', 'static'].includes(t) ? '' : t; },
        check: async (t) => {
            const j = await getJson(`https://apply.workable.com/api/v3/accounts/${t}/jobs`, { method: 'POST', body: '{}' });
            if (!j || typeof j.total !== 'number') return null;
            const w = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${t}`);
            return { jobs: j.total, name: w?.name || null };
        },
    },
    recruitee: {
        patterns: ['*.recruitee.com'],
        tenant: (u) => { const t = sub(u).toLowerCase(); return ['www', 'app', 'api', 'blog', 'support', 'careers', 'help', 'status'].includes(t) ? '' : t; },
        check: async (t) => {
            const j = await getJson(`https://${t}.recruitee.com/api/offers/`);
            if (!j || !Array.isArray(j.offers)) return null;
            return { jobs: j.offers.length, name: j.offers[0]?.company_name || null };
        },
    },
    personio: {
        patterns: ['*.jobs.personio.de', '*.jobs.personio.com'],
        tenant: (u) => sub(u).toLowerCase(),
        region: (u) => (/personio\.com/.test(u) ? 'com' : 'de'),
        check: async (t, region) => {
            const res = await fetch(`https://${t}.jobs.personio.${region || 'de'}/xml`, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) return null;
            const x = await res.text();
            if (!/<workzag-jobs/.test(x)) return null;
            const name = x.match(/<subcompany>([^<]+)<\/subcompany>/)?.[1]?.replace(/&amp;/g, '&') || null;
            return { jobs: (x.match(/<position>/g) || []).length, name };
        },
    },
};

// Second source: Hacker News comments (mostly "Who is hiring" threads) through
// the keyless Algolia HN API. Common Crawl indexes few Lever pages (112
// candidates over two crawls); HN links 1,232 Lever boards. Slashes arrive as
// &#x2F; in comment_text.
const HN = {
    greenhouse: { q: 'boards.greenhouse.io', re: /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9._-]+)/g },
    lever: { q: 'jobs.lever.co', re: /jobs\.(eu\.)?lever\.co\/([A-Za-z0-9._-]+)/g, region: (m) => (m[1] ? 'eu' : undefined), group: 2 },
    ashby: { q: 'jobs.ashbyhq.com', re: /jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)/g },
    smartrecruiters: { q: 'jobs.smartrecruiters.com', re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9._-]+)/g },
    workable: { q: 'apply.workable.com', re: /apply\.workable\.com\/([A-Za-z0-9._-]+)/g },
    recruitee: { q: 'recruitee.com', re: /([a-z0-9-]+)\.recruitee\.com/g },
    personio: { q: 'jobs.personio', re: /([a-z0-9-]+)\.jobs\.personio\.(de|com)/g, region: (m) => m[2], group: 1 },
};

async function hnCandidates(name) {
    const h = HN[name];
    if (!h) return [];
    const out = [];
    let before = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 40; i++) {
        let j = null;
        for (let t = 0; t < 4 && !j; t++) {
            try {
                const r = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(h.q)}&tags=comment&hitsPerPage=1000&numericFilters=created_at_i<${before}`, { signal: AbortSignal.timeout(60_000) });
                if (r.ok) j = await r.json();
            } catch {}
            if (!j) await sleep(3000 * (t + 1));
        }
        const hits = j?.hits || [];
        if (!hits.length) break;
        for (const x of hits) {
            const text = String(x.comment_text || '').replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
            for (const m of text.matchAll(h.re)) {
                let t = m[h.group || 1];
                try { t = decodeURIComponent(t); } catch {}
                out.push({ tenant: t, region: h.region?.(m) });
            }
        }
        before = hits[hits.length - 1].created_at_i;
    }
    return out;
}

const args = process.argv.slice(2);
const which = (args[0] && !/^\d+$/.test(args[0]) ? args[0].split(',') : Object.keys(ATS));
const crawls = Number(args.find((a) => /^\d+$/.test(a)) || 2);
const collinfo = JSON.parse(await cdx('https://index.commoncrawl.org/collinfo.json'));

for (const name of which) {
    const ats = ATS[name];
    const candidates = new Map();
    let gaps = 0;
    for (const c of collinfo.slice(0, crawls)) {
        for (const pattern of ats.patterns) {
            const meta = await cdx(`${c['cdx-api']}?url=${encodeURIComponent(pattern)}&output=json&showNumPages=true`);
            if (!meta) { gaps++; console.error(`skip ${name} ${c.id} ${pattern}`); continue; }
            const pages = JSON.parse(meta).pages || 0;
            for (let p = 0; p < pages; p++) {
                const body = await cdx(`${c['cdx-api']}?url=${encodeURIComponent(pattern)}&output=json&fl=url&page=${p}`);
                if (body == null) { gaps++; console.error(`skip ${name} ${c.id} ${pattern} page ${p}`); continue; }
                for (const line of body.split('\n')) {
                    let r; try { r = JSON.parse(line); } catch { continue; }
                    const t = ats.tenant(r.url);
                    if (!t || !okSlug(t)) continue;
                    const region = ats.region?.(r.url);
                    const key = `${t.toLowerCase()}|${region || ''}`;
                    if (!candidates.has(key)) candidates.set(key, { tenant: t, ...(region ? { region } : {}) });
                }
            }
            console.error(`${name} ${c.id} ${pattern}: ${pages} page(s), ${candidates.size} candidates`);
        }
    }
    let fromHn = 0;
    for (const c of await hnCandidates(name)) {
        if (!c.tenant || !okSlug(c.tenant) || ['embed', 'v1', 'api', 'jobs', 'www', 'app', 'j'].includes(c.tenant.toLowerCase())) continue;
        const key = `${c.tenant.toLowerCase()}|${c.region || ''}`;
        if (!candidates.has(key)) { candidates.set(key, { tenant: name === 'ashby' || name === 'smartrecruiters' ? c.tenant : c.tenant.toLowerCase(), ...(c.region ? { region: c.region } : {}) }); fromHn += 1; }
    }
    console.error(`${name}: +${fromHn} candidates from Hacker News`);
    const list = [...candidates.values()];
    const live = [];
    let i = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
        while (i < list.length) {
            const c = list[i++];
            try {
                const r = await ats.check(c.tenant, c.region);
                if (r) live.push({ tenant: c.tenant, ...(c.region ? { region: c.region } : {}), jobs: r.jobs, ...(r.name ? { name: r.name } : {}) });
            } catch {}
        }
    }));
    live.sort((a, b) => a.tenant.localeCompare(b.tenant));
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(live));
    console.error(`DONE ${name}: ${list.length} candidates, ${live.length} live boards, ${live.filter((x) => x.jobs > 0).length} hiring, ${gaps} index gap(s)`);
}
