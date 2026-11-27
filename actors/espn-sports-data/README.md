# ESPN Sports Data: Scores, Standings, Injuries & Rosters

Pull ESPN data for the NFL, NBA, MLB, NHL, WNBA, college football and basketball, Premier League, LaLiga, MLS, Champions League and 20+ more leagues. One actor returns **live scores with the betting line**, **standings**, **injury reports**, **team rosters**, **news** and **teams**. No ESPN account, no API key, no browser.

## What you get

Pick one or more data types per run. Every row carries a `dataType` field so mixed runs stay easy to filter.

| dataType | One row per | Key fields |
| --- | --- | --- |
| `game` | game | start time, status, live clock and period, home/away team, score, record, winner, **DraftKings spread, total and moneylines**, venue, TV |
| `standing` | team | group (conference or division), rank, wins, losses, ties, win %, games behind, points for/against, differential, streak, all ESPN stats |
| `injury` | listed player | team, player, position, status (Out, Questionable, Injured Reserve...), injury type, body part, expected return date, latest note |
| `player` | roster player | team, jersey, position, age, height, weight, birthplace, college, experience, active/injured, headshot |
| `news` | article | headline, summary, published time, byline, teams and players tagged, link |
| `team` | team | ESPN team id, name, abbreviation, colors, logo, team page |

## Example input

```json
{
  "leagues": ["nfl", "nba"],
  "dataTypes": ["scores", "injuries"],
  "startDate": "2026-11-27",
  "endDate": "2026-11-30",
  "teams": []
}
```

Leave the dates empty for the current slate (today's games, or this week's games in the NFL). Use `teams` to narrow any data type to a few teams, for example `["Lakers", "KC", "Arsenal"]`.

## Example output (game)

```json
{
  "dataType": "game",
  "league": "nfl",
  "name": "New York Giants at Cincinnati Bengals",
  "startTime": "2026-11-30T18:00Z",
  "status": "Scheduled",
  "homeTeam": "Cincinnati Bengals",
  "homeRecord": "8-3",
  "awayTeam": "New York Giants",
  "bettingLine": { "provider": "DraftKings", "spread": "CIN -9.5", "overUnder": 48.5, "homeMoneyline": -579, "awayMoneyline": 435 },
  "venue": "Paycor Stadium",
  "broadcast": "CBS"
}
```

## Supported leagues

`nfl`, `ncaaf`, `nba`, `wnba`, `ncaab`, `ncaaw`, `mlb`, `nhl`, `epl`, `championship`, `laliga`, `serie a`, `bundesliga`, `ligue 1`, `eredivisie`, `mls`, `liga mx`, `ucl`, `uel`, `ufc`, `pga`, `f1`, `nascar`, `atp`, `wta`. Any other ESPN league works as a `sport/league` path, for example `soccer/bra.1` for the Brasileirão.

## Who uses it

- **Bettors and model builders**: the slate, the line and the injury report in one pull, before every game day.
- **Fantasy players**: injuries with expected return dates and full rosters.
- **Apps, bots and dashboards**: scores, standings and news without maintaining six ESPN endpoints.
- **AI agents**: one tool call answers "who is playing tonight, who is hurt, and what is the spread".

## Pricing

**$0.0015 per row.** The first row of every run is free. Notes for unknown leagues, days without games or off-season injury reports are free. A full NFL injury report (about 450 players) costs about 68 cents; a night of NBA scores costs under 2 cents.

## FAQ

**Is there a betting line on every game?** ESPN shows the DraftKings line before a game starts. Live and finished games usually have no line, so `bettingLine` is null there.

**How fresh is the data?** Every run reads ESPN live. Scores update during games; injury reports update as teams file them.

**Can I get past seasons?** Scores: yes, set `startDate` and `endDate` (up to 31 days per run). Standings, injuries and rosters are current only.

**Do I need a proxy or an API key?** No.

## Related actors

- [Sports Odds Scraper: DraftKings, Pinnacle & Bovada](https://apify.com/scrapemint/sports-odds-scraper): three sportsbooks side by side with best price and arbitrage
- [Public Betting Splits: % of Bets vs % of Money](https://apify.com/scrapemint/public-betting-splits): where the public and the sharp money are on every game
- [Player Prop Bets: Odds by Player, Stat and Line](https://apify.com/scrapemint/sportsbook-player-props): player props from the sportsbooks
- [MLB Stats & Statcast](https://apify.com/scrapemint/mlb-stats-statcast): season stats and Statcast quality of contact for every MLB player
