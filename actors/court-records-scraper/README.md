# Court Records Scraper: Case Law & Dockets

Search US federal and state court records - published case law and court dockets - without a Westlaw or PACER bill. Built on [CourtListener](https://www.courtlistener.com) (by the non-profit Free Law Project), credited as the source. No API key, no login, no browser.

## Two record types

**Case law (opinions)** - published court decisions. One row per case:
- case name, court, jurisdiction
- date filed and date argued
- citation, neutral citation, and **how many times the case has been cited** (a strong signal of importance)
- precedential status, docket number, judge, nature of suit
- a text snippet and links to the opinion and its document

**Dockets (filings)** - court case records. One row per docket:
- case name, court, docket number
- date filed and date terminated
- assigned judge, nature of suit / cause, bankruptcy chapter
- a link to the full docket

## Search and filter

```json
{
    "queries": ["fair use copyright"],
    "recordType": "opinions",
    "sortBy": "most_cited"
}
```

- **queries** - keywords, a party or company name, or a case name (one search per line)
- **courts** - limit to specific courts by ID ("scotus" Supreme Court, "cafc" Federal Circuit, "ca9" 9th Circuit, "dcd" DC District)
- **filedAfter / filedBefore** - date range
- **sortBy** - best match, newest, oldest, or most cited

## Who uses this

- **Law firms and paralegals**: research case law on an issue and pull dockets by party.
- **Companies**: check litigation exposure and run due diligence on partners, suppliers and competitors by name.
- **Legal researchers and journalists**: track cases and find the most-cited authorities on a topic.
- **Law schools and students**: study case law and citation patterns with structured data.

## Pricing

A small fee per record. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: CourtListener / Free Law Project, a public database of US court opinions and dockets. Coverage is strongest for appellate and federal courts; docket coverage comes from the RECAP archive of PACER.
- This returns the metadata and links for each record; full opinion text is linked from each row.
