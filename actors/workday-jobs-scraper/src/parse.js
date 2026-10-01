// "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago"
// -> days. 30+ reads as 31 so a 30-day window excludes it. null when unknown.
export function postedDaysAgo(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    if (/today|just posted|hours? ago|minutes? ago/.test(t)) return 0;
    if (/yesterday/.test(t)) return 1;
    const m = t.match(/(\d+)\s*(\+)?\s*days?/);
    if (m) return Number(m[1]) + (m[2] ? 1 : 0);
    return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };

export function htmlToText(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|ul|ol|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
            if (e[0] === '#') {
                const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : m;
            }
            return ENTITIES[e.toLowerCase()] ?? m;
        })
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Pay-transparency laws (CA, CO, NY, WA, IL...) put a range in the description:
// "The base salary range for this role is $148,000 - $287,500" or
// "$45.00 - $60.00 per hour". Only ranges or amounts next to pay words are
// taken, so a "$5B company" never reads as a salary.
const CURRENCY = { $: 'USD', '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'S$': 'SGD', 'R$': 'BRL', 'ZŁ': 'PLN', '₹': 'INR', '¥': 'JPY', CHF: 'CHF' };
const CODES = 'USD|CAD|GBP|EUR|AUD|CHF|SGD|INR|JPY|MXN|BRL|PLN|SEK|NOK|DKK|NZD';
// An optional ISO code may follow either amount ("$168,000 USD - $252,000 USD"),
// and it beats the symbol: "$169,000 - $253,000 CAD" is Canadian dollars.
const AMOUNT = String.raw`(C\$|CA\$|A\$|S\$|R\$|\$|£|€|zł|₹|¥|CHF)\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(k|K)?(?:\s?(${CODES}))?`;
const RANGE_RE = new RegExp(`${AMOUNT}\\s*(?:-|–|—|to)\\s*${AMOUNT}(?:\\s*(?:per|/|an|a)\\s*(hour|hr|year|yr|annum|month|week))?`, 'i');
const PAY_WORDS = /(salary|pay|compensation|wage|hourly rate|base)/i;

function toNum(n, k) {
    const s = String(n);
    // "148,000" / "148.000" thousands vs "45.50" decimals.
    const v = /[,.]\d{3}(?![\d])/.test(s) ? Number(s.replace(/[,.](?=\d{3}(?!\d))/g, '').replace(',', '.')) : Number(s.replace(',', '.'));
    return k ? v * 1000 : v;
}

export function parseSalary(text) {
    const empty = { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryText: null };
    if (!text) return empty;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(RANGE_RE);
        if (!m) continue;
        const context = `${lines[i - 1] || ''} ${lines[i]}`;
        if (!PAY_WORDS.test(context)) continue;
        const min = toNum(m[2], m[3]);
        const max = toNum(m[6], m[7]);
        if (!(min > 0) || !(max >= min)) continue;
        let period = (m[9] || '').toLowerCase();
        if (!period) period = /hour|hourly/i.test(context) ? 'hour' : (max < 500 ? 'hour' : 'year');
        period = { hr: 'hour', yr: 'year', annum: 'year' }[period] || period;
        return {
            salaryMin: min,
            salaryMax: max,
            salaryCurrency: (m[8] || m[4] || '').toUpperCase() || CURRENCY[m[1].toUpperCase()] || null,
            salaryPeriod: period,
            salaryText: m[0].trim(),
        };
    }
    return empty;
}
