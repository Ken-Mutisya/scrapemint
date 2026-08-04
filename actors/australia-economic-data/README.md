# Australia House Prices, Inflation and Wage Growth

Mean residential dwelling price for Australia and every state and territory, plus consumer price inflation and wage growth, straight from the Australian Bureau of Statistics.

Official government statistics, quarterly, with history.

No login, no API key, no proxy.

## What you get

One row per series per region per period:

```json
{
  "dataset": "dwellings",
  "measure": "Mean price of residential dwellings",
  "region": "New South Wales",
  "period": "2026-Q1",
  "value": 1324800,
  "rawValue": 1324.8,
  "unitMultiplier": "Thousands",
  "unit": "Australian Dollars",
  "frequency": "Quarterly",
  "isStale": false
}
```

`value` is the figure in real units. The ABS publishes magnitude separately, so a mean price arrives as `1324.8` with a multiplier of `Thousands`; both the scaled figure and the raw one are on the row so you can check the arithmetic.

## Datasets

| Key | Series | Source |
| --- | --- | --- |
| `dwellings` | Mean price of residential dwellings, and dwelling counts | RES_DWELL_ST |
| `inflation` | Consumer price index, all groups | CPI |
| `wages` | Wage price index, total hourly rates including bonuses | WPI |

## Input

| Field | Description |
| --- | --- |
| `datasets` | Which series to pull |
| `regions` | Names to match, e.g. `["Australia"]` or `["New South Wales","Victoria"]` |
| `periods` | How many recent quarters per series |
| `allMeasures` | Return every measure rather than the headline one |
| `maxRows` | Total rows returned (default 200) |

## Examples

Latest national figures:

```json
{ "datasets": ["dwellings","inflation","wages"], "regions": ["Australia"] }
```

Five years of dwelling prices by state:

```json
{ "datasets": ["dwellings"], "regions": ["New South Wales","Victoria","Queensland"], "periods": 20 }
```

## Things worth knowing

Each dataset returns its headline measure by default. Without that filter the dwellings series mixes mean price with total dwelling stock value, which runs into the trillions and is not a comparable number. Set `allMeasures` if you want everything.

Region matching prefers an exact name. This matters in Australia, where asking for `Australia` would otherwise also return South Australia and Western Australia.

Mean price is published at state and territory level only, not by city or postcode.

Every row carries `isStale`, which flags a series whose newest period has fallen well behind its publication schedule. The ABS leaves discontinued datasets online and they keep answering normally, so this is how a retired series announces itself rather than quietly looking current.

A suppressed or unavailable observation comes back as `null` and never as a zero.

## Who it's for

Property investors comparing Australian states, mortgage and proptech dashboards, economists and journalists tracking prices against wages, and anyone needing Australian figures without a subscription terminal. Pairs with **UK House Prices**, **Europe House Prices**, **Canada Economic Data** and **US Rent and Home Price Index**.

## Pricing

Pay per data row. The first 2 rows of every run are free so you can validate the output before you pay.
