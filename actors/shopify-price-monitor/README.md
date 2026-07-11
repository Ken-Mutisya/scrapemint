# Shopify Price & Stock Monitor: Change Alerts for Any Store

Competitor repricing, restocks, sellouts, and quiet catalog additions all happen in public — every Shopify store publishes its full catalog with variant prices and availability. This actor watches any list of Shopify stores and emits **one row per change**: price up or down (with exact percent), back in stock, out of stock, new product, removed product. No login, no API key, and **no proxy** — the data comes straight from each store's public catalog endpoint.

You pay per change, not per scan. A 5,000 product catalog where nothing moved costs you nothing. Competitive pricing tools charge $99+ a month to do this.

## What you get

One row per detected change:

| Field | Description |
|---|---|
| `changeType` | `price_increase`, `price_decrease`, `back_in_stock`, `out_of_stock`, `new_product`, `product_removed`, or a one-time free `baseline` |
| `store` | Which monitored store |
| `productTitle`, `productUrl`, `productId` | The product |
| `variantId`, `variantTitle`, `sku` | The exact variant (size, color, ...) |
| `oldPrice`, `newPrice`, `priceChangePercent` | For price moves |
| `oldAvailable`, `newAvailable` | For stock flips |
| `checkedAt` | Timestamp |

Prices are in each store's own currency, as published in its catalog.

## How it works

The first run per store saves a catalog snapshot and emits a single **free** baseline row. Every following run pages through the catalog (up to your product cap), diffs variant-level price and availability against the stored snapshot, and pushes only the differences. Snapshots live in a named key-value store and survive between runs.

## Input

- **Store URLs**: any Shopify storefronts (competitors, suppliers, brands you resell).
- **Change toggles**: prices, stock, new products, removed products — pick what you care about.
- **Minimum price change %**: ignore penny jitter, e.g. only report moves of 5% or more.
- **Max products per store / max rows per run**: scan depth and cost cap.

## Pricing

Pay per result: **$0.01 per change row**. Baselines are free, the first 2 change rows of every run are free, and unchanged catalogs cost nothing.

Watching 3 competitor stores daily typically costs a few cents a day. Even a heavy repricing day (100 changes) is $1.

## Typical uses

- **E-commerce brands**: know the morning a competitor drops prices, and by exactly how much, per variant.
- **Resellers and dropshippers**: restock alerts on supplier stores; `back_in_stock` rows straight to Slack via a webhook.
- **Agencies**: pricing intel feeds for retail clients without a Prisync seat per client.
- **Deal hunters and arbitrage**: `price_decrease` rows across a watchlist of stores.
- **Category research**: `new_product` rows show where a competitor is expanding.

## Scheduling

Run it daily (or hourly for fast-moving stores) on an Apify schedule. Wire rows to Slack, email, or Google Sheets with Apify integrations, or poll the dataset via API. Pair with the [Shopify Store Products Scraper](https://apify.com/scrapemint/shopify-store-products-scraper) when you need the full catalog rather than the changes.

## Data notes

Works on any store built on Shopify (the catalog endpoint is part of the platform). A small number of stores disable their public catalog; those are skipped with a warning and cost nothing. Catalog data reflects what the store publishes; flash-sale apps that bypass the catalog may not be visible.
