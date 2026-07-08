# Building Permit Leads Scraper: New Permits by City & Trade

Every issued building permit is a homeowner or business that just committed money to a project. This actor pulls recently issued permits straight from official city open-data APIs and normalizes seven different city schemas into one row shape: permit id, issue date, permit type, work description, address, declared or estimated valuation, and the contractor where the city publishes it. Filter by trade keyword and minimum project value, and run it on a schedule with dedupe for a daily feed of new permits in your trade. Keyless public JSON, no browser, no per-seat construction data subscription.

Built for roofers, solar installers, HVAC, plumbing and electrical contractors chasing active projects, building material and equipment suppliers, restoration and remodeling companies, and anyone selling to contractors named on permits.

## Covered cities

Chicago, New York City, Austin, San Francisco, Seattle, Philadelphia, Boston — the largest US cities with official keyless permit APIs. Contractor names are published by Chicago, NYC, Austin (with phone), Seattle, Philadelphia, and Boston; valuation by all except Philadelphia.

## What you get

One row per permit, with:

- `city`, `permitId`, `issueDate`, `status`
- `permitType`, `workClass`, `description`, `matchedKeyword`
- `address`, `zip`, `latitude`, `longitude`
- `valuation` (declared/estimated project cost)
- `contractorName`, `contractorPhone` (where the city publishes them)

## Input

- `cities` (empty = all seven)
- `keywords` (matched against work description and permit type, e.g. roof, solar, hvac, pool, remodel, demolition)
- `minValuation` (e.g. 50000 for projects worth pitching)
- `sinceDays` (issued in the last N days, default 7)
- `maxPermits` (default 50, up to 2000, split across selected cities)
- `dedupe` (skip previously returned permits; built for a scheduled daily feed)

## Example input

```json
{
  "cities": ["chicago", "austin", "seattle"],
  "keywords": ["roof", "solar"],
  "minValuation": 10000,
  "sinceDays": 14,
  "maxPermits": 200
}
```

## Example output

```json
{
  "city": "Austin, TX",
  "permitId": "2026-084203 EP",
  "issueDate": "2026-07-08",
  "permitType": "Electrical Permit",
  "workClass": "Repair",
  "description": "EV Charger Circuit installation. 30 Amp NEMA 10-30R installation",
  "address": "15717 JEFFS LN",
  "zip": "78717",
  "valuation": 550,
  "contractorName": "Revive Electric LLC",
  "contractorPhone": "5122695447",
  "status": "Active"
}
```

## Uses

- Trade contractors: every new permit in your keyword and value band, the week it is issued
- Suppliers and equipment vendors: permits name the contractor doing the work, which is your buyer
- Restoration, solar, and remodel sales teams: high-valuation permits are funded projects, not tire kickers
- Market research: permit volume by trade, city, and week
- Chain contractor names into the Website Contact Scraper for emails

## Pricing

Pay per permit row. Searches that match nothing cost nothing, and the first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from each city's official open-data portal (Socrata, Carto, and CKAN APIs) and reflects what the city publishes; field coverage varies by city and is normalized to null where absent.
- Cities typically publish issued permits with a lag of one to a few days.
- `minValuation` skips permits where the city publishes no value (all Philadelphia rows, and some rows elsewhere).
