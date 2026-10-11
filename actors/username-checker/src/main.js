// Username Checker: which sites have an account with a given username. For
// each username and site, one row saying taken, available or unknown, with
// the profile URL when taken. Useful for brand-name and handle availability
// checks before a launch, for brand protection (who holds your name), and
// for finding a creator's or company's other profiles.
//
// Strategy
// --------
// Each site in sites.js has one existence check against a public endpoint:
// an official API where there is one (GitLab, npm, Docker Hub, Hacker News,
// Chess.com, Lichess, Mojang, Roblox, Bluesky, Mastodon, Wikipedia...), the
// site's own GraphQL (Twitch, Medium, LeetCode), or the profile page's status
// code or a marker in its HTML. A site ships only if, from Apify's IPs with
// no proxy, its check said "taken" for a known account and "available" for a
// random name (self-test, input _selfTest: true). Anything else (blocked,
// rate-limited, a page that matches neither rule) is reported as "unknown",
// never guessed.
//
// No key, no proxy.
//
// Pay per event
// -------------
//   check ($0.0005) one username on one site, with a taken or available answer
// No start fee. "unknown" answers are free.

import { Actor, log } from 'apify';
import { SITES } from './sites.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    usernames = [],
    categories = [],
    sites: onlySites = [],
    onlyTaken = false,
    _selfTest = false,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(site, username) {
    const c = site.check;
    const url = c.url(username);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await fetch(url, {
                method: c.method || 'GET',
                headers: { 'User-Agent': UA, Accept: c.kind === 'json' ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(c.body ? { 'Content-Type': 'application/json' } : {}), ...(c.headers || {}) },
                body: c.body ? c.body(username) : undefined,
                redirect: 'follow',
                signal: AbortSignal.timeout(20_000),
            });
            const status = r.status;
            if (status === 429 || status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
            if (c.redirectAvailable && c.redirectAvailable.test(r.url) && r.url !== url) return { state: 'available', status };
            if (c.kind === 'status') {
                if (status === 200) return { state: 'taken', status };
                if ((c.availableStatus || [404, 410]).includes(status)) return { state: 'available', status };
                return { state: 'unknown', status };
            }
            if (c.kind === 'json') {
                if ((c.availableStatus || [404]).includes(status)) return { state: 'available', status };
                if (status !== 200) return { state: 'unknown', status };
                const text = await r.text();
                let d = null;
                try { d = text ? JSON.parse(text) : null; } catch { return { state: 'unknown', status }; }
                return { state: c.taken(d) ? 'taken' : 'available', status, data: d };
            }
            if (c.kind === 'body') {
                const text = await r.text();
                const has = (p) => (p instanceof RegExp ? p.test(text) : text.includes(p));
                if (status === 404) return { state: 'available', status };
                if (c.taken && has(c.taken)) return { state: 'taken', status };
                if (c.available && has(c.available)) return { state: 'available', status };
                return { state: 'unknown', status };
            }
        } catch (err) {
            if (attempt === 2) return { state: 'unknown', status: null, error: String(err?.message || err) };
            await sleep(1000);
        }
    }
    return { state: 'unknown', status: 429 };
}

// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

// ---------- Self-test: which sites can ship ----------

if (_selfTest) {
    const random = `zq${Math.random().toString(36).slice(2, 10)}x9`;
    const results = await pool(SITES, 8, async (s) => {
        const a = await check(s, s.known);
        const b = await check(s, random);
        return { site: s.name, ok: a.state === 'taken' && b.state === 'available', known: `${a.state} (${a.status})`, random: `${b.state} (${b.status})` };
    });
    for (const r of results) log.info(`${r.ok ? 'PASS' : 'FAIL'} ${r.site}: known ${r.known}, random ${r.random}`);
    await Actor.pushData(results);
    await Actor.exit();
}

// ---------- Run ----------

const names = [...new Set(list(usernames).map((u) => u.replace(/^@/, '')))].filter((u) => /^[\w.-]{1,40}$/.test(u));
const bad = list(usernames).filter((u) => !/^@?[\w.-]{1,40}$/.test(u));
for (const b of bad) {
    log.warning(`"${b}" is not a username (letters, digits, dot, dash, underscore; up to 40). Skipped.`);
    await Actor.pushData({ rowType: 'error', username: b, error: 'Not a valid username. Not charged.' });
}
const cats = list(categories).map((c) => c.toLowerCase());
const wanted = list(onlySites).map((s) => s.toLowerCase());
const sites = SITES.filter((s) => (!cats.length || cats.includes(s.category)) && (!wanted.length || wanted.some((w) => s.name.toLowerCase().includes(w))));
if (!names.length) {
    await Actor.pushData({ rowType: 'error', error: 'Add at least one username. Not charged.' });
    await Actor.exit();
}
log.info(`Checking ${names.length} username(s) on ${sites.length} site(s).`);

let charged = 0;
let keepGoing = true;
const summary = {};

for (const u of names) {
    if (!keepGoing) break;
    const results = await pool(sites, 8, async (s) => ({ s, r: await check(s, u) }));
    const tally = { taken: 0, available: 0, unknown: 0, takenOn: [] };
    for (const { s, r } of results) {
        tally[r.state] += 1;
        const profileUrl = r.state === 'taken' ? (s.profile ? s.profile(r.data) : null) || s.url(u) : null;
        if (r.state === 'taken') tally.takenOn.push(s.name);
        if (onlyTaken && r.state !== 'taken') continue;
        if (!keepGoing) continue;
        await Actor.pushData({
            username: u,
            site: s.name,
            category: s.category,
            status: r.state,
            profileUrl,
            checkedUrl: s.url(u),
            httpStatus: r.status,
            checkedAt: new Date().toISOString(),
        });
        if (r.state !== 'unknown') {
            try {
                const res = await Actor.charge({ eventName: 'check' });
                charged += 1;
                if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); keepGoing = false; }
            } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        }
    }
    log.info(`${u}: taken on ${tally.taken}, available on ${tally.available}, unknown on ${tally.unknown}.`);
    summary[u] = tally;
}

await Actor.setValue('SUMMARY', { usernames: summary, sitesChecked: sites.map((s) => s.name), chargedChecks: charged });
log.info(`Done. ${charged} answered check(s).`);
await Actor.exit();
