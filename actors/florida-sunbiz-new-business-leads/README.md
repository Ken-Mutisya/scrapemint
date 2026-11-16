# Florida Sunbiz New Business Leads: Daily LLC Filings

Get every new Florida LLC and corporation the day after it is filed, straight from the Florida Division of Corporations (Sunbiz) official daily filing file. Each row has the **business name, entity type, file date, principal and mailing address, FEI/EIN, registered agent and up to six officers, managers or members**.

Filter by city, ZIP, name keyword (ROOFING, CLEANING, TRUCKING...) and entity type, and skip filings that only list a registered-agent service address. No API key, no login, no website scraping.

## Who uses it

- **Business banks, insurance and payroll**: new companies need accounts, cover and payroll in their first weeks
- **Accountants, bookkeepers and tax preparers**: new LLCs need EINs, books and first returns
- **Web designers, marketing agencies, phone and POS vendors**: reach owners before they pick a provider
- **Commercial cleaners, office suppliers, sign makers**: local businesses opening near you
- **Researchers and journalists**: track business formation by city and industry

## What you get

One row per new filing:

- `documentNumber`, `name`, `status`, `entityType`, `entityTypeLabel`, `fileDate`, `feiNumber`
- `principalStreet`, `principalCity`, `principalZip`, plus mailing address
- `registeredAgent`, `registeredAgentIsPerson`, registered agent address, `agentServiceAddress`
- `officers`: up to six people or companies with `title` (Manager, Authorized Member, President...), `name` and address
- `primaryContact`, `primaryContactTitle`: the first named person, ready for outreach
- `sunbizUrl` to the official record

## Example input

New roofing and HVAC LLCs in the Miami and Tampa areas, last 5 business days:

```json
{
  "daysBack": 5,
  "entityTypes": ["llc", "corporation"],
  "zipCodes": ["331", "336"],
  "nameKeywords": ["ROOF", "HVAC", "AIR CONDITIONING"],
  "excludeAgentServiceAddresses": true,
  "requireOfficer": true
}
```

Entity types: `llc`, `corporation`, `nonprofit`, `limited_partnership`, `foreign_llc`, `foreign_corporation`, `foreign_nonprofit`, `foreign_limited_partnership`, `trust`.

## Example output

```json
{
  "documentNumber": "L26000570940",
  "name": "THE BURL TABLE LLC",
  "status": "Active",
  "entityType": "llc",
  "fileDate": "2026-11-10",
  "principalStreet": "15967 TRIPLE CROWN CT",
  "principalCity": "FORT MYERS",
  "principalZip": "33912",
  "registeredAgent": "TYLER J ADAMS",
  "officers": [{ "title": "Authorized Representative", "name": "TYLER J ADAMS", "city": "FORT MYERS", "state": "FL" }],
  "primaryContact": "TYLER J ADAMS",
  "sunbizUrl": "https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults?inquiryType=DocumentNumber&searchTerm=L26000570940"
}
```

## Pricing

Pay per business row. The first row of every run is free.

## Notes

- Sunbiz posts one file per business day, usually the next morning. About 1,000 to 4,000 new filings a day statewide.
- Sunbiz files do not include phone numbers or emails. Pair the names with [Company Email Finder](https://apify.com/scrapemint/company-email-finder) or [Google Maps Local Business Lead Finder](https://apify.com/scrapemint/google-maps-scraper) once the business has a website or listing.
- Schedule it daily with `daysBack: 1` for a fresh list every morning.
- For Colorado, Connecticut and New York filings, use [New Business Registration Leads](https://apify.com/scrapemint/new-business-registration-leads).
