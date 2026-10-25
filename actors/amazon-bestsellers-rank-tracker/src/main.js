// Amazon Best Sellers Rank Tracker: Best Sellers and Hot New Releases top 100
// for any Amazon.com category or subcategory, with rank changes between runs.
//
// Movers & Shakers, Most Wished For and Gift Ideas are not offered: their
// lists load through a script after the page renders, so plain requests get
// no ranks (tested 2026-10-25 on department and subcategory pages), and a
// browser would break the cost model.
//
// Strategy
// --------
// Each list page holds 50 ranks (page 2 = 51-100); see parse.js. Ranks past
// the ~30 rendered cards have only the ASIN in the page, so with fillDetails
// on, their product pages are read for title, price, rating, reviews and
// image.
//
// Cost control
// ------------
// Amazon answers Apify's own IPs directly (tested 2026-10-25). List pages
// go direct, then datacenter, then US residential (~450 KB a page, ~$0.0036,
// against 50 rows x $0.0015), capped at 25% of charged revenue. Product
// pages are 2-3 MB, so they never use residential: if direct and datacenter
// are blocked, those rows keep just ASIN and rank. No proxy input is exposed.
//
// Pay per event
// -------------
//   product ($0.0015) one ranked product row

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { isAmazonBlock, parseListPage, parseProductPage } from './parse.js';

const PRICE = 0.0015;
const BASE = 'https://www.amazon.com';
const LISTS = { 'best-sellers': 'bestsellers', 'new-releases': 'new-releases' };

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories = ['kitchen'],
    categoryUrls = [],
    lists = ['best-sellers'],
    maxRank = 100,
    includeSubcategories = false,
    fillDetails = true,
    trackChanges = true,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x?.url ? x.url : String(x)).trim()).filter(Boolean);
const wanted = arr(lists).filter((l) => LISTS[l]);
const pages = Math.max(1, Math.min(2, Math.ceil((Number(maxRank) || 100) / 50)));
const rankCap = Math.max(1, Math.min(100, Number(maxRank) || 100));

const listGuard = new ProxyGuard({ tiers: ['direct', 'datacenter', 'residential'], country: 'US', share: 0.25, floorUsd: 0.01, isBlocked: isAmazonBlock });
const detailGuard = new ProxyGuard({ tiers: ['direct', 'datacenter'], isBlocked: isAmazonBlock });
const history = trackChanges ? await Actor.openKeyValueStore('amazon-bestsellers-history') : null;
const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
let out = 0;
let stop = false;
const summary = [];
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { products: out, lists: summary, list: listGuard.report(), details: detailGuard.report() }));

