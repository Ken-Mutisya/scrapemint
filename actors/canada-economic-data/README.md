# Canada Economic Data

Monthly Canadian statistics straight from Statistics Canada: consumer prices, new housing prices, housing starts, employment and GDP. For Canada as a whole, or broken down by province and city.

This is the government's own data, not a third party aggregator.

No login, no API key, no proxy.

## What you get

One row per series per geography per month:

```json
{
  "dataset": "housingPrices",
  "label": "New housing price index",
  "geography": "Ontario",
  "referencePeriod": "2026-06-01",
  "value": 117.8,
  "unit": "index, 2016 = 100",
  "productId": 18100205
}
```

## Datasets

| Key | Series | Unit |
| --- | --- | --- |
| `cpi` | Consumer price index | index, 2002 = 100 |
| `housingPrices` | New housing price index | index, 2016 = 100 |
| `housingStarts` | Housing starts | units |
| `employment` | Labour force characteristics | persons or percent |
| `gdp` | GDP at basic prices by industry | chained 2017 dollars |

## Input

| Field | Description |
| --- | --- |
| `datasets` | Which series to pull, e.g. `["cpi","housingPrices"]` |
| `geographies` | Names to match, e.g. `["Canada"]` or `["Ontario","Quebec"]` |
| `periods` | How many recent months per series and geography |
| `maxRows` | Total rows returned (default 200) |

## Examples

Latest headline figures for Canada:

```json
{ "datasets": ["cpi","housingPrices","housingStarts"], "geographies": ["Canada"] }
```

A year of housing prices by province:

```json
{ "datasets": ["housingPrices"], "geographies": ["Ontario","British Columbia","Alberta"], "periods": 12 }
```

## Things worth knowing

Geography matching is partial by design, so asking for `Ontario` also returns the metro areas that carry Ontario in their name, such as the Ontario part of Ottawa-Gatineau. Ask for `Canada` if you only want the national figure.

Each series is pinned to its headline total. The housing index, for example, returns house and land combined rather than the separate house only and land only measures.

Statistics Canada suppresses some figures for confidentiality and returns them as empty. Those come back as `null` and never as a zero, so a suppressed housing start count cannot be read as a month when nothing was built.

Tables publish on their own schedule, so the newest month can differ between series. GDP typically runs one month behind the price and housing figures.

## Who it's for

Analysts and journalists tracking the Canadian economy, property investors comparing provinces, fintech and proptech dashboards, and anyone who needs Canadian figures without a subscription data terminal. Pairs with **US Rent and Home Price Index**, **UK House Prices** and **Europe House Prices** for the same questions elsewhere.

## Pricing

Pay per data row. The first 2 rows of every run are free so you can validate the output before you pay.
