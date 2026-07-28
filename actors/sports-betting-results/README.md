# Sports Betting Results: Closing Odds vs Final Scores

Every other odds feed stops at kickoff. This one starts there.

It takes the **closing line** a game was actually played at, joins it to the **final score**, and grades the three markets people bet: the moneyline, the spread and the total. No key, no login, no proxy.

Use it to settle a slate, check how your picks did, build a results history for a model, or answer the question every bettor asks on Monday morning: did favourites cover this week, or did the underdogs pay?

## What you get

**Games mode** (default) returns one row per finished game:

| Field | Meaning |
| --- | --- |
| `homeScore`, `awayScore`, `winner`, `margin` | The final result |
| `closingSpreadHome`, `closingSpreadAway` | The spread the game closed at |
| `closingTotal`, `closingMoneylineHome`, `closingMoneylineAway`, `closingMoneylineDraw` | The rest of the closing board |
| `closingSpreadPriceHome`, `closingSpreadPriceAway` | The price attached to each side of the spread |
| `moneylineFavorite`, `spreadFavorite` | Who was favoured in each market, and by which team |
| `moneylineResult` | `favorite_won`, `upset` or `draw` |
| `spreadResult`, `favoriteCovered` | `home_covered`, `away_covered` or `push` |
| `totalResult`, `totalPoints` | `over`, `under` or `push`, with the actual points |
| `favoriteProfit100`, `underdogProfit100`, `favoriteSpreadProfit100` | Profit on a flat 100 stake at the closing price |
| `openingSpreadHome`, `spreadMove` | Where the number opened and how far it travelled |

**Teams mode** returns one row per team over the range: straight up record, record against the spread with a win percentage, over and under record, average closing spread, record as a favourite and as an underdog, and the profit a flat 100 on that team every game would have returned.

**Summary mode** returns one row per league: games graded, how often the favourite won, how often the favourite covered, how often the home side covered, the over percentage, average closing total against the average actual total, and what backing every underdog (or every favourite) would have paid.

## Leagues

`nfl`, `nba`, `mlb`, `nhl`, `ncaaf`, `ncaab`, `wnba`, `epl`, `laliga`, `seriea`, `bundesliga`, `ligue1`, `mls`, `ucl`, `uel`. A raw path such as `football/nfl` also works, so any league the source covers is reachable.

Past seasons work: set `dateFrom` and `dateTo` to any range and the closing prices come back with it.

## Example input

```json
{
  "mode": "games",
  "leagues": ["mlb"],
  "daysBack": 3
}
```

A season month for one league:

```json
{
  "mode": "summary",
  "leagues": ["nfl"],
  "dateFrom": "2025-11-01",
  "dateTo": "2025-11-30"
}
```

## Two things worth knowing

**The moneyline favourite and the spread favourite are not always the same team.** Baseball and hockey run the spread at a fixed 1.5 goals or runs, so the side laying that number is regularly the moneyline underdog. In a sample of MLB games this happened in roughly one game in five. Each market is therefore graded against its own favourite, and both are reported, so `moneylineResult` and `favoriteCovered` never contradict each other.

**Draws lose both sides of a moneyline.** In soccer the draw is priced as its own outcome, so a 2-2 result is reported as `moneylineResult: "draw"` and both the favourite and the underdog stake are marked lost. The draw price is returned as `closingMoneylineDraw` so you can grade it yourself.

## Pricing

Pay per result row, `$0.004`. The first 2 rows of every run are free.

Games that have not been played, games with no published line, and every note row are never charged. A run that finds nothing returns a free row explaining why.

Each finished game costs one lookup, so `maxGames` is the lever that controls both speed and spend. Grading a full 15 game baseball slate takes a few seconds.

## Related actors

- **Sports Odds Scraper** for the lines on games that have not been played yet
- **Sports Odds Movement and Arbitrage Tracker** for how a line is moving right now
- **Sports Futures Odds** for championship, division and award markets
- **Sports Scores, Fixtures & Standings Scraper** for results without the betting layer
