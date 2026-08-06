# Sports Odds Scraper

Pregame odds for the major leagues in one clean, normalized schema. Pick your sports and get one row per upcoming game with **moneyline, point spread and total (over/under)**, in American, decimal, fractional or implied probability format, with team names and start time — from a keyless public feed, no login and no API key.

Covers **NFL, college football, NBA, WNBA, college basketball, MLB, NHL, UFC and the top soccer leagues** (Premier League, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Champions League, Europa League) — plus any other league ESPN covers via a `sport/league` path like `soccer/bra.1`.

Built for **odds trackers and alert bots, sports content sites, model builders and bettors** who want structured pregame numbers on a schedule instead of screenshotting a sportsbook.

## What you get for each game

- **home**, **away**, **commenceTime**, **sport**
- **markets[]**: moneyline (`h2h`), `spreads` and `totals`, each outcome carrying the price in your chosen format plus the decimal price and the line/point
- Soccer moneylines include the **Draw** outcome
- **books** with per-outcome price attribution (currently one bookmaker feed, typically DraftKings)
- **dedupe** (on by default): scheduled runs only emit games they have not seen before, so a cron run works as a new-games feed

## Example output

```json
{
  "sport": "mlb",
  "home": "Philadelphia Phillies",
  "away": "New York Mets",
  "commenceTime": "2026-07-16T23:00Z",
  "books": ["draftkings"],
  "markets": [
    { "key": "h2h", "label": "Moneyline", "outcomes": [
      { "name": "Philadelphia Phillies", "point": null, "prices": { "draftkings": { "price": -136, "decimal": 1.7353 } } },
      { "name": "New York Mets", "point": null, "prices": { "draftkings": { "price": 116, "decimal": 2.16 } } }
    ]},
    { "key": "totals", "label": "Total", "outcomes": [
      { "name": "Over", "point": 9.5, "prices": { "draftkings": { "price": -110, "decimal": 1.9091 } } },
      { "name": "Under", "point": 9.5, "prices": { "draftkings": { "price": -110, "decimal": 1.9091 } } }
    ]}
  ]
}
```

## Pricing

**$0.002 per game row.** Games without published odds are skipped and never charged, and the first 2 rows of every run are free. A full MLB slate across every market costs about 3 cents.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~sports-odds-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sports": ["mlb", "nba", "soccer_epl"], "oddsFormat": "decimal", "dedupe": false}'
```

## Frequently asked questions

**Where do the odds come from?** Two keyless public feeds. ESPN's scoreboard carries one bookmaker's pregame lines for each game (typically DraftKings), and Bovada publishes its own prices. Both are normalized into one schema across sports.

**Which sports get two books?** MLB, NFL, NBA, NHL, WNBA, college football and college basketball. Soccer and UFC come from ESPN alone, so those events carry a single book. An event is never dropped for having one price.

**How are the two books matched?** On an exact join: both team names plus the start time to the minute. Nothing fuzzy. If either side differs the event simply stays single book, because a wrong pairing would invent a price gap that is not real.

**Why did you used to read DraftKings and Pinnacle directly?** Both blocked automated access to their own endpoints, so the actor moved to public feeds that are reachable without a key or a proxy.

**Do you have live/in-play odds or player props?** No — pregame moneyline, spread and total. `includeStartedEvents` keeps rows for games already underway, but prices are the pregame closes.

**My scheduled run returns fewer rows than expected.** Dedupe is on by default: each game is emitted once. Set `"dedupe": false` to get the full slate every run, for example to track lines day by day.

**Tennis, golf, F1, esports?** Not available from the current source; those inputs return a free explanatory row rather than silently vanishing.

## More tools from Scrapemint

- [Sports Scores Scraper](https://apify.com/scrapemint/sports-scores-scraper): results, schedules and standings for the same leagues.
- [Polymarket Market Monitor](https://apify.com/scrapemint/polymarket-market-monitor): prediction market prices for real-world events.
- [TradingView Stock Screener](https://apify.com/scrapemint/tradingview-stock-screener-scraper): market data for the finance side.
