# Labor Statistics Scraper (BLS): Inflation, Jobs & Wages

Official US economic data - inflation, unemployment, wages, job openings and more - straight from the Bureau of Labor Statistics, as a clean time series. No API key required, no login, no browser.

The catch with the BLS API is that everything is a cryptic series ID like `CUUR0000SA0`. This actor gives you plain-English metrics instead, while still letting power users paste raw series IDs.

## Pick a metric

| Metric | What it is |
| --- | --- |
| Inflation (CPI-U) | Consumer Price Index, all items |
| Unemployment rate | Headline US unemployment |
| Labor force participation | Share of adults working or looking |
| Total nonfarm employment | Jobs in the economy |
| Average hourly earnings | Private-sector pay |
| Average weekly hours | Private-sector hours |
| Producer Price Index | Wholesale/producer prices |
| Job openings (JOLTS) | Open positions |
| Quits rate (JOLTS) | Share of workers quitting |

## Example input

```json
{
    "metrics": ["cpi-inflation", "unemployment-rate"],
    "startYear": 2020,
    "endYear": 2025
}
```

Each metric comes back as one row per month, with the value, period, unit and a plain label. Add raw BLS series IDs under `seriesIds` for anything not in the preset list.

## Who uses this

- **Companies**: benchmark pay against average earnings, track inflation and the labor market for budgeting and planning.
- **Schools and universities**: economics and business teaching and research with real, current data.
- **Analysts, consultants and journalists**: inflation, jobs and wage trends as structured numbers, ready for a spreadsheet or model.

## Limits and the optional key

The keyless BLS API allows 25 requests per day per IP (shared here) and a 10-year range. If the daily limit is hit, the run stops cleanly and tells you. Add your own free BLS registration key (data.bls.gov/registrationEngine) to raise the limit to 500/day, 50 series and a 20-year range - it stays private to your run.

## Pricing

A small fee per data-point row. Unknown series IDs and requests blocked by the daily limit are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: US Bureau of Labor Statistics public API (public-domain government data). Series are US national and monthly unless noted.
