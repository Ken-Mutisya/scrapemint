# Stock Earnings Calendar Scraper

Get the stock market calendar as clean JSON: **earnings dates, EPS estimates, dividends, IPOs and stock splits** for a date range or your own ticker watchlist.

No login, no API key, no proxy. The actor reads keyless public JSON, so runs are fast and cheap.

## What you get

One row per event. Event types:

- **earnings** — symbol, company, report date, report time (pre-market / after-hours), EPS estimate, number of analyst estimates, last-year EPS, fiscal quarter, market cap
- **dividend** — ex-dividend date, record date, payment date, announcement date, dividend rate, indicated annual dividend
- **ipo** — priced and upcoming IPOs with exchange, share price, shares offered, deal value, status
- **split** — ratio, execution date, the ratio parsed into `splitFrom` and `splitTo`, and a `reverseSplit` boolean
- **stockDividend** — Nasdaq files these on the splits endpoint with a percentage ratio such as `5%`. They are not splits, so they get their own event type

### Reverse splits are the interesting rows

A forward split like `4 : 1` is usually a healthy company making its shares easier to buy. A reverse split like `1 : 10` runs the other way: it concentrates shares to lift the quoted price, most often to cure an exchange listing rule breach before delisting. They are the majority of what this endpoint carries, so filter on `reverseSplit` rather than reading ratios by eye.

Splits also read backwards in time, not just forward, so you can pull a past window to see which names have already done this.

## Input

| Field | Description |
| --- | --- |
| `dateFrom` | Start date `YYYY-MM-DD` (default: today) |
| `dateTo` | End date `YYYY-MM-DD` (default: +7 days, max range 31 days) |
| `tickers` | Optional watchlist, e.g. `["AAPL","MSFT","NKE"]`. Empty = whole market |
| `includeEarnings` / `includeDividends` / `includeIPOs` / `includeSplits` | Toggle event types (all on by default) |
| `maxRows` | Stop after N rows (default 1000) |

## Example

```json
{ "dateFrom": "2026-06-30", "dateTo": "2026-07-07", "tickers": ["NKE", "AAPL"] }
```

```json
{
  "eventType": "earnings",
  "symbol": "NKE",
  "companyName": "Nike, Inc.",
  "date": "2026-06-30",
  "reportTime": "after hours",
  "epsForecast": "$0.11",
  "numAnalystEstimates": 10,
  "lastYearEps": "$0.14",
  "marketCap": "$60,346,146,595"
}
```

## Who it's for

Active and options traders planning around report dates, swing traders working earnings season, fintech apps and trading newsletters that display the calendar, and quants feeding event dates into backtests.

## Pricing

Pay per event row. The first 15 rows of every run are free so you can validate the output before you pay.
