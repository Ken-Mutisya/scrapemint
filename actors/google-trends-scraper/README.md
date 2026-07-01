# Google Trends Scraper (No Login)

See what is trending on Google right now in any country and get one clean row per trending search. No login, no API key, no browser. Give it a list of countries, the Actor returns the trending terms with their approximate search volume and the news articles driving each one.

## What you get

One row per trending search, with:

- `term` (the trending search)
- `rank` (position in the country feed)
- `geo` (country code)
- `approxTraffic`, `approxTrafficNum` (approximate search volume, e.g. `20000+` and `20000`)
- `publishedAt`, `publishedAtIso`
- `pictureUrl`, `pictureSource`
- `newsItems` (the articles driving the trend: `title`, `url`, `source`, `picture`)
- `scrapedAt`

## Input

- `geos` (one or more two letter country codes, e.g. `US`, `GB`, `IN`, `DE`, `JP`, `BR`)
- `includeNews` (attach the related news articles per trend, on by default)
- `maxNewsPerTrend` (cap on news articles per term)
- `maxPerGeo`, `maxRows`

## Example input

```json
{
  "geos": ["US", "GB"],
  "includeNews": true,
  "maxNewsPerTrend": 3,
  "maxRows": 100
}
```

Just the terms and volumes, no news, for several countries:

```json
{
  "geos": ["US", "IN", "BR", "JP"],
  "includeNews": false
}
```

## Uses

- Real time trend and topic monitoring
- Content and SEO idea generation
- PR and newsroom monitoring
- Feeding a trends dashboard or alert

## Pricing

Pay per row. The first 15 rows of every run are free so you can validate output before you scale up. You only pay for the trends you keep.

## Notes

- Data comes from the Google Trends trending searches RSS feed, so coverage matches Google Trends. Google serves roughly 10 to 20 trending searches per country at a time.
- This is the real time trending searches feed, not arbitrary "interest over time for my keyword". That view needs a separate token flow that is rate limited hard, so it is out of scope here.
- Proxy is off by default because the feed is a tolerant public source; supply a proxy only if you pull many countries and hit rate limits.
