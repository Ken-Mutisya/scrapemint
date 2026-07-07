# App Store Top Charts Tracker: Ranks by Country & Category

Track Apple App Store top charts as structured data. Pick countries, chart types (top free, top paid, top grossing), and optionally categories, and get one JSON row per ranked app — with rank movement against your previous run built in. Reads Apple's official public chart feeds: no browser, no proxy, no API key, no scraping games.

Built for app developers watching their own rank, ASO agencies reporting to clients, and publishers scouting rising apps across countries and categories. Put it on a daily schedule and you have rank history the subscription tools charge $40+/month for.

## What you get

One row per ranked app per chart, with:

- `rank`, `previousRank`, `rankChange` (positive = climbed), `isNew` (entered the chart since last run)
- `appId`, `bundleId`, `name`, `artist`, `appUrl`, `artworkUrl`
- `price`, `currency`, `categoryId`, `categoryName`, `releaseDate`
- `country`, `chartType`, `chartCategoryId`, `checkedAt`

Chart state persists per chart in a named key-value store in your account (`app-charts-state`), so scheduled runs compare automatically.

## Input

- `countries` (two-letter codes: us, gb, de, jp, br, ...)
- `chartTypes` (`top-free`, `top-paid`, `top-grossing`)
- `categoryIds` (Apple genre IDs, e.g. 6014 Games, 6015 Finance, 6005 Social Networking; empty = overall charts)
- `topN` (chart depth, up to 200)
- `trackAppIds` (only report these apps; not-found rows are free)
- `compareWithPrevious` (default on)

## Example input

```json
{
  "countries": ["us", "de"],
  "chartTypes": ["top-free", "top-grossing"],
  "categoryIds": ["6014"],
  "topN": 100,
  "trackAppIds": ["1195621598"]
}
```

## Example output

```json
{
  "country": "us",
  "chartType": "top-grossing",
  "chartCategoryId": "6014",
  "rank": 31,
  "previousRank": 47,
  "rankChange": 16,
  "isNew": false,
  "appId": "1195621598",
  "name": "Homescapes",
  "artist": "Playrix",
  "price": 0,
  "currency": "USD",
  "categoryName": "Games",
  "checkedAt": "2026-07-07T12:00:00.000Z"
}
```

## Uses

- Daily rank history for your own app across countries, straight into a dashboard
- ASO agency reporting: client rank movement per market, as rows not screenshots
- Spot rising apps: filter `isNew` or large positive `rankChange` in any category
- Competitive tracking: watch a rival's grossing rank after their update ships
- Market research: compare category charts across countries

## Pricing

Pay per rank row. Tracked apps that are not found in a chart produce a free row (so "not charting" costs nothing), and charts that fail to fetch cost nothing. The first 2 rows of every run are free.

## Notes

- Data comes from Apple's official public chart feeds, refreshed by Apple throughout the day. Chart depth is up to 200 per chart.
- Category IDs are Apple genre IDs; the common ones are listed at the bottom of the input schema, and any ID from Apple's genre taxonomy works.
- Google Play charts are not included (Google exposes no public feed); if you need Play data, pair this with a Play scraping actor.
