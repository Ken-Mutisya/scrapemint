# Stock Market Fundamentals Scraper

Financial-statement line items for any public company, straight from official **SEC filings**: revenue, net income, EPS, total assets, shareholders equity, operating cash flow, capital expenditures and more.

No login, no API key, no proxy. It reads the SEC's keyless XBRL data, so the numbers are the same ones companies file, returned as clean JSON.

## What you get

One row per metric per reporting period:

```json
{
  "symbol": "AAPL",
  "cik": 320193,
  "concept": "NetIncomeLoss",
  "label": "Net income",
  "unit": "USD",
  "value": 29578000000,
  "fiscalYear": 2026,
  "fiscalPeriod": "Q2",
  "periodEnd": "2026-03-28",
  "form": "10-Q",
  "filed": "2026-05-01",
  "accession": "0000320193-26-000061"
}
```

By default you get a curated set of common income-statement, balance-sheet and cash-flow items. Set `includeAllConcepts` to pull every concept a company reports (hundreds), or pass `metrics` to pick specific XBRL tags.

## Input

| Field | Description |
| --- | --- |
| `tickers` | Symbols to fetch, e.g. `["AAPL","MSFT"]` (required) |
| `metrics` | Optional list of XBRL concepts, e.g. `["Revenues","NetIncomeLoss"]` |
| `includeAllConcepts` | Return every reported concept (overrides `metrics`) |
| `forms` | Filing forms to include (default `["10-K","10-Q"]`) |
| `minYear` | Only periods ending in this year or later |
| `latestOnly` | Only the most recent value per metric |

## Example

```json
{ "tickers": ["AAPL"], "metrics": ["Revenues", "NetIncomeLoss", "EarningsPerShareDiluted"], "minYear": 2022 }
```

## Who it's for

Analysts and quants building models, fintech apps and dashboards showing fundamentals, screeners, and researchers who want clean financials without paying for a data terminal. Completes the stock-market data set with the **Stock Market Earnings Calendar** (when companies report) and **Stock Market Price History** (the chart).

## Pricing

Pay per fundamentals row. The first 15 rows of every run are free so you can validate the output before you pay.
