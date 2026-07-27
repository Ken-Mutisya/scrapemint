# Stock Options Scraper: Unusual Activity, IV & Open Interest

Keyless **US stock and index option chains** from **Cboe**. No API key, no account, no broker login. Three modes:

- **Unusual activity** — contracts where today's volume dwarfs the open interest that existed going in. This is the scan options traders run every morning to see where new positioning is being built.
- **Chain** — the option chain filtered to what you actually want: expiry, a strike window around spot, minimum volume and open interest, calls or puts. Every row carries implied volatility, delta, gamma, theta, vega, rho, bid/ask, and Cboe's theoretical price.
- **Summary** — one row per symbol: put/call ratios on both volume and open interest, totals, the most active contract, and 30 day implied volatility.

Works on single stocks (`NVDA`, `TSLA`, `BRK.B`), ETFs (`SPY`, `QQQ`), and index roots (`SPX`, `VIX`, `NDX`, `RUT`).

## Who uses it

- **Options traders** — find unusual flow, read the put/call ratio, pull a clean chain into a spreadsheet without paying for a data terminal.
- **Swing and momentum traders** — unusual call buying in a name you already follow is a positioning signal ahead of the move.
- **Quants and dashboard builders** — schedule it and store the snapshots to build your own history of IV, open interest, and flow.
- **Newsletters and analysts** — "someone bought 40,000 NVDA calls today" is a recurring story, and this is where you find it.

Pairs with our [Stock Market Movers & Screener](https://apify.com/scrapemint/stock-market-movers) for the underlying move and [Stock Analyst Ratings](https://apify.com/scrapemint/stock-analyst-ratings) for the catalyst behind it. For crypto options, see the [Deribit Options Tracker](https://apify.com/scrapemint/deribit-options-tracker).

## Input

| Field | Description |
|-------|-------------|
| `mode` | `unusual`, `chain`, or `summary`. |
| `symbols` | Tickers to pull, e.g. `NVDA`, `TSLA`, `SPY`. Index roots work with or without the caret. Max 25 per run. |
| `optionType` | `both` / `call` / `put`. |
| `minVolume` | Volume floor. Keeps one lot noise out of the unusual scan. |
| `minVolumeOiRatio` | How many times volume must exceed open interest to count as unusual (default 5). |
| `minOpenInterest` | Skip thin contracts. |
| `expiries` | Filter to specific expiry dates, `YYYY-MM-DD` (empty = all). |
| `maxDaysToExpiry` | Focus on near dated flow. 0 = no limit. |
| `moneynessPercent` | Keep strikes within this percent of spot. The main lever for cutting chain row counts. |
| `sortBy` | `volume` / `openInterest` / `volumeOiRatio` / `impliedVolatility`. |
| `maxRows` | Row cap per run. |

## Output

- **Unusual and chain**: `symbol`, `underlyingPrice`, `underlyingChangePercent`, `iv30`, `contract`, `optionType`, `strike`, `expiry`, `daysToExpiry`, `moneyness`, `inTheMoney`, `bid`, `ask`, `mid`, `lastPrice`, `lastTradeTime`, `changePercent`, `volume`, `openInterest`, `volumeOiRatio`, `newContract`, `impliedVolatility`, `delta`, `gamma`, `theta`, `vega`, `rho`, `theoreticalPrice`.
- **Summary**: `symbol`, `underlyingPrice`, `iv30`, `iv30ChangePercent`, `totalContracts`, `callVolume`, `putVolume`, `putCallVolumeRatio`, `callOpenInterest`, `putOpenInterest`, `putCallOiRatio`, `expiryCount`, `nearestExpiry`, `furthestExpiry`, `mostActiveContract`, `mostActiveVolume`, `unusualContractCount`.

`volumeOiRatio` is null when open interest is zero, since there is nothing to divide by. Those contracts are flagged `newContract: true` and qualify for the unusual scan on volume alone, which is usually the most interesting case: a strike nobody held this morning that is suddenly trading.

## Notes on the data

- Quotes are **delayed roughly 15 minutes**, which is what Cboe publishes without a subscription.
- Greeks, implied volatility, and `theoreticalPrice` are Cboe's own published values, passed through unchanged rather than recomputed.
- Deep in the money contracts often publish `impliedVolatility: 0` with delta near 1. That is the source's value for a contract with no meaningful optionality left, not a gap in the scrape.
- Volume and open interest reset and settle on the exchange's schedule, so open interest reflects yesterday's close while volume is intraday. That difference is exactly what makes the ratio informative.
- A symbol with no listed options returns a free note row rather than an error.
- `daysToExpiry` is 0 for a contract expiring today, so same day expiries are easy to isolate or exclude.
- `maxRows` is filled symbol by symbol in the order you list them, with the highest `sortBy` values first within each symbol. Put the names you care about most at the front of `symbols`, or raise the cap.

This is a live snapshot feed. Schedule it to build your own history.

## Pricing

Pay per event: **$0.004 per row**. The first 2 rows of every run are free.

Data source: Cboe delayed quotes (`cdn.cboe.com`).
