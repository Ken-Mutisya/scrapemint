# Crime Data Scraper (US Cities)

Official police incident data from US city open-data portals, normalized to one clean row shape across cities. Pick cities, optionally a crime type and date window, and get structured incidents with offense, location and arrest information. No API key, no login, no browser.

## Cities covered

- **Chicago, IL** - full incident feed, arrest flag included (publishes about a week behind)
- **New York City, NY** - NYPD complaints with felony/misdemeanor class (refreshed quarterly - use 90+ day windows)
- **San Francisco, CA** - incident reports with neighborhood and resolution (a day or two behind)
- **Seattle, WA** - NIBRS offenses with block address (a day or two behind)
- **Austin, TX** - incident reports (about a week behind; area-level location only)
- **Dallas, TX** - police incidents with address and coordinates (a day or two behind)

Every city is the police department's own published dataset - the same data behind the official crime dashboards.

## What you get

One row per incident:

- city, incident id, when it occurred (ISO timestamp)
- offense **category** and description, plus the **place type** (street, apartment, store...)
- block-level **address**, neighborhood/ward/district **area**, and **coordinates** where the city publishes them
- **arrest** flag and case status where available

```json
{
    "cities": ["chicago", "san_francisco"],
    "crimeType": "BURGLARY",
    "sinceDays": 30
}
```

## Monitor mode

Turn on **newOnly**, put the actor on a schedule, and each run emits only incidents it has not returned before - a fresh-incident feed for the cities and crime types you care about. Runs where nothing new arrived cost nothing.

## Who uses this

- **Real-estate investors and agents**: neighborhood-level incident history for due diligence, straight from the source instead of a $40 report.
- **Insurers and security companies**: risk signals and prospecting by area and offense type.
- **Journalists and researchers**: structured, citable incident data across major cities without per-portal wrangling.
- **Retail and operations teams**: monitor incidents around store locations.

Pairs with our Building Permit Leads and Restaurant Inspection Leads - the same city-data-as-signal family.

## Pricing

A small fee per incident row. Empty windows and unreachable city feeds are free note rows, and the first 2 rows of every run are free.

## Notes

- Sources are official city Socrata endpoints; each row carries its source dataset URL.
- Cities publish with a lag (noted per city above), and police departments revise records after initial publication. Incident data reflects reports, not convictions.
- Addresses are block-level as published by each city; some cities redact or generalize locations for privacy.
- Los Angeles is deliberately not included: its public dataset stopped updating in 2024.
