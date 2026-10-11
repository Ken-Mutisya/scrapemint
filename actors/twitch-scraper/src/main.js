// Twitch Scraper: channels, live streams, clips, past broadcasts (VODs) and
// top categories from Twitch, by channel name, category (game), keyword
// search or the whole site, with followers, viewers, partner status, titles,
// languages and the links from each channel's About panels.
//
// Strategy
// --------
// Twitch's own web GraphQL endpoint (POST https://gql.twitch.tv/gql) with the
// public web client id every logged-out visitor sends. Tested from Apify's
// IPs on 2026-10-11 with no proxy: user, users, stream, lastBroadcast,
// videos, clips, panels, game, games, streams and searchFor all answer.
// Only channel.socialMedias fails Twitch's integrity check from datacenter
// IPs, so social links come from the About panels' link URLs instead.
//
// Every list is read as one page: follow-up pages fail the integrity check
// (see streams() below).
//
// No key, no proxy.
//
// Pay per event
// -------------
//   row ($0.001) one channel, stream, clip, video or category
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const GQL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const PERIOD = { day: 'LAST_DAY', week: 'LAST_WEEK', month: 'LAST_MONTH', all_time: 'ALL_TIME' };
const SOCIAL = [
    ['twitter', /(?:twitter|x)\.com\/(?!intent|share)/i], ['instagram', /instagram\.com\//i], ['youtube', /youtube\.com\/|youtu\.be\//i],
    ['tiktok', /tiktok\.com\//i], ['discord', /discord\.(?:gg|com)\//i], ['facebook', /facebook\.com\//i], ['kick', /kick\.com\//i],
];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'channels',
    channels = [],
    categories = [],
    searchQueries = [],
    languages = [],
    clipPeriod = 'week',
    videoType = 'archive',
    minFollowers = null,
    maxItems = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = Math.max(1, Number(maxItems) || 100);
const esc = (s) => JSON.stringify(String(s));
const langs = list(languages).map((l) => l.toUpperCase().slice(0, 2)).filter((l) => /^[A-Z]{2}$/.test(l));
const minF = Number(minFollowers) > 0 ? Number(minFollowers) : null;

async function gql(query) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(GQL, {
                method: 'POST',
                headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ query }),
                signal: AbortSignal.timeout(30_000),
            });
            const d = await r.json().catch(() => null);
            if (d?.data && !d.errors?.length) return d.data;
            if (d?.data && d.errors?.length) { log.debug(`Twitch: ${d.errors[0].message}`); return d.data; }
            const msg = d?.errors?.[0]?.message || d?.message || `HTTP ${r.status}`;
            if (r.status === 400 || /cannot represent|Unknown|Cannot query|integrity|aliases/i.test(msg)) throw Object.assign(new Error(msg), { fatal: true });
            last = new Error(msg);
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
        }
        await sleep(1500 * 2 ** attempt);
    }
    throw last;
}

const login = (v) => {
    const s = String(v).trim();
    const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})/i);
    return (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
};

// ---------- Rows ----------

const BROADCASTER = 'login displayName followers { totalCount } roles { isPartner isAffiliate }';
const iso = (s) => s || null;

function socials(panels) {
    const out = {};
    const links = [...new Set((panels || []).map((p) => p?.linkURL).filter(Boolean))];
    for (const [name, re] of SOCIAL) out[name] = links.find((u) => re.test(u)) || null;
    return { socials: out, panelLinks: links };
}

function channelRow(u) {
    const s = u.stream;
    return {
        type: 'channel',
        login: u.login,
        displayName: u.displayName || null,
        url: `https://www.twitch.tv/${u.login}`,
        description: u.description || null,
        followers: u.followers?.totalCount ?? null,
        isPartner: u.roles?.isPartner ?? null,
        isAffiliate: u.roles?.isAffiliate ?? null,
        createdAt: iso(u.createdAt),
        profileImageUrl: u.profileImageURL || null,
        isLive: Boolean(s),
        liveTitle: s?.title || null,
        liveViewers: s?.viewersCount ?? null,
        liveCategory: s?.game?.name || null,
        liveStartedAt: s?.createdAt || null,
        lastBroadcastAt: u.lastBroadcast?.startedAt || null,
        lastBroadcastTitle: u.lastBroadcast?.title || null,
        lastBroadcastCategory: u.lastBroadcast?.game?.name || null,
        ...socials(u.panels),
        scrapedAt: new Date().toISOString(),
    };
}

function streamRow(n, source) {
    const b = n.broadcaster || {};
    return {
        type: 'stream',
        login: b.login || null,
        displayName: b.displayName || null,
        url: b.login ? `https://www.twitch.tv/${b.login}` : null,
        title: n.title || null,
        viewers: n.viewersCount ?? null,
        category: n.game?.name || null,
        language: n.language || null,
        startedAt: n.createdAt || null,
        tags: (n.freeformTags || []).map((t) => t.name),
        followers: b.followers?.totalCount ?? null,
        isPartner: b.roles?.isPartner ?? null,
        thumbnailUrl: n.previewImageURL || null,
        source,
        scrapedAt: new Date().toISOString(),
    };
}

