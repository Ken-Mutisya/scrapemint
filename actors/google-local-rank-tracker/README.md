# Google Local Rank Tracker: Map Pack Rankings & Competitors

**Where does your business rank in Google's local results, keyword by keyword and place by place?** Give it the searches your customers make, the cities or ZIP codes you serve and your business name, and get one row per keyword and location:

- **Your rank** in Google's local finder (the list behind the map pack), and whether you are **in the map pack** (top 3)
- **Rank change** since your last run
- **Your listing:** rating, review count, category, address, phone and hours as Google shows them
- **Every competitor checked (20, 40 or 60):** name, rating, reviews, category, years in business, address, phone, hours, a review snippet, and Google's CID and Maps link
- **Top competitor** for that keyword and place

Use ZIP codes as locations to build a simple **geo-grid**: one check per ZIP shows where you are strong and where competitors take over.

## What you get

Per check: `keyword`, `location`, `query`, `yourRank`, `inMapPack`, `yourListing`, `resultsChecked`, `topCompetitor`, `results`, `previousRank`, `rankChange`, `lastCheckedAt`, `country`, `checkedAt`

Per business in `results`: `position`, `name`, `rating`, `reviews`, `category`, `priceLevel`, `yearsInBusiness`, `area`, `address`, `phone`, `hours`, `reviewSnippet`, `hasWebsite`, `sponsored`, `cid`, `placeId`, `mapsUrl`

## Example input

A plumber tracking two keywords across a city and two ZIP codes:

```json
{
  "keywords": ["plumber", "water heater repair"],
  "locations": ["Austin, TX", "78744", "78759"],
  "yourBusiness": ["Reliant Plumbing"],
  "depth": 40
}
```

Just your rank, no competitor list (cheaper, stops at the page your listing is on):

```json
{
  "keywords": ["dentist", "emergency dentist"],
  "locations": ["Denver, CO"],
  "yourBusiness": ["(303) 555-0100"],
  "includeResults": false
}
```

## Example output

```json
{
  "keyword": "plumber",
  "location": "Austin, TX",
  "query": "plumber Austin, TX",
  "yourRank": 2,
  "inMapPack": true,
  "resultsChecked": 40,
  "previousRank": 2,
  "rankChange": 0,
  "results": [
    {
      "position": 26,
      "name": "Plumbing Outfitters",
      "rating": 4.9,
      "reviews": 449,
      "category": "Plumber",
      "yearsInBusiness": "3+ years in business",
      "area": "Austin, TX",
      "address": "8329 N Mopac Expy Suite 153, Austin, TX 78759",
      "phone": "(512) 309-5406",
      "hours": "Open · Closes 4 PM",
      "reviewSnippet": "He finished in a timely manner and did a great job on the new water heater.",
      "hasWebsite": true,
      "cid": "17203130384750838411",
      "mapsUrl": "https://maps.google.com/?cid=17203130384750838411"
    }
  ]
}
```

## Uses

- **Local SEO agencies:** weekly rank reports per client, keyword and service area
- **Multi-location businesses:** compare every branch's visibility across ZIP codes
- **Competitor research:** who outranks you, with how many reviews and what rating
- **Lead generation:** local businesses in any category with phone and address
- **Pair it with** [Google Maps Scraper](https://apify.com/scrapemint/google-maps-scraper) for full place details and reviews

## Notes

- Your business is matched by name (any part of it, case-insensitive), phone number or Google CID. Add several values for multiple brands or branches.
- Google personalises local results by location, so results reflect the place in the query, not a GPS point.
- Rank history lives in a key-value store named `local-rank-tracker-history` in your own account.

## Pricing

- **$0.008** per keyword and location, for each 20 results read (depth 20 = $0.008, depth 60 = $0.024)
- No start fee. Pages that cannot be fetched are free.
