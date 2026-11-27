// Transfermarkt Player Values: market values, transfers and contracts
//
// Strategy
// --------
// Transfermarkt's own JSON services, no key, reachable from Apify datacenter
// IPs (verified 2026-11-27):
//   tmapi-alpha.transfermarkt.technology/players?ids[]=..   player profiles in batches
//   tmapi-alpha.transfermarkt.technology/clubs?ids[]=..     club names in batches
//   tmapi-alpha.transfermarkt.technology/club/{id}/squad    current squad (player ids)
//   www.transfermarkt.com/ceapi/marketValueDevelopment/graph/{id}   value history
//   www.transfermarkt.com/ceapi/transferHistory/list/{id}           transfer history
// Names are resolved with the site's quick search page, and a league's clubs
// are read from its overview page (both plain HTML, parsed for ids only).
//
// Pay per event
// -------------
//   player ($0.002)          one player with value, contract, club and profile
//   player_history ($0.002)  value history and/or transfer history added to a player
//   The first player of every run is free. Notes are free.

import { Actor, log } from 'apify';
import { COUNTRIES } from './countries.js';

const TMAPI = 'https://tmapi-alpha.transfermarkt.technology';
const SITE = 'https://www.transfermarkt.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const FREE_TIER_ROWS = 1;
const BATCH = 25;
const LEAGUES = {
    'premier league': 'GB1', epl: 'GB1', championship: 'GB2', laliga: 'ES1', 'la liga': 'ES1', 'serie a': 'IT1',
    bundesliga: 'L1', 'ligue 1': 'FR1', eredivisie: 'NL1', 'liga portugal': 'PO1', 'primeira liga': 'PO1',
    'super lig': 'TR1', 'süper lig': 'TR1', mls: 'MLS1', 'saudi pro league': 'SA1', brasileirao: 'BRA1',
    'brasileirão': 'BRA1', 'scottish premiership': 'SC1', 'belgian pro league': 'BE1', 'jupiler pro league': 'BE1',
    'liga mx': 'MEXA', 'serie b': 'IT2', '2. bundesliga': 'L2', 'ligue 2': 'FR2', 'laliga2': 'ES2',
};

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    players = [],
    clubs = [],
    leagues = [],
    includeValueHistory = false,
    includeTransfers = false,
    minMarketValueEur = 0,
    maxRows = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map((s) => String(s ?? '').trim()).filter(Boolean);
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Math.min(20000, Number(maxRows) || 1000));
const minValue = Math.max(0, Number(minMarketValueEur) || 0);
const withHistory = Boolean(includeValueHistory) || Boolean(includeTransfers);
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const outOfTime = () => timeoutAt && Date.now() > timeoutAt - 40_000;

async function get(url, as = 'json') {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(40_000) });
            if (res.status === 404) return null;
            if (res.ok) return as === 'json' ? await res.json() : await res.text();
            log.warning(`HTTP ${res.status} ${url.slice(0, 110)} (attempt ${attempt})`);
        } catch (err) { log.warning(`${err.message} ${url.slice(0, 110)} (attempt ${attempt})`); }
        await sleep(1500 * attempt);
    }
    return null;
}

async function note(input, text) {
    await Actor.pushData({ input, note: `${text} Not charged.` });
    log.info(`${input}: ${text}`);
}

// ---------- resolve inputs to player ids ----------
const playerIds = new Map(); // id -> origin
const idFrom = (s, kind) => (String(s).match(new RegExp(`/${kind}/(\\d+)`)) || [])[1] ?? (/^\d+$/.test(String(s).trim()) ? String(s).trim() : null);

function searchLinks(html, kind) {
    // <a title="Bukayo Saka" href="/bukayo-saka/profil/spieler/433177">
    const out = [];
    const re = kind === 'spieler'
        ? /<a[^>]*?title="([^"]+)"[^>]*?href="\/[^"]*?\/profil\/spieler\/(\d+)"|<a[^>]*?href="\/[^"]*?\/profil\/spieler\/(\d+)"[^>]*?title="([^"]+)"/g
        : /<a[^>]*?title="([^"]+)"[^>]*?href="\/[^"]*?\/startseite\/verein\/(\d+)"|<a[^>]*?href="\/[^"]*?\/startseite\/verein\/(\d+)"[^>]*?title="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) out.push({ title: m[1] ?? m[4], id: m[2] ?? m[3] });
    return out;
}
async function searchId(query, kind) {
    const html = await get(`${SITE}/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(query)}`, 'html');
    if (!html) return null;
    const links = searchLinks(html, kind);
    const q = norm(query).split(' ');
    const hit = links.find((l) => q.every((w) => norm(l.title).includes(w))) ?? links.find((l) => q.some((w) => w.length > 2 && norm(l.title).includes(w)));
    return hit ?? null;
}

