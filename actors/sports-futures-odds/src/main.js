// Sports Futures Odds: Who Is Favored to Win the Title & Awards
//
// What it does
// ------------
// Game lines tell you who is favoured tonight. FUTURES tell you who is
// favoured to win the whole thing: the Super Bowl, a division, MVP, the
// scoring title. This pulls every futures market a league lists, with the
// price on every team or player in the field.
//
// Distinct from our sports-odds-scraper, which reads per game spreads,
// moneylines and totals for scheduled fixtures. Nothing here is a game line.
//
//   futures  one row per entry: the team or player, the American price, and
//            the probability that price implies
//   markets  one row per market: how many are in the field, who the favourite
//            is, their price, and how much margin the book is holding
//
// The computed layer
// ------------------
// ESPN publishes raw American prices and nothing else. Every row here also
// carries `impliedProbability`, and a `fairProbability` with the bookmaker's
// margin removed. Raw implied probabilities across a 32 team field sum to well
// above 100%; the excess is the overround, and dividing it out is what makes
// two markets comparable. Both numbers are reported so nothing is hidden.
//
// Cost shape
// ----------
// One request returns every market and every price for a league. Team and
// player names arrive as reference links, so only the entries actually being
// emitted are resolved, and every reference is cached for the run. Asking for
// the top 10 of each market costs a handful of lookups rather than hundreds.
//
// Pay per event
// -------------
//   futures_row ($0.004) charged per row pushed. First 2 rows per run free.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 30000;
const REF_SLEEP_MS = 60;
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'futures',
    leagues = ['nfl', 'nba'],
    season = 0,
    marketFilter = [],
    entriesPerMarket = 10,
    maxOdds = 0,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Friendly names -> ESPN sport/league paths. A raw "sport/league" passes
// through, so any ESPN league works even if it is not listed here.
const LEAGUE_PATHS = {
    nfl: 'football/nfl',
    ncaaf: 'football/college-football',
    nba: 'basketball/nba',
    wnba: 'basketball/wnba',
    ncaab: 'basketball/mens-college-basketball',
    mlb: 'baseball/mlb',
    nhl: 'hockey/nhl',
    // Listed so soccer reports "no futures published" rather than being
    // mistaken for a typo; ESPN carries no futures board for these.
    epl: 'soccer/eng.1',
    laliga: 'soccer/esp.1',
    seriea: 'soccer/ita.1',
    bundesliga: 'soccer/ger.1',
    ligue1: 'soccer/fra.1',
    mls: 'soccer/usa.1',
    ucl: 'soccer/uefa.champions',
};

const theMode = ['futures', 'markets'].includes(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'futures';
const leagueKeys = asList(leagues);
if (!leagueKeys.length) leagueKeys.push('nfl');
const filters = asList(marketFilter).map((s) => s.toLowerCase());
const perMarket = Math.max(1, Math.min(500, Number(entriesPerMarket) || 10));
const oddsCeiling = Math.max(0, Number(maxOdds) || 0);
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));
const seasonYear = Number(season) > 2000 ? Number(season) : new Date().getUTCFullYear();

async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Scrapemint/1.0)' },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'futures_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

// "+550" -> 0.1538, "-200" -> 0.6667
function impliedFromAmerican(value) {
    const s = String(value ?? '').replace(/\s/g, '');
    const m = s.match(/^([+-]?)(\d+)$/);
    if (!m) return null;
    const n = Number(m[2]);
    if (!n) return null;
    return m[1] === '-' ? n / (n + 100) : 100 / (n + 100);
}
const americanToDecimal = (value) => {
    const p = impliedFromAmerican(value);
    return p ? round(1 / p, 4) : null;
};

// Team and athlete names arrive as $ref links; resolve each one only once.
const refCache = new Map();
async function resolveName(ref) {
    if (!ref) return {};
    if (refCache.has(ref)) return refCache.get(ref);
    const j = await getJson(ref);
    await sleep(REF_SLEEP_MS);
    const out = j ? {
        name: clean(j.displayName || j.fullName || j.name),
        shortName: clean(j.shortDisplayName || j.abbreviation || j.shortName),
        id: j.id ? String(j.id) : null,
    } : {};
    refCache.set(ref, out);
    return out;
}

let emitted = 0;
const stopEarly = () => (deadlineMs && Date.now() > deadlineMs) || emitted >= cap;

log.info(`Sports futures ${theMode} | ${leagueKeys.join(', ')} | season ${seasonYear} | top ${perMarket}/market | cap ${cap} rows`);

