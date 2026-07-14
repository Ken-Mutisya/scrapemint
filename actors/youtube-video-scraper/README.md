# YouTube Video & Channel Scraper

Get YouTube data as clean rows, with **no API key and no quota limits**. Three things in one tool:

- **Search** any keyword and get the results as structured data
- **Channel videos**: pull the recent uploads from any channel
- **Video details**: full metadata for specific videos

For each video you get the title, view count, upload date, duration, channel, thumbnail and link — ready for a spreadsheet, a dashboard, a database or a bot.

## Why not the official API?

Google's YouTube Data API has a daily quota that runs out fast and needs a Google Cloud project and key. This tool reads YouTube's own public pages instead: no key, no quota, no project setup. You pay only for the rows you get.

## What you get for each video

- **title**, **url**, **videoId**
- **views** (as a number) and **viewsText**
- **published**, **durationSeconds** and **durationText**
- **channel** and **channelId**
- **thumbnail**: the largest available image

Video-details mode adds the description, category, keywords, exact upload date and like count.

## Example output

```json
{
  "source": "channel",
  "sourceInput": "@mkbhd",
  "videoId": "_oRgdlJUD18",
  "title": "iOS 27 Hands-On: Top 5 New Features!",
  "url": "https://www.youtube.com/watch?v=_oRgdlJUD18",
  "views": 2500000,
  "viewsText": "2.5M views",
  "published": "21 hours ago",
  "durationSeconds": 919,
  "thumbnail": "https://i.ytimg.com/vi/_oRgdlJUD18/hqdefault.jpg"
}
```

## Three modes

- **Search keywords**: each keyword returns the first page of results (about 20 videos).
- **Channels**: give handles (`@mkbhd`) or channel URLs; each returns the recent uploads (about 30 videos).
- **Video URLs or IDs**: watch links, youtu.be links or bare ids, for full details.

## Pricing

**$0.002 per video row.** Bad input, videos not found and pages that could not be fetched are **free**, and the first 2 rows of every run are free. A channel of 30 videos costs about $0.06; a keyword search about $0.04. Rental-priced YouTube actors charge far more per thousand.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~youtube-video-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchQueries": ["web scraping tutorial"], "channels": ["@mkbhd"]}'
```

## Scope and limits

- **Search and channel modes** return the first page (about 20 to 30 videos), which is what most monitoring and research needs.
- **Video-details mode** is best effort: YouTube rate limits the watch page more than the listing pages, so a busy run may not fetch every single video. Those rows come back free and marked, never charged, so you can retry them.
- **Not included**: transcripts and comments. This tool covers video and channel metadata.

## Frequently asked questions

**Is this the official YouTube data?** Yes, it is the same data YouTube shows on its public pages, just structured into rows. This tool is not affiliated with YouTube.

**Can I get more than the first page?** This version returns the first page per search or channel, which covers the newest and most relevant videos. Deeper pagination may come later.

**Do view counts update?** Each run reads the current values, so schedule a daily run to track how views grow over time.

## More tools from Scrapemint

- [TV Schedule & Shows Scraper](https://apify.com/scrapemint/tv-schedule-scraper): what airs and streams, per country and date.
- [Google News Scraper](https://apify.com/scrapemint/google-news-scraper): news coverage for any topic.
- [Sports Scores & Fixtures](https://apify.com/scrapemint/sports-scores-scraper): scores and standings for world leagues.
