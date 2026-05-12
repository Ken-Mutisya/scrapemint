// LinkedIn Events Scraper (No Cookies)
//
// Strategy
// --------
// Public LinkedIn event pages at /events/{slug-or-id}/ are reachable to
// anonymous visitors and expose title, start/end time, location, virtual
// flag, organizer, description, image, and an external registration link
// through a mix of meta tags, JSON-LD blocks, and rendered DOM.
//
// Discovery uses three feeds:
//   1. eventUrls       direct URLs supplied by the user
//   2. keywords        search engine queries against site:linkedin.com/events/
//   3. organizerUrls   search engine queries scoped to that organizer's slug
//
// Each event is filtered by time window, format (virtual / in person), and
// optional location substring before being pushed.
//
// Pay-per-event:
//   event_row ($0.02) charged when an event row is pushed. First 3 events
//   per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const FREE_TIER_EVENTS = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    eventUrls = [],
    keywords = [],
    organizerUrls = [],
    maxEventsPerSource = 25,
    timeWindow = 'any',
    eventType = 'any',
    locationContains = '',
    searchDepth = 5,
    concurrency = 6,
    proxyConfiguration: proxyInput,
} = input;

const perSourceCap = Number(maxEventsPerSource) > 0 ? Number(maxEventsPerSource) : Infinity;
const maxSearchPages = Math.max(1, Math.min(15, Number(searchDepth) || 5));
const locationNeedle = String(locationContains || '').trim().toLowerCase();
const { windowStartMs, windowEndMs } = resolveTimeWindow(timeWindow);
const formatFilter = ['virtual', 'in_person'].includes(eventType) ? eventType : 'any';

const sources = [];
const seenSourceKey = new Set();

for (const raw of eventUrls) {
    const url = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = normalizeEventUrl(url);
    if (!cleaned) continue;
    const key = `url:${cleaned}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    sources.push({ kind: 'direct', label: cleaned, key, directUrl: cleaned });
}

for (const raw of keywords) {
    const v = typeof raw === 'string' ? raw : raw?.value || raw?.keyword || '';
    const cleaned = String(v).trim();
    if (!cleaned) continue;
    const key = `kw:${cleaned.toLowerCase()}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    sources.push({ kind: 'keyword', label: cleaned, key });
}

for (const raw of organizerUrls) {
    const v = typeof raw === 'string' ? raw : raw?.url || raw?.value || '';
    const cleaned = String(v).trim();
    if (!cleaned) continue;
    const slug = extractOrganizerSlug(cleaned);
    if (!slug) {
        log.warning(`Skipping organizer URL ${cleaned}: cannot parse company or person slug.`);
        continue;
    }
    const key = `org:${slug.kind}:${slug.value}`;
    if (seenSourceKey.has(key)) continue;
    seenSourceKey.add(key);
    sources.push({ kind: 'organizer', label: cleaned, key, organizer: slug });
}

if (sources.length === 0) {
    log.warning('No eventUrls, keywords, or organizerUrls provided. Example: keywords=["ai webinar", "fintech summit"].');
    await Actor.exit();
}

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const candidatesBySource = new Map();
sources.forEach((s) => candidatesBySource.set(s.key, []));
const sourceByKey = new Map(sources.map((s) => [s.key, s]));
const seenEventIds = new Set();

