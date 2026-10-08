// Spotify Scraper: play counts, monthly listeners, followers, world rank and
// top cities for artists, albums, tracks and playlists, by URL or search.
//
// Strategy
// --------
// Spotify's web player reads everything from one GraphQL endpoint
// (api-partner.spotify.com/pathfinder/v2/query) with persisted queries, and
// the embed page (open.spotify.com/embed/...) hands out an anonymous access
// token. No key, no login, no proxy (answered Apify's IPs in the 2026-10-08
// probe). Play counts are only in this API, not in Spotify's public Web API.
//
// Persisted-query hashes change when Spotify ships a new web player, so they
// are read at start from the player's own JavaScript: the main bundles, plus
// the artist and search route chunks (found through the webpack chunk map).
// The hashes below are a fallback, current on 2026-10-08.
//
// Pay per event
// -------------
//   artist_profile ($0.004) one artist: listeners, followers, rank, cities,
//                           bio, socials, top tracks with play counts
//   item_row       ($0.0015) one album (with every track's play count), track
//                           or playlist row, or one playlist track
// No start fee. Items Spotify does not find are returned free.

import { Actor, log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const API = 'https://api-partner.spotify.com/pathfinder/v2/query';
const CDN = 'https://open.spotifycdn.com/cdn/build/web-player/';
const FALLBACK = {
    queryArtistOverview: '9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6',
    queryArtistDiscographyAll: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
    getAlbum: '6a74b456cd1735c9193d9e8ec8cc5184cad7ce13572210315229db3975964361',
    getTrack: 'a8ef9e9f02b836feb0da3003c31dbb30decc6f4b473ef89ca88c882386d668de',
    fetchPlaylist: '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a',
    searchArtists: '7bf95d754fdbe32c8b161fbbe54d1ae50974900df4dce4c8f1afcbcad153224d',
    searchTracks: 'b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751',
    searchAlbums: '202cb3305e31e5a0767ba7925f28bd728cf8f8b0217e6da43909056071cd70e9',
    searchPlaylists: 'd520014e748f9ea44f7707d8df1819867ac1205e8b7f3e28f22fe5fc858921b1',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    urls = [],
    searchTerms = [],
    searchType = 'artists',
    maxSearchResults = 1,
    includeDiscography = false,
    maxReleasesPerArtist = 50,
    playlistTracks = true,
    maxTracksPerPlaylist = 500,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const idOf = (uri) => String(uri || '').split(':').pop();
const webUrl = (uri) => { const [, type, id] = String(uri || '').split(':'); return type && id ? `https://open.spotify.com/${type}/${id}` : null; };
const biggest = (sources) => (sources || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;

// ---------- Hashes and token ----------

const hashes = { ...FALLBACK };

async function text(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.text();
}

async function loadHashes() {
    try {
        const home = await text('https://open.spotify.com/');
        const bundles = [...new Set(home.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/[^"']+\.js/g) || [])];
        const sources = [];
        for (const u of bundles) sources.push(await text(u).catch(() => ''));
        // Webpack chunk map: ({id:"name"...}[e]||e)+"."+({id:"hash"...})[e]+".js"
        const main = sources.find((s) => s.includes('xpui-routes-artist')) || '';
        const i = main.indexOf('xpui-routes-artist');
        const start = main.lastIndexOf('=>""+(({', i);
        const end = main.indexOf('[e]+".js"', i);
        if (start > 0 && end > 0) {
            const [a, b] = main.slice(start, end).split('})[e]||e)+"."+({');
            const ids = Object.fromEntries([...(a || '').matchAll(/(\d+):"([a-z0-9-]+)"/g)].map((m) => [m[2], m[1]]));
            const hs = Object.fromEntries([...(b || '').matchAll(/(\d+):"([0-9a-f]{8})"/g)].map((m) => [m[1], m[2]]));
            for (const name of ['xpui-routes-artist', 'xpui-routes-search']) {
                if (ids[name] && hs[ids[name]]) sources.push(await text(`${CDN}${name}.${hs[ids[name]]}.js`).catch(() => ''));
            }
        }
        let n = 0;
        for (const s of sources) {
            for (const m of s.matchAll(/"([a-zA-Z]+)","query","([0-9a-f]{64})"/g)) {
                if (m[1] in FALLBACK && hashes[m[1]] !== m[2]) { hashes[m[1]] = m[2]; n += 1; }
            }
        }
        log.info(n ? `Spotify web player updated ${n} query hash(es).` : 'Spotify query hashes are current.');
    } catch (err) {
        log.warning(`Could not read the web player for query hashes, using built-in ones: ${err?.message}`);
    }
}

let token = '';
async function refreshToken() {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const html = await text('https://open.spotify.com/embed/artist/0TnOYISbd1XYRBk9myaseg');
            const t = html.match(/"accessToken":"([^"]+)"/)?.[1];
            if (t) { token = t; return; }
        } catch (err) { log.debug(`token: ${err?.message}`); }
        await sleep(1500 * 2 ** attempt);
    }
    throw new Error('Could not get an anonymous Spotify token.');
}

async function query(operationName, variables) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const r = await fetch(API, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA, 'app-platform': 'WebPlayer' },
                body: JSON.stringify({ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash: hashes[operationName] } } }),
                signal: AbortSignal.timeout(30_000),
            });
            if (r.ok) {
                const j = await r.json();
                if (j?.data) return j.data;
                last = new Error(j?.errors?.[0]?.message || 'empty response');
            } else {
                last = new Error(`HTTP ${r.status}`);
                if (r.status === 401) await refreshToken();
            }
        } catch (err) { last = err; }
        await sleep(1000 * 2 ** attempt);
    }
    throw last;
}

