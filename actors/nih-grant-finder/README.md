# NIH Research Grant Finder: Awards & PIs

Search every research grant the US National Institutes of Health has funded - the single largest source of biomedical research money in the world - straight from the official [NIH RePORTER](https://reporter.nih.gov) database. No API key, no login, no browser.

## What you get

One row per funded grant:

- project title, project number, fiscal year
- **award amount** (whole US dollars)
- grantee institution with city, state and country
- principal investigator(s) and the contact PI
- funding NIH agency/institute, project start and end dates
- research terms and the full abstract (optional)
- a link to the grant on reporter.nih.gov

## Search and filter

```json
{
    "searchText": ["crispr gene editing"],
    "fiscalYears": ["2025", "2024"],
    "sortBy": "award_desc"
}
```

- **searchText** - keywords across titles, abstracts and terms (one search per line)
- **organizations** - specific institutions ("STANFORD UNIVERSITY", "MAYO CLINIC")
- **principalInvestigators** - grants led by named researchers
- **states / fiscalYears / minAwardUsd** - narrow by location, year and size

You can search by keyword, browse an institution's or a researcher's whole portfolio, or combine them.

## Who uses this

- **Universities and research institutions**: track funding in your field, see what peers are winning, find the money behind a topic.
- **Research, biotech and pharma firms**: map who funds what, identify key investigators, spot emerging areas before they are crowded.
- **Business development and consultants**: build lists of funded labs as customers or partners, with award sizes attached.
- **Students, librarians and journalists**: study how research money flows, by topic, institution or year.

## Pricing

A small fee per grant row. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: NIH RePORTER (public domain US government data), covering NIH and related HHS research awards.
- A single search returns up to 15,000 grants; add filters (year, institution, state) to reach deeper subsets.
- Award amounts are total funding as reported; multi-year projects appear once per fiscal year they were funded.
