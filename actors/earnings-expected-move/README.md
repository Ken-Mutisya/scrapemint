# Earnings Expected Move: Options-Implied Moves

See how much the options market expects each stock to move on its next earnings report. For every company reporting in the coming days (or the tickers you choose), you get the at-the-money straddle price, the expected move in dollars and percent, the implied price range, and an IV crush estimate, next to the earnings date, report time and EPS forecast.

Earnings dates come from Nasdaq's public calendar and option prices from Cboe's delayed chain. No API key, no login.

## Who uses it

- **Options traders**: compare implied moves across the week's reports and pick which to trade, sell or skip
- **Swing traders**: know the expected range before holding through a report
- **Newsletter and Discord writers**: the weekly earnings expected-move table, ready to post
- **Analysts**: track how implied moves compare with actual reactions over time

## What you get

One row per company:

- `symbol`, `company`, `earningsDate`, `reportTime` (pre-market / after-hours), `marketCapUsd`, `epsForecast`, `numberOfEstimates`, `lastYearEps`
- `stockPrice`, `expiry` (the first expiry after the report), `atmStrike`, `callPrice`, `putPrice`, `straddlePrice`, `priceSource` (mid, theoretical or last)
- `expectedMoveUsd`, `expectedMovePct`, `expectedRangeLow`, `expectedRangeHigh`
- `frontAtmIv`, `backExpiry`, `backAtmIv`, `ivCrushEstimatePct` (how far IV is priced to fall after the report)
- `straddleVolume`, `straddleOpenInterest`, `iv30`, `quoteTime`

## Example input

Scan the calendar:

```json
{ "daysAhead": 7, "minMarketCapUsd": 10000000000, "maxCompanies": 40 }
```

Or only your tickers:

```json
{ "symbols": ["NVDA", "TGT", "PANW"] }
```

## Example output

```json
{
  "symbol": "PANW",
  "earningsDate": "2026-11-18",
  "reportTime": "after-hours",
  "stockPrice": 329,
  "expiry": "2026-11-20",
  "atmStrike": 330,
  "straddlePrice": 36.6,
  "expectedMovePct": 11.12,
  "expectedRangeLow": 292.4,
  "expectedRangeHigh": 365.6,
  "frontAtmIv": 1.0014,
  "backAtmIv": 0.7744,
  "ivCrushEstimatePct": 22.7
}
```

## Pricing

Pay per company with a priced expected move. Companies without listed options and tickers with no upcoming report are free.

## Notes

- The expected move is the ATM straddle of the first expiry after the report. When that expiry is several days out, it includes some normal non-earnings movement too.
- Option prices are Cboe's delayed quotes (about 15 minutes). Outside market hours the mid price is the last session's close.
- For gamma levels and max pain on the same names, use [Options Max Pain & Gamma Exposure](https://apify.com/scrapemint/options-max-pain-gamma-exposure). For the full calendar, use [Stock Earnings Calendar Scraper](https://apify.com/scrapemint/stock-earnings-calendar-scraper).
