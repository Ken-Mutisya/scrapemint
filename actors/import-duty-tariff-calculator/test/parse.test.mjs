// Parser tests against the real shapes seen in the live HTS.
import { parseRate, parseSpecial, buildTree, formatCode, normalizeCode }
    from '../src/hts.js';

let fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got); const w = JSON.stringify(want);
    if (g !== w) { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fail++; }
    else console.log(`ok   ${name}`);
};

// --- parseRate ---
eq('free', pick(parseRate('Free')), { adValoremPct: 0, isFree: true, specificRateText: null, isCompound: false });
eq('empty is unknown not zero', pick(parseRate('')), { adValoremPct: null, isFree: false, specificRateText: null, isCompound: false });
eq('simple pct', pick(parseRate('16.5%')), { adValoremPct: 16.5, isFree: false, specificRateText: null, isCompound: false });
eq('compound', pick(parseRate('90¢/pr. + 37.5%')), { adValoremPct: 37.5, isFree: false, specificRateText: '90¢/pr.', isCompound: true });
eq('specific only has NO ad valorem', pick(parseRate('3.9¢/kg')), { adValoremPct: null, isFree: false, specificRateText: '3.9¢/kg', isCompound: false });
eq('cents per liter', pick(parseRate('8.8¢/liter')), { adValoremPct: null, isFree: false, specificRateText: '8.8¢/liter', isCompound: false });

// --- parseSpecial ---
const spaced = parseSpecial('Free (AU,BH, CL,CO,D,E,IL, JO,KR,MA, OM,P,PA, PE,R,S,SG)');
eq('spaced codes trimmed', spaced.map((s) => s.programCode).join(','), 'AU,BH,CL,CO,D,E,IL,JO,KR,MA,OM,P,PA,PE,R,S,SG');
eq('spaced all free', spaced.every((s) => s.isFree && s.adValoremPct === 0), true);

// No separator between segments -- the real 2204.10.00 cell.
const noSep = parseSpecial('Free (A,AU,BH,CL,CO,D,E,IL,KR,MA,OM,P,PA,PE,S,SG)8.8¢/liter(JO)');
eq('no-separator segment count', noSep.length, 17);
eq('JO parsed as its own rate', pick2(noSep.find((s) => s.programCode === 'JO')), { adValoremPct: null, isFree: false, specificRateText: '8.8¢/liter' });
eq('AU still free', noSep.find((s) => s.programCode === 'AU').isFree, true);

// Cross references state no rate of their own.
const xref = parseSpecial('Free (BH,CL,CO,JO,KR,MA,OM,P,PA,PE,SG) See 9822.04.15 (AU) See 9823.02.01-9823.02.04 (S+) See 9908.04.03 (IL)');
const au = xref.find((s) => s.programCode === 'AU');
eq('AU is a cross reference', [au.isCrossReference, au.isFree, au.adValoremPct], [true, false, null]);
eq('AU referenced heading', au.referencedHeadings, ['9822.04.15']);
eq('S+ range captured', xref.find((s) => s.programCode === 'S+').referencedHeadings, ['9823.02.01-9823.02.04']);
eq('BH still a real free rate', xref.find((s) => s.programCode === 'BH').isFree, true);
eq('GSP flagged renewal-dependent', parseSpecial('Free (A)')[0].requiresActiveAuthorization, true);
eq('KR not renewal-dependent', parseSpecial('Free (KR)')[0].requiresActiveAuthorization, false);

// --- codes ---
eq('normalize', normalizeCode('8541.43.00.10'), '8541430010');
eq('format 10', formatCode('8541430010'), '8541.43.00.10');
eq('format 8', formatCode('85414300'), '8541.43.00');

// --- buildTree inheritance, against the real 8541 shape ---
const rows = [
    { htsno: '8541', indent: '0', description: 'Semiconductor devices', general: '', other: '', special: '' },
    { htsno: '8541.10.00', indent: '1', description: 'Diodes', general: 'Free', other: '35%', special: 'Free (AU)' },
    { htsno: '', indent: '2', description: 'Other:', general: '', other: '', special: '' },
    { htsno: '8541.10.00.80', indent: '3', description: 'Other', general: '', other: '', special: '' },
];
const tree = buildTree(rows);
const leaf = tree[3];
eq('leaf inherits general', [leaf.resolvedGeneral.text, leaf.generalSource, leaf.generalFrom], ['Free', 'inherited', '8541.10.00']);
eq('leaf inherits column 2', [leaf.resolvedOther.text, leaf.otherSource], ['35%', 'inherited']);
eq('leaf inherits special', [leaf.resolvedSpecial[0].programCode, leaf.specialSource], ['AU', 'inherited']);
eq('description path walks header rows', leaf.descriptionPath, ['Semiconductor devices', 'Diodes', 'Other:', 'Other']);
eq('own rate is not marked inherited', [tree[1].generalSource, tree[1].generalFrom], ['own', null]);
eq('header row keeps null htsno', tree[2].htsno, null);

function pick(r) { return { adValoremPct: r.adValoremPct, isFree: r.isFree, specificRateText: r.specificRateText, isCompound: r.isCompound }; }
function pick2(r) { return { adValoremPct: r.adValoremPct, isFree: r.isFree, specificRateText: r.specificRateText }; }

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
