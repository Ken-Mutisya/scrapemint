# Nonprofit Leads Scraper: IRS 990 Revenue, Assets & Contacts

Turn the IRS nonprofit universe into a segmented lead list. Search US nonprofits by keyword, state, and NTEE category, and get one JSON row per organization with its 990 financials: latest total revenue, expenses, and assets, a multi-year revenue trend, filing history, address, and a link to the filing PDF and public profile. Filter by revenue band to target organizations that can actually afford you. Keyless public API on IRS data: no login, no browser, no seat license.

Built for vendors and agencies selling to nonprofits, grant consultants prospecting clients, fundraisers researching peers and funders, and analysts sizing the sector.

## What you get

One row per organization, with:

- `ein`, `name`, `city`, `state`, `address`, `zipcode`, `nteeCode`, `subsectionCode`, `rulingDate`
- `totalRevenue`, `totalExpenses`, `totalAssets`, `latestFilingYear`
- `revenueByYear` (up to 5 years — spot growth or decline at a glance)
- `filingsAvailable`, `latestFilingPdf`, `profileUrl`, `matchedTerm`

## Input

- `searchTerms` (matched against organization names)
- `states` (two-letter codes)
- `nteeCategories` (1=Arts, 2=Education, 3=Environment, 4=Health, 5=Human Services, 6=International, 7=Public Benefit, 8=Religion, 9=Mutual Benefit)
- `minRevenue` / `maxRevenue` (segment by budget, e.g. only orgs over $1M)
- `includeFinancials` (default on; one extra request per org)
- `maxOrgs` (default 25, up to 1000)
- `dedupe` (skip previously returned EINs; built for scheduled prospecting)

## Example input

```json
{
  "searchTerms": ["food bank"],
  "states": ["TX", "OK"],
  "minRevenue": 1000000,
  "maxOrgs": 100
}
```

## Example output

```json
{
  "ein": 742181456,
  "name": "Houston Food Bank",
  "city": "Houston",
  "state": "TX",
  "nteeCode": "K31",
  "latestFilingYear": 2023,
  "totalRevenue": 401238747,
  "totalExpenses": 389516210,
  "totalAssets": 273904481,
  "revenueByYear": { "2023": 401238747, "2022": 388112604, "2021": 421077553 },
  "profileUrl": "https://projects.propublica.org/nonprofits/organizations/742181456"
}
```

## Uses

- Lead lists for software, services, and consultancies that sell to nonprofits, segmented by real budget
- Grant consultants: find growing organizations in your niche before pitching
- Fundraising benchmarks: revenue trends for every peer organization in a category and state
- Pair with the Grant Opportunity Finder: who is funding, who needs funding, in one workflow
- Chain the names into a website contact scraper for outreach emails

## Pricing

Pay per organization row. Organizations with no filing data on record are free rows, and searches that match nothing cost nothing. The first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from ProPublica's Nonprofit Explorer public API, built on IRS Form 990 filings and the IRS Business Master File. Financials reflect the latest filing on record, which typically lags the current year.
- Revenue filters require financials and skip organizations without filing data.
