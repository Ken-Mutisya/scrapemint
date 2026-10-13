# Property Finder Scraper: UAE, Saudi & Gulf

Property listings from **Property Finder**, the leading portal in the **UAE, Saudi Arabia, Qatar, Bahrain and Egypt**, for sale and for rent: **price and price per sqft/sqm**, size and plot, bedrooms, bathrooms, furnishing, off-plan or ready, **community, sub-community and building**, **GPS coordinates**, amenities, the **agent and agency**, the listing's **phone and WhatsApp numbers**, permit number, photos and the full description.

Search by area (Dubai Marina, JVC, Riyadh, The Pearl...) with filters, or paste any Property Finder search URL. Property Finder lets you page to the end of every search.

No Property Finder account, no API key, no proxy. $0.0015 per listing, no start fee.

## What you get per listing

- `listingId`, `url`, `title`, `offeringType`, `propertyType`
- `price`, `currency`, `pricePeriod`, `pricePerArea`, `areaUnit`, `size`, `plotSize`
- `bedrooms`, `isStudio`, `bathrooms`, `furnished`, `completionStatus`, `amenities`
- `location`, `city`, `community`, `subCommunity`, `tower`, `latitude`, `longitude`
- `agentName`, `agentId`, `agentIsSuperAgent`, `agencyName`, `agencyId`, `agencyLogoUrl`
- `phone`, `whatsapp`, `email`, `reference`, `permitNumber`
- `listedAt`, `isVerified`, `isFeatured`, `isExclusive`, `isPriceDrop`, `isGreatValue`, `isDirectFromDeveloper`
- `photoCount`, `photos`, `videoUrl`, `description`

## Example input

2+ bedroom apartments to rent in Dubai Marina and JVC under AED 200,000 a year, cheapest first:

```json
{
  "locations": ["Dubai Marina", "Jumeirah Village Circle"],
  "operation": "rent",
  "propertyType": "apartment",
  "minBedrooms": 2,
  "maxPrice": 200000,
  "sortBy": "price_asc"
}
```

Newest villas for sale in Riyadh:

```json
{
  "country": "sa",
  "locations": ["Riyadh"],
  "propertyType": "villa",
  "sortBy": "newest",
  "maxItemsPerSearch": 1000
}
```

A search URL copied from the site:

```json
{
  "searchUrls": ["https://www.propertyfinder.ae/en/buy/dubai/apartments-for-sale-dubai-marina.html"]
}
```

## Example output

```json
{
  "listingId": "155509193",
  "url": "https://www.propertyfinder.ae/en/plp/buy/townhouse-for-sale-dubai-arabian-ranches-al-reem-al-reem-1-155509193.html",
  "title": "Full Lake View | Type 1E | Maids + Study",
  "propertyType": "Townhouse",
  "price": 7200000,
  "currency": "AED",
  "pricePerArea": 1920,
  "areaUnit": "sqft",
  "size": 3749,
  "bedrooms": 3,
  "bathrooms": 4,
  "furnished": false,
  "completionStatus": "completed",
  "location": "Al Reem 1, Al Reem, Arabian Ranches, Dubai",
  "city": "Dubai",
  "community": "Arabian Ranches",
  "latitude": 25.0597782,
  "longitude": 55.2948532,
  "agencyName": "Family Homes DXB",
  "phone": "+971586058899",
  "listedAt": "2026-10-07T06:22:58Z",
  "photoCount": 19,
  "description": "Family Homes DXB is delighted to offer this 3 Bedroom Townhouse ..."
}
```

## Uses

- **Investors and analysts:** price per sqft by community, yields (run buy and rent for the same area), price drops
- **Agencies and developers:** competitor stock, new listings daily with **Newest first** on a schedule
- **Lead generation:** agents and agencies active in an area, with phone and WhatsApp
- **Relocation and tenants:** every matching property with coordinates for mapping

## Pricing

- **$0.0015** per listing, description and phone numbers included
- No start fee. A search with no results is free.

## Notes

- Prices are in local currency (AED, SAR, QAR, BHD, EGP). For rentals the price follows the rent period you choose (yearly by default).
- Location names are matched with Property Finder's own location search; the best match is used and named in each row's `search` field.
- Some listing titles and descriptions are in Arabic, as written by the agent.
- A listing that appears in two of your searches is kept once.
