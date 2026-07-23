# Deribit Crypto Options & Derivatives Tracker

Keyless **BTC and ETH options** data from **Deribit** — the dominant crypto options venue. No API key, no account. Three modes:

- **Summary** — per-expiry analytics: put/call open-interest and volume ratios, at-the-money implied volatility, total open interest, and strike count. The dashboard options traders read first.
- **Options** — the full option chain: one row per instrument with mark price, implied vol, open interest, volume, strike, expiry, and moneyness.
- **DVOL** — the Deribit volatility index (the crypto "VIX") as a time series.

## Who uses it

- **Crypto options & volatility traders** — read positioning and skew, track IV and the put/call ratio into expiry.
- **Quant & systematic desks** — pull the chain or DVOL history for models and dashboards.
- **Newsletters & analysts** — "BTC put/call ratio spiked into month-end expiry" is a recurring story.

Pairs with our [Crypto Funding Rates & Open Interest Tracker](https://apify.com/scrapemint/crypto-funding-rates-tracker) for the perps side of the book.

## Input

| Field | Description |
|-------|-------------|
| `mode` | `summary`, `options`, or `dvol`. |
| `currencies` | Underlyings, e.g. `BTC`, `ETH`. |
| `optionType` | `both` / `call` / `put` (options mode). |
| `expiries` | Filter to specific expiries in Deribit format, e.g. `28AUG26` (empty = all). |
| `minOpenInterest` | Skip thin instruments (options mode). |
| `sortBy` | `open_interest` / `volume` / `mark_iv` (options mode). |
| `dvolHours` / `dvolResolution` | Volatility-index lookback and candle size (dvol mode). |
| `maxRows` | Row cap per run. |

## Output

- **Summary**: `currency`, `expiry`, `daysToExpiry`, `underlyingPrice`, `atmIv`, `callOpenInterest`, `putOpenInterest`, `totalOpenInterest`, `putCallOiRatio`, `callVolumeUsd`, `putVolumeUsd`, `putCallVolumeRatio`, `strikeCount`.
- **Options**: `instrument`, `optionType`, `strike`, `expiry`, `daysToExpiry`, `markPrice`, `markPriceUsd`, `markIv`, `openInterest`, `openInterestUsd`, `volume`, `volumeUsd`, `bidPrice`, `askPrice`, `midPrice`, `underlyingPrice`, `moneyness`.
- **DVOL**: `currency`, `timestamp`, `dvolOpen`, `dvolHigh`, `dvolLow`, `dvolClose`.

This is a live snapshot feed — schedule it to build your own history.

## Pricing

Pay per event: **$0.003 per row**. The first 2 rows of every run are free.

Data source: Deribit public API (`deribit.com/api/v2`).
