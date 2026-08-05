// Duty-rate parsing and HTS tree resolution.
//
// Split out of main.js because the rate grammar is the whole product: get the
// parse wrong and every billed row states a confident wrong duty.

/* Special Program Indicator codes as they appear in the HTS "Special" column.
 * The suffixed variants (A+, E*, P+, S+) are separate legal designations, not
 * typos, so they are listed rather than stripped to their base letter. */
export const SPI_PROGRAMS = {
    A: 'Generalized System of Preferences (GSP)',
    'A*': 'GSP, excluding certain beneficiary countries',
    'A+': 'GSP, least-developed beneficiary countries only',
    AU: 'US-Australia Free Trade Agreement',
    B: 'Automotive Products Trade Act',
    BH: 'US-Bahrain Free Trade Agreement',
    C: 'Agreement on Trade in Civil Aircraft',
    CA: 'NAFTA Canada (superseded by USMCA)',
    CL: 'US-Chile Free Trade Agreement',
    CO: 'US-Colombia Trade Promotion Agreement',
    D: 'African Growth and Opportunity Act (AGOA)',
    E: 'Caribbean Basin Economic Recovery Act',
    'E*': 'Caribbean Basin Economic Recovery Act, excluding certain countries',
    IL: 'US-Israel Free Trade Agreement',
    J: 'Andean Trade Preference Act',
    'J*': 'Andean Trade Preference Act, excluding certain countries',
    'J+': 'Andean Trade Promotion and Drug Eradication Act',
    JO: 'US-Jordan Free Trade Agreement',
    JP: 'US-Japan Trade Agreement',
    K: 'Pharmaceutical Appendix',
    KR: 'US-Korea Free Trade Agreement (KORUS)',
    L: 'Intermediate chemicals for dyes appendix',
    MA: 'US-Morocco Free Trade Agreement',
    MX: 'NAFTA Mexico (superseded by USMCA)',
    NP: 'Nepal Preference Program',
    OM: 'US-Oman Free Trade Agreement',
    P: 'Dominican Republic-Central America FTA (CAFTA-DR)',
    'P+': 'CAFTA-DR, certain agricultural goods',
    PA: 'US-Panama Trade Promotion Agreement',
    PE: 'US-Peru Trade Promotion Agreement',
    R: 'Caribbean Basin Trade Partnership Act (CBTPA)',
    S: 'United States-Mexico-Canada Agreement (USMCA)',
    'S+': 'USMCA, certain agricultural goods',
    SG: 'US-Singapore Free Trade Agreement',
};

/* Programs that need an authorization Congress has to keep renewing. When one
 * lapses the code stays printed in the HTS but the duty-free treatment is not
 * actually claimable, so a row that reports "Free under GSP" without a caveat
 * is telling an importer something that may not be true at entry time. */
export const RENEWAL_DEPENDENT = new Set(['A', 'A*', 'A+', 'J', 'J*', 'J+']);

/* Origin country to the Special Program Indicators it can claim under.
 * Eligibility here means "this country participates in this program", NOT that
 * a given shipment qualifies: that turns on rules of origin the HTS does not
 * publish. Every consumer of this map must carry that caveat forward. */
export const COUNTRY_PROGRAMS = {
    AU: ['AU'], BH: ['BH'], CA: ['S', 'S+', 'CA'], CL: ['CL'], CO: ['CO'],
    CR: ['P', 'P+'], DO: ['P', 'P+'], GT: ['P', 'P+'], HN: ['P', 'P+'],
    NI: ['P', 'P+'], SV: ['P', 'P+'],
    IL: ['IL'], JO: ['JO'], JP: ['JP'], KR: ['KR'], MA: ['MA'],
    MX: ['S', 'S+', 'MX'], NP: ['NP'], OM: ['OM'], PA: ['PA'], PE: ['PE'],
    SG: ['SG'],
};

/* Column 2 ("Other") rates apply to countries without Normal Trade Relations.
 * Cuba and North Korea sit in HTS General Note 3(b); Russia and Belarus were
 * moved to column 2 by the Suspending Normal Trade Relations with Russia and
 * Belarus Act (Public Law 117-110, April 2022). This set is set by statute and
 * changes by act of Congress, so the actor reports which column it applied and
 * lets the caller override rather than treating it as settled. */
