// Package Adoption Tracker: npm & PyPI Download Trends
//
// Strategy
// --------
// Stars are vanity; installs are not. Two keyless registries publish real
// download counts: npm (api.npmjs.org) and PyPI (pypistats.org). Three modes:
//   trends    per package: last 7 days, the 7 before that, growth percent and
//             the 30 day total, so adoption direction is visible not just size
//   discover  search npm by keyword, take the highest ranked packages and join
//             them to downloads and growth, which answers "what is actually
//             growing in this space" rather than "what did someone star"
//   history   the daily download series, one row per package per day
//
// Growth is derived from ONE bulk range call rather than two dated point calls,
// because npm's numbers lag by several days and the lag moves. Slicing the
// returned series into its own last-7 and prior-7 buckets stays correct no
// matter where the registry has got to.
//
// Source quirks handled
// ---------------------
//   - npm bulk lookups REJECT scoped packages outright ("scoped packages are
//     not currently supported in bulk lookups"), so @scope/name is fetched
//     one at a time and merged back in. The default input deliberately
//     includes a scoped package so this path is always exercised.
//   - Bulk responses cap at 128 packages; 129 is a hard error, so requests are
//     chunked.
//   - An unknown package in a bulk response comes back as a null VALUE with no
//     error, so a typo looks like a successful lookup unless it is checked.
//   - PyPI has no keyless search and pypistats publishes totals rather than a
//     series, so discover and history are npm only, and PyPI rows carry no
//     growth. pypistats also rate limits hard, one package per call.
//
// Pay per event
// -------------
//   package_row ($0.003) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const BULK_MAX = 128;
const FETCH_TIMEOUT_MS = 45000;
const PYPI_SPACING_MS = 1200;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'trends',
    registry = 'npm',
    packages = ['langchain', '@langchain/core', 'openai', 'llamaindex', 'ai'],
    searchQuery = 'vector database',
    searchLimit = 20,
    minWeeklyDownloads = 0,
    includeMetadata = false,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['trends', 'discover', 'history'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'trends';
const theRegistry = String(registry).toLowerCase() === 'pypi' ? 'pypi' : 'npm';
const pkgList = [...new Set(asList(packages))].slice(0, 500);
const searchCap = Math.max(1, Math.min(250, Number(searchLimit) || 20));
const weeklyFloor = Math.max(0, Number(minWeeklyDownloads) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Scrapemint Package Adoption Tracker (admin@scrapemint.com)' },
        });
        if (res.status === 429) {
            log.warning('Rate limited, backing off 5s');
            await new Promise((r) => setTimeout(r, 5000));
            const retry = await fetch(url, { headers: { accept: 'application/json' } });
            return retry.ok ? await retry.json() : null;
        }
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed for ${url.slice(0, 80)}: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'package_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const isScoped = (name) => name.startsWith('@');
const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

// Returns Map<packageName, [{day, downloads}, ...]> for the last 30 days.
async function npmSeries(names) {
    const series = new Map();
    const plain = names.filter((n) => !isScoped(n));
    const scoped = names.filter(isScoped);

    for (const group of chunk(plain, BULK_MAX)) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const j = await getJson(`https://api.npmjs.org/downloads/range/last-month/${group.map(encodeURIComponent).join(',')}`);
        if (!j) continue;
        // A single-name request answers with the bare object, not a name map.
        if (j.package && Array.isArray(j.downloads)) {
            series.set(j.package, j.downloads);
            continue;
        }
        for (const [name, val] of Object.entries(j)) {
            // Unknown packages come back as null rather than as an error.
            if (!val || !Array.isArray(val.downloads)) { log.warning(`npm: no data for ${name}`); continue; }
            series.set(name, val.downloads);
        }
    }
    // Scoped names are rejected by bulk, so they go one at a time.
    for (const name of scoped) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const j = await getJson(`https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(name)}`);
        if (!j || !Array.isArray(j.downloads)) { log.warning(`npm: no data for ${name}`); continue; }
        series.set(j.package || name, j.downloads);
    }
    return series;
}

// Slice the registry's own returned days rather than trusting today's date:
// npm lags by several days and the lag moves.
function bucket(days) {
    const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
    const last7 = sorted.slice(-7);
    const prior7 = sorted.slice(-14, -7);
    const sum = (rows) => rows.reduce((t, r) => t + (num(r.downloads) ?? 0), 0);
    const lastWeek = sum(last7);
    const priorWeek = sum(prior7);
    return {
        lastWeek,
        priorWeek,
        growthPercent: priorWeek > 0 ? round(((lastWeek - priorWeek) / priorWeek) * 100, 2) : null,
        last30Days: sum(sorted),
        averagePerDay: sorted.length ? Math.round(sum(sorted) / sorted.length) : null,
        windowStart: sorted[0]?.day ?? null,
        windowEnd: sorted[sorted.length - 1]?.day ?? null,
        days: sorted,
    };
}

