// Wikipedia Trends Scraper: Top Articles & Pageviews by Country
//
// Strategy
// --------
// Wikimedia's official pageviews REST API (keyless, documented, stable):
//   top mode:        the 1000 most-viewed articles per country (any ISO
//                    country) or per language project (en.wikipedia, ...)
//                    for a given day. With compareWithPrevious, ranks are
//                    kept in a named key-value store so scheduled runs
//                    report previousRank / rankChange / isNew.
//   timeseries mode: daily views for any list of articles over a date
//                    range, one row per article per day.
// Stats publish with ~1 day lag, so "latest" steps back up to 3 days
// until a day with data is found. No browser, no proxy, no API key.
//
// Pay per event
// -------------
//   page_row ($0.003) per pushed row in either mode.
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const MAX_CHARTS_PER_RUN = 30;
const FETCH_TIMEOUT_MS = 25000;
const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

// Skip non-article namespace noise in top charts (Main_Page, search pages,
// project/meta pages) unless the buyer wants raw charts.
const SPECIAL_RE = new RegExp('^(' + [
    // namespaces (several languages)
    'Special:', 'Wikipedia:', 'Portal:', 'File:', 'Help:', 'Category:', 'Template:', 'Talk:', 'User:', 'Draft:',
    'Wikipédia:', 'Спеціальна:', 'Служебная:', 'Especial:', 'Spezial:', 'Spécial:', 'Speciale:', '特別:', '특수:', 'خاص:',
    'Wikidata:', 'Wikinews:', 'Wikiquote:', 'Wikisource:', 'Wiktionary:', 'Commons:', 'Meta:', 'Wikimedia:',
    // main pages across major language editions (per-country charts mix languages)
    'Main_Page$', 'メインページ$', 'Wikipedia:Hauptseite$', 'Wikipédia:Accueil_principal$', 'Pagina_principale$',
    'Wikipedia:Portada$', 'Заглавная_страница$', 'Головна_сторінка$', 'Hoofdpagina$', 'Strona_główna$',
    'Wikipédia:Página_principal$', 'Anasayfa$', 'صفحه_اصلی$', 'الصفحة_الرئيسية$', '위키백과:대문$', '首页$', 'Portada$',
].join('|') + ')', 'i');

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'top',
    countries = ['US', 'GB'],
    projects = [],
    articles = [],
    project = 'en.wikipedia',
    date = '',
    daysBack = 30,
    topN = 50,
    excludeSpecialPages = true,
    compareWithPrevious = true,
    maxRows = 500,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 500));
