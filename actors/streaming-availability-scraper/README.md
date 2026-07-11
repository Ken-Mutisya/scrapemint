# Streaming Availability Scraper: Where to Watch by Country

Streaming catalogs are different in every country. A title on Netflix US may be on Prime in Germany, on a local service in India, and not watchable at all in Brazil. This actor answers "where can people watch this title" for any list of movies and shows across 140+ countries, in one run. No login, no API key, no subscription.

Commercial streaming availability APIs charge $10 to $150 a month. Here you pay per row and the first rows of every run are free.

## What you get

One row per title per country:

| Field | Description |
|---|---|
| `searchQuery` | The title you asked for |
| `title`, `type`, `releaseYear` | Matched title, `movie` or `show`, release year |
| `imdbId`, `tmdbId` | External ids for joining with your own data |
| `genres` | Genre codes |
| `country` | ISO country code this row answers for |
| `available` | `true` if at least one offer exists in this country |
| `streamingServices` | Subscription services carrying it (Netflix, Prime Video, Disney+ etc.) |
| `rentServices`, `buyServices`, `freeServices` | Services by offer type |
| `offerCount`, `offers` | Full offer list: service, type (stream/rent/buy/free), price and currency where shown, available qualities (SD/HD/4K), direct deep link |
| `justwatchUrl`, `posterUrl` | Title page and poster image |

A row with zero offers is a real answer: the title is not watchable in that country right now.

## Input

- **Titles**: any list of movie or show names. The best match is used (raise "Matches per title" for ambiguous names like remakes).
- **Countries**: ISO codes, e.g. `US, GB, DE, IN, BR, JP, NG, KE`. 140+ supported.
- **Max rows per run**: cost cap.

3 titles x 5 countries = 15 rows. 50 titles x 20 countries = 1,000 rows.

## Pricing

Pay per result: **$0.005 per title x country row**. First 2 rows of every run are free.

Checking one title across 20 countries costs $0.09. A 100-title catalog across 5 countries costs $2.49. No subscription, no minimum.

## Typical uses

- **Where-to-watch sites and apps**: build or refresh availability pages with deep links per country.
- **VPN and affiliate content**: "what is on Netflix in X but not in Y" articles are an entire content niche; this gives you the matrix in one run.
- **Catalog tracking**: schedule a daily run over your watchlist and diff rows to catch titles entering or leaving services.
- **Distribution and rights research**: check which territories already have a title licensed and on which services.
- **Price comparison**: rent and buy prices per country in local currency.

## Scheduling

Run it on a schedule via Apify and consume rows through the API, webhooks, or the Google Sheets integration. Pair rows with your own IMDB or TMDB ids using the returned external ids.

## Data notes

Availability data reflects JustWatch's public catalog at run time. Offer prices are shown where the catalog publishes them (rentals and purchases); subscription offers carry no price. Coverage and freshness vary slightly by country.