async function npmMetadata(name) {
    const j = await getJson(`https://registry.npmjs.org/${name.split('/').map(encodeURIComponent).join('/')}`);
    if (!j) return {};
    const latest = j['dist-tags']?.latest;
    const times = j.time || {};
    const repo = typeof j.repository === 'string' ? j.repository : j.repository?.url;
    return {
        latestVersion: latest ?? null,
        license: typeof j.license === 'string' ? j.license : j.license?.type ?? null,
        description: j.description ?? null,
        repository: repo ? String(repo).replace(/^git\+/, '').replace(/\.git$/, '') : null,
        lastPublishedAt: latest && times[latest] ? times[latest] : times.modified ?? null,
        versionCount: Object.keys(j.versions || {}).length || null,
    };
}

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Package adoption ${theMode} | registry ${theRegistry}`
    + (theMode === 'discover' ? ` | search "${searchQuery}" top ${searchCap}` : ` | ${pkgList.length} package(s)`)
    + ` | cap ${cap} rows`);

if (theRegistry === 'pypi') {
    if (theMode !== 'trends') {
        await flushRow({
            type: 'note', registry: 'pypi', found: false,
            note: 'PyPI supports trends only: it publishes no keyless search and no daily series, so discover and history are npm only; not charged',
        }, false);
    }
    for (const name of pkgList) {
        if (stopEarly()) break;
        const j = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`);
        const d = j?.data;
        if (!d) {
            await flushRow({ type: 'note', registry: 'pypi', packageName: name, found: false, note: 'no PyPI download data for this package; not charged' }, false);
            continue;
        }
        const lastWeek = num(d.last_week);
        if (weeklyFloor && (lastWeek ?? 0) < weeklyFloor) continue;
        await flushRow({
            mode: 'trends',
            registry: 'pypi',
            packageName: j.package || name,
            lastDay: num(d.last_day),
            lastWeek,
            lastMonth: num(d.last_month),
            // pypistats publishes totals, not a series, so there is no
            // prior-week figure to compare against.
            growthPercent: null,
            url: `https://pypi.org/project/${name}/`,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
        await new Promise((r) => setTimeout(r, PYPI_SPACING_MS));
    }
} else {
    let names = pkgList;
    const searchMeta = new Map();

    if (theMode === 'discover') {
        const j = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=${searchCap}`);
        const objects = j?.objects || [];
        names = [];
        for (const o of objects) {
            const p = o.package || {};
            if (!p.name) continue;
            names.push(p.name);
            searchMeta.set(p.name, {
                searchScore: round(num(o.score?.final), 4),
                searchRank: names.length,
                description: p.description ?? null,
                latestVersion: p.version ?? null,
                lastPublishedAt: p.date ?? null,
                repository: p.links?.repository ?? null,
            });
        }
        log.info(`npm search "${searchQuery}": ${j?.total ?? 0} total, taking ${names.length}`);
        if (!names.length) {
            await flushRow({ type: 'note', registry: 'npm', found: false, note: `no npm packages matched "${searchQuery}"; not charged`, searchQuery }, false);
        }
    }

    const series = names.length ? await npmSeries(names) : new Map();

    const rows = [];
    for (const name of names) {
        const days = series.get(name);
        if (!days) continue;
        const b = bucket(days);
        if (weeklyFloor && b.lastWeek < weeklyFloor) continue;
        rows.push({ name, b });
    }
    if (!rows.length && names.length) {
        await flushRow({
            type: 'note', registry: 'npm', found: false,
            note: weeklyFloor
                ? `no packages cleared ${weeklyFloor} weekly downloads; not charged`
                : 'no download data returned for these packages; check the names; not charged',
        }, false);
    }

    // Discover ranks by growth, since the point is finding what is rising.
    if (theMode === 'discover') rows.sort((a, b) => (b.b.growthPercent ?? -Infinity) - (a.b.growthPercent ?? -Infinity));
    else rows.sort((a, b) => b.b.lastWeek - a.b.lastWeek);

    for (const { name, b } of rows) {
        if (stopEarly()) break;
        if (theMode === 'history') {
            for (const d of b.days) {
                if (stopEarly()) break;
                await flushRow({
                    mode: 'history',
                    registry: 'npm',
                    packageName: name,
                    day: d.day,
                    downloads: num(d.downloads),
                    scrapedAt: new Date().toISOString(),
                });
                emitted += 1;
            }
            continue;
        }
        const meta = searchMeta.get(name) || (includeMetadata ? await npmMetadata(name) : {});
        await flushRow({
            mode: theMode,
            registry: 'npm',
            packageName: name,
            scoped: isScoped(name),
            lastWeek: b.lastWeek,
            priorWeek: b.priorWeek,
            growthPercent: b.growthPercent,
            last30Days: b.last30Days,
            averagePerDay: b.averagePerDay,
            windowStart: b.windowStart,
            windowEnd: b.windowEnd,
            ...meta,
            url: `https://www.npmjs.com/package/${name}`,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
