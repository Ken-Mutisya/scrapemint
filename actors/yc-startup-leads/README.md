# Y Combinator Startup Lead Scraper

Turn the Y Combinator company directory into a B2B lead list. Filter by keyword, batch, industry, or hiring status and get, for every startup, the company, **website**, a **scraped contact email**, one-liner, industry, team size, location, batch, and hiring flag. One lead per startup.

YC startups are a premium target for B2B vendors, recruiters, and investors. The directory is keyless, and the contact email is scraped from the company website (99% of companies list one).

## Who buys this

- **B2B SaaS** selling to fast-growing startups early.
- **Recruiters and staffing** (use the hiring filter).
- **VCs and competitive intel** tracking batches and sectors.
- **Sales teams** building a curated, funded-company pipeline.

## How it works

1. It loads the YC company directory and filters by your keywords, batches, industries, hiring status, and team size.
2. It fetches each company website and scrapes a contact email.
3. Each startup is scored and tiered, then pushed as one lead.

## Output

One row per startup:

```json
{
  "name": "Acme AI",
  "ycUrl": "https://www.ycombinator.com/companies/acme-ai",
  "website": "https://acme.ai",
  "email": "founders@acme.ai",
  "oneLiner": "AI copilots for logistics",
  "industry": "B2B",
  "subindustry": "Engineering, Product and Design",
  "batch": "Summer 2026",
  "teamSize": 12,
  "location": "San Francisco, CA, USA",
  "tags": ["AI", "Logistics"],
  "isHiring": true,
  "topCompany": false,
  "launchedAt": "2026-04-01",
  "tier": "qualified_lead",
  "leadScore": 86
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Company data, no website | $0.02 |
| `lead` | A company website | $0.04 |
| `qualified_lead` | A scraped contact email and a team of 5+ or currently hiring | $0.08 |

The directory is keyless and the website scrape is light, so runs are fast.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Match name, one-liner, description, industry, tags. |
| `batches` | `[]` | Limit to YC batches (e.g. Summer 2026). |
| `industries` | `[]` | Match industry or subindustry. |
| `onlyHiring` | `false` | Keep only companies currently hiring. |
| `minTeamSize` | `0` | Drop companies below this team size. |
| `maxLeads` | `200` | Cap total leads per run. |
| `includeEmail` | `true` | Scrape company websites for a contact email. |
| `maxEmailLookups` | `100` | Cap how many top leads get the email scrape. |

## Notes

- The directory is a community-maintained mirror that auto-syncs from YC; the company website is present on ~99% of rows and the email is scraped from it (moderate hit rate).
- Respect applicable outreach laws when contacting companies.
