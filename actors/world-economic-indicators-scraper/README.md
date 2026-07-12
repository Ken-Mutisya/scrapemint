# World Economic Indicators Scraper: GDP, Inflation & More

Pull clean economic data for any set of countries and any set of indicators,
across decades, in one run. Built on the **World Bank Indicators API** —
~265 economies and ~29,500 indicators (GDP, GDP per capita, inflation,
unemployment, population, life expectancy, trade, debt, and far more). No API
key, no proxy, works for every country on Earth.

## Who it's for

- **Analysts, fintech and funds** building country-risk and macro models.
- **Researchers, universities and students** who need multi-country panel data
  without hand-assembling it.
- **Consultancies, NGOs, journalists and data-viz teams** producing country
  comparisons and economic profiles.
- **Companies** doing market-entry and expansion analysis.

## Input

| Field | What it does |
| --- | --- |
| `countries` | ISO codes (`US`, `CN`, `IN`…), or `ALL` for every economy, or World Bank aggregates (`WLD`, `EUU`, `LMY`). |
| `indicators` | World Bank indicator ids, e.g. `NY.GDP.MKTP.CD` (GDP), `FP.CPI.TOTL.ZG` (inflation). Browse at data.worldbank.org/indicator. |
| `startYear` / `endYear` | Year range. Empty = full available history. |
| `mostRecentOnly` | Return only the latest value per country-indicator (a current snapshot). |
| `skipEmpty` | Skip country-years with missing values (on by default). |
| `maxRows` | Cap on data points. Controls cost. |

## Output (one row per country-indicator-year)

`country`, `countryCode`, `iso3`, `region`, `incomeLevel`, `indicatorId`,
`indicator`, `year`, `value`, `unit`.

Each row is enriched with the country's **region** and **income level** (from
World Bank metadata), so you can group or filter by region and income without
a second data source.

## Common indicator ids

| Indicator | Id |
| --- | --- |
| GDP (current US$) | `NY.GDP.MKTP.CD` |
| GDP per capita (current US$) | `NY.GDP.PCAP.CD` |
| GDP growth (annual %) | `NY.GDP.MKTP.KD.ZG` |
| Inflation, consumer prices (annual %) | `FP.CPI.TOTL.ZG` |
| Unemployment (% of labor force) | `SL.UEM.TOTL.ZS` |
| Population, total | `SP.POP.TOTL` |
| Life expectancy at birth | `SP.DYN.LE00.IN` |

## Pricing

Pay per event: **$0.004 per data point** (country-indicator-year). The first
**2 rows per run are free**, so you can preview the output at no cost.

## Example

```json
{
  "countries": ["US", "CN", "IN", "BR", "KE"],
  "indicators": ["NY.GDP.MKTP.CD", "FP.CPI.TOTL.ZG"],
  "startYear": 2015,
  "endYear": 2023
}
```

Returns GDP and inflation for those five countries, 2015–2023, one row each.
