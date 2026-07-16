# Aircraft Owner Leads: FAA Registration Lookup

Every civil aircraft in the United States is registered with the FAA, and the registry is public: owner name, mailing address, aircraft make and model, year, engine, and registration dates. This actor reads the FAA's official daily database release and turns it into clean owner rows, either for specific tail numbers or as filtered lead lists.

Aviation marketing list vendors charge hundreds of dollars for exactly this data. Here you pay per row, from the primary source, updated daily.

## Two modes

**Tail number lookup** - give it N-numbers (`N12345` or `12345`), get the owner and aircraft behind each one. Unknown tail numbers come back as free note rows.

**Filtered lead lists** - leave `nNumbers` empty and combine filters:

- `states` - two-letter codes (TX, FL, CA)
- `manufacturer` - name contains (CESSNA, PIPER, BEECH, CIRRUS, ROBINSON)
- `yearMin` / `yearMax` - year of manufacture range
- `registrantTypes` - individuals, corporations, LLCs, government, and more

## What you get

One row per aircraft:

| Field | Description |
| --- | --- |
| `nNumber`, `serialNumber` | Registration and airframe serial |
| `ownerName`, `ownerType` | Registered owner and registrant category |
| `street`, `street2`, `city`, `state`, `zip`, `country` | Owner mailing address |
| `aircraftManufacturer`, `aircraftModel`, `seats` | From the FAA aircraft reference |
| `aircraftType` | Fixed wing single/multi engine, rotorcraft, balloon, glider... |
| `yearManufactured` | Year built |
| `engineManufacturer`, `engineModel`, `engineType` | From the FAA engine reference |
| `airworthinessDate`, `certIssueDate`, `expirationDate`, `lastActionDate` | Registration dates |
| `registrationStatus` | FAA status code (V = valid) |
| `modeSHex` | Mode S transponder code, joins to ADS-B data |

## Typical uses

- **Aviation insurance agents**: owners of aging aircraft in your state, by year range.
- **FBOs, maintenance shops, avionics installers, detailing**: every owner within the states you serve.
- **Parts dealers**: owners of a specific airframe (all CESSNA 182 owners, all ROBINSON R44 owners).
- **Aircraft brokers**: individual owners of a model you have buyers for.
- **Researchers and journalists**: who owns what, joined to flight tracking via the Mode S code.

## Pricing

You pay per aircraft row returned (`aircraft_row`). The first 2 rows of every run are free. Tail numbers that are not in the registry cost nothing.

## Input example

```json
{
    "states": ["TX", "OK"],
    "manufacturer": "CESSNA",
    "yearMin": 1970,
    "yearMax": 1990,
    "registrantTypes": ["individual"],
    "maxRows": 200
}
```

## Notes

- Data is the FAA's Releasable Aircraft Database, refreshed by the FAA every day. Addresses are the registered mailing addresses; the FAA publishes this as public record.
- Deregistered aircraft are not included (they leave the registry).
- The registry stores tail numbers without the leading N; the actor accepts both forms.
