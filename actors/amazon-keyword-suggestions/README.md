# Amazon Autocomplete Keyword Scraper: 20 Marketplaces

Turn a seed keyword into hundreds of long-tail Amazon search terms, taken straight from the Amazon search box. The actor queries Amazon's autocomplete for the seed, the seed plus every letter a-z, optional digits 0-9, intent prefixes (best, cheap, kids, women...) and suffixes (for, with, set, pack, replacement...), removes duplicates and returns one row per keyword in the order Amazon shows it to shoppers.

Works on 20 marketplaces: US, UK, Germany, France, Italy, Spain, Canada, Japan, Mexico, Australia, Brazil, Netherlands, UAE, Saudi Arabia, Sweden, Poland, Turkey, Singapore, Belgium and Egypt (India is listed too, but its endpoint is often unavailable). No login, no API key, no browser.

## Who uses it

- **Amazon sellers and agencies**: backend search terms, titles and bullet points built from what shoppers actually type
- **PPC managers**: long-tail exact and phrase match keywords for Sponsored Products campaigns
- **Product researchers**: see which variants, sizes, materials and audiences Amazon suggests for a niche
- **International sellers**: compare suggestions for the same seed across marketplaces before you launch

## What you get

One row per unique keyword:

- `keyword`: the suggestion, lowercased
- `seedKeyword`, `modifier` (base, letter:a, prefix:best, suffix:for...), `position` (1-10 in Amazon's list)
- `marketplace`, `amazonDomain`, `department`
- `wordCount`, `containsSeed`
- `searchUrl`: the Amazon search page for that keyword
- `scrapedAt`

## Example input

```json
{
  "keywords": ["yoga mat", "resistance bands"],
  "marketplaces": ["us", "uk", "de"],
  "expandLetters": true,
  "expandPrefixes": true,
  "maxRowsPerKeyword": 300
}
```

## Example output

```json
{
  "keyword": "yoga mat cleaner spray",
  "seedKeyword": "yoga mat",
  "marketplace": "us",
  "amazonDomain": "amazon.com",
  "department": "aps",
  "modifier": "letter:c",
  "position": 3,
  "wordCount": 4,
  "containsSeed": true,
  "searchUrl": "https://www.amazon.com/s?k=yoga%20mat%20cleaner%20spray"
}
```

## Pricing

Pay per keyword row. The first row of every run is free, and seeds that return nothing cost nothing. A full expansion of one seed (a-z + prefixes + suffixes) returned 350 unique keywords on amazon.com and 170 on amazon.de in testing.

## Tips

- Set `department` to narrow suggestions, e.g. `stripbooks` for books or `beauty` for cosmetics.
- Schedule a weekly run to catch new trending terms for your niche.
- Need Google or YouTube suggestions too? See [Google Keyword Suggestions Scraper](https://apify.com/scrapemint/google-keyword-suggestions-scraper).
