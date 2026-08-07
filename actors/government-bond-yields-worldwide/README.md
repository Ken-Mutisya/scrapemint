# Government Bond Yields Worldwide: Yield Curves by Country

Sovereign bond yields for the **United States, United Kingdom, euro area, Japan, Canada and Australia** in one comparable table. Every maturity each debt office publishes, the move since the previous session, the curve slope with an inversion flag, and **cross country spreads measured on the same date**.

Six official sources, one output format. No API key, no signup, no browser.

## Why this exists

Every debt office publishes its own curve, in its own file format, on its own calendar. The US posts an XML feed by month, the Bank of England a CSV with British date strings, the ECB an SDMX document with positional keys, Japan a monthly CSV, Canada a JSON API, Australia a statistics table with a metadata header. Getting one comparable table out of them is the job. That is what this returns.

## Modes

- **Latest** - each country's newest published curve, one row per maturity, with the move in basis points since its previous session.
- **History** - the same rows across any date range.
- **Spreads** - one row per country per date: 2 year, 5 year, 10 year, 20 year and 30 year yields, the **2s10s slope in basis points**, an **inversion flag**, and the **10 year spread against the US and against the euro area**.

## What you get for each row

| Field | Meaning |
| --- | --- |
| `country`, `countryCode` | United States, United Kingdom, Euro area, Japan, Canada, Australia |
| `date` | the date the yield applies to, not the date it was downloaded |
| `maturityLabel`, `maturityYears` | 3M, 2Y, 10Y and the same point as a number, so curves sort and align across countries |
| `yieldPercent` | the published yield, per cent per annum |
| `changeFromPreviousBasisPoints` | move since that country's previous published session |
| `kind` | `nominal`, `real` (inflation linked) or `policy_rate` |
| `curveType` | what the number actually is: par yield, zero coupon spot rate, compound yield, benchmark bond yield |
| `publicationLagDays` | how many days behind today this figure is |
| `sourceName`, `sourceUrl` | the publishing institution |

Spreads rows add `slope2s10sBasisPoints`, `curveInverted`, `spreadVsUnitedStates10YBasisPoints`, `spreadVsEuroArea10YBasisPoints`, `comparedWithSameDate` and `missingPeers`.

## Example output

```json
{
  "mode": "spreads",
  "country": "Japan",
  "countryCode": "JP",
  "date": "2026-07-28",
  "yield2YPercent": 1.504,
  "yield10YPercent": 2.783,
  "yield30YPercent": 3.98,
  "change10YBasisPoints": 0.5,
  "slope2s10sBasisPoints": 127.9,
  "curveInverted": false,
  "spreadVsUnitedStates10YBasisPoints": -182.7,
  "spreadVsEuroArea10YBasisPoints": -37.5,
  "comparedWithSameDate": true,
  "missingPeers": [],
  "publicationLagDays": 1
}
```

## Coverage, stated honestly

| Country | Maturities published | What the number is |
| --- | --- | --- |
| United States | 1M, 1.5M, 2M, 3M, 4M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y | par yield |
| United Kingdom | 5Y, 10Y, 20Y (plus Bank Rate, optional) | nominal par yield |
| Euro area | 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 15Y, 20Y, 30Y | zero coupon spot rate, AAA rated euro area central government bonds |
| Japan | 1Y to 10Y, 15Y, 20Y, 25Y, 30Y, 40Y | compound yield |
| Canada | 2Y, 3Y, 5Y, 7Y, 10Y, LONG (plus a real return bond, optional) | benchmark bond yield |
| Australia | 2Y, 3Y, 5Y, 10Y (plus an indexed bond, optional) | interpolated bond yield |

Things worth knowing before you build on it:

- **The United Kingdom has no 2 year series** in this database, so a UK 2s10s slope comes back null rather than guessed.
- **Australia's table runs several business days behind** the other five. Every row carries `publicationLagDays` so you can see the age of what you are comparing.
- **Curve types differ.** A US par yield and a euro area zero coupon spot rate are close but not identical constructions. The `curveType` field says which you are holding.
- **Spreads mode always loads the US and euro area curves as references**, even if you did not ask for those countries, so the spread columns are populated whatever selection you make. Reference rows are not returned and not billed.
- **Cross country spreads are only ever computed between two figures published on the same date.** National holidays do not line up. If the peer did not publish that day the spread is null and `missingPeers` names it, rather than quietly comparing against a neighbouring session.
- **Inflation linked yields are excluded by default.** Canada's real return bond and Australia's indexed bond sit in the same published files as the nominal benchmarks; mixing a real yield into a nominal curve would corrupt every slope and spread. Turn them on with `includeRealYields` and they arrive marked `kind: "real"`.
- **Japanese history before the current month** comes from the ministry's archive file, which is large, slow and has been observed to stop mid row. Whatever parses is returned and the shortfall is reported in a note row; it is never padded.
- Long US histories are slower than the rest: that feed is served a year per request at roughly ten seconds each.

## Sources

- US Department of the Treasury, daily Treasury par yield curve
- Bank of England, Interactive Statistical Database
- European Central Bank Data Portal, euro area yield curve
- Japan Ministry of Finance, JGB interest rates
- Bank of Canada, Valet API, selected benchmark bond yields
- Reserve Bank of Australia, table F2 capital market yields

All are official publications of the issuing authority or its central bank.

## Pricing

**$0.004 per row.** The first 2 rows of every run are free, and note rows (an unknown country, a maturity nobody publishes, a source that did not respond) are never charged.

A latest snapshot of all six countries at the four key maturities is about 20 rows, or **$0.08**. A full month of daily 10 year yields for all six countries is about 130 rows, or **$0.52**. A terminal subscription that carries the same six curves starts in the hundreds of dollars a month.

## Related actors

- **US Treasury Yields & Interest Rates Scraper** - one country in depth: auctions, bills, TIPS, average interest on the debt.
- **SOFR & Money Market Rates: Benchmarks and Fed Operations** - the overnight funding market underneath these curves.
- **European Economic Indicators** - inflation, unemployment and growth for the same economies.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~government-bond-yields-worldwide/runs?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"spreads","countries":["US","GB","EA","JP","CA","AU"],"daysBack":10}'
```
