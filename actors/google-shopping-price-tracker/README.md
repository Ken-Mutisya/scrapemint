# Google Shopping Scraper & Price Tracker: Prices, Sellers, Deals

**Google Shopping results as clean rows, with price changes since your last run.** Type a product the way you would on Google Shopping and get one row per offer:

- **The offer:** title, **price**, was-price and discount, currency
- **The seller:** merchant name, whether more stores carry it, delivery and returns terms
- **Social proof:** star rating and review count
- **Product data:** brand, image, Google's product cluster ID and offer IDs
- **Tracking:** `previousPrice`, `priceChange`, `priceChangePct`, `isNewListing` and `lastSeenAt`, per merchant, compared with your previous run

Schedule it daily with **Return only new listings and price changes** and it becomes a price-drop and new-seller alert: unchanged rows are skipped and not charged.

## What you get

`query`, `position`, `title`, `price`, `priceText`, `originalPrice`, `discountText`, `currency`, `merchant`, `moreMerchants`, `delivery`, `returns`, `rating`, `reviews`, `brand`, `image`, `productClusterId`, `offerId`, `productId`, `itemId`, `previousPrice`, `priceChange`, `priceChangePct`, `isNewListing`, `lastSeenAt`, `scrapedAt`

## Example input

Prices for two products, 80 offers each:

```json
{
  "queries": ["dyson v15", "nike pegasus 41"],
  "maxProductsPerQuery": 80
}
```

Daily MAP / reseller watch: only Walmart, Best Buy and Target, only changes:

```json
{
  "queries": ["sony wh-1000xm5"],
  "merchants": ["Walmart", "Best Buy", "Target"],
  "onlyChanges": true
}
```

UK prices between £50 and £300, no marketplaces:

```json
{
  "queries": ["air fryer"],
  "country": "gb",
  "minPrice": 50,
  "maxPrice": 300,
  "excludeMerchants": ["eBay", "Amazon Marketplace"]
}
```

## Example output

```json
{
  "query": "dyson v15",
  "position": 13,
  "title": "(NEW!) Dyson v15 Detect Submarine Wet-Dry Vacuum",
  "price": 647.99,
  "priceText": "$647.99",
  "originalPrice": null,
  "currency": "USD",
  "merchant": "Woot",
  "moreMerchants": false,
  "returns": "30-day returns",
  "rating": 4.3,
  "reviews": 6500,
  "brand": "Dyson",
  "productClusterId": "12524978193982557635",
  "offerId": "13430698839395041818",
  "previousPrice": null,
  "priceChange": null,
  "priceChangePct": null,
  "isNewListing": true,
  "lastSeenAt": null
}
```

On a later run, if that merchant's price has moved, the same row carries the change (illustrative numbers):

```json
{ "price": 599.99, "previousPrice": 647.99, "priceChange": -48, "priceChangePct": -7.41, "isNewListing": false, "lastSeenAt": "2026-10-25T17:21:13.270Z" }
```

## Uses

- **Price monitoring:** daily prices for your products and your competitors' across every store Google lists
- **MAP enforcement:** spot resellers advertising below minimum advertised price
- **Deal hunting and arbitrage:** biggest discounts and cheapest sellers per product
- **Market research:** which merchants, brands and price points dominate a category
- **Pair it with** [Shopify Price Monitor](https://apify.com/scrapemint/shopify-price-monitor) to watch individual stores directly

## Notes

- Google shows 40 products per page; more than 40 per search reads further pages.
- Price history is kept in a key-value store named `google-shopping-price-history` in your own account, per search and country.
- Merchant product URLs are not on Google's results page, so rows carry Google's product and offer IDs instead.

## Pricing

- **$0.002** per product row
- No start fee. Filtered-out rows, and unchanged rows when **only changes** is on, are free.
