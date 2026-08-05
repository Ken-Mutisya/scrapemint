// Parser tests against the real shapes seen in the live CROSS API.
import {
    codeDigits, toCrossFormat, toHtsFormat, looksLikeCode, normalizeTerm,
    rulingDate, yearFromPath, precedent, cleanText, absoluteUrl, rulingPageUrl,
} from '../src/cross.js';

let fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got); const w = JSON.stringify(want);
    if (g !== w) { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fail++; }
    else console.log(`ok   ${name}`);
};

// --- the format mismatch that decides whether a search returns anything ---
eq('CROSS groups ten digits 4.2.4', toCrossFormat('6109100040'), '6109.10.0040');
eq('HTS groups the same digits 4.2.2.2', toHtsFormat('6109100040'), '6109.10.00.40');
eq('HTS form is converted to CROSS form', normalizeTerm('6109.10.00.40'), '6109.10.0040');
eq('digits-only is converted too', normalizeTerm('6109100040'), '6109.10.0040');
eq('CROSS form passes through unchanged', normalizeTerm('6109.10.0040'), '6109.10.0040');
eq('eight digits agree in both systems', [toCrossFormat('61091000'), toHtsFormat('61091000')], ['6109.10.00', '6109.10.00']);
eq('six digits', toCrossFormat('610910'), '6109.10');
eq('four digits', toCrossFormat('6109'), '6109');

// A product name must never be reformatted.
eq('product name is not a code', looksLikeCode('integrated solar panel'), false);
eq('product name passes through', normalizeTerm('integrated solar panel'), 'integrated solar panel');
eq('code is a code', looksLikeCode('6109.10.0040'), true);
eq('short number is not a code', looksLikeCode('12'), false);
eq('alphanumeric ruling number is not a code', looksLikeCode('N160415'), false);

// --- missing dates ---
eq('real date kept', rulingDate('2011-05-06T00:00:00'), '2011-05-06');
eq('0001 sentinel becomes null', rulingDate('0001-01-01T00:00:00'), null);
eq('empty becomes null', rulingDate(''), null);
eq('year recovered from document path', yearFromPath('/docs/hq/2002/w964711.doc'), 2002);
eq('no year in path', yearFromPath('/docs/hq/w964711.doc'), null);

// --- precedent status, the reason this actor exists ---
const revoked = precedent({ rulingNumber: 'K88339', revokedBy: ['W967655'], modifiedBy: [], revokes: [], modifies: [], operationallyRevoked: false });
eq('revokedBy marks it revoked', [revoked.precedentStatus, revoked.isSuperseded], ['revoked', true]);
eq('supersededBy names the ruling', revoked.supersededBy, ['W967655']);

const opRevoked = precedent({ revokedBy: [], modifiedBy: [], operationallyRevoked: true });
eq('operationallyRevoked marks it revoked', opRevoked.precedentStatus, 'revoked');

const modified = precedent({ revokedBy: [], modifiedBy: ['H123456'], operationallyRevoked: false });
eq('modifiedBy marks it modified', [modified.precedentStatus, modified.isSuperseded], ['modified', true]);

const clean = precedent({ revokedBy: [], modifiedBy: [], revokes: ['20006'], modifies: [], operationallyRevoked: false });
eq('no recorded change', [clean.precedentStatus, clean.isSuperseded], ['noRecordedChange', false]);
eq('revoking others does not supersede this one', clean.supersededBy, null);
eq('revokes list preserved', clean.revokes, ['20006']);
eq('clean status is caveated, not called good law', /not the same as confirmation/.test(clean.precedentStatusNote), true);

// --- text and urls ---
eq('CR line endings and form feeds normalised', cleanText('\fN160415\t\t\r\rMay 6, 2011\r\r'), 'N160415\n\nMay 6, 2011');
eq('empty text becomes null', cleanText(''), null);
eq('relative doc path absolutised', absoluteUrl('/docs/ny/2011/n160415.doc'), 'https://rulings.cbp.gov/docs/ny/2011/n160415.doc');
eq('absolute url left alone', absoluteUrl('https://x.test/a.doc'), 'https://x.test/a.doc');
eq('ruling page url', rulingPageUrl('N160415'), 'https://rulings.cbp.gov/ruling/N160415');
eq('digits helper', codeDigits('6109.10.00.40'), '6109100040');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
