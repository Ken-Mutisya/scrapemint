# Car Fuel Economy Scraper: MPG, EV Range & CO2 by Model

Look up official fuel economy for any car sold in the US since 1984. Paste **"year make model"** lines and get one clean row per variant: city, highway and combined MPG, fuel type, EV range, CO2 per mile, annual fuel cost, engine and transmission — straight from the US EPA's official test data.

Built for **car dealers, listing sites, fleet buyers and car apps**. Turn an inventory list into complete fuel economy specs in one run, with no signup and no API key.

## What you get for each vehicle variant

- **cityMpg**, **highwayMpg**, **combinedMpg** (MPGe for electric vehicles)
- **fuelType** and **electricType** (hybrid, plug-in hybrid, EV, diesel, flex fuel)
- **evRangeMiles** for electric vehicles
- **co2GramsPerMile** and **ghgScore**: emissions for sustainability reporting
- **annualFuelCostUsd**: the EPA's estimated yearly fuel cost
- **cylinders**, **displacementLiters**, **drive**, **transmission**, **vehicleClass**
- **detailUrl**: the vehicle's official fueleconomy.gov page

## Example output

```json
{
  "input": "2023 Toyota Camry",
  "found": true,
  "year": 2023,
  "make": "Toyota",
  "model": "Camry",
  "variant": "Automatic (S8), 6 cyl, 3.5 L",
  "fuelType": "Regular",
  "cityMpg": 22,
  "highwayMpg": 33,
  "combinedMpg": 26,
  "co2GramsPerMile": 338,
  "annualFuelCostUsd": 2400,
  "detailUrl": "https://www.fueleconomy.gov/feg/Find.do?action=sf1&id=45719"
}
```

## How to write vehicle lines

- **"2023 Toyota Camry"**: returns every Camry variant that year (Camry, Camry AWD, Camry Hybrid...).
- **"2022 Tesla Model 3"**: trims count as models; this returns Long Range, Performance and RWD.
- **"2023 Honda"**: leave the model off to get every Honda model that year.
- Set **max rows per vehicle line** to control how many variants each line returns (default 10).

## Pricing

**$0.003 per vehicle variant found.** Lines that match nothing are **free**, and the first 2 rows of every run are free. Speccing a 500-car inventory costs about $1.50.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~car-fuel-economy-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vehicles": ["2023 Toyota Camry", "2022 Tesla Model 3"], "maxRowsPerVehicle": 10}'
```

## Frequently asked questions

**Where does the data come from?** The US EPA's [fueleconomy.gov](https://www.fueleconomy.gov) vehicle database, the official source of US fuel economy test results. Coverage runs from model year 1984 to the newest releases.

**Does it cover cars outside the US?** Only vehicles sold in the US market. European and Asian market versions of the same model can have different figures.

**Why does one line return several rows?** The EPA tests each engine, transmission and drive combination separately, and lists trims like "Model 3 Long Range AWD" as their own models. Each row is one tested variant.

**What are MPGe and EV range?** For electric and plug-in vehicles the MPG fields hold MPGe (miles per gallon equivalent), and `evRangeMiles` holds the official electric range.

## More tools from Scrapemint

- [Car Info & Safety Check](https://apify.com/scrapemint/car-safety-check): VIN decode, recalls and complaints for any US vehicle.
- [Product Recall Finder](https://apify.com/scrapemint/product-recall-finder): US food, drug and product recalls by keyword.
- [Currency Exchange Rates Scraper](https://apify.com/scrapemint/currency-exchange-rates-scraper): live and historical exchange rates.
