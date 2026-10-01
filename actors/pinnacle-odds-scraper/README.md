# Pinnacle Odds Scraper: Sharp Lines, Fair Odds, Limits

Pinnacle's odds for every sport and league it prices, as one clean row per game: moneyline, spread, total and team totals, each outcome with American and decimal odds, implied probability and the **vig-free fair probability**, plus each market's **margin** and the **maximum stake** Pinnacle will accept.

No key, no account, no proxy.

## Why Pinnacle

Pinnacle is the sharp book. It runs on low margins and takes big bets, so its prices move on informed money, and its line with the margin removed is the closest thing betting has to a market consensus. Bettors use it to check whether a soft book's price is value, modelers use it as ground truth, and line movement at Pinnacle is a signal in itself.

## What you get

- **Every sport Pinnacle has open:** soccer (hundreds of leagues), NFL, NCAA, NBA, MLB, NHL, tennis, esports, MMA, boxing, golf, cricket, darts and more
- **Headline fields** for spreadsheets: `homeWinFair`, `awayWinFair`, `drawFair`, `spreadHome`, `totalPoints`
- **Full markets:** each with `marginPct`, `maxStake`, and outcomes carrying `american`, `decimal`, `line`, `impliedProbability`, `fairProbability` and `fairDecimal`
- **Line-movement mode:** with `onlyChanged` on, each run returns only games that are new or whose prices or lines moved since the last run. Unchanged games are skipped and not charged, so a schedule every few minutes is a cheap line alert.

## Example input

NFL and NBA main lines:

```json
{
  "sports": ["Football", "Basketball"],
  "leagues": ["NFL", "NBA"]
}
```

Line moves in top soccer leagues, every 10 minutes on a schedule:

```json
{
  "sports": ["Soccer"],
  "leagues": ["Premier League", "La Liga", "Bundesliga", "Serie A", "Champions League"],
  "includeTeamTotals": true,
  "onlyChanged": true
}
```

## Example output

```json
{
  "sport": "Soccer",
  "league": "Canada - Premier League",
  "gameId": "1637437064",
  "event": "Pacific @ Supra du Quebec",
  "homeTeam": "Supra du Quebec",
  "awayTeam": "Pacific",
  "startTime": "2026-10-04T20:00:00.000Z",
  "isLive": false,
  "homeWinFair": 0.5769,
  "awayWinFair": 0.2023,
  "drawFair": 0.2208,
  "spreadHome": -1,
  "totalPoints": 3.25,
  "markets": [
    {
      "market": "moneyline",
      "period": "game",
      "maxStake": 100,
      "marginPct": 9.14,
      "outcomes": [
        { "outcome": "Supra du Quebec", "side": "home", "american": -170, "decimal": 1.5882, "impliedProbability": 0.6296, "fairProbability": 0.5769, "fairDecimal": 1.733 },
        { "outcome": "Pacific", "side": "away", "american": 353, "decimal": 4.53, "impliedProbability": 0.2208, "fairProbability": 0.2023, "fairDecimal": 4.943 },
        { "outcome": "Draw", "side": "draw", "american": 315, "decimal": 4.15, "impliedProbability": 0.241, "fairProbability": 0.2208, "fairDecimal": 4.529 }
      ]
    }
  ]
}
```

## Pricing

**$0.004 per game**, with every market you asked for in that one row. No start fee. With `onlyChanged`, unchanged games are not charged, and a run where nothing moved costs nothing.

## Notes

- `fairProbability` removes the margin proportionally (each implied probability divided by their sum). It is the standard quick de-vig; other methods (power, Shin) differ slightly at long odds.
- `maxStake` is Pinnacle's own limit for that market. Higher limits mean Pinnacle trusts its price more; limits rise as kick-off approaches.
- Only real games are returned. Pinnacle's "special" markets (player props, futures) are left out because the public feed does not name their outcomes.
- League filters match on the name, so `Premier League` also matches other countries' Premier Leagues; use `England - Premier League` for one.
- For Pinnacle side by side with Bovada and DraftKings, see [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper).
