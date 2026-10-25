// Truth Social Monitor: posts from Truth Social accounts (Donald Trump and
// any other public account), flagged for your keywords, $cashtags and
// market-moving topics. Built for scheduled polling.
//
// Strategy
// --------
// Truth Social runs a Mastodon-compatible API:
//   /api/v1/accounts/lookup?acct=<username>        -> account id
//   /api/v1/accounts/<id>/statuses?limit=20[&max_id=|&since_id=]
// Cloudflare blocks datacenter and direct Apify IPs (tested 2026-10-25), so
// requests go through US residential. Some residential exits get a
// challenge page; each retry takes a fresh exit.
//
// The API ignores since_id, min_id and limit (tested 2026-10-25): every call
// returns the latest 20 posts (~74 KB) and only max_id pages back. So with
// onlyNew on, the newest post id per account is kept in the named key-value
// store "truth-social-monitor-state" and posts at or below it are dropped
// here; paging stops at the first page that reaches it. Account ids are
// cached there too, so a quiet poll is a single request.
//
// Cost control
// ------------
// A request is ~74 KB on residential ($8/GB) = ~$0.0006, whether or not it
// holds new posts. The per-account check fee ($0.001) covers it, so a
// 5-minute schedule on a quiet account cannot run at a loss; posts are
// charged on top. Residential spend is also capped at 25% of charged revenue
// plus a $0.01 floor (proxy-guard). No proxy input is exposed.
//
// Pay per event
// -------------
//   account_check ($0.001) one account polled
//   post ($0.003) one post returned

import { Actor, log } from 'apify';
import { ProxyGuard, installDeadline, chargeRows } from './proxy-guard.js';

