// Google Trends Scraper (Trending Searches)
//
// Strategy
// --------
// Google Trends publishes a keyless RSS feed of the current trending searches
// per country:
//   GET https://trends.google.com/trending/rss?geo=<US|GB|IN|DE|...>
// Each <item> is one trending search term with an approximate search volume,
// a publish time, a representative image, and the news articles driving the
// trend (namespaced ht: fields). No login, no API key, no browser. We fetch one
// feed per geo, parse the RSS with cheerio, dedupe by term+geo, and emit one row
// per trending search.
//
// Scope note: this is the real-time trending-searches feed, not arbitrary
// "interest over time for my keyword". That explore endpoint needs a widget
// token flow and is rate limited hard, so it is intentionally out of scope.
//
// Pay per event
// -------------
//   trend_row ($0.004) charged when a trending-search row is pushed.
//   First 15 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 15;
const HARD_CAP = 2000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    geos = ['US'],
    includeNews = true,
    maxNewsPerTrend = 5,
    maxPerGeo = 25,
    maxRows = 100,
    proxyConfiguration: proxyInput,
} = input;

const cleanGeos = (Array.isArray(geos) ? geos : [geos])
    .map((g) => String(g || '').trim().toUpperCase()).filter(Boolean);
if (cleanGeos.length === 0) {
    log.warning('Provide at least one country code in "geos", e.g. ["US", "GB"].');
    await Actor.exit();
}

const perGeo = Math.max(1, Math.min(500, Number(maxPerGeo) || 25));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));
const newsCap = Math.max(0, Math.min(50, Number(maxNewsPerTrend) || 5));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

function buildUrl(geo) {
    return `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
}

async function fetchFeed(url) {
    const res = await fetch(url, {
        headers: {
            Accept: 'application/rss+xml, application/xml, text/xml',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`google trends HTTP ${res.status}`);
    return res.text();
}

function trafficToNumber(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/[^0-9]/g, '');
    return digits ? Number(digits) : null;
}

const seen = new Set();
let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'trend_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Fetching Google Trends for ${cleanGeos.length} geo(s), up to ${cap} trending searches.`);

for (const geo of cleanGeos) {
    if (totalRowsPushed >= cap) break;
    let xml;
    try {
        xml = await fetchFeed(buildUrl(geo));
    } catch (err) {
        log.warning(`Geo "${geo}" failed: ${err?.message}`);
        continue;
    }
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = $('item').toArray();
    let pushedForGeo = 0;
    let rank = 0;
    for (const el of items) {
        if (totalRowsPushed >= cap || pushedForGeo >= perGeo) break;
        const item = $(el);
        rank += 1;

        const term = item.find('title').first().text().trim();
        if (!term) continue;
        const key = `${geo}::${term.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const approxTraffic = item.find('ht\\:approx_traffic').first().text().trim() || null;
        const pubDate = item.find('pubDate').first().text().trim() || null;

        let newsItems = null;
        if (includeNews && newsCap > 0) {
            newsItems = item.find('ht\\:news_item').toArray().slice(0, newsCap).map((n) => {
                const news = $(n);
                return {
                    title: news.find('ht\\:news_item_title').text().trim() || null,
                    url: news.find('ht\\:news_item_url').text().trim() || null,
                    source: news.find('ht\\:news_item_source').text().trim() || null,
                    picture: news.find('ht\\:news_item_picture').text().trim() || null,
                };
            });
        }

        await flushRow({
            term,
            rank,
            geo,
            approxTraffic,
            approxTrafficNum: trafficToNumber(approxTraffic),
            publishedAt: pubDate,
            publishedAtIso: pubDate ? new Date(pubDate).toISOString() : null,
            pictureUrl: item.find('ht\\:picture').first().text().trim() || null,
            pictureSource: item.find('ht\\:picture_source').first().text().trim() || null,
            newsItems,
            scrapedAt: new Date().toISOString(),
        });
        pushedForGeo += 1;
    }
    log.info(`Geo "${geo}": ${pushedForGeo} trending search(es).`);
}

log.info(`Done. Pushed ${totalRowsPushed} trend row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
