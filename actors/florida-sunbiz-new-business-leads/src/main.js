// Florida Sunbiz New Business Leads
//
// Strategy
// --------
// The Florida Division of Corporations (Sunbiz) publishes a daily file of every
// new corporate filing on its public SFTP server (sftp.floridados.gov, user
// "Public", password published on dos.fl.gov). Files live in /Public/doc/cor
// and are named YYYYMMDDc.txt (processing date). Each line is a fixed-width
// 1,440-character record: document number, name, status, filing type,
// principal and mailing address, file date, FEI/EIN, registered agent and up
// to six officers / managers. About 1,000-4,000 filings per business day.
//
// We download the latest N daily files, parse them and filter by entity type,
// city, ZIP, name keyword and agent type. No API key, no browser, no proxy.
//
// Pay per event
// -------------
//   filing ($0.002) per business row. The first FREE_TIER_ROWS rows of every
//   run are free. Notes are free.

import { Actor, log } from 'apify';
import Client from 'ssh2-sftp-client';

const FREE_TIER_ROWS = 1;
const SFTP = { host: 'sftp.floridados.gov', port: 22, username: 'Public', password: 'PubAccess1845!', readyTimeout: 30000 };
const DIR = '/Public/doc/cor';

const TYPES = {
    FLAL: ['llc', 'Florida LLC'],
    DOMP: ['corporation', 'Florida profit corporation'],
    DOMNP: ['nonprofit', 'Florida nonprofit corporation'],
    DOMLP: ['limited_partnership', 'Florida limited partnership'],
    FORL: ['foreign_llc', 'Foreign LLC'],
    FORP: ['foreign_corporation', 'Foreign profit corporation'],
    FORNP: ['foreign_nonprofit', 'Foreign nonprofit corporation'],
    FORLP: ['foreign_limited_partnership', 'Foreign limited partnership'],
    TRUST: ['trust', 'Declaration of trust'],
    AGENT: ['agent', 'Registered agent designation'],
};
const TITLES = {
    P: 'President', VP: 'Vice President', S: 'Secretary', T: 'Treasurer', D: 'Director', C: 'Chairman', CEO: 'CEO', CFO: 'CFO', COO: 'COO',
    MGR: 'Manager', MGRM: 'Managing Member', AMBR: 'Authorized Member', MBR: 'Member', AR: 'Authorized Representative', AP: 'Authorized Person',
    PRES: 'President', SECR: 'Secretary', TREA: 'Treasurer', DIR: 'Director', GP: 'General Partner', TRUS: 'Trustee', OWNE: 'Owner',
};
// Common registered-agent services: their address is not the business's.
const AGENT_SERVICE = /REGISTERED AGENT|CORPORATION SERVICE|\bC T CORPORATION|INCORP SERVICES|LEGALINC|NORTHWEST|UNITED STATES CORPORATION AGENTS|REGISTERED AGENTS INC|ZENBUSINESS|BIZFILINGS|SUNSHINE CORPORATE|COGENCY|URS AGENTS|HARBOR COMPLIANCE|A REGISTERED AGENT|FLORIDA REGISTERED AGENT|LEGALZOOM|ROCKET CORPORATE|CORPORATE CREATIONS|INCFILE|TAILOR BRANDS|STATUTORY AGENT/;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    daysBack = 1,
    entityTypes = ['llc', 'corporation'],
    cities = [],
    zipCodes = [],
    nameKeywords = [],
    excludeKeywords = [],
    excludeAgentServiceAddresses = false,
    requireOfficer = false,
    activeOnly = true,
    maxRows = 1000,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s || '').trim()).filter(Boolean);
const days = Math.max(1, Math.min(30, Number(daysBack) || 1));
const cap = Math.max(1, Math.min(50000, Number(maxRows) || 1000));
const wantTypes = new Set(arr(entityTypes).map((s) => s.toLowerCase()));
const wantCities = new Set(arr(cities).map((s) => s.toUpperCase()));
const wantZips = arr(zipCodes).map((s) => s.replace(/\s/g, ''));
const kw = arr(nameKeywords).map((s) => s.toUpperCase());
const notKw = arr(excludeKeywords).map((s) => s.toUpperCase());

