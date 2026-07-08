# FDA Medical Device Manufacturer Leads: Registered Firms

Turn the FDA device establishment registry into a targeted lead list. Every facility that makes, sterilizes, repackages, or specifies a medical device for the US market must register with the FDA, and that registry is public. Filter by state, FDA product code, and establishment type, and get one JSON row per firm with its address, the official correspondent's name and phone, and the devices it makes with their medical specialty and device class. Keyless official FDA API: no login, no browser, no data subscription.

Built for component and materials suppliers, contract manufacturers and sterilizers, testing labs, regulatory and QA consultants, and anyone whose customers are medical device companies.

## What you get

One row per establishment, with:

- `firmName`, `registrationNumber`, `feiNumber`, `ownerOperator`
- `establishmentType` (Manufacturer, Contract Sterilizer, Specification Developer, ...), `establishmentTypes`
- `contactName`, `contactPhone` (the official correspondent on file with the FDA)
- `address`, `city`, `state`, `zip`, `country`, `registrationExpiryYear`
- `deviceCount`, `medicalSpecialties`, `products` (product code, device name, class, regulation number)
- `matchedState`, `matchedProductCode`

## Input

- `states` (two-letter US codes; empty = all states and countries)
- `productCodes` (three-letter FDA device product codes, e.g. QAS, FPA)
- `establishmentType` (e.g. Manufacture Medical Device, Contract Manufacturer, Contract Sterilizer)
- `nameKeyword` (firm name contains)
- `usOnly` (exclude foreign establishments)
- `maxManufacturers` (default 50, up to 2000)
- `dedupe` (skip previously returned registrations; built for scheduled prospecting)

## Example input

```json
{
  "states": ["CA", "MA"],
  "establishmentType": "Manufacture Medical Device",
  "usOnly": true,
  "maxManufacturers": 200
}
```

## Example output

```json
{
  "firmName": "CareFusion",
  "registrationNumber": "3005938999",
  "establishmentType": "Manufacture Medical Device",
  "contactName": "Angela Caravella",
  "contactPhone": "2015746985",
  "address": "3750 Torrey View Court",
  "city": "San Diego",
  "state": "CA",
  "country": "US",
  "deviceCount": 4,
  "medicalSpecialties": ["General Hospital"],
  "products": [
    { "productCode": "FPA", "deviceName": "Set, Administration, Intravascular", "deviceClass": "2", "regulationNumber": "880.5440" }
  ]
}
```

## Uses

- Suppliers and contract services: every device maker in a state or category, with a named contact and phone
- Regulatory and QA consultants: firms by establishment type and device class, segmented by specialty
- Market research: count and map establishments by product code, state, or specialty
- Scheduled prospecting with `dedupe` on: only newly registered establishments each run
- Chain firm names into the Website Contact Scraper for outreach emails

## Pricing

Pay per establishment row: a higher rate for rows that include the official correspondent's name or phone, a lower rate for the rest. Searches that match nothing cost nothing, and the first 2 rows of every run are free so you can validate output before you scale up.

## Notes

- Data comes from openFDA's device registration and listing endpoint, built on the FDA establishment registry, and reflects what firms filed. Contact and phone coverage depends on what the FDA publishes (roughly 7 in 10 rows carry a correspondent in testing).
- Foreign establishments registered with the FDA are included unless `usOnly` is set.
- Each search returns up to 26,000 establishments; narrow by state or product code to go deeper into a large category.
