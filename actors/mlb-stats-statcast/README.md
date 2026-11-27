# MLB Stats & Statcast: Exit Velocity, Barrels, xBA by Player

Every MLB hitter and pitcher's **season stats joined with Statcast**: exit velocity, launch angle, hard-hit %, barrels, **xBA, xSLG, xwOBA** and **xERA**. Look up any player for bio, season and career stats, or pull **games with scores and probable pitchers**. Official MLB data (MLB Stats API and Baseball Savant), no API key.

## Three modes

| Mode | Returns |
| --- | --- |
| `season-stats` (default) | one row per qualified (or every) hitter and/or pitcher with season stats + Statcast |
| `players` | the players you name: bio, bats/throws, season stats, career stats, Statcast |
| `games` | schedule and results for a date range: score, winner, records, probable pitchers, series |

## What you get (season-stats, hitter)

| Group | Fields |
| --- | --- |
| Player | `player`, `playerId`, `team`, `teamAbbrev`, `league`, `position`, `age` |
| Season | games, PA, AB, hits, 2B, 3B, HR, runs, RBI, BB, SO, SB, AVG, OBP, SLG, OPS, BABIP |
| Statcast | `avgExitVelocity`, `maxExitVelocity`, `avgLaunchAngle`, `sweetSpotPct`, `hardHitPct`, `barrels`, `barrelPct`, `xba`, `xslg`, `xwoba`, `wobaMinusXwoba` |

Pitchers get W, L, SV, HLD, IP, ERA, WHIP, K, BB, HR allowed, K/9, BB/9, opponent AVG, plus Statcast contact allowed and **xERA**.

`wobaMinusXwoba` is the luck gap: positive means a hitter's results ran ahead of his contact quality (likely to cool off); negative means he was unlucky.

## Example output

```json
{
  "dataType": "hitter",
  "season": 2026,
  "player": "Pete Crow-Armstrong",
  "team": "Chicago Cubs",
  "position": "CF",
  "homeRuns": 45,
  "stolenBases": 41,
  "avg": 0.28,
  "ops": 0.942,
  "statcast": {
    "avgExitVelocity": 90.6,
    "hardHitPct": 48.6,
    "barrelPct": 13.3,
    "xba": 0.264,
    "xslg": 0.508,
    "xwoba": 0.374,
    "wobaMinusXwoba": 0.026
  }
}
```

## Example inputs

```json
{ "mode": "season-stats", "group": "both", "season": 2026, "qualifiedOnly": true }
```

```json
{ "mode": "players", "players": ["Aaron Judge", "Shohei Ohtani", "Tarik Skubal"] }
```

```json
{ "mode": "games", "startDate": "2026-10-24", "endDate": "2026-11-02" }
```

## Who uses it

- **Props and DFS players**: find hitters whose expected stats say a hot or cold streak will turn.
- **Fantasy baseball**: draft and waiver research on quality of contact, not just box scores.
- **Analysts and model builders**: a clean, joined player table every season since 2015.

## Pricing

**$0.002 per row** (player or game). The first row of every run is free. A full qualified leaderboard of hitters and pitchers (about 180 players) costs about 36 cents; every hitter who played (about 650) about $1.30.

## FAQ

**Which seasons?** Season stats go back decades; Statcast starts in 2015.

**What does "qualified" mean?** 3.1 plate appearances per team game for hitters, 1 inning per team game for pitchers, MLB's batting and ERA title cutoffs. Turn it off for everyone.

**Is there data in the off-season?** Season stats and Statcast for the finished season, yes. Games mode returns a free note when no games are scheduled.

## Related actors

- [ESPN Sports Data](https://apify.com/scrapemint/espn-sports-data): MLB scores, standings, injuries and rosters
- [Player Prop Bets: Odds by Player, Stat and Line](https://apify.com/scrapemint/sportsbook-player-props): the prop lines to test these stats against
- [Public Betting Splits: % of Bets vs % of Money](https://apify.com/scrapemint/public-betting-splits): where the money is on every game
- [Sports Odds Scraper: DraftKings, Pinnacle & Bovada](https://apify.com/scrapemint/sports-odds-scraper)
