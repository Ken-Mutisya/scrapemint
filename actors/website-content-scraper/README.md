# Website Content Scraper: Clean Markdown for AI and RAG

Turn any website into LLM-ready data. Give this Actor one or more start URLs and it crawls the site breadth-first over plain HTTP, strips navigation, footers, scripts, and other boilerplate from every page, and returns one clean row per page as markdown, plain text, or trimmed HTML. No browser, no API key, no proxy needed for most sites.

Built for developers feeding RAG pipelines, chatbots, vector databases, and fine-tuning datasets, and for anyone who needs a site's content as structured rows instead of raw HTML. Point it at a docs site, a blog, a knowledge base, or a competitor's marketing pages and get back content you can embed or index directly.

## What you get

One row per crawled page, with:

- `content` (main page content as markdown by default; switch to plain text or cleaned HTML)
- `title`, `description` (meta), `lang`, `canonical`
- `url`, `finalUrl` (after redirects), `depth`, `wordCount`, `crawledAt`

Boilerplate is removed before extraction: scripts, styles, nav bars, headers, footers, sidebars, forms, and cookie banners. The main content region (`main`, `article`, or `role="main"`) is preferred when the page declares one.

## Input

- `startUrls` (pages to start from)
- `maxPages` (hard cap per run, default 20, up to 500)
- `maxDepth` (0 = start URLs only, default 2)
- `sameDomainOnly` (default true, subdomains included)
- `includePatterns` / `excludePatterns` (URL substring filters, e.g. only `/docs/`)
- `outputFormat` (`markdown`, `text`, or `html`)
- `useSitemap` (also seed the crawl from sitemap.xml)

## Example input

```json
{
  "startUrls": ["https://docs.apify.com/platform"],
  "maxPages": 20,
  "maxDepth": 2,
  "includePatterns": ["/platform"],
  "outputFormat": "markdown"
}
```

## Example output

```json
{
  "url": "https://docs.apify.com/platform/actors",
  "finalUrl": "https://docs.apify.com/platform/actors",
  "depth": 1,
  "title": "Actors | Platform | Apify Documentation",
  "description": "Learn how to develop, run and share serverless cloud programs.",
  "lang": "en",
  "format": "markdown",
  "content": "# Actors\n\nActors are serverless cloud programs that can do almost anything a human can do in a web browser...",
  "wordCount": 412,
  "crawledAt": "2026-07-05T20:00:00.000Z"
}
```

## Uses

- Feed a RAG pipeline or vector database with a docs site, help center, or blog
- Build fine-tuning or evaluation datasets from real site content
- Keep a chatbot's knowledge base in sync with your product docs on a schedule
- Monitor competitor marketing and docs pages as clean diffs instead of HTML soup
- Archive a site's content as structured, searchable rows

## Pricing

Pay per page. Only pages that return real content are pushed and charged; failed fetches, redirects to non-HTML, and empty pages cost nothing. The first 2 pages of every run are free so you can validate output before you scale up.

## Notes

- Plain HTTP fetching keeps runs fast and cheap. JavaScript-only sites (content rendered entirely client-side) are out of scope; most docs sites, blogs, and marketing sites work fine.
- The crawler identifies itself with a descriptive User-Agent and fetches politely with capped concurrency.
