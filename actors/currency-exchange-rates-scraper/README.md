# Currency Exchange Rates: Live & History for 160+ Currencies

Get exchange rates as clean rows, ready for your app, spreadsheet or database. Two modes in one tool: **live rates for 160+ world currencies** (one row per currency pair), and **daily historical rates back to 1999** for 30 major currencies, straight from European Central Bank reference data.

Built for **pricing tools, invoicing, e-commerce, dashboards, accounting and backtesting**. Pick your base currencies (USD, EUR, KES, INR, anything), optionally pick targets, and get every pair as its own row. No signup and no API key.

## What you get for each currency pair

- **base** and **target**: the 3 letter currency codes
- **rate**: how much 1 unit of the base is worth in the target currency
- **inverseRate**: the reverse conversion, precomputed
- **date**: the day the rate applies to
- **source**: where the rate comes from (Open ER API for live, ECB for history)

## Example output

```json
{
  "base": "USD",
  "target": "KES",
  "rate": 129.28,
  "inverseRate": 0.0077351,
  "date": "2026-07-14",
  "source": "open.er-api.com",
  "valid": true
}
```

## Live rates or history?

- **Live rates**: 160+ currencies, refreshed daily. Every world currency you are likely to need, from EUR and JPY to KES, NGN, VND and PKR.
- **Historical daily rates**: European Central Bank reference rates, every banking day back to January 1999, for 30 major currencies. One run can pull a full decade of EUR/USD daily rates for backtesting or reporting.

## Pricing

**$0.001 per rate row.** Unsupported currency codes are **free**, and the first 2 rows of every run are free. A full live snapshot of one base against all 166 currencies costs about $0.17; ten years of daily USD to EUR history (about 2,500 rows) costs about $2.50. Commercial exchange rate APIs start at $10 to $50 per month for the same data.

## How to run it via API

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~currency-exchange-rates-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseCurrencies": ["USD"], "targetCurrencies": ["EUR", "GBP", "KES"], "dataType": "latest"}'
```

For history, add dates:

```bash
curl -X POST "https://api.apify.com/v2/acts/scrapemint~currency-exchange-rates-scraper/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"baseCurrencies": ["EUR"], "targetCurrencies": ["USD"], "dataType": "history", "startDate": "2020-01-01"}'
```

## Frequently asked questions

**How fresh are the live rates?** They update once a day, which is what most billing, invoicing and reporting needs. This tool is not a real time trading feed.

**Why does history cover fewer currencies?** Historical rates come from the European Central Bank, which publishes daily reference rates for 30 major currencies. Live rates cover 160+.

**Are these the rates my bank will give me?** These are mid-market reference rates, the same kind shown by Google or XE. Banks and card networks add their own spread on top.

**Where does the data come from?** Live rates from the Open ER API public feed, historical rates from European Central Bank reference data via frankfurter.dev. Both are public, reputable sources.

## More tools from Scrapemint

- [World Economic Indicators Scraper](https://apify.com/scrapemint/world-economic-indicators-scraper): GDP, inflation and 29,000+ indicators for every country.
- [Crypto Market Data Scraper](https://apify.com/scrapemint/crypto-market-data-scraper): live crypto prices and market caps.
- [TradingView Stock Screener](https://apify.com/scrapemint/tradingview-stock-screener): screen thousands of stocks by fundamentals and technicals.
