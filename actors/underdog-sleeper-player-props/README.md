# Underdog & Sleeper Player Props Scraper

Every live **pick'em player prop** on **Underdog Fantasy** and **Sleeper Picks** in one table:

- **NFL, college football, NBA, WNBA, MLB, NHL, college basketball, soccer (EPL, La Liga, MLS...), tennis, MMA, esports (CS)**, whatever the apps have on the board
- **Line** and **higher/lower payout multipliers** for every player and stat, including quarter and half props, first TD scorer and fantasy points
- **Underdog:** American odds and implied probability per side, matchup and kickoff time
- **Sleeper:** the player's **last 10 results** on that stat, the **hit rate** over the line, and how many players pick it and which side
- **Line shopping:** where both apps list the same player and stat, each row shows the **other app's line** and the difference

No account, no API key, no proxy. $0.002 per line, no start fee.

## What you get

`source`, `sport`, `player`, `position`, `team`, `opponent`, `game`, `gameTitle`, `gameTime`, `stat`, `statKey`, `line`, `lineType`, `overMultiplier`, `underMultiplier`, `overAmericanOdds`, `underAmericanOdds`, `overImpliedProbability`, `underImpliedProbability`, `recentValues`, `hitRateLast10`, `pickPopularity`, `overPickShare`, `otherAppLine`, `lineDifference`, `updatedAt`, `playerImageUrl`, `lineId`

## Example input

Sunday's NFL board from both apps:

```json
{
  "sports": ["NFL"]
}
```

One player's lines everywhere:

```json
{
  "players": ["Josh Allen"]
}
```

NHL shots on goal from Sleeper only, with alternate lines:

```json
{
  "sources": ["sleeper"],
  "sports": ["NHL"],
  "stats": ["Shots"],
  "includeAlternates": true
}
```

## Example output

```json
{
  "source": "underdog",
  "sport": "NFL",
  "player": "Nico Collins",
  "position": "WR",
  "team": "HOU",
  "opponent": "JAX",
  "game": "HOU @ JAX",
  "gameTime": "2026-10-18T13:30:00Z",
  "stat": "Receiving Yards",
  "line": 69.5,
  "overMultiplier": 1,
  "underMultiplier": 1,
  "overAmericanOdds": "-118",
  "overImpliedProbability": 0.541,
  "otherAppLine": 72.5,
  "lineDifference": -3
}
```

```json
{
  "source": "sleeper",
  "sport": "NHL",
  "player": "J.T. Miller",
  "team": "NYR",
  "stat": "Points",
  "line": 0.5,
  "overMultiplier": 1.6,
  "underMultiplier": 2,
  "hitRateLast10": 0.556,
  "overPickShare": 1,
  "recentValues": [{ "date": "2026-10-15", "opponent": "PIT", "value": 1 }]
}
```

## Uses

- **Line shopping:** sort by `lineDifference` to find the same prop priced differently on the two apps
- **Pick'em models:** feed lines, multipliers and recent results into your projections every few minutes
- **Content and alerts:** post the day's biggest discrepancies, or alert when a line moves

## Pricing

- **$0.002** per player line
- No start fee. A run that finds nothing is free.

## Notes

- A full board across every sport is several thousand lines. Use the sport, player and stat filters, or `maxRows`, to keep runs small.
- A multiplier above 1 pays more than standard on that side; below 1 pays less. Underdog's implied probability comes from its decimal price.
- Sleeper doesn't publish opponent or kickoff for upcoming games, only the player's team. Its `recentValues` do include past opponents.
- PrizePicks is not included: it blocks automated access with a captcha.
