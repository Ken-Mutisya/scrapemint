// Property Deed Transfers: NYC, Philadelphia, Cook County
//
// Strategy
// --------
// Three large US recorders publish every recorded deed as open data, with the
// buyer, seller, price and property:
//   nyc           NYC ACRIS (Socrata): master (bnx9-e6tj) + parties (636b-3b5g)
//                 + legals (8h5j-fqxa), joined on document_id.
//   philadelphia  Philadelphia Records Dept real estate transfers (Carto SQL,
//                 table rtt_summary): grantors, grantees, consideration, address.
//   cook          Cook County Assessor parcel sales (wvhk-k5uv) joined with
//                 parcel addresses (3723-97qp) for property and owner mailing
//                 address. Covers Chicago and suburbs.
// Each county publishes with a lag (NYC ~2-3 weeks, Cook ~2 months,
// Philadelphia longer), so the date window is measured back from the newest
// record each county has published, not from today. No API key, no proxy.
//
// Pay per event
// -------------
//   deed ($0.004) per deed transfer row. The first FREE_TIER_ROWS rows of
//   every run are free. Notes are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 1;
const FETCH_TIMEOUT_MS = 60000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    counties = ['nyc', 'philadelphia', 'cook'],
    daysOfRecords = 30,
    minPrice = 1000,
    maxPrice = 0,
    includeNonSaleDeeds = false,
    buyerKeywords = [],
    excludeBuyerKeywords = [],
    zipCodes = [],
    maxRows = 500,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 500));
const days = Math.max(1, Math.min(365, Number(daysOfRecords) || 30));
const minP = Math.max(0, Number(minPrice) || 0);
const maxP = Math.max(0, Number(maxPrice) || 0);
const buyKw = arr(buyerKeywords).map((s) => s.toUpperCase());
const notKw = arr(excludeBuyerKeywords).map((s) => s.toUpperCase());
const zips = arr(zipCodes).map((s) => s.replace(/\D/g, '')).filter(Boolean);
const num = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
const day = (s) => (s ? String(s).slice(0, 10) : null);
const shift = (iso, d) => new Date(Date.parse(iso) - d * 86400000).toISOString().slice(0, 10);
const zip5 = (z) => (String(z || '').replace(/\D/g, '').slice(0, 5) || null);