async function squadIds(clubId) {
    const d = await get(`${TMAPI}/club/${clubId}/squad`);
    return (d?.data?.squad ?? []).filter((p) => p.type === 'current' || !p.type).map((p) => String(p.playerId));
}
async function leagueClubIds(code) {
    const html = await get(`${SITE}/x/startseite/wettbewerb/${code}`, 'html');
    if (!html) return [];
    // The overview table lists every club; the page also links a handful of
    // clubs elsewhere (news, transfers), so keep ids in the order they appear in
    // the main table: the first block of /startseite/verein/ links.
    const table = html.split('class="items"')[1] ?? html;
    return [...new Set([...table.matchAll(/\/startseite\/verein\/(\d+)/g)].map((m) => m[1]))];
}

for (const p of list(players)) {
    let id = idFrom(p, 'spieler');
    if (!id) { const hit = await searchId(p, 'spieler'); id = hit?.id ?? null; if (hit) log.info(`"${p}" -> ${hit.title} (${hit.id})`); }
    if (!id) { await note(p, 'no Transfermarkt player found for this name.'); continue; }
    playerIds.set(id, { input: p });
}
for (const c of list(clubs)) {
    let id = idFrom(c, 'verein');
    if (!id) { const hit = await searchId(c, 'verein'); id = hit?.id ?? null; if (hit) log.info(`"${c}" -> ${hit.title} (${hit.id})`); }
    if (!id) { await note(c, 'no Transfermarkt club found for this name.'); continue; }
    const ids = await squadIds(id);
    if (!ids.length) { await note(c, 'club found but its squad is empty.'); continue; }
    for (const pid of ids) if (!playerIds.has(pid)) playerIds.set(pid, { input: c });
}
for (const l of list(leagues)) {
    const code = LEAGUES[norm(l)] ?? (String(l).match(/wettbewerb\/([A-Z0-9]+)/) || [])[1] ?? (/^[A-Z0-9]{2,5}$/.test(String(l).trim()) ? String(l).trim() : null);
    if (!code) { await note(l, 'unknown league. Use a name like premier league, laliga, serie a, bundesliga, ligue 1, mls, or a Transfermarkt code like GB1.'); continue; }
    const clubIds = await leagueClubIds(code);
    if (!clubIds.length) { await note(l, `no clubs found for league ${code}.`); continue; }
    log.info(`${l} (${code}): ${clubIds.length} clubs`);
    for (const cid of clubIds) {
        if (outOfTime() || playerIds.size >= cap * 2) break;
        for (const pid of await squadIds(cid)) if (!playerIds.has(pid)) playerIds.set(pid, { input: l });
        await sleep(150);
    }
}
if (!playerIds.size) {
    if (!list(players).length && !list(clubs).length && !list(leagues).length) await note('input', 'give at least one player, club or league.');
    await Actor.exit();
}
log.info(`${playerIds.size} player(s) to read${withHistory ? ' with history' : ''}.`);

// ---------- read players ----------
const clubNames = new Map();
async function loadClubs(ids) {
    const need = [...new Set(ids.filter((i) => i && !clubNames.has(i)))];
    for (let i = 0; i < need.length; i += BATCH) {
        const d = await get(`${TMAPI}/clubs?${need.slice(i, i + BATCH).map((x) => `ids[]=${x}`).join('&')}`);
        for (const c of d?.data ?? []) clubNames.set(String(c.id), c.name);
    }
}
const eur = (o) => num(o?.value);
// "€60.00M" -> 60000000, "€500k" -> 500000; "free transfer", "loan", "-" -> null
const money = (s) => {
    const m = String(s ?? '').replace(/,/g, '.').match(/([\d.]+)\s*(bn|b|m|k|th\.)?/i);
    if (!m || !/\d/.test(m[1])) return null;
    const mult = { bn: 1e9, b: 1e9, m: 1e6, k: 1e3, 'th.': 1e3 }[String(m[2] ?? '').toLowerCase()] ?? 1;
    return Math.round(Number(m[1]) * mult);
};
const dmy = (s) => { const m = String(s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || null); };

let pushed = 0;
let billable = 0;
let stop = false;
async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
    } catch (err) { log.warning(`charge failed: ${err?.message}`); }
}

