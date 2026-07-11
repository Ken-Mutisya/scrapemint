# Brand Mention Monitor: News, Reddit, HN & Telegram

Who is talking about your brand right now? This actor sweeps Google News, Reddit, Hacker News and any public Telegram channels you watch, in one run, and returns one row per mention. Run it on a schedule with the alert feed on and it remembers everything it has seen: each run emits **only new mentions**, so a quiet day pushes nothing and costs nothing. No login, no API keys, no subscription.

Mention monitoring tools charge $79 to $199 a month. A daily scheduled run here typically costs a few cents a day, and you only pay when there is actually something new.

## What you get

One row per new mention:

| Field | Description |
|---|---|
| `keyword` | Which of your keywords matched |
| `source` | `google-news`, `reddit`, `hackernews`, or `telegram` |
| `title` | Headline or post title (where the source has one) |
| `snippet` | Text excerpt for comments and messages |
| `url` | Direct link to the mention |
| `author` | Poster or commenter (where available) |
| `community` | Publisher, subreddit, story/comment, or channel |
| `publishedAt`, `foundAt` | When it was posted and when this run found it |

## Sources

- **Google News**: worldwide press coverage, any Google News language and country edition.
- **Reddit**: newest posts mentioning your phrase across all subreddits. Reddit occasionally rate-limits anonymous feeds; when that happens the source logs a warning and the other sources still deliver.
- **Hacker News**: stories and comments, via the Algolia search API. If your buyers are developers, this is where the sharpest opinions appear first.
- **Telegram channels**: public channels you choose to watch (competitors' channels, industry channels, niche news). Telegram has no public global search, so you supply the watchlist.

## Input

- **Keywords**: brand, product, founder name, competitor, ticker — each searched as an exact phrase.
- **Sources**: any combination of the four.
- **Telegram channels**: handles to watch when the Telegram source is on.
- **News language / country**: any Google News edition (e.g. `de` / `DE` for German coverage).
- **Only new mentions**: the alert-feed switch, on by default. Turn off for a one-time backfill.

## Pricing

Pay per result: **$0.005 per new mention**. First 2 rows of every run are free. With dedupe on you are never charged twice for the same mention, and runs that find nothing new cost nothing.

## Typical uses

- **Founders and SMBs**: know when your product gets covered, posted, or complained about, without a $99/month seat.
- **Agencies**: one scheduled run per client name, rows to a Google Sheet, done.
- **Devtool companies**: HN and Reddit mentions reach your Slack via a webhook minutes after they appear.
- **PR teams**: press pickup tracking across every Google News edition you care about.
- **Competitor watch**: put competitor names in the keyword list and their announcement channels in the Telegram watchlist.

## Scheduling

Schedule it hourly or daily with the alert feed on. Seen-mention memory lives in a named key-value store and survives between runs. Wire new rows to Slack, email, or Sheets with Apify integrations, or poll the dataset via API.

## Data notes

All sources are public pages and feeds; no accounts are used. Coverage begins when you start running the monitor (each source returns its most recent items, typically the last 25 to 100 per keyword).
