# Google Play Reviews Scraper

Pull Google Play app reviews at scale, for your own app or any competitor's. One clean row per review with the rating, full text, date, thumbs up count, the app version it was written on, and the developer reply if there is one. Sort by newest for monitoring or filter to 1 star rows to read the churn reasons. No login, no API key, no browser.

## What you get

One row per review, with:

- `appId`, `reviewId`, `url` (deep link to the review)
- `userName`, `rating` (1 to 5), `text` (full review, not truncated)
- `date`, `thumbsUpCount`, `appVersion`
- `developerReplyText`, `developerReplyDate` (when the developer responded)
- `sort`, `starsFilter`, `language`, `country`, `scrapedAt`

## Input

- `apps`: package IDs (`com.whatsapp`) or full store URLs, one per app
- `sort`: `newest`, `relevance`, or `rating`
- `starsFilter`: `0` for all, or `1` to `5` to keep a single rating bucket
- `language`, `country`: which localized reviews to pull (e.g. `en` / `us`, `pt` / `br`)
- `maxReviewsPerApp`, `maxRows`

## Example input

```json
{
  "apps": ["com.whatsapp", "org.telegram.messenger"],
  "sort": "newest",
  "maxReviewsPerApp": 500
}
```

Bug and churn mining, 1 star rows only:

```json
{
  "apps": ["com.yourcompany.app"],
  "starsFilter": 1,
  "sort": "newest"
}
```

## Uses

- Competitor research: what users love and hate about the apps in your category
- Churn and bug mining: 1 and 2 star rows are a prioritized complaint list, with the app version attached
- Review sentiment analysis: feed rows straight into your AI pipeline; the text is full length and structured
- Reply tracking: which reviews the developer answers and how fast
- Pairs with the [Google Play Developer Leads](https://apify.com/scrapemint/google-play-developer-leads) actor for contacting app developers, and the [App Store Top Charts Tracker](https://apify.com/scrapemint/app-store-top-charts-tracker) for the iOS side

## Pricing

Pay per row. The first 2 rows of every run are free so you can validate output. 500 reviews cost $1.00; a full 200 review default run per app costs about 40 cents.

## Notes

- Reviews come from Google Play's public review endpoint, the same one the store page uses, so rows match what you see on play.google.com for your chosen language and country.
- Pagination is native, so deep pulls (thousands of reviews per app) are fine within your row caps.
- Requests are paced and the Actor stops early with results if the endpoint rate limits, so a blocked run never spins compute.
- This Actor reads only public data and never logs in.
