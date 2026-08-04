# Europe House Prices

Eurostat's official house price index for 38 European countries: the index level, how prices moved on the previous quarter, and how they moved on the same quarter a year earlier.

This is the European Union's own statistical measure, not portal asking prices. You can look at all dwellings together, or split new build from existing homes.

No login, no API key, no proxy.

## What you get

One row per country per quarter:

```json
{
  "country": "Portugal",
  "geoCode": "PT",
  "quarter": "2026-Q1",
  "purchase": "TOTAL",
  "purchaseLabel": "all dwellings",
  "index2015": 290.98,
  "changeQuarterPct": 3.8,
  "changeYearPct": 17.8,
  "indexUnit": "index, 2015 = 100"
}
```

## Input

| Field | Description |
| --- | --- |
| `countries` | Eurostat geo codes, e.g. `["DE","FR","ES"]`. Empty returns all 38 |
| `purchase` | `TOTAL`, `DW_NEW` (new dwellings) or `DW_EXST` (existing dwellings) |
| `mode` | `latest` (most recent quarter) or `history` |
| `periods` | History mode only, how many recent quarters per country |
| `maxRows` | Total rows returned (default 200) |

Aggregates work as well as countries, so `EU27_2020` and `EA20` give the union and euro area totals.

## Examples

Latest quarter across Europe:

```json
{ "mode": "latest" }
```

Three years of history for the big four:

```json
{ "mode": "history", "countries": ["DE","FR","ES","IT"], "periods": 12 }
```

New build prices only:

```json
{ "mode": "latest", "purchase": "DW_NEW" }
```

## Things worth knowing

The index is set so that 2015 equals 100. A country can therefore sit at 290 while another sits at 126 purely because prices rose faster there since 2015, so compare the change columns rather than the index levels across countries.

Eurostat publishes quarterly and in arrears, so the newest quarter is not the current one.

Anything Eurostat has not published for a country and quarter comes back as `null` and never as a zero, so a missing figure cannot be mistaken for a flat market.

Countries genuinely do land on identical numbers sometimes. Italy and the Netherlands both recorded a 1.0 percent quarterly and 5.2 percent annual move in 2026 Q1, which is a coincidence in the data rather than a fault.

## Who it's for

Property investors comparing European markets, banks and proptech dashboards, relocation services, and analysts tracking housing across the continent. Completes the picture with **UK House Prices** and **US Rent and Home Price Index** for the same question in Britain and America.

## Pricing

Pay per country row. The first 2 rows of every run are free so you can validate the output before you pay.
