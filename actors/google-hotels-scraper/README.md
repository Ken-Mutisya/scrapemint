# Google Hotels Scraper: Prices & Booking Sites

Hotels and prices from **Google Hotels** for any city, search or specific hotel and **your dates**, as clean rows: **nightly and total price with and without taxes**, Google's **"X% less than usual"** price insight, star class, **rating with 1-5 star breakdown** and review topics, amenities, coordinates, check-in times, website and nearby places.

Turn on **Every booking site's price** to get, per hotel, the price on **Booking.com, Expedia, Agoda, Hotels.com, Trip.com, Priceline, the hotel's own site** and 10-25 more, each with its booking link, plus address and phone.

Track one hotel across many dates to build a **price calendar**, or compare a whole city across weekends.

No Google account, no API key, no proxy. $0.002 per hotel, no start fee.

## What you get per hotel

- `hotelId`, `name`, `url`, `hotelClass` (1-5), `hotelClassText`, `propertyType`
- `pricePerNight`, `pricePerNightBeforeTaxes`, `priceTotal`, `priceTotalBeforeTaxes`, `taxesTotal`, `currency`, `priceText`, `priceTotalText`
- `priceInsight` (e.g. "23% less than usual")
- `rating`, `reviewCount`, `ratingBreakdown` (count per star), `reviewTopics` (Location, Cleanliness, Service... with positive and negative mentions)
- `amenities` (Free Wi-Fi, Breakfast ($), Pool, Parking, Pet-friendly...)
- `latitude`, `longitude`, `countryCode`, `checkInTime`, `checkOutTime`, `website`, `nearby` (transit and airports with walk, transit and drive times)
- `description`, `thumbnail`, `googleMapsPlaceId`
- `checkIn`, `checkOut`, `nights`, `adults`, `search`, `searchQuery`

With **Every booking site's price** on, also:

- `offers`: one entry per booking site with `site`, `isOfficialSite`, `pricePerNight`, `pricePerNightBeforeTaxes`, `priceTotal`, `priceTotalBeforeTaxes`, `bookingUrl`
- `offerCount`, `cheapestSite`, `address`, `phone`, `area`, `longDescription`

## Example input

Up to 100 hotels in Lisbon for 2 nights from 10 November:

```json
{
  "locations": ["Lisbon"],
  "checkIn": "2026-11-10",
  "nights": 2,
  "maxHotelsPerLocation": 100
}
```

One hotel's price on every booking site, for four weekends (a price calendar):

```json
{
  "hotels": ["Hilton Paris Opera"],
  "checkInDates": ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"],
  "nights": 2,
  "currency": "EUR",
  "includeBookingOffers": true
}
```

Your own Google Hotels searches:

```json
{
  "queries": ["hotels near Eiffel Tower", "beach resorts in Phuket"],
  "checkIn": "2026-12-20",
  "nights": 5,
  "adults": 2
}
```

## Example output

```json
{
  "name": "Hilton Paris Opera",
  "url": "https://www.google.com/travel/hotels/entity/ChoIkoe_uKT777foARoNL2cvMTFiNnpyNG0xNhAB",
  "hotelClass": 4,
  "rating": 4.3,
  "reviewCount": 3466,
  "pricePerNight": 540,
  "pricePerNightBeforeTaxes": 521,
  "priceTotal": 1620.06,
  "taxesTotal": 56.81,
  "currency": "USD",
  "checkIn": "2026-12-01",
  "checkOut": "2026-12-04",
  "address": "108 Rue Saint-Lazare, 75008 Paris, France",
  "phone": "+33 1 40 08 44 44",
  "website": "https://www.hilton.com/en/hotels/parophi-hilton-paris-opera/",
  "offerCount": 14,
  "cheapestSite": "Pilot",
  "offers": [
    { "site": "Pilot", "isOfficialSite": false, "pricePerNight": 540, "priceTotal": 1620.06, "bookingUrl": "https://pilotplans.com/stays/hilton-paris-opera-..." }
  ]
}
```

## Uses

- **Hotel revenue managers:** your rate vs. competitors and vs. every OTA, per date, on a schedule
- **Travel agencies and deal sites:** the cheapest booking site per hotel, and hotels priced below their usual rate
- **Rate parity checks:** is the official site cheaper than Booking.com and Expedia?
- **Market research:** price levels, star mix and ratings across a city or neighbourhood
- **Travel apps and AI agents:** clean hotel and price data for any destination and dates

## Pricing

- **$0.002** per hotel per check-in date
- **$0.004** per hotel per date with every booking site's price (instead of $0.002, not on top)
- No start fee. A search with no results is free.

## Notes

- Google shows about 20 hotels per search page. For a city, the actor runs several queries Google understands (by star class, budget, hostels, pool, city centre...) and keeps each hotel once, which gives around 200 hotels for a large city (192 for Lisbon in testing).
- `pricePerNight` and `priceTotal` include taxes and fees where Google shows them; the `BeforeTaxes` fields are the base rate.
- A hotel with no availability for your dates has empty prices.
- Prices are for one room for the number of adults set; Google's lowest price can change between runs as booking sites update.
