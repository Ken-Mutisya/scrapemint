# Shopify Store Products Scraper: Full Catalog, Prices, Stock

Turn any Shopify store into structured product data. Give this Actor store domains and it returns the full catalog (or a single collection) as clean JSON rows: title, vendor, product type, tags, price range, live availability, every variant with SKU and price, image URLs, and created/updated timestamps. It reads Shopify's official public catalog endpoint, so there is no browser, no proxy, no API key, and no login.

Built for ecommerce operators watching competitors, dropshippers researching catalogs, agencies auditing clients, and anyone who needs Shopify product data on a schedule. Run it daily against the same stores and diff prices and stock.

## What you get

One row per product (or per variant with `oneRowPerVariant`), with:

- `title`, `handle`, `url`, `vendor`, `productType`, `tags`
- `priceMin` / `priceMax` and `available` (true if any variant is in stock)
- `variants` (id, title, SKU, price, compare-at price, availability, weight)
- `images` (URLs), `options` (sizes, colors)
- `publishedAt`, `createdAt`, `updatedAt`, `store`, `scrapedAt`

## Input

- `storeUrls` (domains or URLs, up to 100 stores per run)
- `collectionHandle` (optional: scrape one collection instead of the whole catalog)
- `maxProductsPerStore` (default 50, up to 5000)
- `oneRowPerVariant` (each size/color as its own row)
- `includeImages` (default true)

## Example input

```json
{
  "storeUrls": ["gymshark.com", "allbirds.com"],
  "maxProductsPerStore": 100,
  "oneRowPerVariant": false
}
```

## Example output

```json
{
  "store": "https://gymshark.com",
  "productId": 7523118678235,
  "title": "Blush Seamless Shorts",
  "handle": "blush-seamless-shorts",
  "url": "https://gymshark.com/products/blush-seamless-shorts",
  "vendor": "Gymshark",
  "productType": "Shorts",
  "tags": ["new-arrivals", "seamless"],
  "priceMin": 40.0,
  "priceMax": 40.0,
  "available": true,
  "variantCount": 5,
  "variants": [
    { "id": 42371, "title": "XS", "sku": "GS-BSS-XS", "price": 40.0, "compareAtPrice": null, "available": true }
  ],
  "images": ["https://cdn.shopify.com/s/files/1/blush-shorts.jpg"],
  "publishedAt": "2026-06-28T09:00:00-04:00"
}
```

## Uses

- Monitor competitor prices, markdowns, and stock daily with a scheduled run
- Spot a rival's new product launches the day they publish
- Research dropshipping niches: full catalogs with prices and vendors in one run
- Feed product data into repricing tools, dashboards, or spreadsheets
- Audit a client's catalog for missing SKUs, images, or tags

## Pricing

Pay per row. Stores that block or disable the catalog endpoint (a small minority) return no rows and cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Works on any store running Shopify, on any domain (the Actor detects the catalog endpoint, not the domain name).
- Reads the same public endpoint the store's own theme uses; inventory counts beyond in-stock/sold-out are not exposed there.
