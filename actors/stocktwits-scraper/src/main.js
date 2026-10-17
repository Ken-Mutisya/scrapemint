// Stocktwits Scraper: messages, bullish/bearish sentiment and trending
// tickers from Stocktwits, the social network for traders.
//
// Three row types:
//   message   - posts on a symbol's stream, a user's stream or the trending
//               stream, with the author's Bullish/Bearish tag, likes,
//               replies, cashtags and the prices at posting time
//   sentiment - per symbol: watchers, Stocktwits' daily bullish % history,
//               and the bullish/bearish split and post rate of the latest
//               messages read in this run
//   trending  - the trending tickers with rank, trending score, Stocktwits'
//               "why it's trending" summary and fundamentals
//
// Strategy
// --------
// Stocktwits' public API v2, keyless:
//   /streams/symbol/{SYM}.json, /streams/user/{name}.json,
//   /streams/trending.json  (30 messages a page, older pages via ?max=id)
//   /symbols/{SYM}/sentiment.json (daily bullish/bearish %)
//   /trending/symbols.json
// It answers from Apify's IPs (Cloudflare challenges some home IPs).
// Unauthenticated calls are rate-limited per IP, so requests are spaced
// and 429s back off.
//
// No key, no proxy. Tested from Apify on 2026-10-17.
//
// Pay per event
// -------------
//   message_row ($0.0008) one message
//   symbol_row  ($0.003)  one sentiment or trending row
// No start fee. A run that finds nothing is free.

import { Actor, log } from 'apify';

const API = 'https://api.stocktwits.com/api/2';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const GAP_MS = 400;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    symbols = [],
    users = [],
    includeMessages = true,
    includeSentiment = true,
    trending = false,
    trendingMessages = false,
    onlyWithSentiment = false,
    maxMessagesPerSource = 100,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const perSourceCap = Math.max(1, Number(maxMessagesPerSource) || 100);
const decode = (s) => String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/￼/g, '').trim();

