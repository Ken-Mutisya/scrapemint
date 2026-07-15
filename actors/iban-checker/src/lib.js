// Pure IBAN validation logic (no platform imports, unit-testable standalone).
import { IBAN_LENGTHS, SEPA, BBAN_PARTS } from './registry.js';

export const normalize = (raw) => String(raw || '').toUpperCase().replace(/[\s-]/g, '');

// ISO 7064 mod-97-10: move the first 4 chars to the end, map A-Z to 10-35,
// and the resulting number must be ≡ 1 (mod 97). Chunked to avoid BigInt.
export function mod97Ok(iban) {
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
        const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
        for (const d of v) remainder = (remainder * 10 + Number(d)) % 97;
    }
    return remainder === 1;
}

const slicePart = (bban, range) => (range ? bban.slice(range[0], range[1]) || null : null);

// Returns { kind: 'garbage' | 'no_iban_country' | 'checked', row }
export function checkIban(raw) {
    const iban = normalize(raw);
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(iban)) {
        return { kind: 'garbage', row: { input: raw, valid: false, note: 'not IBAN-shaped (expected 2-letter country + 2 check digits + account); not charged' } };
    }
    const countryCode = iban.slice(0, 2);
    const expectedLength = IBAN_LENGTHS[countryCode];
    if (!expectedLength) {
        return { kind: 'no_iban_country', row: { input: raw, valid: false, countryCode, note: `"${countryCode}" is not an IBAN country; not charged` } };
    }

    const problems = [];
    if (iban.length !== expectedLength) problems.push(`length is ${iban.length}, ${countryCode} IBANs are ${expectedLength} characters`);
    const checksumOk = mod97Ok(iban);
    if (!checksumOk) problems.push('check digits do not match (mod-97 failed — likely a typo or mis-scan)');

    const valid = problems.length === 0;
    const bban = iban.slice(4);
    const parts = valid ? BBAN_PARTS[countryCode] : null;
    let countryName = null;
    try { countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) || null; } catch { /* keep null */ }

    return {
        kind: 'checked',
        row: {
            input: raw,
            valid,
            countryCode,
            countryName,
            iban: valid ? iban : null,
            printFormat: valid ? iban.replace(/(.{4})/g, '$1 ').trim() : null,
            checkDigits: iban.slice(2, 4),
            checksumOk,
            expectedLength,
            actualLength: iban.length,
            bankCode: parts ? slicePart(bban, parts.bank) : null,
            branchCode: parts ? slicePart(bban, parts.branch) : null,
            accountNumber: parts ? slicePart(bban, parts.account) : null,
            sepa: SEPA.has(countryCode),
            problems: valid ? null : problems,
        },
    };
}