async function getJson(url, opts = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
            if (res.ok) return await res.json();
            const body = (await res.text()).slice(0, 200);
            if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}: ${body}`);
            log.warning(`HTTP ${res.status}, retrying`);
        } catch (err) {
            if (attempt === 3 || /^HTTP 4/.test(err.message)) throw err;
            log.warning(`${err.message}, retrying`);
        } finally { clearTimeout(t); }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    return null;
}
const soda = (base, params) => getJson(`${base}?${new URLSearchParams(params)}`);

const keep = (row) => {
    if (minP > 0 && !(row.price >= minP)) return false;
    if (maxP > 0 && !(row.price <= maxP)) return false;
    const buyers = (row.buyers || []).join(' | ').toUpperCase();
    if (buyKw.length && !buyKw.some((k) => buyers.includes(k))) return false;
    if (notKw.some((k) => buyers.includes(k))) return false;
    if (zips.length && !zips.some((z) => (row.zip || '').startsWith(z))) return false;
    return true;
};

// ---------- NYC ACRIS ----------
const BOROUGH = { 1: 'Manhattan', 2: 'Bronx', 3: 'Brooklyn', 4: 'Queens', 5: 'Staten Island' };
async function* nyc() {
    const M = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json';
    const P = 'https://data.cityofnewyork.us/resource/636b-3b5g.json';
    const L = 'https://data.cityofnewyork.us/resource/8h5j-fqxa.json';
    const types = includeNonSaleDeeds ? ['DEED', 'DEEDO', 'DEED, TS', 'DEED, LE', 'DEED, RC', 'DEEDP'] : ['DEED', 'DEEDO'];
    const newest = (await soda(M, { $select: 'max(recorded_datetime) as mx', $where: `doc_type in (${types.map(q).join(',')})` }))?.[0]?.mx;
    if (!newest) return;
    const from = shift(newest, days);
    const where = [`doc_type in (${types.map(q).join(',')})`, `recorded_datetime >= ${q(`${from}T00:00:00`)}`];
    if (minP > 0) where.push(`document_amt >= ${minP}`);
    if (maxP > 0) where.push(`document_amt <= ${maxP}`);
    let offset = 0;
    while (!pastDeadline()) {
        const docs = await soda(M, { $where: where.join(' AND '), $order: 'recorded_datetime DESC, document_id', $limit: '200', $offset: String(offset) });
        if (!docs?.length) break;
        const ids = docs.map((d) => q(d.document_id)).join(',');
        const [parties, legals] = await Promise.all([
            soda(P, { $where: `document_id in (${ids})`, $limit: '5000' }),
            soda(L, { $where: `document_id in (${ids})`, $limit: '5000' }),
        ]);
        const pBy = new Map(); for (const p of parties || []) (pBy.get(p.document_id) || pBy.set(p.document_id, []).get(p.document_id)).push(p);
        const lBy = new Map(); for (const l of legals || []) (lBy.get(l.document_id) || lBy.set(l.document_id, []).get(l.document_id)).push(l);
        for (const d of docs) {
            const ps = pBy.get(d.document_id) || []; const ls = lBy.get(d.document_id) || [];
            const sellers = ps.filter((p) => p.party_type === '1'); const buyers = ps.filter((p) => p.party_type === '2');
            const lg = ls[0] || {};
            const b0 = buyers[0] || {};
            yield {
                county: 'nyc', countyLabel: `New York City (${BOROUGH[lg.borough || d.recorded_borough] || d.recorded_borough})`,
                documentId: d.document_id, documentType: d.doc_type, recordedDate: day(d.recorded_datetime), documentDate: day(d.document_date),
                price: num(d.document_amt), percentTransferred: num(d.percent_trans),
                address: [lg.street_number, lg.street_name].filter(Boolean).join(' ') || null, unit: lg.unit || null,
                city: BOROUGH[lg.borough || d.recorded_borough] || null, state: 'NY', zip: null,
                parcelId: lg.borough ? `${lg.borough}-${lg.block}-${lg.lot}` : null, propertyType: lg.property_type || null, parcelCount: ls.length || null,
                buyers: buyers.map((p) => p.name).filter(Boolean), sellers: sellers.map((p) => p.name).filter(Boolean),
                buyerMailingAddress: [b0.address_1, b0.address_2].filter(Boolean).join(', ') || null, buyerMailingCity: b0.city || null, buyerMailingState: b0.state || null, buyerMailingZip: zip5(b0.zip),
                sellerMailingAddress: sellers[0] ? [sellers[0].address_1, sellers[0].address_2].filter(Boolean).join(', ') || null : null,
                documentUrl: `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${d.document_id}`,
                dataThrough: day(newest),
            };
        }
        offset += docs.length;
        if (docs.length < 200) break;
    }
}

// ---------- Philadelphia ----------
async function* philadelphia() {
    const C = 'https://phl.carto.com/api/v2/sql';
    const types = includeNonSaleDeeds ? ["DEED", "SHERIFF'S DEED", 'MISCELLANEOUS DEED', 'DEED OF CONDEMNATION', 'DEED LAND BANK'] : ['DEED', "SHERIFF'S DEED"];
    const typeSql = types.map(q).join(',');
    const newest = (await getJson(`${C}?q=${encodeURIComponent(`select max(recording_date) mx from rtt_summary where document_type in (${typeSql})`)}`))?.rows?.[0]?.mx;
    if (!newest) return;
    const from = shift(newest, days);
    const where = [`document_type in (${typeSql})`, `recording_date >= ${q(from)}`];
    if (minP > 0) where.push(`total_consideration >= ${minP}`);
    if (maxP > 0) where.push(`total_consideration <= ${maxP}`);
    let offset = 0;
    while (!pastDeadline()) {
        const sql = `select document_id, document_type, recording_date, document_date, street_address, zip_code, grantors, grantees, total_consideration, cash_consideration, opa_account_num, property_count from rtt_summary where ${where.join(' and ')} order by recording_date desc, document_id limit 1000 offset ${offset}`;
        const res = await getJson(`${C}?q=${encodeURIComponent(sql)}`);
        const rows = res?.rows || [];
        if (!rows.length) break;
        for (const r of rows) {
            yield {
                county: 'philadelphia', countyLabel: 'Philadelphia, PA',
                documentId: String(r.document_id), documentType: r.document_type, recordedDate: day(r.recording_date), documentDate: day(r.document_date),
                price: num(r.total_consideration), cashConsideration: num(r.cash_consideration),
                address: r.street_address || null, unit: null, city: 'PHILADELPHIA', state: 'PA', zip: zip5(r.zip_code),
                parcelId: r.opa_account_num || null, propertyType: null, parcelCount: num(r.property_count),
                buyers: r.grantees ? String(r.grantees).split(/\s*;\s*/).filter(Boolean) : [], sellers: r.grantors ? String(r.grantors).split(/\s*;\s*/).filter(Boolean) : [],
                documentUrl: r.opa_account_num ? `https://property.phila.gov/?p=${r.opa_account_num}` : null,
                dataThrough: day(newest),
            };
        }
        offset += rows.length;
        if (rows.length < 1000) break;
    }
}

