# SEO Site Audit Scraper: On-Page Issues for Every Page

Run a technical SEO audit on any website and get one clean JSON row per page. Each row carries the on-page facts (title, meta description, H1s, canonical, robots directives, image alt coverage, word count, structured data, redirect chain, response time) plus a ready-made `issues` list, so you can filter straight to the problems. No browser, no API key, no seat license.

Built for SEO agencies and freelancers who deliver recurring audits, in-house teams watching their own sites, and anyone wiring SEO health into a dashboard. Put it on a weekly schedule per client site and diff the issues over time.

## What you get

One row per audited page, with:

- `title`, `titleLength`, `metaDescription`, `metaDescriptionLength`, `metaRobots`, `canonical`, `lang`
- `h1Count`, `firstH1`, `h2Count`, `wordCount`, `structuredDataBlocks`, `hasOgTitle`
- `imageCount`, `imagesMissingAlt`
- `httpStatus`, `redirectChain`, `redirectHops`, `responseMs`, `htmlBytes`
- `internalLinkCount`, `externalLinkCount`, `brokenLinks` (URL + status), `brokenLinkCount`
- `issues` — e.g. `missing_meta_description`, `title_too_long`, `duplicate_title`, `multiple_h1`, `noindex`, `redirect_chain`, `broken_internal_links`, `thin_content`, `images_missing_alt`
- `issueCount`, `depth`, `auditedAt`

Duplicate titles and meta descriptions are detected across the whole crawl, not per page.

## Input

- `startUrls` (pages to start from)
- `maxPages` (default 20, up to 1000)
- `maxDepth` (default 3)
- `includePatterns` / `excludePatterns` (URL substring filters)
- `checkBrokenLinks` (HEAD-check every discovered internal link once, default on)
- `useSitemap` (seed the crawl from sitemap.xml)

## Example input

```json
{
  "startUrls": ["https://example.com"],
  "maxPages": 100,
  "useSitemap": true,
  "checkBrokenLinks": true
}
```

## Example output

```json
{
  "url": "https://example.com/pricing",
  "httpStatus": 200,
  "redirectHops": 0,
  "title": "Pricing",
  "titleLength": 7,
  "metaDescription": null,
  "h1Count": 2,
  "wordCount": 96,
  "imagesMissingAlt": 4,
  "brokenLinkCount": 1,
  "brokenLinks": [{ "url": "https://example.com/old-plans", "status": 404 }],
  "issues": ["title_too_short", "missing_meta_description", "multiple_h1", "thin_content", "images_missing_alt", "broken_internal_links"],
  "issueCount": 6,
  "responseMs": 312
}
```

## Uses

- Weekly scheduled audit per client site; diff `issues` against last week and report changes
- Pre-launch checks: crawl staging, fail the deploy if `noindex` or broken links appear
- Content audits: find thin pages, missing metas, and duplicate titles at scale
- Feed an agency dashboard or a white-label report with structured rows instead of CSV exports
- Chain with the Website Tech Stack Detector and Website Contact Scraper on the same domains

## Pricing

Pay per audited page. Unreachable URLs and non-HTML responses are never pushed or charged, and the broken-link HEAD checks are free. The first 2 pages of every run are free so you can validate output before you scale up.

## Notes

- Plain HTTP fetching: server-rendered and statically generated sites (most marketing sites, blogs, docs, stores) audit accurately. Single-page apps that render everything client-side are out of scope.
- Redirects are followed manually so `redirectChain` shows every hop with its status code.
