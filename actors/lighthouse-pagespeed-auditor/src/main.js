// Lighthouse & PageSpeed Bulk Auditor: Google Lighthouse on many URLs,
// mobile and/or desktop, flattened into one row per URL and device.
//
// Strategy
// --------
// The PageSpeed Insights API answers 429 without a key from shared IPs, so
// this actor runs Lighthouse itself: the lighthouse npm package drives the
// Chrome that ships in Apify's Playwright image, launched with
// chrome-launcher. One Chrome per worker is reused across audits and
// relaunched if it crashes or an audit hangs. Mobile uses Lighthouse's
// default config (Moto G Power, simulated slow 4G); desktop uses its
// desktop config. Both are the same settings PageSpeed Insights uses for its
// lab data. Field data (CrUX) is not part of a Lighthouse run.
// Workers run one audit at a time, because parallel audits in one container
// compete for CPU and inflate timings. Apify CPUs score 1,200-2,800 on
// Lighthouse's benchmark; each row carries benchmarkIndex so timings can be
// read in context.
//
// No key, no proxy: Chrome loads each site directly, as a visitor would.
// Tested from Apify on 2026-10-25.
//
// Pay per event
// -------------
//   audit ($0.02) one completed Lighthouse audit of one URL on one device
// Measured 2026-10-25: about $0.009 of compute per audit at 4 GB.
// No start fee. A URL that fails to load is returned free.

import { Actor, log } from 'apify';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    urls = [],
    devices = ['mobile'],
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    saveHtmlReport = false,
    maxConcurrency = 1,
    maxResults = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,\s]+/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const normalize = (u) => { let s = u.trim(); if (!/^https?:\/\//i.test(s)) s = `https://${s}`; try { return new URL(s).toString(); } catch { return null; } };
// An empty input (store health checks) runs the form's prefill.
const targets = [...new Set((list(urls).length ? list(urls) : ['https://apify.com']).map(normalize).filter(Boolean))];
const devs = (list(devices).length ? list(devices) : ['mobile']).map((d) => d.toLowerCase()).filter((d) => d === 'mobile' || d === 'desktop');
const cats = list(categories).filter((c) => ['performance', 'accessibility', 'best-practices', 'seo'].includes(c));
const jobs = targets.flatMap((url) => devs.map((device) => ({ url, device }))).slice(0, Math.max(1, Number(maxResults) || 500));
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 100_000;
const AUDIT_TIMEOUT = 150_000;

const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--mute-audio'];
async function launch() {
    return chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: CHROME_FLAGS, logLevel: 'silent' });
}

// ---------- flattening ----------
const num = (a) => (a && typeof a.numericValue === 'number' ? Math.round(a.numericValue * (a.numericUnit === 'unitless' ? 1000 : 1)) / (a.numericUnit === 'unitless' ? 1000 : 1) : null);
const score = (c) => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);

function opportunities(lhr) {
    const perf = lhr.categories.performance;
    if (!perf) return [];
    const out = [];
    for (const ref of perf.auditRefs) {
        const a = lhr.audits[ref.id];
        if (!a || a.score === null || a.score >= 0.9 || a.scoreDisplayMode === 'informative' && !a.details?.overallSavingsMs) continue;
        if (['metric', 'manual', 'notApplicable'].includes(a.scoreDisplayMode) || ref.group === 'metrics') continue;
        const ms = a.details?.overallSavingsMs ?? Math.max(0, ...Object.values(a.metricSavings || {}).filter((v) => typeof v === 'number'));
        const bytes = a.details?.overallSavingsBytes ?? null;
        out.push({ id: a.id, title: a.title, displayValue: a.displayValue || null, savingsMs: ms ? Math.round(ms) : null, savingsBytes: bytes ? Math.round(bytes) : null, score: Math.round(a.score * 100) });
    }
    return out.sort((x, y) => (y.savingsMs || 0) - (x.savingsMs || 0) || (y.savingsBytes || 0) - (x.savingsBytes || 0)).slice(0, 10);
}

function failed(lhr, cat) {
    const c = lhr.categories[cat];
    if (!c) return [];
    return c.auditRefs
        .map((r) => ({ r, a: lhr.audits[r.id] }))
        .filter(({ r, a }) => a && r.weight > 0 && a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'manual' && a.scoreDisplayMode !== 'notApplicable')
        .map(({ a }) => ({ id: a.id, title: a.title, items: Array.isArray(a.details?.items) ? a.details.items.length : null }));
}

