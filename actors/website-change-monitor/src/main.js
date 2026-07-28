// Website Change Monitor: Track Page Changes, Pay Per Change
//
// Strategy
// --------
// Fetch each monitored URL over plain HTTP, extract the meaningful text
// (optional CSS selector, otherwise main content with nav/footer/script
// boilerplate stripped), and compare it line-by-line against the baseline
// stored in a named key-value store from previous runs. Changed pages push
// a structured diff row (added/removed lines + timestamps). Designed to run
// on a schedule; state persists across runs in the buyer's own storage.
//
// Pay per event
// -------------
//   change_row ($0.01) charged only when a page actually changed.
//   Baselines (first sight of a URL), unchanged checks, and fetch errors
//   are always free. First 2 change rows per run are free.

import { createHash } from 'node:crypto';
import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_CHANGES = 2;
const HARD_CAP_URLS = 500;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1500000;
const CONCURRENCY = 8;
const STATE_TEXT_CAP = 60000;
const ROW_TEXT_CAP = 5000;
const DIFF_LINES_CAP = 200;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

const BOILERPLATE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template',
    'nav', 'header', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
    '[aria-hidden="true"]', '.cookie-banner', '#cookie-banner', '.cookie-consent',
];

await Actor.init();

// A monitor must never fail a buyer's scheduled run wholesale. Anything that
// escapes the per-item guards below, including a throw inside a top level
// await or a platform hiccup, is reported as a free diagnostic row and the run
// exits cleanly. Buyers get an explanation instead of a failed run, and a
// single bad page stops flagging the whole actor as broken.
let bailing = false;
const bail = async (kind, err) => {
    if (bailing) return;
    bailing = true;
    const message = err?.message ?? String(err);
    log.error(`${kind}: ${message}`);
    try {
        await Actor.pushData({
            type: 'error',
            status: 'error',
            error: `${kind}: ${message}`,
            note: 'the run stopped early on an unexpected error; this row is not charged',
            checkedAt: new Date().toISOString(),
        });
    } catch { /* reporting must not throw either */ }
    await Actor.exit();
};
process.on('unhandledRejection', (err) => { void bail('unhandled rejection', err); });
process.on('uncaughtException', (err) => { void bail('uncaught exception', err); });

const input = (await Actor.getInput()) ?? {};
const {
    urls = [],
    cssSelector = '',
    pushUnchangedRows = false,
    includeFullText = true,
    proxyConfiguration: proxyInput,
} = input;

const targets = (Array.isArray(urls) ? urls : String(urls).split(/[\n,]/))
    .map((u) => (typeof u === 'string' ? u : u?.url))
    .map((u) => String(u || '').trim()).filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
    .slice(0, HARD_CAP_URLS);
if (!targets.length) {
    log.warning('Provide "urls": a list of pages to monitor, e.g. ["https://example.com/pricing"].');
    await Actor.exit();
}
const selector = String(cssSelector || '').trim();

// A malformed buyer selector must not crash the run: cheerio's css-what
// parser THROWS on selectors like `div[class=unclosed` (this failed every
// run of one buyer's schedule before 2026-07-15). Validate once up front
// and report it as free error rows instead.
if (selector) {
    try {
        cheerio.load('<div></div>')(selector);
    } catch (err) {
        log.error(`cssSelector ${JSON.stringify(selector)} is not valid CSS (${err?.message}). Fix the selector and run again; nothing was charged.`);
        for (const url of targets) {
            await Actor.pushData({ url, status: 'error', changed: false, error: `invalid cssSelector: ${err?.message}`, checkedAt: new Date().toISOString() });
        }
        await Actor.exit();
    }
}

let dispatcher = null;
// Proxy resolution must never kill the run: buyers on plans without the
// selected proxy group would otherwise hard-fail before the first fetch.
try {
    const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));
    if (proxyConfiguration) {
        const proxyUrl = await proxyConfiguration.newUrl();
        if (proxyUrl) {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        }
    }
} catch (err) {
    log.warning(`Proxy unavailable (${err?.message}); continuing without proxy.`);
}

// Named storage can be refused or rate limited on some accounts; falling back
// to the run's own store keeps the check working, at the cost of losing the
// baseline between runs, which is far better than failing outright.
let state;
try {
    state = await Actor.openKeyValueStore('website-change-monitor-state');
} catch (err) {
    log.warning(`named state store unavailable (${err?.message}); using this run's own store instead`);
    state = await Actor.openKeyValueStore();
}
const keyFor = (url) => `page-${createHash('sha256').update(selector + '|' + url).digest('hex').slice(0, 32)}`;

async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; WebsiteChangeMonitor/1.0; +https://apify.com/scrapemint/website-change-monitor)',
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'en',
            },
            ...(dispatcher ? { dispatcher } : {}),
        });
        const ctype = res.headers.get('content-type') || '';
        if (!res.ok || !/text\/html|application\/xhtml/.test(ctype)) {
            return { ok: false, status: res.status, html: '' };
        }
        return { ok: true, status: res.status, html: (await res.text()).slice(0, MAX_HTML_BYTES) };
    } catch {
        return { ok: false, status: 0, html: '' };
    } finally {
        clearTimeout(timer);
    }
}

