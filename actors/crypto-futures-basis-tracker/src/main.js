// Crypto Futures vs Spot: Premium by Expiry and Annual Yield
//
// What it does
// ------------
// A dated futures contract usually trades above the current index price. This
// measures that gap for every expiry OKX lists, and converts it into an annual
// percentage: the return you would lock in by holding the coin and selling the
// future against it. Carry traders read it as a yield. Everyone else reads it
// as a leverage gauge, since a fat premium means the market is crowded long and
// a negative one means people are paying to get out.
//
//   curve    one row per contract: premium, days to expiry, annualized yield
//   summary  one row per coin and margin type: front, quarterly and far
//            annualized carry, plus whether the curve is in premium or discount
//   spreads  consecutive expiry pairs with the forward rate implied between
//            them, which is the trade a curve trader actually puts on
//
// Three keyless calls total regardless of how many coins are requested, plus
// one index lookup per coin.
//
// The trap this is built around
// -----------------------------
// Annualizing a contract that expires in days produces nonsense. An ETH
// contract 3.4 days out showed a 0.625% premium, which annualizes to 66.88%.
// That is a rounding artifact over a tiny denominator, not a yield. Contracts
// inside `minDaysToExpiry` (7 by default) are excluded, and any row that
// survives still carries `annualizedReliable` so a short-dated figure is never
// mistaken for a real rate.
//
// Other source quirks handled
// ---------------------------
//   - `_XPERP` families are quasi-perpetuals aliased "this_five_years" with a
//     2031 expiry; they are not dated futures and are excluded.
//   - Every family, coin margined and USD margined alike, references the same
//     `{COIN}-USD` index via its own `uly` field, so the index is taken from
//     `uly` rather than guessed from the family name. Using a USDT index
//     instead moves the reference ~0.1%, which would swamp a front month
//     premium of 0.02%.
//
// Pay per event
// -------------
//   basis_row ($0.003) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 45000;
const BASE = 'https://www.okx.com/api/v5';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'curve',
    coins = ['BTC', 'ETH', 'SOL'],
    marginType = 'both',
    minDaysToExpiry = 7,
    requireVolume = true,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
