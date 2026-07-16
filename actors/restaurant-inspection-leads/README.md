# Restaurant Inspection Leads: Health Violations by City

Fresh restaurant health inspections pulled from official city and county open data portals and normalized into one clean row shape. A restaurant that just failed an inspection is an active buyer of pest control, hood and vent cleaning, food safety consulting, staff training, and equipment repair. This actor turns public inspection records into a lead feed for those services.

## What you get

One row per inspection:

| Field | Description |
| --- | --- |
| `businessName` | Restaurant or food business name |
| `businessType` | Cuisine or facility type where published |
| `address`, `zip` | Street address |
| `phone` | Phone number where the city publishes it (NYC, King County) |
| `inspectionDate` | Date of the inspection |
| `inspectionType` | Routine, complaint, re-inspection, etc. |
| `result` | Pass / Fail / action taken, as published |
| `score`, `grade` | Numeric score or letter grade where the city uses one |
| `violations` | List of cited violation texts for the inspection |
| `violationCount`, `criticalCount` | How many violations, and how many critical |
| `latitude`, `longitude` | Coordinates where published |

## Supported cities

| City | Source | Freshness |
| --- | --- | --- |
| New York City, NY | DOHMH Restaurant Inspection Results (open data) | Updated daily, includes phone numbers |
| Chicago, IL | Chicago Food Inspections (open data) | Updated daily |
| Boston, MA | Inspectional Services food inspections (open data) | Updated daily |
| Austin, TX | Food Establishment Inspection Scores (open data) | Published with a 1 to 2 month delay, scores only |
| Seattle / King County, WA | Food Establishment Inspection Data (open data) | Currently lags several months behind |

All data comes from official government open data APIs. No login, no API key, no browser.

## Typical uses

- **Pest control companies**: filter `keywords` for `vermin`, `mice`, `roach`, `flies` and call restaurants the week they were cited.
- **Hood and vent cleaning**: filter for `hood`, `ventilation`, `grease`.
- **Food safety consultants and trainers**: set `onlyWithViolations` and prospect every failed inspection.
- **Commercial cleaning and equipment repair**: filter for `temperature`, `refrigeration`, `sanitiz`.
- **Insurers, landlords, journalists, researchers**: monitor inspection outcomes across cities.

## Scheduled lead feed

Turn on `dedupe` and run the actor daily on a schedule: every run returns only inspections it has not returned before, so your team gets a stream of new violations without repeats.

## Pricing

You pay per inspection row returned (`inspection_row`). The first 2 rows of every run are free, so you can try the actor without cost. Rows filtered out by your keywords, city choice, or date window are never charged.

## Input example

```json
{
    "cities": ["nyc", "chicago", "boston"],
    "keywords": ["vermin", "mice", "roach"],
    "onlyWithViolations": true,
    "sinceDays": 14,
    "maxRows": 100,
    "dedupe": true
}
```

## Notes

- Inspection records are public data published by each city or county government. Field coverage varies by city; fields a city does not publish are `null`.
- Scores mean different things in different cities (NYC lower is better, Austin higher is better). The `result` field carries each city's own wording.
- If a city's portal is down or slow, the actor logs a warning and continues with the other cities.
