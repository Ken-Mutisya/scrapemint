/**
 * Pinnacle as a second sportsbook. Copy into an actor's src/ when it needs a
 * book beyond Bovada.
 *
 * Actors ship to Apify as self-contained source directories, so this is a file
 * to copy, not a module to import from outside the actor dir. Same rule as
 * numeric-helpers.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four actors read Bovada and nothing else, so a quota bite returns nothing
 * across all of them, and "best price" or "arbitrage" across a single book is
 * not really either. Pinnacle matters more than a second recreational book:
 * it is the sharp book, it works on low margin and high limits, so its
 * vig-free line is the closest thing to a market consensus price. A gap
 * between Bovada and Pinnacle is a signal; a gap between two soft books is
 * mostly noise.
 *
 * THE OLD "PINNACLE BLOCKS CLOUD IPS" NOTE IS OUT OF DATE for this host.
 * That was the original odds endpoint. `guest.api.arcadia.pinnacle.com`
 * answered HTTP 200 from an Apify datacenter run on 2026-08-10, confirmed
 * three independent ways. It needs no key, no account and no proxy.
 *
 * HOW THE FEED IS SHAPED, and the traps in it
 * -------------------------------------------
 * Two requests per league, not one per game:
 *   /0.1/leagues/{id}/matchups          the fixtures
 *   /0.1/leagues/{id}/markets/straight   every price for the league
 * joined on `matchupId`.
 *
 *  - `type` is "matchup" for a real fixture and "special" for a prop or
 *    futures question. Specials outnumber real games (311 of 388 in NFL) and
 *    their participants are things like "Over"/"Under", so anything that
 *    assumes two teams must filter to type === "matchup" first.
 *  - Prices key on `designation` (home/away/over/under) for real fixtures and
 *    on `participantId` for specials. Participants in the league feed carry NO
 *    id, so a participantId price cannot be resolved there. Filtering to real
 *    fixtures removes the problem rather than papering over it.
 *  - `isAlternate` separates the main line from the alternates. One NFL game
 *    carried 400 markets, of which only 5 were main. Taking them all would
 *    bill a buyer for 80 alternate spreads they did not ask for.
 *  - Prices are AMERICAN integers, not the decimal/fractional object Bovada
 *    sends, and "even" money is 100 rather than a string.
 *  - `limits[].maxRiskStake` is the most a Pinnacle client may risk. It is a
 *    confidence signal in its own right and has no Bovada equivalent.
 */

// Bovada league path -> Pinnacle league id. Only leagues where both books
// price the same competition; an unmapped path simply skips Pinnacle rather
// than guessing, because a wrong league is worse than a missing one.
export const PINNACLE_LEAGUES = {
    'football/nfl': { id: 889, name: 'NFL' },
    'football/college-football': { id: 880, name: 'NCAA Football' },
    'basketball/nba': { id: 487, name: 'NBA' },
    'baseball/mlb': { id: 246, name: 'MLB' },
    'hockey/nhl': { id: 1456, name: 'NHL' },
    'soccer/england/premier-league': { id: 1980, name: 'England - Premier League' },
    'soccer/usa/mls': { id: 2663, name: 'USA - Major League Soccer' },
};

export const PINNACLE_HOST = 'https://guest.api.arcadia.pinnacle.com/0.1';

/** American odds -> decimal. Null in, null out; never a fabricated 0. */
export function americanToDecimal(american) {
    const a = Number(american);
    if (!Number.isFinite(a) || a === 0) return null;
    return a > 0 ? +(a / 100 + 1).toFixed(4) : +(100 / Math.abs(a) + 1).toFixed(4);
}

/**
 * Fetch one league from Pinnacle and return games in a book-neutral shape.
 *
 * `fetchJson` is injected so the caller's own retry, spacing and timeout rules
 * apply rather than a second set hidden in here.
 */
