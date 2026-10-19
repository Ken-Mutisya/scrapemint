# Crexi Scraper: Commercial Real Estate Listings & Brokers

**Commercial property for sale on Crexi, with the brokers behind each listing.** Search by state, property type, price and cap rate, and get one row per listing:

- **Deal:** asking price, cap rate, NOI, square footage, price per sq ft, status (on-market, auction), offers-due date
- **Property:** full address, coordinates, county, subtypes, year built, lot size, zoning, tenancy, ownership and the rest of Crexi's facts table
- **Story:** investment highlights and marketing description
- **Brokers:** name, brokerage, license numbers and states, brokerage website, number of active listings

Covers every type Crexi lists: **retail (NNN, Dollar General, gas stations), office, industrial, multifamily, land, mixed use, hospitality, self storage, mobile home parks, senior living, special purpose, businesses for sale and notes**. A **LoopNet alternative** for CRE investors, 1031 exchange buyers, brokers and lenders.

No login, no key, no proxy.

## What you get

`id`, `name`, `url`, `status`, `propertyTypes`, `subtypes`, `headline`, `askingPrice`, `capRatePct`, `noi`, `squareFootage`, `pricePerSqft`, `yearBuilt`, `lotSizeAcres`, `address`, `city`, `county`, `state`, `zip`, `fullAddress`, `latitude`, `longitude`, `brokerageName`, `listedAt`, `updatedAt`, `offersDueAt`, `opportunityZone`, `hasOfferingMemorandum`, `details`, `investmentHighlights`, `marketingDescription`, `brokers`, `brokerOfRecord`, `thumbnailUrl`

## Example input

Retail in Texas and Florida at a 7% cap rate or better:

```json
{
  "states": ["TX", "FL"],
  "propertyTypes": ["Retail"],
  "minCapRate": "7",
  "maxListings": 200
}
```

Newest Dollar General listings nationwide under $2M:

```json
{
  "searchTerm": "Dollar General",
  "maxPrice": 2000000,
  "sort": "newest"
}
```

## Example output

```json
{
  "id": 2755098,
  "name": "Gas Station & C-Store – 15 Year Absolute Net",
  "url": "https://www.crexi.com/properties/2755098/texas-gas-station-c-store-15-year-absolute-net",
  "status": "On-Market",
  "propertyTypes": ["Retail"],
  "subtypes": ["Convenience Store", "Gas Station"],
  "askingPrice": 7400000,
  "squareFootage": 7260,
  "pricePerSqft": 1019.28,
  "lotSizeAcres": 1.02,
  "fullAddress": "1960 Road West, Houston, TX 77090",
  "latitude": 30.0158272,
  "longitude": -95.4470037,
  "brokerageName": "CrownPoint Partners",
  "listedAt": "2026-10-19T20:43:07.487Z",
  "details": {
    "Asking Price": "$7,400,000",
    "Property Type": "Retail",
    "Sub Type": "Convenience Store, Gas Station",
    "Square Footage": "7,260",
    "Lot Size (acres)": "1.02",
    "Ground Lease": "No"
  },
  "investmentHighlights": "• Brand New 15 Year Absolute Net Lease\n• Attractive Annual 2% Rent Increases in Base Term and Options\n• Attractive Opportunity for 1031 Exchange Buyers...",
  "brokers": [
    {
      "name": "Julius Swolsky",
      "brokerage": "CrownPoint Partners",
      "brokerageCity": "West Palm Beach",
      "brokerageState": "FL",
      "licenses": ["CA 02074212"],
      "crexiProfileId": "juliuss",
      "activeListings": 831
    }
  ]
}
```

## Uses

- **Deal sourcing:** new listings that fit your buy box, every morning
- **1031 exchange:** NNN retail and single-tenant deals by cap rate and price
- **Broker prospecting:** who lists what, where, and how many active listings they carry
- **Market comps:** asking price per sq ft and cap rates by state and property type
- **Alerts:** schedule it daily with `"sort": "newest"` and send new rows to Slack or email

## Pricing

- **$0.002** per listing
- No start fee. A run that finds nothing is free.

1,000 listings with details and brokers cost $2.00.

## Notes

- Crexi returns up to 1,500 listings per search. Several states or types run as one search each, so `["TX", "FL", "CA"]` can reach 4,500. `maxListings` is split evenly across them.
- Some facts (occupancy, APN, tenancy) are hidden from logged-out users on some listings; those are left out rather than returned as asterisks.
- `capRatePct` comes from the listing facts or headline when the broker states one. The `minCapRate` filter uses Crexi's own cap-rate field.
- For sale listings only. Lease listings are not included.
