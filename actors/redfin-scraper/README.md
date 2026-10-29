# Redfin Scraper: For Sale & Sold Homes, Price Changes

Scrape homes for sale and recently sold homes from Redfin. Paste any Redfin search URL with the filters you set on redfin.com, or give ZIP codes plus a listing type and price/bed filters, and get one row per home: price, status, sold date, beds, baths, square feet, price per square foot, lot size, HOA, year built, days on market, coordinates, listing remarks and open house. Turn on tracking to get price drops and status changes between scheduled runs.

Redfin shows at most 350 homes per search. This actor splits a bigger search into price bands automatically, so a whole city comes back: a test run returned all 2,329 Austin homes sold in the last 3 months, matching Redfin's own count.

## What you get

One row per home:

- `propertyId`, `listingId`, `url`, `mlsId`
- `status` (e.g. Active, Coming Soon, New, Closed), `isSold`, `price`, `priceType`, `soldDate`, `lastSoldDate`
- `address`, `city`, `state`, `zip`, `neighborhood`, `latitude`, `longitude`
- `propertyType` (House, Condo, Townhouse, Multi-family, Land, Manufactured, Co-op), `beds`, `baths`, `sqft`, `pricePerSqft`, `lotSizeSqft`, `yearBuilt`, `stories`, `garageSpaces`
- `hoaMonthly`, `daysOnMarket`, `daysOnRedfin`, `isNewConstruction`, `hasVirtualTour`, `openHouse`
- `badges` (e.g. Open House, Sold), `keyFacts`, `listingTags`, `listingRemarks`, `photoCount`
- With tracking on: `isNew`, `previousPrice`, `priceChange`, `previousStatus`, `firstSeen`

`priceType` tells you what `price` is: `list_price` for listings, `sold_price` for sales, or `last_list_price` for sales in non-disclosure states (Texas, Utah and others), where Redfin does not publish the sale price.

## Input

- `searchUrls`: any Redfin search results page, e.g. `https://www.redfin.com/city/30818/TX/Austin` or `https://www.redfin.com/city/30818/TX/Austin/filter/include=sold-3mo,min-beds=3`. Set filters on redfin.com, then copy the URL.
- `zipCodes`: 5-digit ZIP codes, used with `listingType` (for sale, or sold in the last week to 5 years), `minPrice`, `maxPrice`, `minBeds`.
- `splitLargeSearches`: get past the 350-home cap (on by default).
- `trackChanges`: remember each home's price and status between runs.
- `onlyChanges`: with tracking on, return only new homes and homes whose price or status changed.
- `maxHomes`: default 500, up to 20,000.

## Example input

```json
{
  "searchUrls": ["https://www.redfin.com/city/30818/TX/Austin/filter/include=sold-3mo"],
  "zipCodes": ["78704"],
  "listingType": "for_sale",
  "minPrice": 400000,
  "maxPrice": 900000,
  "minBeds": 3,
  "maxHomes": 3000
}
```

## Example output

```json
{
  "propertyId": 31796410,
  "url": "https://www.redfin.com/TX/Austin/10711-Pinkney-Ln-78739/home/31796410",
  "status": "Active",
  "price": 815000,
  "priceType": "list_price",
  "address": "10711 Pinkney Ln",
  "city": "Austin",
  "state": "TX",
  "zip": "78739",
  "propertyType": "House",
  "beds": 4,
  "baths": 2.5,
  "sqft": 2938,
  "pricePerSqft": 277,
  "lotSizeSqft": 9130,
  "yearBuilt": 1994,
  "hoaMonthly": 100,
  "daysOnMarket": 1,
  "latitude": 30.1893275,
  "longitude": -97.8883656,
  "openHouse": { "start": "2026-11-01T20:00:00.000Z", "end": "2026-11-01T22:00:00.000Z", "label": "Open House - 2:00 - 4:00 PM" },
  "keyFacts": ["Scenic trails", "Private oasis", "In ground pool"]
}
```

## Uses

- Comps: every home sold in an area in the last 3, 6 or 12 months, with $/sq ft and days on market
- Investor deal flow: schedule a daily run with `onlyChanges` to get new listings and price drops only
- Agent prospecting: expired-looking listings with long days on market, by ZIP
- Market reports: inventory, median $/sq ft and days on market per ZIP, refreshed on a schedule
- Lead lists for mortgage, insurance, moving and home services: new sales by ZIP

## Pricing

Pay per home row. In `onlyChanges` mode, homes that did not change are not returned and cost a tenth of a row each, which covers checking them. Searches that match nothing cost nothing.

## Notes

- Data comes from Redfin's public search pages: what a logged-out visitor sees. Homes Redfin hides from logged-out visitors are not included.
- Redfin's per-home detail pages (full price history, tax records, photos) are not read; every field above comes from the search results.
- A search URL must be a results page, not a single home's page.
- Name-only locations are not resolved. Copy the search URL from redfin.com, or use ZIP codes.
