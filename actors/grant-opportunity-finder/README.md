# Grant Opportunity Finder: US Federal Grants with Deadlines

Search live US federal grant opportunities and get one clean JSON row per grant: opportunity number, title, agency, open and close dates, award ceiling and floor, estimated total funding, eligible applicant types, funding categories, a plain-text description, the application link, and the agency contact email when published. Reads grants.gov's official public API: no key, no login, no browser.

Built for grant writers and consultants, nonprofit development teams, universities, hospitals, municipalities, and startups hunting SBIR-adjacent funding. Turn on cross-run dedupe, put it on a weekly schedule, and each run returns only newly posted grants matching your profile — the alert that discovery platforms charge $179+/month for.

## What you get

One row per opportunity, with:

- `opportunityNumber`, `title`, `agencyCode`, `agencyName`, `status`
- `openDate`, `closeDate` (application deadline), `docType`
- `awardCeiling`, `awardFloor`, `estimatedFunding`, `expectedNumberOfAwards`, `costSharing`
- `applicantTypes` (who can apply), `fundingCategories`, `fundingInstruments`, `cfdas`
- `description` (plain text), `agencyContactEmail`, `agencyContactName`
- `url` (grants.gov detail page), `matchedKeyword`, `scrapedAt`

## Input

- `keywords` (one search per keyword, merged and deduplicated)
- `oppStatuses` (`posted` = open now, `forecasted` = announced but not yet open)
- `agencyCodes` (e.g. NSF, HHS, USDA, ED)
- `fundingCategories` (e.g. ED Education, ENV Environment, HL Health)
- `eligibilityCodes` (e.g. 12 = 501(c)(3) nonprofits, 20 = private universities, 22 = for-profits)
- `includeDetails` (award amounts, eligibility, description, contact email; default on)
- `maxOpportunities` (default 25, up to 1000)
- `dedupe` (skip previously returned grants; built for scheduled alerts)

## Example input

```json
{
  "keywords": ["rural health", "telehealth"],
  "oppStatuses": ["posted", "forecasted"],
  "eligibilityCodes": ["12"],
  "maxOpportunities": 50,
  "dedupe": true
}
```

## Example output

```json
{
  "opportunityId": 103313,
  "opportunityNumber": "NOAA-OAR-CPO-2012",
  "title": "Climate Program Office",
  "agencyName": "Department of Commerce",
  "status": "posted",
  "closeDate": "09/01/2026",
  "estimatedFunding": 15500000,
  "applicantTypes": ["State governments", "Nonprofits with 501(c)(3) status"],
  "fundingCategories": ["Environment", "Science and Technology"],
  "agencyContactEmail": "grants.officer@noaa.gov",
  "url": "https://www.grants.gov/search-results-detail/103313"
}
```

## Uses

- Weekly new-grant alerts scoped to your keywords and eligibility, with dedupe so you only see what's new
- Deadline pipelines: pull everything closing in the next 60 days for your categories
- Grant consultancies: one scheduled run per client profile, rows straight into the client tracker
- Forecast intel: `forecasted` status surfaces grants before they open, when positioning matters most
- Outreach: agency contact emails for program-officer questions

## Pricing

Pay per opportunity row. Searches that match nothing cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from grants.gov's official public API (Search2 + fetchOpportunity), covering all US federal grant-making agencies.
- Category, eligibility, and agency codes are the standard grants.gov codes; any value accepted by grants.gov search works here.
