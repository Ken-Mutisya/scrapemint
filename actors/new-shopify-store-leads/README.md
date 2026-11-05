# New Shopify Store Leads: Fresh Stores Daily with Emails

Get a list of Shopify stores that were launched in the last few days, often before they have made their first sale, and before every other agency, app developer and supplier finds them. Each run scans the domains registered yesterday (or up to 7 days back), finds the ones pointing at Shopify, and opens each store to pull its name, location, currency, product count, launch status and contact details.

About 1,500-2,000 new Shopify stores appear in each day's list. Filter them by country, currency, domain keyword or TLD, and schedule the actor daily with `dedupe` on to get only stores you have not seen before.

No login, no API key, no browser, no proxy.

## Who uses it

- **Shopify agencies and freelancers**: theme setup, store design, CRO and ads for owners who are still building
- **Shopify app developers**: reach merchants in their first week, when they are installing apps
- **Suppliers, dropshipping and print-on-demand services**: new stores need products
- **Payment, shipping, email marketing and review apps**: onboard merchants before they pick a competitor
- **Market researchers**: how many new stores launch per country, niche and currency

## What you get

One row per store:

- `domain`, `url`, `registeredOn` (the day the domain was registered)
- `storeName`, `description`, `homepageTitle`
- `city`, `region`, `country`, `currency` (from the store's own Shopify settings)
- `productsCount`, `collectionsCount`, `shipsToCountries`, `shipsToCountriesCount`
- `launched`: `false` while the store is still behind Shopify's password page
- `email` (best pick), `emails`, `phones`
- `socials`: Instagram, Facebook, TikTok, YouTube, X, Pinterest, LinkedIn when linked
- `hasMx`, `emailProvider` (google_workspace, microsoft_365, zoho...)
- `myshopifyDomain`, `shopifyShopId`, `shopPayInstallments`, `platform`

Emails come from the homepage, the store's contact-information policy page (where Shopify asks merchants to list their contact details) and the contact page.

## Input

- `daysBack`: 1-7 daily lists, newest first. Default 1.
- `countries`: store address country codes, e.g. `US`, `GB`, `CA`, `AU`.
- `keywords`: keep domains containing a word, e.g. `pet`, `coffee`, `skin`.
- `tlds`: e.g. `com`, `shop`, `store`.
- `currencies`: e.g. `USD`, `EUR`.
- `minProducts`: skip stores with fewer published products.
- `onlyLaunched`: skip stores still on the password page.
- `requireEmail`: only stores with an email.
- `platforms`: `shopify` (default). Add `woocommerce` or `bigcommerce` to also fingerprint up to `maxSitesToFingerprint` other new sites per run.
- `maxStores`: default 100.
- `dedupe`: skip stores returned in earlier runs.

## Example input

```json
{
  "daysBack": 2,
  "countries": ["US", "CA"],
  "minProducts": 5,
  "requireEmail": true,
  "maxStores": 200,
  "dedupe": true
}
```

## Example output

```json
{
  "domain": "corelinewellness.com",
  "url": "https://corelinewellness.com",
  "platform": "shopify",
  "storeName": "Coreline Wellness",
  "city": "Del Mar",
  "region": "California",
  "country": "US",
  "currency": "USD",
  "productsCount": 153,
  "launched": true,
  "email": "support@corelinewellness.com",
  "emailProvider": "google_workspace",
  "registeredOn": "2026-11-04"
}
```

## Pricing

Pay per store: a higher rate for stores with an email, a lower rate for the rest. Turn on `requireEmail` to pay only for reachable stores. The first 2 rows of every run are free, and runs that match nothing cost nothing.

## Notes

- New stores are found by their domain's DNS pointing to Shopify. Stores that only use a `.myshopify.com` address, or that moved an older domain to Shopify, are not in the daily registration list.
- Email coverage depends on what the merchant has published. In a test of 12 new US stores, 4 had an email. Stores still on the password page rarely have one yet.
- The daily domain list comes from whoisds.com's free newly registered domains feed, published one day behind.
- Need more than stores? [Newly Registered Domain Leads](https://apify.com/scrapemint/newly-registered-domain-leads) gives every new domain by keyword, and [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector) shows which apps a store runs.
