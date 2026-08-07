# European Economic Indicators: Inflation, Jobs and Growth

The EU statistics office publishes inflation, unemployment, growth, industrial output and public debt for every member state, monthly or quarterly rather than once a year. This reads that publication directly and returns one row per country per period. No key, no login, no proxy.

## Indicators

| Name | What it measures | Frequency |
| --- | --- | --- |
| `inflation` | Annual rate of change, all items | monthly |
| `unemployment` | Percent of the active population, seasonally adjusted | monthly |
| `gdp_growth` | Change on the previous quarter, chain linked volumes | quarterly |
| `industrial_production` | Change on the previous month, seasonally adjusted | monthly |
| `government_debt` | General government gross debt, percent of GDP | quarterly |

Coverage runs well beyond the EU itself: the reporting list includes candidate countries, EFTA members and, for some series, the United States and Japan.

## Three modes

**Latest** returns the most recent figure each country has actually published, with the previous period, the change and the direction.

**History** returns every period in the window, one row each.

**Dataset** takes any Eurostat dataset code with your own dimension filters and decodes it into rows, with each remaining dimension of the cube carried on the row so the output is self describing.

## Example input

```json
{
  "mode": "latest",
  "indicators": ["inflation", "unemployment", "gdp_growth"]
}
```

A year of inflation for the big five:

```json
{
  "mode": "history",
  "indicators": ["inflation"],
  "countries": ["DE", "FR", "IT", "ES", "NL"],
  "periods": 12
}
```

## Three things worth knowing

**Countries publish on different schedules, so "latest" is not one date.** Inflation may be current to December while unemployment runs to May and GDP to the first quarter, and within a single series one country reports a month ahead of another. Latest mode therefore returns each country's own most recent figure and states the period on the row, rather than picking one date and leaving half the map blank.

**Aggregates are excluded by default.** The source publishes the EU and the euro area, in several historical vintages, in the same list as the countries. Any ranking or average built from that list counts the same economies twice, so aggregates are flagged with `isAggregate` and left out unless you ask for them.

**Greece is EL, not GR.** The country codes are the statistical ones, and the United Kingdom appears as UK. Values carry the publisher's own status flag where present, so a provisional or estimated figure is marked rather than presented as final.

## Pricing

Pay per indicator row, `$0.003`. The first 2 rows of every run are free. Unknown indicators, empty windows and filters that match nothing return a free note explaining why.

One request covers a whole indicator across every country and period, so a full sweep of all five indicators is five requests and about twelve seconds.

## Related actors

- **World Economic Indicators Scraper: GDP, Inflation & More** for World Bank annual series covering the whole world
- **European Electricity Prices** for energy costs behind the inflation numbers
- **US Treasury Yields & Interest Rates Scraper** and **SOFR & Money Market Rates** for the rates side
