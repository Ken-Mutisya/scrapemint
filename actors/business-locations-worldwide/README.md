# Business Locations Worldwide: Shops, Restaurants, Services

Every restaurant, hotel, pharmacy, supermarket, bank, gym or charging point mapped in any city on earth, with the name, brand, address, phone, website, email and opening hours the map carries.

Name a city and the boundary is resolved for you, or pass your own bounding box or a radius around a point. No key, no login, no proxy.

## What you get

| Field | Meaning |
| --- | --- |
| `category`, `name`, `brand`, `operator` | What it is and who runs it |
| `latitude`, `longitude` | Exact position, including for premises mapped as building outlines |
| `street`, `houseNumber`, `postcode`, `cityName`, `country` | Address as mapped |
| `phone`, `website`, `email`, `openingHours` | Contact details where the map has them |
| `cuisine`, `wheelchair`, `takeaway`, `outdoorSeating` | Useful extras on hospitality listings |
| `hasWebsite`, `hasPhone` | Quick filters for outreach lists |
| `osmType`, `osmId`, `osmUrl` | The exact record, so anything can be checked or corrected at source |

## Categories

`restaurant`, `cafe`, `bar`, `pub`, `fast_food`, `hotel`, `guest_house`, `hostel`, `supermarket`, `convenience`, `bakery`, `butcher`, `clothing`, `hairdresser`, `beauty`, `pharmacy`, `doctor`, `dentist`, `hospital`, `veterinary`, `bank`, `atm`, `fuel`, `ev_charging`, `gym`, `coworking`, `car_dealer`, `car_repair`, `electronics`, `furniture`, `hardware`, `florist`, `optician`, `school`, `kindergarten`, `cinema`, `museum`.

## Example input

```json
{
  "city": "Lisbon, Portugal",
  "categories": ["restaurant", "cafe", "hotel"],
  "maxResults": 150
}
```

An outreach list of gyms with a phone number, in a precise rectangle:

```json
{
  "boundingBox": "40.70,-74.02,40.78,-73.95",
  "categories": ["gym", "coworking"],
  "requirePhone": true
}
```

Every Starbucks within 3km of a point:

```json
{
  "latitude": "52.52",
  "longitude": "13.405",
  "radiusMeters": 3000,
  "categories": ["cafe"],
  "brand": "Starbucks"
}
```

## Three things worth knowing

**Results are ranked by how complete the listing is, not by map order.** The map server returns every point first and every building outline afterwards, so a capped run taken in that order would hand back only points and quietly drop the businesses mapped as outlines, which skews against larger premises. Ranking by completeness fixes both problems at once: in testing, an 80 row run went from zero building-outline records and patchy contacts to every single row carrying both a website and a phone number.

**Contact coverage varies, and that is the honest trade-off.** This is community maintained mapping, so a chain café in a capital city usually carries phone, website, email and opening hours, while a small independent may carry only a name and a position. Use `requireWebsite` or `requirePhone` when the output feeds outreach, and expect a smaller, richer list.

**The map servers are free community infrastructure.** They are occasionally busy and answer with an error page rather than data, so this actor rotates across several and reports plainly when they are all unavailable rather than returning an empty result as if the area were empty. Smaller areas always run faster and fail less.

## Pricing

Pay per place, `$0.006`. The first 2 rows of every run are free. Unknown categories, areas with nothing mapped, and runs where every server was busy return a free note and are never charged.

## Attribution

Data from OpenStreetMap contributors, available under the Open Database Licence. Every row carries the `osmUrl` of the underlying record.

## Related actors

- **Website Contact Scraper** to enrich the websites this returns with more contact details
- **Local Lead Pipeline** for a fuller lead workflow
- **Global Company Verification** to confirm a company's legal registration
