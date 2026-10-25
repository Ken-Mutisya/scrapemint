// Google Jobs Scraper: job listings from Google's jobs search (udm=8), which
// aggregates LinkedIn, Indeed, ZipRecruiter, Glassdoor, Monster, company
// career sites and hundreds of smaller boards.
//
// Strategy
// --------
// One request = google.com/search?q=<role> jobs in <place>&udm=8 through
// Apify's GOOGLE_SERP proxy, which is billed per request ($0.0025), not per
// byte. A page carries 10 jobs with the full description, highlights, salary,
// employment type and every apply link. Google does not page this view
// (start=10 returns an empty page, tested 2026-10-25), and its filter chips
// are ignored, so the actor reaches more jobs by fanning out over query
// variants ("remote <role>", "senior <role>", ...) and filters on the parsed
// fields itself.
//
// Cost control
// ------------
// A fan-out stops for a search once two pages in a row add fewer than 3 new
// jobs: below that a page costs more than it earns. SERP spend is also capped
// at half of what the run has charged (proxy-guard). No proxy input is
// exposed, so a buyer cannot route the run elsewhere.
//
// Pay per event
// -------------
//   job ($0.002) one unique job that passed the filters

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseJobsPage, parseHealth, noJobsPage } from './parse.js';

const PRICE = 0.002;
const MIN_NEW = 3;
const VARIANTS = ['', 'remote', 'senior', 'entry level', 'junior', 'lead', 'manager', 'associate', 'contract', 'part time',
    'hybrid', 'full time', 'principal', 'specialist', 'coordinator', 'director', 'intern', 'temporary', 'night shift', 'weekend'];
const TYPE_WORDS = { FULLTIME: 'full time', PARTTIME: 'part time', CONTRACTOR: 'contract', INTERN: 'internship' };
const TYPE_MATCH = { FULLTIME: /full-time/i, PARTTIME: /part-time/i, CONTRACTOR: /contractor|temp work|per diem/i, INTERN: /internship/i };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = ['data analyst'],
    locations = [],
    maxJobs = 50,
    expandQueries = true,
    employmentTypes = [],
    postedWithinDays = 0,
    includeDescription = true,
    country = 'us',
    language = 'en',
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const qs = list(queries);
const locs = list(locations);
const types = list(employmentTypes).filter((t) => TYPE_MATCH[t]);
const cap = Math.max(1, Number(maxJobs) || 50);
const maxAgeMs = Number(postedWithinDays) > 0 ? Number(postedWithinDays) * 864e5 : 0;

if (!qs.length) {
    await Actor.pushData({ note: 'Add at least one search query, e.g. "data analyst". Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({ tiers: ['serp'], share: 0.5, floorUsd: 0.01, isBlocked: (r) => r.statusCode !== 200 || /\/sorry\/index|unusual traffic/i.test(r.body.slice(0, 5000)) });
const seen = new Set();
let out = 0;
let stop = false;
let pages = 0;
let emptyParses = 0;
const deadline = installDeadline(() => Actor.setValue('SUMMARY', summary()));

function summary() {
    return { jobs: out, pages, ...guard.report(), queries: qs, locations: locs };
}

function keep(job) {
    if (types.length && !types.some((t) => TYPE_MATCH[t].test(job.employmentType || ''))) return false;
    if (maxAgeMs && (!job.postedAt || Date.now() - Date.parse(job.postedAt) > maxAgeMs)) return false;
    return true;
}

const searches = qs.flatMap((q) => (locs.length ? locs.map((l) => ({ q, l })) : [{ q, l: null }]));
const typeWord = types.length === 1 ? TYPE_WORDS[types[0]] : '';

for (const { q, l } of searches) {
    if (stop || out >= cap || deadline.pastSoft()) break;
    let weak = 0;
    // With a type filter, type-word variants either repeat the base search or contradict it.
    const variants = (expandQueries ? VARIANTS : ['']).filter((v) => !typeWord || !/^(full time|part time|contract|temporary|intern)$/.test(v));
    for (const v of variants) {
        if (stop || out >= cap || deadline.pastSoft()) break;
        const words = [typeWord, v, q].filter(Boolean).join(' ');
        const text = `${words} jobs${l ? ` in ${l}` : ''}`;
        const url = `http://www.google.com/search?${new URLSearchParams({ q: text, udm: '8', hl: language, gl: country })}`;
        const res = await guard.get(url, { timeoutMs: 60_000 });
        pages++;
        if (!res) {
            log.warning(`No page for "${text}" (blocked or out of proxy budget).`);
            if (!guard.canSpend('serp')) { stop = true; break; }
            continue;
        }
        const jobs = parseJobsPage(res.body, { query: text });
        const health = parseHealth(res.body, jobs);
        if (health.docids && !health.parsed) {
            emptyParses++;
            log.warning(`Google returned ${health.docids} jobs for "${text}" but none parsed: the page layout may have changed.`);
        }
        if (!jobs.length && noJobsPage(res.body) && v === '') {
            log.info(`Google has no jobs for "${text}".`);
            break;
        }
        const fresh = [];
        for (const j of jobs) {
            const key = j.jobId || `${j.title}|${j.company}|${j.location}`.toLowerCase();
            const alt = `${j.title}|${j.company}|${j.location}`.toLowerCase();
            if (seen.has(key) || seen.has(alt)) continue;
            seen.add(key); seen.add(alt);
            if (!keep(j)) continue;
            fresh.push({ ...j, description: includeDescription ? j.description : undefined, searchQuery: text, scrapedAt: new Date().toISOString() });
        }
        const rows = fresh.slice(0, cap - out);
        if (rows.length) {
            await Actor.pushData(rows);
            out += rows.length;
            if (!(await chargeRows(guard, 'job', PRICE, rows.length))) stop = true;
        }
        log.info(`"${text}": ${jobs.length} on page, ${rows.length} new (total ${out}).`);
        weak = fresh.length < MIN_NEW ? weak + 1 : 0;
        if (weak >= 2) { log.info(`Variants for "${q}${l ? ` in ${l}` : ''}" stopped adding jobs; moving on.`); break; }
    }
}

if (!out) await Actor.pushData({ note: emptyParses ? 'Google returned jobs but the page could not be read. Not charged; please report it in Issues.' : 'No jobs matched. Not charged. Try a broader query or fewer filters.' });
await Actor.setValue('SUMMARY', summary());
log.info(`Done: ${out} jobs from ${pages} pages. ${JSON.stringify(guard.report())}`);
await Actor.exit();
