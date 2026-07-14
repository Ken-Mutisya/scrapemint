# TV Schedule & Shows Scraper

Get **TV schedules as clean rows**: what airs on which network and when, for any country and any date. Plus **streaming release dates** (what drops on web services each day, worldwide or per country) and **show lookups** with ratings, genres and status.

Built for **TV guide and entertainment app builders, "what to watch" newsletters, Discord bots and media bloggers**. Schedule a run every morning and always have today's TV lineup as structured data; or pull a month of schedules in one go.

## What you get for each episode

- **show** and **episodeName**, with season and episode number
- **airtime** and **airstamp**: local air time plus an exact timestamp
- **channel**: the network or streaming service, with its country
- **genres**, **showRating**, **showStatus**: for filtering what matters

Show lookup mode gives one row per show instead: status (running or ended), premiere and end dates, network, genres, rating, runtime, language, a short summary, official site and IMDb id.

## Example output

```json
{
  "date": "2026-07-14",
  "airtime": "00:35",
  "airstamp": "2026-07-14T04:35:00+00:00",
  "show": "Late Night with Seth Meyers",
  "episodeName": "Anne Hathaway, Alan Ritchson",
  "season": 2026,
  "episode": 68,
  "channel": "NBC",
  "channelCountry": "US",
  "genres": [],
  "showRating": 6.1,
  "showStatus": "Running"
}
```

## Three modes

- **Broadcast TV schedule**: pick a country (US, GB, DE, AU...) and a date or range — one row per episode airing on TV networks.
- **Streaming releases**: what comes out on web and streaming channels that day. Leave the country empty for worldwide.
- **Show lookup**: search shows by name, get the best matches with full details.

## Pricing

**$0.002 per row.** Days with nothing airing, bad country codes and shows that match nothing are **free**, and the first 2 rows of every run are free. A full US broadcast day (about 100 episodes) costs about $0.20; a daily morning run for a month is about $6, versus commercial TV listing APIs that start around $100 per month.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~tv-schedule-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dataType": "schedule", "country": "GB", "startDate": "2026-07-15"}'
```

## Frequently asked questions

**Which countries work?** Any country whose networks are tracked by the TVMaze community catalogue — the US and UK have the deepest coverage, and most of Europe, Australia, Canada, Japan and others are well covered.

**Is this movies too?** No, television and streaming shows only. For where movies and shows stream, see our [Streaming Availability Scraper](https://apify.com/scrapemint/streaming-availability-scraper).

**How current is it?** Schedules update continuously; a run reflects the catalogue at that moment. Future dates work as far as networks have announced.

**Where does the data come from?** The public [TVMaze](https://www.tvmaze.com) API, a community-maintained TV database (data licensed CC BY-SA).

## More tools from Scrapemint

- [Streaming Availability Scraper](https://apify.com/scrapemint/streaming-availability-scraper): where to watch any movie or show.
- [Music Charts Tracker](https://apify.com/scrapemint/music-charts-tracker): top songs and albums by country.
- [Podcast Charts Tracker](https://apify.com/scrapemint/podcast-charts-tracker): top podcasts by country and category.
