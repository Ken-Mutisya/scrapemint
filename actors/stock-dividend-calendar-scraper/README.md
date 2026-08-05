# Stock Dividend Calendar Scraper

Get the upcoming US dividend calendar as clean JSON: **ex-dividend, record, payment and announcement dates** with the declared cash rate, for a date range or your own ticker watchlist.

No login, no API key, no proxy. The actor reads keyless public JSON, so runs are fast and cheap.

## What you get

One row per company per ex-dividend date.

| Field | Description |
| --- | --- |
| `symbol` | Ticker |
| `companyName` | Company name as Nasdaq reports it |
| `exDividendDate` | Buy before this date to receive the dividend |
| `recordDate` | Date the holder of record is determined |
| `paymentDate` | Date the cash is paid out |
| `announcementDate` | Date the dividend was declared |
| `dividendRate` | Declared cash amount per share, or `null` when Nasdaq reports none |
| `indicatedAnnualDividend` | Annualised dividend per share, or `null` |
| `daysUntilExDividend` | Days from the run date to the ex-dividend date |
| `scrapedAt` | Run timestamp, ISO 8601 |

A missing value stays `null`. It is never reported as `0`, because a dividend of zero is a different claim from a dividend Nasdaq did not report.

## Input

| Field | Description |
| --- | --- |
| `dateFrom` | First ex-dividend date `YYYY-MM-DD` (default: today) |
| `dateTo` | Last ex-dividend date `YYYY-MM-DD` (default: +30 days, range capped at 90 days) |
| `tickers` | Optional watchlist, e.g. `["KO","PG","JNJ"]`. Empty = whole market |
| `minDividendRate` | Skip dividends below this cash amount per share, e.g. `0.50` |
| `newOnly` | Monitor mode: emit only dividends not seen in earlier runs |
| `maxRows` | Stop after N rows (default 500) |

### Monitor mode

Set `newOnly` to `true` and put the actor on a daily schedule to get a feed of **newly announced** dividends only. Dividends already returned by a previous run are remembered and skipped, so a quiet day costs nothing.

## Example

```json
{ "dateFrom": "2026-08-06", "dateTo": "2026-08-20", "tickers": ["KO", "PG"] }
```

```json
{
  "symbol": "BMRC",
  "companyName": "Bank of Marin Bancorp Common Stock",
  "exDividendDate": "2026-08-06",
  "recordDate": "2026-08-06",
  "paymentDate": "2026-08-13",
  "announcementDate": "2026-07-23",
  "dividendRate": 0.25,
  "indicatedAnnualDividend": 1.0,
  "daysUntilExDividend": 1,
  "scrapedAt": "2026-08-05T13:20:41.512Z"
}
```

## Who it's for

Income investors tracking when to buy for the next payout, dividend capture traders working ex-dividend dates, portfolio and fintech apps that display an income calendar, and quants feeding ex-dividend dates into backtests and total return models.

## Pricing

Pay per dividend row. The first 2 rows of every run are free so you can validate the output before you pay.

## Notes

- Dividend rows appear on the calendar as companies declare them, so a date far in the future will fill in over time. Re-run closer to the date for the complete picture.
- The date range is capped at 90 days per run to keep runs fast.
