# Google News Scraper (No Login)

Track any topic, brand, ticker, or person on Google News and get one clean row per article. No login, no API key, no browser. Give it search terms, the Actor returns the matching headlines with source and publish date.

## What you get

One row per article, with:

- `title` (headline, with the trailing source removed)
- `source`, `sourceUrl`
- `url` (link to the article)
- `publishedAt`, `publishedAtIso`
- `guid`, `query`, `language`, `country`, `scrapedAt`

## Input

- `queries` (one or more terms; each runs as its own feed, up to ~100 articles)
- `language` (e.g. `en-US`, `en-GB`, `es-ES`, `fr-FR`, `de-DE`)
- `country` (e.g. `US`, `GB`, `CA`, `AU`, `IN`, `DE`)
- `when` (optional recency window, e.g. `1h`, `12h`, `1d`, `7d`)
- `maxPerQuery`, `maxArticles`

## Example input

```json
{
  "queries": ["tesla", "openai"],
  "language": "en-US",
  "country": "US",
  "when": "7d",
  "maxArticles": 200
}
```

Monitor a brand in the UK over the last day:

```json
{
  "queries": ["my brand name"],
  "language": "en-GB",
  "country": "GB",
  "when": "1d"
}
```

## Uses

- Brand and competitor monitoring
- PR and media tracking
- Market and ticker news for finance workflows
- Feeding a news dashboard or alert

## Pricing

Pay per row. The first 5 rows of every run are free so you can validate output before you scale up. You only pay for the articles you keep.

## Notes

- Data comes from Google News public RSS feeds, so coverage matches Google News.
- Proxy is off by default because the feeds are a tolerant public source; supply a proxy only if you run very large pulls and hit rate limits.
- This Actor reads only public data and never logs in.
