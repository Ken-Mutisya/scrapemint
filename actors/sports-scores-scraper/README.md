# Sports Scores, Fixtures & Standings Scraper

Get **game scores, upcoming fixtures, final results and league tables** as clean rows, ready for your app, bot, spreadsheet or dashboard. Covers world soccer (Premier League, La Liga, Serie A, Bundesliga, Champions League, MLS and dozens more) plus **NBA, WNBA, NFL, MLB, NHL, college sports and cricket**.

Built for **sports app and Discord bot builders, fantasy tools, newsletters, bettors and analysts**. Schedule it daily and always have yesterday's results and today's fixtures; or pull a whole month of results for any league in one run.

## What you get for each game

- **teams**: home and away names and short codes
- **scores**: home and away, live or final, plus the winner
- **when and where**: kickoff or tipoff time, venue and city
- **status**: scheduled, live (with game clock) or final

Standings mode gives one row per team instead: rank, games played, wins, losses, points and the full stat line, with conference and division groups kept.

## Example output

```json
{
  "league": "nba",
  "leagueName": "National Basketball Association",
  "gameId": "401766123",
  "name": "New York Knicks at San Antonio Spurs",
  "date": "2026-07-14T00:00Z",
  "status": "Final",
  "completed": true,
  "homeTeam": "San Antonio Spurs",
  "homeScore": 90,
  "awayTeam": "New York Knicks",
  "awayScore": 94,
  "winner": "New York Knicks",
  "venue": "Frost Bank Center",
  "city": "San Antonio"
}
```

## Which leagues work?

Common names work out of the box: `epl`, `laliga`, `seriea`, `bundesliga`, `ligue1`, `ucl`, `mls`, `nba`, `wnba`, `nfl`, `mlb`, `nhl`, `ncaaf`, `ncaab`. Every other league on ESPN works as `sport/league`, for example:

- `soccer/bra.1` — Brazilian Serie A
- `soccer/ken.1` — Kenyan Premier League
- `soccer/arg.1` — Argentine Liga Profesional
- `cricket/8048` — Indian Premier League

## Dates

Leave the dates empty to get the **current slate** (recent and upcoming games). Or set a from/to date to pull history or a future schedule, up to 31 days per run: post-game results appear within minutes of the final whistle.

## Pricing

**$0.003 per game or standings row.** Unknown league ids and days with no games are **free**, and the first 2 rows of every run are free. A full MLB day (15 games) costs about $0.05; a month of Premier League results costs about $0.11.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~sports-scores-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leagues": ["epl", "nba"], "dataType": "scores", "startDate": "2026-07-01", "endDate": "2026-07-14"}'
```

## Frequently asked questions

**Are live scores really live?** Rows reflect the moment the run executes, including the game clock for games in progress. Schedule runs as often as you need; each run fetches fresh data.

**Can I get betting odds too?** That is a separate tool: [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper). This one focuses on schedules, scores and tables.

**What about player stats?** Not in this version. It covers games and standings; player box scores may come later if people ask.

**Where does the data come from?** ESPN's public website feeds, the same data shown on their scoreboard pages.

## More tools from Scrapemint

- [Sports Odds Scraper](https://apify.com/scrapemint/sports-odds-scraper): betting odds for upcoming games.
- [Streaming Availability Scraper](https://apify.com/scrapemint/streaming-availability-scraper): where to watch movies and shows.
- [Google News Scraper](https://apify.com/scrapemint/google-news-scraper): news coverage for any team or topic.
