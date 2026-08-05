// Shaping helpers for CBP CROSS rulings.
//
// Split out of main.js because two of these decide whether a search returns
// anything at all, and a third decides whether a billed row misstates the legal
// weight of a ruling.

const SITE = 'https://rulings.cbp.gov';

/** Digits only, so "6109.10.0040", "6109.10.00.40" and "6109100040" unify. */
export function codeDigits(s) {
    return String(s ?? '').replace(/\D/g, '');
}

/**
 * Group digits the way CROSS writes them: 4.2.4 at ten digits.
 *
 * This is not the same grouping the tariff schedule uses, and the difference is
 * not cosmetic. CROSS matches the search term as a literal string, so
 * "6109.10.00.40" (the HTS form) returns ZERO hits while "6109.10.0040" returns
 * 121. A user pasting a code straight out of the HTS, or out of our own
 * import-duty-tariff-calculator, would conclude no rulings exist.
 */
export function toCrossFormat(digits) {
    const d = codeDigits(digits);
    if (d.length <= 4) return d;
    if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
    if (d.length <= 8) return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 10)}`;
}

/**
 * Group digits the way the Harmonized Tariff Schedule publishes them: 4.2.2.2.
 * Emitted alongside the CROSS form so a row can be joined against tariff data
 * without the caller having to know the two systems disagree.
 */
export function toHtsFormat(digits) {
    const d = codeDigits(digits);
    if (d.length <= 4) return d;
    const parts = [d.slice(0, 4)];
    for (let i = 4; i < d.length; i += 2) parts.push(d.slice(i, i + 2));
    return parts.join('.');
}

/**
 * Does this search term look like a tariff code rather than a product name?
 *
 * Only codes get reformatted. Reformatting a product name would corrupt it, and
 * leaving a code alone makes the search silently fail, so the test has to be
 * conservative: mostly digits, with separators but no letters or spaces.
 */
export function looksLikeCode(term) {
    const t = String(term ?? '').trim();
    if (!t || /[a-z\s]/i.test(t)) return false;
    return codeDigits(t).length >= 4;
}

/** A search term, reformatted only when it is a code. */
export function normalizeTerm(term) {
    const t = String(term ?? '').trim();
    return looksLikeCode(t) ? toCrossFormat(t) : t;
}

/**
 * CROSS returns "0001-01-01T00:00:00" when a ruling's date metadata is missing,
 * which is roughly 1% of the collection. These are real rulings with full text,
 * not placeholders, so they are kept -- but published with a null date rather
 * than a date in the year 1, and flagged so the absence is filterable.
 */
export function rulingDate(raw) {
    const s = String(raw ?? '');
    if (!s || s.startsWith('0001-01-01')) return null;
    const d = s.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Year read out of the document path, e.g. "/docs/hq/2002/w964711.doc".
 *
 * Kept in its own field and never merged into rulingDate: it is inferred from
 * where CBP filed the document, not stated by CBP as the ruling date. For a
 * ruling whose date metadata is missing it is often the only dating available,
 * and a buyer sorting by it should know that is what they are doing.
 */
export function yearFromPath(url) {
    const m = String(url ?? '').match(/\/((?:19|20)\d{2})\//);
    return m ? Number(m[1]) : null;
}

/**
 * How much weight this ruling still carries.
 *
 * A revoked ruling keeps coming back in search results, styled identically to a
 * live one. A customs ruling is legal authority, so citing a revoked one to
 * justify a classification is not a cosmetic error -- it is the kind of thing an
 * importer acts on and gets penalised for.
 *
 * `noRecordedChange` is deliberately not called "good law". It states exactly
 * what the data supports: CROSS records no revoking or modifying document. CBP
 * can supersede a ruling by an action CROSS has not linked, so absence of a
 * link is not proof the ruling still stands.
 */
export function precedent(r) {
    const revokedBy = arr(r?.revokedBy);
    const modifiedBy = arr(r?.modifiedBy);
    const operationally = r?.operationallyRevoked === true;

    let status = 'noRecordedChange';
    if (operationally || revokedBy.length) status = 'revoked';
    else if (modifiedBy.length) status = 'modified';

    return {
        precedentStatus: status,
        isSuperseded: status !== 'noRecordedChange',
        operationallyRevoked: operationally,
        revokedBy: revokedBy.length ? revokedBy : null,
        revokes: nullIfEmpty(arr(r?.revokes)),
        modifiedBy: modifiedBy.length ? modifiedBy : null,
        modifies: nullIfEmpty(arr(r?.modifies)),
        supersededBy: nullIfEmpty([...new Set([...revokedBy, ...modifiedBy])]),
        precedentStatusNote: status === 'noRecordedChange'
            ? 'CROSS records no document revoking or modifying this ruling. That is not the '
              + 'same as confirmation it still stands; verify before relying on it.'
            : 'Superseded. Read the revoking or modifying ruling before citing this one.',
    };
}

/**
 * CROSS ships the ruling body as word-processor plain text: CR line endings,
 * form feeds between pages and tabs used for layout. Passed through untouched it
 * renders as one unbroken line in most tools.
 */
export function cleanText(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    const out = raw
        .replace(/\f/g, '\n\n')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, ' ')
        .replace(/[ ]{2,}/g, ' ')
        /* Tabs used for column layout sit at end of line all through these
         * documents, so collapsing them to spaces leaves ragged trailing
         * whitespace on most lines unless it is trimmed per line. */
        .replace(/[ ]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return out === '' ? null : out;
}

/** Relative paths as CROSS returns them are useless to a caller. */
export function absoluteUrl(path) {
    const p = String(path ?? '').trim();
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return p;
    return `${SITE}${p.startsWith('/') ? '' : '/'}${p}`;
}

export function rulingPageUrl(rulingNumber) {
    const n = String(rulingNumber ?? '').trim();
    return n ? `${SITE}/ruling/${encodeURIComponent(n)}` : null;
}

export const COLLECTION_LABELS = {
    ny: 'National Commodity Specialist Division (New York)',
    hq: 'CBP Headquarters',
};

function arr(v) {
    return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : [];
}
function nullIfEmpty(a) {
    return a.length ? a : null;
}
