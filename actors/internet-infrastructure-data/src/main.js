// Internet Infrastructure Data: Networks, IP Ranges and Peering
//
// What it does
// ------------
// Who actually owns and routes a piece of the internet. Give an autonomous
// system number, an IP address or a country, and get the holder, the address
// space they announce, the networks they connect to, and how long they have
// been visible in the global routing table.
//
//   network    one row per network: holder, announced space, peer counts,
//              first and last seen
//   prefixes   one row per announced IP range, with its size
//   peers      one row per neighbouring network, marked upstream, downstream
//              or uncertain
//   country    every network registered to a country
//
// Distinct from our dns-records-checker, domain-intelligence and
// ssl-subdomain-finder, which read DNS, registry and certificate records.
// This reads the routing layer underneath all of them.
//
// Pay per event
// -------------
//   network_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 45000;
const SPACING_MS = 350;
const API = 'https://stat.ripe.net/data';
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'network',
    resources = ['AS15169'],
    country = '',
    includeHolderNames = true,
    onlyCurrentPrefixes = true,
    peerType = 'all',
    maxResults = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const theMode = ['network', 'prefixes', 'peers', 'country'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'network';
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 100));
const wantPeerType = ['all', 'upstream', 'downstream', 'uncertain'].includes(String(peerType).toLowerCase())
    ? String(peerType).toLowerCase() : 'all';

