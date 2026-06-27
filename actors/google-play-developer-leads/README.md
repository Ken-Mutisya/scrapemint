# Google Play Developer Lead Scraper

Turn the Google Play store into a B2B lead list. Search by keyword or category and get, for every app, the **developer contact email** and website plus the developer name, app title, category, install band, rating, and monetization flags. One lead per app.

The developer contact email is published right on the Play listing, so every lead is reachable out of the box. No login, no API key, no email guessing.

## Who buys this

- **App monetization and SDK vendors** selling ads, analytics, payments, or attribution to app makers.
- **ASO and mobile-marketing agencies** prospecting app owners.
- **Ad networks and mediation platforms** building publisher pipelines.
- **Dev-service shops** (design, QA, localization) targeting active developers.

## How it works

1. It collects app IDs at volume: a search per keyword, the top-chart for each category (up to ~250 apps each), and optionally apps similar to the seeds found.
2. It opens each app's detail page and extracts the developer contact email, website, name, category, install band, rating, and whether the app shows ads or in-app purchases.
3. Each app is scored into a tier and pushed as one lead.

## Output

One row per app:

```json
{
  "appId": "com.zoho.invoice",
  "title": "Zoho Invoice - Invoice Maker",
  "url": "https://play.google.com/store/apps/details?id=com.zoho.invoice",
  "developerName": "Zoho Corporation",
  "developerId": "6811281457353247126",
  "developerUrl": "https://play.google.com/store/apps/dev?id=6811281457353247126",
  "developerEmail": "support@zohoinvoice.com",
  "developerWebsite": "https://www.zoho.com/invoice/",
  "category": "BUSINESS",
  "rating": 4.8,
  "installs": "1M+",
  "installsNumeric": 1000000,
  "containsAds": false,
  "inAppPurchases": true,
  "tier": "qualified_lead"
}
```

## Tiers and pricing

Pay per lead. The first 10 `qualified_lead` per run are free so you can validate output.

| Tier | Meaning | Price |
| --- | --- | --- |
| `listing` | App and developer data, no public email | $0.01 |
| `lead` | A developer contact email is published | $0.02 |
| `qualified_lead` | Developer email, a website, and installs at or above the bar | $0.05 |

Because everything is plain HTTP (no browser), runs are fast and cheap, so a single run can return thousands of leads.

## Input

| Field | Default | Notes |
| --- | --- | --- |
| `keywords` | `[]` | Search terms, one Play search each. |
| `categories` | `[]` | Play category IDs (BUSINESS, PRODUCTIVITY, FINANCE, etc.). |
| `country` / `language` | `us` / `en` | Store country (gl) and language (hl). |
| `collection` | `TOP_FREE` | Chart pulled per category: TOP_FREE, TOP_PAID, or GROSSING. |
| `expandSimilar` | `false` | Also pull apps similar to the seeds for more volume. |
| `maxApps` | `200` | Cap total apps per run. |
| `maxAppsPerQuery` | `60` | Cap apps per keyword or category (categories return up to ~250). |
| `requireEmail` | `false` | Only keep apps with a developer email. |
| `minInstalls` | `0` | Drop apps below this install count. |
| `qualifiedMinInstalls` | `10000` | Install bar for the qualified_lead tier. |
| `concurrency` | `10` | Pages fetched in parallel. |

## Good use cases

- Build a list of every invoicing or CRM app maker with a reachable email.
- Pull the top apps in a category and hand sales a clean publisher pipeline.
- Target established developers (high installs, website, email) for enterprise outreach.