const initialRequests = [];
for (const source of sources) {
    if (source.kind === 'direct') {
        const id = extractEventId(source.directUrl) || source.directUrl;
        initialRequests.push({
            url: source.directUrl,
            userData: { type: 'event', sourceKey: source.key, eventId: id, fromDirect: true },
            uniqueKey: `event:${source.key}:${id}`,
        });
        continue;
    }
    initialRequests.push({
        url: buildSearchUrl(source, 0),
        userData: { type: 'search', sourceKey: source.key, page: 0 },
        uniqueKey: `search:${source.key}:0`,
    });
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(20, Number(concurrency) || 6)),
    headless: true,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    maxRequestRetries: 3,
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: { maxUsageCount: 8, maxErrorScore: 1 },
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
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 45000;
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
            });
        },
    ],
    async requestHandler(ctx) {
        const t = ctx.request.userData.type;
        if (t === 'search') return handleSearch(ctx);
        if (t === 'event') return handleEvent(ctx);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

let totalPushed = 0;
for (const source of sources) {
    const rows = candidatesBySource.get(source.key) || [];
    const sorted = rows.slice().sort((a, b) => {
        const aStart = a._sortKey.start || 0;
        const bStart = b._sortKey.start || 0;
        if (aStart === 0 && bStart === 0) return 0;
        if (aStart === 0) return 1;
        if (bStart === 0) return -1;
        return aStart - bStart;
    });

    const cap = perSourceCap === Infinity ? sorted.length : Math.min(perSourceCap, sorted.length);
    let rank = 0;
    for (const row of sorted.slice(0, cap)) {
        rank += 1;
        const { _sortKey, ...clean } = row;
        clean.rankInSource = rank;
        await Actor.pushData(clean);
        totalPushed += 1;
        if (totalPushed > FREE_TIER_EVENTS) {
            Actor.charge({ eventName: 'event_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
        }
    }
    log.info(`Source ${source.key}: ${rows.length} candidates -> ${Math.min(rank, cap)} pushed.`);
}

log.info(`Run complete. Sources: ${sources.length}. Events pushed: ${totalPushed}.`);
await Actor.exit();

// ---------- Handlers ----------

async function handleSearch({ page, request, crawler: c }) {
    const source = sourceByKey.get(request.userData.sourceKey);
    if (!source) return;

    const bucket = candidatesBySource.get(source.key);
    if (bucket && bucket.length >= perSourceCap * 3 && perSourceCap !== Infinity) {
        return;
    }

    const links = await page.evaluate(() => {
        const out = new Set();
        document.querySelectorAll('a').forEach((a) => {
            const href = a.href || '';
            if (/linkedin\.com\/events\//i.test(href)) out.add(href);
        });
        return [...out];
    });

    let queued = 0;
    for (const raw of links) {
        const cleaned = unwrapEventUrl(raw);
        const eventId = extractEventId(cleaned);
        if (!eventId) continue;
        const dedupeKey = `${source.key}:${eventId}`;
        if (seenEventIds.has(dedupeKey)) continue;
        seenEventIds.add(dedupeKey);
        queued += 1;

        await c.addRequests([{
            url: cleaned,
            userData: { type: 'event', sourceKey: source.key, eventId },
            uniqueKey: `event:${source.key}:${eventId}`,
        }]);
    }

    log.info(`Search page ${request.userData.page} for ${source.key}: ${links.length} raw links, ${queued} new events queued.`);

    const nextPage = (request.userData.page || 0) + 1;
    if (queued > 0 && nextPage < maxSearchPages) {
        await c.addRequests([{
            url: buildSearchUrl(source, nextPage),
            userData: { type: 'search', sourceKey: source.key, page: nextPage },
            uniqueKey: `search:${source.key}:${nextPage}`,
        }]);
    }
}

async function handleEvent({ page, request }) {
    const { sourceKey, eventId, fromDirect } = request.userData;
    const source = sourceByKey.get(sourceKey);
    if (!source) return;

    try {
        await page.waitForSelector(
            'h1, .event-name, meta[property="og:title"], script[type="application/ld+json"]',
            { timeout: 12000 },
        );
    } catch {}

    const data = await page.evaluate(() => {
        const sel = (s, root = document) => root.querySelector(s);
        const all = (s, root = document) => [...root.querySelectorAll(s)];
        const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

        const meta = (prop) => {
            const el = sel(`meta[property="${prop}"], meta[name="${prop}"]`);
            return el?.getAttribute('content') || null;
        };

        const ldBlocks = [];
        for (const s of all('script[type="application/ld+json"]')) {
            try {
                const parsed = JSON.parse(s.textContent || 'null');
                if (parsed) ldBlocks.push(parsed);
            } catch {}
        }

        const flatLd = [];
        const walk = (node) => {
            if (!node) return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (typeof node === 'object') {
                flatLd.push(node);
                if (node['@graph']) walk(node['@graph']);
            }
        };
        ldBlocks.forEach(walk);
        const event = flatLd.find((n) => {
            const type = n['@type'];
            if (!type) return false;
            return Array.isArray(type) ? type.some((t) => /event/i.test(t)) : /event/i.test(type);
        }) || null;

        const titleDom = text(sel('h1.event-name, h1[data-test-event-name], h1'));
        const descriptionDom = text(sel('.event-description, .description, [data-test-event-description], .core-section-container__content'));

        const organizerEl = sel('a[href*="/company/"], a[href*="/in/"], a[data-test-organizer-link]');
        const organizerName = text(organizerEl);
        const organizerHref = organizerEl?.href || null;

        const attendeeText = text(sel('[data-test-event-social-proof], .event-attendees, .attendee-count'));

        const imageDom = sel('img.event-image, img[data-test-event-image]')?.src || null;

        return {
            ldEvent: event,
            ldRaw: ldBlocks,
            title: meta('og:title') || titleDom,
            description: meta('og:description') || descriptionDom,
            image: meta('og:image') || imageDom,
            canonicalUrl: meta('og:url') || (sel('link[rel="canonical"]')?.getAttribute('href') || null),
            organizerNameDom: organizerName,
            organizerUrlDom: organizerHref,
            attendeeText,
            descriptionDom,
        };
    });

    const ld = data.ldEvent || {};
    const startDate = ld.startDate || null;
    const endDate = ld.endDate || null;
    const startMs = parseDateToMs(startDate);
    const endMs = parseDateToMs(endDate);

    let locationName = null;
    let locationAddress = null;
    let locationVirtual = false;
    let virtualUrl = null;
    const locRaw = ld.location;
    if (Array.isArray(locRaw) ? locRaw.length : locRaw) {
        const items = Array.isArray(locRaw) ? locRaw : [locRaw];
        for (const item of items) {
            if (!item) continue;
            const type = item['@type'];
            const isVirtual = (Array.isArray(type) ? type.some((t) => /virtuallocation/i.test(t)) : /virtuallocation/i.test(type || ''));
            if (isVirtual) {
                locationVirtual = true;
                virtualUrl = item.url || virtualUrl;
                continue;
            }
            locationName = locationName || item.name || null;
            const addr = item.address;
            if (addr) {
                if (typeof addr === 'string') locationAddress = locationAddress || addr;
                else {
                    const parts = [
                        addr.streetAddress, addr.addressLocality, addr.addressRegion,
                        addr.postalCode, addr.addressCountry,
                    ].filter(Boolean);
                    if (parts.length) locationAddress = locationAddress || parts.join(', ');
                }
            }
        }
    }
    if (!locationVirtual && (ld.eventAttendanceMode || '').toString().toLowerCase().includes('online')) {
        locationVirtual = true;
    }

    const inferredVirtual = locationVirtual
        || /online|virtual|webinar|livestream|zoom|teams/i.test(`${data.title || ''} ${data.description || ''}`);

    if (formatFilter === 'virtual' && !inferredVirtual) {
        log.info(`Skipping ${eventId}: not virtual.`);
        return;
    }
    if (formatFilter === 'in_person' && inferredVirtual && !locationName && !locationAddress) {
        log.info(`Skipping ${eventId}: not in person.`);
        return;
    }

    if ((windowStartMs || windowEndMs) && startMs) {
        if (windowStartMs && startMs < windowStartMs) {
            log.info(`Skipping ${eventId}: starts before window.`);
            return;
        }
        if (windowEndMs && startMs > windowEndMs) {
            log.info(`Skipping ${eventId}: starts after window.`);
            return;
        }
    }

    const locString = [locationName, locationAddress].filter(Boolean).join(' ').toLowerCase();
    if (locationNeedle && !locString.includes(locationNeedle)) {
        if (!(inferredVirtual && locationNeedle.match(/remote|virtual|online/))) {
            log.info(`Skipping ${eventId}: location does not match "${locationNeedle}".`);
            return;
        }
    }

    let organizer = null;
    const ldOrganizer = Array.isArray(ld.organizer) ? ld.organizer[0] : ld.organizer;
    if (ldOrganizer && typeof ldOrganizer === 'object') {
        organizer = {
            name: ldOrganizer.name || null,
            url: ldOrganizer.url || cleanLinkedInUrl(data.organizerUrlDom),
            kind: inferOrganizerKind(ldOrganizer.url || data.organizerUrlDom),
        };
    } else if (data.organizerNameDom || data.organizerUrlDom) {
        organizer = {
            name: data.organizerNameDom || null,
            url: cleanLinkedInUrl(data.organizerUrlDom),
            kind: inferOrganizerKind(data.organizerUrlDom),
        };
    }

    const attendeeCount = parseAttendeeCount(data.attendeeText);

    const canonical = data.canonicalUrl || request.url;
    const eventSlug = extractEventSlug(canonical);

    const row = {
        id: eventId,
        slug: eventSlug,
        url: stripQuery(canonical),
        title: data.title || ld.name || null,
        description: data.description || ld.description || data.descriptionDom || null,
        startDate: startMs ? new Date(startMs).toISOString() : (startDate || null),
        endDate: endMs ? new Date(endMs).toISOString() : (endDate || null),
        timezone: ld.startDate && /[+-]\d{2}:?\d{2}|Z$/.test(ld.startDate) ? extractTimezone(ld.startDate) : null,
        location: {
            virtual: inferredVirtual,
            name: locationName,
            address: locationAddress,
            virtualUrl,
        },
        organizer,
        attendeeCount,
        attendeeText: data.attendeeText || null,
        image: data.image || null,
        registrationUrl: ld.offers?.url || ld.url || virtualUrl || null,
        discoveredVia: {
            kind: source.kind,
            value: source.label,
        },
        fromDirectInput: !!fromDirect,
        scrapedAt: new Date().toISOString(),
        _sortKey: {
            start: startMs || 0,
        },
    };

    const bucket = candidatesBySource.get(source.key);
    if (bucket) bucket.push(row);
    log.info(`Collected event ${eventId} for ${source.key}: title="${row.title?.slice(0, 80) || ''}", start=${row.startDate}.`);
}

// ---------- URL & search helpers ----------

function buildSearchUrl(source, pageIndex) {
    let q;
    if (source.kind === 'keyword') {
        q = `site:linkedin.com/events/ "${source.label}"`;
    } else if (source.kind === 'organizer') {
        const o = source.organizer;
        q = `site:linkedin.com/events/ "linkedin.com/${o.kind}/${o.value}"`;
    } else {
        q = `site:linkedin.com/events/`;
    }
    const offset = pageIndex * 20;
    const params = new URLSearchParams({ q, source: 'web' });
    if (offset > 0) params.set('offset', String(offset));
    return `https://search.brave.com/search?${params.toString()}`;
}

function unwrapEventUrl(href) {
    if (!href) return href;
    let url = href;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (/bing\.com$/.test(host)) {
            const real = u.searchParams.get('u') || u.searchParams.get('r');
            if (real) {
                if (real.startsWith('a1')) {
                    try { url = Buffer.from(real.slice(2), 'base64').toString('utf8'); }
                    catch { url = real; }
                } else url = real;
            }
        } else if (/google\.com$/.test(host) && u.pathname.startsWith('/url')) {
            const real = u.searchParams.get('q') || u.searchParams.get('url');
            if (real) url = real;
        } else if (/duckduckgo\.com$/.test(host) && u.pathname === '/l/') {
            const real = u.searchParams.get('uddg');
            if (real) url = decodeURIComponent(real);
        }
    } catch {}

    try {
        const u = new URL(url);
        if (/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) {
            if (u.pathname.startsWith('/login') || u.pathname.startsWith('/signup') || u.pathname.startsWith('/uas/')) {
                const inner = u.searchParams.get('session_redirect') || u.searchParams.get('redirect');
                if (inner) url = decodeURIComponent(inner);
            }
        }
    } catch {}

    return normalizeEventUrl(url) || url;
}

function normalizeEventUrl(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return null;
        const m = u.pathname.match(/\/events\/([^/?#]+)/i);
        if (!m) return null;
        return `https://www.linkedin.com/events/${m[1]}/`;
    } catch {
        return null;
    }
}

function extractEventId(url) {
    if (!url) return null;
    const m1 = url.match(/\/events\/(?:[^/?#]*-)?(\d{15,25})(?:[/?#-]|$)/);
    if (m1) return m1[1];
    const m2 = url.match(/\/events\/(\d{15,25})/);
    if (m2) return m2[1];
    return null;
}

function extractEventSlug(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\/events\/([^/?#]+)/i);
        return m ? m[1] : null;
    } catch { return null; }
}

function extractOrganizerSlug(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        const path = u.pathname.replace(/\/+$/, '');
        let m = path.match(/^\/company\/([^/]+)/i);
        if (m) return { kind: 'company', value: m[1].toLowerCase() };
        m = path.match(/^\/in\/([^/]+)/i);
        if (m) return { kind: 'in', value: m[1].toLowerCase() };
        m = path.match(/^\/school\/([^/]+)/i);
        if (m) return { kind: 'school', value: m[1].toLowerCase() };
        m = path.match(/^\/showcase\/([^/]+)/i);
        if (m) return { kind: 'showcase', value: m[1].toLowerCase() };
    } catch {}
    return null;
}

function cleanLinkedInUrl(href) {
    if (!href) return null;
    try {
        const u = new URL(href);
        if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ''))) return href;
        return `${u.origin}${u.pathname.replace(/\/+$/, '')}/`;
    } catch { return href; }
}

function stripQuery(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch { return url; }
}

function inferOrganizerKind(href) {
    if (!href) return 'unknown';
    if (/\/in\//i.test(href)) return 'person';
    if (/\/company\//i.test(href)) return 'company';
    if (/\/school\//i.test(href)) return 'school';
    if (/\/showcase\//i.test(href)) return 'showcase';
    return 'unknown';
}

// ---------- Parsing helpers ----------

function parseAttendeeCount(text) {
    if (!text) return null;
    const m = text.replace(/,/g, '').toLowerCase().match(/([\d.]+)\s*([kmb])?\s*(?:going|attending|attendees|people)?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    else if (m[2] === 'b') n *= 1000000000;
    return Math.round(n);
}

function parseDateToMs(value) {
    if (!value) return null;
    if (typeof value === 'number') return value;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
}

function extractTimezone(iso) {
    const m = String(iso).match(/([+-]\d{2}:?\d{2}|Z)$/);
    return m ? m[1] : null;
}

function resolveTimeWindow(mode) {
    const now = Date.now();
    const day = 86400 * 1000;
    if (mode === 'upcoming') return { windowStartMs: now, windowEndMs: 0 };
    if (mode === 'past') return { windowStartMs: 0, windowEndMs: now };
    if (mode === 'next30days') return { windowStartMs: now, windowEndMs: now + 30 * day };
    if (mode === 'next90days') return { windowStartMs: now, windowEndMs: now + 90 * day };
    return { windowStartMs: 0, windowEndMs: 0 };
}
