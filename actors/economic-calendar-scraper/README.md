# Economic Calendar: Actual vs Forecast, 20+ Countries

A full **economic calendar** as data: every macro release for the US, euro area, UK, Japan, China, Canada, Australia, Switzerland, India, Brazil and more. Each event comes with **actual, forecast, previous** and the **surprise**:

- **Indicators:** CPI, Nonfarm Payrolls, GDP, PMIs, retail sales, JOLTS, rate decisions, trade balance...
- **Speeches:** Fed, ECB, BoE, BoJ governors and members
- **Holidays:** bank holidays by country (optional)
- **History:** past dates return the released actuals, so you can backtest surprises

Filter by date range, importance (high/medium/low), currency and country. An **Investing.com economic calendar alternative**: no account, no key, no proxy. **$1 per 1,000 events**, no start fee.

## What you get

`dateTime` (UTC), `date`, `timeUtc`, `country`, `currency`, `event`, `importance`, `type`, `actual`, `forecast`, `previous`, `previousBeforeRevision`, `actualValue`, `forecastValue`, `previousValue`, `unit`, `surprise`, `surpriseDirection`, `released`, `eventId`, `url`

`actual`, `forecast` and `previous` are the figures as published ("7.271 M", "2.8%"). The `...Value` fields are the same numbers parsed for spreadsheets, with the unit (%, K, M, B, T) in `unit`. `surprise` is actual minus forecast.

## Example input

The coming week, high and medium impact, all countries (the default):

```json
{
  "daysAhead": 7,
  "importance": ["high", "medium"]
}
```

Every high-impact US and euro area release since September, with actuals, for a surprise backtest:

```json
{
  "dateFrom": "2026-09-01",
  "dateTo": "2026-10-15",
  "currencies": ["USD", "EUR"],
  "importance": ["high"],
  "onlyReleased": true
}
```

## Example output

```json
{
  "dateTime": "2026-09-01T14:00:00.000Z",
  "timeUtc": "14:00",
  "country": "United States",
  "currency": "USD",
  "event": "JOLTS Job Openings",
  "importance": "high",
  "type": "indicator",
  "actual": "7.271 M",
  "forecast": "7.496 M",
  "previous": "7.182 M",
  "previousBeforeRevision": "7.359 M",
  "actualValue": 7.271,
  "forecastValue": 7.496,
  "unit": "M",
  "surprise": -0.225,
  "surpriseDirection": "below",
  "released": true,
  "url": "https://www.mql5.com/en/economic-calendar/united-states/jolts-job-openings"
}
```

## Uses

- **Forex and futures traders:** the week's high-impact events in one table, scheduled every Monday
- **Surprise backtests:** actual vs forecast history per indicator, then line it up with price moves
- **Trading bots:** pause strategies around high-impact releases
- **Pair it with** [ForexFactory Economic Calendar](https://apify.com/scrapemint/forexfactory-economic-calendar) for a second source, and [CFTC Commitments of Traders](https://apify.com/scrapemint/cftc-cot-tracker) for positioning

## Pricing

- **$0.001** per event ($1 per 1,000)
- No start fee. A run that finds nothing is free.

## Notes

- Times are UTC. Events without a fixed time (holidays, tentative releases) have `allDayOrTentative: true` and no `timeUtc`.
- Data comes from the MQL5 economic calendar. The euro area appears as "European Union" for area-wide releases and by country (Germany, France...) for national ones. Use `countries` to split them.
- `previousBeforeRevision` is set when the previous figure was revised; `previous` is the revised number.
- Up to one year per run.
