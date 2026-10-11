# Fotocasa Scraper: Spain Property Listings & Prices

Property listings from **fotocasa.es**, one of Spain's largest property portals, for sale and for rent: **price and price per m²**, price reduction, size, bedrooms, bathrooms, **floor**, **condition**, street, neighbourhood, district, city, province, postcode, **GPS coordinates**, features (lift, parking, terrace, pool, air conditioning...), the **agency's name and phone number**, all photos and the full listing description.

Search by city or province, or paste any Fotocasa search URL with your filters, drawn zones or neighbourhoods. Fotocasa lets you page to the end of every search (Madrid alone has 12,000+ homes for sale), 100 listings per request.

No Fotocasa account, no API key, no proxy. $0.0015 per listing, no start fee.

## What you get per listing

- `listingId`, `url`, `operation` (sale or rent)
- `price`, `priceCurrency`, `priceReduction`, `pricePerM2`
- `sizeM2`, `rooms`, `bathrooms`, `floor`, `floorLabel`, `propertySubtype`, `condition`
- `hasElevator`, `hasParking`, `hasTerrace`, `hasBalcony`, `hasGarden`, `hasPool`, `hasAirConditioning`, `hasHeating`, `isNewBuild`
- `street`, `neighbourhood`, `district`, `city`, `province`, `region`, `zipCode`, `latitude`, `longitude`
- `advertiserName`, `advertiserPhone`, `advertiserUrl`, `advertiserId`
- `publishedAt`, `isHighlighted`, `hasVirtualTour`, `photoCount`, `photos`
- `description`

## Example input

Flats to rent in Sevilla and Málaga under €1,500 with 2+ bedrooms, newest first:

```json
{
  "locations": ["Sevilla", "Málaga"],
  "operation": "rent",
  "maxPrice": 1500,
  "minRooms": 2,
  "sortBy": "newest"
}
```

Every home for sale in Madrid under €400,000:

```json
{
  "locations": ["Madrid"],
  "maxPrice": 400000,
  "maxItemsPerSearch": 5000
}
```

A search URL copied from fotocasa.es (neighbourhoods, drawn areas and any filter work):

```json
{
  "searchUrls": ["https://www.fotocasa.es/es/comprar/viviendas/barcelona-capital/todas-las-zonas/l?maxPrice=600000&minRooms=3"]
}
```

## Example output

```json
{
  "listingId": 189316512,
  "url": "https://www.fotocasa.es/es/comprar/vivienda/madrid/aire-acondicionado-calefaccion-amueblado/189316512/d",
  "operation": "sale",
  "price": 369000,
  "priceCurrency": "EUR",
  "priceReduction": 40000,
  "pricePerM2": 6150,
  "sizeM2": 60,
  "rooms": 2,
  "bathrooms": 2,
  "floor": 0,
  "floorLabel": "ground floor",
  "propertySubtype": "flat",
  "condition": "very good",
  "hasAirConditioning": true,
  "street": "Calle de Los Relatores, Centro",
  "neighbourhood": "Embajadores - Lavapiés",
  "district": "Centro",
  "city": "Madrid Capital",
  "zipCode": "28012",
  "latitude": 40.41317,
  "longitude": -3.7032464,
  "advertiserName": "ENGEL & VÖLKERS MADRID",
  "advertiserPhone": "+34912774500",
  "publishedAt": "2026-04-08T11:16:19.933Z",
  "photoCount": 21,
  "description": "Engel&Völkers comercializa este acogedor apartamento de 60 m2 ..."
}
```

## Uses

- **Investors and analysts:** price per m² by neighbourhood, rental yields (run sale and rent for the same area), price cuts
- **Agencies and proptech:** competitor stock, new listings every day with **Newest first** on a schedule, agency phone numbers for outreach
- **Relocation and tenants:** every flat that matches, with coordinates for mapping
- **Market research:** stock, condition and size mix across Spanish cities and provinces

## Pricing

- **$0.0015** per listing, description, photos and phone included
- No start fee. A search with no results is free.

## Notes

- Locations are matched to Fotocasa's own place pages: a name like "Sevilla" is tried as the town, then "-capital", then "-provincia". For a neighbourhood or a drawn area, paste the search URL.
- Features such as `hasElevator` are `true` when the listing states them and `null` when it does not say.
- `floor` is a number (0 is ground floor, -1 basement); floors 15 and up show as `floorLabel: "15th floor or higher"`.
- A listing that appears in two of your searches is kept once.
