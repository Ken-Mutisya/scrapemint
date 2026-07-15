// IBAN Checker: Validate Bank Account Numbers in Bulk
//
// Strategy
// --------
// Fully offline: ISO 7064 mod-97 check digits + the vendored ISO 13616
// country registry (src/registry.js, 89 IBAN countries). No network at all:
// zero block risk, zero bandwidth, results in seconds. Pure logic lives in
// src/lib.js so it stays unit-testable without the platform SDK.
//
// Pay per event
// -------------
//   iban_checked per checked row — valid AND invalid verdicts both charge,
//   because catching the typo is the product. Inputs that are not IBAN-shaped
//   at all, or whose country does not issue IBANs, are free note rows.
//   First 2 chargeable rows per run are free.

import { Actor, log } from 'apify';
import { checkIban, normalize } from './lib.js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { ibans = [], maxRows = 10000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 10000));

const seen = new Set();
const jobs = [];
for (const raw of asTokens(ibans)) {
    const key = normalize(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(raw);
}

if (jobs.length === 0) {
    log.warning('No IBANs given. Paste at least one, like "DE89 3704 0044 0532 0130 00".');
    await Actor.exit();
}

log.info(`Checking ${jobs.length} IBAN(s)...`);

let rowsPushed = 0;
let chargeableRows = 0;
let validCount = 0;
for (const raw of jobs) {
    if (rowsPushed >= cap) break;
    const { kind, row } = checkIban(raw);
    await Actor.pushData(row);
    rowsPushed += 1;
    if (row.valid) validCount += 1;
    if (kind !== 'checked') continue;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'iban_checked' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${validCount} valid, ${rowsPushed - validCount} flagged `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; non-IBAN input is free).`);
await Actor.exit();
