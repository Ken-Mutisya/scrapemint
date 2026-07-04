// ForexFactory Economic Calendar Scraper (No Login)
//
// Strategy
// --------
// ForexFactory itself publishes its weekly calendar as a free static JSON
// feed on a CDN (faireconomy.media). For the common ranges we fetch that
// feed over plain HTTP: no browser, no proxy, near-zero compute. Each feed
// entry is { title, country, date (ISO+offset), impact, forecast, previous }.
//
// For ranges the feed cannot serve (this_month, next_month, custom spans,
// or when the caller wants per-event detail pages) we fall back to scraping
// the public HTML calendar with Playwright. The HTML page accepts:
//   ?day=may9.2026          single day
//   ?week=may3.2026         week starting Sunday
//   ?month=may.2026         full month
//   ?range=may1.2026-may7.2026   custom span
// Each event is a `tr.calendar__row` with cells for time, currency,
// impact, title, actual, forecast, previous. Day-breaker rows reset the
// current date as we walk the table top to bottom.
//
// Output schema is identical for both paths so downstream pipelines do not
// care which path produced a row.
//
// Pay-per-event:
//   event_row ($0.01) charged when an event row is pushed.
//   First 2 event rows per run are free.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_ROWS = 2;
const BASE = 'https://www.forexfactory.com';
const FEED_BASE = 'https://nfs.faireconomy.media';
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    range = 'this_week',
    startDate = '',
    endDate = '',
    currencies = [],
    impactLevels = ['high', 'medium'],
    includeDetail = false,
    maxEvents = 1000,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const cleanCurrencies = new Set((Array.isArray(currencies) ? currencies : [currencies])
    .map((c) => String(c || '').trim().toUpperCase()).filter(Boolean));
const cleanImpacts = new Set((Array.isArray(impactLevels) ? impactLevels : [impactLevels])
    .map((i) => String(i || '').trim().toLowerCase()).filter(Boolean));
if (cleanImpacts.size === 0) { ['high', 'medium'].forEach((i) => cleanImpacts.add(i)); }

let totalRowsPushed = 0;

// ---------- Path selection: cheap HTTP feed first, browser only if needed ----------

const feedPlan = includeDetail ? null : planFeeds(range, startDate, endDate);
let served = false;
if (feedPlan) {
    log.info(`Trying JSON feed path (range=${range}, feeds=${feedPlan.feeds.join(',')}).`);
    served = await runFromFeed(feedPlan);
}

if (!served) {
    if (includeDetail) log.info('includeDetail set: using browser path for detail pages.');
    else log.info(`Range "${range}" not served by JSON feed; using browser path.`);
    await runPlaywright();
}

log.info(`Run complete. Events pushed: ${totalRowsPushed}.`);
await Actor.exit();

// ---------- JSON feed path ----------

// Map an input range to the faireconomy weekly feed(s) that can satisfy it.
// `feeds` are required (a fetch failure forces the browser fallback);
// `optional` are best-effort (skipped silently if unavailable). `fromYmd`/
// `toYmd` apply a per-day filter for single-day ranges. Returns null for
// ranges no single weekly feed can serve (month/custom) -> browser path.
function planFeeds(r, sd, ed) {
    const key = String(r || 'this_week').toLowerCase();
    const today = new Date();
    const ymd = (d) => d.toISOString().slice(0, 10);
    if (key === 'this_week') return { feeds: ['thisweek'], optional: [] };
    if (key === 'next_week') return { feeds: ['nextweek'], optional: [] };
    if (key === 'last_week') return { feeds: ['lastweek'], optional: [] };
    if (key === 'today') { const s = ymd(today); return { feeds: ['thisweek'], optional: [], fromYmd: s, toYmd: s }; }
    if (key === 'tomorrow') { const s = ymd(addDays(today, 1)); return { feeds: ['thisweek'], optional: ['nextweek'], fromYmd: s, toYmd: s }; }
    if (key === 'yesterday') { const s = ymd(addDays(today, -1)); return { feeds: ['thisweek'], optional: ['lastweek'], fromYmd: s, toYmd: s }; }
    return null; // this_month, next_month, custom
}

