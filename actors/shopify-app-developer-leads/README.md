# Shopify App Store Developer Leads

Turn the Shopify App Store into a B2B lead list. Search by keyword and get, for every app, the developer's **public support email**, developer name and partner page, company website, app name, rating, review count, and pricing. One lead per app.

Shopify app developers are a captive market for tooling, agencies, and review/ASO services. The support email is published on the listing, so leads are reachable with no guessing and no API key.

## Who buys this

- **Tool and SDK vendors** selling to Shopify app developers.
- **Agencies** offering development, design, and ASO to app makers.
- **App review, localization, and marketing services.**

## How it works

1. It loads the App Store sitemap (all app handles) and name-matches your keywords, prioritising exact and prefix matches.
2. It opens each app page and extracts the developer support email, developer name, company website, rating, reviews, and pricing.
3. Each app is scored and tiered, then pushed as one lead.

## Output

One row per app:

```json
{
  "name": "Klaviyo: Email Marketing & SMS",
  "handle": "klaviyo-email-marketing",
  "url": "https://apps.shopify.com/klaviyo-email-marketing",
  "developerName": "Klaviyo",
  "partnerUrl": "https://apps.shopify.com/partners/klaviyo",
  "supportEmail": "support@klaviyo.com",
  "website": "https://klaviyo.com",
  "rating": 4.7,
  "reviewCount": 2915,
  "pricing": "Free to install",
  "tier": "qualified_lead"
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | App data, no public email or website | $0.01 |
| `lead` | A public support email or a company website | $0.02 |
| `qualified_lead` | A support email and reviews at or above the bar | $0.05 |

Discovery is the keyless sitemap and app pages are light HTML, so runs are fast and a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Terms matched against app handles. |
| `maxLeads` | `200` | Cap total leads per run. |
| `maxPerKeyword` | `80` | Apps per keyword (exact/prefix first). |
| `minReviews` | `0` | Drop apps below this review count. |
| `qualifiedMinReviews` | `10` | Review bar for the qualified_lead tier. |
| `requireEmail` | `false` | Only keep apps with a support email. |

## Notes

- Keywords match the app handle (URL slug), so use core terms (email, upsell, subscription) rather than long phrases.
- Respect the App Store terms and applicable outreach laws when contacting developers.
