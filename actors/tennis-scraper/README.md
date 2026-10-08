# Tennis Scraper: Live Scores, Results, Odds & Stats

Every tennis match for the dates you pick, as clean rows: **live scores**, **results** with set and tiebreak scores, **fixtures**, **average bookmaker odds** with implied probability, **head-to-head** counts, and optional **match stats** (aces, double faults, serve and return points won, break points, winners, unforced errors). ATP, WTA, Challenger and ITF, singles and doubles.

Results and closing odds go back to 2005, so you can backtest a model on years of matches in one run.

No API key, no login, no proxy. $0.002 per match, no start fee.

## What you get per match

- `tournament`, `category` ("ATP - SINGLES"), `tour` (`atp`, `wta`, `challenger-men`, `itf-women`...), `surface` (hard, clay, grass), `doubles`
- `status`: `scheduled`, `live`, `finished`, `retired`, `walkover`, `cancelled`, `postponed`, `interrupted`, `awarded`
- `player1` / `player2`: name, country, slug
- `winner` (1 or 2), `setsWon1`, `setsWon2`
- `sets`: games per set, with `tiebreak1`/`tiebreak2` when the set went to a tiebreak
- `score`: the usual string, e.g. `6-7(3) 6-1 6-2`
- `odds`: `player1`, `player2` (decimal), `impliedPct1`, `impliedPct2`, `favourite`, and `h2hMatches` for fixtures
- `stats` (with Match stats on): per match and per set, each stat for both players. Percentages come split into `pct`, `won` and `total`
- `startTime` (UTC), `matchUrl`, `tournamentUrl`

## Example input

Today's ATP and WTA matches, live and finished, with odds:

```json
{
  "dateFrom": "today"
}
```

Yesterday's results with full serve stats:

```json
{
  "dateFrom": "yesterday",
  "status": "finished",
  "includeStats": true
}
```

Every match a few players played at Roland Garros 2015, with closing odds:

```json
{
  "dateFrom": "2015-05-24",
  "dateTo": "2015-06-07",
  "players": ["Djokovic", "Wawrinka", "Nadal"]
}
```

Tomorrow's Challenger and ITF fixtures:

```json
{
  "dateFrom": "tomorrow",
  "tours": ["challenger-men", "challenger-women", "itf-men", "itf-women"],
  "status": "scheduled"
}
```

## Example output

```json
{
  "matchId": "8v653Rz9",
  "startTime": "2026-10-06T11:15:00.000Z",
  "tour": "atp",
  "category": "ATP - SINGLES",
  "tournament": "Beijing (China)",
  "surface": "hard",
  "status": "retired",
  "player1": { "name": "Djokovic N.", "country": "Serbia", "slug": "djokovic-novak" },
  "player2": { "name": "De Minaur A.", "country": "Australia", "slug": "de-minaur-alex" },
  "winner": 1,
  "setsWon1": 1,
  "setsWon2": 0,
  "sets": [
    { "player1": 7, "player2": 6, "tiebreak1": 7, "tiebreak2": 3 },
    { "player1": 0, "player2": 1 }
  ],
  "score": "7-6(3) 0-1",
  "odds": { "player1": 1.52, "player2": 2.5, "impliedPct1": 65.8, "impliedPct2": 40, "favourite": 1 },
  "stats": {
    "match": {
      "aces": { "player1": 0, "player2": 4 },
      "1stServePointsWon": { "player1": { "pct": 90, "won": 18, "total": 20 }, "player2": { "pct": 74, "won": 25, "total": 34 } }
    }
  },
  "matchUrl": "https://www.flashscore.com/match/8v653Rz9/#/match-summary"
}
```

## Uses

- **Betting models and backtests:** years of results with closing odds, and implied probability ready to compare against your own
- **Daily fixtures with prices:** schedule the run every morning for the day's matches, favourites and head-to-head
- **Live score feeds:** run every few minutes with status Live for in-play set scores
- **Player and serve analysis:** serve and return stats per match and per set for every player on tour

## Pricing

- **$0.002** per match, odds and head-to-head included
- **+$0.002** for the stats block, only on matches that have one, and only with Match stats on
- No start fee. A run that finds no matches is free.

## Notes

- Live scores, statuses and serve stats cover 7 days back to 7 days ahead. Older dates return results, scores and closing odds, without surface or stats.
- Odds are average bookmaker odds. For finished matches they are closing odds. Some small ITF matches have none, and their `odds` is `null`.
- `startTime` is UTC. Older matches carry `localDate` and `localTime` in Central European time instead.
