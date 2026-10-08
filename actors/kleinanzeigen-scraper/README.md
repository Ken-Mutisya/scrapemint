# Kleinanzeigen Scraper: Listings, Prices & Sellers

Ads from **Kleinanzeigen.de** (formerly eBay Kleinanzeigen), Germany's largest classifieds site, as clean rows: title, **price and price type** (fixed, VB / negotiable, free), original price, **postcode and city**, posting date, description preview, shipping and direct-buy flags, PRO shop name, photo and URL. Turn on details for the **full description, attributes** (condition, type, size, brand...), all photos and the **seller profile**: name, private or commercial, active since, ads online and rating badges.

Paste a search URL from kleinanzeigen.de with any filters (category, city and radius, price, private or commercial, category attributes), or set keywords and a city here. Kleinanzeigen shows 1,250 ads per search; bigger searches are **split by price automatically**.

No API key, no login, no proxy. $0.001 per ad, no start fee.

## What you get per ad

- `adId`, `url`, `title`, `categoryId`
- `price`, `priceText`, `priceType` (fixed, negotiable, negotiable (no price), free), `originalPrice`
- `zip`, `city`
- `postedAt` (Berlin time), `postedAtText`
- `descriptionPreview`, `imageUrl`, `imageCount`
- `shippingAvailable`, `directBuy`, `isProSeller`, `proShopName`

With **Full description, attributes and seller** on:

- `description`: the full ad text
- `attributes`: e.g. Zustand (condition), Typ, Art, Größe, Marke, Farbe
- `features`, `images` (all photos, large), `shipping` (e.g. Nur Abholung, Versand möglich), `state`, `categoryName`
- `sellerName`, `sellerId`, `sellerType` (Privater Nutzer or Gewerblicher Nutzer), `isCommercialSeller`, `sellerActiveSince`, `sellerAdsOnline`, `sellerBadges` (e.g. TOP Zufriedenheit, Besonders zuverlässig)

## Example input

A search copied from the site, with its filters:

```json
{
  "searchUrls": ["https://www.kleinanzeigen.de/s-anbieter:privat/preis:100:500/berlin/fahrrad/k0l3331r10"]
}
```

iPhone 15 ads within 20 km of Berlin, with full details:

```json
{
  "queries": ["iphone 15"],
  "location": "Berlin",
  "radiusKm": 20,
  "includeDetails": true
}
```

Every PlayStation 5 ad in Germany from private sellers, up to 300 €:

```json
{
  "queries": ["playstation 5"],
  "sellerType": "privat",
  "maxPrice": 300,
  "maxItemsPerSearch": 5000
}
```

## Example output

```json
{
  "adId": "3535148567",
  "url": "https://www.kleinanzeigen.de/s-anzeige/panzerglas-fuer-iphone-12-13-14-und-15/3535148567-409-3388",
  "title": "Panzerglas für iPhone 12, 13 ,14 und 15",
  "priceText": "1.500 € VB",
  "priceType": "negotiable",
  "zip": "12353",
  "city": "Neukölln",
  "postedAt": "2026-10-09T00:05",
  "imageCount": 10,
  "shippingAvailable": false,
  "isProSeller": false,
  "attributes": { "Typ": "Schutzfolie", "Material": "Glas", "Zustand": "Neu" },
  "shipping": "Nur Abholung",
  "state": "Berlin",
  "sellerName": "Hüseyin",
  "sellerType": "Privater Nutzer",
  "sellerActiveSince": "23.02.2021",
  "categoryName": "Smartphone Zubehör"
}
```

## Uses

- **Resellers and flippers:** fresh underpriced ads for the products you buy, scheduled every few minutes with a small max
- **Price research:** asking prices for used goods by city, condition and model
- **Dealers and agencies:** cars, flats and services listed by private sellers in your area
- **Market and brand monitoring:** how many second-hand units of a product are on the market and at what price
- **Lead generation:** commercial sellers (PRO shops) by category and region

## Pricing

- **$0.001** per ad
- **$0.0025** per ad with Full description, attributes and seller on (instead of $0.001, not on top)
- No start fee. A search with no results is free.

## Notes

- Built searches use Kleinanzeigen's default order (newest first, with promoted ads on top). Promoted ads show no date, so `postedAt` is empty for them.
- When a search is split by price, ads without a price (VB with no amount) are left out, because Kleinanzeigen's price filter skips them. Searches under 1,250 ads are read whole.
- Split searches are read across all price ranges page by page, so a capped run is a spread of the newest ads, not only the cheapest.
- Phone numbers are behind Kleinanzeigen's login and are not included.
- An ad that shows up in two of your searches is kept once.
