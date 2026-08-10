// Hugging Face Scraper: Trending AI Models, Datasets & Spaces
//
// Strategy
// --------
// The Hugging Face Hub exposes a keyless JSON API for models, datasets, and
// Spaces:
//   GET https://huggingface.co/api/{models|datasets|spaces}?search=&author=&filter=&sort=&direction=-1&limit=100
// Sorting by trendingScore, downloads, or likes needs no auth. Pagination is
// cursor-based via the `Link: <...>; rel="next"` response header. For models we
// pass expand[] fields to keep payloads slim (no siblings list). No login, no
// API key, no browser.
//
// Pay per event
// -------------
//   item_row ($0.004) charged when a model/dataset/space row is pushed.
//   First 5 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 5;
const HARD_CAP = 5000;
const PAGE_SIZE = 100;
const RATE_SLEEP_MS = 200;

const VALID_TYPES = ['models', 'datasets', 'spaces'];
const VALID_SORTS = ['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified'];
const MODEL_EXPAND = [
    'downloads', 'likes', 'trendingScore', 'pipeline_tag', 'library_name',
    'tags', 'createdAt', 'lastModified', 'gated',
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    resourceTypes = ['models'],
    search,
    author,
    tags = [],
    sort = 'trendingScore',
    maxRowsPerType = 50,
    proxyConfiguration: proxyInput,
} = input;

const types = (Array.isArray(resourceTypes) ? resourceTypes : String(resourceTypes).split(','))
    .map((t) => String(t || '').trim().toLowerCase()).filter((t) => VALID_TYPES.includes(t));
if (!types.length) {
    log.warning(`Provide at least one of ${VALID_TYPES.join(', ')} in "resourceTypes".`);
    await Actor.exit();
}

const tagList = (Array.isArray(tags) ? tags : String(tags).split(','))
    .map((t) => String(t || '').trim()).filter(Boolean);
const sortKey = VALID_SORTS.includes(String(sort)) ? String(sort) : 'trendingScore';
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRowsPerType) || 50));

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

function buildUrl(type, limit) {
    const params = new URLSearchParams();
    if (search) params.set('search', String(search).trim());
    if (author) params.set('author', String(author).trim());
    for (const t of tagList) params.append('filter', t);
    // Spaces have no download counter; fall back to likes so the sort still works.
    params.set('sort', type === 'spaces' && sortKey === 'downloads' ? 'likes' : sortKey);
    params.set('direction', '-1');
    params.set('limit', String(limit));
    if (type === 'models') for (const f of MODEL_EXPAND) params.append('expand[]', f);
    return `https://huggingface.co/api/${type}?${params.toString()}`;
}

async function fetchPage(url) {
    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Scrapemint Hugging Face actor (admin@scrapemint.com)',
        },
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`huggingface HTTP ${res.status}`);
    const items = await res.json();
    // Cursor pagination: Link: <next-url>; rel="next"
    const link = res.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    return { items: Array.isArray(items) ? items : [], next: m ? m[1] : null };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// License and arXiv references arrive as tags like "license:mit", "arxiv:2606.23050".
function fromTags(itemTags, prefix) {
    return (itemTags || [])
        .filter((t) => typeof t === 'string' && t.startsWith(`${prefix}:`))
        .map((t) => t.slice(prefix.length + 1));
}

function itemUrl(type, id) {
    if (type === 'models') return `https://huggingface.co/${id}`;
    return `https://huggingface.co/${type}/${id}`;
}

function toRow(type, item) {
    const id = item.id || item.modelId || null;
    const itemAuthor = item.author || (typeof id === 'string' && id.includes('/') ? id.split('/')[0] : null);
    const name = typeof id === 'string' && id.includes('/') ? id.split('/').slice(1).join('/') : id;
    const licenses = fromTags(item.tags, 'license');
    const arxivIds = fromTags(item.tags, 'arxiv');
    return {
        type: type.replace(/s$/, ''),
        id,
        name,
        author: itemAuthor,
        url: itemUrl(type, id),
        trendingScore: item.trendingScore ?? null,
        downloads: item.downloads ?? null,
        likes: item.likes ?? null,
        pipelineTag: item.pipeline_tag ?? null,
        libraryName: item.library_name ?? null,
        sdk: item.sdk ?? null,
        license: licenses[0] || null,
        arxivIds: arxivIds.length ? arxivIds : null,
        gated: item.gated ?? null,
        tags: item.tags ?? null,
        createdAt: item.createdAt ?? null,
        lastModified: item.lastModified ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

const seen = new Set();
let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData(row);
    totalRowsPushed += 1;
    if (totalRowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'item_row' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Hugging Face: types=${types.join(',')} sort=${sortKey}${search ? ` search="${search}"` : ''}${author ? ` author=${author}` : ''}${tagList.length ? ` tags=${tagList.join(',')}` : ''}, up to ${cap} rows per type.`);

for (const type of types) {
    let typeRows = 0;
    let url = buildUrl(type, Math.min(PAGE_SIZE, cap));
    while (url && typeRows < cap) {
        let page;
        try {
            page = await fetchPage(url);
        } catch (err) {
            log.warning(`${type} page failed: ${err?.message}. Moving on.`);
            break;
        }
        if (page.items.length === 0) break;
        for (const item of page.items) {
            if (typeRows >= cap) break;
            const key = `${type}:${item.id || item._id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            await flushRow(toRow(type, item));
            typeRows += 1;
        }
        url = page.next;
        if (url) await sleep(RATE_SLEEP_MS);
    }
    log.info(`${type}: ${typeRows} row(s).`);
}

log.info(`Done. Pushed ${totalRowsPushed} row(s); ${Math.max(0, totalRowsPushed - FREE_TIER_ROWS)} chargeable.`);
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
