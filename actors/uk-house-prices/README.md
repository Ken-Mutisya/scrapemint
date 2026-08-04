# UK House Prices

Average sale price, house price index, monthly and annual change and sales volume for any UK region, straight from HM Land Registry's official UK House Price Index.

This is the government's own measure, not an estate agent estimate or a portal asking price. It covers the whole United Kingdom down to individual local authorities.

No login, no API key, no proxy.

## What you get

One row per region per month:

```json
{
  "region": "London",
  "regionSlug": "london",
  "month": "2026-05",
  "averagePrice": 544814,
  "housePriceIndex": 95.4,
  "percentageChangeMonth": -1.2,
  "percentageChangeYear": -3.7,
  "salesVolume": null,
  "currency": "GBP",
  "averagePriceDetached": 1138974,
  "averagePriceFirstTimeBuyer": 465145,
  "percentageChangeYearDetached": -2.9
}
```

Every row also carries the same figures split by segment: detached, semi detached, terraced, flat or maisonette, new build, existing property, first time buyer, former owner occupier, cash buyer and mortgage buyer.

## Input

| Field | Description |
| --- | --- |
| `regions` | Region slugs, e.g. `["england","london","manchester"]` |
| `mode` | `latest` (newest published month) or `history` |
| `monthFrom` / `monthTo` | `YYYY-MM`. History range. Empty history means the last 12 published months |
| `breakdowns` | Limit the per segment columns. Empty returns all |
| `maxRows` | Total rows returned (default 200) |

Region slugs are lowercase with hyphens: `united-kingdom`, `england`, `scotland`, `wales`, `northern-ireland`, `london`, `manchester`, `city-of-bristol` and so on.

## Examples

Latest month for the four nations:

```json
{ "regions": ["england","scotland","wales","northern-ireland"] }
```

Two years of London history:

```json
{ "mode": "history", "regions": ["london"], "monthFrom": "2024-06", "monthTo": "2026-05" }
```

First time buyer prices across several cities:

```json
{ "regions": ["manchester","leeds","city-of-bristol"], "breakdowns": ["FirstTimeBuyer"] }
```

## Things worth knowing

The index is published roughly two months in arrears, so the newest available month is not last month. Leaving the dates empty finds the newest month that actually has data rather than guessing from today.

**Sales volume lags further than prices**, by about five months, so recent months return `averagePrice` with `salesVolume` as `null`. That is the source, not a gap in this actor.

Not every breakdown exists at every level. The United Kingdom total has no first time buyer figure, for example, while England does. Anything the Land Registry does not publish comes back as `null` and never as a zero, so a missing figure can never be mistaken for a price of nothing.

Prices are in pounds sterling. The index is set so that January 2015 equals 100, which is why a region can show an index below 100 while prices are far above their 2015 level in cash terms.

## Who it's for

Property investors and developers comparing regions, estate agencies and portals showing local trends, mortgage and proptech dashboards, journalists and analysts tracking the UK housing market. Pairs with **US Rent and Home Price Index** for the same question in the United States.

## Pricing

Pay per region row. The first 2 rows of every run are free so you can validate the output before you pay.
