// IP Address Lookup: Location, Company & Proxy Check
//
// Strategy
// --------
// ip-api.com batch endpoint, keyless, up to 100 IPs per POST, no browser, no
// proxy. Note: the free ip-api endpoint is HTTP only (HTTPS needs a paid key),
// so the base URL is http://. Rate limit is 15 batch requests per minute; the
// response carries X-Rl (requests left) and X-Ttl (seconds to reset), which we
// obey by sleeping when the window is exhausted.
//
// One row per input IP. Invalid IPs are returned (valid:false) but never
// charged.
//
// Pay per event
// -------------
//   ip_lookup per successfully located IP. First 2 chargeable rows per run
//   are free.

import { Actor, log } from 'apify';

const BATCH_URL = 'http://ip-api.com/batch';
const FIELDS = 'status,message,query,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting';
const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 30000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { ips = [], maxRows = 1000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;\s]+/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const ipList = [...new Set(asTokens(ips))].slice(0, HARD_CAP);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 1000));

if (ipList.length === 0) {
    log.warning('No IP addresses given. Paste at least one IP, e.g. 8.8.8.8.');
    await Actor.exit();
}

async function fetchBatch(batch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${BATCH_URL}?fields=${FIELDS}`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', 'user-agent': 'scrapemint-ip-address-lookup/0.1 (+https://apify.com)' },
            body: JSON.stringify(batch),
        });
        // Respect the documented rate limit: if the window is used up, wait it out.
        if (res.status === 429) {
            const ttl = Number(res.headers.get('x-ttl')) || 5;
            log.info(`Rate limited; waiting ${ttl}s...`);
            await sleep((ttl + 1) * 1000);
            throw new Error('rate-limited (will retry)');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const left = Number(res.headers.get('x-rl'));
        const ttl = Number(res.headers.get('x-ttl'));
        return { data, left, ttl };
    } finally {
        clearTimeout(timer);
    }
}

function toRow(r) {
    if (!r || r.status !== 'success') {
        return { ip: r?.query ?? null, valid: false, note: r?.message || 'could not locate this IP' };
    }
    return {
        ip: r.query,
        valid: true,
        country: r.country || null,
        countryCode: r.countryCode || null,
        region: r.regionName || null,
        city: r.city || null,
        zip: r.zip || null,
        latitude: r.lat ?? null,
        longitude: r.lon ?? null,
        timezone: r.timezone || null,
        isp: r.isp || null,
        organization: r.org || null,
        asn: r.as || null,
        asnName: r.asname || null,
        isMobile: Boolean(r.mobile),
        isProxyOrVpn: Boolean(r.proxy),
        isHostingOrDatacenter: Boolean(r.hosting),
    };
}

let rowsPushed = 0;
let chargeableRows = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (!row.valid) return;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'ip_lookup' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Looking up ${ipList.length} IP(s) in batches of ${BATCH_SIZE}...`);

let located = 0;
outer:
for (let i = 0; i < ipList.length && rowsPushed < cap; i += BATCH_SIZE) {
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }
    const batch = ipList.slice(i, i + BATCH_SIZE);

    let result;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        try { result = await fetchBatch(batch); break; }
        catch (err) {
            if (attempt === 4) log.warning(`Batch at ${i} failed: ${err?.message}`);
            else if (!String(err?.message).includes('rate-limited')) await sleep(attempt * 2000);
        }
    }
    if (!result) continue;

    for (const r of result.data) {
        if (rowsPushed >= cap) break outer;
        const row = toRow(r);
        if (row.valid) located += 1;
        await flushRow(row);
    }

    // Pre-empt the next 429: if this window is nearly spent, wait for reset.
    if (Number.isFinite(result.left) && result.left <= 1 && Number.isFinite(result.ttl)
        && i + BATCH_SIZE < ipList.length) {
        log.info(`Rate window almost spent; pausing ${result.ttl + 1}s...`);
        await sleep((result.ttl + 1) * 1000);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${located} located (${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; invalid are free).`);
await Actor.exit();
