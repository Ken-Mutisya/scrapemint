# European Electricity Prices: Day-Ahead Rates and Power Mix

Power is priced by the quarter hour, and in Europe the price regularly goes **negative** when wind and solar overshoot demand. On a recent day in Germany the market spent four and a half hours below zero, while the evening peak reached €187/MWh.

This reads the day-ahead spot price per bidding zone, what was generating behind it, and the physical flows between countries. No key, no login, no proxy.

## Four modes

**Prices** returns one row per quarter hour per zone: timestamp, price in EUR/MWh, and an `isNegative` flag. Set `onlyNegativePrices` to return just the intervals where the market was paying consumers to take power.

**Summary** returns one row per zone per day:

| Field | Meaning |
| --- | --- |
| `averagePrice`, `minPrice`, `maxPrice`, `spread` | The day, with the timestamp of the high and the low |
| `peakAverage`, `offPeakAverage`, `peakPremium` | Peak is 08:00 to 20:00 CET, the market's own definition |
| `negativeIntervals`, `negativeHours`, `lowestNegativePrice` | How long, and how far, the price went below zero |

**Generation** returns one row per production type with average, minimum and maximum output, its share of generation, and the average load for context.

**Flows** returns one row per neighbouring country: average net flow in GW, whether that is an import or an export, the extremes in each direction, and the country's overall net position.

## Example input

```json
{
  "mode": "summary",
  "zones": ["DE-LU", "FR", "NL", "AT", "BE", "PL"],
  "date": "2026-07-27"
}
```

Every quarter hour the price was negative:

```json
{
  "mode": "prices",
  "zones": ["DE-LU"],
  "onlyNegativePrices": true
}
```

## Licensing, and why some zones return no data

The upstream publisher licenses **some** bidding zones as CC BY 4.0 and marks the rest for private and internal use only, where redistribution of the raw **or derived** data is expressly prohibited.

This actor therefore returns price rows only for zones whose response declares an open licence, and every row carries the `license` and `source` attribution that licence requires. A restricted zone returns a free note explaining why instead of data you could not lawfully use.

That check runs against the live response rather than a fixed list, because the two disagree: the documentation lists IT-North as openly licensed while the live response marks it restricted. The response wins.

Zones confirmed working: `DE-LU`, `FR`, `NL`, `AT`, `BE`, `CH`, `CZ`, `DK1`, `DK2`, `HU`, `NO2`, `PL`, `SE4`, `SI`. Generation and flow data carry no such restriction and work for any covered country.

## Two things worth knowing

**The generation list mixes three different units.** Alongside the megawatt series for each fuel it carries load, cross-border trade, pumped storage consumption, and two series that are **percentages**, not megawatts. Adding the array up as if it were all generation corrupts every share computed from it. Each row here is tagged with `seriesKind` and `unit`, and shares are calculated only across real generation, so they add to 100.

**Peak hours are a CET convention.** Classifying them in UTC shifts the window two hours in summer and mislabels the midday solar trough as peak, which inverts the number people care about. The window used is on every summary row.

## Pricing

Pay per row, `$0.003`. The first 2 rows of every run are free. Licence-restricted zones, dates with nothing published, and note rows are never charged.

One zone-day is one request, and the upstream API rate limits aggressively, so requests are spaced deliberately. A two zone run takes about ten seconds.

## Related actors

- **Commodity Futures Prices** for the gas and coal that set the marginal price
- **CFTC Commitments of Traders** for positioning in energy futures
- **World Economic Indicators** for the macro backdrop
