# IMF Economic Forecasts

The IMF's World Economic Outlook numbers for around 230 countries and blocs: GDP growth, inflation, government debt, unemployment and more, going back to 1980 and forward through the IMF's own projections.

Every row says whether the year is an observed figure or a forecast, so you never have to guess which is which.

No login, no API key, no proxy.

## What you get

One row per indicator per country per year:

```json
{
  "indicator": "NGDP_RPCH",
  "indicatorLabel": "Real GDP growth",
  "unit": "Annual percent change",
  "entity": "United Kingdom",
  "entityCode": "GBR",
  "entityType": "country",
  "year": 2027,
  "value": 1.3,
  "isProjection": true,
  "weoVintage": "World Economic Outlook (April 2026)"
}
```

## Indicators

Over 130 are available. The common ones:

| Code | Indicator | Unit |
| --- | --- | --- |
| `NGDP_RPCH` | Real GDP growth | annual percent change |
| `PCPIPCH` | Inflation, average consumer prices | annual percent change |
| `GGXWDG_NGDP` | General government gross debt | percent of GDP |
| `LUR` | Unemployment rate | percent |
| `BCA_NGDPD` | Current account balance | percent of GDP |

## Input

| Field | Description |
| --- | --- |
| `indicators` | IMF indicator codes |
| `countries` | ISO3 codes such as `USA`, or full names. Empty means every country |
| `fromYear` / `toYear` | Year range. Data starts 1980, projections run to 2031 |
| `includeAggregates` | Include blocs such as World and Advanced economies |
| `maxRows` | Total rows returned (default 300) |

## Examples

Growth and inflation for the G7 through the forecast horizon:

```json
{ "indicators": ["NGDP_RPCH","PCPIPCH"], "countries": ["USA","GBR","DEU","FRA","ITA","JPN","CAN"], "fromYear": "2025" }
```

Government debt for every country, latest projection year:

```json
{ "indicators": ["GGXWDG_NGDP"], "countries": [], "fromYear": "2031", "toYear": "2031", "maxRows": 250 }
```

World and bloc aggregates:

```json
{ "indicators": ["NGDP_RPCH"], "countries": ["WEOWORLD","ADVEC"], "includeAggregates": true }
```

## How the forecast flag works

The API does not mark which years are projections, so it is derived from the release the data came from. The metadata names a vintage such as "World Economic Outlook (April 2026)", and every year from that vintage year onward is the IMF's forecast rather than an observed outcome. The vintage is on every row so you can see exactly which release you are reading.

Because of that, `isProjection` follows the IMF's publishing cycle rather than the calendar. A figure for the current year is a projection even though the year is underway, which is how the IMF itself presents it.

## Things worth knowing

The IMF publishes blocs such as World, Advanced economies and Euro area in the same list as countries. They are excluded by default so an aggregate is never mistaken for a country, and when included they are labelled `group` or `region`.

Units differ between indicators, so a growth rate and a debt ratio are not comparable numbers. Every row carries its own unit.

A year the IMF has not published comes back as `null`, never as a zero.

The World Economic Outlook is released about twice a year, so this data changes far less often than a market feed.

## Who it's for

Analysts and journalists writing country briefs, economists comparing forecasts, fintech dashboards, and anyone who needs the IMF's outlook without scraping the PDF. Complements the World Bank based **World Economic Indicators Scraper**, which is historical rather than forward looking.

## Pricing

Pay per data row. The first 2 rows of every run are free so you can validate the output before you pay.
