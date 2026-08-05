// Parser tests against real Federal Register notice titles.
import {
    extractCaseNumbers, parseCaseNumber, parseTitle, classifyStage, isOmnibus,
    deriveCaseStatus, normalizeCountry, decodeEntities, titleDutyType, pickCaseCountry,
} from '../src/adcvd.js';

let fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got); const w = JSON.stringify(want);
    if (g !== w) { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fail++; }
    else console.log(`ok   ${name}`);
};
const stage = (t) => classifyStage(t).stage;

// --- the distinction the whole actor turns on ---
eq('rescission of a review does NOT end the order',
    classifyStage('Hydrofluorocarbon Blends From the People\'s Republic of China: Preliminary Results and Rescission, in Part, of Antidumping Duty Administrative Review'),
    { stage: 'reviewRescinded', endsOrder: false, establishesOrder: false, changesRates: false });
eq('revocation DOES end the order',
    classifyStage('Barium Carbonate From the People\'s Republic of China: Final Results of Sunset Review and Revocation of Antidumping Duty Order'),
    { stage: 'orderRevoked', endsOrder: true, establishesOrder: false, changesRates: false });
eq('merely considering revocation is not revocation',
    stage('Notice of Initiation of Changed Circumstances Reviews, and Consideration of Revocation of the Antidumping and Countervailing Duty Orders'),
    'changedCircumstancesReview');

// --- other lifecycle stages, all from real titles ---
eq('order issued', stage('Lattice Boom Crawler Cranes From Japan: Antidumping Duty Order'), 'orderIssued');
eq('continuation', stage('Certain Crepe Paper Products From the People\'s Republic of China: Continuation of Antidumping Duty Order'), 'orderContinued');
eq('review final results sets rates', classifyStage('Certain Steel Nails From Taiwan: Final Results of Antidumping Duty Administrative Review').changesRates, true);
eq('review preliminary results does not set rates', classifyStage('Certain Steel Nails From Taiwan: Preliminary Results of Antidumping Duty Administrative Review').changesRates, false);
eq('initiation', stage('Certain Fatty Acids From Indonesia: Initiation of Less-Than-Fair-Value Investigations'), 'investigationInitiated');
eq('preliminary determination', stage('Van-Type Trailers From Mexico: Preliminary Affirmative Determination of Sales at Less Than Fair Value'), 'preliminaryDetermination');
eq('sunset review', stage('Polyethylene Retail Carrier Bags From Thailand: Final Results of the Expedited Sunset Review'), 'sunsetReview');
eq('court remand', stage('Certain Pasta From Italy: Notice of Court Decision Not in Harmony With the Results of Administrative Review'), 'courtRemand');
eq('postponement', stage('Oleoresin Paprika From India: Postponement of Preliminary Determination'), 'postponement');
eq('unknown title', stage(''), 'unknown');

// --- title parsing ---
eq('product and country split',
    parseTitle('Lattice Boom Crawler Cranes From Japan: Antidumping Duty Order'),
    { product: 'Lattice Boom Crawler Cranes', countries: ['Japan'], actionClause: 'Antidumping Duty Order' });
eq('multi-country notice yields every country',
    parseTitle('Certain Preserved Mushrooms From Chile, the People\'s Republic of China, India, and Indonesia: Continuation of Antidumping Duty Orders').countries,
    ['Chile', 'China', 'India', 'Indonesia']);
eq('title with no colon still parses', parseTitle('Certain Widgets From Japan').actionClause, null);
eq('semicolon separates the action too',
    parseTitle('Agreement Suspending the Countervailing Duty Investigation on Sugar From Mexico; Preliminary Results of the 2023 Administrative Review'),
    { product: 'Agreement Suspending the Countervailing Duty Investigation on Sugar', countries: ['Mexico'], actionClause: 'Preliminary Results of the 2023 Administrative Review' });
eq('a title with no country still yields the product',
    parseTitle('Forged Steel Fluid End Blocks: Preliminary Results of Antidumping Duty Administrative Review; 2024'),
    { product: 'Forged Steel Fluid End Blocks', countries: [], actionClause: 'Preliminary Results of Antidumping Duty Administrative Review; 2024' });
eq('bracket-escaped umlaut decoded', decodeEntities('Republic of T[uuml]rkiye'), 'Republic of Türkiye');
eq('escaped country normalises to the same name', normalizeCountry('the Republic of T[uuml]rkiye'), 'Türkiye');
eq('unknown bracket token left alone', decodeEntities('Widgets [notanentity] Here'), 'Widgets [notanentity] Here');

// --- country normalisation ---
eq('PRC normalised', normalizeCountry("the People's Republic of China"), 'China');
eq('Korea normalised', normalizeCountry('the Republic of Korea'), 'South Korea');
eq('Vietnam normalised', normalizeCountry('the Socialist Republic of Vietnam'), 'Vietnam');
eq('Turkiye normalised', normalizeCountry('the Republic of Türkiye'), 'Türkiye');

// --- case numbers ---
eq('case number parsed', parseCaseNumber('A-570-135'), { caseNumber: 'A-570-135', dutyType: 'antidumping', countryCode: '570', countryFromCaseNumber: 'China', sequence: '135' });
eq('C prefix is countervailing', parseCaseNumber('C-560-849').dutyType, 'countervailing');
eq('bad case number rejected', parseCaseNumber('570-135'), null);
eq('case numbers extracted from text', extractCaseNumbers('covers A-570-135 and C-570-946 and A-570-135'), ['A-570-135', 'C-570-946']);

