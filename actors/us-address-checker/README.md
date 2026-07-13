# US Address Checker & GPS Finder: Verify & Geocode

Check US addresses in bulk. Paste one address or thousands and get one clean row per address: is it real, the cleaned up official version, and its exact GPS location for maps. Plus the county, official city, congressional district and census tract when you want them.

Built for **real estate and logistics teams, mailing list owners, market researchers and app builders**. Built on the official US Census Bureau geocoder, so there is no API key, no signup and no per-seat license.

## What you get for each address

- **Found or not**: instantly flags addresses that do not exist.
- **The cleaned official version**: "1600 pennsylvania ave washington dc" becomes "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500".
- **GPS location** (latitude, longitude) ready for maps and routing.
- **Area info** (on by default): county with FIPS code, official city or town, congressional district and census tract, the fields analysts join demographics on.

## Example output

```json
{
  "input": "1600 Pennsylvania Ave NW, Washington, DC",
  "matched": true,
  "cleanAddress": "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500",
  "latitude": 38.89869893252,
  "longitude": -77.03518753691,
  "city": "WASHINGTON",
  "state": "DC",
  "zip": "20500",
  "county": "District of Columbia",
  "countyFips": "11001",
  "officialPlace": "Washington city",
  "congressionalDistrict": "Delegate District (at Large)",
  "censusTract": "11001980000"
}
```

## Pricing

**$0.001 per address found**, and addresses that cannot be found are **free**, so cleaning a dirty list never costs you for the bad rows. The first 2 rows of every run are free.

| List size | Typical geocoding service | This actor |
| --- | --- | --- |
| 1,000 addresses | $0.50 to $5, signup and API key required | **$1, no signup** |
| 10,000 addresses | $5 to $50 plus monthly minimums | **$10 or less** |

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~us-address-checker/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addresses": ["350 5th Ave, New York, NY 10118", "1 Apple Park Way, Cupertino, CA"]}'
```

## Frequently asked questions

**Does it work outside the US?** No, US addresses only (including DC and Puerto Rico). That is what the Census geocoder covers.

**How accurate is it?** It matches against the Census Bureau's national address database, the same data behind official statistics. Addresses it cannot match are flagged rather than guessed.

**What is a census tract and why would I care?** It is the small area code that all US demographic data is published against. With it you can join income, population and housing stats onto your address list.

## More tools from Scrapemint

- [Home Prices & Listings Scraper](https://apify.com/scrapemint/home-listings-scraper): US homes for sale by area.
- [Email List Checker](https://apify.com/scrapemint/email-list-checker): clean email lists in bulk.
- [Healthcare Provider Leads](https://apify.com/scrapemint/healthcare-provider-leads): US healthcare provider contacts by specialty and state.
