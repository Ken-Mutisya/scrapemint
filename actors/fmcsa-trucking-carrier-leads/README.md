# FMCSA Trucking Carrier Leads: New DOT Carriers

Get every new trucking company the day FMCSA registers it, with **phone, email, company officers, address, fleet size, drivers, cargo types and MC docket**. Filter by state, fleet size, cargo and for-hire status, or look up any USDOT number, MC number or company name.

Data comes from FMCSA's official Company Census File on the US DOT open-data portal, refreshed daily. No API key, no login, no SAFER scraping.

## Who uses it

- **Truck insurance agents**: new authorities need liability and cargo cover before they can haul
- **Freight factoring and fuel card companies**: reach owner-operators in their first weeks
- **ELD, dispatch, TMS and compliance services**: new carriers must set all of this up
- **Truck and trailer dealers, leasing**: fleet size and cargo tell you what they run
- **Freight brokers**: find carriers by state, cargo type and fleet size

## What you get

One row per carrier:

- `dotNumber`, `legalName`, `dbaName`, `status`, `addedDate`, `mcs150Date`
- `email`, `phone`, `cellPhone`, `fax`, `officer1`, `officer2`, `businessType`
- `street`, `city`, `state`, `zip`, plus the mailing address
- `operation` (interstate / intrastate), `classifications`, `authorizedForHire`, `hazmat`
- `powerUnits`, `trucks`, `buses`, `totalDrivers`, `cdlDrivers`, `operatingRadius`
- `cargoTypes` (general freight, refrigerated food, building materials, ...)
- `dockets`, `mcNumber`, `safetyRating`, `mileage`, `saferUrl`

## Example input

Owner-operators hauling for hire in Texas and Florida, registered this week:

```json
{
  "mode": "new",
  "addedWithinDays": 7,
  "states": ["TX", "FL"],
  "authorizedForHireOnly": true,
  "maxPowerUnits": 2,
  "requireEmail": true
}
```

Look up carriers:

```json
{ "mode": "lookup", "dotNumbers": ["1198688"], "mcNumbers": ["1234567"], "companyNames": ["SWIFT TRANSPORTATION"] }
```

Cargo types: `general_freight`, `household_goods`, `metal_sheets_coils`, `motor_vehicles`, `driveaway_towaway`, `logs_poles_lumber`, `building_materials`, `mobile_homes`, `machinery_large_objects`, `fresh_produce`, `liquids_gases`, `intermodal_containers`, `passengers`, `oilfield_equipment`, `livestock`, `grain_feed_hay`, `coal_coke`, `meat`, `garbage_refuse`, `us_mail`, `chemicals`, `dry_bulk`, `refrigerated_food`, `beverages`, `paper_products`, `utilities`, `agricultural_supplies`, `construction`, `water_well`, `other`.

## Example output

```json
{
  "dotNumber": "6905713",
  "legalName": "WE FIX CARS NOW LLC",
  "status": "Active",
  "addedDate": "2026-11-15",
  "email": "...",
  "phone": "+1773...",
  "officer1": "PATRICK ZAPART",
  "city": "ARLINGTON HEIGHTS",
  "state": "IL",
  "operation": "Interstate",
  "classifications": ["PRIVATE PROPERTY", "AUTHORIZED FOR HIRE"],
  "authorizedForHire": true,
  "powerUnits": 3,
  "totalDrivers": 4,
  "cargoTypes": ["General freight"]
}
```

## Pricing

Pay per carrier row. The first row of every run is free, so you can check the fields before paying.

## Notes

- New carriers appear about 1 to 2 days after FMCSA registers them. Around 300 to 400 new carriers a day.
- Contact details are what the carrier filed on its MCS-150. Respect the CAN-SPAM Act and TCPA when you contact them.
- Run it daily with `addedWithinDays: 1` on a schedule to get a fresh lead list every morning.
- Also see [New Business Registration Leads](https://apify.com/scrapemint/new-business-registration-leads) and [Florida Sunbiz New Business Leads](https://apify.com/scrapemint/florida-sunbiz-new-business-leads).
