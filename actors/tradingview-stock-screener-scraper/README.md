# TradingView Stock Screener Scraper (No Login)

Screen stocks, crypto, and forex straight from TradingView's public scanner and get one clean row per matching symbol. No login, no API key, no browser. You set the filters, the Actor returns the matches with live fundamentals and technicals.

## What you get

One row per symbol, with:

- `tickerId` (e.g. `NASDAQ:NVDA`) and `symbol`
- `name` (full company or instrument name)
- `price`, `changePercent`, `changeAbs`
- `volume`
- `marketCap`
- `peRatio` (trailing P/E)
- `dividendYield`
- `rsi` (14-period)
- `sector`, `industry`
- `exchange`, `country`
- `perfYTD` (year to date performance)
- `url` to the TradingView symbol page
- `market`, `scrapedAt`

## Filters

Set any combination of:

- `market` (default `america`; also `crypto`, `forex`, `india`, `uk`, `germany`, `canada`, `australia`, `japan`, and more)
- `marketCapMin` / `marketCapMax`
- `priceMin` / `priceMax`
- `volumeMin`
- `sectors` (e.g. `Technology Services`, `Electronic Technology`, `Finance`, `Health Technology`, `Energy Minerals`)
- `peRatioMin` / `peRatioMax`
- `dividendYieldMin`
- `rsiMin` / `rsiMax` (RSI ≥ 70 for overbought, ≤ 30 for oversold)
- `changeMin` (percent up on the day)
- `sortBy`, `sortOrder`, `maxResults`

Power users can pass raw TradingView filter objects through `filters`, each shaped `{ "left": "<field>", "operation": "<op>", "right": <value> }`. These are appended to the friendly filters above.

## Example input

```json
{
  "market": "america",
  "marketCapMin": 1000000000,
  "sectors": ["Technology Services", "Electronic Technology"],
  "sortBy": "market_cap_basic",
  "sortOrder": "desc",
  "maxResults": 100
}
```

Oversold large caps with a dividend:

```json
{
  "market": "america",
  "marketCapMin": 10000000000,
  "dividendYieldMin": 3,
  "rsiMax": 30,
  "sortBy": "dividend_yield_recent",
  "maxResults": 50
}
```

## Pricing

Pay per row. The first 25 rows of every run are free so you can validate output before you scale up. You only pay for the matches you keep.

## Notes

- Data comes from TradingView's own scanner endpoint, so values match what you see on the site.
- Proxy is off by default because the endpoint is a tolerant public API; supply a proxy only if you run very large pulls and hit rate limits.
- This Actor reads only public data and never logs in.
