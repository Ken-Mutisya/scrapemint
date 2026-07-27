# Package Adoption Tracker: npm & PyPI Download Trends

Keyless **download data** for **npm** and **PyPI** packages. No API key, no account. Stars are vanity and easy to game; installs are what people actually do.

- **Trends** — per package: downloads in the last 7 days, the 7 days before that, the **growth percent** between them, the 30 day total and the daily average. Direction, not just size.
- **Discover** — search npm by keyword, take the highest ranked packages and rank them **by growth**. This answers "what is actually rising in the vector database space", which is a different question from "what has the most stars".
- **History** — the daily download series, one row per package per day, ready to chart.

## Who uses it

- **Engineering leads choosing a dependency** — you are picking something you will live with for years, and a library whose installs are falling is a maintenance problem waiting to happen.
- **VCs and analysts** — open source traction is a leading indicator, and download growth is the cleanest public measure of it.
- **Developer tool marketers** — track your own adoption against competitors, weekly, on a schedule.
- **Package maintainers** — see your own trend without wiring up analytics.

Pairs with our [GitHub Trending Scraper](https://apify.com/scrapemint/github-trending-scraper) for what is being starred and the [Hugging Face AI Models Scraper](https://apify.com/scrapemint/huggingface-ai-models-scraper) for model adoption.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `trends`, `discover`, or `history`. |
| `registry` | `npm` (all three modes) or `pypi` (trends only). |
| `packages` | Names to track. Scoped npm names like `@langchain/core` are handled. |
| `searchQuery` | What space to search, in discover mode. |
| `searchLimit` | How many top results to pull download data for. |
| `minWeeklyDownloads` | Drop abandoned and toy packages. |
| `includeMetadata` | Add version, license, repository and last publish date. |
| `maxRows` | Row cap per run. |

## Output

- **Trends and discover**: `packageName`, `registry`, `scoped`, `lastWeek`, `priorWeek`, `growthPercent`, `last30Days`, `averagePerDay`, `windowStart`, `windowEnd`, `url`, plus `searchScore` and `searchRank` in discover mode and `latestVersion`, `license`, `repository`, `lastPublishedAt`, `versionCount` when metadata is on.
- **History**: `packageName`, `day`, `downloads`.
- **PyPI trends**: `packageName`, `lastDay`, `lastWeek`, `lastMonth`, `url`.

## Notes on the data

- **Growth is measured against the registry's own returned days, not against today's date.** npm publishes with a lag of several days and the lag moves, so the series is sliced into its last 7 and prior 7 buckets from whatever window came back. `windowStart` and `windowEnd` tell you exactly what was compared.
- **npm bulk lookups reject scoped packages.** `@scope/name` is fetched individually and merged back in, so a mixed list works, it is just slightly slower per scoped name.
- **A misspelled npm package is not an error.** The registry returns a null value inside an otherwise successful response, so unknown names are logged and skipped rather than silently counted as zero.
- **PyPI is trends only.** It publishes no keyless search, and pypistats serves totals rather than a daily series, so PyPI rows carry no `growthPercent` and cannot be charted. It also rate limits hard, one package per request with spacing.
- Download counts include continuous integration and mirror traffic. They measure activity, not distinct humans, and that is true of every download figure anyone quotes.

## Pricing

Pay per event: **$0.003 per row**. The first 2 rows of every run are free.

Data sources: npm registry and downloads API, pypistats.org.
