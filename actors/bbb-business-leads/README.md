# BBB Business Leads: Phones, Ratings & Accreditation

**Local business leads from the Better Business Bureau directory.** Give it business types (roofing, plumber, dentist, HVAC, auto repair...) and cities or ZIP codes across the **US and Canada**, and get one row per business:

- **Contact:** business name, phone numbers, street address, city, state, ZIP, coordinates
- **Trust signals:** BBB rating (A+ to F), rating score, **BBB accredited** status
- **What they do:** main category, all BBB categories, service areas
- **Links:** BBB profile and request-a-quote page

Filter to **accredited** or **A-rated** businesses to get the established, reputable ones first. For **local lead generation, home-services marketing, B2B sales and agencies** building prospect lists.

No account, no key, no proxy.

## What you get

`name`, `phone`, `phones`, `address`, `city`, `state`, `postalCode`, `country`, `category`, `categories`, `rating`, `ratingScore`, `accredited`, `isCharity`, `serviceAreas`, `bbbProfileUrl`, `requestQuoteUrl`, `latitude`, `longitude`, `logoUrl`, `localBbb`, `businessId`, `searchTerm`, `searchLocation`

## Example input

A-rated roofers in Austin and Manhattan:

```json
{
  "searchTerms": ["roofing"],
  "locations": ["Austin, TX", "10001"],
  "minRating": "A",
  "maxResults": 500
}
```

Accredited plumbers in Toronto, exact category only:

```json
{
  "searchTerms": ["plumber"],
  "locations": ["Toronto, ON"],
  "country": "CA",
  "accreditedOnly": true,
  "strictMatch": true
}
```

## Example output

```json
{
  "name": "Calixto Plumbing",
  "phone": "(512) 945-3143",
  "address": "8410 Georgian Dr # B",
  "city": "Austin",
  "state": "TX",
  "postalCode": "78753-6003",
  "country": "US",
  "category": "Plumber",
  "categories": ["Plumber", "Plumbing Renovation", "Commercial Plumber"],
  "rating": "A+",
  "ratingScore": 98.49,
  "accredited": true,
  "serviceAreas": ["Bell County, TX", "Burnet County, TX", "Lee County, TX"],
  "bbbProfileUrl": "https://www.bbb.org/us/tx/austin/profile/plumber/calixto-plumbing-0825-1000223803",
  "requestQuoteUrl": "https://www.bbb.org/central-texas/quote/request-calixto-plumbing-1000223803",
  "latitude": 30.3,
  "longitude": -97.76,
  "localBbb": "BBB Heart of Texas",
  "searchTerm": "plumber",
  "searchLocation": "Austin, TX"
}
```

## Uses

- **Home-services lead lists:** roofers, plumbers, HVAC, electricians and contractors by city, with phone and rating
- **Agencies:** prospect accredited local businesses that already invest in their reputation
- **Market sizing:** how many rated businesses work a category in each metro
- **Pair it with** [Google Maps Scraper](https://apify.com/scrapemint/google-maps-scraper) for websites and reviews, and [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper) for emails

## Pricing

- **$0.002** per business
- No start fee. A run that finds nothing is free.

500 businesses cost $1.00.

## Notes

- BBB returns up to 225 businesses (15 pages) per search term and location. Add more cities or ZIP codes for wider coverage; duplicates across searches are dropped.
- Results come from BBB's directory search, so there are no emails or websites. BBB profile pages are linked in `bbbProfileUrl`.
- BBB search also returns neighbouring trades (a roofing search brings some general contractors). Turn on `strictMatch` to keep only businesses whose name or categories contain the term.
- Businesses BBB marks as out of business are left out.
