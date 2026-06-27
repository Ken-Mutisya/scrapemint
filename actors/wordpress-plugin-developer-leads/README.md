# WordPress Plugin & Theme Developer Leads

Turn the WordPress.org directory into a B2B lead list. Search by keyword and get, for every plugin or theme, the **author**, the author's **company website**, **active installs**, rating, downloads, maintenance signals, and a **scraped contact email**. One lead per plugin or theme.

WordPress powers a huge share of the web, so its plugin and theme authors are a captive market for hosting, security, dev tools, and agencies. This actor reads the official keyless WordPress.org API, so the listing stage is fast and reliable, with no scraping or API key.

## Who buys this

- **WordPress hosting** prospecting plugin and theme authors and agencies.
- **Security, backup, and performance SaaS** selling to plugin developers.
- **Page builders, marketplaces, and dev-tool vendors** in the WP ecosystem.
- **Agencies** building partner and outreach lists.

## How it works

1. For each keyword it queries the WordPress.org plugin or theme directory, paginated (100 per page), and collects the listings.
2. It ranks them by active installs and, for the top leads, fetches the author's company website to scrape a contact email.
3. Each lead is scored and tiered, then pushed.

## Output

One row per plugin or theme:

```json
{
  "type": "plugin",
  "name": "Rank Math SEO",
  "slug": "seo-by-rank-math",
  "wpDirUrl": "https://wordpress.org/plugins/seo-by-rank-math/",
  "tier": "qualified_lead",
  "leadScore": 88,
  "author": "Rank Math SEO",
  "authorProfile": "https://profiles.wordpress.org/rankmath/",
  "website": "https://rankmath.com/",
  "websiteReachable": true,
  "emails": ["support@rankmath.com"],
  "likelyContactEmails": ["info@rankmath.com", "contact@rankmath.com"],
  "activeInstalls": 4000000,
  "downloaded": 184015809,
  "rating": 96,
  "numRatings": 6500,
  "supportThreads": 60,
  "supportResolved": 58,
  "lastUpdated": "2026-06-10 8:09am GMT"
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | Plugin/theme data, no company website | $0.01 |
| `lead` | Author plus a company website | $0.02 |
| `qualified_lead` | A scraped contact email and installs at or above the bar | $0.05 |

The directory stage is a keyless JSON API, so runs are fast and cheap, and a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Search terms, one query each. |
| `type` | `plugins` | plugins, themes, or both. |
| `browse` | `(none)` | Pull popular / new / updated instead of keywords. |
| `maxLeads` | `200` | Cap total leads per run. |
| `maxPerKeyword` | `100` | Cap per keyword (paginated). |
| `minInstalls` | `0` | Drop plugins below this install count. |
| `qualifiedMinInstalls` | `1000` | Install bar for the qualified_lead tier. |
| `includeEmail` | `true` | Scrape company websites for a contact email. |
| `maxEmailLookups` | `60` | Cap how many top leads get the email scrape. |

## Good use cases

- Build a list of every SEO or backup plugin author with a reachable email.
- Target established plugin developers (high installs, active maintenance) for partnerships.
- Pull the most popular plugins in a niche and hand sales a clean pipeline.