const cut = (l, a, b) => l.slice(a, b).replace(/\0/g, '').trim();
const date8 = (s) => (/^\d{8}$/.test(s) ? `${s.slice(4, 8)}-${s.slice(0, 2)}-${s.slice(2, 4)}` : null);
const person = (raw, type) => {
    if (!raw) return null;
    if (type !== 'P' || raw.length < 21) return raw.replace(/\s+/g, ' ').trim();
    const last = raw.slice(0, 20).trim(); const first = raw.slice(20, 34).trim(); const middle = raw.slice(34).trim();
    return [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ');
};
const zip5 = (z) => (z || '').replace(/\D/g, '').slice(0, 5) || null;
const addr = (a, b) => [a, b].filter(Boolean).join(', ') || null;

function parse(line, sourceFile) {
    if (line.length < 668) return null;
    const typeCode = cut(line, 205, 220);
    const officers = [];
    for (let i = 0; i < 6; i++) {
        const o = 668 + i * 128;
        if (line.length < o + 128) break;
        const titleCode = cut(line, o, o + 4); const ptype = cut(line, o + 4, o + 5);
        const raw = line.slice(o + 5, o + 47).replace(/\0/g, '');
        const name = person(raw.trimEnd(), ptype);
        if (!name) continue;
        officers.push({
            title: TITLES[titleCode] || titleCode || null, titleCode: titleCode || null, isPerson: ptype === 'P', name,
            address: cut(line, o + 47, o + 89) || null, city: cut(line, o + 89, o + 117) || null, state: cut(line, o + 117, o + 119) || null, zip: zip5(cut(line, o + 119, o + 128)),
        });
    }
    const raType = cut(line, 586, 587);
    const ra = person(line.slice(544, 586).replace(/\0/g, '').trimEnd(), raType);
    const p = { street: addr(cut(line, 220, 262), cut(line, 262, 304)), city: cut(line, 304, 332) || null, state: cut(line, 332, 334) || null, zip: zip5(cut(line, 334, 344)) };
    const m = { street: addr(cut(line, 346, 388), cut(line, 388, 430)), city: cut(line, 430, 458) || null, state: cut(line, 458, 460) || null, zip: zip5(cut(line, 460, 470)) };
    const doc = cut(line, 0, 12);
    return {
        documentNumber: doc,
        name: cut(line, 12, 204).replace(/\s+/g, ' '),
        status: cut(line, 204, 205) === 'A' ? 'Active' : (cut(line, 204, 205) === 'I' ? 'Inactive' : cut(line, 204, 205) || null),
        entityType: TYPES[typeCode]?.[0] || typeCode.toLowerCase() || null,
        entityTypeLabel: TYPES[typeCode]?.[1] || typeCode || null,
        filingTypeCode: typeCode || null,
        fileDate: date8(cut(line, 472, 480)),
        feiNumber: cut(line, 480, 494) || null,
        stateOfIncorporation: cut(line, 503, 505) || null,
        principalStreet: p.street, principalCity: p.city, principalState: p.state || (p.city && m.city === p.city ? m.state : null), principalZip: p.zip,
        mailingStreet: m.street, mailingCity: m.city, mailingState: m.state, mailingZip: m.zip,
        registeredAgent: ra || null,
        registeredAgentIsPerson: raType === 'P',
        registeredAgentStreet: cut(line, 587, 629) || null, registeredAgentCity: cut(line, 629, 657) || null, registeredAgentState: cut(line, 657, 659) || null, registeredAgentZip: zip5(cut(line, 659, 668)),
        agentServiceAddress: AGENT_SERVICE.test((ra || '').toUpperCase()) && (cut(line, 587, 629) === cut(line, 220, 262)),
        officers,
        primaryContact: officers.find((o) => o.isPerson)?.name || (raType === 'P' ? ra : null) || null,
        primaryContactTitle: officers.find((o) => o.isPerson)?.title || (raType === 'P' ? 'Registered Agent' : null),
        officerCount: officers.length,
        sunbizUrl: `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=DocumentNumber&searchTerm=${doc}`,
        sourceFile,
        scrapedAt: new Date().toISOString(),
    };
}

function keep(r) {
    if (activeOnly && r.status !== 'Active') return false;
    if (wantTypes.size && !wantTypes.has(r.entityType)) return false;
    if (wantCities.size && !wantCities.has((r.principalCity || '').toUpperCase().replace(/,\s*FL$/, '')) && !wantCities.has((r.mailingCity || '').toUpperCase())) return false;
    if (wantZips.length && !wantZips.some((z) => (r.principalZip || '').startsWith(z) || (r.mailingZip || '').startsWith(z))) return false;
    const n = r.name.toUpperCase();
    if (kw.length && !kw.some((k) => n.includes(k))) return false;
    if (notKw.some((k) => n.includes(k))) return false;
    if (excludeAgentServiceAddresses && r.agentServiceAddress) return false;
    if (requireOfficer && !r.officers.some((o) => o.isPerson)) return false;
    return true;
}

const sftp = new Client();
let files = [];
try {
    await sftp.connect(SFTP);
    files = (await sftp.list(DIR)).filter((f) => /^\d{8}c\.txt$/i.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, days);
} catch (err) {
    log.error(`SFTP failed: ${err.message}`);
    await Actor.pushData({ note: `Could not reach the Sunbiz SFTP server (${err.message.slice(0, 120)}). Try again later. Not charged.` });
    await sftp.end().catch(() => {});
    await Actor.exit();
}
log.info(`Files: ${files.map((f) => f.name).join(', ')}`);

let pushed = 0; let scanned = 0;
for (const f of files) {
    if (pushed >= cap) break;
    let text;
    try { text = (await sftp.get(`${DIR}/${f.name}`)).toString('latin1'); } catch (err) { log.warning(`${f.name}: ${err.message}`); continue; }
    for (const line of text.split(/\r?\n/)) {
        if (pushed >= cap) break;
        const r = parse(line, f.name);
        if (!r || !r.documentNumber) continue;
        scanned += 1;
        if (!keep(r)) continue;
        await Actor.pushData(r);
        pushed += 1;
        if (pushed > FREE_TIER_ROWS) {
            try { await Actor.charge({ eventName: 'filing' }); } catch (err) { log.warning(`charge failed: ${err?.message}`); }
        }
    }
}
await sftp.end().catch(() => {});
if (!pushed) await Actor.pushData({ note: `No filings matched in ${files.length} daily file(s) (${scanned} scanned). Widen the filters or raise daysBack. Not charged.` });
await Actor.setValue('SUMMARY', { files: files.map((f) => f.name), scanned, returned: pushed });
log.info(`Done. ${pushed} of ${scanned} filings.`);
await Actor.exit();
