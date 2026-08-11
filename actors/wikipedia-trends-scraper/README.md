# Wikipedia Trends Scraper: Top Articles by Country

Wikipedia is where the world goes to look things up, and its view counts are public, real numbers, not an index. This actor pulls the daily most-viewed articles for any country or language edition (up to 1000 ranks), and daily view histories for any list of articles. Straight from Wikimedia's official pageviews API. No login, no API key, no subscription.

Google Trends tells you a topic is rising on a 0 to 100 scale. Wikipedia tells you how many people actually looked it up, per day, per country. Together they are a complete attention dataset; pair this with the [Google News Scraper](https://apify.com/scrapemint/google-news-scraper).

## What you get

**Top mode** — one row per ranked article per chart:

| Field | Description |
|---|---|
| `scope`, `country` / `project` | Chart identity: a country (all languages combined) or a language edition (worldwide) |
| `date` | The day the chart is for (stats publish with about one day of lag) |
| `rank`, `views` | Position and real view count |
| `previousRank`, `rankChange`, `isNew` | Movement versus your previous run (with compare on) |
| `article`, `articleKey`, `articleUrl` | Title, raw key, and link |

**Timeseries mode** — one row per article per day: `article`, `date`, `views`, `project`, `articleUrl`.

Non-article noise (Main Page, search pages, meta namespaces) is filtered out by default so charts contain real topics.

## Input

- **Top mode**: country codes (`US, GB, DE, IN, BR, KE, ...`) and/or wiki projects (`en.wikipedia, ja.wikipedia`), chart depth up to 1000, optional specific date, movement tracking on a schedule.
- **Timeseries mode**: article titles, language edition, up to 365 days back.
- **Max rows per run**: cost cap.

## Pricing

Pay per result: **$0.003 per row**. First 2 rows of every run are free.

The daily top 100 for 5 countries is $1.50 a run. A 90-day view history for 20 articles is $5.40, once.

## Typical uses

- **SEO and content teams**: topic demand with real absolute numbers; catch topics whose attention is climbing before search volume tools update.
- **Newsrooms and newsletters**: "what the world looked up this week" formats, per market, automated.
- **Traders and analysts**: attention spikes on companies, products, people and events as a signal input.
- **Brand and PR monitoring**: daily views on your company's article versus competitors.
- **Researchers**: clean per-country attention data with no API key paperwork.

## Scheduling

Run top mode daily with "Compare with previous run" on: rank history is kept per chart in a named key-value store, so every run reports movers, new entries and exact view counts. Consume rows via the API, webhooks, or the Google Sheets integration.

## Data notes

Data comes from the official Wikimedia pageviews API and counts human (user) traffic only, excluding known bots and spiders. Daily stats publish with roughly one day of lag; the actor automatically steps back to the newest published day when no date is given.
