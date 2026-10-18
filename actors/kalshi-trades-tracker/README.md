# Kalshi Trades: Live Tape, Whale Trades and Price History

The **Kalshi trade tape** as a dataset. Every fill for the markets you name, or a scan of the **whole exchange for whale trades**:

- **Trades for any market, event or series:** time, taker side, contracts, YES and NO price, price paid and **dollar size** of every fill, back up to 90 days
- **Whale scan:** leave the tickers empty and it reads every fill on Kalshi over the last 30 minutes (~180,000 fills) and returns the ones over **$1,000**, largest first
- **Price candles:** 1-minute, 1-hour or 1-day open, high, low, close, closing bid/ask, volume and open interest per market

No Kalshi account, no API key, no proxy. **$0.80 per 1,000 trades**, no start fee.

## What you get

Trades: `time`, `marketTicker`, `marketTitle`, `outcome`, `takerSide`, `contracts`, `yesPrice`, `noPrice`, `takerPrice`, `notionalUsd`, `isBlockTrade`, `eventTicker`, `seriesTicker`, `marketStatus`, `tradeId`, `url`

Candles: `time`, `interval`, `marketTicker`, `marketTitle`, `open`, `high`, `low`, `close`, `meanPrice`, `yesBidClose`, `yesAskClose`, `volume`, `openInterest`

## Example input

Whale trades over $5,000 in the last hour, across all of Kalshi:

```json
{
  "whaleScanMinutes": 60,
  "minNotionalUsd": 5000
}
```

Every fill in one game, both teams, last 2 days, with hourly candles:

```json
{
  "eventTickers": ["KXNFLGAME-26OCT18PITTB"],
  "lookbackHours": 48,
  "includeCandles": true
}
```

Only big NO buyers in every open Fed market:

```json
{
  "seriesTickers": ["KXFED"],
  "takerSide": "no",
  "minNotionalUsd": 500
}
```

## Example output

```json
{
  "type": "trade",
  "time": "2026-10-18T11:00:29.852Z",
  "marketTicker": "KXATPMATCH-26OCT18DAVJOD-DAV",
  "marketTitle": "Alejandro Davidovich Fokina wins",
  "outcome": "Alejandro Davidovich Fokina",
  "takerSide": "yes",
  "contracts": 11237,
  "yesPrice": 0.93,
  "noPrice": 0.07,
  "takerPrice": 0.93,
  "notionalUsd": 10450.41,
  "isBlockTrade": false,
  "eventTicker": "KXATPMATCH-26OCT18DAVJOD",
  "seriesTicker": "KXATPMATCH",
  "url": "https://kalshi.com/markets/kxatpmatch"
}
```

## Uses

- **Smart-money alerts:** schedule the whale scan every 15-30 minutes and send new rows to Slack, Telegram or a webhook
- **Flow before the move:** read who was buying YES or NO in the hours before a price jump
- **Backtests:** hourly or daily candles with volume and open interest for any market
- **Pair it with** [Kalshi Prediction Market Scraper](https://apify.com/scrapemint/kalshi-prediction-market-scraper) for live prices and order books

## Pricing

- **$0.0008** per trade ($0.80 per 1,000)
- **$0.0004** per candle
- No start fee. A run that finds nothing is free.

## Notes

- `notionalUsd` is what the taker paid: contracts x the price of the side they bought. A YES buy at 93c for 11,237 contracts is $10,450.
- By default the whale scan skips fills at more than 97c (`maxTakerPrice`). Those are near-certain bets on contracts about to settle, so they are large but carry no signal. Set it to 1 to keep them.
- Kalshi's trade API filters by market only. Events and series are resolved to their markets first; a series reads its open markets, up to 300 per run.
- Combo markets (parlays across games) appear in the whale scan with their legs as the title.
