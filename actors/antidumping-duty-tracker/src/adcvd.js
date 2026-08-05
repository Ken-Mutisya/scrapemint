// Parsing and status derivation for AD/CVD proceedings.
//
// Split out of main.js because the lifecycle classification is the whole
// product. Commerce publishes proceedings as a stream of notices with no
// status field; whether an order is actually in force has to be derived, and
// getting the derivation wrong tells an importer that a live order is dead.

/**
 * Commerce case numbers are `{A|C}-{country}-{sequence}`, e.g. A-570-135.
 * A is antidumping, C is countervailing.
 */
const CASE_RE = /\b([AC])-(\d{3})-(\d{3})\b/g;

/**
 * Country code to country, derived from the data rather than assumed.
 *
 * Built by taking 3,000 International Trade Administration notices, keeping
 * only those with exactly one docket and one country in the title, and mapping
 * each case-number country segment to the most frequently observed name. The
 * handful of codes that showed more than one name were naming variants of the
 * same country ("Canada" / "the Republic of Canada", "Turkey" / "Türkiye")
 * plus about 1% mis-parses, which majority vote absorbs.
 *
 * This is a cross-check, never an override. The country stated in the notice
 * title is what Commerce published; this map only says whether the case number
 * agrees with it.
 */
export const CASE_COUNTRY_CODES = {
    122: 'Canada', 201: 'Mexico', 301: 'Colombia', 331: 'Ecuador', 337: 'Chile',
    351: 'Brazil', 357: 'Argentina', 403: 'Norway', 412: 'United Kingdom',
    421: 'Netherlands', 423: 'Belgium', 427: 'France', 428: 'Germany',
    433: 'Austria', 441: 'Switzerland', 455: 'Poland', 469: 'Spain',
    471: 'Portugal', 475: 'Italy', 484: 'Greece', 487: 'Bulgaria',
    489: 'Türkiye', 508: 'Israel', 517: 'Saudi Arabia', 518: 'Qatar',
    520: 'United Arab Emirates', 523: 'Oman', 525: 'Bahrain', 533: 'India',
    542: 'Sri Lanka', 546: 'Burma', 549: 'Thailand', 552: 'Vietnam',
    553: 'Laos', 555: 'Cambodia', 557: 'Malaysia', 560: 'Indonesia',
    565: 'Philippines', 570: 'China', 580: 'South Korea', 583: 'Taiwan',
    588: 'Japan', 602: 'Australia', 714: 'Morocco', 721: 'Algeria',
    729: 'Egypt', 762: 'Angola', 791: 'South Africa', 801: 'Serbia',
    803: 'Kosovo', 821: 'Russia', 823: 'Ukraine', 831: 'Armenia',
    834: 'Kazakhstan', 851: 'Czech Republic', 856: 'Slovenia',
};

