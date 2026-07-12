// Sanctions & Watchlist Screening Scraper
//
// Strategy
// --------
// Official government sanctions lists, all keyless public downloads:
//   - OFAC SDN (US Treasury Specially Designated Nationals)
//   - OFAC Consolidated (non-SDN US sanctions)
//   - UK HMT (OFSI consolidated list)
// OFAC ships three positional CSVs per list (main / aliases / addresses)
// joined on an entity number; the UK ships one wide CSV grouped by Group ID.
// This actor downloads the selected lists fresh each run, normalizes them into
// one record shape, and either returns the list (filterable) or screens a set
// of names against it.
//
// This is a public-data feed, not certified compliance software. Matching is
// normalized substring/exact, not phonetic/fuzzy; treat hits as candidates to
// review, not determinations.
//
// Pay per event
// -------------
//   record per returned entity (list mode) or per name match (screen mode).
//   First 2 rows per run are free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 50000;
const FETCH_TIMEOUT_MS = 60000;

const SOURCES = {
    'ofac-sdn': {
        label: 'OFAC-SDN',
        kind: 'ofac',
        main: 'https://www.treasury.gov/ofac/downloads/sdn.csv',
        alt: 'https://www.treasury.gov/ofac/downloads/alt.csv',
        add: 'https://www.treasury.gov/ofac/downloads/add.csv',
        url: 'https://sanctionssearch.ofac.treas.gov/',
    },
    'ofac-consolidated': {
        label: 'OFAC-Consolidated',
        kind: 'ofac',
        main: 'https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv',
        alt: 'https://www.treasury.gov/ofac/downloads/consolidated/cons_alt.csv',
        add: 'https://www.treasury.gov/ofac/downloads/consolidated/cons_add.csv',
        url: 'https://sanctionssearch.ofac.treas.gov/',
    },
    'uk-hmt': {
        label: 'UK-HMT',
        kind: 'uk',
        main: 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv',
        url: 'https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets',
    },
};

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'list',
    sources = ['ofac-sdn', 'ofac-consolidated'],
    screenNames = [],
    type = '',
    program = '',
    country = '',
    keyword = '',
    maxRows = 200,
} = input;

const asTokens = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);

const selectedSources = asTokens(sources).map((s) => s.toLowerCase()).filter((s) => SOURCES[s]);
const wantSources = selectedSources.length ? selectedSources : ['ofac-sdn', 'ofac-consolidated'];
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const typeFilter = String(type || '').trim().toLowerCase();
const programFilter = String(program || '').trim().toLowerCase();
const countryFilter = String(country || '').trim().toLowerCase();
const kw = String(keyword || '').trim().toLowerCase();

// --- helpers -------------------------------------------------------------

// Quote-aware CSV parse for a whole file (files are <= ~17 MB).
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// OFAC uses "-0-" (often with trailing space) as an empty value.
const clean = (v) => {
    const s = String(v ?? '').trim();
    return (s === '' || s === '-0-') ? null : s;
};

const splitPrograms = (v) => {
    const s = clean(v);
    if (!s) return [];
    return s.split(/\]\s*\[/).map((p) => p.replace(/[[\]]/g, '').trim()).filter(Boolean);
};

const normName = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'scrapemint-sanctions-watchlist/0.1 (+https://apify.com)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

function mapOfacType(t) {
    const v = (clean(t) || '').toLowerCase();
    if (v === 'individual') return 'Individual';
    if (v === 'vessel') return 'Vessel';
    if (v === 'aircraft') return 'Aircraft';
    return 'Entity';
}

// --- loaders -------------------------------------------------------------

async function loadOfac(srcKey) {
    const src = SOURCES[srcKey];
    const [mainT, altT, addT] = await Promise.all([fetchText(src.main), fetchText(src.alt), fetchText(src.add)]);

    const aliases = new Map(); // entNum -> [names]
    for (const r of parseCsv(altT)) {
        const en = clean(r[0]); const name = clean(r[3]);
        if (!en || !name) continue;
        (aliases.get(en) || aliases.set(en, []).get(en)).push(name);
    }
    const addresses = new Map(); // entNum -> [{address,city,country}]
    for (const r of parseCsv(addT)) {
        const en = clean(r[0]); if (!en) continue;
        const a = { address: clean(r[2]), city: clean(r[3]), country: clean(r[4]) };
        if (a.address || a.city || a.country) (addresses.get(en) || addresses.set(en, []).get(en)).push(a);
    }

    const out = [];
    for (const r of parseCsv(mainT)) {
        const en = clean(r[0]); const name = clean(r[1]);
        if (!en || !name) continue;
        out.push({
            source: src.label,
            uid: `${src.label}:${en}`,
            name,
            type: mapOfacType(r[2]),
            programs: splitPrograms(r[3]),
            title: clean(r[4]),
            aliases: aliases.get(en) || [],
            addresses: addresses.get(en) || [],
            nationalities: [],
            remarks: clean(r[11]),
            sourceUrl: src.url,
        });
    }
    return out;
}

