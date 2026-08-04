# US Loan and Mortgage Rates

What Americans actually borrow at, straight from the Federal Reserve: 30 and 15 year mortgage rates, the bank prime rate, credit card APR, new car loans and personal loans.

Every rate arrives with context rather than a bare number: how it moved over the past week, month and year, and where it sits inside its own multi year range.

No login, no API key, no proxy.

## What you get

One row per rate in `latest` mode:

```json
{
  "seriesId": "MORTGAGE30US",
  "label": "30-year fixed mortgage",
  "category": "mortgage",
  "rate": 6.66,
  "unit": "percent per year",
  "observationDate": "2026-07-30",
  "frequency": "weekly",
  "changeWeek": 0.08,
  "changeMonth": 0.17,
  "changeYear": -0.08,
  "percentileRank": 63,
  "windowYears": 5,
  "windowLow": 2.77,
  "windowHigh": 7.79,
  "windowMedian": 6.81,
  "isStale": false,
  "daysSinceObservation": 5
}
```

In `history` mode you get one row per published observation instead, going back as far as the series runs. The 30 year mortgage starts in 1971.

## Rates covered

| Series | Rate | Published |
| --- | --- | --- |
| `MORTGAGE30US` | 30 year fixed mortgage | weekly |
| `MORTGAGE15US` | 15 year fixed mortgage | weekly |
| `DPRIME` | Bank prime loan rate | daily |
| `DFF` | Federal funds effective rate | daily |
| `TERMCBCCALLNS` | Credit card interest rate | quarterly |
| `TERMCBAUTO48NS` | 48 month new car loan | quarterly |
| `RIFLPBCIANM60NM` | 60 month new car loan | quarterly |
| `TERMCBPER24NS` | 24 month personal loan | quarterly |

Two more, `MORTGAGE5US` and `MMNRNJ`, are no longer published. They still return their final value, so they are left out unless you ask for them and always come back marked `isStale`.

## Input

| Field | Description |
| --- | --- |
| `mode` | `latest` (default) or `history` |
| `series` | Which rates to return. Empty means all current ones |
| `includeDiscontinued` | Include the two retired series (default false) |
| `percentileYears` | Window for the low, high, median and percentile (default 5) |
| `historyFrom` / `historyTo` | History mode date range, `YYYY-MM-DD` |
| `maxRows` | Total rows returned (default 500) |

## Examples

Today's rates with context:

```json
{ "mode": "latest" }
```

Just the mortgage rates:

```json
{ "mode": "latest", "series": ["MORTGAGE30US", "MORTGAGE15US"] }
```

Two years of weekly 30 year mortgage history:

```json
{ "mode": "history", "series": ["MORTGAGE30US"], "historyFrom": "2024-08-01" }
```

## How the numbers are worked out

A change is measured against the newest observation at or before that date, not a fixed number of rows back, because these series publish at different rhythms.

A change window shorter than how often the rate is published comes back as `null`. The credit card and loan surveys are quarterly, so there is no such thing as their weekly move, and reporting one would be inventing a measurement.

Any rate that is missing for a period, such as a daily series over a holiday, is left out rather than treated as zero. A zero would read as a real 0.00% rate.

`isStale` compares the age of the newest observation against how often that rate is normally published, so a quarterly survey is not called stale for behaving quarterly.

## Who it's for

Anyone tracking borrowing costs: mortgage and lending sites showing current rates, personal finance tools and newsletters, fintech dashboards, and analysts watching what consumer credit costs. Pairs with the **US Treasury Rates Scraper** and **Central Bank Policy Rates** for the wholesale and policy side of the same picture.

## Pricing

Pay per rate row. The first 2 rows of every run are free so you can validate the output before you pay.
