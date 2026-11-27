# Public Betting Splits: % of Bets vs % of Money by Game

See where the public is betting and where the big money is going on every **NFL, NBA, MLB, NHL, WNBA, college football, college basketball and soccer** game. For each side of the **spread, moneyline and total** you get the **% of bets**, the **% of money**, the consensus line and price, plus a **sharp-money flag** when the money share runs well ahead of the bet share. No account, no API key.

## Why bettors use splits

When 70% of tickets are on one team but only 50% of the money is, the other side is drawing fewer, bigger bets. Bettors call that **sharp money**, and "fade the public" strategies are built on exactly this gap. This actor computes it for you on every market.

## What you get (one row per game)

| Field | Meaning |
| --- | --- |
| `homeTeam`, `awayTeam`, `startTime`, `status`, `winner` | The game (`winner` once it is final) |
| `totalBets` | Number of bets tracked on the game |
| `spread.home` / `spread.away` | line, odds, `betsPct`, `moneyPct`, `moneyMinusBets` |
| `moneyline.home` / `away` / `draw` | odds, `betsPct`, `moneyPct`, `moneyMinusBets` |
| `total.over` / `total.under` | line, odds, `betsPct`, `moneyPct`, `moneyMinusBets` |
| `sharpSignals` | per market, the side whose money beats its bets by your gap (default 10 points), or null |
| `hasSharpSignal` | true when any market is flagged |

## Example output

```json
{
  "league": "nfl",
  "homeTeam": "Los Angeles Chargers",
  "awayTeam": "New England Patriots",
  "startTime": "2026-11-29T21:05:00.000Z",
  "totalBets": 8396,
  "spread": {
    "home": { "line": 2.5, "odds": -107, "betsPct": 41, "moneyPct": 43, "moneyMinusBets": 2 },
    "away": { "line": -2.5, "odds": -111, "betsPct": 59, "moneyPct": 57, "moneyMinusBets": -2 }
  },
  "moneyline": {
    "home": { "line": null, "odds": 119, "betsPct": 29, "moneyPct": 45, "moneyMinusBets": 16 },
    "away": { "line": null, "odds": -142, "betsPct": 71, "moneyPct": 55, "moneyMinusBets": -16 }
  },
  "total": {
    "over": { "line": 35.5, "odds": -107, "betsPct": 85, "moneyPct": 84, "moneyMinusBets": -1 },
    "under": { "line": 35.5, "odds": -111, "betsPct": 15, "moneyPct": 16, "moneyMinusBets": 1 }
  },
  "sharpSignals": { "spread": null, "moneyline": { "side": "Los Angeles Chargers", "gap": 16 }, "total": null },
  "hasSharpSignal": true
}
```

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `leagues` | `["nfl"]` | nfl, nba, mlb, nhl, wnba, ncaaf, ncaab, soccer |
| `date` | today | YYYY-MM-DD, daily leagues (NBA, MLB, NHL, WNBA, college basketball, soccer) |
| `days` | 1 | daily leagues: read up to 14 days from the date |
| `week` | current week | NFL and college football are weekly boards: set a week number for a past or future week |
| `season` | current season | football season year for `week` |
| `includeCompleted` | false | also return finished games with their final splits |
| `onlySharpSignals` | false | only games with at least one flagged side |
| `sharpGapPct` | 10 | money % minus bets % needed for a flag |

Run it on a schedule (every hour on game days) to watch the splits move as kickoff gets closer.

## Pricing

**$0.004 per game.** The first game of every run is free. Off-season leagues and empty slates return a free note. A full NFL Sunday slate costs about 5 cents; a Saturday of college football about 25 cents.

## FAQ

**Where do the numbers come from?** Action Network's public betting consensus, which aggregates tickets and handle reported across sportsbooks.

**Why do some games have no splits?** Splits appear once enough bets are tracked. Far-off games and small leagues may have none yet; they are skipped and not charged.

**Is this betting advice?** No. Splits are one input. The sharp flag only says the money share leads the bet share.

## Related actors

- [Sports Odds Scraper: DraftKings, Pinnacle & Bovada](https://apify.com/scrapemint/sports-odds-scraper): the same games priced at three books, with best price and arbitrage
- [Sports Odds Movement and Arbitrage Tracker](https://apify.com/scrapemint/sports-odds-movement-tracker): which lines moved since your last run
- [ESPN Sports Data](https://apify.com/scrapemint/espn-sports-data): scores, injuries and rosters for the same leagues
- [Sports Betting Results: Closing Odds vs Final Scores](https://apify.com/scrapemint/sports-betting-results): grade your picks after the games