const depth = Math.max(1, Math.min(1000, Number(topN) || 50));

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'page_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                accept: 'application/json',
                'User-Agent': 'WikipediaTrendsScraper/1.0 (https://apify.com/scrapemint/wikipedia-trends-scraper; contact via Apify)',
            },
        });
        if (res.status === 404) return { notFound: true };
        if (!res.ok) { log.warning(`HTTP ${res.status}: ${url}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Fetch failed: ${err?.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

const pad = (n) => String(n).padStart(2, '0');
const ymdPath = (d) => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const ymdCompact = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const isoDay = (d) => d.toISOString().slice(0, 10);

const prettyTitle = (t) => String(t || '').replace(/_/g, ' ');
const articleUrl = (proj, title) => (proj && title)
    ? `https://${proj}.org/wiki/${encodeURIComponent(String(title))}` : null;

// ---------- top mode ----------

async function runTop() {
    const ccs = asList(countries).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    const projs = asList(projects).map((p) => p.toLowerCase());
    const charts = [
        ...ccs.map((c) => ({ scope: 'country', id: c })),
        ...projs.map((p) => ({ scope: 'project', id: p })),
    ].slice(0, MAX_CHARTS_PER_RUN);
    if (!charts.length) {
        log.error('top mode: provide at least one country code or wiki project (e.g. en.wikipedia).');
        return;
    }

    // Resolve the newest day that has published data (stats lag ~1 day).
    let baseDate;
    if (String(date).trim()) {
        baseDate = new Date(`${String(date).trim()}T00:00:00Z`);
        if (Number.isNaN(+baseDate)) { log.error(`Invalid date "${date}" (use YYYY-MM-DD).`); return; }
    } else {
        baseDate = new Date(Date.now() - 864e5);
    }

    const state = compareWithPrevious ? await Actor.openKeyValueStore('wikipedia-trends-state') : null;

    for (const chart of charts) {
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
        if (rowsPushed >= cap) break;

        // Try the requested day, then step back up to 3 days for the lag.
        let data = null;
        let usedDate = null;
        for (let back = 0; back < (String(date).trim() ? 1 : 4); back++) {
            const d = new Date(+baseDate - back * 864e5);
            const url = chart.scope === 'country'
                ? `${API}/top-per-country/${chart.id}/all-access/${ymdPath(d)}`
                : `${API}/top/${chart.id}/all-access/${ymdPath(d)}`;
            const res = await fetchJson(url);
            if (res && !res.notFound && res.items?.length) { data = res; usedDate = d; break; }
        }
        if (!data) { log.warning(`${chart.scope} ${chart.id}: no published data found.`); continue; }

        const rawArticles = data.items[0]?.articles || [];
        const key = `top-${chart.scope}-${chart.id}`;
        const prev = state ? (await state.getValue(key)) || {} : {};
        const hadHistory = Object.keys(prev).length > 0;
        const currentRanks = {};
        const dayIso = isoDay(usedDate);
        let kept = 0;

        for (const a of rawArticles) {
            const title = a.article;
            if (excludeSpecialPages && SPECIAL_RE.test(String(title))) continue;
            if (kept >= depth || rowsPushed >= cap) break;
            kept += 1;
            currentRanks[title] = a.rank ?? kept;
            const prevRank = prev[title] ?? null;
            const proj = a.project || (chart.scope === 'project' ? chart.id : null);
            await flushRow({
                mode: 'top',
                scope: chart.scope,
                country: chart.scope === 'country' ? chart.id : null,
                project: proj,
                date: dayIso,
                rank: a.rank ?? kept,
                article: prettyTitle(title),
                articleKey: title,
                articleUrl: articleUrl(proj, title),
                views: a.views_ceil ?? a.views ?? null,
                previousRank: prevRank,
                rankChange: prevRank != null && a.rank != null ? prevRank - a.rank : null,
                isNew: state ? prevRank == null && hadHistory : null,
                checkedAt: new Date().toISOString(),
            });
        }
        if (state) await state.setValue(key, currentRanks);
        log.info(`${key} (${dayIso}): ${kept} row(s).`);
    }
}

// ---------- timeseries mode ----------

async function runTimeseries() {
    const arts = asList(articles);
    if (!arts.length) {
        log.error('timeseries mode: provide at least one article title in "articles".');
        return;
    }
    const proj = String(project || 'en.wikipedia').toLowerCase();
    const days = Math.max(1, Math.min(365, Number(daysBack) || 30));
    const end = new Date(Date.now() - 864e5);
    const start = new Date(+end - (days - 1) * 864e5);

    for (const raw of arts) {
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
        if (rowsPushed >= cap) break;
        const title = raw.replace(/ /g, '_');
        const url = `${API}/per-article/${proj}/all-access/user/${encodeURIComponent(title)}/daily/${ymdCompact(start)}/${ymdCompact(end)}`;
        const res = await fetchJson(url);
        if (!res || res.notFound || !res.items?.length) {
            log.warning(`No pageview data for "${raw}" on ${proj} (check spelling/casing).`);
            continue;
        }
        for (const item of res.items) {
            if (rowsPushed >= cap) break;
            const ts = String(item.timestamp || '');
            await flushRow({
                mode: 'timeseries',
                project: proj,
                article: prettyTitle(title),
                articleKey: title,
                articleUrl: articleUrl(proj, title),
                date: ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null,
                views: item.views ?? null,
                checkedAt: new Date().toISOString(),
            });
        }
        log.info(`${raw}: ${res.items.length} day(s).`);
    }
}

if (mode === 'timeseries') await runTimeseries();
else await runTop();

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
