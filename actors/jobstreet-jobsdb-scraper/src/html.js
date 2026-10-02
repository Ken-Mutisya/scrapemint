// HTML to readable text, shared shape with workday-jobs-scraper/src/parse.js.
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

