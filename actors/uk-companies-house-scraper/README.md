# UK Companies House Scraper: New Companies & Directors

**Pull companies from the UK Companies House register in bulk.** Search by **incorporation date**, **SIC code**, **town or postcode**, **company name**, **status** and **company type**, or look up company numbers, and get one row per company:

- **Company:** name, company number, status, type, incorporation and dissolution dates
- **Where:** registered office address and postcode
- **What they do:** SIC codes with plain-English descriptions
- **With details on:** next accounts and confirmation-statement due dates, **overdue flags**, previous names, and **active directors and secretaries** (name, role, appointed date, nationality, country of residence)

Set **incorporated in the last 7 days** and run it on a schedule for a **daily feed of brand-new UK companies**: new businesses need accountants, banks, insurance, web design, software, office space and payroll.

Uses the register's own CSV export, so 5,000 companies come back in about a second. Large searches are split by date automatically, so you are not stuck at the 5,000 limit of the website.

No API key, no account, no proxy.

## What you get

`companyName`, `companyNumber`, `status`, `companyType`, `companyTypeCode`, `incorporationDate`, `dissolutionDate`, `registeredOfficeAddress`, `postcode`, `sicCodes`, `sicDescriptions`, `companyUrl`

With **Add profile details and officers**: `accountsNextMadeUpTo`, `accountsNextDue`, `accountsLastMadeUpTo`, `accountsOverdue`, `confirmationStatementNextDue`, `confirmationStatementLastDate`, `confirmationStatementOverdue`, `previousNames`, `activeOfficerCount`, `directors`, `officers`

## Example input

New restaurants registered this week, with their directors:

```json
{
  "incorporatedInLastDays": 7,
  "sicCodes": ["56101", "56102"],
  "includeDetails": true
}
```

Software companies incorporated in Manchester in 2026:

```json
{
  "incorporatedFrom": "2026-01-01",
  "incorporatedTo": "2026-12-31",
  "sicCodes": ["62012", "62020"],
  "location": "Manchester",
  "maxResults": 5000
}
```

Look up specific companies:

```json
{
  "companyNumbers": ["00445790", "SC906865"],
  "includeDetails": true
}
```

## Example output

```json
{
  "companyName": "CRAVZ LTD",
  "companyNumber": "17530611",
  "status": "Active",
  "companyType": "Private limited company",
  "incorporationDate": "2026-10-20",
  "registeredOfficeAddress": "17 Plumbers Row, Unit D, Upper Ground Floor, London, United Kingdom, E1 1EQ",
  "postcode": "E1 1EQ",
  "sicCodes": ["56101"],
  "sicDescriptions": ["Licenced restaurants"],
  "companyUrl": "https://find-and-update.company-information.service.gov.uk/company/17530611",
  "accountsNextMadeUpTo": "2027-10-31",
  "accountsNextDue": "2028-07-20",
  "accountsOverdue": false,
  "confirmationStatementNextDue": "2027-11-02",
  "confirmationStatementOverdue": false,
  "activeOfficerCount": 1,
  "directors": ["MIAH, Modu"],
  "officers": [
    { "name": "MIAH, Modu", "role": "Director", "appointedOn": "2026-10-20", "nationality": "British", "countryOfResidence": "England" }
  ]
}
```

## Uses

- **New-business lead lists:** accountants, banks, insurers, web agencies and SaaS sellers reaching companies in their first weeks
- **Local prospecting:** every new company in a town or postcode area, by trade
- **Compliance and credit:** companies with overdue accounts or confirmation statements
- **Market research:** how many companies start in a sector each month
- **Pair it with** [Company Email Finder](https://apify.com/scrapemint/company-email-finder) and [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper) for contact details

## Common SIC codes

`62012` software development, `62020` IT consultancy, `56101` restaurants, `56302` pubs and bars, `68100` buying and selling property, `68209` letting property, `41202` building houses, `43210` electricians, `43220` plumbing and heating, `47910` online retail, `70229` management consultancy, `73110` advertising agencies, `86900` health practices, `96020` hairdressing and beauty

## Pricing

- **$0.001** per company from the search
- **$0.003** per company with profile details and officers (instead of the above)
- No start fee. A run that finds nothing is free.

Data comes from the public Companies House register under the Open Government Licence. Dates of birth and correspondence addresses of officers are left out.
