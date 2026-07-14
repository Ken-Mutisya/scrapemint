// Phone Number Checker: Validate, Format & Find Country
//
// Strategy
// --------
// Google's libphonenumber rules (libphonenumber-js /max metadata for line
// type detection), fully offline: no network calls, no rate limits, nothing
// to block. One row per input number with validity, country, line type and
// clean formats. The /max build is required — the default metadata cannot
// distinguish mobile from landline.
//
// Honest scope: validates that a number is real by that country's numbering
// plan and formats it. It does NOT dial the number or check whether the line
// is currently active (that needs paid carrier lookups).
//
// Pay per event
// -------------
//   phone_checked per parseable number (valid true or false — both are
//   answers). Unparseable garbage is free. First 2 chargeable rows per run
//   are free.

import { Actor, log } from 'apify';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 100000;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { phoneNumbers = [], defaultCountry = '', maxRows = 10000 } = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const numbers = [...new Set(asTokens(phoneNumbers))].slice(0, HARD_CAP);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 10000));
const country = /^[A-Za-z]{2}$/.test(String(defaultCountry).trim()) ? String(defaultCountry).trim().toUpperCase() : undefined;

if (numbers.length === 0) {
    log.warning('No phone numbers given. Paste at least one, e.g. +14155552671.');
    await Actor.exit();
}
if (defaultCountry && !country) log.warning(`Ignoring default country "${defaultCountry}" (expected a 2 letter code like US or KE).`);

const countryName = (() => {
    try {
        const dn = new Intl.DisplayNames(['en'], { type: 'region' });
        return (code) => { try { return dn.of(code) || null; } catch { return null; } };
    } catch { return () => null; }
})();

const TYPE_LABELS = {
    MOBILE: 'mobile',
    FIXED_LINE: 'landline',
    FIXED_LINE_OR_MOBILE: 'landline or mobile',
    TOLL_FREE: 'toll free',
    PREMIUM_RATE: 'premium rate',
    SHARED_COST: 'shared cost',
    VOIP: 'voip',
    PERSONAL_NUMBER: 'personal number',
    PAGER: 'pager',
    UAN: 'company number',
    VOICEMAIL: 'voicemail',
};

let rowsPushed = 0;
let chargeableRows = 0;
let validCount = 0;

for (const raw of numbers) {
    if (rowsPushed >= cap) break;
    if (pastDeadline()) { log.warning('Approaching timeout; stopping early.'); break; }

    const parsed = parsePhoneNumberFromString(raw, country);
    let row;
    let chargeable;
    if (!parsed) {
        row = { input: raw, valid: null, note: country ? 'not a phone number' : 'not a phone number (if it lacks a + prefix, set a default country)' };
        chargeable = false;
    } else {
        const valid = parsed.isValid();
        if (valid) validCount += 1;
        const type = valid ? (parsed.getType() || null) : null;
        row = {
            input: raw,
            valid,
            country: parsed.country || null,
            countryName: parsed.country ? countryName(parsed.country) : null,
            countryCallingCode: `+${parsed.countryCallingCode}`,
            type: type ? (TYPE_LABELS[type] || type.toLowerCase()) : null,
            e164: valid ? parsed.number : null,
            international: valid ? parsed.formatInternational() : null,
            national: valid ? parsed.formatNational() : null,
        };
        chargeable = true;
    }

    await Actor.pushData(row);
    rowsPushed += 1;
    if (!chargeable) continue;
    chargeableRows += 1;
    if (chargeableRows > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'phone_checked' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed, ${validCount} valid `
    + `(${Math.max(0, chargeableRows - FREE_TIER_ROWS)} charged; unparseable input is free).`);
await Actor.exit();