// Targets: (list, url-builder). Category slugs map onto every chosen list;
// full URLs are used as given.
const targets = [];
for (const c of arr(categories)) {
    const slug = c.replace(/^\/+|\/+$/g, '');
    for (const l of wanted.length ? wanted : ['best-sellers']) targets.push({ list: l, url: `${BASE}/gp/${LISTS[l]}/${slug}` });
}
for (const u of arr(categoryUrls).filter((x) => /amazon\.com\//.test(x))) {
    if (/movers-and-shakers|most-wished-for|most-gifted/.test(u)) { log.warning(`${u}: Movers & Shakers, Most Wished For and Gift Ideas are not supported (their lists load by script). Skipped.`); continue; }
    const list = /new-releases/.test(u) ? 'new-releases' : 'best-sellers';
    targets.push({ list, url: u.replace(/\/ref=.*$/, '').replace(/[?#].*$/, '') });
}
if (!targets.length) {
    await Actor.pushData({ note: 'Add a category (e.g. kitchen, electronics) or an Amazon Best Sellers URL. Not charged.' });
    await Actor.exit();
}

async function readList(t) {
    const items = [];
    let category = null;
    let subcategories = [];
    let listLinks = [];
    for (let p = 1; p <= pages && !deadline.pastSoft(); p++) {
        const res = await listGuard.get(p > 1 ? `${t.url}?pg=${p}` : t.url, { headers });
        if (!res) { log.warning(`${t.list} ${t.url}: no page ${p} (blocked or out of proxy budget).`); break; }
        const parsed = parseListPage(res.body);
        category ??= parsed.category;
        if (p === 1) { subcategories = parsed.subcategories; listLinks = parsed.listLinks; }
        for (const it of parsed.items) if (!items.some((x) => x.asin === it.asin)) items.push(it);
        if (parsed.items.length < 50) break;
    }
    return { category, items: items.filter((x) => !x.rank || x.rank <= rankCap).slice(0, rankCap), subcategories, listLinks };
}

const queue = [...targets];
const done = new Set();
while (queue.length && !stop && !deadline.pastSoft()) {
    const t = queue.shift();
    if (done.has(t.url)) continue;
    done.add(t.url);
    const { category, items, subcategories, listLinks } = await readList(t);
    if (includeSubcategories && t.depth !== 1) {
        for (const s of subcategories) {
            const u = s.url.replace(/\/(zgbs|bestsellers|new-releases|movers-and-shakers|most-wished-for|most-gifted)\//, `/${t.list === 'best-sellers' ? 'zgbs' : LISTS[t.list]}/`);
            queue.push({ list: t.list, url: u, depth: 1 });
        }
    }
    if (!items.length) {
        // A carousel page (e.g. department-level Movers & Shakers): read the lists it links to instead.
        const sub = t.depth === 1 ? [] : listLinks.filter((u) => u.includes(`/${t.list === 'best-sellers' ? 'zgbs' : LISTS[t.list]}/`) || (t.list === 'best-sellers' && u.includes('/bestsellers/'))).slice(0, 10);
        if (sub.length) {
            log.info(`${t.list} ${t.url}: a carousel page; reading ${sub.length} subcategory lists instead.`);
            for (const u of sub) queue.push({ list: t.list, url: u, depth: 1 });
            continue;
        }
        summary.push({ list: t.list, url: t.url, category, products: 0 });
        log.warning(`${t.list} ${t.url}: no ranked products found.`);
        continue;
    }

    if (fillDetails) {
        // Product pages are 2-3 MB and mostly network wait: four at a time.
        const todo = items.filter((x) => !x.title);
        let i = 0;
        const worker = async () => {
            while (i < todo.length && !deadline.pastSoft()) {
                const it = todo[i++];
                const res = await detailGuard.get(`${BASE}/dp/${it.asin}`, { headers });
                const d = res ? parseProductPage(res.body) : null;
                if (d) Object.assign(it, { ...d, image: it.image || d.image });
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
    }

    const histKey = `h-${createHash('sha1').update(t.url).digest('hex').slice(0, 20)}`;
    const before = history ? ((await history.getValue(histKey)) || null) : null;
    const now = {};
    const rows = items.map((it) => {
        now[it.asin] = it.rank;
        const prev = before?.ranks?.[it.asin];
        return {
            list: t.list,
            category,
            categoryUrl: t.url,
            rank: it.rank,
            asin: it.asin,
            title: it.title || null,
            price: it.price ?? null,
            priceText: it.priceText || null,
            rating: it.rating ?? null,
            reviews: it.reviews ?? null,
            image: it.image || null,
            url: `${BASE}/dp/${it.asin}`,
            bestSellersRank: it.bestSellersRank ?? null,
            bestSellersRankCategory: it.bestSellersRankCategory ?? null,
            previousRank: before ? (prev ?? null) : undefined,
            rankChange: before && prev && it.rank ? prev - it.rank : before ? null : undefined,
            isNewEntry: before ? prev == null : undefined,
            lastCheckedAt: before?.checkedAt,
            scrapedAt: new Date().toISOString(),
        };
    });
    const dropped = before ? Object.keys(before.ranks).filter((a) => !(a in now)) : [];
    if (history) await history.setValue(histKey, { ranks: now, checkedAt: new Date().toISOString() });
    await Actor.pushData(rows);
    out += rows.length;
    if (!(await chargeRows(listGuard, 'product', PRICE, rows.length))) stop = true;
    summary.push({ list: t.list, url: t.url, category, products: rows.length, withDetails: rows.filter((r) => r.title).length, droppedOut: dropped });
    log.info(`${t.list} / ${category || t.url}: ${rows.length} products${before ? `, ${rows.filter((r) => r.isNewEntry).length} new entries, ${dropped.length} dropped out` : ''}.`);
}

if (!out) await Actor.pushData({ note: 'No ranked products found. Not charged. Check the category slug or URL.' });
await Actor.setValue('SUMMARY', { products: out, lists: summary, list: listGuard.report(), details: detailGuard.report() });
log.info(`Done: ${out} products. lists ${JSON.stringify(listGuard.report())} details ${JSON.stringify(detailGuard.report())}`);
await Actor.exit();
