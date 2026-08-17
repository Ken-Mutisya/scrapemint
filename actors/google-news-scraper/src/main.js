// Google News Scraper (No Login)
//
// Strategy
// --------
// Google News publishes a keyless RSS feed for any search term:
//   GET https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en
// It returns up to ~100 <item> entries with title, link, pubDate, guid, and a
// <source url="..."> publisher. No login, no API key, no browser. We fetch one
// feed per query (optionally narrowed to a recency window), parse the RSS with
// cheerio, dedupe by guid/link, and emit one row per article.
//
// Pay per event
// -------------
//   article_row ($0.003) charged when an article row is pushed.
//   First 1 row per run is free so buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 1;
const HARD_CAP = 5000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    language = 'en-US',
    country = 'US',
    when,
    maxPerQuery = 100,
    maxArticles = 200,
    proxyConfiguration: proxyInput,
} = input;

const cleanQueries = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q || '').trim()).filter(Boolean);
if (cleanQueries.length === 0) {
    log.warning('Provide at least one search term in "queries", e.g. ["tesla", "openai"].');
    await Actor.exit();
}

const hl = String(language || 'en-US').trim() || 'en-US';
const gl = String(country || 'US').trim().toUpperCase() || 'US';
const ceid = `${gl}:${hl.split('-')[0]}`;
const perQuery = Math.max(1, Math.min(100, Number(maxPerQuery) || 100));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxArticles) || 200));
const whenClause = when ? ` when:${String(when).trim().replace(/[^0-9a-zA-Z]/g, '')}` : '';

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(sanitizeProxyInput(proxyInput));
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

function buildUrl(query) {
    const q = encodeURIComponent(`${query}${whenClause}`);
    return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

async function fetchFeed(url) {
    const res = await fetch(url, {
        headers: {
            Accept: 'application/rss+xml, application/xml, text/xml',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`google news HTTP ${res.status}`);
    return res.text();
}

const seen = new Set();
let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'article_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Fetching Google News for ${cleanQueries.length} query(ies), up to ${cap} articles (${hl}/${gl})${whenClause ? `, window${whenClause}` : ''}.`);

for (const query of cleanQueries) {
    if (totalRowsPushed >= cap) break;
    let xml;
    try {
        xml = await fetchFeed(buildUrl(query));
    } catch (err) {
        log.warning(`Query "${query}" failed: ${err?.message}`);
        continue;
    }
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = $('item').toArray();
    let pushedForQuery = 0;
    for (const el of items) {
        if (totalRowsPushed >= cap || pushedForQuery >= perQuery) break;
        const item = $(el);
        const guid = item.find('guid').text().trim();
        const link = item.find('link').text().trim();
        const key = guid || link;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);

        const rawTitle = item.find('title').text().trim();
        const sourceEl = item.find('source');
        const sourceName = sourceEl.text().trim() || null;
        // Google News titles are "Headline - Source"; strip the trailing source.
        let headline = rawTitle;
        if (sourceName && headline.endsWith(` - ${sourceName}`)) {
            headline = headline.slice(0, -(` - ${sourceName}`.length)).trim();
        }
        const pubDate = item.find('pubDate').text().trim() || null;

        await flushRow({
            title: headline || rawTitle || null,
            source: sourceName,
            sourceUrl: sourceEl.attr('url') || null,
            url: link || guid || null,
            publishedAt: pubDate,
            publishedAtIso: pubDate ? new Date(pubDate).toISOString() : null,
            guid: guid || null,
            query,
            language: hl,
            country: gl,
            scrapedAt: new Date().toISOString(),
        });
        pushedForQuery += 1;
    }
    log.info(`Query "${query}": ${pushedForQuery} article(s).`);
}

log.info(`Done. Pushed ${totalRowsPushed} article row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
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
