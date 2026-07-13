# Home Prices & Listings Scraper: Redfin Homes by Area

Get every home for sale in any US area. Paste the Redfin link for a city, zip code, neighborhood or county (or just a 5 digit zip code) and get one clean row per home.

Built for **real estate investors, agents, analysts and anyone researching a market**. Checking listings one by one takes hours; this pulls a whole area in one run, ready for a spreadsheet.

## What you get for each home

- **Price**, and price per square foot
- **Beds, baths, size, lot size, year built**
- **HOA fee per month** where there is one
- **Days on market**, and the date the home last changed hands
- **New construction flag**
- **Exact GPS location** (latitude, longitude) for maps
- **MLS number and the listing link**

## How to point it at an area

1. Go to redfin.com, search your area, copy the page link, e.g. `https://www.redfin.com/city/30818/TX/Austin`. City, zip, neighborhood and county pages all work.
2. Or skip that and just enter a 5 digit zip code like `78701`.

Filters: min and max price, min bedrooms, home type (house, condo, townhouse, multi family, land).

## Example output

```json
{
  "area": "https://www.redfin.com/city/30818/TX/Austin",
  "address": "3501 Mt Bonnell Rd",
  "city": "Austin",
  "state": "TX",
  "zip": "78731",
  "price": 9925000,
  "beds": 5,
  "baths": 5.5,
  "squareFeet": 6100,
  "pricePerSquareFoot": 1627,
  "yearBuilt": 2016,
  "hoaPerMonth": null,
  "daysOnMarket": 12,
  "latitude": 30.32,
  "longitude": -97.77,
  "mlsNumber": "5061725",
  "url": "https://www.redfin.com/TX/Austin/3501-Mt-Bonnell-Rd-78731/home/31558906"
}
```

## Pricing

**$0.005 per home.** The **first 2 rows of every run are free**. A full city run (up to 350 homes per area) costs at most $1.75; a zip code run usually costs cents. Compare that with paid MLS data feeds that start at hundreds of dollars per month.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~home-listings-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"areas": ["78701"], "maxPrice": 800000, "minBeds": 2}'
```

## Frequently asked questions

**How many homes per area?** Up to 350 per area per run (the source caps it). Add more zip codes to cover a big city fully; zips are the sharpest tool.

**Sold homes and rentals?** Not in this version, for sale listings only. Each row does include the date the home last changed hands where known.

## More tools from Scrapemint

- [Website Change Monitor](https://apify.com/scrapemint/website-change-monitor): watch any listing page for changes.
- [Building Permit Leads](https://apify.com/scrapemint/building-permit-leads): fresh building permits from city portals.
- [New Business Registration Leads](https://apify.com/scrapemint/new-business-registration-leads): newly registered companies by state.