/** Commerce writes the same country several ways across notices. */
const COUNTRY_ALIASES = [
    [/^people'?s republic of china$/i, 'China'],
    [/^republic of korea$/i, 'South Korea'],
    [/^korea$/i, 'South Korea'],
    [/^socialist republic of vietnam$/i, 'Vietnam'],
    [/^republic of t(?:ü|u)rkiye$/i, 'Türkiye'],
    [/^turkey$/i, 'Türkiye'],
    [/^federal republic of germany$/i, 'Germany'],
    [/^republic of (canada|germany|indonesia|india|armenia|kazakhstan|serbia)$/i, '$1'],
    [/^kingdom of (thailand|bahrain|cambodia|morocco|saudi arabia)$/i, '$1'],
    [/^lao people'?s democratic republic$/i, 'Laos'],
    [/^russian federation$/i, 'Russia'],
    [/^sultanate of oman$/i, 'Oman'],
    [/^socialist republic of vietnam administrative review$/i, 'Vietnam'],
];

/* The Federal Register escapes non-ASCII letters in square brackets rather than
 * as HTML entities, so "Türkiye" arrives as "T[uuml]rkiye". Left alone it makes
 * the same country look like two, and the case-number cross-check disagrees
 * with a title that is actually correct. */
const BRACKET_ENTITIES = {
    uuml: 'ü', ouml: 'ö', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê',
    ntilde: 'ñ', ccedil: 'ç', aacute: 'á', iacute: 'í', oacute: 'ó',
    uacute: 'ú', agrave: 'à', acirc: 'â', ocirc: 'ô', uuml_: 'ü', szlig: 'ß',
    aring: 'å', oslash: 'ø', ae: 'æ', amp: '&', deg: '°',
};

export function decodeEntities(raw) {
    return String(raw ?? '').replace(
        /\[([a-z]+)\]/gi,
        (whole, name) => BRACKET_ENTITIES[name.toLowerCase()] ?? whole,
    );
}

export function normalizeCountry(raw) {
    let s = decodeEntities(raw).replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
    if (!s) return null;
    /* Stripped before the alias table rather than as an entry in it: as a rule
     * it would match nearly every long-form name first, and the loop stops at
     * the first hit, so "the Socialist Republic of Vietnam" would come out as
     * "Socialist Republic of Vietnam" and never reach its own alias. */
    s = s.replace(/^the\s+/i, '').trim();
    for (const [re, to] of COUNTRY_ALIASES) {
        if (re.test(s)) { s = s.replace(re, to).trim(); break; }
    }
    if (!s) return null;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Every AD/CVD case number mentioned in a string, deduped and uppercased. */
export function extractCaseNumbers(text) {
    const out = [];
    const s = String(text ?? '').toUpperCase();
    for (const m of s.matchAll(CASE_RE)) {
        const id = `${m[1]}-${m[2]}-${m[3]}`;
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

/** `A-570-135` to its parts, or null when the string is not a case number. */
export function parseCaseNumber(caseNumber) {
    const m = String(caseNumber ?? '').toUpperCase().match(/^([AC])-(\d{3})-(\d{3})$/);
    if (!m) return null;
    return {
        caseNumber: `${m[1]}-${m[2]}-${m[3]}`,
        dutyType: m[1] === 'A' ? 'antidumping' : 'countervailing',
        countryCode: m[2],
        countryFromCaseNumber: CASE_COUNTRY_CODES[Number(m[2])] ?? null,
        sequence: m[3],
    };
}

/**
 * Split a notice title into the product and the countries it covers.
 *
 * Commerce titles read "{Product} From {Country}: {Action}". A single notice
 * can cover several countries at once ("From Chile, the People's Republic of
 * China, India, and Indonesia"), each of which is a separate case, so the
 * country side is always a list.
 */
export function parseTitle(title) {
    const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
    if (!t) return { product: null, countries: [], actionClause: null };

    /* Most titles separate the action with a colon, but the suspension
     * agreement notices use a semicolon ("... on Sugar From Mexico;
     * Preliminary Results ..."). Splitting on the colon alone swallows the
     * action clause into the country name. */
    const sep = t.search(/[:;]/);
    const head = sep === -1 ? t : t.slice(0, sep);
    const actionClause = sep === -1 ? null : t.slice(sep + 1).trim() || null;

    const m = head.match(/^(.*?)\s+[Ff]rom\s+(.+)$/);
    if (!m) {
        /* Commerce occasionally omits the country ("Forged Steel Fluid End
         * Blocks: Preliminary Results ..."). The head is still the product, so
         * returning null for both would throw away the half that is there. */
        return { product: head.trim() || null, countries: [], actionClause };
    }

    const product = m[1].trim() || null;
    const countries = m[2]
        .split(/,\s*(?:and\s+)?|\s+and\s+/)
        .map((c) => normalizeCountry(c))
        .filter(Boolean);

    return { product, countries, actionClause };
}

/**
 * Lifecycle stage of a notice.
 *
 * The distinction that matters most here is rescission versus revocation. In
 * this corpus rescission notices outnumber revocations roughly 17 to 1, and
 * they mean opposite things:
 *
 *   * "Rescission, in Part, of Antidumping Duty Administrative Review" ends a
 *     REVIEW. The order stays fully in force and duties keep being collected.
 *   * "Final Results of Sunset Review and Revocation of Antidumping Duty Order"
 *     ends the ORDER. Duties stop.
 *
 * A classifier that keys on the shared "resc/revo" shape, or that treats any
 * notice containing "revocation" as terminal, tells an importer that a live
 * order has ended. Order matters below: revocation is tested before rescission,
 * and "consideration of revocation" is not a revocation.
 */
export function classifyStage(title) {
    const t = String(title ?? '').toLowerCase();
    if (!t) return { stage: 'unknown', endsOrder: false, establishesOrder: false, changesRates: false };

    const mk = (stage, opts = {}) => ({
        stage,
        endsOrder: opts.endsOrder === true,
        establishesOrder: opts.establishesOrder === true,
        changesRates: opts.changesRates === true,
    });

    /* A changed-circumstances or sunset notice that merely *considers* or
     * *initiates* revocation has not revoked anything yet. */
    const consideringOnly = /(consideration|intent|initiation) of\b[^.]*\brevocation/.test(t)
        || /revocation.*\b(initiation|proposed)\b/.test(t);

    /* "Revocation ... in Part" narrows an order -- it drops particular products
     * or exporters and leaves the order standing for everything else. In this
     * corpus 14 of 23 revocation notices are partial, so treating the word
     * "revocation" as terminal reports the majority of them as killing an order
     * that is still collecting duties. Same shape as rescission, one level
     * further in. */
    if (/\brevocation\b/.test(t) && /\bin part\b/.test(t) && !consideringOnly) {
        return mk('orderRevokedInPart');
    }
    if (/\brevocation\b/.test(t) && !consideringOnly) {
        return mk('orderRevoked', { endsOrder: true });
    }
    if (/\bcontinuation\b/.test(t)) return mk('orderContinued');
    if (/\b(antidumping|countervailing) duty order\b/.test(t)
        && /\b(notice of )?(amended )?(antidumping|countervailing) duty order/.test(t)
        && !/opportunity to request/.test(t)) {
        return mk('orderIssued', { establishesOrder: true });
    }

    /* Rescission of a review. Explicitly NOT an end to the order. */
    if (/\brescission\b/.test(t)) return mk('reviewRescinded');

    /* Tested before the review stages. A remand notice is titled "Court
     * Decision Not in Harmony With the Results of Administrative Review", so a
     * plain "administrative review" test upstream of this would swallow it and
     * report a court loss as a routine review. */
    if (/court decision not in harmony/.test(t)) return mk('courtRemand');

    if (/sunset review/.test(t)) return mk('sunsetReview');
    if (/administrative review/.test(t)) {
        return /final results/.test(t)
            ? mk('reviewFinalResults', { changesRates: true })
            : mk('reviewPreliminaryResults');
    }
    if (/\bnew shipper review\b/.test(t)) return mk('newShipperReview');
    if (/changed circumstances/.test(t)) return mk('changedCircumstancesReview');
    if (/scope ruling/.test(t)) return mk('scopeRuling');
    if (/circumvention/.test(t)) return mk('circumventionInquiry');
    if (/postponement/.test(t)) return mk('postponement');

    if (/final (affirmative|negative)? ?determination/.test(t) || /final determination/.test(t)) {
        return /final negative determination|negative final determination/.test(t)
            ? mk('finalDeterminationNegative')
            : mk('finalDetermination');
    }
    if (/preliminary .*determination/.test(t)) return mk('preliminaryDetermination');
    if (/\binitiation\b/.test(t)) return mk('investigationInitiated');
    if (/opportunity to request/.test(t)) return mk('reviewOpportunity');

    return mk('other');
}

/**
 * Notices that name many unrelated cases at once.
 *
 * Commerce publishes periodic omnibus notices -- scope ruling round-ups and the
 * monthly "Opportunity To Request Administrative Review" -- that list dozens of
 * case numbers and carry no docket of their own. They are a real part of a
 * case's paper trail, but they are not a determination ABOUT any one case, so
 * they must never drive a derived status: an omnibus notice mentioning a case
 * would otherwise read as that case having had a review.
 */
export function isOmnibus(doc) {
    const dockets = Array.isArray(doc?.docket_ids) ? doc.docket_ids : [];
    const title = String(doc?.title ?? '').toLowerCase();
    if (/opportunity to request administrative review/.test(title)) return true;
    if (/notice of scope ruling/.test(title)) return true;
    if (/scope ruling applications filed/.test(title)) return true;
    /* No docket and no "X From Y:" shape means the title is not about one
     * proceeding. */
    if (!dockets.length && !/\sfrom\s/i.test(title)) return true;
    return false;
}

const STATUS_PRECEDENCE = {
    orderRevoked: 'revoked',
    orderContinued: 'activeOrder',
    orderIssued: 'activeOrder',
    finalDeterminationNegative: 'terminatedNegative',
};
/* Stages that only happen while an order exists. They do not set the status on
 * their own, but they are evidence one was in force at that date. */
const IMPLIES_ACTIVE = new Set([
    'reviewFinalResults', 'reviewPreliminaryResults', 'reviewRescinded',
    'sunsetReview', 'newShipperReview', 'changedCircumstancesReview',
    /* A partial revocation narrows an order, which means there was one to
     * narrow and it survives for everything not carved out. */
    'orderRevokedInPart',
]);

/**
 * Derive where a case stands from its notices.
 *
 * Only case-specific notices count. The most recent status-setting notice wins,
 * because a case can be revoked and later replaced by a fresh order, or
 * continued after a sunset review.
 *
 * `activeOrderInferred` is kept separate from `activeOrder`: an administrative
 * review proves an order existed at the time, but inferring from it is weaker
 * evidence than an order notice, and a buyer deciding whether to import should
 * be able to tell those apart.
 */
/**
 * Which duty types a notice title acts on.
 *
 * A notice that names both the antidumping and countervailing case for the same
 * product still usually acts on one of them: "Revocation of Antidumping Duty
 * Order" is singular. When the title names exactly one duty type, a notice
 * listing several case numbers is unambiguous for the case of that type.
 */
export function titleDutyType(title) {
    const t = String(title ?? '').toLowerCase();
    const ad = /antidumping/.test(t);
    const cvd = /countervailing/.test(t);
    if (ad && cvd) return 'both';
    if (ad) return 'antidumping';
    if (cvd) return 'countervailing';
    return null;
}

export function deriveCaseStatus(notices, caseNumber = null) {
    const thisCase = parseCaseNumber(caseNumber);
    const caseSpecific = notices
        .filter((n) => n && n.isCaseSpecific && n.publicationDate)
        .sort((a, b) => (a.publicationDate < b.publicationDate ? -1 : 1));

    /* Commerce runs joint proceedings, so one notice can name several cases and
     * do different things to each: the same document can continue the order on
     * one country and revoke it on another. The title does not say which action
     * lands on which case. Status is therefore derived from notices about this
     * case alone, and a joint notice that disagrees is reported as a conflict
     * rather than silently overwriting the single-case answer -- otherwise a
     * revoked Taiwan order reads as active because a later China notice
     * mentioned it. */
    const isSingle = (n) => {
        if (!Array.isArray(n.caseNumbers) || n.caseNumbers.length <= 1) return true;
        /* A joint AD/CVD notice on one product names both case numbers, but if
         * the title acts on a single duty type it is unambiguous for the case
         * of that type. Without this, a revocation naming its own paired case
         * would be discarded and the order would keep reading as live. */
        const acts = titleDutyType(n.title);
        return Boolean(thisCase && acts && acts !== 'both' && acts === thisCase.dutyType);
    };
    const singles = caseSpecific.filter(isSingle);
    const usable = singles.length ? singles : caseSpecific;
    const multiOnly = singles.length ? caseSpecific.filter((n) => !isSingle(n)) : [];

    if (!usable.length) {
        return {
            currentStatus: 'unknown',
            statusConfidence: 'none',
            statusSetByDocument: null,
            statusSetByTitle: null,
            statusAsOf: null,
            orderIssuedDate: null,
            revokedDate: null,
            lastRateActionDate: null,
        };
    }

    let status = null;
    let setBy = null;
    let inferredActive = null;
    let orderIssuedDate = null;
    let revokedDate = null;
    let lastRateActionDate = null;

    for (const n of usable) {
        const mapped = STATUS_PRECEDENCE[n.stage];
        if (mapped) { status = mapped; setBy = n; }
        if (n.stage === 'orderIssued' && !orderIssuedDate) orderIssuedDate = n.publicationDate;
        if (n.stage === 'orderRevoked') revokedDate = n.publicationDate;
        if (n.changesRates) lastRateActionDate = n.publicationDate;
        if (IMPLIES_ACTIVE.has(n.stage)) inferredActive = n;
    }

    if (!status && inferredActive) {
        return {
            currentStatus: 'activeOrderInferred',
            statusConfidence: 'inferred',
            statusSetByDocument: inferredActive.documentNumber,
            statusSetByTitle: inferredActive.title,
            statusAsOf: inferredActive.publicationDate,
            orderIssuedDate,
            revokedDate,
            lastRateActionDate,
        };
    }
    if (!status) {
        const last = usable[usable.length - 1];
        const investigating = usable.some(
            (n) => n.stage === 'investigationInitiated' || n.stage === 'preliminaryDetermination',
        );
        return {
            currentStatus: investigating ? 'underInvestigation' : 'unknown',
            statusConfidence: investigating ? 'inferred' : 'none',
            statusSetByDocument: last.documentNumber,
            statusSetByTitle: last.title,
            statusAsOf: last.publicationDate,
            orderIssuedDate,
            revokedDate,
            lastRateActionDate,
        };
    }

    /* A joint notice published after the deciding one, pointing somewhere else.
     * Surfaced rather than resolved: which case it acted on is not knowable
     * from the title. */
    let conflict = null;
    for (const n of multiOnly) {
        const mapped = STATUS_PRECEDENCE[n.stage];
        if (mapped && mapped !== status && n.publicationDate > setBy.publicationDate) conflict = n;
    }

    return {
        currentStatus: status,
        statusConfidence: conflict ? 'conflicted' : 'stated',
        statusSetByDocument: setBy.documentNumber,
        statusSetByTitle: setBy.title,
        statusAsOf: setBy.publicationDate,
        conflictingNoticeDocument: conflict?.documentNumber ?? null,
        conflictingNoticeTitle: conflict?.title ?? null,
        conflictingNoticeDate: conflict?.publicationDate ?? null,
        orderIssuedDate,
        revokedDate,
        lastRateActionDate,
    };
}

/**
 * Which country's case this is.
 *
 * A joint notice lists every country in the proceeding, so taking the first one
 * attaches the wrong country to the case: A-583-853 is a Taiwan case, but its
 * notices are shared with China and "China" comes first in the title. The case
 * number's country segment says whose case it is, so a country matching it wins
 * over document order.
 */
export function pickCaseCountry(notices, countryFromCaseNumber) {
    const seen = [];
    for (const n of notices) {
        for (const c of (n.countries ?? [])) if (!seen.includes(c)) seen.push(c);
    }
    if (countryFromCaseNumber) {
        const match = seen.find(
            (c) => c.toLowerCase() === countryFromCaseNumber.toLowerCase(),
        );
        if (match) return match;
        /* The case number is the more reliable signal when the titles never
         * name its country, which happens on joint notices. */
        if (seen.length) return countryFromCaseNumber;
    }
    return seen[0] ?? countryFromCaseNumber ?? null;
}

export const STATUS_NOTES = {
    activeOrder: 'A Commerce notice issued or continued this order and nothing later revoked it. '
        + 'Duties apply to subject merchandise.',
    activeOrderInferred: 'No order notice was found in range, but Commerce ran reviews on this case, '
        + 'which only happens while an order is in force. Widen the date range to find the order itself.',
    revoked: 'Commerce revoked this order. Duties no longer apply from the effective date in the notice, '
        + 'which can differ from the publication date.',
    terminatedNegative: 'The investigation ended in a negative determination, so no order was issued.',
    underInvestigation: 'An investigation is open. No order yet, but one may follow and can apply '
        + 'retroactively to entries made during the investigation.',
    unknown: 'Not enough case-specific notices in range to say. Widen the date range.',
};
