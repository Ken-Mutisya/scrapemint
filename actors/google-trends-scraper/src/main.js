// Google Trends Scraper: interest over time, by region and related queries
// for any keyword, plus the daily Trending Now feed.
//
// Strategy
// --------
// The Trends web app reads a small JSON API: /trends/api/explore turns a
// keyword set into widget tokens, and /trends/api/widgetdata/{multiline,
// comparedgeo,relatedsearches} returns each chart. Every response starts with
// ")]}'," which is stripped. No key and no proxy: from Apify's own IPs, 48/50
// and 80/80 keyword sets succeeded in feasibility runs on 2026-10-02.
//
// The one thing it needs is the session cookie the explore page sets (the page
// itself answers 429 but still sets NID). Without it every API call is 429. On
// a 429 the session is refreshed and the call retried with backoff.
//
// Related topics are not offered: Google marks these sessions
// USER_TYPE_SCRAPER inside the signed widget request and returns an empty
// topics list for them; editing the flag gets 401 (checked 2026-10-02).
//
// Pay per event
// -------------
//   keyword_result  ($0.003) one keyword with every data type asked for
//   trending_search ($0.001) one Trending Now search with its news links
// No start fee. A keyword Google has no data for is returned free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = 'https://trends.google.com/trends';
const PROPERTY = { web: '', images: 'images', news: 'news', youtube: 'youtube', shopping: 'froogle' };
const TIME_RANGES = new Set(['now 1-H', 'now 4-H', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y', 'all']);

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    searchTerms = [],
    compareTerms = false,
    geo = '',
    timeRange = 'today 12-m',
    startDate = '',
    endDate = '',
    category = 0,
    searchType = 'web',
    interestOverTime = true,
    interestByRegion = true,
    regionResolution = '',
    relatedQueries = true,
    trendingNow = false,
    trendingGeos = ['US'],
    language = 'en-US',
} = input;

const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
const terms = [...new Set(listOf(searchTerms))];
const geoCode = String(geo || '').trim().toUpperCase();
const time = startDate && endDate ? `${startDate} ${endDate}` : (TIME_RANGES.has(timeRange) ? timeRange : 'today 12-m');
const property = PROPERTY[searchType] ?? '';
const tz = 0;

if (!terms.length && !trendingNow) {
    await Actor.pushData({ rowType: 'note', note: 'Add at least one search term, or turn on Trending Now. Not charged.' });
    await Actor.exit();
}
if (startDate && endDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate + '') ) log.warning('startDate/endDate should be YYYY-MM-DD.');

// ---------- Session and HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function refreshSession() {
    try {
        const r = await fetch(`${BASE}/explore?geo=${geoCode || 'US'}&q=trends&hl=${language}`, { headers: { 'User-Agent': UA, 'Accept-Language': language } });
        const set = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
        if (set.length) cookie = set.join('; ');
    } catch (err) {
        log.debug(`session refresh: ${err?.message}`);
    }
}

async function api(path, params) {
    const qs = new URLSearchParams({ hl: language, tz: String(tz), ...params }).toString();
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const r = await fetch(`${BASE}/api/${path}?${qs}`, { headers: { 'User-Agent': UA, Cookie: cookie, 'Accept-Language': language }, signal: AbortSignal.timeout(30_000) });
            if (r.ok) {
                const t = await r.text();
                return JSON.parse(t.slice(t.indexOf('{')));
            }
            last = new Error(`HTTP ${r.status}`);
            if (r.status === 429) await refreshSession();
            else if (r.status === 400) throw Object.assign(last, { fatal: true });
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(Math.min(30_000, 1500 * 2 ** attempt + Math.random() * 1000));
    }
    throw last;
}

// ---------- Explore and widgets ----------

const widgetData = (endpoint, w) => api(`widgetdata/${endpoint}`, { req: JSON.stringify(w.request), token: w.token });

const toIso = (unix) => new Date(Number(unix) * 1000).toISOString();

