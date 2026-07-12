# Government Tender Finder: EU, UK & World Bank Contracts

Search live government tenders across three official procurement systems in one run and get one clean JSON row per tender: title, buyer organization, country, published date, submission deadline, estimated value, CPV categories, notice link, and the buyer contact email when published. Reads official public APIs (EU TED, UK Contracts Finder, World Bank): no key, no login, no browser.

Coverage is global: TED carries every above-threshold public tender from 27+ EU/EEA countries, Contracts Finder carries UK government contracts, and World Bank notices span development projects in 140+ countries across Africa, Asia, Latin America, and Eastern Europe. Built for any company that sells to governments: IT and software firms, construction and engineering, medical suppliers, consultants, logistics, training providers. Turn on cross-run dedupe, put it on a daily schedule, and each run returns only newly published tenders matching what you sell — the alert that tender portals charge $100 to $300 per month for.

## What you get

One row per tender, with:

- `source` (`eu-ted`, `uk-contracts-finder`, `world-bank`), `noticeId`
- `title`, `description` (plain text), `noticeType`
- `buyer`, `buyerCountry`, `country`
- `publishedDate`, `deadline` (submission deadline)
- `estimatedValue`, `currency`, `cpvCodes` (EU procurement categories)
- `projectId`, `projectName` (World Bank rows)
- `contactName`, `contactEmail`, `contactPhone` (when published)
- `url` (official notice page), `matchedKeyword`, `scrapedAt`

## Input

- `keywords` — what you sell; one search per keyword, merged and deduplicated
- `sources` — any of `ted`, `uk`, `worldbank` (default: all three)
- `countries` — ISO 3-letter codes for EU (DEU, FRA, ESP) or country names for World Bank (Kenya, Brazil, India); empty = everywhere
- `publishedWithinDays` — lookback window (default 14, up to 90)
- `activeOnly` — drop tenders whose deadline already passed (default on)
- `maxTenders` — cap on rows returned (default 25, up to 1000)
- `dedupe` — skip previously returned tenders; built for scheduled alerts

## Example input

```json
{
  "keywords": ["software development", "IT services"],
  "sources": ["ted", "worldbank"],
  "countries": ["DEU", "FRA", "Kenya"],
  "publishedWithinDays": 7,
  "maxTenders": 50,
  "dedupe": true
}
```

## Example output

```json
{
  "source": "world-bank",
  "noticeId": "OP00456175",
  "title": "Individual Consulting Services for IT Technician (Software Development)",
  "buyer": "Ministry of Economy",
  "country": "El Salvador",
  "publishedDate": "2026-07-10",
  "deadline": "2026-07-24",
  "noticeType": "Request for Expression of Interest / Individual Consultant Selection",
  "projectName": "Promoting Job Opportunities and Skills Development in El Salvador",
  "contactEmail": "procurement@economia.gob.sv",
  "url": "https://projects.worldbank.org/en/projects-operations/procurement-detail/OP00456175"
}
```

## Uses

- Daily new-tender alerts scoped to your keywords and countries, with dedupe so you only see what's new
- Bid pipelines: pull every open tender in your category closing in the next 30 days
- Bid consultancies: one scheduled run per client profile, rows straight into the client tracker
- Market entry research: see which governments buy what you sell, at what estimated values, before you invest in a region
- Outreach: buyer contact emails for clarification questions and expressions of interest

## Pricing

Pay per tender row. Searches that match nothing cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Sources are the official public APIs: TED (Tenders Electronic Daily, the EU's procurement journal), Contracts Finder (UK Cabinet Office), and the World Bank procurement notice database.
- EU rows are above-threshold tenders (roughly EUR 143k+ for services), which is where the serious contracts live. UK rows include lower-value contracts too.
- World Bank notices often include the buyer's direct email, which most paid tender portals strip out.
