# Local Business Lead Pipeline

Turn a city plus business category into a ranked lead list. The pipeline chains a Google Maps search with website verification and DNS-level enrichment, then scores each business as **basic** or **enriched** so your outbound team only pays for what is usable.

## What you get per row

| Field | Description |
|---|---|
| `name`, `category`, `address`, `phone` | Core business identity from Google Maps |
| `rating`, `reviewCount` | Aggregate review signals |
| `recentNegativeReviewCount` | Out of the last 5 reviews, how many are 3 stars or below (when sentiment scraping is on) |
| `website` | Place website from Maps |
| `websiteReachable` | True when an HTTP HEAD to the site returns < 500 |
| `domain` | Root domain of the website |
| `mxFound` | True when the domain has a valid MX record (real mailbox infrastructure) |
| `likelyContactEmails` | Inferred `info@`, `contact@`, `hello@`, and any emails the Maps stage already extracted |
| `latitude`, `longitude`, `placeId`, `mapsUrl` | Geo and Maps identifiers for re-runs and CRM joins |
| `qualityTier` | `enriched` or `basic` based on your input rules |

## How qualification works

A row is **enriched** when ALL of the following hold:
- Rating is at or above `minRating` (default `4.0`)
- Review count is at or above `minReviews` (default `10`)
- Has a phone
- If `requireWebsite` is on (default): website is reachable AND domain has an MX record

Everything else that came back from Maps is returned as **basic**.

## Pricing

- `enriched_lead` $0.08 each. First 5 per run are free.
- `basic_lead` $0.03 each.

Apify auto-applies 20% margin. You see net.

### What you actually pay per lead

This actor chains the Google Maps Intelligence actor under the hood. Your run will show two line items on the Apify billing breakdown: one for the Maps stage and one for this pipeline.

| Quality tier | Maps stage | This pipeline | Total per lead |
|---|---|---|---|
| Basic | $0.02 | $0.03 | **$0.05** |
| Enriched | $0.02 | $0.08 | **$0.10** |

For comparison, intent-scored B2B leads run $1 to $5 per record on Apollo, Clay, and ZoomInfo. You are paying 10x to 50x less for a lead that already includes a verified MX and a phone.

## Two ways to scope a run

**Easy mode:** pass `cities` and `categories`. The pipeline cross-joins them into one Maps query per pair.

```json
{
  "cities": ["Austin TX", "Denver CO"],
  "categories": ["dentists", "medspas"]
}
```

The above runs 4 queries: `dentists in Austin TX`, `medspas in Austin TX`, `dentists in Denver CO`, `medspas in Denver CO`.

**Power mode:** pass raw `searchQueries`. Useful when you already have hand-tuned queries.

```json
{
  "searchQueries": ["plumber 78704", "hvac near Miami Beach"]
}
```

You can use both modes in the same run.

## Common use cases

- Agencies building local lead lists for client outreach
- B2B SaaS sellers prospecting SMBs by vertical
- Real estate scouts identifying business owners in a footprint
- Door-to-door route planning by category and rating

## Tips

- Start with `maxPlacesTotal: 50` to validate output and quality before scaling.
- Turn `requireWebsite` off when prospecting trades that often skip a web presence (mobile repair, in-home services). They will land as basic leads and cost less.
- `minReviews: 10` filters out fake or newly opened listings. Lower it only when you want fresh openings.

## Built on

- Google Maps Intelligence (sister actor) for search and place data
- DNS-level MX verification (no third-party API)
- Email pattern inference from canonical domain

PAY_PER_EVENT on the Apify BRONZE plan.
