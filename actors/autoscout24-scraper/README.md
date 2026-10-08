# AutoScout24 Scraper: Cars, Prices & Dealer Phones

Car listings from **AutoScout24**, Europe's largest car marketplace, as clean rows: make, model, version, **price and AutoScout24's market price band**, mileage, first registration, fuel, gearbox, power, condition, location, and the **seller with dealer name, phone numbers and rating**. Turn on details for the description, full equipment list, body, colour, seats, emissions, coordinates and listing date.

Germany, Italy, France, Spain, the Netherlands, Belgium, Austria and Luxembourg. Paste a search URL from any AutoScout24 site with any filters, or pick make, model and filters here. AutoScout24 shows 4,000 cars per search; bigger searches are **split by price automatically**, so one run can export a whole model.

No API key, no login, no proxy. $0.0005 per car, no start fee.

## What you get per car

- `title`, `url`, `listingId`, `make`, `model`, `modelGroup`, `variant`, `version`
- `price`, `priceFormatted`, `currency`, `priceRatingScore`
- `mileageKm`, `firstRegistration` (YYYY-MM), `firstRegistrationYear`
- `fuel`, `transmission`, `power`, `powerKw`, `powerHp`, `engineCc`
- `condition` (used, new, demonstration, pre-registered, employee car, classic), `isDamaged`
- `countryCode`, `zip`, `city`, `street`
- `sellerType` (dealer or private), `sellerName`, `sellerContact`, `sellerPhones`, `sellerPage`, `sellerRating`, `sellerRatingCount`
- `images` (full size), `equipmentSummary`, `leadsRange`

With **Full specs and description** on:

- `description`, `equipment` (every item, e.g. Apple CarPlay, 360° camera, heated seats)
- `bodyType`, `bodyColor`, `paintType`, `upholstery`, `seats`, `doors`, `driveTrain`, `gears`, `cylinders`, `weightKg`
- `co2GPerKm`, `fuelConsumption`, `electricRangeKm`, `emissionClass`
- `previousOwners`, `hadAccident`, `hasFullServiceHistory`, `nonSmoking`, `productionYear`, `hasWarranty`
- `latitude`, `longitude`, `marketMedianPrice`, `priceNegotiable`, `vatDeductible`, `listedAt`
- `sellerRatingAverage`, `sellerRecommendPercent`

## Example input

A search copied from the site, with its filters:

```json
{
  "searchUrls": ["https://www.autoscout24.de/lst/bmw/3er?atype=C&cy=D&fregfrom=2019&kmto=100000&fuel=D"]
}
```

Used Golfs and 3 Series from dealers in Germany and Austria, petrol or diesel, automatic, 2018 or newer:

```json
{
  "makes": ["Volkswagen / Golf", "BMW / 3 Series"],
  "countries": ["D", "A"],
  "offerTypes": ["U"],
  "sellerType": "D",
  "fuelTypes": ["B", "D"],
  "gearbox": "A",
  "yearFrom": 2018
}
```

Every Tesla within 100 km of Munich, with full specs:

```json
{
  "makes": ["Tesla"],
  "countries": ["D"],
  "zip": "80331",
  "radiusKm": 100,
  "includeDetails": true
}
```

## Example output

```json
{
  "listingId": "f9d44dd2-404a-42a6-a61c-72a90455ae14",
  "url": "https://www.autoscout24.com/offers/bmw-318-i-leder+cabrio+applecarplay+h-faehig-gasoline-green-cat_ma13mo1640-f9d44dd2-404a-42a6-a61c-72a90455ae14",
  "title": "BMW 318 i Leder+Cabrio+AppleCarplay+H-fähig",
  "make": "BMW",
  "model": "318",
  "modelGroup": "3 Series",
  "variant": "Convertible",
  "price": 5950,
  "priceFormatted": "€ 5,950",
  "currency": "EUR",
  "mileageKm": 222500,
  "firstRegistration": "1996-08",
  "fuel": "Gasoline",
  "transmission": "Automatic",
  "power": "85 kW (116 hp)",
  "powerKw": 85,
  "powerHp": 116,
  "engineCc": 1796,
  "condition": "used",
  "countryCode": "DE",
  "zip": "97437",
  "city": "Haßfurt",
  "sellerType": "dealer",
  "sellerName": "Wuerfel-S Individual Cars",
  "sellerPhones": [{ "type": "Office", "number": "+4995216029135" }, { "type": "Mobile", "number": "+4915115654157" }],
  "sellerRating": 5,
  "sellerRatingCount": 3
}
```

## Uses

- **Dealers and traders:** price your stock against the market, find underpriced cars the minute they are listed
- **Lead generation:** dealer names, phone numbers and dealer pages by brand and region
- **Market research and leasing companies:** asking prices by model, year, mileage and country; residual value tracking over time
- **Exporters and importers:** compare the same model across eight countries
- **Price monitoring:** schedule a search and watch for new listings and price drops

## Pricing

- **$0.0005** per car
- **$0.0015** per car with Full specs and description on (instead of $0.0005, not on top)
- No start fee. A search with no results is free.

## Notes

- `priceRatingScore` is AutoScout24's market band for the car, from 0 (cheapest against similar cars) to 6 (most expensive). Only the country sites publish it: set Site to autoscout24.de (or .it, .fr...) or paste a URL from a country site. It is empty on autoscout24.com and when AutoScout24 does not rate the car.
- Make and model names are read the way AutoScout24 writes them in English (BMW / 3 Series, Mercedes-Benz / C-Class). If a model is not recognised, the run log says so; paste a search URL for that one.
- Built searches use the site you pick (autoscout24.com by default, with English labels). A pasted URL keeps its site's language. Model names follow the site: "BMW / 3 Series" on .com, "BMW / 3er" on .de.
- Sponsored cars can appear on several result pages; each car is kept once.
