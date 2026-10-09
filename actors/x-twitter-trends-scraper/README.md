# X (Twitter) Trends Scraper: 62 Countries, Hourly

The **top 50 trending topics on X (Twitter)** for 62 countries and worldwide, as clean rows: rank, trend, hashtag flag, a ready X search link, and **each trend's rank over the past 8 hours**, so you can see what is climbing, what just entered and what is fading. Read the list **right now or any hour of the last 24**, and add the **most-tweeted** and **longest-trending** lists for the last day, week or month.

No X account, no API key, no proxy. $0.0002 per trend, no start fee.

## What you get per trend

- `rank` (1 to 50), `trend`, `isHashtag`, `xSearchUrl`
- `country`, `countrySlug`, `snapshot` ("now", "6 hours ago"), `hoursAgo`
- `rankHistory8h`: rank in each of the last 8 hours, oldest first (`null` = not in the top 50 that hour)
- `hoursInTop50Last8h`, `bestRankLast8h`, `isNew` (entered the top 50 this hour)
- `sourceUrl`, `scrapedAt`

With **Add most-tweeted and longest-trending lists** on, each country also gets:

- `list: mostTweeted_day|week|month` rows with `tweetScore` (relative tweet volume) and `recordDate`
- `list: longestTrending_day|week|month` rows with `hoursTrending`

## Countries

Worldwide, Algeria, Argentina, Australia, Austria, Bahrain, Belarus, Belgium, Brazil, Canada, Chile, Colombia, Denmark, Dominican Republic, Ecuador, Egypt, France, Germany, Ghana, Greece, Guatemala, India, Indonesia, Ireland, Israel, Italy, Japan, Jordan, Kenya, Korea, Kuwait, Latvia, Lebanon, Malaysia, Mexico, Netherlands, New Zealand, Nigeria, Norway, Oman, Pakistan, Panama, Peru, Philippines, Poland, Portugal, Puerto Rico, Qatar, Russia, Saudi Arabia, Singapore, South Africa, Spain, Sweden, Switzerland, Thailand, Turkey, Ukraine, United Arab Emirates, United Kingdom, United States, Venezuela, Vietnam. Use `all` for every one.

## Example input

The US and worldwide top 50 right now:

```json
{
  "countries": ["united-states", "worldwide"]
}
```

Four snapshots across the day for the UK and Germany, plus the week's most-tweeted and longest-trending:

```json
{
  "countries": ["uk", "germany"],
  "hoursAgo": ["0", "6", "12", "18"],
  "includeTopLists": true,
  "topListPeriod": "week"
}
```

Top 10 in every country (630 rows, about $0.13):

```json
{
  "countries": ["all"],
  "maxTrendsPerList": 10
}
```

## Example output

```json
{
  "list": "top50",
  "rank": 3,
  "trend": "Jerry",
  "isHashtag": false,
  "xSearchUrl": "https://x.com/search?q=Jerry&src=trend_click",
  "country": "United States",
  "snapshot": "now",
  "rankHistory8h": [null, null, null, 4, 5, 5, 3, 3],
  "hoursInTop50Last8h": 5,
  "bestRankLast8h": 3,
  "isNew": false
}
```

```json
{
  "list": "mostTweeted_week",
  "rank": 1,
  "trend": "#FUNToken",
  "isHashtag": true,
  "country": "United States",
  "tweetScore": 685,
  "recordDate": "20 hours ago"
}
```

## Uses

- **Social media and newsrooms:** what to post about now, per market, on a schedule every hour
- **Brand monitoring:** catch your brand, product or campaign hashtag entering a country's trends
- **Trend research:** a time series of what trended where, built from hourly runs
- **Marketing and ad teams:** pick hashtags that are rising, not ones already fading
- **Data and AI pipelines:** a clean daily feed of world events by country

## Pricing

- **$0.0002** per trend row
- No start fee. A country that fails is free.

## Notes

- X stopped publishing tweet counts outside its paid API, so no free source shows a "tweets" number any more. `tweetScore` is the source site's relative volume index, useful for ranking, not an exact count.
- Rank history is read from the source site's hourly chart, so a value can be off by one place.
- Trends are the country-level lists X publishes; city-level lists are not available from this source.
- Schedule the actor hourly (Apify Schedules) to build your own long-term trend history.
