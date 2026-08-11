# Google Keyword Suggestions Scraper (Autocomplete)

Turn one seed keyword into hundreds of real search queries people type. This Actor fans a seed out through Google (or YouTube) autocomplete with a to z suffixes, question prefixes and preposition suffixes, dedupes everything, and returns one clean row per unique suggestion. No login, no API key, no browser.

## What you get

One row per unique suggestion, with:

- `suggestion` (the query people actually type)
- `seedKeyword`, `modifier` (which expansion found it: `base`, `letter:a`, `question:how`, `preposition:vs`, ...)
- `position` (rank within its autocomplete response)
- `wordCount`, `source` (`google` or `youtube`), `language`, `country`, `scrapedAt`

A single seed with default settings typically yields 200 to 400 unique suggestions.

## Input

- `keywords` (seed keywords, each expanded separately)
- `source` (Google Search or YouTube Search suggestions)
- `language`, `country` (e.g. `en` / `us`, `de` / `de`)
- `expandLetters`, `expandDigits`, `expandQuestions`, `expandPrepositions`
- `maxRowsPerKeyword`, `maxRows`

## Example input

```json
{
  "keywords": ["project management software", "crm"],
  "language": "en",
  "country": "us"
}
```

YouTube content research:

```json
{
  "keywords": ["sourdough bread"],
  "source": "youtube",
  "expandQuestions": true
}
```

## Uses

- Keyword research: long tail queries that keyword tools miss or charge for
- Content planning: the `question:` rows are ready made article and FAQ topics
- YouTube video research with `source: youtube`

## Pricing

Pay per row. The first 10 rows of every run are free so you can validate output before you scale up. A full default expansion of one seed costs about 20 to 40 cents.

## Notes

- Suggestions come from Google's public autocomplete endpoint, the same one the search box uses, so rows reflect what real users type right now in your chosen language and country.
- Requests are paced and the Actor stops early with results if the endpoint starts rate limiting, so a blocked run never spins compute.
- Autocomplete is a suggestion source, not a volume source; it does not include search volumes. Feed rows into Trends or your SEO tool for volumes.
- This Actor reads only public data and never logs in.
