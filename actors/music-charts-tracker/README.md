# Music Charts Tracker: Apple Music Ranks by Country

Apple Music charts are different in every country, and they move every day. This actor pulls the official most-played songs and albums charts for any list of countries in one run, up to 100 ranks per chart. Schedule it and every run also tells you what moved: previous rank, change, new entries, artist drop-offs. No login, no API key, no subscription.

Chart analytics platforms charge $10 to $140 a month for dashboards built on this data. Here you pay per row and the first rows of every run are free.

## What you get

One row per ranked entry per chart:

| Field | Description |
|---|---|
| `country`, `chartType` | Which chart this row is from (`top-songs` or `top-albums`) |
| `rank` | Current chart position |
| `previousRank`, `rankChange`, `isNew` | Movement versus your previous run (with "Compare with previous run" on) |
| `droppedOff` | For tracked artists that left the chart |
| `itemId` | Apple Music song or album id |
| `name`, `artistName`, `artistId`, `artistUrl` | Title and artist, with joinable artist id |
| `genres` | Genre names |
| `releaseDate`, `contentAdvisoryRating` | Release date and explicit flag |
| `itemUrl`, `artworkUrl` | Apple Music deep link and cover art |
| `checkedAt` | Timestamp |

## Input

- **Countries**: any Apple storefront codes (`us, gb, de, br, jp, in, ng, ke, ...`)
- **Chart types**: top songs, top albums, or both
- **Chart depth**: up to 100 ranks per chart
- **Track only these artists**: give Apple artist ids and get only their entries; artists with no chart entry return a **free** `rank: null` row, so "not charting" costs nothing
- **Compare with previous run**: keeps rank history between runs for movement fields

5 countries x both charts x top 100 = 1,000 rows in a single run.

## Pricing

Pay per result: **$0.003 per chart row**. First 2 rows of every run are free. Tracked artists missing from a chart are always free rows.

Following one artist across 20 countries daily costs at most $0.06 a day even when they chart everywhere. A daily top-100 songs sweep of 10 countries is $3 a run.

## Typical uses

- **Artists and managers**: track your releases across every market, daily, with movement.
- **Labels and distributors**: catch a track breaking in one territory before it spreads.
- **Playlist and TikTok music marketers**: risers by country are the pitch list.
- **Music journalists and chart-watch accounts**: automated movement feeds per market.
- **A&R research**: which genres and artists dominate which storefronts.

## Scheduling

Run it daily on an Apify schedule with "Compare with previous run" on. Rank history is kept per chart in a named key-value store, so movement fields are computed automatically. Consume rows via the API, webhooks, or the Google Sheets integration.

## Data notes

Data comes from Apple's official public chart feeds and reflects chart state at run time. Apple refreshes charts throughout the day; movement fields compare against your own previous run, so a stable schedule gives the cleanest deltas.
