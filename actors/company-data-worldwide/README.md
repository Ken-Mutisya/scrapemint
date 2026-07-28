# Company Data Worldwide: Industry, Owners and Listings

Structured company facts for any country: when a company was founded, where it is based, what industry it is in, who owns it, which exchanges it trades on under which ticker, and how many people it employs. No key, no login, no proxy.

## What you get

| Field | Meaning |
| --- | --- |
| `company`, `wikidataId`, `wikidataUrl` | The company and its source record |
| `country`, `headquarters` | Where it is based |
| `founded`, `foundedYear` | Founding date |
| `industries` | Every industry it is classified under |
| `legalForm` | AG, GmbH, corporation, and so on |
| `chiefExecutive`, `parentCompany` | Who runs it and who owns it |
| `listings`, `tickers`, `isListed` | Each exchange with the ticker used there |
| `employees`, `employeesAsOf`, `employeeHistory` | Headcount, and the year it refers to |
| `website` | Official site |

## Three modes

**Search** finds companies by country, industry, founding window, or listed status. Useful for mapping a sector, building a target list, or finding companies founded since a given year.

**Company** returns full profiles for the names you supply.

**Subsidiaries** lists what a parent company owns. Ownership is recorded in both directions and neither side is complete on its own, so both are queried and merged.

## Example input

```json
{
  "mode": "search",
  "country": "Germany",
  "industry": "automotive",
  "listedOnly": true,
  "maxResults": 50
}
```

Trace a group's holdings:

```json
{
  "mode": "subsidiaries",
  "parentCompany": "Alphabet Inc."
}
```

## Three things worth knowing

**This is a knowledge base, not a companies registry.** Large and notable firms are described in depth, small local businesses are often absent. It is the right tool for mapping an industry, tracing ownership or enriching a list of known companies, and the wrong tool for proving that a given small company exists. For that, use our Global Company Verification actor, which checks VAT and LEI registration.

**Industry terms are resolved both ways.** Companies are tagged with "software industry" rather than "software", and which phrasing is the real one differs by sector. Type either: both readings are resolved and the search keeps whichever actually returns companies, so a wrong guess never comes back looking like an empty sector.

**Employee counts carry the year they refer to.** A company often has several figures recorded across different years, and the largest is not the current one. The most recent dated figure is returned in `employees` with its year in `employeesAsOf`, and the full series stays in `employeeHistory` so you can see the trend or pick your own.

## Pricing

Pay per company, `$0.005`. The first 2 rows of every run are free. Names that cannot be resolved, sectors with no matches, and queries the source rejects return a free note explaining which happened, and are never charged.

## Attribution

Data from Wikidata, released under CC0. Every row carries the `wikidataUrl` of the underlying record, so any fact can be checked or corrected at source.

## Related actors

- **Global Company Verification** for legal registration through VAT and LEI records
- **Business Locations Worldwide** for physical premises and contact details
- **SEC Company Filings Feed** for US regulatory filings by the same companies
