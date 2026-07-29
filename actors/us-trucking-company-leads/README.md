# US Trucking Company Leads: New Carriers and Contacts

Every trucking company operating in the United States has to register with the
FMCSA and keep a census record current. That census is public and updated daily.
This actor turns it into a lead list: **around 390 new active carriers register
every day**, most of them one to three trucks, and the recent ones almost always
publish a phone number and an email.

Built for the people who sell to carriers in their first weeks: freight brokers,
factoring companies, truck insurance agents, ELD and telematics vendors, fuel
card programmes and load boards.

## Modes

| Mode | What you get |
| --- | --- |
| `newCarriers` | Companies registered in the last N days, newest first. The default. |
| `search` | Every carrier matching your filters, regardless of registration date. |
| `lookup` | Specific carriers by USDOT number. |

## Filters

- **states** — two letter codes, for example `["TX", "CA"]`. Empty means all.
- **minPowerUnits / maxPowerUnits** — fleet size in trucks and tractors. Set
  `minPowerUnits: 6` to skip owner-operators, or `maxPowerUnits: 1` to target
  only them.
- **carrierOperation** — interstate carriers cross state lines and are the
  larger buying market.
- **requireContact** — on by default. You are never billed for a carrier you
  cannot phone or email.
- **includeInactive** — off by default. Half the census is companies that no
  longer operate.

## Output

One row per carrier:

```json
{
  "dotNumber": "4312887",
  "legalName": "GRIMOR LOGISTICS LLC",
  "dbaName": null,
  "phone": "8177277377",
  "email": "dispatch@example.com",
  "contactName": "MORALES",
  "physicalAddress": { "street": "...", "city": "FORT WORTH", "state": "TX", "zip": "76108", "country": "US" },
  "mailingAddress":  { "street": "...", "city": "FORT WORTH", "state": "TX", "zip": "76108", "country": "US" },
  "powerUnits": 2,
  "truckUnits": 2,
  "totalDrivers": 2,
  "cdlDrivers": 2,
  "fleetBand": "micro (2-5)",
  "operatingStatus": "active",
  "carrierOperation": "interstate",
  "businessType": "LLC",
  "carriesHazmat": false,
  "carriesGeneralFreight": true,
  "registeredDate": "2026-07-27",
  "lastCensusUpdate": "2026-07-27",
  "saferUrl": "https://safer.fmcsa.dot.gov/query.asp?...",
  "source": "FMCSA Company Census (datahub.transportation.gov)"
}
```

`fleetBand` is precomputed (`owner-operator`, `micro (2-5)`, `small (6-20)`,
`medium (21-100)`, `large (100+)`) because a one-truck operation buys very
differently from a fifty-truck fleet.

Missing numbers come back as `null`, never `0`. A carrier with no fleet figure
in the census and a carrier that genuinely reports zero trucks are different
facts, and both are billable rows, so they are kept distinct.

## Pricing

`carrier_row` at $0.02 per carrier. **The first 2 rows of every run are free**,
and note rows are never charged. With `requireContact` left on, a row is only
ever billed if it carries a phone or an email.

## Notes on the data

- Roughly half the census is inactive carriers. They are excluded unless you ask
  for them.
- FMCSA leaves its own test records in the live dataset. They are detected and
  dropped rather than sold to you as leads.
- A carrier can appear more than once across pages; rows are deduplicated by
  DOT number so you are not billed twice for the same company.
- Contact coverage is far better for recent registrations than for the census as
  a whole, because current registration requires it. Across all 4.4 million
  records phone is about 53 percent and email about 18 percent; among carriers
  registered in the last 30 days both are close to complete.

Source: FMCSA Company Census, `datahub.transportation.gov`. Public data, no API
key, no account.