export const COLUMN_2_COUNTRIES = new Set(['CU', 'KP', 'RU', 'BY']);

/* HTS descriptions carry presentation markup (<il> for italics, <sup> for
 * footnote markers). Left in, it leaks into every description field and breaks
 * exact-match lookups downstream. */
export function stripMarkup(s) {
    if (typeof s !== 'string') return null;
    const out = s
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    return out === '' ? null : out;
}

/** Digits only, so "8541.43.00.10", "8541430010" and "8541 43 00 10" unify. */
export function normalizeCode(s) {
    return String(s ?? '').replace(/\D/g, '');
}

/** Format digits back into the dotted HTS presentation (4.2.2.2). */
export function formatCode(digits) {
    const d = normalizeCode(digits);
    if (d.length <= 4) return d;
    const parts = [d.slice(0, 4)];
    for (let i = 4; i < d.length; i += 2) parts.push(d.slice(i, i + 2));
    return parts.join('.');
}

/**
 * Parse one duty-rate cell.
 *
 * The grammar is not just percentages. Real cells include "Free",
 * "90¢/pr. + 37.5%" (compound), "3.9¢/kg" (specific only) and "" (inherited).
 * These four cases must stay distinguishable downstream, because:
 *   * "" is unknown, not zero. A `Number("") || 0` would publish duty-free.
 *   * A specific-only rate has NO ad valorem component. Reporting 0% there
 *     would tell an importer the goods enter free when they do not.
 * So adValoremPct is null unless a percentage is genuinely present, and
 * `isFree` is reserved for a cell that literally says Free.
 */
export function parseRate(raw) {
    const text = stripMarkup(raw);
    if (!text) {
        return {
            text: null, isFree: false, adValoremPct: null,
            specificRateText: null, isCompound: false, isAdValoremOnly: false,
        };
    }

    const isFree = /^free$/i.test(text);
    if (isFree) {
        return {
            text, isFree: true, adValoremPct: 0,
            specificRateText: null, isCompound: false, isAdValoremOnly: true,
        };
    }

    /* Percent components. A cell can hold more than one ("5% + 2%"), so they
     * are summed rather than first-match-wins. */
    const pctMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    const adValoremPct = pctMatches.length
        ? Math.round(pctMatches.reduce((s, m) => s + Number(m[1]), 0) * 1e6) / 1e6
        : null;

    /* A specific duty is charged per physical unit (¢/kg, $/pr., ¢/liter).
     * Detected by a currency amount bound to a unit rather than a percent. */
    const specificMatches = [...text.matchAll(
        /(?:\$|¢|cents?\b)\s*[\d.]*\s*(?:\/\s*[A-Za-z.]+|per\s+[A-Za-z.]+)|[\d.]+\s*(?:¢|cents?)\s*\/\s*[A-Za-z.]+/g,
    )];
    const specificRateText = specificMatches.length
        ? specificMatches.map((m) => m[0].trim()).join(' + ')
        : (adValoremPct === null ? text : null);

    return {
        text,
        isFree: false,
        adValoremPct,
        specificRateText,
        isCompound: adValoremPct !== null && specificRateText !== null,
        isAdValoremOnly: adValoremPct !== null && specificRateText === null,
    };
}

/**
 * Parse the Special column into one entry per program code.
 *
 * Two shapes that a single naive regex gets wrong:
 *   * Segments are not always space separated. Real HTS text includes
 *     "Free (A,AU,...)8.8¢/liter(JO)" with no gap before the next rate, so
 *     splitting on whitespace merges two different rates into one.
 *   * Some segments are cross references, not rates: "See 9822.04.15 (AU)"
 *     means the rate lives in another heading. Parsing that as a duty rate
 *     would publish a rate of null and imply no preference exists, when in
 *     fact one does and it is simply stated elsewhere.
 *   * Code lists are wrapped with stray spaces ("BH, CL,CO,D") from the print
 *     layout, so codes are trimmed individually.
 */
