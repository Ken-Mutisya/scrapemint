# Stock Market Fundamentals Scraper

Financial-statement line items for any public company, straight from official **SEC filings**: revenue, net income, EPS, total assets, shareholders equity, operating cash flow, capital expenditures and more.

No login, no API key, no proxy. It reads the SEC's keyless XBRL data, so the numbers are the same ones companies file, returned as clean JSON.

Two ways to use it: pull **full history for companies you name**, or flip to **screener mode** and rank every filer in the market on one period.

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

## Screener mode

Set `mode` to `screener` and you get the inverse view: instead of full history for a few companies, you get **one row per company for a single period, across every filer that reported it**, ranked by whatever metric you choose. That turns a lookup into a screener over roughly 5,500 companies.

Each row carries the metrics you asked for side by side, plus margins and returns calculated for you, plus the SEC accession number behind every number so you can trace it back to the filing.

```json
{
  "ticker": "GOOGL",
  "tickerSource": "cik",
  "entityName": "Alphabet Inc.",
  "cik": 1652044,
  "loc": "US-CA",
  "period": "CY2026Q1",
  "revenue": 109900000000,
  "revenueAccession": "0001652044-26-000071",
  "netIncome": 62576000000,
  "assets": 921983000000,
  "equity": 640480000000,
  "netMarginPct": 56.94,
  "roaPct": 6.79,
  "roePct": 13.07,
  "sortedBy": "revenue"
}
```

Available screener metrics: `revenue`, `netIncome`, `grossProfit`, `operatingIncome`, `rndExpense`, `operatingCashFlow`, `epsDiluted`, `assets`, `liabilities`, `equity`, `cash`.

A ratio is only filled in when both of its inputs were reported. If a company did not file shareholders equity, `roePct` comes back as `null`, never as a zero that would read like a real measurement.

**On periods.** Leave `period` empty and the actor picks the most recent quarter that most companies have actually reported, so you are never handed a quarter that is still filling up. Q4 is a special case worth knowing: companies report Q4 inside the annual 10-K rather than a 10-Q, so discrete Q4 data barely exists. Ask for the full year instead, e.g. `CY2024`.

**On tickers.** Most companies resolve by CIK. When a company reorganises under a new parent it keeps filing under its old CIK while the SEC ticker file points at the new one, so the actor falls back to an exact name match and tells you which path it used in `tickerSource`. Ambiguous names are left `null` rather than guessed, and registrants with no listed ticker (funds, subsidiaries) can be dropped with `tickersOnly`.

## Input

| Field | Description |
| --- | --- |
| `mode` | `tickers` (default) or `screener` |
| `tickers` | Tickers mode. Symbols to fetch, e.g. `["AAPL","MSFT"]` |
| `metrics` | Optional list of XBRL concepts, e.g. `["Revenues","NetIncomeLoss"]` |
| `includeAllConcepts` | Return every reported concept (overrides `metrics`) |
| `forms` | Filing forms to include (default `["10-K","10-Q"]`) |
| `minYear` | Only periods ending in this year or later |
| `latestOnly` | Only the most recent value per metric |
| `screenerMetrics` | Screener mode. Metrics to place side by side on each row |
| `period` | Screener mode. e.g. `CY2025Q1` or `CY2024`. Empty picks the latest well reported quarter |
| `sortBy` | Screener mode. Metric to rank by (default: the first one) |
| `sortOrder` | Screener mode. `desc` (default) or `asc` |
| `maxCompanies` | Screener mode. Rows returned after sorting (default 100) |
| `tickersOnly` | Screener mode. Drop registrants with no listed ticker |

## Examples

Full history for one company:

```json
{ "tickers": ["AAPL"], "metrics": ["Revenues", "NetIncomeLoss", "EarningsPerShareDiluted"], "minYear": 2022 }
```

The 100 largest companies by revenue last quarter, with margins and returns:

```json
{ "mode": "screener", "screenerMetrics": ["revenue", "netIncome", "assets", "equity"], "maxCompanies": 100 }
```

Biggest R&D spenders of 2024, listed companies only:

```json
{ "mode": "screener", "period": "CY2024", "screenerMetrics": ["revenue", "rndExpense"], "sortBy": "rndExpense", "tickersOnly": true }
```

## Who it's for

Analysts and quants building models, fintech apps and dashboards showing fundamentals, screeners, and researchers who want clean financials without paying for a data terminal. Completes the stock-market data set with the **Stock Market Earnings Calendar** (when companies report) and **Stock Market Price History** (the chart).

## Pricing

Pay per fundamentals row. The first 15 rows of every run are free so you can validate the output before you pay.

In tickers mode a row is one metric for one period. In screener mode a row is **one company**, however many metrics you put on it, so a 100 company screen with six metrics costs 100 rows and not 600.
