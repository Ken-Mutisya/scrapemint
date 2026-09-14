# DraftKings Odds: Line Movement, Spreads and Totals

DraftKings spreads, totals and moneylines for NFL, college football, MLB, WNBA and top soccer — with **the opening line next to the current one**, so you can see where the line moved instead of only where it landed.

Anyone can tell you tonight's number. What costs money to find out is that Kansas City opened **-155** and is now **-130**.

No API key, no login, no browser, no proxy. One row per game.

## What you get for each game

| field | example |
|---|---|
| `event` / `shortName` | `Denver Broncos at Kansas City Chiefs` / `DEN @ KC` |
| `home` / `away` / `favorite` | `Kansas City Chiefs` / `Denver Broncos` / `Kansas City Chiefs` |
| `commenceTime` | `2026-09-15T00:15Z` |
| `details` | `KC -2.5` |
| `spread` | `{ current: -2.5, open: -2.5, move: 0 }` |
| `total` | `{ current: 42.5, overOdds: -110, underOdds: -110 }` |
| `moneyline` | `{ home: -130, homeOpen: -155, homeMove: 25, away: 110, awayOpen: 130, awayMove: -20 }` |
| `movement` | `{ moved: true, spreadMove: 0, homeMoneylineMove: 25, threshold: 2 }` |

Odds come in American by default; set `oddsFormat` to `decimal` for `2.30` / `1.65`.

## Finding the games that moved

Set `onlyMoved` to return just the games whose line has shifted, and `minLineMove` to say how far counts:

```json
{
  "sports": ["nfl", "ncaaf"],
  "onlyMoved": true,
  "minLineMove": 2
}
```

A **higher** threshold means fewer games qualify — and a cheaper run, because moved games bill at the higher rate. You control that trade directly.

## Leagues

`nfl` · `ncaaf` · `mlb` · `nba` · `wnba` · `ncaab` · `nhl` · `epl` · `laliga` · `bundesliga` · `seriea` · `ligue1` · `mls` · `ucl`

DraftKings prices NFL, college football, MLB, WNBA and top soccer year-round on this feed. NBA, NHL and college basketball carry odds in season. When a league has games scheduled but no prices posted, you get a short note row explaining it — **never an empty dataset with no reason, and nothing charged**.

## Pricing

| event | price | what it is |
|---|---|---|
| `line_row` | $0.004 | a game with a current DraftKings line |
| `line_move_row` | $0.012 | a game whose line has moved past your threshold |

A game is charged once, under one or the other. Games DraftKings has not priced are skipped and cost nothing, as are note rows. Every row you receive is charged — there is no per-run free allowance to work around.

## Notes on the data

- **The opening total is not published.** ESPN carries an opening spread and opening moneyline but no opening total, so `total.open` is `null` rather than a copy of the current number. A confident wrong figure is worse than an honest gap on a row you are betting against.
- **Pregame only by default.** Set `includeStartedEvents` to include games already under way.
- **`dedupe`** remembers game ids between runs so a scheduled run returns only new games. Leave it off when you are tracking movement on the same games over time — which is usually the point.

## Related actors

- [Betting Odds Comparison: Best Price & Arbitrage Finder](https://apify.com/scrapemint/sports-odds-scraper) — Bovada and Pinnacle side by side, with best price and arbitrage. Runs well beside this one: three books instead of one.
- [Player Prop Bets: Odds by Player, Stat and Line](https://apify.com/scrapemint/sportsbook-player-props)
- [Sports Odds Movement and Arbitrage Tracker](https://apify.com/scrapemint/sports-odds-movement-tracker)
