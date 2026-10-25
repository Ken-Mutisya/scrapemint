# Amazon Best Sellers Scraper & Rank Tracker: Top 100

**Amazon.com's Best Sellers and Hot New Releases top 100 for any category, with what moved since your last run.** Pick departments or paste any subcategory list URL and get one row per ranked product:

- **The rank:** list, category, rank 1-100
- **The product:** ASIN, title, price, star rating, review count, image, product URL
- **Best Sellers Rank** and its category from the product page (for ranks Amazon does not render on the list)
- **Tracking:** `previousRank`, `rankChange` and `isNewEntry` versus your last run, plus a list of products that **dropped out** in the run summary

Schedule it daily to see what is climbing, what is new in the top 100 and what fell off, for product research, competitor watching or trend reports.

## What you get

`list`, `category`, `categoryUrl`, `rank`, `asin`, `title`, `price`, `priceText`, `rating`, `reviews`, `image`, `url`, `bestSellersRank`, `bestSellersRankCategory`, `previousRank`, `rankChange`, `isNewEntry`, `lastCheckedAt`, `scrapedAt`

## Example input

Best Sellers and New Releases top 100 in two departments:

```json
{
  "categories": ["kitchen", "electronics"],
  "lists": ["best-sellers", "new-releases"]
}
```

A subcategory, plus every subcategory one level below a department:

```json
{
  "categoryUrls": ["https://www.amazon.com/Best-Sellers-Kitchen-Dining-Bakeware/zgbs/kitchen/289668"],
  "categories": ["pet-supplies"],
  "includeSubcategories": true,
  "maxRank": 50
}
```

## Example output

```json
{
  "list": "new-releases",
  "category": "Electronics",
  "categoryUrl": "https://www.amazon.com/gp/new-releases/electronics",
  "rank": 46,
  "asin": "B0H87DRN2H",
  "title": "Anker Laptop Smart Display Charger, 100W Max USB C Charger for MacBook Pro",
  "price": 59.99,
  "priceText": "$59.99",
  "rating": 4.9,
  "reviews": 53,
  "image": "https://m.media-amazon.com/images/I/61NnIYEfXQL._AC_SL1500_.jpg",
  "url": "https://www.amazon.com/dp/B0H87DRN2H",
  "bestSellersRank": 42,
  "bestSellersRankCategory": "Computers & Accessories",
  "previousRank": 46,
  "rankChange": 0,
  "isNewEntry": false
}
```

## Uses

- **Product research for sellers:** what sells and what is newly hot in a niche
- **Brands and agencies:** daily rank of your products and competitors in their categories
- **Trend reports:** new entries and fast climbers across departments
- **Pair it with** [Amazon Seller Leads](https://apify.com/scrapemint/amazon-seller-leads) to find the third-party sellers behind the bestsellers

## Notes

- Department slugs: kitchen, electronics, beauty, toys-and-games, sporting-goods, pet-supplies, hpc (health), books, fashion, home-garden, baby-products, office-products, automotive, tools, grocery and more. For anything deeper, paste the list URL.
- Amazon renders details for about the first 30 ranks; **Fill details** reads product pages for the rest. A few rows can stay without a price if the product page shows none.
- Movers & Shakers, Most Wished For and Gift Ideas are not supported: Amazon loads those lists with a script.
- Rank history lives in a key-value store named `amazon-bestsellers-history` in your own account.

## Pricing

- **$0.0015** per ranked product (a full top 100 is $0.15)
- No start fee.
