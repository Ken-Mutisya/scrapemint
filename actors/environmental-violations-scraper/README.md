# Environmental Violations Scraper (EPA ECHO)

US facility-level environmental compliance from EPA's ECHO database - the official record of how regulated sites perform under the Clean Air Act, Clean Water Act and hazardous-waste rules. Search by company, state or industry and get each facility's compliance status, quarters in violation, inspections, enforcement actions and penalties. No API key, no login, no browser.

## What you get

One row per facility:

- name, full address, county, coordinates, EPA registry id
- SIC and NAICS industry codes
- **compliance status** overall and per program (air, water, waste, drinking water)
- **significant non-complier** flag and **quarters in non-compliance**
- inspection count and last inspection date
- penalty count, last penalty date and Clean Air Act penalty dollars
- last formal enforcement action date, and a link to the facility's ECHO report

```json
{
    "state": "TX",
    "naicsCode": "324",
    "violatorsOnly": true
}
```

## Ways to search

- **companyName** - a company or facility name (partial match)
- **state** - sweep a whole state's regulated facilities
- **naicsCode** - limit to an industry ("324" petroleum, "3116" meat processing)
- **violatorsOnly** - only facilities currently in violation or significant non-compliance (the highest-signal filter)

## Who uses this

- **ESG and diligence teams**: environmental risk on a target's facilities for M&A and investment screening.
- **Insurers and lenders**: compliance history for underwriting industrial sites.
- **Journalists and advocates**: the polluter beat - who violates, where, and what they were fined.
- **Compliance and EHS teams**: benchmark your own sites and monitor competitors.

Pairs with our Lobbying Disclosure Scraper and Government Contract Winner Leads for a fuller corporate-accountability picture.

## Pricing

A small fee per facility row. Searches that match nothing (and violator-only searches where every match is compliant) are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: EPA ECHO (Enforcement and Compliance History Online), official US government data. Each row links to the facility's detailed ECHO report.
- Compliance status reflects EPA's most recent data; "quarters in non-compliance" captures a rolling three-year history, so a facility can show past non-compliance even when its current status reads clean.
- A violation or penalty on record is regulatory history, not a statement about current operations.
