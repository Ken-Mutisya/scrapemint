// Threads Scraper: public Threads profiles (bio, followers, latest posts)
// and single posts with their replies, logged out.
//
// Strategy
// --------
// threads.com/@<user> and threads.com/@<user>/post/<code> are server-rendered
// with the data embedded as JSON (parse.js). A logged-out profile page
// carries the latest ~10-20 posts; deeper history needs a login, which this
// actor does not use.
//
// Cost control
// ------------
// Threads answered Apify's own IPs directly (tested 2026-10-25), which costs
// nothing per byte. Pages are ~1.2 MB, so US residential ($8/GB, ~$0.01 a
// page) is only a fallback after three blocks in a row and is capped at 25%
// of charged revenue (proxy-guard). No proxy input is exposed.
//
// Pay per event
// -------------
//   post ($0.002) one post or reply
//   profile ($0.002) one profile row (bio, followers, links)

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';
import { parseThreadsPage, isThreadsBlock } from './parse.js';

const POST_PRICE = 0.002;
const PROFILE_PRICE = 0.002;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    usernames = ['zuck'],
    postUrls = [],
    includeProfile = true,
    maxPostsPerProfile = 20,
    includeReplies = true,
} = input;

const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x?.url ? x.url : String(x)).trim()).filter(Boolean);
const users = arr(usernames).map((u) => u.replace(/^https?:\/\/(www\.)?threads\.(net|com)\//i, '').replace(/^@/, '').split(/[/?#]/)[0]).filter(Boolean);
const posts = arr(postUrls).map((u) => /threads\.(?:net|com)\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/.exec(u)).filter(Boolean).map((m) => ({ user: m[1], code: m[2] }));
const cap = Math.max(1, Math.min(50, Number(maxPostsPerProfile) || 20));

if (!users.length && !posts.length) {
    await Actor.pushData({ note: 'Add a username (e.g. zuck) or a Threads post URL. Not charged.' });
    await Actor.exit();
}

const guard = new ProxyGuard({ tiers: ['direct', 'datacenter', 'residential'], country: 'US', share: 0.25, floorUsd: 0.01, isBlocked: isThreadsBlock });
const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Mode': 'navigate' };
const stats = { profiles: 0, posts: 0, replies: 0, failed: 0 };
let stop = false;
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { ...stats, ...guard.report() }));

async function fetchPage(url) {
    const res = await guard.get(url, { headers, timeoutMs: 45_000 });
    if (!res || res.statusCode === 404) return null;
    return res.body;
}

for (const u of users) {
    if (stop || deadline.pastSoft()) break;
    const html = await fetchPage(`https://www.threads.com/@${encodeURIComponent(u)}`);
    const parsed = html ? parseThreadsPage(html, { pageType: 'profile', username: u }) : null;
    if (!parsed || (!parsed.profile && !parsed.posts.length)) { stats.failed++; log.warning(`@${u}: profile not found or not readable.`); continue; }
    const rows = parsed.posts.filter((p) => includeReplies || !p.isReply).slice(0, cap).map((p) => ({ type: 'post', profile: u, ...p, scrapedAt: new Date().toISOString() }));
    if (includeProfile && parsed.profile) {
        await Actor.pushData({ type: 'profile', ...parsed.profile, profileUrl: `https://www.threads.com/@${parsed.profile.username}`, postsReturned: rows.length, scrapedAt: new Date().toISOString() });
        stats.profiles++;
        if (!(await chargeRows(guard, 'profile', PROFILE_PRICE, 1))) { stop = true; break; }
    }
    if (rows.length) {
        await Actor.pushData(rows);
        stats.posts += rows.length;
        if (!(await chargeRows(guard, 'post', POST_PRICE, rows.length))) stop = true;
    }
    log.info(`@${u}: ${parsed.profile ? `${parsed.profile.followers} followers, ` : ''}${rows.length} posts.`);
}

for (const p of posts) {
    if (stop || deadline.pastSoft()) break;
    const html = await fetchPage(`https://www.threads.com/@${encodeURIComponent(p.user)}/post/${p.code}`);
    const parsed = html ? parseThreadsPage(html, { pageType: 'post', code: p.code }) : null;
    if (!parsed?.posts.length) { stats.failed++; log.warning(`${p.user}/${p.code}: post not found or not readable.`); continue; }
    const rows = parsed.posts.filter((x) => includeReplies || x.kind === 'post').map((x) => ({ type: x.kind, sourcePost: `https://www.threads.com/@${p.user}/post/${p.code}`, ...x, scrapedAt: new Date().toISOString() }));
    await Actor.pushData(rows);
    stats.posts += rows.filter((r) => r.type === 'post').length;
    stats.replies += rows.filter((r) => r.type === 'reply').length;
    if (!(await chargeRows(guard, 'post', POST_PRICE, rows.length))) stop = true;
    log.info(`${p.user}/${p.code}: ${rows.filter((r) => r.type === 'post').length} post, ${rows.filter((r) => r.type === 'reply').length} replies.`);
}

if (!stats.profiles && !stats.posts && !stats.replies) await Actor.pushData({ note: 'Nothing could be read. Not charged.' });
await Actor.setValue('SUMMARY', { ...stats, ...guard.report() });
log.info(`Done: ${JSON.stringify(stats)} ${JSON.stringify(guard.report())}`);
await Actor.exit();
