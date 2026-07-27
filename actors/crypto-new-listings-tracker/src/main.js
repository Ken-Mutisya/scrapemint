// Crypto New Coin Listings Tracker: OKX, Gate, Bitget, KuCoin
//
// Strategy
// --------
// A new exchange listing is one of the most reliably traded events in crypto,
// and every one of these venues publishes a listing timestamp on its own spot
// instrument catalogue. So the feed is stateless: one catalogue fetch per venue
// answers "what got listed in the last N days" without needing a baseline from
// a previous run.
//
//   new_listings   pairs whose listing time falls inside the window, newest
//                  first, with the live price and 24h move so a buyer can see
//                  whether it is actually trading
//   announcements  OKX's listing notices, which are published BEFORE the
//                  listing goes live; the forward looking half
//   delistings     Bitget publishes an off time alongside the open time, and a
//                  delisting moves price in the other direction
//
// Venues were chosen for datacenter reachability, not preference: Binance and
// Bybit block Apify datacenter IPs (see the crypto funding rates tracker), the
// four here do not.
//
// Field normalisation traps, all verified live
// --------------------------------------------
//   - Listing time lives under a different key per venue: OKX listTime,
//     Gate buy_start (SECONDS, not ms), Bitget openTime, KuCoin
//     tradingStartTime.
//   - 24h change is a PERCENT on Gate (0.23) but a FRACTION on Bitget
//     (0.00274) and KuCoin (0.0026), and OKX does not publish one at all so it
//     is computed from open24h. Mixing these up understates a move 100x.
//   - Pair separators differ: OKX AEON-USDT, Gate AEON_USDT, Bitget AEONUSDT,
//     KuCoin AEON-USDT.
//
// Pay per event
// -------------
//   listing_row ($0.003) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const SEEN_MAX = 5000;
const FETCH_TIMEOUT_MS = 45000;
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'new_listings',
    venues = ['okx', 'gate', 'bitget', 'kucoin'],
    daysBack = 7,
    quoteCurrencies = ['USDT'],
    minVolumeUsd = 0,
    includePrices = true,
    announcementType = 'announcements-new-listings',
    announcementPages = 1,
    newOnly = false,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['new_listings', 'announcements', 'delistings'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'new_listings';
const quoteFilter = new Set(asList(quoteCurrencies).map((q) => q.toUpperCase()));
const windowDays = Math.max(0, Number(daysBack) || 0);
const volFloor = Math.max(0, Number(minVolumeUsd) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const pages = Math.max(1, Math.min(10, Number(announcementPages) || 1));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        return await res.json();
    } catch (err) {
        log.warning(`Request failed for ${url.slice(0, 80)}: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

// Each adapter returns a common shape so the rest of the actor never has to
// care which exchange a row came from.
const VENUES = {
    okx: {
        label: 'OKX',
        async instruments() {
            const j = await getJson('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
            return (j?.data || []).map((x) => ({
                pair: x.instId,
                base: x.baseCcy,
                quote: x.quoteCcy,
                listMs: num(x.listTime),
                offMs: null,
                tradable: x.state === 'live',
                status: x.state,
            }));
        },
        async tickers() {
            const j = await getJson('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
            const map = new Map();
            for (const t of j?.data || []) {
                const last = num(t.last); const open = num(t.open24h);
                map.set(t.instId, {
                    price: last,
                    // OKX publishes no 24h change field, so derive it from open.
                    changePct24h: last != null && open ? round(((last - open) / open) * 100, 3) : null,
                    quoteVolume24h: num(t.volCcy24h),
                });
            }
            return map;
        },
    },
    gate: {
        label: 'Gate.io',
        async instruments() {
            const j = await getJson('https://api.gateio.ws/api/v4/spot/currency_pairs');
            return (j || []).map((x) => ({
                pair: x.id,
                base: x.base,
                quote: x.quote,
                // buy_start is in SECONDS on Gate, unlike every other venue here.
                listMs: x.buy_start ? num(x.buy_start) * 1000 : null,
                offMs: null,
                tradable: x.trade_status === 'tradable',
                status: x.trade_status,
            }));
        },
        async tickers() {
            const j = await getJson('https://api.gateio.ws/api/v4/spot/tickers');
            const map = new Map();
            for (const t of j || []) {
                map.set(t.currency_pair, {
                    price: num(t.last),
                    // Already a percent on Gate.
                    changePct24h: round(num(t.change_percentage), 3),
                    quoteVolume24h: num(t.quote_volume),
                });
            }
            return map;
        },
    },
    bitget: {
        label: 'Bitget',
        async instruments() {
            const j = await getJson('https://api.bitget.com/api/v2/spot/public/symbols');
            return (j?.data || []).map((x) => ({
                pair: x.symbol,
                base: x.baseCoin,
                quote: x.quoteCoin,
                listMs: num(x.openTime),
                offMs: num(x.offTime) || null,
                tradable: x.status === 'online',
                status: x.status,
            }));
        },
        async tickers() {
            const j = await getJson('https://api.bitget.com/api/v2/spot/market/tickers');
            const map = new Map();
            for (const t of j?.data || []) {
                const chg = num(t.change24h);
                map.set(t.symbol, {
                    price: num(t.lastPr),
                    // Fraction on Bitget, so scale to percent.
                    changePct24h: chg == null ? null : round(chg * 100, 3),
                    quoteVolume24h: num(t.usdtVolume) ?? num(t.quoteVolume),
                });
            }
            return map;
        },
    },
    kucoin: {
        label: 'KuCoin',
        async instruments() {
            const j = await getJson('https://api.kucoin.com/api/v2/symbols');
            return (j?.data || []).map((x) => ({
                pair: x.symbol,
                base: x.baseCurrency,
                quote: x.quoteCurrency,
                listMs: num(x.tradingStartTime),
                offMs: null,
                tradable: x.enableTrading === true,
                status: x.enableTrading ? 'online' : 'offline',
            }));
        },
        async tickers() {
            const j = await getJson('https://api.kucoin.com/api/v1/market/allTickers');
            const map = new Map();
            for (const t of j?.data?.ticker || []) {
                const chg = num(t.changeRate);
                map.set(t.symbol, {
                    price: num(t.last),
                    // Fraction on KuCoin too.
                    changePct24h: chg == null ? null : round(chg * 100, 3),
                    quoteVolume24h: num(t.volValue),
                });
            }
            return map;
        },
    },
};

const venueKeys = asList(venues).map((v) => v.toLowerCase()).filter((v) => VENUES[v]);
if (!venueKeys.length) venueKeys.push('okx', 'gate', 'bitget', 'kucoin');

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'listing_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const store = newOnly ? await Actor.openKeyValueStore('crypto-listings-seen') : null;
const SEEN_KEY = 'seen-listing-keys';
const seen = new Set(newOnly ? (await store.getValue(SEEN_KEY)) || [] : []);
const seenAtStart = seen.size;
let skippedSeen = 0;

const now = Date.now();
const windowStart = windowDays ? now - windowDays * 86400000 : null;
let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Crypto listings ${theMode} | ${venueKeys.join(', ')}`
    + (theMode !== 'announcements' ? ` | last ${windowDays} day(s)` : ` | ${announcementType}, ${pages} page(s)`)
    + `${newOnly ? ' | NEW only' : ''} | cap ${cap} rows`);

if (theMode === 'announcements') {
    let any = 0;
    for (let page = 1; page <= pages && !stopEarly(); page++) {
        const j = await getJson(`https://www.okx.com/api/v5/support/announcements?annType=${encodeURIComponent(announcementType)}&page=${page}`);
        const details = (j?.data || []).flatMap((d) => d.details || []);
        if (!details.length) break;
        for (const d of details) {
            if (stopEarly()) break;
            const key = `ann|${d.url}`;
            if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
            if (newOnly) seen.add(key);
            const pubMs = num(d.pTime);
            const effMs = num(d.businessPTime);
            await flushRow({
                mode: 'announcements',
                venue: 'OKX',
                announcementType: d.annType || announcementType,
                title: d.title,
                url: d.url,
                publishedAt: pubMs ? new Date(pubMs).toISOString() : null,
                // businessPTime is when the change actually takes effect, which
                // is what a trader schedules around, not when the post went up.
                effectiveAt: effMs ? new Date(effMs).toISOString() : null,
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1; any += 1;
        }
    }
    if (!any) {
        await flushRow({
            type: 'note', mode: 'announcements', found: false,
            note: newOnly ? 'no announcements since the last run; not charged' : 'no announcements returned for this type; not charged',
        }, false);
    }
} else {
    // new_listings and delistings both read the instrument catalogues.
    const perVenue = [];
    for (const key of venueKeys) {
        if (deadlineMs && Date.now() > deadlineMs) break;
        const v = VENUES[key];
        const instruments = await v.instruments();
        if (!instruments?.length) { log.warning(`${v.label}: no instruments returned`); continue; }
        const tickers = includePrices ? await v.tickers() : new Map();
        perVenue.push({ key, label: v.label, instruments, tickers });
        log.info(`${v.label}: ${instruments.length} spot pairs`);
    }

    const matches = [];
    for (const { key, label, instruments, tickers } of perVenue) {
        for (const inst of instruments) {
            if (quoteFilter.size && !quoteFilter.has(String(inst.quote || '').toUpperCase())) continue;
            const eventMs = theMode === 'delistings' ? inst.offMs : inst.listMs;
            if (!eventMs) continue;
            if (theMode === 'delistings') {
                // Keep scheduled delistings (future) and ones inside the window.
                if (windowStart && eventMs < windowStart) continue;
            } else if (windowStart && eventMs < windowStart) continue;
            const t = tickers.get(inst.pair) || {};
            if (volFloor && (t.quoteVolume24h ?? 0) < volFloor) continue;
            matches.push({ venueKey: key, venue: label, ...inst, eventMs, ...t });
        }
    }

    // How many of the SELECTED venues listed the same base coin in this window.
    // A coin appearing on three venues at once is a bigger event than one.
    const byBase = new Map();
    for (const m of matches) {
        const b = String(m.base || '').toUpperCase();
        if (!byBase.has(b)) byBase.set(b, new Set());
        byBase.get(b).add(m.venue);
    }

    matches.sort((a, b) => b.eventMs - a.eventMs);

    let any = 0;
    for (const m of matches) {
        if (stopEarly()) break;
        const key = `${theMode}|${m.venueKey}|${m.pair}|${m.eventMs}`;
        if (newOnly && seen.has(key)) { skippedSeen += 1; continue; }
        if (newOnly) seen.add(key);
        const venuesForBase = [...(byBase.get(String(m.base || '').toUpperCase()) || [])].sort();
        // On a coin's first day each venue seeds a different reference open
        // (AEON on listing day: OKX 0.05, Bitget 0.012, Gate an auction high),
        // so the 24h change is real per venue but NOT comparable across them
        // until a full session has passed. Flag it rather than hide it.
        const ageDays = m.listMs ? (now - m.listMs) / 86400000 : null;
        await flushRow({
            mode: theMode,
            venue: m.venue,
            pair: m.pair,
            baseCurrency: m.base,
            quoteCurrency: m.quote,
            [theMode === 'delistings' ? 'delistingTime' : 'listingTime']: new Date(m.eventMs).toISOString(),
            [theMode === 'delistings' ? 'daysUntilDelisting' : 'daysSinceListing']:
                round((theMode === 'delistings' ? m.eventMs - now : now - m.eventMs) / 86400000, 2),
            tradable: m.tradable,
            status: m.status,
            price: m.price ?? null,
            changePercent24h: m.changePct24h ?? null,
            hasFullDayOfTrading: ageDays == null ? null : ageDays >= 1,
            quoteVolume24h: m.quoteVolume24h != null ? round(m.quoteVolume24h, 2) : null,
            venuesListingThisCoin: venuesForBase,
            venueCount: venuesForBase.length,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1; any += 1;
    }
    if (!any) {
        await flushRow({
            type: 'note', mode: theMode, found: false,
            note: newOnly
                ? `nothing new since the last run in the last ${windowDays} day(s); not charged`
                : theMode === 'delistings'
                    ? 'no scheduled delistings in this window (only Bitget publishes an off time); not charged'
                    : `no listings in the last ${windowDays} day(s) for the selected venues and quote currencies; widen daysBack or clear quoteCurrencies; not charged`,
        }, false);
    }
}

if (newOnly) {
    const toSave = seen.size > SEEN_MAX ? [...seen].slice(seen.size - SEEN_MAX) : [...seen];
    await store.setValue(SEEN_KEY, toSave);
    log.info(`Monitor state saved: ${toSave.length} key(s) remembered (${seenAtStart} before, ${skippedSeen} already-seen skipped).`);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
