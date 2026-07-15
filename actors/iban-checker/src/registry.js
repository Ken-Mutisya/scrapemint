// ISO 13616 / SWIFT IBAN registry: official IBAN length per country code.
// Countries not listed here do not issue IBANs (their rows come back as
// "country does not use IBAN", free).
export const IBAN_LENGTHS = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
    BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
    DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
    GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
    IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
    LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22,
    MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23,
    PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
    SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
    TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

// SEPA scheme members (payments in EUR clear via SEPA rails).
export const SEPA = new Set([
    'AD', 'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
    'FR', 'GB', 'GI', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU',
    'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM',
    'VA',
]);

// BBAN part offsets [start, end) within the BBAN (the IBAN after the first 4
// chars) for countries where the split is well documented. Countries not
// listed decode with bankCode/branchCode null.
export const BBAN_PARTS = {
    DE: { bank: [0, 8], account: [8, 18] },
    GB: { bank: [0, 4], branch: [4, 10], account: [10, 18] },
    FR: { bank: [0, 5], branch: [5, 10], account: [10, 21] },
    ES: { bank: [0, 4], branch: [4, 8], account: [10, 20] },
    IT: { bank: [1, 6], branch: [6, 11], account: [11, 23] },
    NL: { bank: [0, 4], account: [4, 14] },
    BE: { bank: [0, 3], account: [3, 10] },
    PT: { bank: [0, 4], branch: [4, 8], account: [8, 19] },
    AT: { bank: [0, 5], account: [5, 16] },
    CH: { bank: [0, 5], account: [5, 17] },
    PL: { bank: [0, 8], account: [8, 24] },
    IE: { bank: [0, 4], branch: [4, 10], account: [10, 18] },
    DK: { bank: [0, 4], account: [4, 14] },
    NO: { bank: [0, 4], account: [4, 11] },
    SE: { bank: [0, 3], account: [3, 20] },
    FI: { bank: [0, 6], account: [6, 14] },
    CZ: { bank: [0, 4], account: [4, 20] },
    SK: { bank: [0, 4], account: [4, 20] },
    RO: { bank: [0, 4], account: [4, 20] },
    GR: { bank: [0, 3], branch: [3, 7], account: [7, 23] },
    BG: { bank: [0, 4], branch: [4, 8], account: [8, 18] },
    TR: { bank: [0, 5], account: [6, 22] },
    LU: { bank: [0, 3], account: [3, 16] },
    HR: { bank: [0, 7], account: [7, 17] },
    HU: { bank: [0, 3], branch: [3, 7], account: [7, 24] },
};