async function fetchFeed(name) {
    const url = `${FEED_BASE}/ff_calendar_${name}.json`;
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30000);
        const res = await fetch(url, {
            signal: ac.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ScrapemintCalendar/1.0)',
                Accept: 'application/json',
            },
        });
        clearTimeout(timer);
        if (!res.ok) { log.info(`Feed ${name}: HTTP ${res.status}`); return null; }
        const data = await res.json();
        return Array.isArray(data) ? data : null;
    } catch (e) {
        log.warning(`Feed ${name} fetch failed: ${e?.message}`);
        return null;
    }
}

function feedEntryToEvent(fe) {
    const iso = String(fe.date || '');
    const date = iso.slice(0, 10) || null;
    const timePart = iso.length >= 16 ? iso.slice(11, 16) : null;
    const impact = mapFeedImpact(fe.impact);
    const isAllDay = impact === 'holiday' && (!timePart || timePart === '00:00');
    const off = iso.match(/([+-]\d{2}:\d{2})$/);
    const displayTimezone = off ? `GMT${off[1]}` : 'ForexFactory display zone';
    return {
        eventIdRaw: null,
        date,
        time: isAllDay ? null : timePart,
        isAllDay,
        // Full ISO string with offset; downstream Date.parse() resolves to UTC.
        timestamp: iso || null,
        currency: fe.country ? String(fe.country).toUpperCase() : null,
        impact,
        title: fe.title || null,
        actual: null, // weekly feed does not carry the released actual value
        forecast: fe.forecast || null,
        previous: fe.previous || null,
        revised: null,
        detailUrl: null,
        displayTimezone,
    };
}

function mapFeedImpact(s) {
    const t = String(s || '').toLowerCase();
    if (t.includes('high')) return 'high';
    if (t.includes('medium')) return 'medium';
    if (t.includes('low')) return 'low';
    if (t.includes('holiday') || t.includes('non-economic')) return 'holiday';
    return null;
}

