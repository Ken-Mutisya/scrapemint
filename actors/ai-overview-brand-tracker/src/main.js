// Google AI Overview Tracker: does Google's AI Overview mention your brand,
// cite your site, or favour a competitor? One row per keyword.
//
// Strategy
// --------
// google.com/search?q=<keyword> through Apify's GOOGLE_SERP proxy ($0.0025
// per request). The AI Overview text, its cited sources (site + URL), the
// brands it links and the organic top 10 are all in that one page; see
// parse.js. Google sometimes answers "Can't generate an AI overview right
// now"; that keyword is retried once. A keyword with no AI Overview is a
// valid result (status "none") and is still a checked keyword.
//
// Tracking
// --------
// With trackChanges on, each keyword's last result is kept in the named
// key-value store "ai-overview-tracker-history", and the next run reports
// brands and domains gained or lost and whether the overview appeared or
// disappeared.
//
// Cost control
// ------------
// At most two SERP requests per keyword (one retry), so a keyword costs
// $0.0025-0.005 against $0.008 charged. SERP spend is capped at 70% of
// charged revenue (proxy-guard). Keywords whose page could not be fetched
// are not charged.
//
// Pay per event
// -------------
//   keyword ($0.008) one keyword checked, with or without an AI Overview

import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseSerp, brandMentions, domainOf } from './parse.js';

const PRICE = 0.008;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = ['best crm for small business'],
    brands = [],
    domains = [],
    country = 'us',
    language = 'en',
    includeOrganic = true,
    retryUnavailable = true,
    trackChanges = true,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const kws = [...new Set(list(keywords))];
const brandList = list(brands);
const domainList = list(domains).map((d) => domainOf(/^https?:/.test(d) ? d : `https://${d}`)).filter(Boolean);

if (!kws.length) {
    await Actor.pushData({ note: 'Add at least one keyword, e.g. "best crm for small business". Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({ tiers: ['serp'], share: 0.7, floorUsd: 0.01, isBlocked: (r) => r.statusCode !== 200 || /\/sorry\/index|unusual traffic/i.test(r.body.slice(0, 5000)) });
const history = trackChanges ? await Actor.openKeyValueStore('ai-overview-tracker-history') : null;
const counts = { shown: 0, none: 0, unavailable: 0, failed: 0 };
let out = 0;
let stop = false;
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { keywords: out, ...counts, ...guard.report() }));

const matchesDomain = (d, target) => d && (d === target || d.endsWith(`.${target}`));
const diff = (now, before) => ({ gained: now.filter((x) => !before.includes(x)), lost: before.filter((x) => !now.includes(x)) });

async function fetchSerp(keyword) {
    const url = `http://www.google.com/search?${new URLSearchParams({ q: keyword, hl: language, gl: country })}`;
    let parsed = null;
    for (let attempt = 0; attempt < (retryUnavailable ? 2 : 1); attempt++) {
        const res = await guard.get(url, { timeoutMs: 60_000 });
        if (!res) return parsed;
        parsed = parseSerp(res.body);
        if (parsed.status !== 'unavailable') break;
        log.info(`"${keyword}": Google could not generate an AI Overview right now${attempt === 0 && retryUnavailable ? '; retrying once' : ''}.`);
    }
    return parsed;
}

for (const keyword of kws) {
    if (stop || deadline.pastSoft()) break;
    const p = await fetchSerp(keyword);
    if (!p) {
        counts.failed++;
        log.warning(`"${keyword}": no page (blocked or out of proxy budget). Not charged.`);
        if (!guard.canSpend('serp')) break;
        continue;
    }
    counts[p.status]++;
    const mentions = brandMentions(p.text, brandList);
    const citedDomains = [...new Set(p.citations.map((c) => c.domain).filter(Boolean))];
    const organic = p.organic.slice(0, 10);
    const yourDomains = domainList.map((d) => {
        const cite = p.citations.find((c) => matchesDomain(c.domain, d));
        const org = organic.find((o) => matchesDomain(o.domain, d));
        return { domain: d, citedInAiOverview: !!cite, citationPosition: cite?.position ?? null, organicPosition: org?.position ?? null };
    });
    for (const m of mentions) {
        const slug = m.brand.toLowerCase().replace(/[^a-z0-9]/g, '');
        m.citedInAiOverview = !!slug && citedDomains.some((d) => d.replace(/[^a-z0-9]/g, '').includes(slug));
    }
    const brandsMentioned = mentions.filter((m) => m.mentioned).sort((a, b) => a.rank - b.rank).map((m) => m.brand);
    const row = {
        keyword,
        aiOverview: p.status,
        hasAiOverview: p.status === 'shown',
        brandsMentioned,
        brands: mentions,
        yourDomains,
        aiOverviewText: p.text,
        linkedEntities: p.linkedEntities,
        citations: p.citations,
        citedDomains,
        organicResults: includeOrganic ? organic : undefined,
        country,
        language,
        checkedAt: new Date().toISOString(),
    };
    if (history) {
        const key = `k-${createHash('sha1').update(`${keyword.toLowerCase()}|${country}|${language}`).digest('hex').slice(0, 20)}`;
        const before = await history.getValue(key);
        if (before) {
            row.changes = {
                since: before.checkedAt,
                aiOverviewBefore: before.aiOverview,
                aiOverviewAppeared: before.aiOverview !== 'shown' && p.status === 'shown',
                aiOverviewDisappeared: before.aiOverview === 'shown' && p.status !== 'shown',
                brands: diff(brandsMentioned, before.brandsMentioned || []),
                citedDomains: diff(citedDomains, before.citedDomains || []),
            };
        } else row.changes = null;
        // Keep the last real answer when Google was only temporarily unable to produce one.
        if (p.status !== 'unavailable') await history.setValue(key, { aiOverview: p.status, brandsMentioned, citedDomains, checkedAt: row.checkedAt });
    }
    await Actor.pushData(row);
    out++;
    if (!(await chargeRows(guard, 'keyword', PRICE, 1))) stop = true;
    log.info(`"${keyword}": AI Overview ${p.status}${brandsMentioned.length ? `, mentions ${brandsMentioned.join(', ')}` : ''}, ${citedDomains.length} cited domains.`);
}

if (!out) await Actor.pushData({ note: 'No keyword could be checked. Not charged.' });
await Actor.setValue('SUMMARY', { keywords: out, ...counts, ...guard.report() });
log.info(`Done: ${out} keywords (${JSON.stringify(counts)}). ${JSON.stringify(guard.report())}`);
await Actor.exit();
