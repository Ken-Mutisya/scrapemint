# Kalshi Prediction Market Scraper: Live Event Odds

Live market data from Kalshi, the CFTC-regulated US event contract exchange. Every market is a real-money yes/no question - who wins the game, where the Fed sets rates, how hot the summer gets - and the price is the crowd's probability. This actor reads those markets through Kalshi's public API and gives you clean rows.

## What you get

One row per market:

| Field | Description |
| --- | --- |
| `eventTitle`, `outcome` | The question and the specific outcome this market prices |
| `yesBid`, `yesAsk`, `noBid`, `noAsk` | Live order book, in dollars (0 to 1) |
| `lastPrice` | Last trade price |
| `impliedProbabilityPct` | Book midpoint (or last trade) as a percentage |
| `volume`, `volume24h`, `openInterest` | Activity and positioning |
| `openTime`, `closeTime`, `status`, `result` | Lifecycle |
| `rules` | Exact resolution criteria |
| `ticker`, `eventTicker`, `seriesTicker`, `category` | Identifiers for joins |

## Three ways to query

1. **Discovery** - pick `categories` (Politics, Economics, Sports, Financials, Climate and Weather, Culture, Crypto...) and optional `keywords`; the actor browses open events and returns matching markets.
2. **Event tickers** - exact events like `KXNEWPOPE-70`.
3. **Series tickers** - everything in a recurring series, like Fed decisions or monthly CPI.

## Typical uses

- **Traders and arb hunters**: compare Kalshi prices against Polymarket and sportsbook lines. Pairs with our Polymarket Prediction Market Scraper for a two-exchange view.
- **Researchers and journalists**: probability time series on elections, rates, and geopolitics - schedule the actor and build your own history.
- **Dashboards and newsletters**: structured event odds without touching an exchange account.
- **Sports analytics**: event contract prices on games as a sharp, regulated reference line.

## Pricing

You pay per market row (`market_row`). The first 2 rows of every run are free. Unknown tickers and searches with no matches cost nothing.

## Input example

```json
{
    "categories": ["Economics"],
    "keywords": ["Fed", "CPI", "inflation"],
    "onlyPriced": true,
    "minVolume": 100,
    "maxRows": 100
}
```

## Notes

- Data comes from Kalshi's public market-data API. No account, no API key, no browser. This actor reads prices; it does not trade.
- Prices are dollars per contract that pays $1, so 0.63 means a 63% implied probability.
- `onlyPriced` (default on) skips empty order books and long-dated combo markets that have never traded.
- Kalshi rate limits are handled: the actor paces requests, retries once, and stops cleanly with partial data if limits persist.

## Run it on a schedule

Most people run this every 5 to 60 minutes. In Apify Console open the actor, go to **Schedules**, and pick the interval with your saved input. Each run adds a fresh snapshot, so over time you build your own probability history for every market you track. Send every run to Google Sheets, Slack, Telegram or your own webhook under **Integrations**, or start runs from code:

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~kalshi-prediction-market-scraper/runs?token=YOUR_TOKEN" -H "Content-Type: application/json" -d '{}'
```

## Related actors

- [Kalshi Trades: Live Tape, Whale Trades and Price History](https://apify.com/scrapemint/kalshi-trades-tracker): every fill and whale trade behind the prices, plus candles
- [Prediction Market Arbitrage: Kalshi vs Polymarket vs PredictIt](https://apify.com/scrapemint/prediction-market-odds-comparison): the same question priced on three venues, with locked-in arbitrage
- [Kalshi Weather Markets: Prices vs Forecast Odds](https://apify.com/scrapemint/kalshi-weather-markets): temperature and rain markets next to an ensemble forecast
- [Polymarket Trade Intelligence: Order Book and Prices](https://apify.com/scrapemint/polymarket-scraper): the other big prediction market
- [Polymarket Whale Tracker: Big Bets and Smart Money](https://apify.com/scrapemint/polymarket-whale-tracker): large Polymarket bets as they happen