function clipRow(n, source) {
    return {
        type: 'clip',
        clipId: n.id,
        slug: n.slug || null,
        url: n.url || null,
        title: n.title || null,
        views: n.viewCount ?? null,
        durationSeconds: n.durationSeconds ?? null,
        createdAt: n.createdAt || null,
        language: n.language || null,
        broadcaster: n.broadcaster?.login || null,
        curator: n.curator?.login || null,
        category: n.game?.name || null,
        thumbnailUrl: n.thumbnailURL || null,
        source,
        scrapedAt: new Date().toISOString(),
    };
}

function videoRow(n, source) {
    return {
        type: 'video',
        videoId: n.id,
        url: `https://www.twitch.tv/videos/${n.id}`,
        title: n.title || null,
        views: n.viewCount ?? null,
        lengthSeconds: n.lengthSeconds ?? null,
        publishedAt: n.publishedAt || null,
        videoType: n.broadcastType || null,
        broadcaster: n.owner?.login || null,
        category: n.game?.name || null,
        thumbnailUrl: n.previewThumbnailURL && !/404_processing/.test(n.previewThumbnailURL) ? n.previewThumbnailURL : null,
        source,
        scrapedAt: new Date().toISOString(),
    };
}

function categoryRow(n, rank) {
    return {
        type: 'category',
        rank,
        categoryId: n.id,
        name: n.displayName || n.name,
        url: `https://www.twitch.tv/directory/category/${encodeURIComponent(String(n.name).toLowerCase().replace(/\s+/g, '-'))}`,
        viewers: n.viewersCount ?? null,
        liveChannels: n.broadcastersCount ?? null,
        followers: n.followersCount ?? null,
        tags: (n.tags || []).map((t) => t.localizedName).filter(Boolean),
        boxArtUrl: n.boxArtURL || null,
        scrapedAt: new Date().toISOString(),
    };
}

// ---------- Sources (each yields arrays of rows) ----------

const CHANNEL = `id login displayName description createdAt profileImageURL(width: 300) followers { totalCount } roles { isPartner isAffiliate }
 stream { title viewersCount createdAt game { name } } lastBroadcast { startedAt title game { name } }
 panels { ... on DefaultPanel { linkURL } }`;
const STREAM = `id title viewersCount createdAt language previewImageURL(width: 640, height: 360) freeformTags { name } game { name } broadcaster { ${BROADCASTER} }`;
const CLIP = 'id slug title viewCount createdAt durationSeconds url language thumbnailURL(width: 480, height: 272) broadcaster { login } curator { login } game { name }';
const VIDEO = 'id title viewCount lengthSeconds publishedAt broadcastType previewThumbnailURL(width: 640, height: 360) game { name } owner { login }';

async function* channelsByLogin(logins) {
    for (let i = 0; i < logins.length; i += 10) {
        const chunk = logins.slice(i, i + 10);
        const d = await gql(`query { ${chunk.map((l, k) => `u${k}: user(login: ${esc(l)}) { ${CHANNEL} }`).join(' ')} }`);
        const rows = [];
        chunk.forEach((l, k) => {
            const u = d[`u${k}`];
            if (u) rows.push(channelRow(u));
            else rows.push({ type: 'error', login: l, error: `No Twitch channel "${l}". Not charged.` });
        });
        yield rows;
    }
}

// One request per list: Twitch rejects every follow-up page (after: cursor)
// with "failed integrity check", from home and datacenter IPs alike
// (2026-10-11). The first page holds up to 100 games, clips or videos and up
// to 30 streams, so stream lists are read once per sort order (top viewers,
// fewest viewers, most recent) and per language, and merged.
const STREAM_SORTS = ['VIEWER_COUNT', 'VIEWER_COUNT_ASC', 'RECENT'];

async function once(query, pick, toRow) {
    const d = await gql(query);
    return (pick(d)?.edges || []).map((e) => toRow(e.node)).filter(Boolean);
}

// Streams of a category (or the whole site): every sort x language.
async function* streams(cat, toRow) {
    const langList = langs.length ? langs : [null];
    for (const lang of langList) {
        for (const sort of STREAM_SORTS) {
            // Category streams take language strings, site-wide streams the enum.
            const opt = cat
                ? `options: { sort: ${sort}${lang ? `, languages: [${esc(lang.toLowerCase())}]` : ''} }`
                : `options: { sort: ${sort}${lang ? `, languages: [${lang}]` : ''} }`;
            yield await once(
                cat ? `query { game(name: ${esc(cat)}) { streams(first: 30, ${opt}) { edges { node { ${STREAM} } } } } }`
                    : `query { streams(first: 30, ${opt}) { edges { node { ${STREAM} } } } }`,
                (d) => (cat ? d.game?.streams : d.streams),
                toRow,
            );
        }
    }
}

