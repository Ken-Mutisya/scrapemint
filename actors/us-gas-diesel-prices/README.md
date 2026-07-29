# US Gas & Diesel Prices: Weekly Retail by Region and Grade

The official weekly survey of what American drivers actually pay at the pump, as clean rows: **national, the refining districts, nine states and ten cities**, for every grade of gasoline and for diesel.

No API key, no login, no browser.

## Why this exists

The agency publishes this as **legacy Excel workbooks, not an API** — there is no CSV and no JSON endpoint. Getting a usable table out of them means parsing twelve sheets of spreadsheet, decoding Excel date serials, and untangling series titles. That is the work this does.

## Modes

- **Prices** - one row per area at the latest published week: price, the move on the week and on the year, the 52 week high and low, the **spread against the national average**, and a rank from most to least expensive.
- **History** - one row per area per week over any range.
- **Series** - the catalogue of areas and grades published, with each one's first and latest week.

## Example output

```json
{
  "mode": "prices",
  "product": "gasoline",
  "grade": "regular",
  "regionName": "San Francisco",
  "areaType": "city",
  "weekEnding": "2026-07-27",
  "pricePerGallon": 5.578,
  "weekChangeCents": 16.2,
  "yearChangeCents": 127.1,
  "centsVersusNationalAverage": 148.2,
  "fiftyTwoWeekLow": 3.944,
  "fiftyTwoWeekHigh": 6.129,
  "priceRankMostExpensive": 1
}
```

## Coverage

| Area type | What is included |
| --- | --- |
| national | the US average |
| region | East Coast, New England, Central Atlantic, Lower Atlantic, Midwest, Gulf Coast, Rocky Mountain, West Coast, and for diesel West Coast Except California |
| state | California, Colorado, Florida, Massachusetts, Minnesota, New York, Ohio, Texas, Washington |
| city | Boston, Chicago, Cleveland, Denver, Houston, Los Angeles, Miami, New York City, San Francisco, Seattle |

Gasoline comes in regular, midgrade, premium or all grades, each as conventional, reformulated or both. Diesel comes as No 2, low sulfur and ultra low sulfur. Diesel has no formulation split.

## Things worth knowing

- **The diesel workbook pairs every weekly sheet with a monthly one whose title differs by a single extra space.** Mixing them drops monthly averages into a weekly series. The frequency here is confirmed from the spacing of the dates themselves rather than trusted from the sheet name, and only weekly sheets are used.
- **Dates are Excel serial numbers**, not dates, and the sheets end with an empty row.
- **A blank cell means that area was not surveyed that week, not a price of zero.** Series start in different years, so blanks appear inside otherwise complete rows and are skipped rather than zeroed.
- **Refining districts carry their designator inside the name**, as in "Central Atlantic (PADD 1B)". The code is extracted to its own field so the district still classifies as a region.
- **Asking for a grade the fuel does not have** — premium diesel, for instance — returns a free note naming the published grades and answers with the default, rather than silently reporting a different grade as though you had asked for it.
- Prices are dollars per US gallon, including taxes, as surveyed.

## Who this is for

Fleet, haulage and delivery operators tracking fuel cost by region; travel and consumer apps; commodity and equity analysts watching the retail margin over crude; and journalists covering pump prices. The California versus Gulf Coast gap, which the spread column gives you directly, is one of the most reliably newsworthy numbers in US energy.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unpublished grade, a region filter nothing matched, a source that did not load) are never charged.

A full national snapshot of regular gasoline is 28 rows, or **$0.11**. A year of weekly history for one city is 52 rows. Diesel is 11 areas.

## Related actors

- **Oil & Gas Inventory Report** - the weekly supply data behind these prices.
- **Commodity Futures Prices** - crude and refined product futures.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~us-gas-diesel-prices/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"prices","product":"gasoline","grade":"regular"}'
```

Data from the US Energy Information Administration weekly retail price survey.
