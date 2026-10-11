# Vinted Scraper: Prices, Brands & Sellers

Second-hand listings from **Vinted**, on any of its 23 country sites (UK, France, Germany, Spain, Italy, Netherlands, Poland, US and more), as clean rows: title, **brand, size and condition**, **price, Vinted buyer fee and total price** in the site's currency, favourites, promoted flag, every photo and the seller id.

Turn on **Description and seller** and each item also gets the full description, category, colour, material, upload time and the **seller's name, review count and star rating**.

Search by keyword, or paste any Vinted catalog URL with your filters (brand, size, condition, colour, category, price). Vinted shows 960 items per search; bigger searches are **split by price automatically** so you can collect thousands.

No Vinted account, no API key, no proxy. $0.0008 per item, no start fee.

## What you get per item

- `itemId`, `url`, `title`, `brand`, `size`, `condition`
- `price`, `originalPrice` (when discounted), `buyerFee`, `totalPrice`, `currency`
- `favourites`, `isPromoted`, `sellerId`, `sellerIsBusiness`
- `imageUrl`, `imageUrls`, `site`

With **Description and seller** on:

- `description`, `category`, `color`, `material`, `uploaded` (e.g. "2 days ago"), `itemAttributes`
- `sellerName`, `sellerUrl`, `sellerReviews`, `sellerRating` (0-5)

## Example input

Nike jackets on Vinted UK, newest first:

```json
{
  "queries": ["nike jacket"],
  "country": "uk",
  "sortBy": "newest"
}
```

Up to 3,000 Adidas Samba listings on Vinted Germany with seller ratings:

```json
{
  "queries": ["adidas samba"],
  "country": "de",
  "includeDetails": true,
  "maxItemsPerSearch": 3000
}
```

A filtered catalog URL copied from vinted.fr:

```json
{
  "searchUrls": ["https://www.vinted.fr/catalog?search_text=levis%20501&brand_ids[]=10&status_ids[]=6"]
}
```

## Example output

```json
{
  "itemId": 10311603506,
  "url": "https://www.vinted.co.uk/items/10311603506-nike-windbreaker",
  "title": "Nike Windbreaker",
  "brand": "Nike",
  "size": "S / UK 8-10",
  "condition": "Very good",
  "price": 5.34,
  "buyerFee": 0.97,
  "totalPrice": 6.31,
  "currency": "GBP",
  "favourites": 10,
  "sellerId": 3193981306,
  "imageUrl": "https://images1.vinted.net/t/05_01ccb_cE8jYGpE5jctgihF7d6giZRy/f800/fbdbd231.webp?s=...",
  "description": "Size Small Nike Windbreaker jacket. Colour is Navy and light blue ...",
  "category": "Women Windbreakers",
  "color": "Navy",
  "uploaded": "a day ago",
  "sellerName": "angiemaya1",
  "sellerReviews": 2,
  "sellerRating": 5
}
```

## Uses

- **Resellers:** spot underpriced items and track what sells, by brand, size and condition
- **Brands:** monitor second-hand prices and volume of your products across European markets
- **Price research:** typical resale prices for any item, with buyer fees and totals
- **Market analysis:** listing volume and price spread by country site, on a schedule

## Pricing

- **$0.0008** per item
- **$0.002** per item with **Description and seller** on (charged instead of the $0.0008, not on top)
- No start fee. A search with no results is free.

## Notes

- Prices are in the site's own currency (GBP on .co.uk, EUR on .fr/.de/.es/..., PLN on .pl and so on).
- Past 960 results the search is read price band by price band, so your sort order applies within each band, not across the whole set.
- Brand, size and condition labels are in the site's language (e.g. "Sehr gut" on vinted.de).
- An item that appears in two of your searches is kept once.