const PRICE = 0.003;
const CHECK_PRICE = 0.001;
const BASE = 'https://truthsocial.com';
const MARKET = {
    tariffs: /\btariffs?\b|\bduties\b|\btrade deal\b|\btrade war\b/i,
    china: /\bchina\b|\bchinese\b|\bxi\b/i,
    fed_rates: /\bfed\b|federal reserve|\bpowell\b|interest rates?|\brate cuts?\b/i,
    oil_energy: /\boil\b|\bopec\b|\bgasoline\b|\bdrill\b|\benergy\b/i,
    crypto: /\bcrypto\b|\bbitcoin\b|\bbtc\b|\bstablecoin\b|\bmemecoin\b/i,
    stocks: /stock market|\bdow\b|\bnasdaq\b|s&p ?500|\bstocks\b/i,
    sanctions_war: /\bsanctions?\b|\bwar\b|\bceasefire\b|\bmissiles?\b|\bstrikes?\b/i,
    economy: /\binflation\b|\bjobs report\b|\bgdp\b|\brecession\b|\beconomy\b/i,
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    accounts = ['realDonaldTrump'],
    maxPostsPerAccount = 20,
    onlyNew = false,
    includeReplies = false,
    includeReposts = true,
    keywords = [],
    onlyMatching = false,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const names = list(accounts).map((a) => a.replace(/^https?:\/\/(www\.)?truthsocial\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]).filter(Boolean);
const cap = Math.max(1, Math.min(1000, Number(maxPostsPerAccount) || 20));
const kw = list(keywords);

const guard = new ProxyGuard({
    tiers: ['residential'],
    country: 'US',
    share: 0.25,
    floorUsd: 0.01,
    isBlocked: (r) => r.statusCode === 403 || r.statusCode === 429 || r.statusCode >= 500 || /Just a moment|cf-chl|challenge-platform/i.test(r.body.slice(0, 3000)),
});
const state = await Actor.openKeyValueStore('truth-social-monitor-state');
const headers = { Accept: 'application/json, text/plain, */*', Referer: `${BASE}/` };
let out = 0;
let stop = false;
const perAccount = [];
const deadline = installDeadline(() => Actor.setValue('SUMMARY', { posts: out, ...guard.report(), accounts: perAccount }));

async function getJson(path) {
    const res = await guard.get(BASE + path, { headers, retriesPerTier: 3, timeoutMs: 30_000 });
    if (!res) return { error: 'blocked or out of proxy budget' };
    if (res.statusCode === 404) return { error: 'not found' };
    try { return { data: JSON.parse(res.body) }; } catch { return { error: `unexpected response (${res.statusCode})` }; }
}

const strip = (h) => (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();

function toRow(s) {
    const src = s.reblog || s;
    const text = strip(src.content);
    const hay = `${text} ${src.card?.title || ''}`;
    const matchedKeywords = kw.filter((k) => new RegExp(`(^|\\W)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\W)`, 'i').test(hay));
    return {
        postId: s.id,
        account: s.account?.acct || null,
        displayName: s.account?.display_name || null,
        createdAt: s.created_at,
        editedAt: s.edited_at || null,
        text,
        url: s.url || src.url || null,
        isRepost: !!s.reblog,
        repostOf: s.reblog ? { account: s.reblog.account?.acct || null, postId: s.reblog.id, url: s.reblog.url || null } : null,
        isReply: !!s.in_reply_to_id,
        quoteOf: s.quote ? { account: s.quote.account?.acct || null, postId: s.quote.id, text: strip(s.quote.content).slice(0, 1000) } : null,
        replies: src.replies_count ?? null,
        reposts: src.reblogs_count ?? null,
        likes: src.favourites_count ?? null,
        media: (src.media_attachments || []).map((m) => ({ type: m.type, url: m.url, previewUrl: m.preview_url || null })),
        link: src.card ? { url: src.card.url, title: src.card.title || null, description: (src.card.description || '').slice(0, 300) || null } : null,
        hashtags: (src.tags || []).map((t) => t.name),
        mentions: (src.mentions || []).map((m) => m.acct),
        cashtags: [...new Set((text.match(/\$[A-Z]{1,5}\b/g) || []))],
        marketTopics: Object.entries(MARKET).filter(([, re]) => re.test(hay)).map(([k]) => k),
        matchedKeywords,
        language: s.language || null,
        scrapedAt: new Date().toISOString(),
    };
}

for (const name of names) {
    if (stop || deadline.pastSoft()) break;
    const nameKey = `name-${name.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
    let id = (await state.getValue(nameKey))?.id;
    if (!id) {
        const look = await getJson(`/api/v1/accounts/lookup?acct=${encodeURIComponent(name)}`);
        if (!look.data?.id) { log.warning(`@${name}: ${look.error || 'account not found'}.`); perAccount.push({ account: name, posts: 0, error: look.error || 'not found' }); continue; }
        id = look.data.id;
        await state.setValue(nameKey, { id });
    }
    const stateKey = `acct-${id}`;
    const since = onlyNew ? (await state.getValue(stateKey))?.newestId : null;
    let checked = false;
    let reachedSince = false;
    const rows = [];
    let maxId = null;
    let newest = since;
    while (rows.length < cap && !deadline.pastSoft()) {
        const q = new URLSearchParams({ limit: '20', exclude_replies: String(!includeReplies) });
        if (!includeReposts) q.set('exclude_reblogs', 'true');
        if (maxId) q.set('max_id', maxId);
        const r = await getJson(`/api/v1/accounts/${id}/statuses?${q}`);
        if (!Array.isArray(r.data)) { log.warning(`@${name}: ${r.error || 'no posts returned'}.`); break; }
        checked = true;
        if (!r.data.length) break;
        for (const s of r.data) {
            if (since && BigInt(s.id) <= BigInt(since)) { reachedSince = true; continue; }
            if (!newest || BigInt(s.id) > BigInt(newest)) newest = s.id;
            if (!includeReposts && s.reblog) continue;
            const row = toRow(s);
            if (onlyMatching && kw.length && !row.matchedKeywords.length) continue;
            rows.push(row);
            if (rows.length >= cap) break;
        }
        maxId = r.data[r.data.length - 1].id;
        if (reachedSince || r.data.length < 20) break;
    }
    if (checked && !(await chargeRows(guard, 'account_check', CHECK_PRICE, 1))) stop = true;
    if (rows.length && !stop) {
        await Actor.pushData(rows);
        out += rows.length;
        if (!(await chargeRows(guard, 'post', PRICE, rows.length))) stop = true;
    }
    if (newest) await state.setValue(stateKey, { newestId: newest, account: name, updatedAt: new Date().toISOString() });
    perAccount.push({ account: name, posts: rows.length, newestId: newest || null, onlyNew: !!onlyNew });
    log.info(`@${name}: ${rows.length} posts${since ? ' since the last run' : ''}.`);
}

if (!out) await Actor.pushData({ note: onlyNew ? 'No new posts since the last run (only the account check is charged).' : 'No posts found.' });
await Actor.setValue('SUMMARY', { posts: out, ...guard.report(), accounts: perAccount });
log.info(`Done: ${out} posts. ${JSON.stringify(guard.report())}`);
await Actor.exit();
