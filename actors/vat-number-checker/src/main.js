// EU VAT Number Checker: Validate & Get Company Details
//
// Strategy
// --------
// VIES REST API (ec.europa.eu, the European Commission's official registry),
// keyless JSON, verified reachable from Apify DC IPs. One POST per VAT number
// returns valid flag + registered company name and address where the member
// state discloses them (Germany returns "---", normalised to null).
//
// Covers EU-27 plus Northern Ireland (XI). Greece is EL in VIES; GR input is
// mapped. UK proper (GB) left VIES and is reported as unsupported, free.
//
// Member-state backends flake (MS_UNAVAILABLE / TIMEOUT / concurrency caps):
// those retry with backoff, then produce a FREE note row. Only rows with a
// definitive valid/invalid answer are charged. Small worker pool keeps under
// VIES's unofficial concurrency limits.
//
// Pay per event
// -------------
//   vat_checked per definitive answer (valid true or false). Bad format,
//   unsupported country and unavailable-backend rows are free. First 2
//   chargeable rows per run are free.

import { Actor, log } from 'apify';

const URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 20000;
const POOL_SIZE = 3;
const FETCH_TIMEOUT_MS = 30000;
const EU_CODES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR',
    'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);
const RETRYABLE = new Set(['MS_UNAVAILABLE', 'MS_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ', 'TIMEOUT', 'SERVICE_UNAVAILABLE']);

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { vatNumbers = [], requesterVatNumber = '', maxRows = 1000 } = input;

// "IE 6388047V", "ie6388047v", "FR-40 303 265 045" -> { countryCode, vatNumber }
function parseVat(raw) {
    const clean = String(raw || '').toUpperCase().replace(/[\s.\-–]/g, '');
    const m = clean.match(/^([A-Z]{2})([0-9A-Z+*]{2,12})$/);
    if (!m) return { raw, error: 'bad format: expected a 2 letter country prefix followed by the number, e.g. IE6388047V' };
    let cc = m[1] === 'GR' ? 'EL' : m[1];
    if (!EU_CODES.has(cc)) {
        const why = cc === 'GB' ? 'the UK left VIES; only Northern Ireland (XI) numbers can be checked'
            : 'not an EU VIES country code';
        return { raw, error: `unsupported country ${cc}: ${why}` };
    }
    return { raw, countryCode: cc, vatNumber: m[2] };
}

const seen = new Set();
const jobs = [];
const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map((s) => String(s || '').trim()).filter(Boolean);
for (const raw of asTokens(vatNumbers)) {
    const parsed = parseVat(raw);
    const key = parsed.error ? `raw:${raw}` : `${parsed.countryCode}${parsed.vatNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(parsed);
    if (jobs.length >= HARD_CAP) break;
}
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (jobs.length === 0) {
    log.warning('No VAT numbers given. Paste at least one, e.g. IE6388047V.');
    await Actor.exit();
}

const requester = requesterVatNumber ? parseVat(requesterVatNumber) : null;
if (requester?.error) log.warning(`Ignoring requester VAT number (${requester.error}); checks run without a consultation number.`);

async function checkVat({ countryCode, vatNumber }) {
    const body = { countryCode, vatNumber };
    if (requester && !requester.error) {
        body.requesterMemberStateCode = requester.countryCode;
        body.requesterNumber = requester.vatNumber;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(URL, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'scrapemint-vat-number-checker/0.1 (+https://apify.com)' },
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => null);
            const userError = json?.userError && !['VALID', 'INVALID'].includes(json.userError) ? json.userError : null;
            const wrapped = (json?.errorWrappers || [])[0]?.error || null;
            const viesError = userError || wrapped;
            if ((res.status === 200 || res.status === 400) && typeof json?.valid === 'boolean' && !viesError) return { json };
            if (viesError && !RETRYABLE.has(viesError)) return { viesError };
            throw new Error(viesError || `HTTP ${res.status}`);
        } catch (err) {
            if (attempt === 3) return { viesError: err?.message || 'request failed' };
            await sleep(attempt * 3000);
        } finally {
            clearTimeout(timer);
        }
    }
    return { viesError: 'request failed' };
}

let rowsPushed = 0;
let chargeableRows = 0;
let validCount = 0;
async function flushRow(row, chargeable) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'vat_checked' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const noneIfDashes = (s) => (!s || /^-+$/.test(String(s).trim())) ? null : String(s).trim();

log.info(`Checking ${jobs.length} VAT number(s)${requester && !requester.error ? ' with consultation numbers' : ''}...`);

let cursor = 0;
let stopped = false;
async function worker() {
    while (!stopped) {
        const i = cursor++;
        if (i >= jobs.length) return;
        if (rowsPushed >= cap) { stopped = true; return; }
        if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); stopped = true; return; }
        const job = jobs[i];
        const display = job.error ? job.raw : `${job.countryCode}${job.vatNumber}`;

        if (job.error) {
            await flushRow({ input: job.raw, valid: null, note: job.error }, false);
            continue;
        }

        const { json, viesError } = await checkVat(job);
        if (!json) {
            log.warning(`${display}: ${viesError}`);
            await flushRow({
                input: job.raw, countryCode: job.countryCode, vatNumber: job.vatNumber,
                valid: null, note: `could not check (${viesError}); not charged, try again later`,
            }, false);
            continue;
        }

        if (json.valid) validCount += 1;
        await flushRow({
            input: job.raw,
            countryCode: job.countryCode,
            vatNumber: job.vatNumber,
            valid: json.valid,
            companyName: noneIfDashes(json.name),
            companyAddress: noneIfDashes(json.address)?.replace(/\n+/g, ', ') ?? null,
            consultationNumber: json.requestIdentifier || null,
            checkedAt: json.requestDate || new Date().toISOString(),
        }, true);
        await sleep(200);
    }
}

await Promise.all(Array.from({ length: Math.min(POOL_SIZE, jobs.length) }, worker));

log.info(`Done. ${rowsPushed} row(s) pushed, ${validCount} valid `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; bad input and unavailable backends are free).`);
await Actor.exit();
