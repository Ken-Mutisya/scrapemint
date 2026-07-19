# RSS Feed Scraper

Turn any RSS or Atom feeds into clean structured data. Paste feed URLs - or just website URLs, and the actor finds the feed for you - and get one row per item with title, link, date, author, plain-text summary, categories and image. No API key, no login, no browser.

## What you get

One row per feed item:

- title, link, published date (ISO), author
- a **plain-text summary** with HTML stripped and entities decoded
- categories/tags and the item image (enclosure or media tag)
- feed title and URL, plus the input URL it came from
- optionally the full HTML content when the feed carries it

## Feed autodiscovery

You do not need to know a site's feed URL. Give it `https://techcrunch.com` and the actor reads the page's feed link tag (falling back to common paths like `/feed` and `/atom.xml`) and scrapes what it finds. RSS 2.0, RSS 1.0 and Atom all work, including the malformed feeds real sites publish.

```json
{
    "feedUrls": [
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
        "https://techcrunch.com"
    ],
    "maxPerFeed": 50
}
```

## Monitor mode

Turn on **newOnly**, put the actor on a schedule, and each run emits only items it has not returned before. That turns any list of sites into a new-post alert feed - competitor blogs, industry news, product changelogs, security advisories - ready to pipe into Sheets, Slack or anything else. Runs where nothing new arrived cost nothing.

## Who uses this

- **Marketing and PR teams**: watch competitor blogs and industry news in one place, structured.
- **Founders and analysts**: aggregate niche sources into one dataset instead of an unread feed reader.
- **Developers**: a feed-to-JSON bridge for dashboards and automations - no parsing, no cron server.
- **Researchers and journalists**: collect articles across many outlets with consistent fields.

Pairs with our Google News Scraper for keyword-driven discovery and our Website Change Monitor for pages that have no feed at all.

## Pricing

A small fee per item row. Dead URLs, sites with no discoverable feed, and runs where nothing new arrived are free note rows, and the first 2 rows of every run are free.

## Notes

- Feeds are fetched directly with plain HTTP - your sources see a normal feed-reader request.
- Items are returned in feed order (feeds put newest first). Use **sinceDays** to drop old items on first runs.
- Very large feeds are truncated at the last complete item; per-feed and total row caps keep runs bounded.
