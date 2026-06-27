# Apple App Store Developer Leads

Turn the iOS App Store into a B2B lead list. Search by keyword and get, for every app, the seller, the **developer website**, a **scraped contact email**, category, rating, review count, and price. One lead per app.

iOS app developers are a captive market for app tools, ASO, and mobile marketing. Pair this with a Google Play scraper for full mobile coverage. Keyless, no API key.

## Who buys this

- **App-tool and SDK vendors** selling analytics, monetization, or testing to app makers.
- **ASO and mobile-marketing agencies** prospecting app owners.
- **Ad networks** building publisher pipelines.

## How it works

1. For each keyword it searches the iOS App Store via the keyless iTunes API, returning the seller, website, ratings, category, and price.
2. It fetches each seller website and scrapes a contact email.
3. Each app is scored and tiered, then pushed as one lead.

## Output

One row per app:

```json
{
  "name": "Invoice Simple: Invoice Maker",
  "seller": "Zenvoice Inc.",
  "website": "https://www.invoicesimple.com",
  "email": "support@invoicesimple.com",
  "category": "Business",
  "ratings": 122545,
  "rating": 4.8,
  "price": "Free",
  "lastUpdated": "2026-06-01T00:00:00Z",
  "appStoreUrl": "https://apps.apple.com/us/app/...",
  "tier": "qualified_lead",
  "leadScore": 90
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | App data, no developer website | $0.01 |
| `lead` | A developer website (every app with a seller URL) | $0.02 |
| `qualified_lead` | A scraped contact email and ratings at or above the bar | $0.05 |

The search is keyless and the website scrape is light, so runs are fast and a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | App topics, one search each. |
| `country` | `US` | Store country. |
| `maxLeads` | `200` | Cap total leads per run. |
| `maxPerKeyword` | `100` | Apps per keyword (up to 200). |
| `minRatings` | `0` | Drop apps below this rating count. |
| `qualifiedMinRatings` | `50` | Rating bar for the qualified_lead tier. |
| `includeEmail` | `true` | Scrape seller websites for a contact email. |
| `maxEmailLookups` | `80` | Cap how many top leads get the email scrape. |

## Notes

- Apple does not publish the developer email directly, so the website is always present and the email is scraped from it (moderate hit rate). Expect more `lead` than `qualified_lead` rows.
- Respect the App Store terms and applicable outreach laws when contacting developers.
