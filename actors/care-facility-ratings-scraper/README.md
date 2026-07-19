# Care Facility Ratings Scraper (CMS)

Medicare's official quality ratings for US care facilities - nursing homes, hospitals and home health agencies - as structured data. The star ratings and inspection records behind Medicare's Care Compare tool, searchable by name, state or city in bulk. No API key, no login, no browser.

## What you get

One row per facility:

- name, CMS certification number, full address, city, state, ZIP, county
- **overall star rating** (1 to 5)
- for **nursing homes**: health-inspection rating, staffing rating, quality-measure rating, certified beds, average residents per day, total fines in dollars, ownership
- for **hospitals**: overall rating, hospital type, emergency services, ownership
- for **home health agencies**: quality-of-patient-care star rating, ownership

```json
{
    "facilityType": "nursing_homes",
    "state": "CA",
    "minRating": "4"
}
```

## Ways to search

- **facilityType** - nursing homes (fullest ratings), hospitals, or home health agencies
- **facilityName** - name contains (partial, case-insensitive)
- **state / city** - sweep an area
- **minRating** - only facilities at or above a star rating

## Who uses this

- **Families and elder-care advisors**: compare nursing homes and agencies by quality, not marketing.
- **Health systems and payers**: benchmark facilities and competitors across a market.
- **Senior-living operators and investors**: market research and acquisition screening by rating and ownership.
- **Elder-law attorneys and journalists**: staffing, deficiency and fine records as evidence and data.

Pairs with our Healthcare Provider Leads (the provider directory) and Doctor Payments Scraper for a fuller healthcare picture.

## Pricing

A small fee per facility row. Searches that match nothing are free note rows, and the first 2 rows of every run are free.

## Notes

- Source: CMS Care Compare / provider-data, official Medicare data, refreshed by CMS. Each row links to Medicare's Care Compare site.
- A rating reflects CMS's most recent published data; some facilities (especially newer home health agencies) carry no rating yet and appear with a null rating.
- Ratings and deficiencies are regulatory history, not a statement about current care on any given day.