function toRow(job, lhr) {
    const A = lhr.audits;
    const lcp = num(A['largest-contentful-paint']);
    const cls = num(A['cumulative-layout-shift']);
    const tbt = num(A['total-blocking-time']);
    const requests = A['network-requests']?.details?.items || [];
    const thirdParty = A['third-parties-insight']?.details?.items || A['third-party-summary']?.details?.items || [];
    return {
        url: job.url,
        finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || null,
        device: job.device,
        performanceScore: score(lhr.categories.performance),
        accessibilityScore: score(lhr.categories.accessibility),
        bestPracticesScore: score(lhr.categories['best-practices']),
        seoScore: score(lhr.categories.seo),
        largestContentfulPaintMs: lcp,
        cumulativeLayoutShift: cls,
        totalBlockingTimeMs: tbt,
        firstContentfulPaintMs: num(A['first-contentful-paint']),
        speedIndexMs: num(A['speed-index']),
        timeToInteractiveMs: num(A.interactive),
        serverResponseTimeMs: num(A['server-response-time']) ?? num(A['document-latency-insight']),
        coreWebVitalsLabPass: lcp != null && cls != null && tbt != null ? lcp <= 2500 && cls <= 0.1 && tbt <= 200 : null,
        pageWeightBytes: num(A['total-byte-weight']),
        requestCount: requests.length || null,
        domElements: num(A['dom-size']) ?? num(A['dom-size-insight']),
        thirdPartyDomains: thirdParty.length || null,
        lcpElement: (() => {
            const items = A['largest-contentful-paint-element']?.details?.items || A['lcp-breakdown-insight']?.details?.items || [];
            const node = items.flatMap((i) => i.items || [i]).find((i) => i.node)?.node;
            return node ? (node.snippet || node.selector || null)?.slice(0, 300) : null;
        })(),
        opportunities: opportunities(lhr),
        failedAccessibilityAudits: failed(lhr, 'accessibility'),
        failedSeoAudits: failed(lhr, 'seo'),
        failedBestPracticesAudits: failed(lhr, 'best-practices'),
        warnings: (lhr.runWarnings || []).slice(0, 5),
        benchmarkIndex: lhr.environment?.benchmarkIndex ?? null,
        cpuSlowdown: lhr.configSettings?.throttling?.cpuSlowdownMultiplier ?? null,
        lighthouseVersion: lhr.lighthouseVersion,
        fetchedAt: lhr.fetchTime,
    };
}

// ---------- run ----------
let charged = 0;
let done = 0;
let stop = false;
const queue = [...jobs];
const conc = Math.min(3, Math.max(1, Number(maxConcurrency) || 1));
log.info(`${jobs.length} audits (${targets.length} URLs x ${devs.join(' + ')}), ${conc} at a time.`);

async function audit(port, job) {
    // Screenshots only matter for the HTML report; skipping them saves time and memory.
    const skipAudits = saveHtmlReport ? undefined : ['screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot'];
    const flags = { port, output: saveHtmlReport ? ['json', 'html'] : 'json', logLevel: 'error', onlyCategories: cats.length ? cats : undefined, skipAudits, maxWaitForLoad: 45_000 };
    let timer;
    const run = lighthouse(job.url, flags, job.device === 'desktop' ? desktopConfig : undefined);
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Audit took longer than 150 s')), AUDIT_TIMEOUT); });
    try { return await Promise.race([run, guard]); } finally { clearTimeout(timer); }
}

async function worker() {
    let chrome = await launch();
    while (queue.length && !stop) {
        if (pastDeadline()) { log.warning('Run timeout is close; stopping. Remaining URLs are not audited or charged.'); stop = true; break; }
        const job = queue.shift();
        let row;
        try {
            const res = await audit(chrome.port, job);
            const lhr = res?.lhr;
            if (!lhr) throw new Error('Lighthouse returned no result');
            if (lhr.runtimeError) {
                row = { url: job.url, device: job.device, error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}`.slice(0, 400), note: 'Not charged.' };
            } else {
                row = toRow(job, lhr);
                if (saveHtmlReport && Array.isArray(res.report)) {
                    const key = `report-${createHash('md5').update(`${job.url}|${job.device}`).digest('hex').slice(0, 12)}`;
                    await Actor.setValue(key, res.report[1], { contentType: 'text/html; charset=utf-8' });
                    const store = await Actor.openKeyValueStore();
                    row.reportUrl = store.getPublicUrl(key);
                }
            }
        } catch (err) {
            row = { url: job.url, device: job.device, error: err.message.slice(0, 400), note: 'Not charged.' };
            // A hung or crashed Chrome is replaced before the next URL.
            try { await chrome.kill(); } catch { /* already gone */ }
            chrome = await launch();
        }
        await Actor.pushData(row);
        done++;
        if (!row.error) {
            charged++;
            try {
                const r = await Actor.charge({ eventName: 'audit' });
                if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
            } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        }
        log.info(`${done}/${jobs.length} ${job.device} ${job.url}: ${row.error ? `failed (${row.error.slice(0, 80)})` : `performance ${row.performanceScore}, LCP ${row.largestContentfulPaintMs} ms`}`);
    }
    try { await chrome.kill(); } catch { /* ignore */ }
}
await Promise.all(Array.from({ length: conc }, worker));

await Actor.setValue('SUMMARY', { audits: jobs.length, completed: charged, failed: done - charged });
log.info(`Done: ${charged} audits completed, ${done - charged} failed.`);
await Actor.exit();
