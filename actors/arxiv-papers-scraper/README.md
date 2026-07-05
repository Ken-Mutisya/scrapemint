# arXiv Papers Scraper: AI & Science Research Tracker

Track new research the moment it posts. Give this Actor keywords, arXiv categories (cs.AI, cs.LG, cs.CL, stat.ML, or any other), or author names and it returns one clean JSON row per paper: title, full abstract, authors, categories, submitted and updated dates, PDF link, DOI, and journal reference. It reads arXiv's official open API, so there is no key, no browser, no proxy, and no rate-limit games, ever.

Built for AI teams tracking specific topics, newsletter and content operators, analysts watching research trends, and RAG builders assembling paper corpora. Turn on cross-run dedupe, put it on a daily schedule, and each run returns only the papers you have not seen yet.

## What you get

One row per paper, with:

- `title`, `abstract` (full text), `authors`
- `primaryCategory`, `categories` (cross-lists included)
- `published`, `updated`, `doi`, `journalRef`, `comment` (venue/pages notes)
- `arxivId`, `url` (abstract page), `pdfUrl`

## Input

- `searchQueries` (keywords matched on title + abstract, OR-combined)
- `categories` (arXiv category codes, OR-combined; AND-ed with keywords)
- `authors` (optional author filter)
- `dateFrom` (only papers on/after this date)
- `sortBy` (newest submitted, recently updated, or relevance)
- `maxPapers` (default 25, up to 1000)
- `dedupe` (skip papers returned by previous runs; built for scheduled monitoring)

## Example input

```json
{
  "searchQueries": ["multi-agent", "tool use"],
  "categories": ["cs.AI", "cs.CL"],
  "dateFrom": "2026-07-01",
  "maxPapers": 50,
  "dedupe": true
}
```

## Example output

```json
{
  "arxivId": "2507.01234v1",
  "url": "https://arxiv.org/abs/2507.01234v1",
  "pdfUrl": "https://arxiv.org/pdf/2507.01234v1",
  "title": "Distributed Attacks in Persistent-State AI Control",
  "abstract": "We study control protocols for AI agents that maintain persistent state...",
  "authors": ["Jane Doe", "John Smith"],
  "primaryCategory": "cs.AI",
  "categories": ["cs.AI", "cs.CR"],
  "published": "2026-07-02T17:58:01Z",
  "updated": "2026-07-02T17:58:01Z",
  "doi": null,
  "journalRef": null
}
```

## Uses

- Daily digest of new papers in your niche, deduped, straight into Slack or a newsletter draft
- Track what a specific lab or author publishes
- Build topic-scoped paper corpora (abstracts included) for RAG and embeddings
- Watch research momentum on a technology before the market does
- Feed a literature review with structured rows instead of browser tabs

## Pricing

Pay per paper. Queries that match nothing cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Uses arXiv's official public API, which is intended for programmatic access. The Actor honors the API's politeness guidance (about one request every 3 seconds when paginating).
- arXiv covers physics, math, CS, biology, finance, statistics, EE, and economics; category codes are on arxiv.org/category_taxonomy.
