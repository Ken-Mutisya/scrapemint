// X (Twitter) Trends Scraper: the top 50 trends for 62 countries and
// worldwide, now or any hour of the last 24, with each trend's rank over the
// past 8 hours, plus the most-tweeted and longest-trending lists.
//
// Strategy
// --------
// getdaytrends.com archives X's trending lists every hour. Pages are
// server-rendered:
//   /<country>/          the current top 50 (worldwide is /)
//   /<country>/<h>/      the list h hours ago, h = 1..23
//   /<country>/top/tweeted/<day|week|month>/   ranked by tweet score
//   /<country>/top/longest/<day|week|month>/   ranked by hours trending
// Each top-50 row carries an SVG sparkline of its rank for the last 8 hours:
// <polyline points="x,y ..."> with x = 0..140 in steps of 20 (one per hour,
// oldest first) and y = rank, where 50 means "not in the top 50". A row can
// have two polylines when the trend dropped out and came back.
//
// X no longer publishes tweet volumes to anyone outside its API, so neither
// does this actor (sites that still show a "K Tweets" column show blanks).
// The tweeted list's "score" is getdaytrends' own volume index.
//
// No key, no proxy: getdaytrends answered Apify's IPs 3/3 in the 2026-10-09
// probe. trends24.in is behind Cloudflare from Apify, so it is not used.
//
// Pay per event
// -------------
//   trend ($0.0002) one row: a trend in a list
// No start fee. A location that fails is free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SITE = 'https://getdaytrends.com';

const COUNTRIES = {
    worldwide: 'Worldwide', algeria: 'Algeria', argentina: 'Argentina', australia: 'Australia', austria: 'Austria', bahrain: 'Bahrain',
    belarus: 'Belarus', belgium: 'Belgium', brazil: 'Brazil', canada: 'Canada', chile: 'Chile', colombia: 'Colombia', denmark: 'Denmark',
    'dominican-republic': 'Dominican Republic', ecuador: 'Ecuador', egypt: 'Egypt', france: 'France', germany: 'Germany', ghana: 'Ghana',
    greece: 'Greece', guatemala: 'Guatemala', india: 'India', indonesia: 'Indonesia', ireland: 'Ireland', israel: 'Israel', italy: 'Italy',
    japan: 'Japan', jordan: 'Jordan', kenya: 'Kenya', korea: 'Korea', kuwait: 'Kuwait', latvia: 'Latvia', lebanon: 'Lebanon',
    malaysia: 'Malaysia', mexico: 'Mexico', netherlands: 'Netherlands', 'new-zealand': 'New Zealand', nigeria: 'Nigeria', norway: 'Norway',
    oman: 'Oman', pakistan: 'Pakistan', panama: 'Panama', peru: 'Peru', philippines: 'Philippines', poland: 'Poland', portugal: 'Portugal',
    'puerto-rico': 'Puerto Rico', qatar: 'Qatar', russia: 'Russia', 'saudi-arabia': 'Saudi Arabia', singapore: 'Singapore',
    'south-africa': 'South Africa', spain: 'Spain', sweden: 'Sweden', switzerland: 'Switzerland', thailand: 'Thailand', turkey: 'Turkey',
    ukraine: 'Ukraine', 'united-arab-emirates': 'United Arab Emirates', 'united-kingdom': 'United Kingdom', 'united-states': 'United States',
    venezuela: 'Venezuela', vietnam: 'Vietnam',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    countries = ['united-states'],
    hoursAgo = [0],
    maxTrendsPerList = 50,
    includeTopLists = false,
    topListPeriod = 'day',
} = input;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

async function get(url) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30_000) });
            if (r.status === 404) return null;
            const body = await r.text();
            // The site answers transient overload with a 16-byte "error code: 520".
            if (r.ok && body.length > 1000) return body;
            last = new Error(`HTTP ${r.status}`);
        } catch (err) { last = err; }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

// "United States", "us", "united_states" -> "united-states"
function countrySlug(c) {
    const s = String(c || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (!s || s === 'world' || s === 'global' || s === 'all') return 'worldwide';
    const alias = { us: 'united-states', usa: 'united-states', uk: 'united-kingdom', gb: 'united-kingdom', uae: 'united-arab-emirates', 'south-korea': 'korea', kr: 'korea' };
    if (alias[s]) return alias[s];
    if (COUNTRIES[s]) return s;
    return Object.keys(COUNTRIES).find((k) => COUNTRIES[k].toLowerCase() === s.replace(/-/g, ' ')) || null;
}

const base = (slug) => (slug === 'worldwide' ? SITE : `${SITE}/${slug}`);

// One sparkline -> ranks for the last 8 hours, oldest first; null = outside the top 50.
function rankHistory(row) {
    const hist = new Array(8).fill(null);
    for (const m of row.matchAll(/<polyline points="([^"]+)"\s*\/>/g)) {
        const pts = m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
        for (const [x, y] of pts) {
            const i = Math.round(x / 20);
            // y = rank; the chart clips rank 1 to y = 0 at the top edge.
            if (i >= 0 && i < 8 && Number.isFinite(y) && y < 50) hist[i] = Math.max(1, Math.round(y));
        }
    }
    return hist;
}

