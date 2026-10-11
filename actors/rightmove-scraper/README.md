# Rightmove Scraper: UK Property for Sale & Rent

UK property from **Rightmove**, for sale and to rent: **price** (and rent frequency), price qualifier, bedrooms, bathrooms, property type, size, tenure, **address and GPS coordinates**, summary, **key features**, first listed and last updated dates (with "reduced" flags), the **agent, branch and phone number**, and photos.

Turn on **Full description and property details** and each property also gets the full description, **floor area in sq ft and m²**, **full postcode**, **lease years remaining**, **service charge and ground rent**, **council tax band**, **nearest stations**, parking, garden, heating, broadband, floorplans and the EPC.

Search by town, area or postcode district with Rightmove's filters, or paste any Rightmove search URL. Rightmove shows about 1,000 properties per search; bigger searches are **split by price automatically**.

No Rightmove account, no API key, no proxy. $0.001 per property, no start fee.

## What you get per property

- `propertyId`, `url`, `transactionType`
- `price`, `priceFrequency`, `displayPrice`, `priceQualifier`, `currency`
- `bedrooms`, `bathrooms`, `propertyType`, `description`, `displaySize`, `tenure`
- `address`, `latitude`, `longitude`, `summary`, `keyFeatures`
- `addedOrReduced`, `firstListedAt`, `updatedAt`, `lastUpdateReason`, `letAvailableDate`, `status`
- `agentName`, `agentBranch`, `agentPhone`, `agentBranchId`, `agentUrl`
- `isAuction`, `isNewHome`, `isFeatured`, `photoCount`, `floorplanCount`, `hasVirtualTour`, `photos`

With **Full description and property details** on:

- `fullDescription`, `sizeSqFt`, `sizeSqM`, `pricePerSqFt`, `postcode`, `outcode`
- `leaseYearsRemaining`, `annualServiceCharge`, `annualGroundRent`, `councilTaxBand`, `councilTaxExempt`
- `nearestStations`, `heating`, `parking`, `garden`, `broadband`, `accessibility`
- `floorplans`, `epcUrls`, `agentAddress`, `agentCompany`

## Example input

Everything for sale in Manchester, newest first, up to 3,000:

```json
{
  "locations": ["Manchester"],
  "sortBy": "newest",
  "maxItemsPerSearch": 3000
}
```

2-3 bed flats and terraces to rent in Bristol under £2,000 pcm with a garden, full details:

```json
{
  "locations": ["Bristol"],
  "operation": "rent",
  "maxPrice": 2000,
  "minBedrooms": 2,
  "maxBedrooms": 3,
  "propertyTypes": ["flat", "terraced"],
  "mustHave": ["garden"],
  "includeDetails": true
}
```

New listings in the last 24 hours within 5 miles of Clapham (schedule daily):

```json
{
  "locations": ["Clapham"],
  "radiusMiles": "5.0",
  "addedWithinDays": "1"
}
```

## Example output

```json
{
  "propertyId": 171974612,
  "url": "https://www.rightmove.co.uk/properties/171974612",
  "price": 700000,
  "displayPrice": "£700,000",
  "bedrooms": 2,
  "bathrooms": 2,
  "propertyType": "Apartment",
  "displaySize": "818 sq. ft.",
  "tenure": "LEASEHOLD",
  "address": "Landmark West, Canary Wharf, E14",
  "latitude": 51.502914,
  "longitude": -0.025234,
  "keyFeatures": ["Spacious two-bedroom apartment", "Large private balcony", "Secure underground parking"],
  "addedOrReduced": "Reduced on 01/08/2026",
  "firstListedAt": "2026-02-07T07:28:44Z",
  "agentName": "Romans & Partners",
  "agentPhone": "020 3917 4650",
  "postcode": "E14 9AL",
  "sizeSqM": 76,
  "leaseYearsRemaining": 982,
  "annualServiceCharge": 7600,
  "annualGroundRent": 750,
  "nearestStations": [{ "name": "Heron Quays Station", "types": ["LIGHT_RAILWAY"], "distanceMiles": 0.16 }]
}
```

## Uses

- **Investors:** price per sq ft, reductions, service charges and lease lengths across an area
- **Estate agents:** competitor stock and new instructions every day, with branch phone numbers
- **Proptech and analysts:** UK listing data with coordinates and postcodes for mapping and models
- **Tenants and buyers:** every property that matches, with the details that matter

## Pricing

- **$0.001** per property from search results
- **$0.003** per property with **Full description and property details** on (charged instead of the $0.001, not on top)
- No start fee. A search with no results is free.

## Notes

- Past about 1,000 results a search is read price band by price band, so your sort order applies within each band.
- Locations are matched with Rightmove's own place search (the first match is used and named in each row's `search` field). For drawn areas, paste the search URL.
- Rent prices are as Rightmove shows them (usually per calendar month, see `priceFrequency`).
- A property that appears in two of your searches is kept once.
