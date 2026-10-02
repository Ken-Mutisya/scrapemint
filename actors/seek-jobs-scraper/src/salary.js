// Seek salary labels are free text written by the advertiser:
//   "$150,000 – $200,000 per year"
//   "$113,978 - $125,456 p.a. + 12% superannuation"
//   "$110.00 - $135.00 phr (incl. super)"
//   "$160k+super"
//   "Competitive salary and benefits."
// Parsed into min/max/period and whether super is included. A label with no
// dollar amount parses to nulls rather than a guess.

const NUM = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|K)(?![a-zA-Z]))?/g;

function periodOf(text, max) {
    const t = text.toLowerCase();
    if (/\b(p\.?\s?h\.?r?|per\s+hour|hourly|\/\s?h(ou)?r|an\s+hour|ph)\b/.test(t)) return 'hour';
    if (/\b(per\s+day|p\.?d\.?|daily|\/\s?day|a\s+day)\b/.test(t)) return 'day';
    if (/\b(per\s+week|p\.?w\.?|weekly|\/\s?week)\b/.test(t)) return 'week';
    if (/\b(per\s+month|monthly|\/\s?month)\b/.test(t)) return 'month';
    if (/\b(p\.?\s?a\.?|per\s+(year|annum)|annual(ly)?|\/\s?(yr|year)|a\s+year|salary)\b/.test(t)) return 'year';
    // No period word: Australian hourly rates sit below ~$300, daily rates
    // below ~$2,000, and anything larger is a yearly salary.
    if (max == null) return null;
    if (max < 300) return 'hour';
    if (max < 2000) return 'day';
    return 'year';
}

export function parseSeekSalary(label, currency) {
    const empty = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryIncludesSuper: null };
    if (!label) return empty;
    const nums = [...String(label).matchAll(NUM)].map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)).filter((n) => n > 0);
    if (!nums.length) return empty;
    const min = nums[0];
    const max = nums[1] && nums[1] >= min ? nums[1] : min;
    const t = String(label).toLowerCase();
    let includesSuper = null;
    if (/\b(incl\.?|including|inclusive of|inc\.?)\s*(of\s+)?super/.test(t) || /\bpackage\b/.test(t)) includesSuper = true;
    else if (/(\+|plus|and)\s*(\d+(\.\d+)?%\s*)?super/.test(t)) includesSuper = false;
    return { salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: periodOf(t, max), salaryIncludesSuper: includesSuper };
}
