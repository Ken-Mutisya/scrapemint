# Sports Odds Scraper: DraftKings, Pinnacle & Bovada

Sports betting odds from **DraftKings, Pinnacle and Bovada** on a single line per game, with the best available price per outcome and arbitrage where the books disagree. Pregame odds for the major leagues in one clean, normalized schema. Pick your sports and get one row per upcoming game with **moneyline, point spread and total (over/under)**, in American, decimal, fractional or implied probability format, with team names and start time — from a keyless public feed, no login and no API key.

Covers **NFL, college football, NBA, WNBA, college basketball, MLB, NHL, UFC and the top soccer leagues** (Premier League, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Champions League, Europa League) — plus any other league ESPN covers via a `sport/league` path like `soccer/bra.1`.

Built for **odds trackers and alert bots, sports content sites, model builders and bettors** who want structured pregame numbers on a schedule instead of screenshotting a sportsbook.

## What you get for each game

- **home**, **away**, **commenceTime**, **sport**
- **markets[]**: moneyline (`h2h`), `spreads` and `totals`, each outcome carrying the price in your chosen format plus the decimal price and the line/point
- Soccer moneylines include the **Draw** outcome
- **books** with per-outcome price attribution: up to three books per game (DraftKings, Pinnacle, Bovada)
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

**Where do the odds come from?** Three keyless public feeds. ESPN's scoreboard carries DraftKings' pregame lines, Pinnacle publishes its own prices through its guest API, and Bovada publishes its own coupon feed. All three are normalized into one schema.

**Which sports get several books?** NBA, NHL, NFL, MLB, WNBA and college football and basketball can carry all three. Premier League and MLS add Pinnacle to ESPN's line. Other soccer leagues and UFC come from ESPN alone. A game any one book lists is returned, even with a single price.

**How are the books matched?** Both team names must match exactly, and the start times must be within 45 minutes (Bovada stamps the real puck drop or first pitch, a few minutes after the scheduled start). No fuzzy team matching. If the names differ the game simply stays single book, because a wrong pairing would invent a price gap that is not real.

**Why not read DraftKings directly?** DraftKings blocks automated access to its own endpoints, so its lines come through ESPN's public scoreboard instead. ESPN only posts lines for games close to kick-off, so games further out may show Pinnacle and Bovada only.

**Do you have live/in-play odds or player props?** No — pregame moneyline, spread and total. `includeStartedEvents` keeps rows for games already underway, but prices are the pregame closes.

**My scheduled run returns fewer rows than expected.** Dedupe is on by default: each game is emitted once. Set `"dedupe": false` to get the full slate every run, for example to track lines day by day.

**Tennis, golf, F1, esports?** Not available from the current source; those inputs return a free explanatory row rather than silently vanishing.

## Related actors

- [Sports Odds Movement and Arbitrage Tracker](https://apify.com/scrapemint/sports-odds-movement-tracker): sharp line moves across books
- [Player Prop Bets: Odds by Player, Stat and Line](https://apify.com/scrapemint/sportsbook-player-props): player props by stat and line
- [Underdog & Sleeper Player Props Scraper](https://apify.com/scrapemint/underdog-sleeper-player-props): DFS pick'em lines to compare with sportsbook props
- [Kalshi Trades: Live Tape, Whale Trades and Price History](https://apify.com/scrapemint/kalshi-trades-tracker): Kalshi game markets and the big trades on them
- [Prediction Market Arbitrage: Kalshi vs Polymarket vs PredictIt](https://apify.com/scrapemint/prediction-market-odds-comparison): prediction market prices on the same events
