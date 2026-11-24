# Flashscore Scraper: Live Scores, Odds, xG & Match Stats

Pull Flashscore data for **30+ sports** in one run: football (soccer), tennis, basketball, hockey, American football, baseball, handball, rugby, volleyball, cricket, darts, snooker, esports, MMA and more.

- **Fixtures, live scores and results** for any day from 7 days ago to 7 days ahead
- **Match stats**: xG, xGOT, shots, shots on target, possession, corners, big chances, passes, cards (tennis: aces, break points, service points...)
- **Bookmaker odds**: opening and current odds from 15-20 bookmakers per match (bet365, William Hill, Betfair, Unibet, Betway, Ladbrokes, Paddy Power and more, depending on country), 1X2, moneyline, over/under, BTTS, Asian handicap, correct score and more, each with its settled result
- **Match timeline**: goals, cards and substitutions with minute and player
- **Head-to-head and form**: each side's last matches and their previous meetings

No API key, no login, no browser. Uses the same data feeds the Flashscore site loads.

## Who uses it

- **Bettors and tipsters**: today's fixtures with the best price per outcome across bookmakers, and opening vs current odds to spot moves
- **Betting model builders**: results + closing odds + xG for backtesting, refreshed daily on a schedule
- **Telegram / Discord score bots**: a clean live-score feed every few minutes
- **Fantasy, media and data teams**: match stats and timelines without paying for a sports data API

## Example input

Today's top-5 league football with xG and odds:

```json
{
  "sports": ["football"],
  "days": ["0"],
  "leagues": ["ENGLAND: Premier League", "SPAIN: LaLiga", "ITALY: Serie A", "GERMANY: Bundesliga", "FRANCE: Ligue 1"],
  "includeStats": true,
  "includeOdds": true
}
```

Yesterday's NBA and tennis results, scores only (cheapest):

```json
{ "sports": ["basketball", "tennis"], "days": ["-1"], "leagues": ["USA: NBA", "ATP - SINGLES", "WTA - SINGLES"], "status": "finished" }
```

League filters match on the league name Flashscore shows (`COUNTRY: League`), partial and case-insensitive. `Premier League` also matches `Premier League Cup`; write `ENGLAND: Premier League` and add `teams` if you need tighter filtering.

## Example output

```json
{
  "matchId": "OluRZ1ie",
  "sport": "football",
  "country": "England",
  "league": "Premier League",
  "startTime": "2026-11-22T14:00:00.000Z",
  "status": "finished",
  "stage": "Finished",
  "homeTeam": "Hull",
  "awayTeam": "Brighton",
  "homeScore": 2,
  "awayScore": 0,
  "periods": [{ "home": 0, "away": 0 }, { "home": 2, "away": 0 }],
  "winner": "home",
  "homeXg": 1.83,
  "awayXg": 2.23,
  "homePossessionPct": 30,
  "awayPossessionPct": 70,
  "homeShots": 11,
  "awayShots": 15,
  "bookmakerCount": 20,
  "bestHomeOdds": { "odds": 6.6, "bookmaker": "10bet" },
  "bestDrawOdds": { "odds": 4.75, "bookmaker": "Unibetuk" },
  "bestAwayOdds": { "odds": 1.5, "bookmaker": "William Hill" },
  "odds": [
    { "bookmaker": "bet365", "market": "HOME_DRAW_AWAY", "scope": "FULL_TIME", "selection": "home", "line": null, "odds": 6.25, "openingOdds": 6.0, "active": true, "result": "WON" },
    { "bookmaker": "bet365", "market": "OVER_UNDER", "scope": "FULL_TIME", "selection": "over", "line": 2.5, "odds": 1.67, "openingOdds": 1.62, "active": true, "result": "LOST" }
  ],
  "events": [
    { "period": "2nd Half", "minute": "90+2'", "team": "home", "type": "Goal", "player": "McBurnie O.", "secondPlayer": "Gourna-Douath L.", "detail": null }
  ],
  "url": "https://www.flashscore.com/match/OluRZ1ie/#/match-summary"
}
```

`periods` holds the score per half, set, quarter or period in order (null when Flashscore has not published it). `stats` (every stat Flashscore shows, as text), `headToHead` and the full `odds` list are included when you turn those options on.

## Pricing

Pay per result, no monthly fee:

| Event | Price |
|---|---|
| Match row (scores, teams, status) | $0.001 |
| Match details (stats, odds, timeline or head-to-head, any combination) | +$0.002 |

The first row of every run is free. 1,000 matches with scores only cost $1; 1,000 matches with xG and odds cost $3.

## Tips

- **Schedules**: run every 5-15 minutes with `status: "live"` for a live-score feed, or once a day with `days: ["-1"]` and `includeOdds` to log closing odds and results.
- **Bookmakers by country**: `oddsCountry` decides which bookmakers you get (GB, US, DE, KE, NG, AU...).
- **Single matches**: paste Flashscore match URLs or IDs into `matchIds` to refresh only those.

## Related actors

- [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper): US sportsbook odds for NFL, NBA, MLB, NHL
- [Pinnacle Odds Scraper](https://apify.com/scrapemint/pinnacle-odds-scraper): sharp lines from Pinnacle
- [Football xG Stats](https://apify.com/scrapemint/football-xg-stats): season xG tables for teams and players
- [Historical Football Odds](https://apify.com/scrapemint/historical-football-odds): 25 years of closing odds and results for backtesting