function summarize(points) {
    const vals = points.map((p) => p.value).filter((v) => typeof v === 'number');
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    let peak = points[0];
    for (const p of points) if (p.value > peak.value) peak = p;
    // Last quarter of the series against the quarter before it; a partial last
    // point (the current, unfinished period) is left out so it cannot read as a drop.
    const full = points.filter((p) => !p.isPartial);
    const q = Math.max(1, Math.floor(full.length / 4));
    const mean = (a) => (a.length ? a.reduce((s, p) => s + p.value, 0) / a.length : null);
    const recent = mean(full.slice(-q));
    const prior = mean(full.slice(-2 * q, -q));
    const change = prior ? Math.round(((recent - prior) / prior) * 1000) / 10 : null;
    return {
        average: Math.round(avg * 10) / 10,
        latest: full.length ? full[full.length - 1].value : vals[vals.length - 1],
        peak: peak.value,
        peakDate: peak.date,
        recentVsPriorPct: change,
        direction: change == null ? null : change > 10 ? 'rising' : change < -10 ? 'falling' : 'flat',
    };
}

// rankedList[0] is Top (0-100, relative), [1] is Rising (percent growth, or
// "Breakout" for more than +5000%).
function rankedLists(data) {
    const lists = data?.default?.rankedList || [];
    const map = (l) => (l?.rankedKeyword || []).map((k) => ({ query: k.query, value: k.value, formattedValue: k.formattedValue }));
    return { top: map(lists[0]), rising: map(lists[1]) };
}

async function exploreGroup(group) {
    const req = {
        comparisonItem: group.map((keyword) => ({ keyword, geo: geoCode, time })),
        category: Number(category) || 0,
        property,
    };
    const ex = await api('explore', { req: JSON.stringify(req) });
    const widgets = ex.widgets || [];
    const byId = (id) => widgets.find((w) => w.id === id);
    const rows = group.map((term) => ({
        searchTerm: term,
        geo: geoCode || 'worldwide',
        timeRange: time,
        category: Number(category) || 0,
        searchType,
        comparedWith: group.length > 1 ? group.filter((t) => t !== term) : null,
    }));

    if (interestOverTime && byId('TIMESERIES')) {
        const d = await widgetData('multiline', byId('TIMESERIES'));
        const tl = d.default?.timelineData || [];
        group.forEach((_, i) => {
            const points = tl.map((p) => ({ date: toIso(p.time), value: p.hasData?.[i] === false ? null : p.value?.[i] ?? null, ...(p.isPartial ? { isPartial: true } : {}) }));
            rows[i].interestOverTime = points;
            rows[i].summary = summarize(points.filter((p) => p.value != null));
        });
    }

    if (interestByRegion) {
        // Comparisons have one GEO_MAP for the set plus GEO_MAP_<i> per term;
        // a single term has GEO_MAP only.
        for (let i = 0; i < group.length; i++) {
            const w = byId(group.length > 1 ? `GEO_MAP_${i}` : 'GEO_MAP') || (group.length > 1 ? null : byId('GEO_MAP'));
            if (!w) continue;
            if (regionResolution) w.request.resolution = regionResolution;
            const d = await widgetData('comparedgeo', w);
            rows[i].interestByRegion = (d.default?.geoMapData || []).filter((g) => g.hasData?.[0] !== false)
                .map((g) => ({ geoCode: g.geoCode || null, geoName: g.geoName, value: g.value?.[0] ?? null }));
        }
    }

    for (let i = 0; i < group.length; i++) {
        const sfx = group.length > 1 ? `_${i}` : '';
        if (relatedQueries && byId(`RELATED_QUERIES${sfx}`)) {
            const r = rankedLists(await widgetData('relatedsearches', byId(`RELATED_QUERIES${sfx}`)));
            rows[i].relatedQueriesTop = r.top;
            rows[i].relatedQueriesRising = r.rising;
        }
        const q = new URLSearchParams({ q: group.join(','), date: time, ...(geoCode ? { geo: geoCode } : {}), ...(property ? { gprop: property } : {}), ...(category ? { cat: String(category) } : {}) });
        rows[i].trendsUrl = `${BASE}/explore?${q.toString().replace(/%2C/g, ',')}`;
    }
    return rows;
}

