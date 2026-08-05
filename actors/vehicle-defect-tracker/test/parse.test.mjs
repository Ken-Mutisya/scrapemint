// Parser tests against the real shapes seen in the live NHTSA API.
import {
    parseComplaintDate, parseRecallDate, daysBetween, variantsFor, dedupeComplaints,
    splitComplaintComponents, topLevelComponent, severityOf, meetsSeverity,
    intOrNull, componentTrends,
} from '../src/nhtsa.js';

let fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got); const w = JSON.stringify(want);
    if (g !== w) { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fail++; }
    else console.log(`ok   ${name}`);
};

// --- the two date orders in one API ---
eq('complaint date is MM/DD/YYYY', parseComplaintDate('02/20/2026'), '2026-02-20');
eq('recall date is DD/MM/YYYY', parseRecallDate('17/12/2020'), '2020-12-17');
eq('the ambiguous case resolves differently per endpoint',
    [parseComplaintDate('10/11/2021'), parseRecallDate('10/11/2021')],
    ['2021-10-11', '2021-11-10']);
eq('impossible month rejected rather than guessed', parseComplaintDate('17/12/2020'), null);
eq('iso passes through', parseComplaintDate('2021-05-06T00:00:00'), '2021-05-06');
eq('empty date is null', parseComplaintDate(''), null);
eq('garbage date is null', parseComplaintDate('n/a'), null);
eq('epoch sentinel is absent, not 1969', parseComplaintDate('12/31/1969'), null);
eq('other epoch sentinel too', parseComplaintDate('01/01/1970'), null);
eq('a real 1969 recall date is still refused as a sentinel', parseRecallDate('31/12/1969'), null);
eq('an ordinary old date survives', parseComplaintDate('06/15/1985'), '1985-06-15');

// --- filing lag ---
eq('lag in days', daysBetween('2026-02-20', '2026-07-29'), 159);
eq('same day lag is zero, not null', daysBetween('2026-02-20', '2026-02-20'), 0);
eq('missing side gives null lag', daysBetween(null, '2026-07-29'), null);

// --- model variants, deduped, from the real F-150 list ---
const fordModels = [
    'F-150 REGULAR CAB', 'F-150 SUPER CAB', 'F-150 SUPER CREW', 'F-150 SUPER CAB DIESEL',
    'F-150 SUPER CREW DIESEL', 'F-150 REGULAR CAB', 'F-150 SUPER CAB', 'F-150 SUPER CREW',
    'F-150 SUPER CAB DIESEL', 'F-150 SUPER CREW DIESEL', 'F-150 SUPER CREW HEV',
    'F-150 SUPER CREW HEV', 'EXPLORER', 'F-250 SUPER DUTY',
];
eq('variants deduped and scoped to the model', variantsFor(fordModels, 'F-150'),
    ['F-150 REGULAR CAB', 'F-150 SUPER CAB', 'F-150 SUPER CREW', 'F-150 SUPER CAB DIESEL',
        'F-150 SUPER CREW DIESEL', 'F-150 SUPER CREW HEV']);
eq('F-250 is not an F-150 variant', variantsFor(fordModels, 'F-150').includes('F-250 SUPER DUTY'), false);
eq('exact match is its own variant', variantsFor(fordModels, 'Explorer'), ['EXPLORER']);
eq('unknown model has no variants', variantsFor(fordModels, 'Mustang'), []);

// --- the dedupe that stops a 4x overcount ---
const shared = { odiNumber: 1, components: 'POWER TRAIN', crash: false, fire: false, numberOfInjuries: 0, numberOfDeaths: 0 };
const batches = [
    { model: 'F-150 REGULAR CAB', results: [shared, { ...shared, odiNumber: 2 }] },
    { model: 'F-150 SUPER CAB', results: [shared, { ...shared, odiNumber: 2 }] },
    { model: 'F-150 SUPER CREW', results: [shared, { ...shared, odiNumber: 3 }] },
];
const deduped = dedupeComplaints(batches);
eq('six rows across variants collapse to three complaints', deduped.length, 3);
eq('a complaint records every variant it appeared under',
    deduped.find((d) => d.complaint.odiNumber === 1).variants,
    ['F-150 REGULAR CAB', 'F-150 SUPER CAB', 'F-150 SUPER CREW']);