// "$aapl", "AAPL", "https://stocktwits.com/symbol/AAPL", "btc.x" -> "AAPL" / "BTC.X"
const symbolOf = (s) => {
    const m = String(s).match(/stocktwits\.com\/symbol\/([^/?#]+)/i);
    return (m ? m[1] : String(s)).replace(/^\$/, '').trim().toUpperCase();
};
const userOf = (s) => {
    const m = String(s).match(/stocktwits\.com\/([^/?#]+)/i);
    return (m ? m[1] : String(s)).replace(/^@/, '').trim();
};

let lastCall = 0;
async function getJson(path) {
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
        const wait = lastCall + GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        try {
            const r = await fetch(API + path, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
            if (r.status === 404) return null;
            if (r.status === 429) {
                const reset = Number(r.headers.get('x-ratelimit-reset'));
                const ms = Number.isFinite(reset) && reset > 0 ? Math.min(120_000, Math.max(5_000, reset * 1000 - Date.now())) : 15_000 * (attempt + 1);
                log.warning(`Stocktwits rate limit; waiting ${Math.round(ms / 1000)}s.`);
                await sleep(ms);
                last = new Error('HTTP 429 (rate limited)');
                continue;
            }
            if (r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(3000 * (attempt + 1)); continue; }
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: true });
            return await r.json();
        } catch (err) {
            if (err.fatal) throw err;
            last = err;
            await sleep(2000 * (attempt + 1));
        }
    }
    throw last;
}

function toMessage(m, source) {
    const u = m.user || {};
    const s = m.entities?.sentiment?.basic || null;
    const prices = Object.fromEntries((m.prices || []).map((p) => [p.symbol, Number(p.price)]));
    return {
        type: 'message',
        source,
        messageId: m.id,
        createdAt: m.created_at,
        body: decode(m.body),
        sentiment: s,
        cashtags: (m.symbols || []).map((x) => x.symbol),
        pricesAtPost: Object.keys(prices).length ? prices : null,
        likes: m.likes?.total ?? 0,
        replies: m.conversation?.parent ? (m.conversation.replies ?? 0) : null,
        isReply: m.conversation ? !m.conversation.parent : false,
        inReplyToId: m.conversation?.in_reply_to_message_id ?? null,
        reshareOf: m.reshare_message?.message?.id ?? null,
        hasMedia: Boolean(m.entities?.media?.length),
        username: u.username || null,
        userDisplayName: u.name || null,
        userFollowers: u.followers ?? null,
        userFollowing: u.following ?? null,
        userIdeas: u.ideas ?? null,
        userJoinDate: u.join_date || null,
        userOfficial: Boolean(u.official),
        userCountry: u.home_country || null,
        postedFrom: m.source?.title || null,
        url: u.username ? `https://stocktwits.com/${u.username}/message/${m.id}` : null,
    };
}

// Newest first, older pages through ?max=<last id - 1>.
async function* stream(path, label) {
    let max = null;
    let n = 0;
    while (n < perSourceCap) {
        const d = await getJson(`${path}${max ? `${path.includes('?') ? '&' : '?'}max=${max}` : ''}`);
        if (!d) return { notFound: true };
        const msgs = d.messages || [];
        if (!msgs.length) return {};
        const out = msgs.map((m) => toMessage(m, label)).slice(0, perSourceCap - n);
        n += out.length;
        yield { rows: out, meta: d };
        if (!d.cursor?.more || !d.cursor?.max) return {};
        max = d.cursor.max - 1;
    }
    return {};
}

// ---- run ----
let rowsOut = 0;
let keepGoing = true;
const failures = [];
const perSource = [];

async function charge(eventName) {
    try {
        const res = await Actor.charge({ eventName });
        if (res?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); return false; }
    } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
    return true;
}

async function emit(row, eventName) {
    await Actor.pushData(row);
    rowsOut += 1;
    if (!(await charge(eventName))) keepGoing = false;
}

const syms = [...new Set(list(symbols).map(symbolOf))];
const names = [...new Set(list(users).map(userOf))];
if (!syms.length && !names.length && !trending && !trendingMessages) {
    await Actor.pushData({ type: 'error', error: 'Add symbols or users, or turn on trending. Not charged.' });
}

// Trending tickers first: they are one call and often what a schedule wants.
if (trending && keepGoing) {
    try {
        const d = await getJson('/trending/symbols.json');
        let n = 0;
        for (const [i, s] of (d?.symbols || []).entries()) {
            if (!keepGoing) break;
            const f = s.fundamentals || {};
            const numf = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
            await emit({
                type: 'trending',
                rank: s.rank ?? i + 1,
                symbol: s.symbol,
                name: s.title || null,
                exchange: s.exchange || null,
                instrumentClass: s.instrument_class || null,
                sector: s.sector || null,
                industry: s.industry || null,
                trendingScore: r3(s.trending_score),
                trendingSummary: s.trends?.summary || null,
                summaryAt: s.trends?.summary_at || null,
                watchers: s.watchlist_count ?? null,
                marketCapMillions: numf(f.MarketCapitalization ?? f.MarketCap),
                peRatio: numf(f.PERatio),
                dividendYield: numf(f.DividendYieldSecurity),
                fiftyTwoWeekHigh: numf(f.HighPriceLast52Weeks),
                fiftyTwoWeekLow: numf(f.LowPriceLast52Weeks),
                url: `https://stocktwits.com/symbol/${s.symbol}`,
                scrapedAt: new Date().toISOString(),
            }, 'symbol_row');
            n += 1;
        }
        perSource.push({ source: 'trending symbols', rows: n });
    } catch (err) {
        failures.push({ source: 'trending symbols', error: String(err.message) });
    }
}

for (const sym of syms) {
    if (!keepGoing) break;
    const msgs = [];
    let meta = null;
    let notFound = false;
    if (includeMessages || includeSentiment) {
        // Sentiment counts need messages even when they are not output; read
        // at least one page (30) for it.
        const want = includeMessages ? perSourceCap : 30;
        try {
            const it = stream(`/streams/symbol/${encodeURIComponent(sym)}.json`, `symbol:${sym}`);
            let got = 0;
            while (got < want) {
                const { value, done } = await it.next();
                if (done) { if (value?.notFound) notFound = true; break; }
                meta = meta || value.meta;
                for (const r of value.rows) {
                    msgs.push(r);
                    got += 1;
                    if (includeMessages && keepGoing && (!onlyWithSentiment || r.sentiment)) await emit(r, 'message_row');
                }
                if (!keepGoing) break;
            }
        } catch (err) {
            failures.push({ source: sym, error: String(err.message) });
        }
    }
    if (notFound) {
        await Actor.pushData({ type: 'error', symbol: sym, error: `Stocktwits has no symbol "${sym}". Not charged.` });
        continue;
    }
    if (includeSentiment && keepGoing) {
        let history = [];
        try {
            const d = await getJson(`/symbols/${encodeURIComponent(sym)}/sentiment.json`);
            history = (d?.data || []).map((x) => ({ date: x.timestamp, bullish: x.bullish, bearish: x.bearish }));
        } catch (err) {
            log.warning(`${sym} sentiment history: ${err.message}`);
        }
        const tagged = msgs.filter((m) => m.sentiment);
        const bull = tagged.filter((m) => m.sentiment === 'Bullish').length;
        const times = msgs.map((m) => Date.parse(m.createdAt)).filter(Number.isFinite);
        const spanH = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3600_000 : null;
        const sy = meta?.symbol || {};
        if (meta || history.length) {
            await emit({
                type: 'sentiment',
                symbol: sym,
                name: sy.title || null,
                exchange: sy.exchange || null,
                instrumentClass: sy.instrument_class || null,
                watchers: sy.watchlist_count ?? null,
                bullishToday: history[0]?.bullish ?? null,
                bearishToday: history[0]?.bearish ?? null,
                bullishChange7d: history.length > 7 && history[0].bullish != null ? r3(history[0].bullish - history[7].bullish) : null,
                sentimentHistory: history.length ? history : null,
                messagesSampled: msgs.length,
                taggedBullish: bull,
                taggedBearish: tagged.length - bull,
                taggedBullishShare: tagged.length ? r3(bull / tagged.length) : null,
                messagesPerHour: spanH ? r3(msgs.length / spanH) : null,
                latestMessageAt: msgs[0]?.createdAt || null,
                url: `https://stocktwits.com/symbol/${sym}`,
                scrapedAt: new Date().toISOString(),
            }, 'symbol_row');
        }
    }
    perSource.push({ source: sym, messages: msgs.length });
}

const msgSources = [
    ...names.map((u) => ({ path: `/streams/user/${encodeURIComponent(u)}.json`, label: `user:${u}`, name: u })),
    ...(trendingMessages ? [{ path: '/streams/trending.json', label: 'trending', name: 'trending stream' }] : []),
];
for (const s of msgSources) {
    if (!keepGoing) break;
    let n = 0;
    try {
        const it = stream(s.path, s.label);
        while (keepGoing) {
            const { value, done } = await it.next();
            if (done) {
                if (value?.notFound) await Actor.pushData({ type: 'error', user: s.name, error: `Stocktwits has no user "${s.name}". Not charged.` });
                break;
            }
            for (const r of value.rows) {
                if (!keepGoing) break;
                if (onlyWithSentiment && !r.sentiment) continue;
                await emit(r, 'message_row');
                n += 1;
            }
        }
    } catch (err) {
        failures.push({ source: s.name, error: String(err.message) });
    }
    perSource.push({ source: s.name, messages: n });
}

if (!rowsOut && (syms.length || names.length || trending || trendingMessages)) {
    await Actor.pushData({ type: 'note', note: `${failures.length ? `Stocktwits did not answer (${failures[0].error}).` : 'Nothing found.'} Not charged.` });
}
await Actor.setValue('SUMMARY', { rows: rowsOut, sources: perSource, failures });
log.info(`Done. ${rowsOut} row(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
await Actor.exit();
