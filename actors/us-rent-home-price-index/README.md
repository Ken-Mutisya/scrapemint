# US Rent and Home Price Index

What a typical home is worth and what typical rent costs, for any US metro, county, city or zip code. Built on Zillow's published research indexes, so it measures the whole market rather than whatever happens to be listed today.

Every region comes back with its current level, how it moved over the past month and year, and the gross rental yield where both figures exist.

No login, no API key, no proxy.

## What you get

One row per region in `latest` mode:

```json
{
  "regionName": "Austin, TX",
  "regionType": "metro",
  "state": "TX",
  "sizeRank": 29,
  "rentIndex": 1648.78,
  "rentAsOf": "2026-06-30",
  "rentChangeMonthPct": 0.42,
  "rentChangeYearPct": -1.83,
  "homeValue": 476400.03,
  "homeValueAsOf": "2026-06-30",
  "homeChangeMonthPct": -0.61,
  "homeChangeYearPct": -3.42,
  "rentToPriceYieldPct": 4.15,
  "rentUnit": "US dollars per month",
  "homeValueUnit": "US dollars"
}
```

In `history` mode you get one row per region per month instead. Home values go back to 2000, rent to 2015.

## Input

| Field | Description |
| --- | --- |
| `mode` | `latest` (default) or `history` |
| `geography` | `metro` (default), `state`, `county`, `city` or `zip` |
| `regions` | Filter by name, e.g. `["Austin","Denver"]`. A state code such as `"TX"` returns everything in that state |
| `metrics` | `rent`, `homeValue` or both. Asking for one skips downloading the other file |
| `historyFrom` / `historyTo` | History mode date range, `YYYY-MM-DD` |
| `maxRows` | Total rows returned (default 200) |

## Examples

Every metro, largest first:

```json
{ "mode": "latest", "geography": "metro" }
```

Everything in Texas with rental yield:

```json
{ "mode": "latest", "geography": "metro", "regions": ["TX"] }
```

Three years of monthly history for one metro:

```json
{ "mode": "history", "regions": ["Austin, TX"], "historyFrom": "2023-01-31" }
```

## Things worth knowing

Zillow does not publish the rent index at state level, so states return home values with the rent fields set to `null`. Use metro, county, city or zip if you need rent.

A change is only reported when the earlier month exists for that same index. Because rent history starts in 2015 and home values in 2000, a region can have a home value change and no rent change, and that comes back as `null` rather than as a zero.

Gross yield is annual rent divided by home value, and it is only filled in when both indexes cover the region. It is a market level ratio, not a projection for any individual property.

The city and zip home value files are large, about 93MB and 60MB, so those levels take noticeably longer than metro or state.

Values are smoothed, seasonally adjusted indexes of typical value in the middle third of the market. They describe a market, not a specific address.

## Who it's for

Property investors comparing yields across markets, real estate sites and newsletters showing local trends, relocation and cost of living tools, and analysts tracking housing affordability. Pairs with **US Loan and Mortgage Rates** for the borrowing side of the same question.

## Pricing

Pay per region row. The first 2 rows of every run are free so you can validate the output before you pay.
