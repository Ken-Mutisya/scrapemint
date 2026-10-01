# Google Trends Scraper: Interest, Regions, Rising Queries

Google Trends data for any keyword, as clean rows: **interest over time** (with a summary that tells you the peak and whether interest is rising, falling or flat), **interest by country, state, city or US metro**, **top and rising related queries**, and the daily **Trending Now** searches with their news links. Compare up to 5 terms, pick any country, time range, category, or switch to YouTube, News, Image or Shopping search.

No API key, no login, no proxy. $0.003 per keyword, no start fee.

## What you get per keyword

- `interestOverTime`: every point Google charts for the range (`date`, `value` 0-100, `isPartial` on the unfinished last period)
- `summary`: `average`, `latest`, `peak`, `peakDate`, `recentVsPriorPct` (the last quarter of the range against the quarter before) and `direction` (`rising`, `falling` or `flat`), so you can sort a keyword list by momentum without charting anything
- `interestByRegion`: `geoCode`, `geoName`, `value` for countries, states, cities or US metros
- `relatedQueriesTop` and `relatedQueriesRising`: what people also search, with Google's score, or the growth figure (`"Breakout"` above +5000%) for rising ones
- `trendsUrl`: the same view on trends.google.com

With `trendingNow` on, you also get one row per trending search: `title`, `approxTraffic` ("200K+"), `approxTrafficMin` as a number, `startedAt`, `picture`, and `news` (title, URL, source) for each country you list.

## Example input

Two keywords in the US over the last year:

```json
{
  "searchTerms": ["pickleball", "padel"],
  "geo": "US"
}
```

Three terms compared against each other, worldwide, last 90 days:

```json
{
  "searchTerms": ["chatgpt", "claude", "gemini"],
  "compareTerms": true,
  "timeRange": "today 3-m"
}
```

Today's trending searches in the US, UK and India:

```json
{
  "trendingNow": true,
  "trendingGeos": ["US", "GB", "IN"]
}
```

## Example output

```json
{
  "rowType": "keyword",
  "searchTerm": "pickleball",
  "geo": "US",
  "timeRange": "today 12-m",
  "comparedWith": null,
  "interestOverTime": [
    { "date": "2025-09-28T00:00:00.000Z", "value": 50 },
    { "date": "2025-10-05T00:00:00.000Z", "value": 53 }
  ],
  "summary": {
    "average": 66.6,
    "latest": 51,
    "peak": 100,
    "peakDate": "2026-04-12T00:00:00.000Z",
    "recentVsPriorPct": -28.2,
    "direction": "falling"
  },
  "interestByRegion": [
    { "geoCode": "US-WY", "geoName": "Wyoming", "value": 100 },
    { "geoCode": "US-UT", "geoName": "Utah", "value": 62 }
  ],
  "relatedQueriesTop": [
    { "query": "pickleball paddle", "value": 100, "formattedValue": "100" },
    { "query": "pickleball courts", "value": 49, "formattedValue": "49" }
  ],
  "relatedQueriesRising": [],
  "trendsUrl": "https://trends.google.com/trends/explore?q=pickleball&date=today+12-m&geo=US"
}
```

## Uses

- **SEO and content:** find rising queries before they are competitive, and the regions where a topic is hottest
- **Product and market research:** compare demand for products, brands or categories over time
- **Trading and investing signals:** search interest in a ticker, product or brand as an alternative-data series, scheduled daily
- **Newsrooms and social teams:** the Trending Now feed with its news links, per country

## Pricing

- **$0.003** per keyword result, with every data type you asked for in one row
- **$0.001** per Trending Now search
- No start fee. A keyword Google has no data for (too rare for the range and region) is returned with a note and not charged.

## Notes

- Values are Google's: 0-100, relative to the highest point in the range (or, with `compareTerms`, to the highest of the compared terms). They are not absolute search volumes.
- Google compares at most 5 terms. With `compareTerms` and more than 5 terms, they are split into groups of 5, each scaled on its own.
- Related topics are not included: Google does not serve them to automated sessions.
- Category IDs follow Google Trends' own list (e.g. 7 Finance, 71 Food & Drink, 958 Travel); 0 is all categories.