const ids = [...playerIds.keys()];
for (let i = 0; i < ids.length && !stop; i += BATCH) {
    if (outOfTime()) { log.warning('Stopping early to stay inside the run timeout.'); break; }
    const d = await get(`${TMAPI}/players?${ids.slice(i, i + BATCH).map((x) => `ids[]=${x}`).join('&')}`);
    const profiles = d?.data ?? [];
    await loadClubs(profiles.flatMap((p) => (p.clubAssignments ?? []).map((a) => String(a.clubId))));
    for (const p of profiles) {
        if (stop || pushed >= cap) { stop = true; break; }
        const mv = p.marketValueDetails ?? {};
        const value = eur(mv.current);
        if (minValue && (value ?? 0) < minValue) continue;
        const cur = (p.clubAssignments ?? []).find((a) => a.type === 'current');
        const nat = (p.clubAssignments ?? []).find((a) => a.type === 'nationalTeam');
        const attr = p.attributes ?? {};
        const nIds = [p.nationalityDetails?.nationalities?.nationalityId, p.nationalityDetails?.nationalities?.secondNationalityId].filter((x) => x);
        const row = {
            playerId: String(p.id),
            name: p.name ?? null,
            age: num(p.lifeDates?.age),
            dateOfBirth: p.lifeDates?.dateOfBirth ?? null,
            placeOfBirth: p.birthPlaceDetails?.placeOfBirth ?? null,
            nationality: nIds.map((x) => COUNTRIES[String(x)] ?? null).filter(Boolean),
            nationalityIds: nIds,
            position: attr.position?.name ?? null,
            positionGroup: attr.positionGroupName ?? attr.positionGroup ?? null,
            preferredFoot: attr.preferredFoot?.name ?? null,
            heightM: num(attr.height),
            club: cur ? (clubNames.get(String(cur.clubId)) ?? null) : null,
            clubId: cur ? String(cur.clubId) : null,
            shirtNumber: cur?.shirtNumber ?? null,
            joined: cur?.start ?? null,
            contractUntil: attr.contractUntil ?? null,
            nationalTeam: nat ? (clubNames.get(String(nat.clubId)) ?? null) : null,
            marketValueEur: value,
            marketValueDate: mv.current?.determined ?? null,
            previousMarketValueEur: eur(mv.previous),
            marketValueChangePct: value && eur(mv.previous) ? Math.round(((value - eur(mv.previous)) / eur(mv.previous)) * 1000) / 10 : null,
            highestMarketValueEur: eur(mv.highest),
            highestMarketValueDate: mv.highest?.determined ?? null,
            kitSupplier: attr.outfitter?.name ?? null,
            photo: p.portraitUrl ?? null,
            url: p.relativeUrl ? `${SITE}${p.relativeUrl.replace(/\\\//g, '/')}` : null,
            source: playerIds.get(String(p.id))?.input ?? null,
            scrapedAt: new Date().toISOString(),
        };
        if (withHistory) {
            if (includeValueHistory) {
                const h = await get(`${SITE}/ceapi/marketValueDevelopment/graph/${p.id}`);
                row.valueHistory = (h?.list ?? []).map((x) => ({ date: dmy(x.datum_mw), valueEur: num(x.y), club: x.verein ?? null, age: num(x.age) }));
            }
            if (includeTransfers) {
                const t = await get(`${SITE}/ceapi/transferHistory/list/${p.id}`);
                row.transfers = (t?.transfers ?? []).map((x) => ({
                    date: x.dateUnformatted ?? dmy(x.date), season: x.season ?? null, from: x.from?.clubName ?? null, to: x.to?.clubName ?? null,
                    fee: x.fee ?? null, feeEur: /€/.test(String(x.fee ?? '')) ? money(x.fee) : null,
                    marketValueAtTransfer: x.marketValue ?? null, marketValueAtTransferEur: /€/.test(String(x.marketValue ?? '')) ? money(x.marketValue) : null,
                    upcoming: Boolean(x.upcoming),
                }));
            }
            await sleep(120);
        }
        await Actor.pushData(row);
        pushed += 1;
        billable += 1;
        if (billable > FREE_TIER_ROWS) {
            await charge('player');
            if (withHistory && !stop) await charge('player_history');
        }
    }
    await sleep(200);
}
await Actor.setValue('SUMMARY', { requested: playerIds.size, rows: pushed, withHistory });
log.info(`Done. ${pushed} player(s); first ${FREE_TIER_ROWS} free, notes free.`);
await Actor.exit();
