# Healthcare Provider Leads Scraper: NPI Contacts by Specialty

Build US healthcare provider lead lists from the official NPI registry (CMS NPPES), the public record every practicing provider and healthcare organization must be in. Search by specialty, state, city, or ZIP and get one JSON row per provider with the practice phone number, address, specialty taxonomy, and license, and for organizations the authorized official: the decision maker's name, title, and phone. Keyless official government API: no login, no browser, no per-seat directory subscription.

Built for dental and medical software vendors, device and supply reps, healthcare recruiters and staffing agencies, insurance and billing services, and local marketers selling to practices.

## What you get

One row per provider, with:

- `npi`, `providerType` (individual or organization), `name`, `credential`
- `specialty`, `taxonomyCode`, `licenseNumber`, `licenseState`
- `phone`, `fax`, `address1`, `address2`, `city`, `state`, `postalCode`
- `authorizedOfficialName`, `authorizedOfficialTitle`, `authorizedOfficialPhone` (organizations: the practice's decision maker)
- `status`, `enumerationDate`, `lastUpdated`, `profileUrl`

`enumerationDate` tells you how new the provider is: recently enumerated NPIs are new practices and new graduates, the leads with no incumbent vendors yet.

## Input

- `specialties` (matched against taxonomy descriptions, e.g. dentist, chiropractor, physical therapy, family medicine, pharmacy)
- `states` / `cities` / `postalCodes` (a trailing `*` on a ZIP matches the prefix, e.g. `787*` for all of Austin)
- `providerType` (both, individuals only, or organizations only — organizations carry the decision-maker fields)
- `maxProviders` (default 50, up to 2000)
- `dedupe` (skip previously returned NPIs; built for scheduled prospecting)

## Example input

```json
{
  "specialties": ["dentist"],
  "states": ["TX"],
  "providerType": "organization",
  "maxProviders": 200
}
```

## Example output

```json
{
  "npi": "1154494250",
  "providerType": "organization",
  "name": "360 DENTAL CARE P.A.",
  "specialty": "Dentist, General Practice",
  "taxonomyCode": "1223G0001X",
  "phone": "512-327-3631",
  "address1": "3300 BEE CAVES RD STE 305",
  "city": "AUSTIN",
  "state": "TX",
  "postalCode": "787468106",
  "authorizedOfficialName": "JANE DOE",
  "authorizedOfficialTitle": "OWNER",
  "authorizedOfficialPhone": "512-327-3631",
  "enumerationDate": "2009-02-01",
  "profileUrl": "https://npiregistry.cms.hhs.gov/provider-view/1154494250"
}
```

## Uses

- Call and mail lists for anyone selling software, devices, supplies, or services to practices, segmented by specialty and geography
- Organizations mode: skip gatekeepers and get the authorized official's name and title per practice
- Healthcare recruiters: every licensed provider in a specialty and metro, with license numbers
- Scheduled prospecting with `dedupe` on: only never-seen providers each run
- Chain practice names into the Website Contact Scraper for emails once you have the list

## Pricing

Pay per provider row. Providers without any phone number are free rows, and searches that match nothing cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from the official CMS NPPES NPI registry API and reflects what providers filed; addresses are practice locations, and phone coverage is near universal.
- A state on its own is not accepted by the registry; combine it with a specialty, city, or ZIP.
- Wide searches fan out: each specialty x location combo pages through the registry 200 rows at a time.