function sources() {
    const out = [];
    const logins = list(channels).map(login);
    const cats = list(categories);
    const qs = list(searchQueries);
    const period = PERIOD[clipPeriod] || 'LAST_WEEK';
    const vtypes = videoType === 'all' ? ['ARCHIVE', 'HIGHLIGHT', 'UPLOAD'] : [{ archive: 'ARCHIVE', highlight: 'HIGHLIGHT', upload: 'UPLOAD' }[videoType] || 'ARCHIVE'];
    switch (mode) {
        case 'channels':
            if (logins.length) out.push({ label: `${logins.length} channel(s)`, gen: () => channelsByLogin(logins) });
            for (const q of qs) {
                out.push({
                    label: `channel search "${q}"`,
                    gen: async function* () {
                        const d = await gql(`query { searchFor(userQuery: ${esc(q)}, platform: "web", target: { index: CHANNEL, limit: 100 }) { channels { edges { item { ... on User { login } } } } } }`);
                        yield* channelsByLogin((d.searchFor?.channels?.edges || []).map((e) => e.item?.login).filter(Boolean));
                    },
                });
            }
            for (const c of cats) {
                out.push({
                    label: `live channels in ${c}`,
                    gen: async function* () {
                        const found = new Set();
                        for await (const rows of streams(c, (n) => n.broadcaster?.login)) rows.forEach((l) => found.add(l));
                        yield* channelsByLogin([...found]);
                    },
                });
            }
            break;
        case 'live_streams':
            if (cats.length) for (const c of cats) out.push({ label: `live in ${c}`, gen: () => streams(c, (n) => streamRow(n, `live in ${c}`)) });
            else out.push({ label: 'live streams site-wide', gen: () => streams(null, (n) => streamRow(n, 'live streams site-wide')) });
            break;
        case 'clips':
            for (const l of logins) out.push({ label: `clips of ${l}`, gen: async function* () { yield await once(`query { user(login: ${esc(l)}) { clips(first: 100, criteria: { period: ${period}, sort: VIEWS_DESC }) { edges { node { ${CLIP} } } } } }`, (d) => d.user?.clips, (n) => clipRow(n, `clips of ${l}`)); } });
            for (const c of cats) out.push({ label: `clips in ${c}`, gen: async function* () { yield await once(`query { game(name: ${esc(c)}) { clips(first: 100, criteria: { period: ${period}, sort: VIEWS_DESC }) { edges { node { ${CLIP} } } } } }`, (d) => d.game?.clips, (n) => clipRow(n, `clips in ${c}`)); } });
            break;
        case 'videos':
            for (const l of logins) {
                out.push({
                    label: `videos of ${l}`,
                    gen: async function* () {
                        for (const t of vtypes) yield await once(`query { user(login: ${esc(l)}) { videos(first: 100, type: ${t}, sort: TIME) { edges { node { ${VIDEO} } } } } }`, (d) => d.user?.videos, (n) => videoRow(n, `videos of ${l}`));
                    },
                });
            }
            break;
        case 'top_categories': {
            let rank = 0;
            out.push({ label: 'top categories', gen: async function* () { yield await once('query { games(first: 100) { edges { node { id name displayName viewersCount broadcastersCount followersCount boxArtURL(width: 285, height: 380) tags(tagType: CONTENT) { localizedName } } } } }', (d) => d.games, (n) => categoryRow(n, ++rank)); } });
            break;
        }
        default:
            break;
    }
    return out;
}

// ---------- Run ----------

let rowsOut = 0;
let keepGoing = true;
const failures = [];
const perSource = [];
const seen = new Set();

async function charge() {
    try {
        const res = await Actor.charge({ eventName: 'row' });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

const srcs = sources();
if (!srcs.length) {
    const msg = {
        channels: 'Add channels, search keywords or categories.',
        clips: 'Add channels or categories to get clips from.',
        videos: 'Add channels to get their videos.',
    }[mode] || `Unknown mode "${mode}".`;
    log.warning(msg);
    await Actor.pushData({ type: 'error', error: `${msg} Not charged.` });
}

for (const s of srcs) {
    if (!keepGoing) break;
    let n = 0;
    try {
        for await (const batch of s.gen()) {
            for (const r of batch) {
                if (!keepGoing || n >= cap) break;
                if (r.type === 'error') { await Actor.pushData(r); failures.push({ source: s.label, error: r.error }); continue; }
                const key = `${r.type}:${r.login || r.clipId || r.videoId || r.categoryId}`;
                if (seen.has(key)) continue;
                if (minF && (r.type === 'channel' || r.type === 'stream') && (r.followers ?? 0) < minF) continue;
                seen.add(key);
                await Actor.pushData(r);
                rowsOut += 1;
                n += 1;
                if (!(await charge())) keepGoing = false;
            }
            if (!keepGoing || n >= cap) break;
        }
    } catch (err) {
        log.warning(`${s.label}: ${err?.message}`);
        failures.push({ source: s.label, error: String(err?.message || err) });
    }
    log.info(`${s.label}: ${n} row(s).`);
    perSource.push({ source: s.label, rows: n });
}

if (!rowsOut && srcs.length) await Actor.pushData({ type: 'note', note: 'Nothing found. Not charged.' });
await Actor.setValue('SUMMARY', { rows: rowsOut, sources: perSource, failures });
log.info(`Done. ${rowsOut} row(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
