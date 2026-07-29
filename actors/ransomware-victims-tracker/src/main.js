// Ransomware Victims Tracker: Who Got Hit, By Which Group
//
// What it does
// ------------
// Ransomware groups publish the organisations they say they have breached on
// their own leak sites, to pressure them into paying. This aggregates those
// postings into rows: the named organisation, the group claiming it, the
// country, the sector, and when the claim appeared.
//
//   victims   one row per claimed victim, filterable by country, sector,
//             group and how far back to look
//   groups    one row per ransomware group: known aliases, when it was first
//             seen, how many leak sites it runs, tooling and techniques
//   summary   one row per group, country or sector with claim counts over
//             the window, so you can see who is currently most active
//
// READ THIS BEFORE USING THE DATA
// -------------------------------
// Every entry is a CLAIM MADE BY A CRIMINAL GROUP on its own leak site. It is
// not a confirmed breach. Claims are sometimes exaggerated, recycled from
// older incidents, or simply false, and a listed organisation may never have
// been compromised at all. Every row is labelled as a claim, with the group
// named as its source. Do not present these as verified breaches.
//
// Pay per event
// -------------
//   victim_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 45000;
// The service rate limits and answers 429 under rapid use, so requests are
// spaced and backed off rather than retried immediately.
const SPACING_MS = 1200;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const API = 'https://api.ransomware.live/v2';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'victims',
    country = '',
    sector = '',
    group = '',
    year = 0,
    month = 0,
    daysBack = 30,
    summariseBy = 'group',
    maxRows = 100,
} = input;

