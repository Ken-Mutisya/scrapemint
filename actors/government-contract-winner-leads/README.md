# Government Contract Winner Leads: New Federal Contract Awards

Reach a company the week it wins a federal contract. A fresh award is the strongest timed buying signal in B2B: the winner is about to hire, buy software and equipment, rent space, line up subcontractors, and need bonding, insurance and compliance help. This actor pulls new contract awards from the official USAspending.gov API (keyless, no login, no browser), filtered by your keywords, industry codes, agencies and amount floor, and enriches every winner with their address, UEI, business-type flags and lifetime award total.

Platforms selling this alert charge hundreds of dollars per month. Here it is pay per row.

## What you get

One row per new award, with:

- `awardId`, `recipientName`, `awardAmount`, `description`
- `awardingAgency`, `awardingSubAgency`
- `naicsCode`, `naicsDescription`, `pscCode`, `pscDescription`
- `placeOfPerformanceState`, `startDate`, `endDate`, `usaspendingUrl`
- Winner profile: `addressLine1`, `city`, `state`, `zip`, `uei`
- `businessTypes` (small business, veteran owned, minority owned, ...), `smallBusiness`
- `lifetimePrimeAwards` (first-time winner vs entrenched incumbent)

A first-time winner with a $5M award is setting up everything from payroll to facilities. A small business that just landed a prime contract needs subcontractors and suppliers. An incumbent stacking wins in your state is a qualified enterprise prospect with confirmed budget.

## Input

- `keywords` (matched against award descriptions, e.g. software, construction, security)
- `naicsCodes` (optional industry filter; prefixes work, 54 = all professional services)
- `agencies` (optional, full names like Department of Defense)
- `daysBack` (awards signed in the last N days, default 7)
- `minAmount` (skip small awards)
- `smallBusinessOnly` (only registered small business winners)
- `enrichRecipient` (default on)
- `maxAwards` (default 50, up to 500, largest first)

## Example input

```json
{
  "keywords": ["software"],
  "daysBack": 7,
  "minAmount": 250000,
  "maxAwards": 50
}
```

## Example output

```json
{
  "awardId": "2032H526F00080",
  "recipientName": "IMPRES TECHNOLOGY SOLUTIONS, INC",
  "awardAmount": 49673734.15,
  "description": "VMWARE MIGRATION TO NUTANIX...",
  "awardingAgency": "Department of the Treasury",
  "awardingSubAgency": "Internal Revenue Service",
  "naicsCode": "541519",
  "placeOfPerformanceState": "WV",
  "addressLine1": "810 HESTERS CROSSING RD",
  "city": "ROUND ROCK",
  "state": "TX",
  "uei": "MSSQQ551LG41",
  "businessTypes": ["small_business", "minority_owned_business"],
  "smallBusiness": true,
  "lifetimePrimeAwards": 176664320.41,
  "enriched": true
}
```

## Uses

- B2B sales: companies with fresh, publicly confirmed budget in your niche, addressable by name and location
- Subcontracting and teaming: catch primes the week they win, before they finish staffing
- Recruiters: a services contract award means immediate hiring against a start date
- Insurance, bonding, and compliance sellers: every new winner needs coverage and audits
- Market intel: who is winning in your NAICS, at which agencies, at what amounts
- Chain winners into the Website Contact Scraper for emails and phone numbers

## Pricing

Pay per row. Rows with winner profile enrichment (address, UEI, business types, lifetime totals) are lead rows; rows where enrichment is off or the profile is unavailable are cheaper award rows. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data is the official USAspending.gov API, covering all federal prime contract awards; new awards appear within days of signing.
- `date_signed` filtering returns genuinely new awards, not modifications to old ones.
- Rows sort by award amount, so the biggest wins come first under any cap.
- Run it weekly with your niche keywords for a standing new-winner feed.
