# IPO Calendar Scraper

Get the US IPO pipeline as clean JSON: **upcoming, priced, newly filed and withdrawn deals** with ticker, exchange, share price, shares offered and deal value.

No login, no API key, no proxy. The actor reads keyless public JSON, so runs are fast and cheap.

## What you get

One row per deal per stage.

| Field | Description |
| --- | --- |
| `ipoStatus` | `priced`, `upcoming`, `filed` or `withdrawn` |
| `symbol` | Proposed ticker |
| `companyName` | Company name |
| `date` | The date that matters for this stage |
| `exchange` | Listing venue, e.g. NASDAQ Global |
| `sharePriceUsd` | Firm offer price per share. Stays `null` while the deal is still a marketed range |
| `sharePriceLowUsd` / `sharePriceHighUsd` | The marketed price range, e.g. 16.00 to 18.00. Both equal `sharePriceUsd` once the deal prices |
| `sharesOffered` | Number of shares offered, or `null` |
| `dealValueUsd` | Total raise in USD, or `null` |
| `pricedDate` / `expectedPriceDate` / `filedDate` / `withdrawDate` | Stage dates, whichever apply |
| `dealId` | Nasdaq deal identifier, stable across stages |
| `scrapedAt` | Run timestamp, ISO 8601 |

A missing value stays `null`. It is never reported as `0`, because a share price of zero is a different claim from a price Nasdaq has not published yet.

### Why `filed` matters

Most IPO trackers show only what is about to price. A company appears in `filed` when it submits its registration, often months earlier. That is the early signal, and it is why this actor reads all four stages rather than the two most tools stop at.

## Input

| Field | Description |
| --- | --- |
| `dateFrom` | Earliest deal date `YYYY-MM-DD` (default: today) |
| `dateTo` | Latest deal date `YYYY-MM-DD` (default: +30 days, range capped at 12 months) |
| `statuses` | Any of `priced`, `upcoming`, `filed`, `withdrawn` (default: all four) |
| `tickers` | Optional watchlist of proposed symbols. Empty = every deal |
| `minDealValueUsd` | Skip deals raising less than this, e.g. `50000000` |
| `newOnly` | Monitor mode: emit only deals not seen in earlier runs |
| `maxRows` | Stop after N rows (default 300) |

### Monitor mode

Set `newOnly` to `true` and put the actor on a daily schedule to get a feed of new deals only. A deal is reported again when it **changes stage**, so a company that files and later prices shows up both times. Quiet days cost nothing.

## Example

```json
{ "dateFrom": "2026-08-01", "dateTo": "2026-08-31", "statuses": ["upcoming", "filed"] }
```

```json
{
  "ipoStatus": "priced",
  "symbol": "THEOU",
  "companyName": "BOA Acquisition Corp. II",
  "date": "2026-08-04",
  "exchange": "NASDAQ Global",
  "sharePriceUsd": 10,
  "sharePriceLowUsd": 10,
  "sharePriceHighUsd": 10,
  "sharesOffered": 12500000,
  "dealValueUsd": 125000000,
  "pricedDate": "2026-08-04",
  "expectedPriceDate": null,
  "filedDate": null,
  "withdrawDate": null,
  "dealId": "1351784-115611",
  "scrapedAt": "2026-08-05T14:40:12.004Z"
}
```

## Who it's for

IPO and small cap traders working the new issue calendar, funds screening the pipeline for upcoming supply, fintech apps and newsletters that display an IPO calendar, and researchers tracking issuance and withdrawal rates over time.

## Pricing

Pay per IPO row. The first 2 rows of every run are free so you can validate the output before you pay.

## Notes

- Stages fill in over time. A deal in `filed` has no price or share count until it is ready to go, so those fields stay `null` until Nasdaq publishes them.
- An upcoming deal is marketed as a price range and only becomes a single number when it prices. That is why `sharePriceUsd` is `null` for most upcoming deals while `sharePriceLowUsd` and `sharePriceHighUsd` are populated.
- Withdrawn deals are often absent for a given month. An empty stage is reported as no rows, never as a placeholder row.
