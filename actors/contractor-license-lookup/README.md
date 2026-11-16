# Contractor License Lookup: WA, OR, TX, NY Leads

Verify a contractor's license or pull every newly licensed contractor from four official state license rolls in one run:

- **Washington**: Labor & Industries contractor registrations
- **Oregon**: Construction Contractors Board active licenses (with bond and insurance)
- **Texas**: TDLR trade licenses (electrical, A/C, appliance, sign, water well, elevator)
- **New York**: Department of Labor Contractor Registry (with workers' comp and debarment flags)

Every row uses the same fields: license number, business, trade, status, issue and expiry dates, **phone**, address, principal, bond and insurance where the state publishes them. Data comes from each state's open-data portal, refreshed daily. No API key, no login, no CAPTCHA.

## Who uses it

- **Insurance, bonding and surety agents**: new contractors need general liability, workers' comp and license bonds
- **Building suppliers, equipment dealers, software vendors**: reach newly licensed electricians, HVAC and general contractors
- **Homeowners, property managers, GCs**: verify a sub's license status, expiry and insurance before hiring
- **Marketplaces and lead-gen platforms**: verify contractors at signup

## What you get

- `licensingState` (the board: WA, OR, TX, NY), `licenseNumber`, `businessName`, `dbaName`, `ownerOrPrincipal`
- `licenseType`, `trades`, `status`, `issueDate`, `expirationDate`
- `phone`, `street`, `city`, `state`, `zip`, `county`, `businessType`
- Oregon: `bondCompany`, `bondAmount`, `insuranceCompany`, `insuranceAmount`, `insuranceExpiration`
- New York: `workersCompInsurance`, `debarred`, `wageAssessmentsOutstanding`, `mwbeOwned`
- `lookupUrl` to the official record

## Example input

Electricians licensed in Washington and New York in the last 30 days:

```json
{ "states": ["WA", "NY"], "trades": ["ELECTRICAL"], "issuedWithinDays": 30, "requirePhone": true }
```

Verify specific contractors:

```json
{ "states": ["WA", "OR", "TX", "NY"], "businessNames": ["ACME ROOFING"], "licenseNumbers": ["ECOSTSC758NN"] }
```

## Example output

```json
{
  "licensingState": "WA",
  "licenseNumber": "ECOSTSC758NN",
  "businessName": "!ECO STAR C G CONSTRUCTION LLC",
  "ownerOrPrincipal": "GUERRERO MARTINEZ, CARLOS I.",
  "licenseType": "CONSTRUCTION CONTRACTOR",
  "trades": ["GENERAL"],
  "status": "ACTIVE",
  "issueDate": "2025-08-15",
  "expirationDate": "2027-08-15",
  "phone": "+15039573452",
  "city": "VANCOUVER",
  "zip": "98661"
}
```

## Pricing

Pay per license row. The first row of every run is free.

## Notes

- Texas TDLR does not publish issue dates, so `issuedWithinDays` skips Texas. Without trades, Texas returns construction trades only (not barbers or cosmetologists).
- Oregon's file lists active licenses only. New York's registry covers contractors on public works and covered private projects.
- More states will be added. Ask in the Issues tab for the one you need.
- For permits pulled by contractors, see [Building Permit Leads](https://apify.com/scrapemint/building-permit-leads).