function extractText(html) {
    const $ = cheerio.load(html);
    const title = ($('title').first().text() || '').trim() || null;
    let $scope;
    if (selector) {
        $scope = $(selector).first();
        if (!$scope.length) return { title, text: '', selectorMissing: true };
    } else {
        for (const sel of BOILERPLATE_SELECTORS) $(sel).remove();
        $scope = $('main').first();
        if (!$scope.length) $scope = $('article').first();
        if (!$scope.length) $scope = $('[role="main"]').first();
        if (!$scope.length) $scope = $('body');
    }
    // Line-oriented text: block elements become line breaks so diffs are readable.
    $scope.find('br, p, div, li, tr, h1, h2, h3, h4, h5, h6, section').each((_, el) => {
        $(el).append('\n');
    });
    const text = $scope.text()
        .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
        .join('\n').slice(0, STATE_TEXT_CAP);
    return { title, text, selectorMissing: false };
}

function diffLines(prev, curr) {
    const prevSet = new Map();
    for (const l of prev.split('\n')) prevSet.set(l, (prevSet.get(l) || 0) + 1);
    const currSet = new Map();
    for (const l of curr.split('\n')) currSet.set(l, (currSet.get(l) || 0) + 1);
    const added = [];
    const removed = [];
    for (const [l, n] of currSet) {
        const p = prevSet.get(l) || 0;
        for (let i = 0; i < n - p && added.length < DIFF_LINES_CAP; i++) added.push(l);
    }
    for (const [l, n] of prevSet) {
        const c = currSet.get(l) || 0;
        for (let i = 0; i < n - c && removed.length < DIFF_LINES_CAP; i++) removed.push(l);
    }
    return { added, removed };
}

let changeRows = 0;
let baselines = 0;
let unchanged = 0;
let errors = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function pushChange(row) {
    await Actor.pushData(row);
    changeRows += 1;
    if (changeRows > FREE_TIER_CHANGES) {
        try {
            await Actor.charge({ eventName: 'change_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function checkUrl(url) {
    const key = keyFor(url);
    const now = new Date().toISOString();
    const prev = await state.getValue(key);
    const res = await fetchHtml(url);
    if (!res.ok) {
        errors += 1;
        await Actor.pushData({ url, status: 'error', changed: false, httpStatus: res.status, checkedAt: now });
        return;
    }
    const { title, text, selectorMissing } = extractText(res.html);
    if (selectorMissing) {
        errors += 1;
        await Actor.pushData({ url, status: 'error', changed: false, httpStatus: res.status, error: `selector "${selector}" not found`, checkedAt: now });
        return;
    }
    const hash = createHash('sha256').update(text).digest('hex');

    if (!prev) {
        baselines += 1;
        await state.setValue(key, { url, hash, text, title, firstSeenAt: now, lastChangedAt: null, lastCheckedAt: now });
        await Actor.pushData({ url, status: 'baseline', changed: false, title, httpStatus: res.status, textHash: hash, firstSeenAt: now, checkedAt: now });
        return;
    }
    if (prev.hash === hash) {
        unchanged += 1;
        await state.setValue(key, { ...prev, lastCheckedAt: now });
        if (pushUnchangedRows) {
            await Actor.pushData({ url, status: 'unchanged', changed: false, title, httpStatus: res.status, textHash: hash, firstSeenAt: prev.firstSeenAt, lastChangedAt: prev.lastChangedAt, checkedAt: now });
        }
        return;
    }

    const { added, removed } = diffLines(prev.text || '', text);
    const row = {
        url,
        status: 'changed',
        changed: true,
        title,
        httpStatus: res.status,
        addedLines: added,
        removedLines: removed,
        addedCount: added.length,
        removedCount: removed.length,
        textHash: hash,
        previousTextHash: prev.hash,
        firstSeenAt: prev.firstSeenAt,
        previousChangeAt: prev.lastChangedAt,
        checkedAt: now,
    };
    if (includeFullText) {
        row.previousText = (prev.text || '').slice(0, ROW_TEXT_CAP);
        row.currentText = text.slice(0, ROW_TEXT_CAP);
    }
    await state.setValue(key, { url, hash, text, title, firstSeenAt: prev.firstSeenAt, lastChangedAt: now, lastCheckedAt: now });
    await pushChange(row);
}

log.info(`Monitoring ${targets.length} URL(s)${selector ? ` with selector "${selector}"` : ' (auto main-content mode)'}.`);

for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    // Any single page's unexpected throw becomes a free error row, never a
    // failed run (a monitor on a schedule must degrade, not crash).
    await Promise.all(targets.slice(i, i + CONCURRENCY).map((u) => checkUrl(u).catch(async (err) => {
        errors += 1;
        log.warning(`${u}: ${err?.message}`);
        await Actor.pushData({ url: u, status: 'error', changed: false, error: String(err?.message || err).slice(0, 300), checkedAt: new Date().toISOString() }).catch(() => {});
    })));
}

log.info(`Done. ${changeRows} change(s) (${Math.max(0, changeRows - FREE_TIER_CHANGES)} chargeable), ${baselines} new baseline(s), ${unchanged} unchanged, ${errors} error(s).`);
await Actor.exit();

// Buyer-selected RESIDENTIAL or SERP proxy groups bill the developer under
// pay-per-event pricing, and this data source works from datacenter IPs, so
// those groups are stripped (buyer-supplied proxyUrls pass through untouched).
function sanitizeProxyInput(p) {
    if (!p || typeof p !== 'object') return p;
    const out = { ...p };
    if (Array.isArray(out.apifyProxyGroups)) {
        const kept = out.apifyProxyGroups.filter((g) => !/RESIDENTIAL|SERP/i.test(String(g)));
        if (kept.length !== out.apifyProxyGroups.length) {
            log.warning('Ignoring RESIDENTIAL/SERP proxy groups: this source works from datacenter IPs and premium groups only raise run costs.');
        }
        if (kept.length) out.apifyProxyGroups = kept;
        else delete out.apifyProxyGroups;
    }
    return out;
}