// Returns true if the feed satisfied the request, false to force browser fallback.
async function runFromFeed(plan) {
    const merged = [];
    for (const name of plan.feeds) {
        const rows = await fetchFeed(name);
        if (rows == null) {
            log.warning(`Required feed "${name}" unavailable; falling back to browser.`);
            return false;
        }
        merged.push(...rows);
    }
    for (const name of plan.optional || []) {
        const rows = await fetchFeed(name);
        if (rows) merged.push(...rows);
    }

    const seen = new Set();
    let pushed = 0;
    for (const fe of merged) {
        if (totalRowsPushed >= maxEvents) break;
        const ev = feedEntryToEvent(fe);
        if (!ev.title) continue;
        if (plan.fromYmd && (!ev.date || ev.date < plan.fromYmd || ev.date > plan.toYmd)) continue;
        if (cleanCurrencies.size > 0 && ev.currency && !cleanCurrencies.has(ev.currency)) continue;
        if (!ev.impact || !cleanImpacts.has(ev.impact)) continue;

        const dedupeKey = `${ev.date}|${ev.time}|${ev.currency}|${ev.title}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const row = buildRow(ev);
        row.displayTimezone = ev.displayTimezone || 'America/New_York';
        await flushRow(row);
        pushed += 1;
    }
    log.info(`Feed path pushed ${pushed} events (feeds: ${plan.feeds.join(', ')}).`);
    return true;
}

// ---------- Browser fallback path ----------

async function runPlaywright() {
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const calendarUrl = buildCalendarUrl({ range, startDate, endDate });
log.info(`Calendar URL: ${calendarUrl}`);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(10, Number(concurrency) || 3)),
    headless: true,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 180,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: { maxUsageCount: 6, maxErrorScore: 1 },
    },
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    preNavigationHooks: [
        async ({ page, browserController }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 90000;
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
            // Force UTC timezone display and 24h time format.
            try {
                const ctx = browserController?.browserContext || page.context();
                await ctx.addCookies([
                    { name: 'fftimezoneoffset', value: '0', domain: '.forexfactory.com', path: '/' },
                    { name: 'fftimeformat', value: '1', domain: '.forexfactory.com', path: '/' },
                ]);
            } catch (e) {
                log.debug(`cookie set failed: ${e?.message}`);
            }
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'calendar') return handleCalendar(ctx);
        if (t === 'event_detail') return handleEventDetail(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests([{
    url: calendarUrl,
    userData: { type: 'calendar' },
    uniqueKey: `calendar:${calendarUrl}`,
}]);
await crawler.run();
}

// ---------- Handlers ----------

async function handleCalendar({ page, request, crawler: c }) {
    await dismissBanners(page);
    log.info(`Loading calendar page: ${request.url}`);

    try {
        await page.waitForSelector('table.calendar__table, .calendar__row', { timeout: 20000 });
    } catch {
        log.warning('Calendar table did not render; page may be gated.');
    }

    // The week table lazy-renders as you scroll, so a fixed scroll count raced
    // the parse and often captured only the first day (counts swung 9..76 run
    // to run). Scroll and poll until the row count stabilizes and more than one
    // day section is present, so the whole week is in the DOM before parsing.
    await waitForFullCalendar(page);

    const events = await extractCalendarEvents(page);
    log.info(`Parsed ${events.length} candidate events.`);

    // ForexFactory renders times in its display zone. Extract the GMT offset from
    // the settings panel so downstream pipelines can convert to UTC.
    const displayTimezone = await page.evaluate(() => {
        const body = document.body?.textContent || '';
        // FF settings panel renders e.g. "(GMT -04:00) Eastern Time".
        const m = body.match(/\(GMT\s*([+-])\s*(\d{1,2}):(\d{2})\)\s*([A-Za-z][A-Za-z /\-]{1,40})?/);
        if (m) {
            const sign = m[1];
            const hh = m[2].padStart(2, '0');
            const mm = m[3];
            const label = (m[4] || '').trim();
            return `GMT${sign}${hh}:${mm}${label ? ` (${label})` : ''}`;
        }
        return 'ForexFactory display zone';
    }).catch(() => 'ForexFactory display zone');
    log.info(`Display timezone: ${displayTimezone}`);

    const pendingDetailFetches = [];

    for (const ev of events) {
        if (totalRowsPushed >= maxEvents) break;

        if (cleanCurrencies.size > 0 && ev.currency && !cleanCurrencies.has(ev.currency)) continue;
        if (!ev.impact || !cleanImpacts.has(ev.impact)) continue;
        if (!ev.title) continue;

        const row = buildRow(ev);
        row.displayTimezone = displayTimezone || 'America/New_York';

        if (includeDetail && ev.detailUrl) {
            pendingDetailFetches.push({ row, detailUrl: ev.detailUrl });
        } else {
            await flushRow(row);
        }
    }

    for (const { row, detailUrl } of pendingDetailFetches) {
        await c.addRequests([{
            url: detailUrl,
            userData: { type: 'event_detail', row },
            uniqueKey: `event_detail:${row.eventId}`,
        }]);
    }
}

async function handleEventDetail({ page, request }) {
    await dismissBanners(page);
    const { row } = request.userData;

    try {
        await page.waitForSelector('.calendarspecs, .calendarspecs__cell, h1, .calendar__details', { timeout: 12000 });
    } catch {}

    const detail = await extractEventDetail(page);
    Object.assign(row, detail);
    await flushRow(row);
}

// ---------- Extraction ----------

async function dismissBanners(page) {
    try {
        await page.evaluate(() => {
            const sel = [
                '#onetrust-accept-btn-handler',
                'button[aria-label*="accept" i]',
                'button[aria-label*="agree" i]',
                '[class*="cookie"] button',
                '#hg-cookie-consent button',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el) { el.click(); break; }
            }
        });
        await page.waitForTimeout(400);
    } catch {}
}

async function autoScroll(page, rounds = 2) {
    for (let i = 0; i < rounds; i += 1) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await page.waitForTimeout(700);
    }
}

// Scroll to the bottom repeatedly, polling the calendar row count until it stops
// growing across two consecutive checks (and at least two day sections exist),
// or a hard cap is hit. This makes the whole week render before we parse it.
async function waitForFullCalendar(page, { maxRounds = 22, settleRounds = 3, minRounds = 6 } = {}) {
    const count = () => page.evaluate(() => document.querySelectorAll('tr.calendar__row, .calendar__row').length).catch(() => 0);

    let prev = -1;
    let stable = 0;
    for (let i = 0; i < maxRounds; i += 1) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(900);
        const rows = await count();
        if (rows === prev) stable += 1;
        else stable = 0;
        // Only allow an early exit after a minimum number of rounds, so a brief
        // mid-load plateau (e.g. the first day rendered before the rest) does
        // not end the wait prematurely.
        if (i + 1 >= minRounds && stable >= settleRounds) break;
        prev = rows;
    }
    // Scroll back to top so any top-anchored rows are in view for extraction.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(400);
}

async function extractCalendarEvents(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const out = [];
        let currentDate = null;
        let currentDateStr = null;

        const rows = [...document.querySelectorAll('tr.calendar__row, .calendar__row')];
        let lastTime = null;

        for (const tr of rows) {
            const cls = tr.className || '';

            if (cls.includes('day-breaker') || cls.includes('calendar__row--day-breaker')) {
                const dateText = text(tr);
                const parsed = parseDateBreaker(dateText);
                if (parsed) {
                    currentDate = parsed;
                    currentDateStr = isoDate(parsed);
                    lastTime = null;
                }
                continue;
            }

            // Skip filter rows etc.
            if (!tr.querySelector('.calendar__currency, .calendar__event, .calendar__impact')) continue;

            const timeRaw = text(tr.querySelector('.calendar__time'));
            const currency = text(tr.querySelector('.calendar__currency'));

            let impact = null;
            const impactCell = tr.querySelector('.calendar__impact');
            if (impactCell) {
                const titleEl = impactCell.querySelector('[title]');
                if (titleEl) {
                    const t = (titleEl.getAttribute('title') || '').toLowerCase();
                    if (t.includes('high')) impact = 'high';
                    else if (t.includes('medium')) impact = 'medium';
                    else if (t.includes('low')) impact = 'low';
                    else if (t.includes('holiday') || t.includes('non-economic')) impact = 'holiday';
                }
                if (!impact) {
                    const html = (impactCell.innerHTML || '').toLowerCase();
                    if (/impact-red|ff-impact-red/.test(html)) impact = 'high';
                    else if (/impact-ora|ff-impact-ora/.test(html)) impact = 'medium';
                    else if (/impact-yel|ff-impact-yel/.test(html)) impact = 'low';
                    else if (/impact-gra|ff-impact-gra/.test(html)) impact = 'holiday';
                }
            }

            const titleEl = tr.querySelector('.calendar__event-title, .calendar__event');
            const title = text(titleEl);

            const actualText = text(tr.querySelector('.calendar__actual'));
            const forecastText = text(tr.querySelector('.calendar__forecast'));
            const previousEl = tr.querySelector('.calendar__previous');
            const previousText = text(previousEl);

            // Revised: ForexFactory shows revised value via tooltip (.calendar__previous span[title]) or as <span class="revised">.
            let revisedText = null;
            const revisedEl = tr.querySelector('.calendar__previous .revised, .revised, .calendar__previous span[title]');
            if (revisedEl) {
                revisedText = text(revisedEl) || revisedEl.getAttribute('title') || null;
                // Some templates put the original in title and revised in text.
                if (revisedText && /revised/i.test(revisedEl.getAttribute('title') || '')) {
                    revisedText = revisedText.replace(/^.*revised:?\s*/i, '');
                }
            }

            const detailLink = tr.querySelector('.calendar__detail a, .calendar__event-link, a.calendar__detail-toggler');
            let detailUrl = null;
            if (detailLink) {
                const href = detailLink.getAttribute('href');
                if (href) detailUrl = href.startsWith('http') ? href : `https://www.forexfactory.com${href}`;
            }
            const eventIdAttr = tr.getAttribute('data-event-id') || tr.getAttribute('data-eventid') || null;

            // Some rows continue the time from the previous row (blank time cell).
            let time = (timeRaw || '').replace(/\s+/g, '');
            if (!time && lastTime) time = lastTime;
            if (time) lastTime = time;

            const isAllDay = /all day|tentative/i.test(time);
            const timestamp = currentDateStr && time && !isAllDay ? buildIsoTimestamp(currentDateStr, time) : null;

            out.push({
                eventIdRaw: eventIdAttr,
                date: currentDateStr,
                time: isAllDay ? null : (time || null),
                isAllDay,
                timestamp,
                currency: currency ? currency.toUpperCase() : null,
                impact,
                title: title || null,
                actual: actualText || null,
                forecast: forecastText || null,
                previous: previousText || null,
                revised: revisedText || null,
                detailUrl,
            });
        }

        return out;

        function parseDateBreaker(s) {
            if (!s) return null;
            // Examples: "Mon May 10", "Monday, May 10", "May 10"
            const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
            const m = s.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})/);
            if (!m) return null;
            const month = monthMap[m[1]];
            const day = parseInt(m[2], 10);
            // Year is implicit. Use current calendar year, advance Dec-Jan boundary if needed.
            const now = new Date();
            let year = now.getUTCFullYear();
            if (month < now.getUTCMonth() - 6) year += 1; // forward
            if (month > now.getUTCMonth() + 6) year -= 1; // backward
            return new Date(Date.UTC(year, month, day));
        }
        function isoDate(d) {
            return d.toISOString().slice(0, 10);
        }
        function buildIsoTimestamp(dateStr, timeStr) {
            // timeStr formats: "12:30", "12:30am", "8:30pm", "08:30"
            let s = timeStr.toLowerCase().replace(/\s+/g, '');
            let ampm = null;
            if (s.endsWith('am')) { ampm = 'am'; s = s.slice(0, -2); }
            else if (s.endsWith('pm')) { ampm = 'pm'; s = s.slice(0, -2); }
            const m = s.match(/^(\d{1,2}):?(\d{2})$/);
            if (!m) return null;
            let hours = parseInt(m[1], 10);
            const mins = parseInt(m[2], 10);
            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;
            if (hours > 23 || mins > 59) return null;
            const hh = String(hours).padStart(2, '0');
            const mm = String(mins).padStart(2, '0');
            // Naive datetime in ForexFactory's display timezone (carried per-row as displayTimezone).
            return `${dateStr}T${hh}:${mm}:00`;
        }
    });
}

