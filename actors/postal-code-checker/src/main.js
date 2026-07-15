// Postal Code Checker: Global ZIP & Postcode Lookup
//
// Strategy
// --------
// Fully offline: a bundled GeoNames postal dataset (CC BY 4.0, 1.8M codes,
// 121 countries; src/data/postal.tsv.gz, columns cc|code|place|region|
// district|lat|lng) is streamed once per run and matched against the
// requested codes. No network at all: zero block risk, zero bandwidth.
//
// Matching: exact code first, then documented fallbacks for countries where
// the dataset is coarser than the full code — GB full postcodes fall back to
// the outward part ("SW1A 1AA" -> "SW1A"), CA to the FSA ("K1A 0B1" -> "K1A"),
// BR full CEPs to the 5-digit prefix ("01310-100" -> "01310"). A bare code
// without a country matches every country that uses it.
//
// Pay per event
// -------------
//   postal_code_found per matched (country, code) row. Invalid and unknown
//   codes are free note rows. First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'postal.tsv.gz');
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const MAX_PLACES_PER_ROW = 20;
const MAX_COUNTRIES_PER_BARE_CODE = 20;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { codes = [], defaultCountry = '', maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));
const fallbackCountry = String(defaultCountry || '').trim().toUpperCase();
const countryName = (cc) => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || null; } catch { return null; }
};

if (fallbackCountry && !/^[A-Z]{2}$/.test(fallbackCountry)) {
    log.warning(`defaultCountry "${defaultCountry}" is not a 2-letter country code; ignoring it.`);
}

// Parse "US 90210" / "90210" into { cc|null, code } and build match variants
// in priority order (exact first, then coarser fallbacks).
const norm = (s) => s.toUpperCase().replace(/\s+/g, ' ').trim();
function variantsOf(code) {
    const list = [code];
    const beforeSpace = code.includes(' ') ? code.split(' ')[0] : null;
    const beforeDash = code.includes('-') ? code.split('-')[0] : null;
    if (beforeSpace && !list.includes(beforeSpace)) list.push(beforeSpace);
    if (beforeDash && !list.includes(beforeDash)) list.push(beforeDash);
    return list;
}

const jobs = [];
const seenInputs = new Set();
for (const raw of asTokens(codes)) {
    const cleaned = norm(raw);
    if (seenInputs.has(cleaned)) continue;
    seenInputs.add(cleaned);
    const m = cleaned.match(/^([A-Z]{2})\s+(.+)$/);
    let cc = m ? m[1] : (/^[A-Z]{2}$/.test(fallbackCountry) ? fallbackCountry : null);
    let code = m ? m[2] : cleaned;
    if (!code || code.length > 20) {
        jobs.push({ input: raw, error: 'not a usable postal code' });
        continue;
    }
    jobs.push({ input: raw, cc, code, variants: variantsOf(code) });
}

if (jobs.length === 0) {
    log.warning('No postal codes given. Paste at least one code like "US 90210" or "DE 10115".');
    await Actor.exit();
}

// variant code -> [{ job, priority }] so one streaming pass serves all jobs.
const wanted = new Map();
for (const job of jobs) {
    if (job.error) continue;
    job.variants.forEach((v, priority) => {
        if (!wanted.has(v)) wanted.set(v, []);
        wanted.get(v).push({ job, priority });
    });
}

log.info(`Looking up ${jobs.length} code(s) against the bundled dataset (1.8M codes, 121 countries)...`);

// hits: job -> priority -> cc -> places[]
const started = Date.now();
const rl = createInterface({ input: createReadStream(DATA_PATH).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
    const tab1 = line.indexOf('\t');
    const tab2 = line.indexOf('\t', tab1 + 1);
    const code = line.slice(tab1 + 1, tab2);
    const entries = wanted.get(code);
    if (!entries) continue;
    const [cc, , place, region, district, lat, lng] = line.split('\t');
    for (const { job, priority } of entries) {
        if (job.cc && job.cc !== cc) continue;
        job.hits ??= new Map();
        if (!job.hits.has(priority)) job.hits.set(priority, new Map());
        const byCountry = job.hits.get(priority);
        if (!byCountry.has(cc)) byCountry.set(cc, { code, places: [] });
        const bucket = byCountry.get(cc);
        if (bucket.places.length < MAX_PLACES_PER_ROW) {
            bucket.places.push({
                name: place || null,
                region: region || null,
                district: district || null,
                latitude: lat ? Number(lat) : null,
                longitude: lng ? Number(lng) : null,
            });
        }
    }
}
log.info(`Dataset scanned in ${((Date.now() - started) / 1000).toFixed(1)}s.`);

let rowsPushed = 0;
let chargeableRows = 0;
let found = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'postal_code_found' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const MATCH_LABEL = ['exact', 'outward part before space', 'prefix before dash'];
outer:
for (const job of jobs) {
    if (rowsPushed >= cap) break;
    if (job.error) {
        await flushRow({ input: job.input, found: false, note: job.error }, false);
        continue;
    }
    const bestPriority = job.hits ? Math.min(...job.hits.keys()) : null;
    if (bestPriority == null) {
        await flushRow({ input: job.input, found: false, note: job.cc ? `no ${job.cc} entry for this code in the dataset` : 'no country uses this code in the dataset' }, false);
        continue;
    }
    const byCountry = [...job.hits.get(bestPriority).entries()].slice(0, MAX_COUNTRIES_PER_BARE_CODE);
    for (const [cc, bucket] of byCountry) {
        if (rowsPushed >= cap) break outer;
        found += 1;
        const primary = bucket.places[0] || {};
        await flushRow({
            input: job.input,
            found: true,
            countryCode: cc,
            countryName: countryName(cc),
            postalCode: bucket.code,
            matchedBy: MATCH_LABEL[bestPriority] || 'exact',
            placeName: primary.name ?? null,
            region: primary.region ?? null,
            district: primary.district ?? null,
            latitude: primary.latitude ?? null,
            longitude: primary.longitude ?? null,
            placeCount: bucket.places.length,
            places: bucket.places,
        }, true);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${found} code(s) matched `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; not-found and bad input are free).`);
await Actor.exit();
