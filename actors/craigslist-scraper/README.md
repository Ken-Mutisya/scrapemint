# Craigslist Scraper: Listings, Housing, Jobs & Cars

Listings from any Craigslist search in any city, as clean rows: **for sale, apartments and rooms, real estate, jobs, gigs, services, cars and trucks**. Paste a search URL from your browser with any filters you like, or pick an area, category and keywords here. Up to **10,000 listings per search**, well past the 360 a results page shows.

No API key, no login, no proxy. $0.0015 per listing, no start fee.

## What you get per listing

- `title`, `url`, `postingId`, `postedAt`
- `price`, `priceText`
- `category` (id, abbreviation, name)
- `area`, `subarea`, `location`, `neighborhood`, `latitude`, `longitude`
- Housing: `bedrooms`, `sqft`
- Jobs and gigs: `jobTitle`, `employer`, `compensation`
- `images`: photo links (600x450)

With **Full description and attributes** on:

- `description`: the full listing text
- `attributes`: rent period, condition, make and model, odometer, fuel, transmission, title status...
- `attributeFlags`: "2BR / 1Ba", "966ft2", "w/d in unit", "cats are OK - purrr", "no smoking"...
- `address` (street, when the poster gave one), `postedAtLocal`, `updatedAtLocal`

## Example input

A search copied from the site, with its filters:

```json
{
  "searchUrls": ["https://sfbay.craigslist.org/search/apa?max_price=3000&min_bedrooms=2"]
}
```

Used Honda Civics from 2015 on, by owner, in three cities, with full details:

```json
{
  "searchUrls": [
    "https://losangeles.craigslist.org/search/cto?auto_make_model=honda%20civic&min_auto_year=2015",
    "https://sfbay.craigslist.org/search/cto?auto_make_model=honda%20civic&min_auto_year=2015",
    "https://seattle.craigslist.org/search/cto?auto_make_model=honda%20civic&min_auto_year=2015"
  ],
  "includeDetails": true
}
```

Couches within 5 miles of a ZIP code, with photos:

```json
{
  "areas": ["newyork"],
  "category": "fua",
  "query": "couch",
  "postal": "11211",
  "searchDistance": 5,
  "hasPic": true
}
```

## Example output

```json
{
  "postingId": "7979788506",
  "title": "Spacious 2 Bed / 2 Bath Apartment! Washer & Dryer IN UNIT!",
  "url": "https://sfbay.craigslist.org/eby/apa/d/walnut-creek-spacious-bed-bath/7979765872.html",
  "price": 3039,
  "priceText": "$3,039",
  "postedAt": "2026-10-07T23:32:30.000Z",
  "category": { "id": 1, "abbr": "apa", "name": "apartments / housing for rent" },
  "area": "sfbay",
  "subarea": "eby",
  "location": "walnut creek",
  "latitude": 37.8862,
  "longitude": -122.0527,
  "bedrooms": 2,
  "sqft": 1079,
  "images": ["https://images.craigslist.org/00l0l_3tNm4M5t0vb_0kE0dL_600x450.jpg"]
}
```

## Uses

- **Rental and real-estate research:** asking rents by bedroom count and neighborhood, with coordinates for a map
- **Car dealers and flippers:** fresh by-owner listings for the makes and models you buy, scheduled hourly with Posted today
- **Resellers:** furniture, electronics and free stuff near a ZIP code
- **Recruiters and job boards:** job and gig posts with employer and pay
- **Lead generation:** services and gigs posts by area

## Pricing

- **$0.0015** per listing
- **$0.003** per listing with Full description and attributes on (instead of $0.0015, not on top)
- No start fee. A search with no results is free.

## Notes

- Like the site, a search includes nearby areas; each row's `area` shows where the listing was posted.
- Contact details (phone and email) are hidden behind Craigslist's reply button and are not included.
- Prices are in the area's currency (USD in the US).
