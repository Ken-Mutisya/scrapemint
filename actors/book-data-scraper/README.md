# Book Data Scraper: ISBN & Title Lookup

Look up books in bulk. Paste a list of **ISBNs** (from a barcode scanner, an inventory export, a spreadsheet) or **title and author searches**, and get one clean row per book: title, authors, first publish year, page count, publisher, subjects, languages, reader rating and a cover image URL.

Built for **used book sellers, online bookshops, libraries and reading app builders**. Scanned a box of books? Turn the ISBN list into ready-to-publish listing data — title, author, pages, cover — in one run, with no signup and no API key.

## What you get for each book

- **title** and **authors**
- **firstPublishYear**, **pages**, **publishers**, **editionCount**
- **subjects** and **languages**: for categorising your catalogue
- **rating** and **ratingsCount**: reader ratings out of 5
- **coverUrl**: a large cover image, ready for your listing or app
- **openLibraryUrl**: the book's page for reference

## Example output

```json
{
  "input": "9780140328721",
  "mode": "isbn",
  "found": true,
  "title": "Fantastic Mr Fox",
  "authors": ["Roald Dahl"],
  "firstPublishYear": 1970,
  "pages": 96,
  "publishers": ["Puffin"],
  "subjects": ["Foxes", "Fiction", "Juvenile fiction"],
  "rating": 4.16,
  "editionCount": 94,
  "coverUrl": "https://covers.openlibrary.org/b/id/6498519-L.jpg"
}
```

## ISBNs or searches?

- **ISBNs**: exact, one row per number. ISBN-10 and ISBN-13 both work, dashes and spaces are fine.
- **Searches**: free text like "atomic habits" or "things fall apart achebe". Set how many best matches you want per search (default 1).

## Pricing

**$0.002 per book found.** ISBNs and searches that match nothing are **free**, and the first 2 rows of every run are free. Enriching a 1,000 book inventory costs about $2, versus the monthly subscriptions of book seller tools.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~book-data-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isbns": ["9780140328721", "9780062316097"], "queries": ["atomic habits"]}'
```

## Frequently asked questions

**Where does the data come from?** Open Library, the Internet Archive's open catalogue of more than 40 million records. It is the same public dataset behind many library and book apps.

**Does it include prices or sales ranks?** No. Marketplace prices and ranks live behind retailer sites that block automated access; this tool covers the catalogue data (title, author, pages, cover) that listings need.

**An ISBN I scanned was not found.** Very new, very local or print-on-demand ISBNs are sometimes missing from the catalogue. Those rows are free and marked `found: false` so you can handle them separately.

**Can I use the cover images?** The cover URLs point to Open Library's public cover service, fine for catalogue and listing use.

## More tools from Scrapemint

- [Wikipedia Article Data](https://apify.com/scrapemint/wikipedia-article-data): facts and summaries for any topic in bulk.
- [Website Content Scraper](https://apify.com/scrapemint/website-content-scraper): clean text from any web page.
- [Shopify Store Products Scraper](https://apify.com/scrapemint/shopify-store-products-scraper): product data from any Shopify store.
