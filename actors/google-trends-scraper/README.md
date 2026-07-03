# Google Trends Scraper (No Login)

Get Google Trends data for any keyword as clean rows: interest over time, interest by region, and related rising and top queries. No login, no API key, no browser. Give it keywords, pick a country and time range, and it returns the same data the Trends UI shows.

## What you get

Each keyword produces up to three row types (choose which in `dataTypes`):

- `interest_over_time` (1 row per keyword): full `timeline` of dated 0 to 100 values, plus `averageValue`, `peakValue`, `latestValue`
- `interest_by_region` (1 row per region): `geoCode`, `geoName`, `value`, highest interest first
- `related_query` (1 row per query): `query`, `rank` (`top` or `rising`), `value`, `formattedValue` (rising shows growth like `+250%` or `Breakout`), `link`

Every row carries `keyword`, `geo`, `timeRange`, `category`, `property`, and `scrapedAt`.

## Input

- `keywords` (one or more terms; each explored on its own 0 to 100 scale)
- `geo` (two letter country code, empty = worldwide)
- `timeRange` (`now 1-H` to `all`, default past 12 months)
- `category` (Google Trends category ID, 0 = all)
- `property` (Web, Image, News, YouTube, or Shopping search)
- `dataTypes`, `maxRegionsPerKeyword`, `maxRelatedPerKeyword`, `maxRows`

## Example input

```json
{
  "keywords": ["web scraping", "chatgpt"],
  "geo": "US",
  "timeRange": "today 12-m"
}
```

Find rising searches around a niche worldwide:

```json
{
  "keywords": ["standing desk"],
  "geo": "",
  "timeRange": "today 3-m",
  "dataTypes": ["relatedQueries"]
}
```

## Uses

- Keyword research and SEO content planning
- Spotting rising product or niche demand before it peaks
- Validating market interest by country or region
- Tracking brand or competitor search interest over time
- Feeding trend signals into dashboards and alerts

## Pricing

Pay per row. The first 10 rows of every run are free so you can validate output before you scale up. An interest-over-time series is a single row (the whole timeline is embedded), so a typical keyword costs a few cents.

## Notes

- Values are Google's relative 0 to 100 index, scaled per keyword and time range, not absolute search volumes.
- Google Trends rate limits by IP. The Actor paces requests and retries with backoff; if you run many keywords back to back and see 429 warnings, supply a residential proxy in `proxyConfiguration`.
- Low volume keywords can return an empty timeline or no related lists; that is Google having no data, and no rows means no charge.
- Related topics (as opposed to related queries) are not offered because Google does not serve them to keyless sessions.
- This Actor reads only public data and never logs in.
