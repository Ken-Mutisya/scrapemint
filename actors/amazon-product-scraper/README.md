# Amazon Product Scraper: Search, Best Sellers & ASINs

Products from **Amazon.com** and **Amazon.ca** as clean rows, from any **keyword search** (with sort and price filters), any **Best Sellers, New Releases, Movers & Shakers or Most Wished For** list, or a list of **ASINs**: price, list price, rating, review count, **"bought in past month"**, Best Seller and Amazon's Choice badges, sponsored and Prime flags, coupon, image and URL.

Turn on **Full product page** for brand, bullet points, the full **specs and details table**, **Best Sellers Rank** in every category, breadcrumb categories, availability, **seller and ships-from**, all images, variations and description.

Amazon shows about 7 pages per search; bigger searches are **split by price range automatically**.

No Amazon account, no API key, no proxy. $0.002 per product, no start fee.

## What you get per product

From search and list pages:

- `asin`, `url`, `title`, `imageUrl`, `position` (search) or `rank` (lists)
- `price`, `listPrice`, `currency`, `priceText`, `coupon`
- `rating`, `reviewsCount`, `boughtPastMonth` ("5K+ bought in past month")
- `badges` (Best Seller, Amazon's Choice, Overall Pick, Limited time deal), `isBestSeller`, `isAmazonsChoice`, `isSponsored`, `isPrime`
- `variationsCount`, `listCategory` and `listType` for lists

With **Full product page** on, also:

- `brand`, `savingsPercent`, `badge` ("#1 Best Seller in Home Office Desks")
- `availability`, `inStock`, `soldBy`, `shipsFrom`
- `categories` (breadcrumb), `bestSellersRank` (rank in each category)
- `features` (bullet points), `description`, `overview`, `details` (the full specs table: dimensions, weight, model, manufacturer, ISBN, publisher...)
- `images`, `mainImage`, `variationAsins`, `parentAsin`, `dateFirstAvailable`, `manufacturer`, `modelNumber`

## Example input

Standing desks, best sellers first, up to 200:

```json
{
  "searchQueries": ["standing desk"],
  "sort": "bestSellers",
  "maxItemsPerSearch": 200
}
```

The top 100 Best Sellers in Books, with full product pages:

```json
{
  "startUrls": ["https://www.amazon.com/gp/bestsellers/books"],
  "includeDetails": true
}
```

Specific products by ASIN on Amazon.ca:

```json
{
  "asins": ["B0B41YH9B6", "0593139135"],
  "marketplace": "CA"
}
```

## Example output

```json
{
  "asin": "B0B41YH9B6",
  "url": "https://www.amazon.com/dp/B0B41YH9B6",
  "title": "ErGear 48 X 24 Inch Height Adjustable Electric Standing Desk, Black",
  "price": 99.99,
  "listPrice": 119.99,
  "currency": "USD",
  "rating": 4.5,
  "reviewsCount": 5248,
  "boughtPastMonth": "5K+ bought in past month",
  "badges": ["Best Seller"],
  "isSponsored": false,
  "brand": "ErGear",
  "savingsPercent": 17,
  "badge": "#1 Best Seller in Home Office Desks",
  "availability": "In Stock",
  "soldBy": "Bestqi Ergonomic",
  "shipsFrom": "Amazon",
  "categories": ["Home & Kitchen", "Furniture", "Home Office Furniture", "Home Office Desks"],
  "bestSellersRank": [
    { "rank": 870, "category": "Home & Kitchen" },
    { "rank": 1, "category": "Home Office Desks" }
  ],
  "details": { "Item Weight": "43.8 pounds", "Model Number": "EGESD5B", "Lifting Mechanism": "Electric" }
}
```

## Uses

- **Amazon sellers and brands:** track your products' and competitors' prices, ratings, reviews and Best Sellers Rank daily
- **Product research:** what sells ("bought in past month"), at what price, in which category
- **Best Sellers monitoring:** the top 100 of any category, with rank changes over scheduled runs
- **Price monitoring and deal sites:** list price vs. current price, coupons and limited-time deals
- **Catalog and data teams:** full specs, images and categories by ASIN

## Pricing

- **$0.002** per product from a search or list
- **$0.004** per product with the full product page (instead of $0.002, not on top). ASINs and product URLs are always read from the product page.
- No start fee. A search with no results is free.

## Notes

- **Stores:** Amazon.com and Amazon.ca. Other Amazon stores (UK, Germany, France, India, Australia...) block requests without a paid proxy, so they are not offered.
- **Reviews text** needs an Amazon login and is not included; `rating` and `reviewsCount` are.
- Best Sellers pages show 50 products per page; the actor reads pages 1 and 2 (top 100). The last 20 of each page are filled from their product pages.
- Prices are for the default US (or Canada) delivery location; some sellers price by ZIP code.
- A product that shows up in two of your searches is kept once.
