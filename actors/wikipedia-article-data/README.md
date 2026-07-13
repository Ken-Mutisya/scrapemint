# Wikipedia Article Data: Summary, Facts & Images

Pull clean, structured data from Wikipedia articles in bulk. Look up a list of article titles, or search by keyword, and get one tidy row per article instead of messy page HTML.

Built for **researchers, content and SEO teams, app builders and anyone building a knowledge base or AI dataset**. Wikipedia is one of the most visited sites in the world, but its pages are built for reading, not for data. This turns them into rows you can drop into a spreadsheet or database.

> Looking for view counts and trending topics instead? See our separate **Wikipedia Trends Scraper**. This actor is about article content and facts.

## What you get for each article

- **Summary**: the opening of the article as clean plain text
- **Short description**: the one line under the title
- **Main image**: a thumbnail URL
- **Map location**: latitude and longitude for places
- **Categories**: what the article is filed under
- **Language versions**: how many languages the article exists in
- **Wikidata ID**: to join with structured data
- **Page facts**: page link, page size and the last edit date
- **Found flag**: missing or misspelled titles are clearly marked

## Two ways to use it

1. **By title**: paste exact article names (Berlin, Marie Curie, Quantum computing).
2. **By keyword search**: type something like "electric cars" and get the top matching articles, fully expanded.

Pick any language edition (en, es, de, fr, ja and more).

## Example output

```json
{
  "title": "Berlin",
  "found": true,
  "pageId": 3354,
  "description": "Capital and largest city of Germany",
  "summary": "Berlin is the capital of Germany as well as its largest city...",
  "thumbnail": "https://upload.wikimedia.org/.../Berlin_Skyline.jpg",
  "latitude": 52.52,
  "longitude": 13.405,
  "categories": ["Capitals in Europe", "Port cities in Germany"],
  "languageCount": 268,
  "wikidataId": "Q64",
  "pageLengthBytes": 229903,
  "lastEdited": "2026-07-13T08:28:35Z",
  "url": "https://en.wikipedia.org/wiki/Berlin",
  "language": "en"
}
```

## Pricing

**$0.002 per article**, and titles that do not exist are **free**. The first 2 rows of every run are free. Pulling 1,000 articles costs about $2.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~wikipedia-article-data/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"titles": ["Berlin", "Marie Curie"], "language": "en"}'
```

Or by keyword:

```bash
  -d '{"search": "electric cars", "searchLimit": 50}'
```

## Frequently asked questions

**Where does the data come from?** The official MediaWiki API that Wikipedia itself runs. No scraping of page HTML, so the data is clean and stable.

**Can I get the full article text?** This returns the summary (the intro), which is what most uses need. The page link is included if you want the full article.

**Which languages work?** Any Wikipedia language edition. Set the language code and the titles or search run against that edition.

## More tools from Scrapemint

- [Wikipedia Trends Scraper](https://apify.com/scrapemint/wikipedia-trends-scraper): top and trending articles by country, with view counts.
- [Google News Scraper](https://apify.com/scrapemint/google-news-scraper): news headlines by topic.
- [arXiv Papers Scraper](https://apify.com/scrapemint/arxiv-papers-scraper): academic papers by topic and author.