// ---------- Cook County ----------
async function* cook() {
    const S = 'https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json';
    const A = 'https://datacatalog.cookcountyil.gov/resource/3723-97qp.json';
    const newest = (await soda(S, { $select: 'max(sale_date) as mx' }))?.[0]?.mx;
    if (!newest) return;
    const from = shift(newest, days);
    const where = [`sale_date >= ${q(`${from}T00:00:00`)}`];
    if (!includeNonSaleDeeds) where.push(`deed_type in ('Warranty','Trustee','Other')`);
    if (minP > 0) where.push(`sale_price >= ${minP}`);
    if (maxP > 0) where.push(`sale_price <= ${maxP}`);
    let offset = 0;
    while (!pastDeadline()) {
        const sales = await soda(S, { $where: where.join(' AND '), $order: 'sale_date DESC, doc_no', $limit: '500', $offset: String(offset) });
        if (!sales?.length) break;
        const pins = [...new Set(sales.map((s) => s.pin))];
        const addrs = await soda(A, { $where: `pin in (${pins.map(q).join(',')})`, $order: 'year DESC', $limit: '5000' });
        const aBy = new Map(); for (const a of addrs || []) if (!aBy.has(a.pin)) aBy.set(a.pin, a);
        for (const s of sales) {
            const a = aBy.get(s.pin) || {};
            yield {
                county: 'cook', countyLabel: 'Cook County, IL',
                documentId: s.doc_no, documentType: s.mydec_deed_type || s.deed_type || null, recordedDate: day(s.sale_date), documentDate: day(s.sale_date),
                price: num(s.sale_price),
                address: a.prop_address_full || null, unit: null, city: a.prop_address_city_name || null, state: a.prop_address_state || 'IL', zip: zip5(a.prop_address_zipcode_1),
                parcelId: s.pin, propertyType: s.class ? `Class ${s.class}` : null, parcelCount: num(s.num_parcels_sale),
                buyers: s.buyer_name ? [s.buyer_name] : [], sellers: s.seller_name ? [s.seller_name] : [],
                // Assessor tax-bill mailing record: may still show the seller until the assessor updates it.
                taxBillName: a.owner_address_name || null, taxBillMailingAddress: a.owner_address_full || null, taxBillMailingCity: a.owner_address_city_name || null, taxBillMailingState: a.owner_address_state || null, taxBillMailingZip: zip5(a.owner_address_zipcode_1),
                documentUrl: `https://www.cookcountyassessor.com/pin/${s.pin}`,
                dataThrough: day(newest),
            };
        }
        offset += sales.length;
        if (sales.length < 500) break;
    }
}

const SOURCES = { nyc, philadelphia, cook };
const wanted = arr(counties).map((c) => c.toLowerCase()).filter((c) => SOURCES[c]);
const bad = arr(counties).filter((c) => !SOURCES[c.toLowerCase()]);
if (bad.length) await Actor.pushData({ note: `Counties not covered yet: ${bad.join(', ')}. Covered: nyc, philadelphia, cook. Not charged.` });
const perCounty = Math.max(1, Math.ceil(cap / Math.max(1, wanted.length)));
let pushed = 0;
const summary = {};
for (const c of wanted) {
    let got = 0;
    try {
        for await (const row of SOURCES[c]()) {
            if (got >= perCounty || pushed >= cap) break;
            if (!keep(row)) continue;
            await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
            got += 1; pushed += 1;
            if (pushed > FREE_TIER_ROWS) {
                try { await Actor.charge({ eventName: 'deed' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
            }
        }
    } catch (err) {
        log.error(`${c}: ${err.message}`);
        await Actor.pushData({ county: c, note: `${c} records could not be loaded (${err.message.slice(0, 100)}). Not charged.` });
    }
    summary[c] = got;
    log.info(`${c}: ${got} deeds`);
}
if (!pushed) await Actor.pushData({ note: 'No deed transfers matched. Raise daysOfRecords or loosen the price and keyword filters. Not charged.' });
await Actor.setValue('SUMMARY', { perCounty: summary, total: pushed });
log.info(`Done. ${pushed} deeds ${JSON.stringify(summary)}`);
await Actor.exit();