async function extractEventDetail(page) {
    return page.evaluate(() => {
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const grab = (label) => {
            const labels = [...document.querySelectorAll('.calendarspecs__name, .calendarspecs__label, .calendar__details-label, dt, th')];
            for (const l of labels) {
                if (text(l).toLowerCase().startsWith(label.toLowerCase())) {
                    const val = l.nextElementSibling || l.parentElement?.querySelector('.calendarspecs__value, .calendar__details-value, dd, td');
                    if (val) return text(val);
                }
            }
            return null;
        };

        const description = (() => {
            const sel = document.querySelector('.calendarspecs__description, .calendar__details-description, .description');
            if (sel) return text(sel).slice(0, 1200);
            const meta = document.querySelector('meta[name="description"]');
            return meta?.getAttribute('content')?.slice(0, 1200) || null;
        })();

        return {
            source: grab('Source') || grab('Released by'),
            frequency: grab('Frequency') || grab('Released'),
            description,
        };
    });
}

// ---------- Routing helpers ----------

function buildRow(ev) {
    const slug = (ev.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const eventId = ev.eventIdRaw
        ? `ff-${ev.eventIdRaw}`
        : `${ev.date || 'na'}-${ev.currency || 'NA'}-${slug || 'event'}`;

    const actualParsed = parseValue(ev.actual);
    const forecastParsed = parseValue(ev.forecast);
    const previousParsed = parseValue(ev.previous);
    const revisedParsed = parseValue(ev.revised);

    return {
        eventId,
        url: ev.detailUrl || `${BASE}/calendar`,
        date: ev.date || null,
        time: ev.time || null,
        timestamp: ev.timestamp || null,
        currency: ev.currency || null,
        impact: ev.impact || null,
        title: ev.title || null,
        actual: ev.actual || null,
        actualNumeric: actualParsed.numeric,
        forecast: ev.forecast || null,
        forecastNumeric: forecastParsed.numeric,
        previous: ev.previous || null,
        previousNumeric: previousParsed.numeric,
        revised: ev.revised || null,
        revisedNumeric: revisedParsed.numeric,
        unit: actualParsed.unit || forecastParsed.unit || previousParsed.unit || null,
        isAllDay: !!ev.isAllDay,
        // Detail fields populated by detail handler when includeDetail is on.
        source: null,
        frequency: null,
        description: null,
        scrapedAt: null,
    };
}

function parseValue(s) {
    if (!s) return { numeric: null, unit: null };
    const raw = String(s).trim();
    const m = raw.match(/(-?[\d,]+(?:\.\d+)?)\s*([%KMBkmb]|bps|trillion|billion|million|thousand)?/);
    if (!m) return { numeric: null, unit: null };
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return { numeric: null, unit: null };
    const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'thousand') { n *= 1e3; }
    else if (u === 'm' || u === 'million') { n *= 1e6; }
    else if (u === 'b' || u === 'billion') { n *= 1e9; }
    else if (u === 'trillion') { n *= 1e12; }
    return { numeric: n, unit: m[2] || null };
}