export function parseSpecial(raw) {
    const text = stripMarkup(raw);
    if (!text) return [];

    const out = [];
    const segment = /([^()]+?)\(([^()]*)\)/g;
    for (const m of text.matchAll(segment)) {
        const rateText = m[1].trim().replace(/^[,;]\s*/, '');
        const codes = m[2].split(',').map((c) => c.trim()).filter(Boolean);
        if (!codes.length) continue;

        const crossRef = /^see\b/i.test(rateText);
        const referencedHeadings = crossRef
            ? (rateText.match(/\d{4}\.\d{2}\.\d{2}(?:\s*-\s*\d{4}\.\d{2}\.\d{2})?/g) ?? [])
            : [];
        const parsed = crossRef ? null : parseRate(rateText);

        for (const code of codes) {
            out.push({
                programCode: code,
                programName: SPI_PROGRAMS[code] ?? null,
                rateText: rateText || null,
                /* A cross reference has no rate of its own. Null here means
                 * "stated in another heading", never "duty free". */
                adValoremPct: parsed ? parsed.adValoremPct : null,
                isFree: parsed ? parsed.isFree : false,
                specificRateText: parsed ? parsed.specificRateText : null,
                isCompound: parsed ? parsed.isCompound : false,
                isCrossReference: crossRef,
                referencedHeadings,
                requiresActiveAuthorization: RENEWAL_DEPENDENT.has(code),
            });
        }
    }
    return out;
}

/**
 * Attach ancestry to a flat exportList response.
 *
 * The USITC returns one heading as an indent-ordered document, and two facts
 * only exist in that ordering:
 *
 *   1. Duty rates are published at the 8-digit subheading. The 10-digit
 *      statistical lines below it carry EMPTY rate cells and inherit from the
 *      nearest ancestor that has one. Reading a 10-digit line on its own -- the
 *      exact line an importer types in -- therefore reports no duty rate at all
 *      for the majority of the tariff schedule.
 *   2. Descriptions are hierarchical. Line 8541.10.00.80 reads "Other", which
 *      is meaningless without the chain above it. The legal description is the
 *      full path.
 *
 * Rows with an empty htsno are pure grouping headers ("Other:", "Transistors,
 * other than photosensitive transistors:"). They carry description context and
 * must be walked, but they are not tariff lines and are never emitted.
 */
export function buildTree(rows) {
    const stack = [];
    return rows.map((row) => {
        const indent = Number(row.indent);
        const level = Number.isFinite(indent) ? indent : 0;
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();

        const description = stripMarkup(row.description);
        const ancestors = stack.slice();

        const general = parseRate(row.general);
        const other = parseRate(row.other);

        /* Walk up for the nearest ancestor that actually states a rate. The
         * inherited flag travels with the row so a buyer can tell a rate read
         * off this line from one resolved off its parent. */
        let generalSource = general.text ? 'own' : null;
        let generalFrom = null;
        let resolvedGeneral = general;
        let resolvedOther = other;
        let otherSource = other.text ? 'own' : null;
        let otherFrom = null;

        if (!general.text) {
            for (let i = ancestors.length - 1; i >= 0; i -= 1) {
                if (ancestors[i].general.text) {
                    resolvedGeneral = ancestors[i].general;
                    generalSource = 'inherited';
                    generalFrom = ancestors[i].htsno;
                    break;
                }
            }
        }
        if (!other.text) {
            for (let i = ancestors.length - 1; i >= 0; i -= 1) {
                if (ancestors[i].other.text) {
                    resolvedOther = ancestors[i].other;
                    otherSource = 'inherited';
                    otherFrom = ancestors[i].htsno;
                    break;
                }
            }
        }

        let special = parseSpecial(row.special);
        let specialSource = special.length ? 'own' : null;
        let specialFrom = null;
        if (!special.length) {
            for (let i = ancestors.length - 1; i >= 0; i -= 1) {
                if (ancestors[i].special.length) {
                    special = ancestors[i].special;
                    specialSource = 'inherited';
                    specialFrom = ancestors[i].htsno;
                    break;
                }
            }
        }

        const node = {
            htsno: row.htsno || null,
            level,
            description,
            descriptionPath: [...ancestors.map((a) => a.description), description]
                .filter(Boolean),
            units: Array.isArray(row.units) && row.units.length ? row.units : null,
            footnotes: Array.isArray(row.footnotes) && row.footnotes.length
                ? row.footnotes : null,
            general,
            other,
            special,
            resolvedGeneral,
            generalSource,
            generalFrom,
            resolvedOther,
            otherSource,
            otherFrom,
            resolvedSpecial: special,
            specialSource,
            specialFrom,
        };
        stack.push(node);
        return node;
    });
}