function parseTop50(html) {
    const out = [];
    // The two left-hand tables (1-15, 16-50) are the ranking; the right-hand
    // "Most Tweeted" / "Longest Trending" boxes are parsed separately.
    const tables = [...html.matchAll(/<table class="[^"]*ranking trends wider[^"]*"[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);
    for (const t of tables) {
        for (const m of t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
            const row = m[1];
            const pos = row.match(/<th scope="row" class="pos">(\d+)<\/th>/);
            const a = row.match(/<td class="main"><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
            if (!pos || !a) continue;
            const history = rankHistory(row);
            history[7] = Number(pos[1]); // the chart's last point is this list's own rank
            out.push({ rank: Number(pos[1]), name: decode(a[2]).trim(), path: a[1], history });
        }
    }
    return out;
}

// Rows of a /top/ table: rank, trend, score or duration, record date.
function parseScoredRows(t) {
    const out = [];
    for (const m of t.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        const row = m[1];
        const pos = row.match(/<th scope="row" class="pos">(\d+)<\/th>/);
        const a = row.match(/<td class="main"><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!pos || !a) continue;
        const cells = [...row.matchAll(/<td class="details[^"]*">([\s\S]*?)<\/td>/g)].map((x) => decode(x[1].replace(/<[^>]+>/g, '')).trim());
        out.push({ rank: Number(pos[1]), name: decode(a[2]).trim(), path: a[1], value: cells[0] ?? null, recordDate: cells[1] ?? null });
    }
    return out;
}

function trendRow(t, slug) {
    return {
        trend: t.name,
        isHashtag: t.name.startsWith('#'),
        xSearchUrl: `https://x.com/search?q=${encodeURIComponent(t.name)}&src=trend_click`,
        sourceUrl: SITE + t.path,
        country: COUNTRIES[slug],
        countrySlug: slug,
    };
}

// ---------- Run ----------

let rows = 0;
let keepGoing = true;
const failures = [];
const perList = [];

async function charge() {
    try {
        const r = await Actor.charge({ eventName: 'trend' });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function push(row) {
    await Actor.pushData(row);
    rows += 1;
    if (!(await charge())) keepGoing = false;
}

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((x) => String(x).trim()).filter((x) => x !== '');
const slugs = [];
for (const c of list(countries).length ? list(countries) : ['united-states']) {
    if (/^all$/i.test(c)) { slugs.push(...Object.keys(COUNTRIES)); continue; }
    const s = countrySlug(c);
    if (s) slugs.push(s);
    else {
        failures.push({ country: c, error: 'Unknown country' });
        await Actor.pushData({ rowType: 'error', error: `Unknown country "${c}". Use one of: ${Object.values(COUNTRIES).join(', ')}. Not charged.` });
    }
}
const hours = [...new Set(list(hoursAgo).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))];
if (!hours.length) hours.push(0);
const cap = Math.max(1, Math.min(50, Number(maxTrendsPerList) || 50));
const period = ['day', 'week', 'month'].includes(topListPeriod) ? topListPeriod : 'day';
const scrapedAt = new Date().toISOString();

for (const slug of [...new Set(slugs)]) {
    if (!keepGoing) break;
    for (const h of hours) {
        if (!keepGoing) break;
        const url = h ? `${base(slug)}/${h}/` : `${base(slug)}/`;
        try {
            const html = await get(url);
            if (!html) throw new Error('Page not found');
            const trends = parseTop50(html).slice(0, cap);
            if (!trends.length) throw new Error('No trends on the page');
            for (const t of trends) {
                if (!keepGoing) break;
                const hist = t.history;
                await push({
                    rowType: 'trend',
                    list: 'top50',
                    rank: t.rank,
                    ...trendRow(t, slug),
                    hoursAgo: h,
                    snapshot: h ? `${h} hour${h > 1 ? 's' : ''} ago` : 'now',
                    rankHistory8h: hist,
                    hoursInTop50Last8h: hist.filter((x) => x != null).length,
                    bestRankLast8h: hist.some((x) => x != null) ? Math.min(...hist.filter((x) => x != null)) : null,
                    isNew: hist.slice(0, 7).every((x) => x == null),
                    scrapedAt,
                });
            }
            perList.push({ country: COUNTRIES[slug], hoursAgo: h, trends: trends.length });
            log.info(`${COUNTRIES[slug]} ${h ? `${h}h ago` : 'now'}: ${trends.length} trend(s).`);
        } catch (err) {
            log.warning(`${COUNTRIES[slug]} ${h}h ago: ${err?.message}`);
            failures.push({ country: COUNTRIES[slug], hoursAgo: h, error: String(err?.message || err) });
        }
        await sleep(400);
    }
    if (includeTopLists && keepGoing) {
        for (const kind of ['tweeted', 'longest']) {
            if (!keepGoing) break;
            const url = `${base(slug)}/top/${kind}/${period}/`;
            try {
                const html = await get(url);
                const table = (html?.match(/<table class="[^"]*ranking top[^"]*"[^>]*>[\s\S]*?<\/table>/g) || []).join('');
                const items = parseScoredRows(table).slice(0, cap);
                for (const t of items) {
                    if (!keepGoing) break;
                    const num = Number(String(t.value || '').replace(/[^\d.]/g, ''));
                    await push({
                        rowType: 'trend',
                        list: kind === 'tweeted' ? `mostTweeted_${period}` : `longestTrending_${period}`,
                        rank: t.rank,
                        ...trendRow(t, slug),
                        tweetScore: kind === 'tweeted' && Number.isFinite(num) ? num : null,
                        hoursTrending: kind === 'longest' && Number.isFinite(num) ? num : null,
                        recordDate: t.recordDate || null,
                        scrapedAt,
                    });
                }
                perList.push({ country: COUNTRIES[slug], list: `${kind}/${period}`, trends: items.length });
            } catch (err) {
                log.warning(`${COUNTRIES[slug]} top ${kind}: ${err?.message}`);
                failures.push({ country: COUNTRIES[slug], list: `${kind}/${period}`, error: String(err?.message || err) });
            }
            await sleep(400);
        }
    }
}

if (!rows) await Actor.pushData({ rowType: 'note', note: 'No trends returned. Not charged.' });
await Actor.setValue('SUMMARY', { trends: rows, lists: perList, failures });
log.info(`Done. ${rows} trend row(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
