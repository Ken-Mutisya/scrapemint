// JobStreet and JobsDB salary labels are advertiser free text in six
// currencies, nearly always monthly:
//   "RM 3,500 – RM 5,000 per month"        Malaysia
//   "$3,000 – $4,500 per month"            Singapore (SGD) / Hong Kong (HKD)
//   "₱30,000 – ₱40,000 per month", "Up to PHP35K"   Philippines
//   "Rp 3.500.000 – Rp 4.000.000 per month"         Indonesia (dot thousands)
//   "฿20,000 – ฿25,000 per month"          Thailand
// A bare "$" means the site's own dollar (SGD, HKD), elsewhere USD. A label
// with no amount ("negotiable") parses to nulls rather than a guess.

const CODES = { 'S$': 'SGD', SGD: 'SGD', 'HK$': 'HKD', HKD: 'HKD', 'US$': 'USD', USD: 'USD', RM: 'MYR', MYR: 'MYR', '₱': 'PHP', PHP: 'PHP', RP: 'IDR', IDR: 'IDR', '฿': 'THB', THB: 'THB' };
const NUM = /(S\$|HK\$|US\$|SGD|HKD|USD|MYR|PHP|IDR|THB|RM|Rp|₱|฿|\$)\s?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(k|K)(?![a-zA-Z]))?/g;

function toNumber(raw, k) {
    // "3.500.000" and "3,500" are thousands; "3.50" is a decimal.
    const thousands = /^\d{1,3}([.,]\d{3})+$/.test(raw) || /^\d{1,3}([.,]\d{3})+[.,]\d{1,2}$/.test(raw);
    let n;
    if (thousands) {
        const dec = raw.match(/[.,](\d{1,2})$/);
        const intPart = dec ? raw.slice(0, -dec[0].length) : raw;
        n = Number(intPart.replace(/[.,]/g, '')) + (dec ? Number(`0.${dec[1]}`) : 0);
    } else n = Number(raw.replace(',', '.'));
    return k ? n * 1000 : n;
}

function periodOf(t) {
    if (/\b(per\s+hour|hourly|\/\s?h(ou)?r|an\s+hour|p\.?h\.?)\b/.test(t)) return 'hour';
    if (/\b(per\s+day|daily|\/\s?day|a\s+day)\b/.test(t)) return 'day';
    if (/\b(per\s+week|weekly|\/\s?week)\b/.test(t)) return 'week';
    if (/\b(per\s+(year|annum)|annual(ly)?|p\.?\s?a\.?|\/\s?(yr|year)|a\s+year)\b/.test(t)) return 'year';
    // Monthly pay is the norm in these markets and the label usually says so;
    // when it does not, month is the reading.
    return 'month';
}

export function parseAsiaSalary(label, siteDollar) {
    const empty = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null };
    if (!label) return empty;
    const hits = [...String(label).matchAll(NUM)];
    if (!hits.length) return empty;
    const nums = hits.map((m) => toNumber(m[2], m[3])).filter((n) => n > 0);
    if (!nums.length) return empty;
    const sym = hits[0][1];
    const currency = sym === '$' ? siteDollar : (CODES[sym.toUpperCase()] || CODES[sym] || null);
    const min = nums[0];
    const max = nums[1] && nums[1] >= min ? nums[1] : min;
    return { salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: periodOf(String(label).toLowerCase()) };
}