// ---------- Trending Now ----------

const tag = (x, t) => x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;
const unxml = (s) => (s == null ? null : String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

async function trending(g) {
    const r = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(g)}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
        const traffic = unxml(tag(it, 'ht:approx_traffic'));
        const n = traffic ? Number(traffic.replace(/[^\d]/g, '')) : null;
        return {
            rowType: 'trending',
            geo: g,
            title: unxml(tag(it, 'title')),
            approxTraffic: traffic,
            approxTrafficMin: Number.isFinite(n) ? n : null,
            startedAt: tag(it, 'pubDate') ? new Date(tag(it, 'pubDate')).toISOString() : null,
            picture: unxml(tag(it, 'ht:picture')),
            pictureSource: unxml(tag(it, 'ht:picture_source')),
            news: (it.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/g) || []).map((ni) => ({
                title: unxml(tag(ni, 'ht:news_item_title')),
                url: unxml(tag(ni, 'ht:news_item_url')),
                source: unxml(tag(ni, 'ht:news_item_source')),
            })),
            trendsUrl: `${BASE}/explore?q=${encodeURIComponent(unxml(tag(it, 'title')) || '')}&date=now%201-d&geo=${encodeURIComponent(g)}`,
        };
    });
}

// ---------- Run ----------

let keywordRows = 0;
let trendingRows = 0;
let freeRows = 0;
const failures = [];

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) {
        log.warning(`charge failed (continuing): ${err?.message}`);
    }
    return true;
}

let keepGoing = true;
if (terms.length) {
    await refreshSession();
    // Comparisons are relative to one another, so they go to Google together,
    // at most five at a time. Otherwise each term is scaled on its own.
    const groups = [];
    if (compareTerms) for (let i = 0; i < terms.length; i += 5) groups.push(terms.slice(i, i + 5));
    else for (const t of terms) groups.push([t]);
    if (compareTerms && terms.length > 5) log.warning(`Google compares at most 5 terms; split into ${groups.length} groups of up to 5, each scaled on its own.`);
    log.info(`Reading ${terms.length} term(s) in ${groups.length} request(s), ${geoCode || 'worldwide'}, ${time}.`);

    for (const group of groups) {
        if (!keepGoing) break;
        let rows;
        try {
            rows = await exploreGroup(group);
        } catch (err) {
            log.warning(`${group.join(', ')}: ${err?.message}`);
            failures.push({ terms: group, error: String(err?.message || err) });
            continue;
        }
        for (const row of rows) {
            // Google answers a too-rare keyword with an empty series, or with one
            // stray search scaled to 100 among nulls ("zqxv flarbnog 9931": 1 of
            // 181 days). Fewer than 3 data points and no regions or related
            // queries is no data, and the row is returned free.
            const points = (row.interestOverTime || []).filter((p) => p.value > 0).length;
            const hasData = points >= 3 || (row.interestByRegion || []).length > 0 || (row.relatedQueriesTop || []).length > 0;
            if (!hasData) row.note = 'Google Trends has no data for this term in this range and region. Not charged.';
            await Actor.pushData({ rowType: 'keyword', ...row, scrapedAt: new Date().toISOString() });
            if (hasData) { keywordRows += 1; if (!(await charge('keyword_result'))) { keepGoing = false; break; } } else freeRows += 1;
        }
        await sleep(300);
    }
}

if (trendingNow && keepGoing) {
    for (const g of listOf(trendingGeos).map((x) => x.toUpperCase())) {
        try {
            for (const row of await trending(g)) {
                await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
                trendingRows += 1;
                if (!(await charge('trending_search'))) { keepGoing = false; break; }
            }
        } catch (err) {
            log.warning(`Trending Now ${g}: ${err?.message}`);
            failures.push({ trendingGeo: g, error: String(err?.message || err) });
        }
        if (!keepGoing) break;
    }
}

await Actor.setValue('SUMMARY', { keywordRows, freeRows, trendingRows, failures });
log.info(`Done. ${keywordRows} keyword result(s), ${freeRows} with no data (free), ${trendingRows} trending search(es)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
