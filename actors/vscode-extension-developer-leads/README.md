# VS Code Extension Developer Leads: Publisher Contacts

Turn the VS Code Marketplace into a targeted B2B lead list. Search extensions by keyword or category and get one JSON row per publisher: company or developer name, verified domain, website, GitHub repo, scraped contact emails, total installs across their matched extensions, and their top extensions with install counts. Keyless official Marketplace API plus a light website email scrape: no login, no browser, no data subscription.

Built for devtool, API, and cloud vendors selling to extension authors, AI coding tool companies, developer marketing and DevRel agencies, and recruiters sourcing engineers with proven shipped tools.

## What you get

One row per publisher, with:

- `publisher`, `publisherHandle`, `publisherId`, `domainVerified`
- `website`, `githubRepo`, `websiteReachable`, `marketplaceUrl`
- `email`, `emails`, `likelyContactEmails`, `mxFound`
- `extensionCount`, `totalInstalls`, `avgRating`
- `topExtensions` (name, installs, rating, last update, marketplace URL)
- `categories`, `matchedQueries`

## Input

- `keywords` (marketplace search terms, e.g. database, kubernetes, ai assistant)
- `categories` (official categories, e.g. AI, Programming Languages, Data Science, Testing)
- `minInstalls` (only publishers with at least this many total installs; use 10000+ for established companies)
- `maxPublishers` (default 50, up to 500)
- `includeEmail` (scrape each publisher's website for public contact emails)
- `maxEmailLookups` (cap on website fetches)
- `dedupe` (skip previously returned publishers; built for scheduled prospecting)

## Example input

```json
{
  "keywords": ["database", "sql"],
  "minInstalls": 10000,
  "maxPublishers": 100,
  "includeEmail": true
}
```

## Example output

```json
{
  "publisher": "Database Client",
  "publisherHandle": "cweijan",
  "domainVerified": true,
  "website": "https://database-client.com",
  "githubRepo": "https://github.com/database-client/jdbc-adapter-server",
  "email": "support@database-client.com",
  "emails": ["support@database-client.com"],
  "extensionCount": 3,
  "totalInstalls": 4210530,
  "avgRating": 4.7,
  "topExtensions": [
    { "name": "vscode-database-client2", "displayName": "Database Client", "installs": 3959207, "rating": 4.68, "url": "https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-database-client2" }
  ],
  "categories": ["Programming Languages", "Other"],
  "marketplaceUrl": "https://marketplace.visualstudio.com/publishers/cweijan"
}
```

## Uses

- Devtool and API vendors: every publisher shipping extensions in your category, ranked by installs, with a contact email
- AI coding tool companies: publishers of AI, Copilot-adjacent, and LLM extensions to partner with or acquire
- DevRel and developer marketing agencies: proven ecosystem builders segmented by category and traction
- Recruiters: developers with shipped tools and real install numbers, plus their GitHub
- Scheduled prospecting with `dedupe` on: only new publishers each run
- Chain `website` values into the Website Contact Scraper for deeper outreach data

## Pricing

Pay per publisher row: a higher rate for rows with a scraped contact email, a lower rate for the rest. Searches that match nothing cost nothing, and the first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from the official VS Code Marketplace gallery API. Install counts and ratings are aggregated across the publisher's extensions that matched your search, not their entire catalog.
- Emails are scraped from the publisher's own public website (verified domain first, then extension homepage links). GitHub-only publishers get the repo link but usually no email.
- `likelyContactEmails` adds standard patterns (info@, contact@, hello@, support@) on the publisher's domain; `mxFound` tells you the domain accepts mail.
- One publisher row can represent many extensions, so a 100-row run can cover several hundred extensions.