async function loadUk() {
    const src = SOURCES['uk-hmt'];
    const rows = parseCsv(await fetchText(src.main));
    // Line 0 is "Last Updated,<date>"; line 1 is the header.
    let hi = rows.findIndex((r) => r.includes('Group ID'));
    if (hi < 0) hi = 1;
    const header = rows[hi];
    const col = (name) => header.indexOf(name);
    const ci = {
        n1: col('Name 1'), n2: col('Name 2'), n3: col('Name 3'), n4: col('Name 4'), n5: col('Name 5'), n6: col('Name 6'),
        groupType: col('Group Type'), aliasType: col('Alias Type'), regime: col('Regime'),
        country: col('Country'), nationality: col('Nationality'), dob: col('DOB'),
        listedOn: col('Listed On'), groupId: col('Group ID'), other: col('Other Information'),
    };
    const nameOf = (r) => [ci.n1, ci.n2, ci.n3, ci.n4, ci.n5, ci.n6].map((i) => (i >= 0 ? clean(r[i]) : null)).filter(Boolean).join(' ').trim();

    const groups = new Map();
    for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i];
        const gid = clean(r[ci.groupId]); if (!gid) continue;
        const nm = nameOf(r); if (!nm) continue;
        const isPrimary = String(r[ci.aliasType] || '').toLowerCase().includes('primary');
        let g = groups.get(gid);
        if (!g) { g = { primary: null, aliases: [], rows: [] }; groups.set(gid, g); }
        g.rows.push(r);
        if (isPrimary && !g.primary) g.primary = r;
        else g.aliases.push(nm);
    }

    const out = [];
    for (const [gid, g] of groups) {
        const p = g.primary || g.rows[0];
        const primaryName = nameOf(p);
        const gt = String(p[ci.groupType] || '').toLowerCase();
        out.push({
            source: src.label,
            uid: `${src.label}:${gid}`,
            name: primaryName,
            type: gt.includes('individual') ? 'Individual' : (gt.includes('entity') ? 'Entity' : (clean(p[ci.groupType]) || 'Entity')),
            programs: [clean(p[ci.regime])].filter(Boolean),
            title: null,
            aliases: g.aliases.filter((a) => a && a !== primaryName),
            addresses: clean(p[ci.country]) ? [{ address: null, city: null, country: clean(p[ci.country]) }] : [],
            nationalities: [clean(p[ci.nationality])].filter(Boolean),
            remarks: clean(p[ci.other]),
            sourceUrl: src.url,
        });
    }
    return out;
}

// --- load selected lists -------------------------------------------------

log.info(`Loading sanctions lists: ${wantSources.join(', ')} …`);
let entities = [];
for (const s of wantSources) {
    try {
        const rows = SOURCES[s].kind === 'ofac' ? await loadOfac(s) : await loadUk();
        entities = entities.concat(rows);
        log.info(`  ${SOURCES[s].label}: ${rows.length} entities`);
    } catch (err) {
        log.warning(`  ${SOURCES[s].label} failed: ${err?.message}`);
    }
}
log.info(`Total ${entities.length} sanctioned entities loaded.`);

// --- output --------------------------------------------------------------

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'record' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const entityMatchesFilters = (e) => {
    if (typeFilter && e.type.toLowerCase() !== typeFilter) return false;
    if (programFilter && !e.programs.some((p) => p.toLowerCase().includes(programFilter))) return false;
    if (countryFilter) {
        const hay = [...e.addresses.map((a) => a.country || ''), ...e.nationalities].join(' ').toLowerCase();
        if (!hay.includes(countryFilter)) return false;
    }
    if (kw) {
        const hay = [e.name, ...e.aliases].join(' ').toLowerCase();
        if (!hay.includes(kw)) return false;
    }
    return true;
};

if (mode === 'screen') {
    const queries = asTokens(screenNames);
    if (queries.length === 0) {
        log.warning('Screen mode needs screenNames. Provide one or more names to check.');
        await Actor.exit();
    }
    // Index every name/alias -> entities for fast lookup.
    const byNorm = new Map();
    for (const e of entities) {
        for (const [field, val] of [['name', e.name], ...e.aliases.map((a) => ['alias', a])]) {
            const n = normName(val); if (!n) continue;
            (byNorm.get(n) || byNorm.set(n, []).get(n)).push({ e, field, val });
        }
    }
    const allNames = [...byNorm.keys()];
    outer:
    for (const q of queries) {
        const qn = normName(q);
        if (!qn) continue;
        const seen = new Set();
        const hits = [];
        for (const cand of allNames) {
            const exact = cand === qn;
            const partial = !exact && qn.length >= 4 && (cand.includes(qn) || qn.includes(cand));
            if (!exact && !partial) continue;
            for (const { e, field, val } of byNorm.get(cand)) {
                if (seen.has(e.uid)) continue;
                seen.add(e.uid);
                hits.push({ e, field, val, matchType: exact ? 'exact' : 'partial' });
            }
        }
        hits.sort((a, b) => (a.matchType === 'exact' ? 0 : 1) - (b.matchType === 'exact' ? 0 : 1));
        for (const h of hits) {
            if (rowsPushed >= cap) break outer;
            if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break outer; }
            await flushRow({ query: q, matchType: h.matchType, matchedName: h.val, matchedField: h.field, ...h.e });
        }
        if (hits.length === 0) log.info(`No match: "${q}"`);
    }
} else {
    for (const e of entities) {
        if (rowsPushed >= cap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('Approaching timeout; stopping early.'); break; }
        if (entityMatchesFilters(e)) await flushRow(e);
    }
}

log.info(`Done. ${rowsPushed} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
