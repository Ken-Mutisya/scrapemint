# Car Info & Safety Check: VIN Decoder & Recalls

Check any car for known safety problems and get its full details in seconds. Paste one car ID number (VIN) or thousands at once. No VIN? Just enter the make, model and year.

Built for **used car buyers, car dealers, fleet owners, marketplaces and insurers**. All data comes from official US government sources (NHTSA), so there is nothing to sign up for and no API key to manage.

## What you get for each car

- **Full details decoded from the VIN**: make, model, year, trim, body style, engine size and cylinders, fuel type, gearbox, drive type, doors, where it was built, and the manufacturer.
- **Known safety problems**: every open safety recall for that make, model and year, with the problem, the risk, the fix, and warnings like "do not drive" or "park outside".
- **Owner complaint count**: how many official complaints other owners filed about the same car.

## Two ways to use it

**1. By car ID number (VIN).** The 17 character number on the corner of the windshield or the driver door frame. Paste as many as you want, they are checked in bulk (thousands per run).

**2. By make, model and year.** No VIN needed. Get one row per safety problem, e.g. every recall on a 2020 Honda Civic.

## Example output (VIN mode)

```json
{
  "vin": "1FTFW1ET5EKE57182",
  "decoded": true,
  "make": "FORD",
  "model": "F-150",
  "modelYear": 2014,
  "bodyStyle": "Pickup",
  "driveType": "4WD/4-Wheel Drive/4x4",
  "engineCylinders": "6",
  "engineSizeL": "3.5",
  "fuelType": "Gasoline",
  "plantCountry": "UNITED STATES (USA)",
  "manufacturer": "FORD MOTOR COMPANY",
  "safetyProblemCount": 8,
  "safetyProblems": [
    {
      "campaignNumber": "16V643000",
      "component": "SERVICE BRAKES",
      "problem": "Brake fluid may leak from the brake master cylinder...",
      "risk": "A brake fluid leak can reduce braking performance...",
      "fix": "Dealers will replace the brake master cylinder, free of charge.",
      "reportedDate": "06/09/2016",
      "doNotDrive": false,
      "parkOutside": false
    }
  ],
  "complaintCount": 1450
}
```

## Pricing

You pay per car checked: **$0.005 per row**. The **first 2 rows of every run are free**, so you can test before you spend anything. Car ID numbers that cannot be decoded are always free.

| What you need | Typical alternative | This actor |
| --- | --- | --- |
| Decode 1,000 VINs | $10 to $50 at commercial VIN APIs, plus signup and key management | **$5, no signup** |
| Recall check per car | Manual lookups on the NHTSA site, one by one | Included in the same row |
| Complaint counts | Separate manual search | Included in the same row |

Note: this is spec and safety data, not an accident or title history report.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~car-safety-check/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vins": ["1HGCM82633A004352", "1FTFW1ET5EKE57182"]}'
```

Or by make, model and year:

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~car-safety-check/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"make": "Honda", "model": "Civic", "year": 2020}'
```

## How it works

```mermaid
flowchart LR
    A[Your VINs or make model year] --> B[Bulk VIN decode, 50 per call]
    B --> C[Safety recall lookup per make model year]
    C --> D[Owner complaint counts]
    D --> E[One clean row per car]
```

Safety lookups are cached within the run, so checking a fleet of 1,000 similar cars stays fast and cheap.

## Frequently asked questions

**Where is the data from?** The US National Highway Traffic Safety Administration (NHTSA): the vPIC vehicle database, the recall database and the complaint database. It covers cars sold in the US market.

**Does it work for motorcycles, trucks and buses?** Yes, anything with a VIN in the NHTSA database.

**Is this a vehicle history report?** No. It does not show accidents, previous owners or title status. It shows what the car is and which official safety problems apply to it.

## More tools from Scrapemint

- [Website Contact Scraper](https://apify.com/scrapemint/website-contact-scraper): emails, phones and social profiles from any website.
- [Domain WHOIS & Age Checker](https://apify.com/scrapemint/domain-whois-checker): age, registrar and owner info for any domain.
- [Government Tender Finder](https://apify.com/scrapemint/government-tender-finder): open government tenders from the EU, UK and World Bank.