// Persist and bill one row. pushData and charge MUST be awaited: the feed path
// emits all rows in a tight synchronous loop and then calls Actor.exit(), so an
// un-awaited write would never flush before the process exits (the dataset would
// come back empty and the charge would be dropped).
async function flushRow(row) {
    row.scrapedAt = new Date().toISOString();
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'event_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

// ---------- URL helpers ----------

function buildCalendarUrl({ range, startDate, endDate }) {
    const r = String(range || 'this_week').toLowerCase();
    const today = new Date();

    if (r === 'today') return `${BASE}/calendar?day=${ffDate(today)}`;
    if (r === 'tomorrow') {
        const d = addDays(today, 1);
        return `${BASE}/calendar?day=${ffDate(d)}`;
    }
    if (r === 'yesterday') {
        const d = addDays(today, -1);
        return `${BASE}/calendar?day=${ffDate(d)}`;
    }
    if (r === 'this_week') {
        const start = startOfWeek(today);
        return `${BASE}/calendar?week=${ffDate(start)}`;
    }
    if (r === 'next_week') {
        const start = addDays(startOfWeek(today), 7);
        return `${BASE}/calendar?week=${ffDate(start)}`;
    }
    if (r === 'last_week') {
        const start = addDays(startOfWeek(today), -7);
        return `${BASE}/calendar?week=${ffDate(start)}`;
    }
    if (r === 'this_month') {
        return `${BASE}/calendar?month=${MONTH_ABBR[today.getUTCMonth()]}.${today.getUTCFullYear()}`;
    }
    if (r === 'next_month') {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
        return `${BASE}/calendar?month=${MONTH_ABBR[d.getUTCMonth()]}.${d.getUTCFullYear()}`;
    }
    if (r === 'custom') {
        const s = parseYmd(startDate);
        const e = parseYmd(endDate);
        if (!s || !e) {
            log.warning(`Custom range needs startDate and endDate (YYYY-MM-DD). Falling back to this_week.`);
            return buildCalendarUrl({ range: 'this_week' });
        }
        if ((e - s) > 30 * 86400000) {
            log.warning('Custom range exceeds 30 days; clamping endDate.');
            e.setTime(s.getTime() + 30 * 86400000);
        }
        return `${BASE}/calendar?range=${ffDate(s)}-${ffDate(e)}`;
    }
    return `${BASE}/calendar`;
}

function ffDate(d) {
    return `${MONTH_ABBR[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`;
}

function addDays(d, n) {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
}

function startOfWeek(d) {
    // ForexFactory weeks start on Sunday.
    const x = new Date(d.getTime());
    const day = x.getUTCDay();
    x.setUTCDate(x.getUTCDate() - day);
    return x;
}

function parseYmd(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