export async function fetchPinnacleLeague(leaguePath, {
    fetchJson,
    includeAlternateLines = false,
    includeNonMainPeriods = false,
    liveOnly = false,
} = {}) {
    const league = PINNACLE_LEAGUES[String(leaguePath || '').replace(/^\//, '')];
    if (!league) return { games: [], unmapped: true };

    const [matchups, markets] = await Promise.all([
        fetchJson(`${PINNACLE_HOST}/leagues/${league.id}/matchups`),
        fetchJson(`${PINNACLE_HOST}/leagues/${league.id}/markets/straight`),
    ]);
    if (!Array.isArray(matchups) || !Array.isArray(markets)) {
        return { games: [], error: 'pinnacle feed unavailable' };
    }

    const games = new Map();
    for (const m of matchups) {
        // Specials carry "Over"/"Under" as participants and would otherwise be
        // published as if they were fixtures between two teams.
        if (m?.type !== 'matchup') continue;
        if (liveOnly && m.isLive !== true) continue;
        const parts = Array.isArray(m.participants) ? m.participants : [];
        const home = parts.find((p) => p.alignment === 'home')?.name || null;
        const away = parts.find((p) => p.alignment === 'away')?.name || null;
        if (!home || !away) continue;
        const periodStatus = new Map((m.periods || []).map((p) => [p.period, p.status]));
        games.set(m.id, {
            eventId: String(m.id),
            event: `${away} @ ${home}`,
            league: league.name,
            leaguePath,
            startTime: m.startTime ? new Date(m.startTime).toISOString() : null,
            isLive: m.isLive === true,
            competitors: [
                { name: home, shortName: null, isHome: true },
                { name: away, shortName: null, isHome: false },
            ],
            periodStatus,
            markets: [],
        });
    }

    for (const mk of markets) {
        const game = games.get(mk?.matchupId);
        if (!game) continue;
        if (!includeAlternateLines && mk.isAlternate === true) continue;
        const period = Number(mk.period ?? 0);
        if (!includeNonMainPeriods && period !== 0) continue;

        const prices = Array.isArray(mk.prices) ? mk.prices : [];
        // A designation-less price belongs to a special; without participant
        // ids in this feed it cannot be named, so it is dropped rather than
        // published as an unlabelled outcome.
        if (!prices.length || prices.some((p) => !p.designation)) continue;

        const outcomes = prices.map((p) => {
            const american = Number.isFinite(Number(p.price)) ? Number(p.price) : null;
            return {
                outcome: designationLabel(p.designation, mk.type, game),
                outcomeType: String(p.designation),
                isOpen: true,
                priceAmerican: american,
                priceDecimal: americanToDecimal(american),
                priceFractional: null,
                handicap: p.points === undefined || p.points === null ? null : Number(p.points),
                handicapSecondary: null,
                isSplitLine: false,
            };
        });

        const status = periodStatusOf(game, period);
        game.markets.push({
            marketId: mk.key || null,
            // Pinnacle names the market type itself, so there is no need to
            // classify a label. Team totals are reported as "total" to match
            // how the Bovada side classifies them, with the distinction kept
            // in the market name instead of inventing a type on one book only.
            marketType: marketTypeOf(mk.type, outcomes.length),
            marketName: marketNameOf(mk.type, mk.key),
            period,
            isMainPeriod: period === 0,
            isOpen: status === 'open',
            marketStatus: status === 'open' ? 'open' : 'suspended',
            maxRiskStake: maxStakeOf(mk.limits),
            outcomes,
        });
    }

    const out = [...games.values()].filter((g) => g.markets.length);
    for (const g of out) delete g.periodStatus;
    return { games: out, leagueName: league.name };
}

function periodStatusOf(game, period) {
    const s = game.periodStatus?.get(period);
    return s === undefined ? 'open' : s;
}

function maxStakeOf(limits) {
    if (!Array.isArray(limits)) return null;
    const l = limits.find((x) => x?.type === 'maxRiskStake');
    const v = Number(l?.amount);
    return Number.isFinite(v) ? v : null;
}

function marketTypeOf(type, outcomeCount) {
    if (type === 'moneyline') return outcomeCount >= 3 ? 'moneyline_3way' : 'moneyline';
    if (type === 'spread') return 'spread';
    if (type === 'total' || type === 'team_total') return 'total';
    return 'other';
}

function marketNameOf(type, key) {
    if (type === 'moneyline') return 'Moneyline';
    if (type === 'spread') return 'Point Spread';
    if (type === 'total') return 'Total';
    if (type === 'team_total') {
        // key looks like "s;0;tt;28.5;home", so the side is the last segment.
        const side = String(key || '').split(';').pop();
        return side === 'home' || side === 'away' ? `Team Total (${side})` : 'Team Total';
    }
    return type ? String(type) : null;
}

function designationLabel(designation, type, game) {
    const d = String(designation).toLowerCase();
    if (d === 'home') return game.competitors.find((c) => c.isHome)?.name || 'Home';
    if (d === 'away') return game.competitors.find((c) => !c.isHome)?.name || 'Away';
    if (d === 'draw') return 'Draw';
    if (d === 'over') return 'Over';
    if (d === 'under') return 'Under';
    return designation ? String(designation) : null;
}
