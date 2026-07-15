# Postal Code Checker: Global ZIP & Postcode Lookup

Validate and enrich postal codes for **121 countries** in one run. Paste codes like `US 90210`, `DE 10115` or `GB SW1A 1AA` and get one clean row per code: place name, region, district and GPS coordinates — matched against a bundled open dataset of **1.8 million postal codes**, with no network calls, no signup and no API key.

Built for **e-commerce checkout validation, logistics and shipping teams, CRM and mailing list cleaning**. Works for any country's codes in the same run: US ZIP codes, UK postcodes, EU codes, Japanese, Kenyan, Indian and more.

## What you get for each code

- **countryCode** and **countryName**
- **placeName**, **region**, **district**: where the code points
- **latitude** and **longitude**: for mapping, routing and distance math
- **places** and **placeCount**: every locality sharing the code (up to 20)
- **matchedBy**: how the match was made (exact, or a documented fallback)

## Example output

```json
{
  "input": "US 90210",
  "found": true,
  "countryCode": "US",
  "countryName": "United States",
  "postalCode": "90210",
  "matchedBy": "exact",
  "placeName": "Beverly Hills",
  "region": "California",
  "latitude": 34.0901,
  "longitude": -118.4065,
  "placeCount": 1
}
```

## How to write code lines

- **With a country (recommended)**: `US 90210`, `JP 100-0001`, `KE 00100`. Exact and fast.
- **Bare code**: `90210` returns a row for **every country** that uses it (90210 exists in the US, Kenya, Mexico, Thailand and more). Set **default country** to pin bare codes to one country.
- **Full UK and Canadian codes work**: `GB SW1A 1AA` matches the outward part (`SW1A`), `CA K1A 0B1` matches the FSA (`K1A`) — the row's `matchedBy` field tells you.

## Pricing

**$0.002 per matched code.** Codes that match nothing are **free**, and the first 2 rows of every run are free. Cleaning a 10,000-address CRM list costs about $20, versus per-seat subscriptions of address-validation SaaS.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~postal-code-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"codes": ["US 90210", "DE 10115", "GB SW1A 1AA"]}'
```

## Frequently asked questions

**Where does the data come from?** The [GeoNames](https://www.geonames.org) postal code dataset (1.8M codes, 121 countries), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The dataset is bundled inside the actor, so runs make zero network calls and always return in seconds.

**What granularity should I expect?** Most countries are covered at full postal code level. Known exceptions: UK codes resolve to the outward part (`SW1A`), Canadian codes to the FSA (`K1A`), and Brazil to municipality-level CEPs only (street-level CEPs like `01310-100` in big cities return not found, free).

**Does it verify that a street address exists?** No — it validates and enriches the postal code itself. Pair it with our US Address Checker for full US address verification.

**A code I know exists returned not found.** Newly introduced codes appear in the dataset with some lag, and a few countries have partial coverage. Those rows are free and marked `found: false`.

## More tools from Scrapemint

- [Email List Checker](https://apify.com/scrapemint/email-list-checker): DNS-level validation for email lists.
- [Phone Number Checker](https://apify.com/scrapemint/phone-number-checker): validate and type phone numbers for any country.
- [US Address Checker & GPS Finder](https://apify.com/scrapemint/us-address-checker): full US street address verification.
- [EU VAT Number Checker](https://apify.com/scrapemint/vat-number-checker): validate EU VAT numbers with company names.
