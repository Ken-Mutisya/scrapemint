# Flipkart Scraper: Prices, Ratings & Specs

Products from **Flipkart**, India's largest online store, for any search term, category or search URL: **price, MRP and discount**, **rating with the 1 to 5 star breakdown**, rating and review counts, key specs, stock state, Flipkart Assured, sponsored flag, category and images.

Turn on **Full specifications and seller** and every product also gets its complete specification table (often 50 to 100 rows), the **seller name and seller rating**, colour and return policy.

Pages through results the way the Flipkart site does, so you get page after page of real results, not page 1 repeated.

No Flipkart account, no API key, no proxy. $0.001 per product, no start fee.

## What you get per product

- `productId`, `listingId`, `url`, `title`, `name`, `brand`, `variant`
- `price`, `mrp`, `currency`, `discountPercent`
- `rating`, `ratingCount`, `reviewCount`, `ratingBreakdown` (count of 1, 2, 3, 4 and 5 star ratings)
- `keySpecs`, `inStock`, `availability`, `isFlipkartAssured`, `isSponsored`, `warranty`
- `category`, `subCategory`, `superCategory`, `vertical`
- `imageUrl`, `imageUrls`

With **Full specifications and seller** on:

- `specifications` (every row of the product's spec table, e.g. Display Size, Processor, Battery, Model Number)
- `seller`, `sellerRating`, `color`, `returnPolicy`, `metaDescription`

## Example input

Cheapest running shoes first:

```json
{
  "queries": ["running shoes"],
  "sortBy": "price_asc",
  "maxItemsPerSearch": 500
}
```

Phones with full specs and seller, no ads:

```json
{
  "queries": ["iphone 17", "samsung galaxy s25"],
  "includeDetails": true,
  "includeSponsored": false
}
```

A category or filtered search URL copied from flipkart.com:

```json
{
  "searchUrls": ["https://www.flipkart.com/mobiles/pr?sid=tyy,4io"]
}
```

## Example output

```json
{
  "productId": "MOBHQV9YCUG4ZQZK",
  "url": "https://www.flipkart.com/apple-iphone-17-black-256-gb/p/itmc61b40459dd98?pid=MOBHQV9YCUG4ZQZK",
  "title": "Apple iPhone 17 (Black, 256 GB)",
  "brand": "Apple",
  "price": 86999,
  "mrp": 99900,
  "currency": "INR",
  "discountPercent": 12,
  "rating": 4.6,
  "ratingCount": 28706,
  "reviewCount": 2057,
  "ratingBreakdown": { "1": 1102, "2": 258, "3": 707, "4": 3684, "5": 22955 },
  "keySpecs": ["256 GB ROM", "16.0 cm (6.3 inch) Super Retina XDR Display", "48MP + 48MP | 18MP Front Camera", "A19 Chip, 6 Core Processor Processor"],
  "inStock": true,
  "isFlipkartAssured": true,
  "isSponsored": false,
  "seller": "GRAHGOODS RETAIL",
  "sellerRating": 4.6,
  "color": "Black",
  "returnPolicy": "Returns are not permitted. We offer a 7 days replacement-only policy.",
  "specifications": { "Display Size": "16.0 cm (6.3 inch)", "Resolution": "2622 x 1206 Pixels", "Weight": "177 g" }
}
```

## Uses

- **Brands and sellers:** track your prices, discounts and ratings against competitors, daily with a schedule
- **Price monitoring:** MRP vs selling price and discount depth across a category
- **Market research:** which brands and specs win on ratings and review volume
- **Catalogue building:** full specification tables and images for comparison sites

## Pricing

- **$0.001** per product from search or category pages
- **$0.003** per product with **Full specifications and seller** on (charged instead of the $0.001, not on top)
- No start fee. A search with no results is free.

## Notes

- Prices are in Indian rupees as shown to a visitor without a delivery pincode.
- Flipkart mixes sponsored products into results; they carry `isSponsored: true`, and **Include sponsored products** off drops them.
- Products Flipkart shows as having no available listing have no price (`availability: NO_AVAILABLE_LISTING`).
- Some layouts show no seller at all; `seller` is then empty while specifications are filled.
- A product that appears in two of your searches is kept once.
