# Historical Football Odds & Results: Closing Lines

Football results with **opening and closing bookmaker odds** for **38 leagues**, back to the 1990s, in one clean format. Built for backtesting betting models.

Each match row has:

- **Result**: full-time and half-time score, result (H/D/A), total goals, over 2.5, both teams scored
- **Match stats**: shots, shots on target, corners, fouls, cards, referee (main European leagues), xG (from 2026/27)
- **1X2 odds**, opening and closing: **Pinnacle, Bet365, Betfair Exchange, market maximum and market average**
- **Over/under 2.5 goals** odds, opening and closing
- **Asian handicap** line and odds, opening and closing
- **No-vig implied probabilities** (home, draw, away and the overround) from the sharpest line available: Pinnacle closing, then Betfair Exchange closing, then market average
- Optional: **every raw bookmaker column** of the season (William Hill, Interwetten, Ladbrokes, BetVictor, 1xBet and more)

Closing odds start in 2019/20; opening odds go back to 2000/01; results to 1993/94. Data from football-data.co.uk, normalised so every season has the same fields. No API key.

## Leagues

| Region | Leagues (code) |
|---|---|
| England | Premier League (E0), Championship (E1), League One (E2), League Two (E3), National League (EC) |
| Scotland | Premiership (SC0), Championship (SC1), League One (SC2), League Two (SC3) |
| Top 5 | Bundesliga (D1), 2. Bundesliga (D2), Serie A (I1), Serie B (I2), La Liga (SP1), Segunda (SP2), Ligue 1 (F1), Ligue 2 (F2) |
| Rest of Europe | Eredivisie (N1), Belgium (B1), Portugal (P1), Turkey (T1), Greece (G1), Austria (AUT), Denmark (DNK), Finland (FIN), Ireland (IRL), Norway (NOR), Poland (POL), Romania (ROU), Russia (RUS), Sweden (SWE), Switzerland (SWZ) |
| Americas and Asia | MLS (USA), Brazil (BRA), Argentina (ARG), Mexico (MEX), Japan (JPN), China (CHN) |

The 16 leagues with three-letter codes (Austria to China) have closing 1X2 odds only, from about 2012. The 22 others have every field.

## Who uses it

- **Betting model builders**: test a model against closing lines, the standard measure of a betting edge
- **Value bettors**: measure closing line value (CLV) on past bets
- **Data scientists and students**: a clean, consistent football dataset with odds, without cleaning 30 different CSV layouts
- **Tipsters**: prove a track record against the closing price

## Example input

The last 5 seasons of the top 5 leagues:

```json
{ "leagues": ["E0", "SP1", "I1", "D1", "F1"], "lastSeasons": 5 }
```

Every Arsenal match since 2010 with all bookmaker columns:

```json
{ "leagues": ["Premier League"], "lastSeasons": 17, "teams": ["Arsenal"], "includeAllBookmakers": true }
```

## Example output

```json
{
  "country": "England",
  "league": "Premier League",
  "division": "E0",
  "season": "2025/2026",
  "date": "2026-05-24",
  "homeTeam": "Brighton",
  "awayTeam": "Man United",
  "homeGoals": 0,
  "awayGoals": 3,
  "result": "A",
  "halfTimeHomeGoals": 0,
  "halfTimeAwayGoals": 2,
  "over2_5": true,
  "bothTeamsScored": false,
  "homeShots": 13,
  "awayShots": 11,
  "odds1x2Opening": {
    "bet365": { "home": 1.85, "draw": 4.2, "away": 3.6 },
    "betfairExchange": { "home": 1.95, "draw": 4.4, "away": 3.8 },
    "avg": { "home": 1.86, "draw": 3.98, "away": 3.58 }
  },
  "odds1x2Closing": {
    "bet365": { "home": 1.85, "draw": 4.33, "away": 3.5 },
    "betfairExchange": { "home": 1.95, "draw": 4.5, "away": 3.7 },
    "avg": { "home": 1.87, "draw": 4.08, "away": 3.49 }
  },
  "overUnder25Closing": { "bet365": { "over": 1.44, "under": 2.75 } },
  "asianHandicapClosing": { "line": -0.5, "bet365": { "home": 1.88, "away": 1.98 } },
  "impliedProbability": { "home": 0.5101, "draw": 0.221, "away": 0.2688, "overround": 0.0053 },
  "impliedProbabilitySource": "betfairExchange closing"
}
```

A bookmaker is left out of an odds block when the source has no price for it that season.

## Pricing

**$0.0005 per match**, no monthly fee. The first row of every run is free. A full Premier League season (380 matches) costs $0.19; ten seasons of the top 5 leagues (about 18,000 matches) cost about $9.

## Related actors

- [Football xG Stats](https://apify.com/scrapemint/football-xg-stats): xG tables, player xG and xA, match xG
- [Flashscore Scraper](https://apify.com/scrapemint/flashscore-scraper): today's fixtures, live scores and odds
- [Pinnacle Odds Scraper](https://apify.com/scrapemint/pinnacle-odds-scraper): live sharp lines
- [Sports Betting Results](https://apify.com/scrapemint/sports-betting-results): US sports closing lines vs final scores
