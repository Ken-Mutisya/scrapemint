// Product Recall Finder: Unsafe Food, Drugs, Toys & More
//
// Strategy
// --------
// Two keyless US government API families, no browser, no proxy:
//   1. CPSC SaferProducts REST — consumer product recalls (toys, appliances,
//      furniture, electronics...). Keyword params search title/description;
//      when a keyword is given we query both and dedupe by RecallID.
//   2. openFDA enforcement — food, drug and medical device recalls. NOTE:
//      openFDA answers 404 for "no matches", treat that as zero rows.
// USDA FSIS (meat/poultry) sits behind Akamai and 403s datacenter requests,
// so it is deliberately NOT included.
//
// Rows are normalized across sources, merged, sorted newest first, then
// pushed up to maxRows.
//
// Pay per event
// -------------
//   recall_found per pushed row. First 2 rows per run are free.

import { Actor, log } from 'apify';

const CPSC = 'https://www.saferproducts.gov/RestWebServices/Recall';
const OPENFDA = 'https://api.fda.gov';
const FDA_ENDPOINTS = {
    food: '/food/enforcement.json',
    drugs: '/drug/enforcement.json',
    medical_devices: '/device/enforcement.json',
};
const SOURCE_LABELS = {
    consumer_products: 'CPSC consumer products',
    food: 'FDA food',
    drugs: 'FDA drugs',
    medical_devices: 'FDA medical devices',
};
const FDA_SEVERITY = {
    'Class I': 'serious risk',
    'Class II': 'moderate risk',
    'Class III': 'low risk',
};
const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FDA_PAGE = 1000;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keyword = '',
    sources = [],
    dateFrom = null,
    dateTo = null,
    maxRows = 200,
} = input;

const kw = String(keyword || '').trim();
const wanted = (Array.isArray(sources) && sources.length > 0 ? sources : Object.keys(SOURCE_LABELS))
    .filter((s) => SOURCE_LABELS[s]);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

const parseDay = (s, fallback) => {
    const t = Date.parse(String(s || '').trim());
    return Number.isFinite(t) ? new Date(t) : fallback;
};
const today = new Date();
const from = parseDay(dateFrom, new Date(Date.now() - 90 * 24 * 3600 * 1000));
const to = parseDay(dateTo, today);
const iso = (d) => d.toISOString().slice(0, 10);
const fdaDay = (d) => iso(d).replaceAll('-', '');

async function fetchJson(url, { okEmpty404 = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'user-agent': 'scrapemint-product-recall-finder/0.1 (+https://apify.com)', accept: 'application/json' },
        });
        if (res.status === 404 && okEmpty404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

const joinNames = (arr, key = 'Name') => (Array.isArray(arr) ? arr.map((x) => x?.[key]).filter(Boolean).join(' | ') : null) || null;

function cpscRow(r) {
    return {
        source: SOURCE_LABELS.consumer_products,
        recallDate: (r.RecallDate || '').slice(0, 10) || null,
        title: r.Title || null,
        products: (r.Products || []).map((p) => p?.Name).filter(Boolean),
        company: joinNames(r.Manufacturers) || joinNames(r.Importers) || joinNames(r.Distributors),
        problem: joinNames(r.Hazards),
        severity: null,
        fix: joinNames(r.Remedies),
        injuries: joinNames(r.Injuries),
        unitsAffected: r.Products?.[0]?.NumberOfUnits || null,
        soldAt: joinNames(r.Retailers) || r.SoldAtLabel || null,
        distribution: null,
        upcs: (r.ProductUPCs || []).map((u) => u?.UPC).filter(Boolean),
        status: null,
        recallNumber: r.RecallNumber || null,
        url: r.URL || null,
    };
}

function fdaRow(r, sourceKey) {
    const d = String(r.report_date || '');
    return {
        source: SOURCE_LABELS[sourceKey],
        recallDate: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
        title: (r.product_description || '').slice(0, 300) || null,
        products: r.product_description ? [r.product_description.slice(0, 300)] : [],
        company: r.recalling_firm || null,
        problem: r.reason_for_recall || null,
        severity: FDA_SEVERITY[r.classification] || null,
        fix: null,
        injuries: null,
        unitsAffected: r.product_quantity || null,
        soldAt: null,
        distribution: r.distribution_pattern || null,
        upcs: [],
        status: r.status || null,
        recallNumber: r.recall_number || null,
        url: null,
    };
}

async function fetchCpsc() {
    const base = `${CPSC}?format=json&RecallDateStart=${iso(from)}&RecallDateEnd=${iso(to)}`;
    const urls = kw
        ? [`${base}&RecallTitle=${encodeURIComponent(kw)}`, `${base}&RecallDescription=${encodeURIComponent(kw)}`]
        : [base];
    const seen = new Set();
    const rows = [];
    for (const url of urls) {
        if (pastDeadline()) break;
        try {
            const j = await fetchJson(url);
            for (const r of (Array.isArray(j) ? j : [])) {
                const id = r.RecallID ?? r.RecallNumber;
                if (seen.has(id)) continue;
                seen.add(id);
                rows.push(cpscRow(r));
            }
        } catch (err) {
            log.warning(`CPSC fetch failed: ${err?.message}`);
        }
    }
    return rows;
}

async function fetchFda(sourceKey) {
    const terms = [`report_date:[${fdaDay(from)}+TO+${fdaDay(to)}]`];
    if (kw) terms.push(`product_description:"${encodeURIComponent(kw)}"`);
    const rows = [];
    let skip = 0;
    while (rows.length < cap && skip <= 25000 - FDA_PAGE && !pastDeadline()) {
        const url = `${OPENFDA}${FDA_ENDPOINTS[sourceKey]}?search=${terms.join('+AND+')}&limit=${FDA_PAGE}&skip=${skip}`;
        let j;
        try {
            j = await fetchJson(url, { okEmpty404: true });
        } catch (err) {
            log.warning(`${SOURCE_LABELS[sourceKey]} fetch failed: ${err?.message}`);
            break;
        }
        if (!j) break; // 404 = no matches
        const results = j.results || [];
        for (const r of results) rows.push(fdaRow(r, sourceKey));
        if (results.length < FDA_PAGE) break;
        skip += FDA_PAGE;
    }
    return rows;
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'recall_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Searching ${wanted.length} source(s), ${iso(from)} to ${iso(to)}${kw ? `, keyword "${kw}"` : ''}...`);

const all = [];
for (const s of wanted) {
    if (pastDeadline()) { log.warning('Approaching timeout; skipping remaining sources.'); break; }
    const rows = s === 'consumer_products' ? await fetchCpsc() : await fetchFda(s);
    log.info(`${SOURCE_LABELS[s]}: ${rows.length} recall(s).`);
    all.push(...rows);
}

all.sort((a, b) => String(b.recallDate || '').localeCompare(String(a.recallDate || '')));

for (const row of all) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    await flushRow(row);
}

log.info(`Done. ${rowsPushed} recall(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable past the ${FREE_TIER_ROWS} free).`);
await Actor.exit();