// ---------- Parsers ----------

const artistsOf = (items) => (items || []).map((a) => ({ id: a.id || idOf(a.uri), name: a.profile?.name || null }));

function trackOf(t, extra = {}) {
    return {
        id: t.id || idOf(t.uri),
        name: t.name,
        url: webUrl(t.uri),
        playcount: num(t.playcount),
        durationMs: t.duration?.totalMilliseconds ?? t.trackDuration?.totalMilliseconds ?? null,
        explicit: t.contentRating?.label === 'EXPLICIT',
        trackNumber: t.trackNumber ?? null,
        discNumber: t.discNumber ?? null,
        artists: artistsOf(t.artists?.items || [t.firstArtist?.items?.[0], ...(t.otherArtists?.items || [])].filter(Boolean)),
        ...extra,
    };
}

async function artist(uri) {
    const d = await query('queryArtistOverview', { uri, locale: '', includePrerelease: true });
    const a = d?.artistUnion;
    if (!a || a.__typename === 'NotFound') return null;
    const disc = a.discography || {};
    const latest = disc.latest;
    return {
        rowType: 'artist',
        id: a.id,
        name: a.profile?.name,
        url: webUrl(a.uri),
        monthlyListeners: a.stats?.monthlyListeners ?? null,
        followers: a.stats?.followers ?? null,
        worldRank: a.stats?.worldRank || null,
        topCities: (a.stats?.topCities?.items || []).map((c) => ({ city: c.city, country: c.country, region: c.region, listeners: c.numberOfListeners })),
        biography: (a.profile?.biography?.text || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim() || null,
        externalLinks: Object.fromEntries((a.profile?.externalLinks?.items || []).map((l) => [l.name.toLowerCase(), l.url])),
        avatarUrl: biggest(a.visuals?.avatarImage?.sources),
        headerImageUrl: biggest(a.headerImage?.data?.sources),
        topTracks: (disc.topTracks?.items || []).map((x) => trackOf(x.track, { albumId: idOf(x.track?.albumOfTrack?.uri) })),
        releaseCounts: { albums: disc.albums?.totalCount ?? null, singles: disc.singles?.totalCount ?? null, compilations: disc.compilations?.totalCount ?? null },
        latestRelease: latest ? { id: latest.id, name: latest.name, type: latest.type, date: latest.date?.isoString?.slice(0, 10) || (latest.date?.year ? String(latest.date.year) : null), url: webUrl(latest.uri) } : null,
        relatedArtists: (a.relatedContent?.relatedArtists?.items || []).map((r) => ({ id: r.id, name: r.profile?.name, url: webUrl(r.uri) })),
    };
}

async function discography(uri, max) {
    const out = [];
    for (let offset = 0; out.length < max; offset += 50) {
        const d = await query('queryArtistDiscographyAll', { uri, offset, limit: 50, order: 'DATE_DESC' });
        const all = d?.artistUnion?.discography?.all;
        for (const it of all?.items || []) for (const r of it.releases?.items || []) if (out.length < max) out.push(r.uri || `spotify:album:${r.id}`);
        if (!all || offset + 50 >= (all.totalCount || 0)) break;
    }
    return out;
}

async function album(uri) {
    let a = null;
    const tracks = [];
    for (let offset = 0; ; offset += 50) {
        const d = await query('getAlbum', { uri, locale: '', offset, limit: 50 });
        const u = d?.albumUnion;
        if (!u || u.__typename === 'NotFound') return null;
        a = a || u;
        for (const it of u.tracksV2?.items || []) tracks.push(trackOf(it.track));
        if (offset + 50 >= (u.tracksV2?.totalCount || 0)) break;
    }
    const plays = tracks.map((t) => t.playcount).filter((p) => p != null);
    return {
        rowType: 'album',
        id: idOf(a.uri),
        name: a.name,
        url: webUrl(a.uri),
        albumType: a.type || null,
        releaseDate: a.date?.isoString?.slice(0, 10) || null,
        label: a.label || null,
        copyright: (a.copyright?.items || []).map((c) => c.text),
        artists: artistsOf(a.artists?.items),
        totalTracks: a.tracksV2?.totalCount ?? tracks.length,
        totalPlaycount: plays.length ? plays.reduce((s, p) => s + p, 0) : null,
        coverUrl: biggest(a.coverArt?.sources),
        tracks,
    };
}

async function track(uri) {
    const d = await query('getTrack', { uri });
    const t = d?.trackUnion;
    if (!t || t.__typename === 'NotFound') return null;
    return {
        rowType: 'track',
        ...trackOf(t),
        album: t.albumOfTrack ? { id: idOf(t.albumOfTrack.uri), name: t.albumOfTrack.name || null, releaseDate: t.albumOfTrack.date?.isoString?.slice(0, 10) || null, url: webUrl(t.albumOfTrack.uri) } : null,
        coverUrl: biggest(t.albumOfTrack?.coverArt?.sources),
    };
}

async function* playlist(uri, maxTracks) {
    let head = null;
    let pos = 0;
    for (let offset = 0; ; offset += 100) {
        const d = await query('fetchPlaylist', { uri, offset, limit: 100, enableWatchFeedEntrypoint: false });
        const p = d?.playlistV2;
        if (!p || p.__typename !== 'Playlist') { if (!head) yield null; return; }
        if (!head) {
            head = {
                rowType: 'playlist',
                id: idOf(p.uri),
                name: p.name,
                url: webUrl(p.uri),
                description: (p.description || '').replace(/<[^>]+>/g, '') || null,
                owner: p.ownerV2?.data ? { name: p.ownerV2.data.name, username: p.ownerV2.data.username, url: webUrl(p.ownerV2.data.uri) } : null,
                followers: p.followers ?? null,
                totalTracks: p.content?.totalCount ?? null,
                imageUrl: biggest(p.images?.items?.[0]?.sources),
            };
            yield head;
        }
        if (!playlistTracks) return;
        const items = p.content?.items || [];
        for (const it of items) {
            const t = it.itemV2?.data;
            if (!t || t.__typename !== 'Track') continue;
            pos += 1;
            if (pos > maxTracks) return;
            yield {
                rowType: 'playlist_track',
                playlistId: head.id,
                playlistName: head.name,
                position: pos,
                addedAt: it.addedAt?.isoString || null,
                ...trackOf(t),
                album: t.albumOfTrack ? { id: idOf(t.albumOfTrack.uri), name: t.albumOfTrack.name || null, url: webUrl(t.albumOfTrack.uri) } : null,
            };
        }
        if (!items.length || offset + 100 >= (p.content?.totalCount || 0)) return;
    }
}

// ---------- Inputs ----------

// open.spotify.com/intl-de/artist/<id>?si=..., spotify:artist:<id>, or a bare 22-char id (artist)
function toUri(s) {
    const m = s.match(/(artist|album|track|playlist)[/:]([A-Za-z0-9]{22})/);
    if (m) return `spotify:${m[1]}:${m[2]}`;
    if (/^[A-Za-z0-9]{22}$/.test(s)) return `spotify:artist:${s}`;
    return null;
}

const SEARCH = {
    artists: { op: 'searchArtists', key: 'artists', uri: (it) => it.data?.uri },
    tracks: { op: 'searchTracks', key: 'tracksV2', uri: (it) => it.item?.data?.uri },
    albums: { op: 'searchAlbums', key: 'albumsV2', uri: (it) => it.data?.uri },
    playlists: { op: 'searchPlaylists', key: 'playlists', uri: (it) => it.data?.uri },
};

async function searchUris(term, type, max) {
    const s = SEARCH[type] || SEARCH.artists;
    const d = await query(s.op, {
        searchTerm: term, offset: 0, limit: Math.min(50, max), numberOfTopResults: 5,
        includeAudiobooks: false, includePreReleases: false, includeAuthors: false,
        includeEpisodeContentRatingsV2: false, includeArtistHasConcertsField: false,
    });
    return (d?.searchV2?.[s.key]?.items || []).map(s.uri).filter(Boolean).slice(0, max);
}

// ---------- Run ----------

const counts = { artist: 0, album: 0, track: 0, playlist: 0, playlist_track: 0 };
let keepGoing = true;
const failures = [];
const done = new Set();

async function charge(eventName) {
    try {
        const r = await Actor.charge({ eventName });
        if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function push(row, source) {
    await Actor.pushData({ ...row, source, scrapedAt: new Date().toISOString() });
    counts[row.rowType] += 1;
    if (!(await charge(row.rowType === 'artist' ? 'artist_profile' : 'item_row'))) keepGoing = false;
}

async function handle(uri, source) {
    if (done.has(uri) || !keepGoing) return;
    done.add(uri);
    const type = uri.split(':')[1];
    try {
        if (type === 'artist') {
            const row = await artist(uri);
            if (!row) throw Object.assign(new Error('Artist not found'), { notFound: true });
            await push(row, source);
            if (includeDiscography && keepGoing) {
                const releases = await discography(uri, Math.max(1, Number(maxReleasesPerArtist) || 50));
                log.info(`${row.name}: ${releases.length} release(s).`);
                for (const r of releases) { if (!keepGoing) break; await handle(r, `discography:${row.name}`); }
            }
        } else if (type === 'album') {
            const row = await album(uri);
            if (!row) throw Object.assign(new Error('Album not found'), { notFound: true });
            await push(row, source);
        } else if (type === 'track') {
            const row = await track(uri);
            if (!row) throw Object.assign(new Error('Track not found'), { notFound: true });
            await push(row, source);
        } else if (type === 'playlist') {
            for await (const row of playlist(uri, Math.max(0, Number(maxTracksPerPlaylist) || 500))) {
                if (!row) throw Object.assign(new Error('Playlist not found or private'), { notFound: true });
                if (!keepGoing) break;
                await push(row, source);
            }
        }
    } catch (err) {
        log.warning(`${uri}: ${err?.message}`);
        failures.push({ uri, error: String(err?.message || err) });
        await Actor.pushData({ rowType: 'error', uri, url: webUrl(uri), error: `${err?.message}. Not charged.`, source });
    }
}

const uris = [];
const bad = [];
for (const s of list(urls)) { const u = toUri(s); if (u) uris.push(u); else bad.push(s); }
for (const s of bad) await Actor.pushData({ rowType: 'error', url: s, error: 'Not a Spotify artist, album, track or playlist URL. Not charged.' });
const terms = list(searchTerms);

if (!uris.length && !terms.length) {
    await Actor.pushData({ rowType: 'note', note: 'Add Spotify URLs or search terms. Not charged.' });
    await Actor.exit();
}

await loadHashes();
await refreshToken();

for (const term of terms) {
    if (!keepGoing) break;
    try {
        const found = await searchUris(term, searchType, Math.max(1, Number(maxSearchResults) || 1));
        log.info(`Search "${term}" (${searchType}): ${found.length} result(s).`);
        for (const u of found) { if (!keepGoing) break; await handle(u, `search:${term}`); }
    } catch (err) {
        log.warning(`Search "${term}": ${err?.message}`);
        failures.push({ search: term, error: String(err?.message || err) });
    }
}
for (const u of uris) { if (!keepGoing) break; await handle(u, 'url'); }

await Actor.setValue('SUMMARY', { ...counts, failures });
log.info(`Done. ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
