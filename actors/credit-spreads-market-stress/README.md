# Credit Spreads, VIX & Financial Stress: Market Risk Data

The risk dashboard a macro desk watches, as clean rows. **Corporate bond spreads** for US, European and emerging market credit, **volatility indexes** for equities, oil and gold, **Treasury curve spreads and inflation expectations**, and the **official financial conditions indexes**. No API key, no login, no browser.

Credit spreads are the reason this exists: what lenders charge risky borrowers over government debt is the earliest widely published sign that risk appetite is turning, and it usually moves before equities do.

## A level on its own tells you nothing

A high yield spread of 2.81 per cent is either the calmest credit market in a decade or the start of something, depending on where it sits in its own history. So **every latest row is ranked against its own trailing window**: percentile rank, z score, the high, the low and the median, plus the move over a week, a month, a quarter and a year.

That context is what separates this from a quote. In a live run today, broad US high yield sat at the **38th percentile** of its own year while **CCC and lower rated credit sat at the 99th** — the risky end selling off while the index looked calm. One number without the other hides that.

## Modes

- **Latest** - one row per series: newest value, the moves over 1 week, 1 month, 3 months and 1 year, and the full trailing context.
- **History** - one row per series per date over any window.
- **Catalogue** - every series covered, with its units and publication frequency.

## What is covered

| Category | Series |
| --- | --- |
| **credit** | US high yield, US investment grade, US BBB, US CCC and lower, euro high yield, emerging market corporate spreads, US high yield effective yield |
| **volatility** | S&P 500 (VIX), Nasdaq 100, crude oil, gold |
| **rates** | 10y minus 2y, 10y minus 3m, 10 year, 2 year, 10 year real yield, 10 year breakeven inflation, 5 year forward inflation |
| **conditions** | Chicago Fed national and adjusted financial conditions, St Louis Fed financial stress index |
| **dollar** | broad trade weighted dollar, dollar against advanced economies |

Every one was verified returning live data before shipping.

## Example output

```json
{
  "mode": "latest",
  "seriesId": "BAMLH0A3HYC",
  "name": "US CCC and lower rated bond spread",
  "category": "credit",
  "unit": "percentage points over government bonds (option adjusted spread)",
  "latestValue": 10.01,
  "latestDate": "2026-07-27",
  "publicationLagDays": 2,
  "changeFromPreviousBasisPoints": 4.0,
  "change1Month": 0.61,
  "change1Year": 1.67,
  "percentileRankInLookback": 99.1,
  "zScoreInLookback": 1.803,
  "lookbackLow": 7.83,
  "lookbackHigh": 10.2,
  "atLookbackHigh": false
}
```

## Things worth knowing

- **Units are not interchangeable.** A spread is percentage points over government bonds, a volatility index is annualised per cent, a conditions index is standard deviations from its own average. Ranking or averaging across them is meaningless, so the unit rides on every row and a caveat field says so.
- **Series publish on different calendars.** The conditions indexes are weekly, everything else is daily, so the newest value is not the same age across rows. Each row carries `publicationLagDays` and an `isStale` flag, and the trailing comparisons resolve to the most recent observation **at or before** the target date rather than counting rows backwards, which would make a weekly series look a month staler than it is.
- **A holiday inside a daily series returns an empty value, not a missing row.** The 10 year Treasury yield on Independence Day comes back blank; read carelessly that becomes a yield of zero. Blank observations are dropped, never zeroed.
- **Requesting several series in one call returns a ZIP archive** rather than CSV, so each series is fetched separately.
- **Series discovery needs an API key**, which this actor does not use, so the catalogue is a fixed curated list rather than a search. Catalogue mode prints it.
- **An unrecognised identifier answers 404 with an HTML page.** Anything that is not the expected CSV header is never parsed as data, and if nothing you asked for resolves, the run returns an explanation and charges nothing.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unknown series, a category that does not exist, a series that returned nothing) are never charged.

The default latest snapshot of credit and volatility is 11 rows, or **$0.044**. Every series in the catalogue with full context is 23 rows, or **$0.092**. A quarter of daily history for one series is about 60 rows.

## Related actors

- **Government Bond Yields Worldwide** - the risk free level these spreads sit on top of.
- **US Treasury Yields & Interest Rates Scraper** - one country in depth, including auctions and bills.
- **SOFR & Money Market Rates: Benchmarks and Fed Operations** - the overnight funding market.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~credit-spreads-market-stress/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"latest","categories":["credit","volatility"],"lookbackDays":365}'
```

Data is published by the Federal Reserve Bank of St Louis (FRED). Spread indexes are ICE BofA index data as republished there.
