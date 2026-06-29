# Stock Earnings Calendar Scraper

Get the forward-looking stock market calendar as clean JSON: **upcoming earnings dates, EPS estimates, dividends, IPOs and stock splits** for a date range or your own ticker watchlist.

No login, no API key, no proxy. The actor reads keyless public JSON, so runs are fast and cheap.

## What you get

One row per event. Event types:

- **earnings** — symbol, company, report date, report time (pre-market / after-hours), EPS estimate, number of analyst estimates, last-year EPS, fiscal quarter, market cap
- **dividend** — ex-dividend date, record date, payment date, announcement date, dividend rate, indicated annual dividend
- **ipo** — priced and upcoming IPOs with exchange, share price, shares offered, deal value, status
- **split** — stock splits with ratio and execution date

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
