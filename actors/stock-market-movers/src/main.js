// US Stock Market Movers & Screener
//
// Strategy
// --------
// One keyless source: the official NASDAQ market-activity screener
// (api.nasdaq.com/api/screener/stocks?download=true), which returns the entire
// US market (~7,000 stocks) in a single call with price, net/percent change,
// volume, market cap, sector, and industry. From that snapshot we serve the two
// things equity traders open first every day:
//   - movers    top gainers, losers, and most-active names
//   - screener  filter the whole market by sector, market cap, price, %-change,
//               and volume
//
// The endpoint needs a browser-like User-Agent + Accept header or it 403s.
// Values arrive as strings ("$139.30", "4.376%", "543,777") and are parsed to
// numbers. Movers apply a price/volume floor by default so the lists are real
// liquid stocks, not penny-stock noise.
//
// Pay per event
// -------------
//   stock_row ($0.003) charged per stock row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 5000;
const FETCH_TIMEOUT_MS = 45000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'movers',
    moverType = 'all',
    count = 25,
    minPrice = 0,
    maxPrice = 0,
    minMarketCap = 0,
    maxMarketCap = 0,
    minPctChange = 0,
    minVolume = 0,
    sector = '',
    country = '',
    sortBy = 'pct_change',
    maxRows = 200,
} = input;

const theMode = ['movers', 'screener'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'movers';
const wantMover = String(moverType || 'all').toLowerCase();
const perCat = Math.max(1, Math.min(500, Number(count) || 25));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

// Movers default floors so gainer/loser lists are real liquid stocks, not penny pumps.
const moverMinPrice = theMode === 'movers' ? (Number(minPrice) || 1) : Number(minPrice) || 0;
const moverMinVol = theMode === 'movers' ? (Number(minVolume) || 50000) : Number(minVolume) || 0;

const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[$,%\s]/g, '');
    if (s === '' || /^(N\/A|UNCH|--)$/i.test(String(v).trim())) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

async function getMarket() {
    const url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000&offset=0&download=true';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} from NASDAQ screener`); return null; }
        const j = await res.json();
        return j?.data?.rows || j?.data?.table?.rows || null;
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row) {
    await Actor.pushData(row);
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'stock_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

function shape(r, category) {
    return {
        symbol: clean(r.symbol),
        name: clean(r.name),
        price: num(r.lastsale),
        netChange: num(r.netchange),
        pctChange: num(r.pctchange),
        volume: num(r.volume),
        marketCap: num(r.marketCap),
        sector: clean(r.sector),
        industry: clean(r.industry),
        country: clean(r.country),
        ipoYear: clean(r.ipoyear),
        moverCategory: category || null,
        url: r.url ? `https://www.nasdaq.com${r.url}` : null,
        scrapedAt: new Date().toISOString(),
    };
}

const rows = await getMarket();
if (!rows || !rows.length) { log.warning('No market data returned from NASDAQ.'); await Actor.exit(); }
log.info(`Fetched ${rows.length} US stocks. Mode: ${theMode}.`);

// Parse once into a working set with numeric fields.
const parsed = rows.map((r) => ({ raw: r, price: num(r.lastsale), pct: num(r.pctchange), vol: num(r.volume), mcap: num(r.marketCap) }));

let emitted = 0;
const stop = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

if (theMode === 'movers') {
    const liquid = parsed.filter((p) => p.price != null && p.pct != null && p.vol != null
        && (!moverMinPrice || p.price >= moverMinPrice) && (!moverMinVol || p.vol >= moverMinVol));
    const cats = [];
    if (wantMover === 'gainers' || wantMover === 'all') cats.push(['gainers', [...liquid].sort((a, b) => b.pct - a.pct)]);
    if (wantMover === 'losers' || wantMover === 'all') cats.push(['losers', [...liquid].sort((a, b) => a.pct - b.pct)]);
    if (wantMover === 'most_active' || wantMover === 'all') cats.push(['most_active', [...liquid].sort((a, b) => b.vol - a.vol)]);

    for (const [label, list] of cats) {
        let n = 0;
        for (const p of list) {
            if (n >= perCat || stop()) break;
            await flushRow(shape(p.raw, label));
            emitted += 1; n += 1;
        }
        log.info(`${label}: ${n} rows.`);
    }
} else {
    // screener: apply filters, then sort.
    const sectorLc = String(sector || '').toLowerCase();
    const countryLc = String(country || '').toLowerCase();
    let hits = parsed.filter((p) => {
        if (minPrice && (p.price == null || p.price < minPrice)) return false;
        if (maxPrice && (p.price == null || p.price > maxPrice)) return false;
        if (minMarketCap && (p.mcap == null || p.mcap < minMarketCap)) return false;
        if (maxMarketCap && (p.mcap == null || p.mcap > maxMarketCap)) return false;
        if (minPctChange && (p.pct == null || p.pct < minPctChange)) return false;
        if (minVolume && (p.vol == null || p.vol < minVolume)) return false;
        if (sectorLc && !String(p.raw.sector || '').toLowerCase().includes(sectorLc)) return false;
        if (countryLc && !String(p.raw.country || '').toLowerCase().includes(countryLc)) return false;
        return true;
    });
    const keyer = sortBy === 'volume' ? (p) => p.vol ?? -Infinity
        : sortBy === 'market_cap' ? (p) => p.mcap ?? -Infinity
            : sortBy === 'price' ? (p) => p.price ?? -Infinity
                : (p) => p.pct ?? -Infinity;
    hits.sort((a, b) => keyer(b) - keyer(a));
    log.info(`Screener matched ${hits.length} stocks; returning up to ${cap}.`);
    for (const p of hits) {
        if (stop()) break;
        await flushRow(shape(p.raw, null));
        emitted += 1;
    }
}

log.info(`Done. ${emitted} stock row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