// --- omnibus detection ---
eq('opportunity notice is omnibus', isOmnibus({ title: 'Antidumping or Countervailing Duty Order, Finding, or Suspended Investigation; Opportunity To Request Administrative Review', docket_ids: [] }), true);
eq('scope ruling list is omnibus', isOmnibus({ title: 'Notice of Scope Rulings', docket_ids: [] }), true);
eq('normal notice is not omnibus', isOmnibus({ title: 'Lattice Boom Crawler Cranes From Japan: Antidumping Duty Order', docket_ids: ['A-588-877'] }), false);

// --- status derivation ---
const n = (date, st, extra = {}) => ({
    isCaseSpecific: true, publicationDate: date, stage: st, documentNumber: `D${date}`,
    title: `${st} ${date}`, changesRates: extra.changesRates === true,
});
eq('order then reviews is an active order',
    deriveCaseStatus([n('2020-01-01', 'orderIssued'), n('2022-01-01', 'reviewFinalResults', { changesRates: true })]).currentStatus,
    'activeOrder');
eq('revocation after an order wins',
    deriveCaseStatus([n('2020-01-01', 'orderIssued'), n('2024-01-01', 'orderRevoked')]).currentStatus,
    'revoked');
eq('a later order revives a revoked case',
    deriveCaseStatus([n('2000-01-01', 'orderRevoked'), n('2020-01-01', 'orderIssued')]).currentStatus,
    'activeOrder');
eq('rescission never ends the order',
    deriveCaseStatus([n('2020-01-01', 'orderIssued'), n('2024-01-01', 'reviewRescinded')]).currentStatus,
    'activeOrder');
eq('reviews alone infer an order rather than state one',
    deriveCaseStatus([n('2022-01-01', 'reviewFinalResults', { changesRates: true })]),
    { currentStatus: 'activeOrderInferred', statusConfidence: 'inferred', statusSetByDocument: 'D2022-01-01', statusSetByTitle: 'reviewFinalResults 2022-01-01', statusAsOf: '2022-01-01', orderIssuedDate: null, revokedDate: null, lastRateActionDate: '2022-01-01' });
eq('initiation alone is under investigation',
    deriveCaseStatus([n('2026-01-01', 'investigationInitiated')]).currentStatus, 'underInvestigation');
eq('negative determination terminates',
    deriveCaseStatus([n('2020-01-01', 'investigationInitiated'), n('2021-01-01', 'finalDeterminationNegative')]).currentStatus,
    'terminatedNegative');
eq('omnibus notices cannot set status',
    deriveCaseStatus([{ isCaseSpecific: false, publicationDate: '2024-01-01', stage: 'orderRevoked', documentNumber: 'X', title: 'omnibus' }]).currentStatus,
    'unknown');
eq('no notices is unknown, not active', deriveCaseStatus([]).currentStatus, 'unknown');
eq('rate action date tracked',
    deriveCaseStatus([n('2020-01-01', 'orderIssued'), n('2023-06-01', 'reviewFinalResults', { changesRates: true })]).lastRateActionDate,
    '2023-06-01');

// --- partial revocation: 14 of 23 revocation notices in the corpus, and none
// --- of them end the order.
eq('revocation in part does NOT end the order',
    classifyStage("Crystalline Silicon Photovoltaic Cells From the People's Republic of China: Final Results of Changed Circumstances Reviews, and Revocation of the Antidumping and Countervailing Duty Orders, in Part"),
    { stage: 'orderRevokedInPart', endsOrder: false, establishesOrder: false, changesRates: false });
eq('full revocation still ends the order',
    classifyStage('Barium Carbonate From China: Final Results of Sunset Review and Revocation of Antidumping Duty Order').endsOrder,
    true);
eq('partial revocation leaves the order active',
    deriveCaseStatus([n('2015-01-01', 'orderIssued'), n('2025-12-19', 'orderRevokedInPart')]).currentStatus,
    'activeOrder');
eq('partial revocation alone implies an order exists',
    deriveCaseStatus([n('2025-12-19', 'orderRevokedInPart')]).currentStatus,
    'activeOrderInferred');

// --- joint AD/CVD notices ---
eq('title naming one duty type is attributable',
    titleDutyType('Widgets From China: Revocation of Antidumping Duty Order'), 'antidumping');
eq('title naming both is ambiguous',
    titleDutyType('Widgets From China: Revocation of the Antidumping and Countervailing Duty Orders'), 'both');
const joint = deriveCaseStatus([
    { ...n('2015-01-01', 'orderIssued'), caseNumbers: ['A-570-979'] },
    { ...n('2025-12-19', 'orderRevoked'), caseNumbers: ['A-570-979', 'C-570-980'], title: 'Widgets From China: Revocation of the Antidumping and Countervailing Duty Orders' },
], 'A-570-979');
eq('a joint notice disagreeing is reported as a conflict, not applied',
    [joint.currentStatus, joint.statusConfidence, joint.conflictingNoticeDate],
    ['activeOrder', 'conflicted', '2025-12-19']);
const soleDuty = deriveCaseStatus([
    { ...n('2015-01-01', 'orderIssued'), caseNumbers: ['A-570-979'] },
    { ...n('2025-12-19', 'orderRevoked'), caseNumbers: ['A-570-979', 'C-570-980'], title: 'Widgets From China: Revocation of Antidumping Duty Order' },
], 'A-570-979');
eq('a joint notice naming only this duty type does apply',
    [soleDuty.currentStatus, soleDuty.statusConfidence], ['revoked', 'stated']);

// --- case country picking ---
eq('case-number country beats document order on joint notices',
    pickCaseCountry([{ countries: ['China', 'Taiwan'] }], 'Taiwan'), 'Taiwan');
eq('falls back to the observed country when the code is unknown',
    pickCaseCountry([{ countries: ['Japan'] }], null), 'Japan');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