for (const key of leagueKeys) {
    if (stopEarly()) break;
    const path = LEAGUE_PATHS[key.toLowerCase()] || (key.includes('/') ? key : null);
    if (!path) {
        await flushRow({ type: 'note', league: key, found: false, note: 'unknown league; use nfl, nba, mlb, nhl, ncaaf, ncaab, wnba or a raw ESPN sport/league path; not charged' }, false);
        continue;
    }
    const [sport, leagueId] = path.split('/');

    // The season rolls over before the new futures board is posted, so fall
    // back one year rather than reporting an empty league.
    let data = await getJson(`${CORE}/${sport}/leagues/${leagueId}/seasons/${seasonYear}/futures`);
    let usedSeason = seasonYear;
    if (!data?.items?.length) {
        data = await getJson(`${CORE}/${sport}/leagues/${leagueId}/seasons/${seasonYear - 1}/futures`);
        usedSeason = seasonYear - 1;
    }
    const markets = data?.items || [];
    if (!markets.length) {
        log.warning(`${key}: no futures markets published`);
        await flushRow({
            type: 'note', league: key, found: false,
            note: 'no futures markets published for this league; soccer leagues in particular do not carry futures; not charged',
        }, false);
        continue;
    }
    log.info(`${key}: ${markets.length} futures market(s), season ${usedSeason}`);

    for (const market of markets) {
        if (stopEarly()) break;
        const marketName = clean(market.displayName || market.name);
        if (filters.length && !filters.some((f) => String(marketName).toLowerCase().includes(f))) continue;

        const providerBlock = (market.futures || [])[0];
        const provider = clean(providerBlock?.provider?.name);
        const books = providerBlock?.books || [];
        if (!books.length) continue;

        // Compute the overround across the WHOLE field before slicing, or the
        // fair probabilities would be normalised against a partial market.
        const priced = books
            .map((b) => ({ raw: b, implied: impliedFromAmerican(b.value) }))
            .filter((b) => b.implied != null);
        const overround = priced.reduce((t, b) => t + b.implied, 0);
        // A real market's implied probabilities sum ABOVE 100%; the excess is
        // the bookmaker's margin. A sum BELOW 100% means the source listed only
        // part of the field (the NBA title market arrived with 3 of 30 teams),
        // and normalising against it turns a +6000 longshot into a fabricated
        // 64% chance. So fair probability is only computed on a complete book.
        const fieldComplete = overround >= 1;
        const fair = (p) => (fieldComplete ? round((p / overround) * 100, 3) : null);

        priced.sort((a, b) => b.implied - a.implied);
        const favourite = priced[0];
        const favName = favourite ? await resolveName(favourite.raw.team?.$ref || favourite.raw.athlete?.$ref) : {};

        if (theMode === 'markets') {
            await flushRow({
                mode: 'markets',
                league: key,
                season: usedSeason,
                market: marketName,
                marketId: market.id ? String(market.id) : null,
                provider,
                entrants: priced.length,
                favourite: favName.name ?? null,
                favouriteOdds: clean(favourite?.raw?.value),
                favouriteImpliedProbability: round(favourite?.implied * 100, 3),
                favouriteFairProbability: favourite ? fair(favourite.implied) : null,
                fieldComplete,
                // Sum of implied probabilities minus 100%: the book's margin.
                marketOverroundPercent: round((overround - 1) * 100, 3),
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
            continue;
        }

        let rank = 0;
        for (const entry of priced.slice(0, perMarket)) {
            if (stopEarly()) break;
            const value = clean(entry.raw.value);
            const numeric = Number(String(value).replace('+', ''));
            if (oddsCeiling && Number.isFinite(numeric) && numeric > oddsCeiling) continue;
            rank += 1;
            const who = await resolveName(entry.raw.team?.$ref || entry.raw.athlete?.$ref);
            await flushRow({
                mode: 'futures',
                league: key,
                season: usedSeason,
                market: marketName,
                provider,
                rank,
                competitor: who.name ?? null,
                competitorShort: who.shortName ?? null,
                competitorId: who.id ?? null,
                competitorType: entry.raw.team?.$ref ? 'team' : 'athlete',
                americanOdds: value,
                decimalOdds: americanToDecimal(value),
                impliedProbability: round(entry.implied * 100, 3),
                // Implied probability with the bookmaker's margin divided out.
                // Null when the listed field is incomplete; see fieldComplete.
                fairProbability: fair(entry.implied),
                fieldComplete,
                entrants: priced.length,
                marketOverroundPercent: round((overround - 1) * 100, 3),
                scrapedAt: new Date().toISOString(),
            });
            emitted += 1;
        }
    }
}

if (!emitted) {
    await flushRow({ type: 'note', found: false, note: 'no futures markets matched; try a different league or clear marketFilter; not charged' }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable). ${refCache.size} name lookup(s).`);
await Actor.exit();
