# Stock Price History Scraper

Daily **open, high, low, close and volume (OHLCV)** for any stock or ETF ticker over a date range, returned as clean JSON.

No login, no API key, no proxy. It reads a keyless public API, so runs are fast and cheap. This is the price data behind every chart and backtest.

## What you get

One row per ticker per trading day:

```json
{
  "symbol": "AAPL",
  "date": "2026-06-26",
  "open": 275.0,
  "high": 285.95,
  "low": 274.21,
  "close": 283.78,
  "volume": 261775500
}
```

Prices and volume are parsed to numbers (no `$` or commas), and dates are normalized to `YYYY-MM-DD`, so the output drops straight into a dataframe or database.

## Input

| Field | Description |
| --- | --- |
| `tickers` | Symbols to fetch, e.g. `["AAPL","MSFT","SPY"]` (required) |
| `fromDate` | Start date `YYYY-MM-DD` (default: 30 days ago) |
| `toDate` | End date `YYYY-MM-DD` (default: today) |
| `assetClass` | `auto` (default), `stocks`, `etf` or `index` |
| `maxRowsPerTicker` / `maxRowsTotal` | Caps on output size |

## Example

```json
{ "tickers": ["AAPL", "MSFT", "SPY"], "fromDate": "2026-01-01", "toDate": "2026-06-30" }
```

## Who it's for

Quants and backtesters who need clean OHLCV, charting tools and dashboards, fintech apps, and researchers pulling historical prices without a paid data plan. Pairs naturally with the **Stock Earnings Calendar Scraper** — the calendar tells you when a company reports, this gives you the price action around it.

## Pricing

Pay per daily price row. The first 20 rows of every run are free so you can validate the output before you pay.
