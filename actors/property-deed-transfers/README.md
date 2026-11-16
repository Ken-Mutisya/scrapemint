# Property Deed Transfers: NYC, Philadelphia, Cook County

Get recorded property sales straight from official county records in **New York City** (ACRIS, all five boroughs), **Philadelphia** and **Cook County** (Chicago and suburbs). Each row has the **buyer and seller names, sale price, recording date, property address, parcel ID** and, where published, the **buyer's mailing address** (NYC).

Filter by price, buyer keyword (LLC, TRUST, PROPERTIES for investor buyers) and ZIP. Data comes from each county's open-data portal. No API key, no login, no paid property-data subscription.

## Who uses it

- **Real estate investors and wholesalers**: see which LLCs and investors are buying, where and for how much
- **New-homeowner marketing**: movers, contractors, insurance, security, solar, furniture and home services
- **Mortgage and refinance lenders**: new owners and their purchase prices
- **Appraisers, agents and analysts**: recent comparable sales by neighborhood
- **Journalists and researchers**: who is buying up a neighborhood

## What you get

One row per recorded deed:

- `county`, `countyLabel`, `documentId`, `documentType`, `recordedDate`, `documentDate`
- `price`, `percentTransferred` (NYC), `cashConsideration` (Philadelphia)
- `address`, `unit`, `city`, `state`, `zip`, `parcelId`, `propertyType`, `parcelCount`
- `buyers`, `sellers` (all names on the deed)
- NYC: `buyerMailingAddress`, `buyerMailingCity`, `buyerMailingState`, `buyerMailingZip`, `sellerMailingAddress` from the deed
- Cook: `taxBillName` and `taxBillMailingAddress` / city / state / zip from the assessor (may still show the seller until the assessor updates it)
- `documentUrl` to the official record, `dataThrough` (newest record the county has published)

## Example input

LLC and trust buyers in Cook County and NYC, sales over $300,000 in the last 30 days of records:

```json
{
  "counties": ["cook", "nyc"],
  "daysOfRecords": 30,
  "minPrice": 300000,
  "buyerKeywords": ["LLC", "TRUST", "PROPERTIES"]
}
```

## Example output

```json
{
  "county": "cook",
  "countyLabel": "Cook County, IL",
  "documentId": "2625824659",
  "documentType": "Warranty Deed",
  "recordedDate": "2026-09-14",
  "price": 295000,
  "address": "...",
  "city": "...",
  "zip": "...",
  "parcelId": "31333050020000",
  "buyers": ["LAWANDA HOLMES WILLIAMS"],
  "sellers": ["DUWARN V. PORTER"],
  "documentUrl": "https://www.cookcountyassessor.com/pin/31333050020000"
}
```

## Pricing

Pay per deed row. The first row of every run is free.

## Notes

- **Counties publish with a lag**: NYC ACRIS about 2 to 3 weeks, Cook County about 2 months, Philadelphia longer. `daysOfRecords` counts back from the newest record each county has published, and every row carries `dataThrough`.
- `minPrice` defaults to 1,000, which drops $0 to $10 nominal transfers between relatives, trusts and related companies.
- NYC deeds have no property ZIP in ACRIS, so a ZIP filter drops NYC rows.
- More counties will be added. Ask in the Issues tab for yours.
- For mortgage and listing data, see [Redfin Scraper](https://apify.com/scrapemint/redfin-scraper) and [US Rent and Home Price Index](https://apify.com/scrapemint/us-rent-home-price-index).
