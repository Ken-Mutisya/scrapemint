# Podcast Charts Tracker: Apple Ranks by Country & Genre

Apple Podcasts charts are the scoreboard of podcasting, and they are different in every country and genre. This actor pulls them straight from Apple's official chart feeds: any country, any genre, up to 200 ranks per chart, one run. Schedule it and every run also tells you what moved: previous rank, change, new entries, drop-offs. No login, no API key, no subscription.

Since Chartable shut down, rank tracking tools charge $19 to $160 a month. Here you pay per row and the first rows of every run are free.

## What you get

One row per ranked podcast per chart:

| Field | Description |
|---|---|
| `country`, `genre` | Which chart this row is from |
| `rank` | Current chart position |
| `previousRank`, `rankChange`, `isNew` | Movement versus your previous run (with "Compare with previous run" on) |
| `droppedOff` | For tracked shows that left the chart |
| `podcastId` | Apple podcast id (joinable with lookup APIs and RSS feeds) |
| `name`, `publisher` | Show and publisher |
| `categoryName`, `summary` | Genre label and show description |
| `podcastUrl`, `artworkUrl` | Apple Podcasts page and cover art |
| `checkedAt` | Timestamp |

## Input

- **Countries**: any Apple storefront codes (`us, gb, de, in, br, jp, au, ng, ke, ...`)
- **Genres**: overall chart plus 19 genres (Business, Comedy, News, True Crime, Technology, ...)
- **Chart depth**: up to 200 ranks per chart
- **Track only these podcasts**: give your show ids and get only their rows; shows absent from a chart return a **free** `rank: null` row, so "not charting" costs nothing
- **Compare with previous run**: keeps rank history between runs for movement fields

2 countries x 3 genres x top 100 = 600 rows in a single run.

## Pricing

Pay per result: **$0.003 per chart row**. First 2 rows of every run are free. Tracked shows missing from a chart are always free rows.

Watching your own show across 10 countries daily costs at most $0.03 a day. A full daily top-100 sweep of one country's 20 charts is $6 a month.

## Typical uses

- **Podcasters**: track your show's rank across every country you care about, daily, with movement.
- **Agencies and networks**: client reporting without a $160/month analytics seat.
- **Sponsors and advertisers**: spot rising shows in a genre before their rate card catches up.
- **Guest booking and PR**: pair with the [Podcast Host Leads](https://apify.com/scrapemint/podcast-host-leads) actor — this one tells you which shows are hot, that one turns show lists into host contact emails.
- **Media and newsletters**: chart movement stories per market.

## Scheduling

Run it daily on an Apify schedule with "Compare with previous run" on. Rank history is kept per chart in a named key-value store, so movement fields are computed automatically. Consume rows via the API, webhooks, or the Google Sheets integration.

## Data notes

Data comes from Apple's official public chart feeds and reflects chart state at run time. Apple refreshes charts throughout the day; movement fields compare against your own previous run, so a stable schedule gives the cleanest deltas.
