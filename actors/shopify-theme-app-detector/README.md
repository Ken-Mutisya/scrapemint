# Shopify Theme & App Detector: Store Tech Lookup

Paste a list of store URLs and see, for each one, which Shopify theme it runs, which version, and which apps are installed: email and SMS, reviews, subscriptions, loyalty, upsells, search, support, payments, returns, analytics and ad pixels. Each row also has the store's name, country, currency and number of published products.

It reads what Shopify itself embeds in every storefront (the `Shopify.theme` object, the shop id and the app pixel config) plus each store's public `/meta.json`. No API key, no login, no browser.

## Who uses it

- **Shopify agencies and app makers**: build lead lists of stores on a given theme, or stores missing your category of app
- **Theme developers**: find stores on competing themes and outdated theme versions
- **Ecommerce analysts**: benchmark the stack of competing brands
- **Sales teams**: qualify a store list by apps, size (product count) and market (country, currency)

## What you get

One row per URL:

- `isShopify`, `storeName`, `myshopifyDomain`, `shopId`
- `themeName` (the underlying theme, e.g. `Dawn`, `Prestige`, or a custom build), `themeVersion`, `themeCustomName` (the merchant's label), `themeStoreId`, `isThemeStoreTheme`
- `apps`: `[{ name, category }]` from 85+ app signatures, plus `appNames` as one string and `appCount`
- `appPixelCount`, `customPixelCount` (tracking pixels registered through Shopify)
- `currency`, `locale`, `country`, `province`, `city`
- `publishedProductCount`, `publishedCollectionCount`, `description`

The run summary (key-value store record `SUMMARY`) lists the most common themes and apps across your list.

## Example input

```json
{
  "urls": ["allbirds.com", "gymshark.com", "kyliecosmetics.com"],
  "includeStoreDetails": true
}
```

## Example output

```json
{
  "domain": "kyliecosmetics.com",
  "isShopify": true,
  "storeName": "Kylie Cosmetics",
  "themeName": "KYLIE",
  "themeVersion": "438b6b9",
  "appNames": "Klaviyo, Attentive, Yotpo, Recharge, Nosto, Algolia, Afterpay, Klarna, Global-e, Google Tag Manager, OneTrust, Foursixty",
  "appCount": 12,
  "appPixelCount": 9,
  "country": "US",
  "currency": "USD",
  "publishedProductCount": 262
}
```

## Pricing

Pay per Shopify store detected. Sites that are not on Shopify, unreachable URLs and invalid inputs are free, and the first 2 stores of every run are free.

## Notes

- Apps are detected from the scripts and markers they put on the storefront. Apps that only work in the admin or at checkout leave no trace on the homepage and cannot be seen.
- Headless stores (custom frontends on the Shopify API) often hide the theme; they still show `isShopify` when Shopify markers are present.
- Need fresh Shopify stores to check? [New Shopify Store Leads](https://apify.com/scrapemint/new-shopify-store-leads) finds stores launched in the last days. For non-Shopify sites, use [Website Tech Stack Detector](https://apify.com/scrapemint/website-tech-stack-detector).