const clean = (v) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    // The source writes a literal "Not Found" where it has no value, which is
    // a placeholder, not a sector called Not Found.
    if (!s || s.toLowerCase() === 'not found' || s.toLowerCase() === 'unknown') return null;
    return s;
};
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const isoOrNull = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const theMode = ['victims', 'groups', 'summary'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'victims';
const wantCountry = String(country || '').trim().toUpperCase();
const wantSector = String(sector || '').trim();
const wantGroup = String(group || '').trim().toLowerCase();
const wantYear = Math.max(0, Math.min(2100, Number(year) || 0));
const wantMonth = Math.max(0, Math.min(12, Number(month) || 0));
const back = Math.max(1, Math.min(3650, Number(daysBack) || 30));
const groupBy = ['group', 'country', 'sector'].includes(String(summariseBy).toLowerCase())
    ? String(summariseBy).toLowerCase() : 'group';
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'victim_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

async function getJson(path, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API}/${path}`, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': UA },
        });
        if (res.status === 429) throw new Error('rate limited (HTTP 429)');
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (res.status === 404) return { error: 'no data published for that selection' };
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { data: await res.json() };
    } catch (err) {
        if (attempt < 3) {
            // Longer waits than usual: this service throttles a burst of
            // requests hard and recovers after a pause.
            await sleep(3000 * (attempt + 1));
            return getJson(path, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// The same record comes back under DIFFERENT KEY NAMES depending on which
// endpoint served it: the recent feed calls it victim/group/attackdate, while
// the country and sector feeds call it post_title/group_name/published. One
// parser written against either shape silently returns nulls for the other.
const normalise = (raw) => ({
    victimName: clean(raw.victim ?? raw.post_title),
    groupName: clean(raw.group ?? raw.group_name),
    country: clean(raw.country),
    sector: clean(raw.activity),
    descriptionRaw: clean(raw.description),
    claimedAt: isoOrNull(raw.attackdate ?? raw.published),
    discoveredAt: isoOrNull(raw.discovered),
    leakSiteUrl: clean(raw.claim_url ?? raw.post_url),
    victimWebsite: clean(raw.domain ?? raw.website),
    dataSize: clean(raw.data_size),
    ransomDemand: clean(raw.ransom),
    pressReference: clean(raw.press),
    screenshotUrl: clean(raw.screenshot),
    profileUrl: clean(raw.url),
});

const CLAIM_FIELDS = {
    recordType: 'attacker claim',
    isConfirmedBreach: false,
    claimCaveat: 'this entry is a claim published by the attacking group on its own leak site, not a confirmed breach; claims are sometimes exaggerated, recycled from older incidents or false, and a listed organisation may never have been compromised',
    sourceName: 'ransomware.live leak site aggregation',
    sourceUrl: 'https://www.ransomware.live',
};

const stamp = () => ({ ...CLAIM_FIELDS, scrapedAt: new Date().toISOString() });

// Which endpoint answers depends on the filters, because the service exposes
// a different path per dimension rather than one query interface.
function routeFor() {
    if (wantCountry) return { path: `countryvictims/${encodeURIComponent(wantCountry)}`, label: `country ${wantCountry}` };
    if (wantSector) return { path: `sectorvictims/${encodeURIComponent(wantSector)}`, label: `sector ${wantSector}` };
    if (wantYear && wantMonth) return { path: `victims/${wantYear}/${wantMonth}`, label: `${wantYear}-${String(wantMonth).padStart(2, '0')}` };
    return { path: 'recentvictims', label: 'most recent claims' };
}

log.info(`Ransomware ${theMode} | ${routeFor().label}`);

if (theMode === 'groups') {
    const res = await getJson('groups');
    const groups = Array.isArray(res.data) ? res.data : [];
    if (!groups.length) {
        await note({ note: `no group profiles returned: ${res.error || 'empty response'}; not charged` });
    }
    const filtered = wantGroup
        ? groups.filter((g) => String(g.name || '').toLowerCase().includes(wantGroup)
            || (Array.isArray(g.altname) ? g.altname : [g.altname]).some((a) => String(a || '').toLowerCase().includes(wantGroup)))
        : groups;
    if (wantGroup && !filtered.length) {
        await note({ requestedGroup: group, note: `no ransomware group matched "${group}"; not charged` });
    }
    filtered.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    for (const g of filtered) {
        if (emitted >= rowCap || pastDeadline()) break;
        const locations = Array.isArray(g.locations) ? g.locations : [];
        const alt = Array.isArray(g.altname) ? g.altname.filter(Boolean) : (clean(g.altname) ? [clean(g.altname)] : []);
        await push({
            mode: 'groups',
            ...stamp(),
            groupName: clean(g.name),
            alsoKnownAs: alt,
            description: clean(g.description),
            firstSeen: isoOrNull(g.added_date),
            leakSiteCount: locations.length,
            leakSitesOnline: locations.filter((l) => String(l.available).toLowerCase() === 'true' || l.available === true).length,
            toolsReported: Array.isArray(g.tools) ? g.tools.length : null,
            techniquesReported: Array.isArray(g.ttps) ? g.ttps.length : null,
            profileUrl: clean(g.url),
        });
    }
} else {
    const route = routeFor();
    const res = await getJson(route.path);
    const raw = Array.isArray(res.data) ? res.data : [];
    if (!raw.length) {
        await note({
            selection: route.label,
            note: `no claims returned for ${route.label}: ${res.error || 'empty response'}; country codes are two letters and sector names must match the source spelling; not charged`,
        });
    }

    const cutoff = Date.now() - back * 86400000;
    let records = raw.map(normalise).filter((r) => r.victimName || r.groupName);
    // A date filter only applies where the record carries a date; dropping
    // undated claims silently would quietly shrink the count.
    const undated = records.filter((r) => !r.claimedAt && !r.discoveredAt).length;
    records = records.filter((r) => {
        const t = Date.parse(r.claimedAt || r.discoveredAt || '');
        return Number.isFinite(t) ? t >= cutoff : true;
    });
    if (wantGroup) records = records.filter((r) => String(r.groupName || '').toLowerCase().includes(wantGroup));
    records.sort((a, b) => String(b.claimedAt || b.discoveredAt || '').localeCompare(String(a.claimedAt || a.discoveredAt || '')));

    if (!records.length && raw.length) {
        await note({
            selection: route.label, matchedBeforeFilters: raw.length,
            note: `${raw.length} claims were returned for ${route.label} but none matched the filters; widen days back or clear the group filter; not charged`,
        });
    }

    if (theMode === 'summary') {
        const counts = new Map();
        for (const r of records) {
            const key = groupBy === 'country' ? (r.country || 'unknown')
                : (groupBy === 'sector' ? (r.sector || 'unknown') : (r.groupName || 'unknown'));
            if (!counts.has(key)) counts.set(key, { claims: 0, newest: null, oldest: null, victims: new Set() });
            const c = counts.get(key);
            c.claims += 1;
            if (r.victimName) c.victims.add(r.victimName);
            const d = r.claimedAt || r.discoveredAt;
            if (d) {
                if (!c.newest || d > c.newest) c.newest = d;
                if (!c.oldest || d < c.oldest) c.oldest = d;
            }
        }
        const total = records.length;
        const sorted = [...counts.entries()].sort((a, b) => b[1].claims - a[1].claims);
        for (const [key, c] of sorted) {
            if (emitted >= rowCap || pastDeadline()) break;
            await push({
                mode: 'summary',
                ...stamp(),
                summarisedBy: groupBy,
                name: key,
                claimCount: c.claims,
                distinctVictims: c.victims.size,
                shareOfClaimsPercent: total ? round((c.claims / total) * 100, 2) : null,
                newestClaimAt: c.newest,
                oldestClaimAt: c.oldest,
                windowDays: back,
                claimsInWindow: total,
                selection: route.label,
            });
        }
    } else {
        for (const r of records) {
            if (emitted >= rowCap || pastDeadline()) break;
            await push({
                mode: 'victims',
                ...stamp(),
                ...r,
                // The source itself masks some organisation names; saying so
                // is better than shipping asterisks that look like a parse bug.
                victimNameMasked: /\*/.test(r.victimName || ''),
                // The date the group posted the claim, against the date the
                // aggregator noticed it. They are not the same thing.
                claimDateIsAttackerReported: !!r.claimedAt,
                selection: route.label,
            });
        }
        if (undated) {
            log.info(`${undated} record(s) carried no date and were kept rather than filtered out`);
        }
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; widen days back, clear filters, or check the country code and sector spelling; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
