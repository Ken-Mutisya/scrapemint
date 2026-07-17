# Sports Player Stats & Rosters Scraper

Player data without an API key, a login or a $50/mo sports-data subscription. Pull complete team rosters, sweep every roster in a league, or get any player's season-by-season career stat line - clean JSON rows from ESPN's public feeds.

## What you can pull

**Rosters** - `"nba lakers"`, `"nfl chiefs"`, `"epl arsenal"`: one row per player with position, jersey number, age, date of birth, height, weight, years of experience, college, birthplace and headshot URL. Works for NBA, WNBA, NFL, MLB, NHL, college basketball and football, and world soccer leagues (Premier League, La Liga, Serie A, Bundesliga, MLS and any ESPN league path - even `soccer/ken.1`).

**Whole-league sweeps** - `"nba"` gives you all ~450 NBA players in one run; `"nfl"` ~1,700. A fresh league-wide player database for the cost of a coffee.

**Career stats by name** - `"LeBron James"`, `"Patrick Mahomes"`: one row per season with the full stat line (per-game averages, season totals, or both), team, and league. Covers NBA, WNBA, NFL, MLB, NHL and college players.

## Example input

```json
{
    "teams": ["nba lakers"],
    "players": ["LeBron James"],
    "statType": "averages"
}
```

Stat rows come back as a named object, so `stats.avgPoints`, `stats.gamesPlayed` and friends are directly usable in a spreadsheet or pipeline.

## Who uses this

- **Fantasy sports tools and pools**: fresh rosters and career baselines without enterprise data contracts.
- **Sports media and newsletters**: player facts and stat tables straight into your workflow.
- **Betting content and models**: roster changes and historical stat lines as structured inputs.
- **Trivia, games and fan apps**: an entire league's player database in one scheduled run.

Pairs with our Sports Scores Scraper (live scores and standings) and Sports Odds Scraper (moneylines, spreads and totals).

## Pricing

A small fee per row. Unknown leagues, unmatched teams and players that cannot be found are free note rows, and the first 2 rows of every run are free.

## Notes

- Career stats are available for the US leagues and college sports; soccer players are found by search but ESPN does not publish their career tables in the same feed, so those return a friendly note pointing at roster mode.
- Some leagues empty their rosters briefly in the offseason; that returns a free note, not a charge.
- Data comes from ESPN's public website feeds, the same JSON its own pages use.
