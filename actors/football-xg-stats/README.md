# Football xG Stats: xG Table, Player xG/xA & Match xG

Expected goals (xG) data for **40+ football leagues**, in three modes:

- **Teams**: the xG league table. Points, goals and the expected version of each: xG, xGA, xG difference, **expected points (xPts)** and **expected position**, plus how far each team is over or under them. Adds possession, big chances, clean sheets, set-piece goals, cards and the FotMob team rating.
- **Players**: xG, xGOT, xA, xG and xA per 90, goals and assists minus expected, minutes, shots, big chances created and missed, dribbles, tackles, interceptions, saves, goals prevented and rating. One row per player.
- **Matches**: every finished match of the season with home and away xG, **non-penalty xG**, xGOT, possession, shots, big chances, corners and every other match stat. Add the **shot map** for minute, player, result, xG, xGOT, situation, shot type and pitch position of each shot.

Leagues include the Premier League, Championship, League One, LaLiga, Serie A, Bundesliga, Ligue 1, Eredivisie, Liga Portugal, Scottish Premiership, Belgian Pro League, Super Lig, MLS, Brasileirao, Liga MX, Saudi Pro League, J League, A-League, Champions League, Europa League and Conference League. Past seasons too. Data from FotMob, no API key, no login.

## Who uses it

- **Football bettors**: find teams whose points run ahead of their xPts (likely to regress) and back the ones running behind
- **Betting and fantasy model builders**: match xG and shot-level data for every game, season after season
- **Scouts, analysts and writers**: player xG, xA and per-90 tables filtered by minutes
- **FPL and fantasy players**: who is getting the chances, not only the goals

## Example input

xG table for the top 5 leagues:

```json
{ "mode": "teams", "leagues": ["Premier League", "LaLiga", "Serie A", "Bundesliga", "Ligue 1"] }
```

Last season's LaLiga players with 900+ minutes:

```json
{ "mode": "players", "leagues": ["LaLiga"], "season": "2025/2026", "minMinutes": 900 }
```

The last 10 Premier League matches with shot maps:

```json
{ "mode": "matches", "leagues": ["Premier League"], "lastMatches": 10, "includeShots": true }
```

## Example output

Team (xG table):

```json
{
  "league": "Premier League",
  "season": "2026/2027",
  "position": 1,
  "team": "Arsenal",
  "played": 11,
  "points": 28,
  "goalsFor": 17,
  "goalsAgainst": 7,
  "xg": 17.64,
  "xga": 9.31,
  "xgDiff": 8.3,
  "xPoints": 21.42,
  "xPosition": 1,
  "pointsMinusXPoints": 6.58,
  "possessionPct": 60.3,
  "bigChances": 28,
  "cleanSheets": 7
}
```

Player:

```json
{
  "league": "LaLiga",
  "season": "2025/2026",
  "player": "Kylian Mbappé",
  "team": "Real Madrid",
  "minutes": 2604,
  "goals": 25,
  "xg": 23.9,
  "xgot": 22,
  "assists": 5,
  "xa": 6.2,
  "xgPer90": 0.83,
  "xgPlusXaPer90": 1.04,
  "goalsMinusXg": 1.1,
  "bigChancesMissed": 21,
  "rating": 8.02
}
```

Match:

```json
{
  "league": "Premier League",
  "date": "2026-11-21T15:00:00Z",
  "homeTeam": "Chelsea",
  "awayTeam": "Leeds United",
  "homeGoals": 1,
  "awayGoals": 4,
  "homeXg": 0.64,
  "awayXg": 2.77,
  "homeNonPenaltyXg": 0.64,
  "awayNonPenaltyXg": 1.98,
  "homePossessionPct": 57,
  "homeShots": 14,
  "awayShots": 21
}
```

A stat is `null` when FotMob does not rank that player or team for it (for example, a player with no assists is missing from the assists list).

## Pricing

**$0.002 per row**, no monthly fee. The first row of every run is free. A full Premier League xG table costs $0.04; every match of a 380-game season costs $0.76.

## Related actors

- [Flashscore Scraper](https://apify.com/scrapemint/flashscore-scraper): live scores, odds and match stats for 30+ sports
- [Historical Football Odds](https://apify.com/scrapemint/historical-football-odds): 25 years of closing odds and results
- [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper): live sportsbook odds