async function getJson(path, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API}/${path}`, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, accept: 'application/json' },
        });
        const text = await res.text();
        if (!text.trimStart().startsWith('{')) return null;
        const json = JSON.parse(text);
        // The service answers 200 with a status of "error" in the envelope,
        // so the HTTP code alone does not tell you whether it worked.
        if (json.status && json.status !== 'ok') {
            log.warning(`${path.split('/')[0]}: ${json.status} ${clean(json.message) ?? ''}`);
            return null;
        }
        return json.data ?? null;
    } catch (err) {
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); return getJson(path, attempt + 1); }
        log.warning(`request failed: ${path.slice(0, 100)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'network_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const push = async (row) => {
    if (emitted >= cap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const asNumber = (v) => {
    const m = String(v ?? '').trim().match(/^(?:AS)?(\d+)$/i);
    return m ? Number(m[1]) : null;
};
const looksLikeIp = (v) => /^[0-9a-f:.]+(\/\d+)?$/i.test(String(v ?? '').trim()) && /[.:]/.test(String(v));

// A v4 prefix covers a countable number of addresses. A v6 prefix does not,
// in any useful sense: a /32 covers 79 octillion addresses, so counting them
// alongside v4 totals produces a number that means nothing. Address counts
// are v4 only, and v6 is reported as prefixes, which is what the source does
// and what network engineers actually compare.
function prefixSize(prefix) {
    const s = String(prefix ?? '');
    const [addr, lenText] = s.split('/');
    const len = Number(lenText);
    if (!addr || !Number.isFinite(len)) return { family: null, addresses: null };
    if (addr.includes(':')) return { family: 'ipv6', addresses: null };
    return { family: 'ipv4', addresses: len <= 32 ? 2 ** (32 - len) : null };
}

const holderCache = new Map();
async function holderOf(asn) {
    if (!includeHolderNames || asn == null) return null;
    if (holderCache.has(asn)) return holderCache.get(asn);
    const data = await getJson(`as-overview/data.json?resource=AS${asn}`);
    await sleep(SPACING_MS);
    const holder = clean(data?.holder);
    holderCache.set(asn, holder);
    return holder;
}

async function resolveToAsn(token) {
    const direct = asNumber(token);
    if (direct != null) return { asn: direct, via: null };
    if (looksLikeIp(token)) {
        const info = await getJson(`network-info/data.json?resource=${encodeURIComponent(token)}`);
        await sleep(SPACING_MS);
        const asn = asNumber((info?.asns || [])[0]);
        if (asn != null) return { asn, via: clean(info?.prefix) };
    }
    return null;
}

log.info(`Internet infrastructure ${theMode} | ${theMode === 'country' ? country : asList(resources).join(', ')}`);

if (theMode === 'country') {
    const code = clean(country)?.toUpperCase();
    if (!code || !/^[A-Z]{2}$/.test(code)) {
        await flushRow({ type: 'note', found: false, requested: country, note: 'country mode needs a two letter country code such as KE, DE or BR; not charged' }, false);
        log.error('bad country code');
        await Actor.exit();
    }
    const data = await getJson(`country-resource-list/data.json?resource=${code}`);
    const asns = (data?.resources?.asn || []).map(asNumber).filter((n) => n != null);
    const v4 = data?.resources?.ipv4 || [];
    const v6 = data?.resources?.ipv6 || [];
    if (!asns.length) {
        await flushRow({ type: 'note', found: false, country: code, note: 'no networks are registered to that country code; check the code is a valid two letter code; not charged' }, false);
    } else {
        log.info(`${code}: ${asns.length} network(s), ${v4.length} IPv4 block(s), ${v6.length} IPv6 block(s)`);
        for (const asn of asns) {
            if (emitted >= cap) break;
            if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
            // Holder names cost one request each, so only the networks being
            // returned are looked up, never the whole country list.
            const holder = await holderOf(asn);
            await push({
                mode: 'country',
                country: code,
                asn,
                asnLabel: `AS${asn}`,
                holder,
                networksInCountry: asns.length,
                ipv4BlocksInCountry: v4.length,
                ipv6BlocksInCountry: v6.length,
                source: 'RIPE NCC',
                scrapedAt: new Date().toISOString(),
            });
        }
    }
} else {
    const tokens = asList(resources);
    if (!tokens.length) {
        await flushRow({ type: 'note', found: false, note: 'give at least one network number such as AS15169, or an IP address; not charged' }, false);
        log.error('no resources');
        await Actor.exit();
    }
    for (const token of tokens) {
        if (emitted >= cap) break;
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        const resolved = await resolveToAsn(token);
        if (!resolved) {
            await flushRow({
                type: 'note', found: false, requested: token,
                note: 'could not read that as a network number or an IP address; use a form such as AS15169, 15169 or 8.8.8.8; not charged',
            }, false);
            continue;
        }
        const { asn, via } = resolved;

        if (theMode === 'network') {
            const [overview, routing] = [
                await getJson(`as-overview/data.json?resource=AS${asn}`),
                await (async () => { await sleep(SPACING_MS); return getJson(`routing-status/data.json?resource=AS${asn}`); })(),
            ];
            await sleep(SPACING_MS);
            if (!overview && !routing) {
                await flushRow({ type: 'note', found: false, requested: token, asn, note: 'no routing data is published for that network; not charged' }, false);
                continue;
            }
            const v4 = routing?.announced_space?.v4 || {};
            const v6 = routing?.announced_space?.v6 || {};
            await push({
                mode: 'network',
                requested: token,
                asn,
                asnLabel: `AS${asn}`,
                holder: clean(overview?.holder),
                resolvedViaPrefix: via,
                announced: overview?.announced ?? null,
                registryBlock: clean(overview?.block?.desc),
                registryName: clean(overview?.block?.name),
                ipv4Prefixes: v4.prefixes ?? null,
                // Address totals are v4 only, on purpose. See prefixSize.
                ipv4Addresses: v4.ips ?? null,
                ipv6Prefixes: v6.prefixes ?? null,
                observedNeighbours: routing?.observed_neighbours ?? null,
                firstSeenInRouting: clean(routing?.first_seen?.time),
                firstSeenPrefix: clean(routing?.first_seen?.prefix),
                lastSeenInRouting: clean(routing?.last_seen?.time),
                visibilityIpv4Percent: routing?.visibility?.v4?.ris_peers_seeing != null && routing?.visibility?.v4?.total_ris_peers
                    ? Math.round((routing.visibility.v4.ris_peers_seeing / routing.visibility.v4.total_ris_peers) * 1000) / 10
                    : null,
                source: 'RIPE NCC',
                scrapedAt: new Date().toISOString(),
            });
        } else if (theMode === 'prefixes') {
            const data = await getJson(`announced-prefixes/data.json?resource=AS${asn}`);
            await sleep(SPACING_MS);
            const list = data?.prefixes || [];
            if (!list.length) {
                await flushRow({ type: 'note', found: false, requested: token, asn, note: 'that network announces no prefixes right now; not charged' }, false);
                continue;
            }
            const holder = await holderOf(asn);
            // A prefix that stopped being announced keeps its entry, with the
            // timeline showing when it ended. Those are marked rather than
            // dropped, and excluded by default.
            const latestEnd = list.reduce((max, p) => {
                const end = (p.timelines || []).reduce((m, t) => (String(t.endtime) > m ? String(t.endtime) : m), '');
                return end > max ? end : max;
            }, '');
            for (const p of list) {
                if (emitted >= cap) break;
                const timelines = p.timelines || [];
                const end = timelines.reduce((m, t) => (String(t.endtime) > m ? String(t.endtime) : m), '');
                const start = timelines.reduce((m, t) => (!m || String(t.starttime) < m ? String(t.starttime) : m), '');
                const current = !latestEnd || end === latestEnd;
                if (onlyCurrentPrefixes && !current) continue;
                const { family, addresses } = prefixSize(p.prefix);
                await push({
                    mode: 'prefixes',
                    asn,
                    asnLabel: `AS${asn}`,
                    holder,
                    prefix: clean(p.prefix),
                    family,
                    addresses,
                    currentlyAnnounced: current,
                    firstSeen: clean(start),
                    lastSeen: clean(end),
                    source: 'RIPE NCC',
                    scrapedAt: new Date().toISOString(),
                });
            }
        } else {
            const data = await getJson(`asn-neighbours/data.json?resource=AS${asn}`);
            await sleep(SPACING_MS);
            const neighbours = data?.neighbours || [];
            if (!neighbours.length) {
                await flushRow({ type: 'note', found: false, requested: token, asn, note: 'no neighbouring networks were observed for that network; not charged' }, false);
                continue;
            }
            const counts = data?.neighbour_counts || {};
            // The source labels relationships left and right. Those mean
            // upstream and downstream, which is what people actually ask for.
            const relationOf = (t) => (t === 'left' ? 'upstream' : (t === 'right' ? 'downstream' : 'uncertain'));
            const selfHolder = await holderOf(asn);
            const filtered = neighbours.filter((n) => wantPeerType === 'all' || relationOf(n.type) === wantPeerType);
            filtered.sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (b.v4_peers ?? 0) - (a.v4_peers ?? 0));
            for (const n of filtered) {
                if (emitted >= cap) break;
                if (deadlineMs && Date.now() > deadlineMs) break;
                const peerAsn = asNumber(n.asn);
                await push({
                    mode: 'peers',
                    asn,
                    asnLabel: `AS${asn}`,
                    holder: selfHolder,
                    peerAsn,
                    peerAsnLabel: peerAsn != null ? `AS${peerAsn}` : null,
                    peerHolder: await holderOf(peerAsn),
                    relationship: relationOf(n.type),
                    observationStrength: n.power ?? null,
                    ipv4PeeringSessions: n.v4_peers ?? null,
                    ipv6PeeringSessions: n.v6_peers ?? null,
                    totalNeighbours: counts.unique ?? neighbours.length,
                    upstreamCount: counts.left ?? null,
                    downstreamCount: counts.right ?? null,
                    uncertainCount: counts.uncertain ?? null,
                    source: 'RIPE NCC',
                    scrapedAt: new Date().toISOString(),
                });
            }
        }
    }
}

if (!emitted && !notePushed) {
    await flushRow({ type: 'note', found: false, note: 'nothing returned; check the network numbers, IP addresses or country code; not charged' }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable). ${holderCache.size} holder lookup(s).`);
await Actor.exit();