eq('a variant-specific complaint records only its own',
    deduped.find((d) => d.complaint.odiNumber === 3).variants, ['F-150 SUPER CREW']);
eq('complaints with no ODI number are dropped',
    dedupeComplaints([{ model: 'X', results: [{ components: 'ENGINE' }] }]).length, 0);

// --- components ---
eq('complaint components split on commas',
    splitComplaintComponents('POWER TRAIN, ELECTRICAL SYSTEM'), ['POWER TRAIN', 'ELECTRICAL SYSTEM']);
eq('recall component hierarchy reduced to its top level',
    topLevelComponent('POWER TRAIN:DRIVELINE:DRIVESHAFT'), 'POWER TRAIN');
eq('flat recall component unchanged', topLevelComponent('ENGINE'), 'ENGINE');
eq('empty component is null', topLevelComponent(''), null);

// --- severity ---
eq('death outranks all', severityOf({ numberOfDeaths: 1, numberOfInjuries: 2, crash: true, fire: true }), 'fatal');
eq('injury outranks fire', severityOf({ numberOfDeaths: 0, numberOfInjuries: 1, fire: true }), 'injury');
eq('fire outranks crash', severityOf({ numberOfDeaths: 0, numberOfInjuries: 0, fire: true, crash: true }), 'fire');
eq('crash alone', severityOf({ numberOfDeaths: 0, numberOfInjuries: 0, crash: true }), 'crash');
eq('zero counts mean none, a real finding', severityOf({ numberOfDeaths: 0, numberOfInjuries: 0, crash: false, fire: false }), 'none');
eq('severity floor: crashOrFire admits a crash', meetsSeverity('crash', 'crashOrFire'), true);
eq('severity floor: crashOrFire rejects none', meetsSeverity('none', 'crashOrFire'), false);
eq('severity floor: injuryOrDeath rejects a crash', meetsSeverity('crash', 'injuryOrDeath'), false);
eq('severity floor: all admits none', meetsSeverity('none', 'all'), true);

// --- integers ---
eq('zero stays zero', intOrNull(0), 0);
eq('absent stays null, never zero', intOrNull(null), null);
eq('empty string is null', intOrNull(''), null);

// --- component trends and the recall gap ---
const rows = [
    { components: ['POWER TRAIN'], crash: true, fire: false, numberOfInjuries: 0, numberOfDeaths: 0, dateOfIncident: '2024-03-01' },
    { components: ['POWER TRAIN'], crash: false, fire: false, numberOfInjuries: 2, numberOfDeaths: 0, dateOfIncident: '2023-01-15' },
    { components: ['ENGINE'], crash: false, fire: true, numberOfInjuries: 0, numberOfDeaths: 1, dateOfIncident: '2025-06-30' },
];
const recalls = [{ campaignNumber: '21V986000', component: 'POWER TRAIN:DRIVELINE:DRIVESHAFT' }];
const trends = componentTrends(rows, recalls);
eq('trends sorted by complaint count', trends.map((t) => t.component), ['POWER TRAIN', 'ENGINE']);
const pt = trends[0];
eq('power train totals', [pt.complaintCount, pt.crashCount, pt.injuryComplaintCount, pt.totalInjuries], [2, 1, 1, 2]);
eq('earliest and latest incident dates', [pt.firstIncidentDate, pt.latestIncidentDate], ['2023-01-15', '2024-03-01']);
eq('recall matched on top-level component', [pt.hasMatchingRecall, pt.unaddressedByRecall], [true, false]);
eq('matching campaign named', pt.matchingRecallCampaigns, ['21V986000']);
const eng = trends[1];
eq('engine has no recall, so it is the gap', [eng.hasMatchingRecall, eng.unaddressedByRecall], [false, true]);
eq('fatal engine complaint counted', [eng.deathComplaintCount, eng.totalDeaths, eng.fireCount], [1, 1, 1]);
eq('no recall campaigns is null not empty', eng.matchingRecallCampaigns, null);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