// Number("") is 0, not NaN, so an empty price would otherwise become a real
// zero and produce a -100% premium. Guard the empty string explicitly.
const num = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const theMode = ['curve', 'summary', 'spreads'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'curve';
const coinList = [...new Set(asList(coins).map((c) => c.toUpperCase().replace(/[-_/].*$/, '')))].slice(0, 30);
if (!coinList.length) coinList.push('BTC');
const wantMargin = ['coin', 'usd'].includes(String(marginType).toLowerCase()) ? String(marginType).toLowerCase() : 'both';
const dayFloor = Math.max(0, Number(minDaysToExpiry) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (!res.ok) { log.warning(`HTTP ${res.status} for ${url.slice(0, 100)}`); return null; }
        const j = await res.json();
        if (j.code && j.code !== '0') { log.warning(`OKX code ${j.code}: ${String(j.msg).slice(0, 80)}`); return null; }
        return j;
    } catch (err) {
        log.warning(`Request failed: ${err?.message}`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'basis_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const now = Date.now();
let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Futures basis ${theMode} | ${coinList.join(', ')} | margin ${wantMargin} | min ${dayFloor}d to expiry${requireVolume ? ' | traded contracts only' : ''} | cap ${cap} rows`);

const instRes = await getJson(`${BASE}/public/instruments?instType=FUTURES`);
const tickRes = await getJson(`${BASE}/market/tickers?instType=FUTURES`);
if (!instRes || !tickRes) {
    log.error('Could not load the futures instrument list or tickers.');
    await flushRow({ type: 'note', found: false, note: 'OKX futures data unavailable right now; not charged' }, false);
    await Actor.exit();
}
const tickers = new Map((tickRes.data || []).map((t) => [t.instId, t]));

// Group live dated futures by coin and family, skipping the quasi-perpetuals.
const byCoin = new Map();
for (const x of instRes.data || []) {
    const family = x.instFamily || '';
    if (family.endsWith('_XPERP')) continue;
    if (x.state && x.state !== 'live') continue;
    const coin = String(x.uly || family).split('-')[0].toUpperCase();
    if (!coinList.includes(coin)) continue;
    // settleCcy equal to the coin means the contract is coin margined.
    const margin = String(x.settleCcy).toUpperCase() === coin ? 'coin' : 'usd';
    if (wantMargin !== 'both' && margin !== wantMargin) continue;
    const expMs = num(x.expTime);
    if (!expMs) continue;
    const t = tickers.get(x.instId);
    if (!t) continue;
    // `last` is the last TRADED price, which on an untraded back month is
    // stale or empty: two different BTC expiries were both quoting an
    // identical 65975.5 while showing zero volume. A live two sided quote is
    // the honest price, so prefer its mid and keep `last` as the fallback.
    const bid = num(t.bidPx); const ask = num(t.askPx); const last = num(t.last);
    const hasQuote = bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid;
    const price = hasQuote ? (bid + ask) / 2 : last;
    if (price == null || price <= 0) continue;
    const volume = num(t.vol24h) ?? 0;
    // A contract that has not traded in 24h with a 10% wide spread is not a
    // market, and annualizing its "premium" prints yields that do not exist.
    if (requireVolume && volume <= 0) continue;
    const days = (expMs - now) / 86400000;
    if (days <= 0 || days < dayFloor) continue;
    if (!byCoin.has(coin)) byCoin.set(coin, { uly: x.uly, families: new Map() });
    const entry = byCoin.get(coin);
    const key = `${family}|${margin}`;
    if (!entry.families.has(key)) entry.families.set(key, { family, margin, contracts: [] });
    entry.families.get(key).contracts.push({
        contract: x.instId,
        label: x.alias || null,
        expiryMs: expMs,
        days,
        price: round(price, 4),
        priceSource: hasQuote ? 'quote_mid' : 'last_trade',
        // A wide spread is the tell for a contract nobody is making a market
        // in, so the caller can discount the row rather than trust it blindly.
        quoteSpreadPercent: hasQuote ? round(((ask - bid) / ((ask + bid) / 2)) * 100, 4) : null,
        volume24hContracts: volume,
    });
}

if (!byCoin.size) {
    await flushRow({
        type: 'note', found: false,
        note: `no live dated futures matched those coins with at least ${dayFloor} day(s) to expiry${requireVolume ? ' and 24h volume' : ''}; not charged`,
    }, false);
}

// One index lookup per coin; every family of a coin shares the same uly index.
const indexPrices = new Map();
for (const [coin, entry] of byCoin) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    const j = await getJson(`${BASE}/market/index-tickers?instId=${encodeURIComponent(entry.uly)}`);
    const px = num((j?.data || [])[0]?.idxPx);
    if (px == null) { log.warning(`${coin}: no index price for ${entry.uly}`); continue; }
    indexPrices.set(coin, px);
}

const enrich = (c, indexPrice) => {
    const premiumPercent = ((c.price - indexPrice) / indexPrice) * 100;
    const annualized = premiumPercent * (365 / c.days);
    return {
        ...c,
        indexPrice,
        premiumPercent: round(premiumPercent, 4),
        premiumAbsolute: round(c.price - indexPrice, 4),
        annualizedPercent: round(annualized, 3),
        // A few days of noise scaled by 365 is not a rate. Kept visible rather
        // than hidden so the caller can judge.
        annualizedReliable: c.days >= 7,
    };
};

for (const [coin, entry] of byCoin) {
    if (stopEarly()) break;
    const indexPrice = indexPrices.get(coin);
    if (indexPrice == null) {
        await flushRow({ type: 'note', coin, found: false, note: 'no index price published for this coin; not charged' }, false);
        continue;
    }

    for (const fam of entry.families.values()) {
        if (stopEarly()) break;
        const contracts = fam.contracts
            .map((c) => enrich(c, indexPrice))
            .sort((a, b) => a.days - b.days);
        if (!contracts.length) continue;

        if (theMode === 'curve') {
            for (const c of contracts) {
                if (stopEarly()) break;
                await flushRow({
                    mode: 'curve',
                    coin,
                    family: fam.family,
                    marginType: fam.margin === 'coin' ? 'coin-margined' : 'usd-margined',
                    contract: c.contract,
                    label: c.label,
                    expiry: new Date(c.expiryMs).toISOString(),
                    daysToExpiry: round(c.days, 2),
                    futuresPrice: c.price,
                    indexPrice: c.indexPrice,
                    premiumAbsolute: c.premiumAbsolute,
                    premiumPercent: c.premiumPercent,
                    annualizedPercent: c.annualizedPercent,
                    annualizedReliable: c.annualizedReliable,
                    inPremium: c.premiumPercent > 0,
                    priceSource: c.priceSource,
                    quoteSpreadPercent: c.quoteSpreadPercent,
                    volume24hContracts: c.volume24hContracts,
                    scrapedAt: new Date().toISOString(),
                });
                emitted += 1;
            }
            continue;
        }

        if (theMode === 'spreads') {
            for (let i = 0; i < contracts.length - 1; i++) {
                if (stopEarly()) break;
                const near = contracts[i]; const far = contracts[i + 1];
                const gapDays = far.days - near.days;
                if (gapDays <= 0) continue;
                const spreadPercent = ((far.price - near.price) / near.price) * 100;
                await flushRow({
                    mode: 'spreads',
                    coin,
                    family: fam.family,
                    marginType: fam.margin === 'coin' ? 'coin-margined' : 'usd-margined',
                    nearContract: near.contract,
                    nearLabel: near.label,
                    farContract: far.contract,
                    farLabel: far.label,
                    nearDaysToExpiry: round(near.days, 2),
                    farDaysToExpiry: round(far.days, 2),
                    gapDays: round(gapDays, 2),
                    nearPrice: near.price,
                    farPrice: far.price,
                    spreadAbsolute: round(far.price - near.price, 4),
                    spreadPercent: round(spreadPercent, 4),
                    // The rate implied between the two expiries rather than
                    // against spot: what the curve prices for that window.
                    forwardAnnualizedPercent: round(spreadPercent * (365 / gapDays), 3),
                    scrapedAt: new Date().toISOString(),
                });
                emitted += 1;
            }
            continue;
        }

        // summary: one row per coin and margin type.
        const front = contracts[0];
        const far = contracts[contracts.length - 1];
        // The ~90 day point is the standard carry reference.
        const quarter = contracts.reduce((best, c) => (
            Math.abs(c.days - 90) < Math.abs(best.days - 90) ? c : best), contracts[0]);
        const reliable = contracts.filter((c) => c.annualizedReliable);
        const best = reliable.reduce((b, c) => ((c.annualizedPercent ?? -Infinity) > (b?.annualizedPercent ?? -Infinity) ? c : b), null);
        await flushRow({
            mode: 'summary',
            coin,
            family: fam.family,
            marginType: fam.margin === 'coin' ? 'coin-margined' : 'usd-margined',
            indexPrice,
            contractCount: contracts.length,
            frontLabel: front.label,
            frontDaysToExpiry: round(front.days, 2),
            frontPremiumPercent: front.premiumPercent,
            frontAnnualizedPercent: front.annualizedPercent,
            quarterContract: quarter.contract,
            quarterDaysToExpiry: round(quarter.days, 2),
            // The headline carry number most desks quote.
            quarterAnnualizedPercent: quarter.annualizedPercent,
            farLabel: far.label,
            farDaysToExpiry: round(far.days, 2),
            farPremiumPercent: far.premiumPercent,
            farAnnualizedPercent: far.annualizedPercent,
            // Premium across the whole curve means contango; a discount at the
            // far end means the market is paying to get out.
            curveShape: far.premiumPercent > front.premiumPercent ? 'contango'
                : far.premiumPercent < front.premiumPercent ? 'backwardation' : 'flat',
            allInPremium: contracts.every((c) => c.premiumPercent > 0),
            steepnessPercent: round(far.premiumPercent - front.premiumPercent, 4),
            bestAnnualizedContract: best?.contract ?? null,
            bestAnnualizedPercent: best?.annualizedPercent ?? null,
            scrapedAt: new Date().toISOString(),
        });
        emitted += 1;
    }
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
