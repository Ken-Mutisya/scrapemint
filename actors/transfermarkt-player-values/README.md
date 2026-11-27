# Transfermarkt Player Values: Market Value, Transfers, Contracts

Get Transfermarkt data for **any player, a whole club squad, or every squad in a league**: current market value, last change, all-time high, contract end date, club, shirt number, position, nationality and age. Turn on **market value history** and **transfer history** (with fees) when you need the full story. No account, no API key, no browser.

## Three ways to ask

| Input | Example | Returns |
| --- | --- | --- |
| `players` | `["Erling Haaland", "Bukayo Saka"]` or Transfermarkt URLs or ids | those players |
| `clubs` | `["Arsenal", "Real Madrid"]` | every player in the current squad |
| `leagues` | `["premier league", "laliga"]` | every player of every club (about 550 for the Premier League) |

Names are matched with Transfermarkt's own search. Mix all three in one run.

## What you get (one row per player)

| Field | Example |
| --- | --- |
| `name`, `age`, `dateOfBirth`, `placeOfBirth` | Erling Haaland, 26, 2000-07-21, Leeds |
| `nationality`, `nationalTeam` | ["Norway"], Norway |
| `position`, `positionGroup`, `preferredFoot`, `heightM` | Centre-Forward, Striker, left, 1.95 |
| `club`, `shirtNumber`, `joined`, `contractUntil` | Manchester City, 9, 2022-07-01, 2034-06-30 |
| `marketValueEur`, `marketValueDate` | 220000000, 2026-07-22 |
| `previousMarketValueEur`, `marketValueChangePct` | 200000000, 10 |
| `highestMarketValueEur`, `highestMarketValueDate` | 220000000, 2026-07-22 |
| `valueHistory[]` (optional) | date, valueEur, club, age for every valuation |
| `transfers[]` (optional) | date, season, from, to, fee, `feeEur`, market value at the time |
| `photo`, `url` | portrait and Transfermarkt profile |

## Example input

```json
{
  "leagues": ["premier league"],
  "minMarketValueEur": 50000000,
  "includeTransfers": true
}
```

## Who uses it

- **Fantasy and betting analysts**: squad value as a team-strength input, and which players are rising or falling.
- **Scouts, agents and clubs**: contract end dates for the next transfer window, value trends by position and age.
- **Journalists and content creators**: most valuable squads, biggest risers, transfer fee tables.
- **Data scientists**: market value as a target or feature in player models.

## Pricing

- **$0.002 per player.** The first player of every run is free.
- **+$0.002 per player** only when you turn on value history or transfer history.
- No start fee. Players filtered out by `minMarketValueEur` are not charged.

A full Premier League (about 550 players) costs about $1.10; one club squad about 5 cents.

## FAQ

**How current are the values?** Every run reads Transfermarkt live. Values change when Transfermarkt publishes a new valuation, usually a few times a season.

**Can I get a past season's squad?** Squads are the current squad. Value history and transfer history go back over each player's whole career.

**Do I need a proxy?** No.

## Related actors

- [Football xG Stats: xG Table, Player xG/xA & Match xG](https://apify.com/scrapemint/football-xg-stats): expected goals for the same leagues
- [Flashscore Scraper: Live Scores, Odds, xG & Match Stats](https://apify.com/scrapemint/flashscore-scraper): fixtures, results and odds
- [Historical Football Odds & Results: Closing Lines](https://apify.com/scrapemint/historical-football-odds): years of results with closing odds
- [ESPN Sports Data](https://apify.com/scrapemint/espn-sports-data): scores, standings and injuries
