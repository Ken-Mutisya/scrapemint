#!/usr/bin/env node
// Build src/directory.json: every live public Workday career site we can find,
// so a buyer can type "nvidia" instead of hunting for the career-site URL.
//
// Candidates come from the Common Crawl URL index (keyless) across the last few
// crawls. Each candidate is then checked against the career site's own jobs
// endpoint and kept only if it answers, with its current job count.
//
//   node scripts/build-directory.mjs [crawls=6]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkdayUrl } from '../src/workday-url.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/directory.json');
const CRAWLS = Number(process.argv[2] || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The CDX index throws 502/503 under load. Pages that did load are cached on
// disk (CC_CACHE, default the OS temp dir), so a rerun only fetches the gaps.
const CACHE = process.env.CC_CACHE || path.join(os.tmpdir(), 'workday-cc-cache');
fs.mkdirSync(CACHE, { recursive: true });

async function get(url, tries = 8) {
    const file = path.join(CACHE, url.replace(/[^a-z0-9]+/gi, '_').slice(-180));
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (res.ok) {
                const text = await res.text();
                fs.writeFileSync(file, text);
                return text;
            }
            if (res.status === 404) return '';
        } catch {}
        await sleep(Math.min(60_000, 5000 * (i + 1)));
    }
    return null;
}

const collinfo = JSON.parse(await get('https://index.commoncrawl.org/collinfo.json'));
const candidates = new Map();
for (const c of collinfo.slice(0, CRAWLS)) {
    for (const pattern of ['*.myworkdayjobs.com', '*.myworkdaysite.com']) {
        const meta = await get(`${c['cdx-api']}?url=${pattern}&output=json&showNumPages=true`);
        if (!meta) { console.error(`skip ${c.id} ${pattern}: index unavailable`); continue; }
        const pages = JSON.parse(meta).pages || 0;
        for (let p = 0; p < pages; p++) {
            const body = await get(`${c['cdx-api']}?url=${pattern}&output=json&fl=url,status&page=${p}`);
            if (!body) { console.error(`skip ${c.id} ${pattern} page ${p}`); continue; }
            for (const line of body.split('\n')) {
                if (!line.trim()) continue;
                let r; try { r = JSON.parse(line); } catch { continue; }
                const w = parseWorkdayUrl(r.url);
                if (!w) continue;
                const key = `${w.host}|${w.tenant}|${w.site.toLowerCase()}`;
                if (!candidates.has(key)) candidates.set(key, w);
            }
            console.error(`${c.id} ${pattern} page ${p + 1}/${pages}: ${candidates.size} candidates`);
        }
    }
}

// "2100 NVIDIA USA" -> "NVIDIA USA": hiring entities often lead with an
// internal company code.
function cleanName(n) {
    const c = String(n || '').replace(/^[A-Z]?\d{2,}\s*[-–]?\s*/, '').replace(/^[A-Z0-9]{2,6}-(?=[A-Z])/, '').trim();
    return c.length >= 2 ? c : null;
}

// Check every candidate against the live jobs endpoint.
const live = [];
const list = [...candidates.values()];
let idx = 0;
async function worker() {
    while (idx < list.length) {
        const w = list[idx++];
        try {
            const res = await fetch(`https://${w.host}/wday/cxs/${w.tenant}/${w.site}/jobs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) continue;
            const j = await res.json();
            if (typeof j.total !== 'number') continue;
            // The employer's own name, from one posting: listing-only rows
            // otherwise show the tenant id ("abcsupply", "aig").
            let name = null;
            const first = j.jobPostings?.[0]?.externalPath;
            if (first) {
                try {
                    const d = await fetch(`https://${w.host}/wday/cxs/${w.tenant}/${w.site}${first}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
                    if (d.ok) name = cleanName((await d.json()).hiringOrganization?.name);
                } catch {}
            }
            live.push({ tenant: w.tenant, site: w.site, host: w.host, jobs: j.total, ...(name ? { name } : {}) });
        } catch {}
    }
}
await Promise.all(Array.from({ length: 16 }, worker));

// One tenant can run several sites (external, internal, campus); keep them all,
// sorted so the busiest site of each tenant comes first.
live.sort((a, b) => a.tenant.localeCompare(b.tenant) || b.jobs - a.jobs);
fs.writeFileSync(OUT, JSON.stringify(live));
console.error(`checked ${list.length} candidates, ${live.length} live sites, ${new Set(live.map((x) => x.tenant)).size} tenants -> ${OUT}`);
